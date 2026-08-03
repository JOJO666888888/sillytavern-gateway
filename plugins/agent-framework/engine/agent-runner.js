import { ContextBuilder, extractDefinitionVar } from '../../../server/agent/context-builder.js';
import { Pipeline } from '../../../server/agent/pipeline.js';
import { AgentRunResult, AgentEventType } from '../../../server/agent/run-result.js';

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
        this.activeRuns = new Map();
        this.runLog = [];
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
        this.activeRuns.set(runId, { definition, session, startTime });

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
            // 1. 构建上下文
            const messages = this.contextBuilder.build(definition, session, history, userMessage);
            this.logger.info(`[agent-runner] Agent "${definition.name}" 启动，messages: ${messages.length}`);

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
            // runId 注入工具执行上下文，供 collab.* 协作工具绑定消息
            const baseExecutor = this.toolRegistry.createExecutor({ session, ctx, definition, runId });
            const executor = this._wrapExecutor(baseExecutor, runId, useWorkspace, capturedEvents, () => { draftGenerated = true; });

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
            const sessionKey = `${session?.platform || 'unknown'}:${session?.chatId || 'unknown'}`;

            let result;
            if (typeof ctx.llm.runToolsStream === 'function') {
                result = await ctx.llm.runToolsStream(messages, tools, executor, {
                    maxSteps,
                    sampling,
                    onDelta: (delta, full, turn) => this.onTokenDelta?.(runId, delta, full, turn, sessionKey),
                });
            } else {
                result = await ctx.llm.runTools(messages, tools, executor, { maxSteps, sampling });
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
                    if (useWorkspace) this.workspaceManager.appendEvent(runId, 'subagent', r);
                }
            }

            // 8. 产出 AgentRunResult（主文本 artifact + 注入捕获的事件）
            const runResult = AgentRunResult.fromRunResult(result.text, result.steps, runId, meta);
            for (const ev of capturedEvents) {
                runResult.addEvent(ev.type, ev.payload);
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
            this.logger.error(`[agent-runner] Agent "${definition.name}" 执行失败: ${e.message}`);
            // 失败/取消不 commit，workspace 保留供审计
            const logEntry = {
                runId,
                agent: definition.name,
                startTime,
                endTime: Date.now(),
                success: false,
                error: e.message,
            };
            this.runLog.push(logEntry);
            if (this.runLog.length > 100) this.runLog.shift();

            const errResult = AgentRunResult.fromRunResult(`Agent 执行出错: ${e.message}`, 0, runId, meta);
            return {
                runId,
                result: errResult,
                text: errResult.getMainText(),
                steps: 0,
                error: e.message,
                logs: logEntry,
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
     * @returns {Function} 包装后的执行器
     * @private
     */
    _wrapExecutor(baseExecutor, runId, useWorkspace, capturedEvents, onDraft) {
        return async (name, args) => {
            capturedEvents.push({
                type: AgentEventType.TOOL_CALL,
                payload: { tool: name, args },
            });
            if (typeof name === 'string' && name.startsWith('state.')) {
                capturedEvents.push({
                    type: AgentEventType.STATE_CHANGE,
                    payload: { tool: name, args },
                });
            }
            if (name === 'narrative.generate') {
                capturedEvents.push({
                    type: AgentEventType.DRAFT,
                    payload: { args },
                });
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
}
