import { ContextBuilder } from '../../../server/agent/context-builder.js';

/**
 * 子代理调度器
 * 负责创建独立上下文并执行子代理
 */
export class SubagentDispatcher {
    constructor(options = {}) {
        this.agentLoader = options.agentLoader;
        this.toolRegistry = options.toolRegistry;
        this.contextBuilder = options.contextBuilder || new ContextBuilder(options);
        this.logger = options.logger || console;
    }

    /**
     * 调度子代理
     * @param {string} agentName - 子代理名称
     * @param {string} task - 任务描述
     * @param {Object} session - 会话状态
     * @param {Object} ctx - 插件上下文
     * @param {Object} options - { injectFiles?, tools?, await? }
     * @returns {Object} { text, steps, agent }
     */
    async dispatch(agentName, task, session, ctx, options = {}) {
        // 查找子代理定义
        const definition = this.agentLoader.get(agentName);
        if (!definition) {
            return { error: `子代理 "${agentName}" 不存在`, agent: agentName };
        }

        this.logger.info(`[subagent-dispatcher] 调度子代理: ${agentName}`);

        // 构建独立上下文（不包含主 Agent 的历史消息）
        const messages = this.contextBuilder.build(definition, session, [], task);

        // 获取工具声明（使用子代理自己的白名单）
        const tools = this.toolRegistry.getDeclarations(definition.tools || []);
        const executor = this.toolRegistry.createExecutor({ session, ctx, definition, isSubAgent: true });

        // 执行
        const sampling = {
            temperature: definition.model?.temperature ?? 0.5, // 子代理用较低温度
            max_tokens: definition.model?.maxTokens ?? 1024,
        };
        const maxSteps = definition.maxSteps || 5;

        try {
            const result = await ctx.llm.runTools(messages, tools, executor, { maxSteps, sampling });
            return {
                text: result.text,
                steps: result.steps,
                agent: agentName,
            };
        } catch (e) {
            this.logger.error(`[subagent-dispatcher] 子代理 "${agentName}" 执行失败: ${e.message}`);
            return { error: e.message, agent: agentName };
        }
    }

    /**
     * 并行调度多个子代理
     */
    async dispatchParallel(agentNames, task, session, ctx) {
        const promises = agentNames.map(name => this.dispatch(name, task, session, ctx));
        const results = await Promise.allSettled(promises);
        return results.map((r, i) => {
            if (r.status === 'fulfilled') return r.value;
            return { error: r.reason?.message || '执行失败', agent: agentNames[i] };
        });
    }

    /**
     * 列出可用子代理
     */
    listAvailable() {
        return this.agentLoader.list();
    }
}
