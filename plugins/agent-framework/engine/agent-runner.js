import { ContextBuilder } from '../../../server/agent/context-builder.js';
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
        const meta = {
            viewMode: definition.viewMode || 'first',
            style: definition.style || session?.style || '',
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
            const baseExecutor = this.toolRegistry.createExecutor({ session, ctx, definition });
            const executor = this._wrapExecutor(baseExecutor, runId, useWorkspace, capturedEvents, () => { draftGenerated = true; });

            // 4. 构建 pipeline（如有阶段定义）
            let pipeline = null;
            if (definition.pipeline?.stages) {
                pipeline = new Pipeline(definition.pipeline.stages);
            }

            // 5. 执行 agent loop
            const sampling = {
                temperature: definition.model?.temperature ?? 0.8,
                max_tokens: definition.model?.maxTokens ?? 2048,
            };
            const maxSteps = definition.maxSteps || 10;

            const result = await ctx.llm.runTools(messages, tools, executor, { maxSteps, sampling });

            // 6. 草稿生成后 checkpoint
            if (useWorkspace && draftGenerated) {
                this.workspaceManager.createCheckpoint(runId, 'after-draft');
            }

            // 7. 检查子代理触发
            let subAgentResults = [];
            if (definition.subAgents && definition.subAgents.length > 0) {
                subAgentResults = await this._triggerSubAgents(definition, result.text, session, ctx);
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
     * 触发子代理
     */
    async _triggerSubAgents(definition, mainResult, session, ctx) {
        const results = [];
        const triggers = definition.subAgents || [];

        // 按触发条件分组
        const afterDraft = triggers.filter(s => s.trigger === 'after_draft');
        const afterOutline = triggers.filter(s => s.trigger === 'after_outline');

        // 并行执行 after_draft 的子代理
        const parallel = afterDraft.filter(s => s.parallel);
        const sequential = afterDraft.filter(s => !s.parallel);

        if (parallel.length > 0) {
            const promises = parallel.map(s => 
                this.subagentDispatcher.dispatch(s.name, `审查以下内容:\n${mainResult}`, session, ctx)
            );
            const parallelResults = await Promise.allSettled(promises);
            for (const r of parallelResults) {
                if (r.status === 'fulfilled') results.push(r.value);
                else results.push({ error: r.reason?.message || '子代理执行失败' });
            }
        }

        for (const s of sequential) {
            const result = await this.subagentDispatcher.dispatch(s.name, `审查以下内容:\n${mainResult}`, session, ctx);
            results.push(result);
        }

        return results;
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
