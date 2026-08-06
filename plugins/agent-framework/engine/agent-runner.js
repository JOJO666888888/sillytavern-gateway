import { ContextBuilder, extractDefinitionVar, buildContextWithGreeting } from '../../../server/agent/context-builder.js';
import { Pipeline } from '../../../server/agent/pipeline.js';
import { AgentRunResult, AgentEventType } from '../../../server/agent/run-result.js';
import { extractOptions } from '../../../server/agent/option-utils.js';

/**
 * Agent 执行引擎
 * 负责执行 Agent 定义，管理工具循环和子代理触发
 */
export class AgentRunner {
    constructor(options = {}) {
        this.toolRegistry = options.toolRegistry;
        this.subagentDispatcher = options.subagentDispatcher;
        this.stateManager = options.stateManager;
        this.memoryEngine = options.memoryEngine;
        this.contextBuilder = options.contextBuilder || new ContextBuilder(options);
        this.workspaceManager = options.workspaceManager || null;
        this.logger = options.logger || console;
        // Phase 3 多 Agent 协作：run 级协作总线（run 结束时 close 清理）
        this.collabBus = options.collabBus || null;
        // 流式 token 增量回调：onTokenDelta(runId, delta, fullText, turn, sessionKey)
        this.onTokenDelta = typeof options.onTokenDelta === 'function' ? options.onTokenDelta : null;
        // P1-2: 单个 Agent 事件实时回调：onAgentEvent(sessionKey, { type, payload, seq, timestamp })
        // 由插件层接线到 theatre-broadcaster.broadcastEvent，供前端时间线实时消费。
        this.onAgentEvent = typeof options.onAgentEvent === 'function' ? options.onAgentEvent : null;
        // P2: 提示词构建回调：onPromptBuilt(sessionKey, { messages, builtAt, runId })
        // 由插件层接线到 theatre-broadcaster，把最近一次注入的完整提示词推给 SSE 客户端。
        this.onPromptBuilt = typeof options.onPromptBuilt === 'function' ? options.onPromptBuilt : null;
        // 模型思维链回调：onReasoning(sessionKey, runId, delta, full)
        // 由插件层接线到 theatre-broadcaster，把 reasoning 增量实时推给 SSE 客户端（AI 思考过程）。
        this.onReasoning = typeof options.onReasoning === 'function' ? options.onReasoning : null;
        this.activeRuns = new Map();
        this.runLog = [];
        // P2: 最近一次构建的完整提示词：Map<sessionKey, { messages, builtAt, runId }>
        // 供 GET /api/agent-theatre/prompt 查询（前端提示词查看器）。
        this.lastPromptMap = new Map();
    }

    /**
     * 执行 Agent
     * @param {Object} definition - Agent 定义
     * @param {Object} session - 会话状态
     * @param {Array} history - 历史消息
     * @param {string} userMessage - 用户消息
     * @param {Object} ctx - 插件上下文（含 ctx.llm 等）
     * @returns {Object} { runId, result: AgentRunResult, text(兼容), steps, subAgentResults, logs }
     */
    async run(definition, session, history, userMessage, ctx) {
        const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const startTime = Date.now();
        // P2: 每个 run 持有一个 AbortController，abort(runId) 触发后 LLM 工具循环抛错中断
        const controller = new AbortController();
        this.activeRuns.set(runId, { definition, session, startTime, controller });

        // 工具循环中捕获的事件（待 runTools 完成后注入 AgentRunResult）
        const capturedEvents = [];
        let draftGenerated = false;

        // meta 提前构造，便于 catch 分支复用
        // style 语义统一：session.style（会话运行时）> injectAssets 变量名 > 顶层 definition.style（deprecated 兼容）
        const meta = {
            viewMode: definition.viewMode || 'first',
            style: session?.style || extractDefinitionVar(definition, 'style') || definition.style || '',
            turn: session?.turn || session?.turnCount || 0,
            referencedMemory: '',
        };

        try {
            // 构建上下文（P5 修复：开场白注入 + 组装抽到共享函数 buildContextWithGreeting，
            // 与提示词查看器"无 run 预览"共用同一路径，保证显示=实际注入逐字节一致）
            const { messages, greetingInjected } = buildContextWithGreeting(
                this.contextBuilder, definition, session, Array.isArray(history) ? history : [], userMessage,
            );
            this.logger.info(`[agent-runner] Agent "${definition.name}" 启动，messages: ${messages.length}${greetingInjected ? '（含角色开场白）' : ''}`);

            // P2: 捕获最近一次注入的完整提示词（供前端提示词查看器 + SSE prompt_built 实时刷新）
            // P4 修复：缓存 key 增加角色卡维度（sessionKey|char:<角色>）——切换角色卡后，
            // 查看器不会命中上一角色卡的记录，杜绝"切卡后显示旧卡上下文"。
            const sessionKey = `${session?.platform || 'unknown'}:${session?.chatId || 'unknown'}`;
            const promptKey = `${sessionKey}|char:${session?.character || ''}`;
            const promptRecord = { messages, builtAt: Date.now(), runId };
            this.lastPromptMap.set(promptKey, promptRecord);
            if (this.onPromptBuilt) {
                try { this.onPromptBuilt(sessionKey, promptRecord); } catch (e) { /* 广播失败不阻塞主流程 */ }
            }

            // 2. workspace 能力：若 definition 或 ctx 声明 workspace，初始化 run 级工作区
            const useWorkspace = !!this.workspaceManager
                && !!(definition.workspace || ctx?.workspace);
            if (useWorkspace) {
                const sessionId = session?.id
                    || `${session?.platform || 'unknown'}:${session?.chatId || 'unknown'}`;
                this.workspaceManager.initRun(runId, {
                    sessionId,
                    manifest: {
                        agent: definition.name,
                        tools: definition.tools || [],
                        ...(definition.workspace || {}),
                    },
                });
            }

            // 3. 获取工具声明 + 执行器（包装一层以捕获事件 / 检测草稿生成 / 写 journal）
            const tools = this.toolRegistry.getDeclarations(definition.tools || []);
            // 工具名规范化：OpenAI/Claude/Gemini 的 function.name 不允许点号（如 "state.read"），
            // 发给模型前统一转下划线；模型返回工具调用时按映射还原为原始名再执行。
            const sanitizeToolName = (n) => String(n).replace(/\./g, '_');
            const toolNameMap = new Map();
            const llmTools = tools.map(t => {
                const sn = sanitizeToolName(t.name);
                if (sn !== t.name) toolNameMap.set(sn, t.name);
                return { ...t, name: sn };
            });
            // runId 注入工具执行上下文，供 collab.* 协作工具绑定消息
            const baseExecutor = this.toolRegistry.createExecutor({ session, ctx, definition, runId });
            // 先还原工具名（sanitized -> 原始名），再交给事件包装器（其内部按原始点号名匹配 state.* / narrative.generate）
            const executor = this._wrapExecutor(
                (name, args) => baseExecutor(toolNameMap.get(name) || name, args),
                runId, useWorkspace, capturedEvents, () => { draftGenerated = true; },
                sessionKey,
            );

            // 4. 构建 pipeline（如有阶段定义）
            let pipeline = null;
            if (definition.pipeline?.stages) {
                pipeline = new Pipeline(definition.pipeline.stages);
            }

            // 5. 执行 agent loop（优先流式：实时转发 token 增量；引擎缺失/未知 provider 自动降级非流式）
            const sampling = {
                temperature: definition.model?.temperature ?? 0.8,
                max_tokens: definition.model?.maxTokens ?? 32768,
            };
            const maxSteps = definition.maxSteps || 10;

            let result;
            if (typeof ctx.llm.runToolsStream === 'function') {
                result = await ctx.llm.runToolsStream(messages, llmTools, executor, {
                    maxSteps,
                    sampling,
                    // P2: 中止信号，abort 后 LLM 工具循环在 step 边界抛 Error('aborted') 中断
                    signal: controller.signal,
                    onDelta: (delta, full, turn) => this.onTokenDelta?.(runId, delta, full, turn, sessionKey),
                    // 思维链增量实时转发：reasoning SSE 事件（AI 思考过程展示）
                    onReasoning: (delta, full, turn) => this.onReasoning?.(sessionKey, runId, delta, full),
                });
            } else {
                result = await ctx.llm.runTools(messages, llmTools, executor, {
                    maxSteps,
                    sampling,
                    signal: controller.signal,
                    // 非流式：runTools 全部回合结束后一次性上报完整思维链（delta=full）
                    onReasoning: (delta, full, turn) => this.onReasoning?.(sessionKey, runId, delta, full),
                });
            }

            // 6. 草稿生成后 checkpoint
            if (useWorkspace && draftGenerated) {
                this.workspaceManager.createCheckpoint(runId, 'after-draft');
            }

            // 7. 检查子代理触发
            let subAgentResults = [];
            if (definition.subAgents && definition.subAgents.length > 0) {
                subAgentResults = await this._triggerSubAgents(definition, result.text, session, ctx, runId);
                for (const r of subAgentResults) {
                    capturedEvents.push({ type: AgentEventType.SUBAGENT, payload: r });
                    // P1-2: 子代理结果实时广播
                    if (this.onAgentEvent) {
                        try { this.onAgentEvent(sessionKey, { type: AgentEventType.SUBAGENT, payload: r }); } catch (e) { /* 忽略 */ }
                    }
                    if (useWorkspace) this.workspaceManager.appendEvent(runId, 'subagent', r);
                }
            }

            // 8. 产出 AgentRunResult（主文本 artifact + 注入捕获的事件）
            const runResult = AgentRunResult.fromRunResult(result.text, result.steps, runId, meta);
            for (const ev of capturedEvents) {
                runResult.addEvent(ev.type, ev.payload);
            }

            // P1-1: 从正文提取 >选项X： 格式的选项并填充 result.options。
            // 此前 options 恒为空导致面板选项区恒空、IM 选项需靠 option-splitter 正则兜底；
            // 现在引擎契约直接产出选项（含 callbackId 语义），前端可据此渲染可点击选项。
            try {
                const { mainText, options } = extractOptions(runResult.getMainText());
                if (mainText) runResult.setMainText(mainText);
                for (const opt of options) {
                    runResult.addOption({
                        text: opt.content,
                        callbackId: `select:option:${opt.index}`,
                        index: opt.index,
                    });
                }
            } catch (e) {
                // 选项提取失败不阻断主流程（保持原正文）
                this.logger.warn(`[agent-runner] 选项提取失败: ${e.message}`);
            }

            // 9. commit 前 checkpoint + commit（成功才 promote，失败不污染稳定层）
            let promoted = [];
            if (useWorkspace) {
                this.workspaceManager.createCheckpoint(runId, 'before-commit');
                promoted = this.workspaceManager.commit(runId);
                runResult.addEvent(AgentEventType.COMMIT, { promoted });
            }

            // 10. 记录日志
            const logEntry = {
                runId,
                agent: definition.name,
                startTime,
                endTime: Date.now(),
                duration: Date.now() - startTime,
                steps: result.steps,
                success: true,
                subAgentCount: subAgentResults.length,
                promoted,
            };
            this.runLog.push(logEntry);
            if (this.runLog.length > 100) this.runLog.shift();

            return {
                runId,
                result: runResult,
                text: runResult.getMainText(),
                steps: result.steps,
                subAgentResults,
                logs: logEntry,
                promoted,
            };
        } catch (e) {
            // P2: 识别"被中止"与"真失败"：abort 触发后 LLM 工具循环抛 Error('aborted') 或 AbortError
            const isAborted = e?.name === 'AbortError' || e?.message === 'aborted';
            if (isAborted) {
                this.logger.info(`[agent-runner] Agent "${definition.name}" 已停止生成`);
            } else {
                this.logger.error(`[agent-runner] Agent "${definition.name}" 执行失败: ${e.message}`);
            }
            // 失败/取消不 commit，workspace 保留供审计
            const logEntry = {
                runId,
                agent: definition.name,
                startTime,
                endTime: Date.now(),
                success: false,
                aborted: isAborted,
                error: e.message,
            };
            this.runLog.push(logEntry);
            if (this.runLog.length > 100) this.runLog.shift();

            // P2: 被中止时提示文本为"已停止生成"，而非报错
            const errText = isAborted ? '（已停止生成）' : `Agent 执行出错: ${e.message}`;
            const errResult = AgentRunResult.fromRunResult(errText, 0, runId, meta);
            return {
                runId,
                result: errResult,
                text: errResult.getMainText(),
                steps: 0,
                error: e.message,
                logs: logEntry,
                // P2: 中止标记，server/index.js 据此广播 run_state=aborted
                aborted: isAborted,
            };
        } finally {
            // 确保缓冲中的事件落盘（commit/rollback 已 flush，但失败路径不 commit）。
            // SubTask 7.2：保证审计事件不丢，便于事后排查。
            if (this.workspaceManager?.flushRun) {
                try { this.workspaceManager.flushRun(runId); } catch { /* ignore */ }
            }
            // 状态写缓冲落盘，保证 agent 工具循环中 state.write 的变更即时持久化
            if (this.stateManager?.flush) {
                try { this.stateManager.flush(); } catch { /* ignore */ }
            }
            // Phase 3：run 结束清理协作总线（邮箱 + 挂起请求）
            if (this.collabBus?.close) {
                try { this.collabBus.close(runId); } catch { /* ignore */ }
            }
            this.activeRuns.delete(runId);
        }
    }

    /**
     * 包装工具执行器：捕获 tool_call / state_change 事件，检测草稿生成，写入 journal。
     * @param {Function} baseExecutor - 原始执行器 async (name, args) => string
     * @param {string} runId
     * @param {boolean} useWorkspace
     * @param {Array} capturedEvents - 待注入 AgentRunResult 的事件缓冲
     * @param {Function} onDraft - 草稿生成回调
     * @param {string} sessionKey - 会话键（P1-2：实时广播事件用）
     * @returns {Function} 包装后的执行器
     * @private
     */
    _wrapExecutor(baseExecutor, runId, useWorkspace, capturedEvents, onDraft, sessionKey) {
        const fire = (type, payload) => {
            const ev = { type, payload };
            capturedEvents.push(ev);
            // P1-2: 实时广播给剧场 SSE 客户端（时间线实时展示工具调用/状态变更）
            if (this.onAgentEvent) {
                try { this.onAgentEvent(sessionKey, { type, payload }); } catch (e) { /* 广播失败不阻断 */ }
            }
            return ev;
        };
        return async (name, args) => {
            fire(AgentEventType.TOOL_CALL, { tool: name, args });
            if (typeof name === 'string' && name.startsWith('state.')) {
                fire(AgentEventType.STATE_CHANGE, { tool: name, args });
            }
            if (name === 'narrative.generate') {
                fire(AgentEventType.DRAFT, { args });
                onDraft();
            }
            if (useWorkspace) {
                try { this.workspaceManager.appendEvent(runId, 'tool_call', { tool: name, args }); }
                catch (e) { this.logger.warn?.(`[agent-runner] 写 journal 失败: ${e.message}`); }
            }
            return baseExecutor(name, args);
        };
    }

    /**
     * 触发子代理（Phase 3 增强：任务分配算法）
     * - 常规 / split_by_section / sequential_feedback / consensus
     *   - split_by_section：按 sections 数把主稿文本切块分别 dispatch（并行）
     *   - sequential_feedback：链式传稿（前一个子代理产出注入下一个的 parentResult）
     *   - consensus：本期按顺序反馈基础版执行 + 记录 warn（完整实现排期）
     * @param {Object} definition - Agent 定义
     * @param {string} mainResult - 主 Agent 产出文本
     * @param {Object} session - 会话状态
     * @param {Object} ctx - 插件上下文
     * @param {string} runId - 当前 run ID（绑定协作消息）
     * @returns {Array} 子代理结果数组
     * @private
     */
    async _triggerSubAgents(definition, mainResult, session, ctx, runId) {
        const results = [];
        const triggers = definition.subAgents || [];

        // 按触发条件分组
        const afterDraft = triggers.filter(s => s.trigger === 'after_draft');
        const afterOutline = triggers.filter(s => s.trigger === 'after_outline');

        // 并行执行 after_draft 的子代理
        const parallel = afterDraft.filter(s => s.parallel);
        const sequential = afterDraft.filter(s => !s.parallel);

        if (parallel.length > 0) {
            const settled = await Promise.allSettled(
                parallel.map(s => this._runSubAgentSpec(s, mainResult, session, ctx, runId))
            );
            for (const r of settled) {
                results.push(r.status === 'fulfilled' ? r.value : { error: r.reason?.message || '子代理执行失败' });
            }
        }

        // 顺序子代理：sequential_feedback 链式传稿（下一子代理以上一产出为参考）
        let chainResult = mainResult;
        for (const s of sequential) {
            if (s.task?.divide === 'consensus') {
                this.logger.warn?.('[agent-runner] consensus 任务分配模式设计就绪、完整实现排期，本期按顺序反馈基础版执行');
            }
            const result = await this._runSubAgentSpec(s, chainResult, session, ctx, runId);
            results.push(result);
            if (result && !result.error && result.text) chainResult = result.text;
        }

        return results;
    }

    /**
     * 按子代理定义的 task.divide 执行单个子代理（Phase 3 任务分配）。
     * @param {Object} spec - 子代理定义 { name, trigger, parallel, task? }
     * @param {string} mainResult - 主稿文本
     * @param {Object} session
     * @param {Object} ctx
     * @param {string} runId
     * @returns {Promise<Object>} 单结果或 { agent, mode, results }（split 模式）
     * @private
     */
    async _runSubAgentSpec(spec, mainResult, session, ctx, runId) {
        const taskSpec = spec.task || {};
        if (taskSpec.divide === 'split_by_section') {
            const n = Math.max(1, Array.isArray(taskSpec.sections) ? taskSpec.sections.length : 1);
            const chunks = this._splitBySections(mainResult, n);
            const tasks = chunks.map((chunk, i) => {
                const sec = Array.isArray(taskSpec.sections) ? taskSpec.sections[i] : null;
                const desc = typeof sec === 'string' ? sec : (sec?.task || '');
                return { chunk, desc };
            });
            const settled = await Promise.allSettled(
                tasks.map(({ chunk, desc }) =>
                    this.subagentDispatcher.dispatch(
                        spec.name,
                        `审查以下内容片段${desc ? `（${desc}）` : ''}:\n${chunk}`,
                        session,
                        ctx,
                        { runId, parentResult: mainResult },
                    )
                )
            );
            const results = settled.map(r => (
                r.status === 'fulfilled' ? r.value : { error: r.reason?.message || '子代理执行失败', agent: spec.name }
            ));
            return { agent: spec.name, mode: 'split_by_section', count: results.length, results };
        }

        // 常规 / sequential_feedback / consensus（基础版）：单次调度，主稿作为协作参考注入
        return this.subagentDispatcher.dispatch(
            spec.name,
            `审查以下内容:\n${mainResult}`,
            session,
            ctx,
            { runId, parentResult: mainResult },
        );
    }

    /**
     * 把主稿文本按段落（\n\n+）平均切分为 n 块（连续分区）。
     * @param {string} text
     * @param {number} n
     * @returns {string[]}
     * @private
     */
    _splitBySections(text, n) {
        if (!text) return Array.from({ length: n }, () => '');
        const paras = text.split(/\n\n+/).filter(p => p.trim());
        if (n <= 1 || paras.length <= 1) return [text];
        const perChunk = Math.ceil(paras.length / n);
        const chunks = [];
        for (let i = 0; i < n; i++) {
            chunks.push(paras.slice(i * perChunk, (i + 1) * perChunk).join('\n\n'));
        }
        return chunks;
    }

    /**
     * 中止一个正在执行的 run（P2）。
     * 触发该 run 的 AbortController，LLM 工具循环在 step 边界检查 signal.aborted 后抛错中断。
     * @param {string} runId
     * @returns {boolean} 是否找到并触发了中止（run 不存在/已结束返回 false）
     */
    abort(runId) {
        const run = this.activeRuns.get(runId);
        if (!run) return false;
        if (run.controller && !run.controller.signal.aborted) {
            run.controller.abort();
        }
        return true;
    }

    /**
     * 获取运行状态
     */
    getStatus() {
        return {
            activeAgents: Array.from(this.activeRuns.entries()).map(([id, run]) => ({
                runId: id,
                agent: run.definition.name,
                duration: Date.now() - run.startTime,
            })),
            totalRuns: this.runLog.length,
            recentLogs: this.runLog.slice(-10),
        };
    }

    getLogs(limit = 50) {
        return this.runLog.slice(-limit);
    }

    /**
     * 获取某会话（可指定角色卡）最近一次注入的完整提示词（P2/P4）。
     * @param {string} sessionKey - 会话 key（"platform:chatId"）
     * @param {string} [character] - 角色卡名（P4 修复：缓存按 会话+角色卡 双维度隔离）。
     *   指定时精确匹配该角色卡；未指定时回退为该会话最近一次记录（兼容旧调用）。
     * @returns {{messages:Array<{role:string, content:string}>, builtAt:number, runId:string}|null}
     *          无记录时返回 null
     */
    getLastPrompt(sessionKey, character) {
        const prefix = `${sessionKey}|char:`;
        if (character) {
            // 指定角色卡：精确匹配，未命中返回 null（切到新卡未 run 时不得回退到旧卡记录）
            return this.lastPromptMap.get(`${prefix}${character}`) || null;
        }
        // 未指定角色卡：返回该会话最近一次（跨角色）记录（兼容旧调用）
        let latest = null;
        let latestTime = -1;
        for (const [key, rec] of this.lastPromptMap) {
            // >= 保证同毫秒多条记录时"后插入者"胜出（插入序 = 时间序）
            if (key.startsWith(prefix) && rec.builtAt >= latestTime) {
                latest = rec;
                latestTime = rec.builtAt;
            }
        }
        return latest;
    }

    /**
     * 选择角色开场白（P3）：
     * 加载会话绑定的角色卡，从 [first_message, ...alternate_greetings] 中按
     * session.greetingIndex（默认 0）取模选择。卡不存在 / 无开场白返回 ''。
     * @param {Object} session - 会话状态（需含 character / greetingIndex）
     * @returns {string}
     * @private
     */
    _selectGreeting(session) {
        try {
            if (!this.contextBuilder || typeof this.contextBuilder.selectGreeting !== 'function') return '';
            const greeting = this.contextBuilder.selectGreeting(
                session.character,
                session.greetingIndex ?? 0,
            );
            return greeting || '';
        } catch (e) {
            this.logger.warn?.(`[agent-runner] 开场白加载失败: ${e.message}`);
            return '';
        }
    }
}
