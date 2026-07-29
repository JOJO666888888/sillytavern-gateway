import { ContextBuilder } from '../../../server/agent/context-builder.js';
import { Pipeline } from '../../../server/agent/pipeline.js';

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
     * @returns {Object} { text, steps, logs }
     */
    async run(definition, session, history, userMessage, ctx) {
        const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const startTime = Date.now();
        this.activeRuns.set(runId, { definition, session, startTime });

        try {
            // 1. 构建上下文
            const messages = this.contextBuilder.build(definition, session, history, userMessage);
            this.logger.info(`[agent-runner] Agent "${definition.name}" 启动，messages: ${messages.length}`);

            // 2. 获取工具声明
            const tools = this.toolRegistry.getDeclarations(definition.tools || []);
            const executor = this.toolRegistry.createExecutor({ session, ctx, definition });

            // 3. 构建 pipeline（如有阶段定义）
            let pipeline = null;
            if (definition.pipeline?.stages) {
                pipeline = new Pipeline(definition.pipeline.stages);
            }

            // 4. 执行 agent loop
            const sampling = {
                temperature: definition.model?.temperature ?? 0.8,
                max_tokens: definition.model?.maxTokens ?? 2048,
            };
            const maxSteps = definition.maxSteps || 10;

            const result = await ctx.llm.runTools(messages, tools, executor, { maxSteps, sampling });

            // 5. 检查子代理触发
            let subAgentResults = [];
            if (definition.subAgents && definition.subAgents.length > 0) {
                subAgentResults = await this._triggerSubAgents(definition, result.text, session, ctx);
            }

            // 6. 记录日志
            const logEntry = {
                runId,
                agent: definition.name,
                startTime,
                endTime: Date.now(),
                duration: Date.now() - startTime,
                steps: result.steps,
                success: true,
                subAgentCount: subAgentResults.length,
            };
            this.runLog.push(logEntry);
            if (this.runLog.length > 100) this.runLog.shift();

            return {
                text: result.text,
                steps: result.steps,
                subAgentResults,
                logs: logEntry,
            };
        } catch (e) {
            this.logger.error(`[agent-runner] Agent "${definition.name}" 执行失败: ${e.message}`);
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
            return { text: `Agent 执行出错: ${e.message}`, steps: 0, error: e.message, logs: logEntry };
        } finally {
            this.activeRuns.delete(runId);
        }
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
