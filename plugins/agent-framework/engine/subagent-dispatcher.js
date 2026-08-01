import { ContextBuilder } from '../../../server/agent/context-builder.js';

/**
 * 子代理调度器
 * 负责创建独立上下文并执行子代理
 *
 * SubTask 6.8 独立角色模式：支持 namespace 隔离。
 * 子代理定义中的 namespace 字段（或调度时 options.namespace）会被注入到 session，
 * 供 state/memory 工具识别并使用独立的存储路径，实现认知隔离。
 */
export class SubagentDispatcher {
    constructor(options = {}) {
        this.agentLoader = options.agentLoader;
        this.toolRegistry = options.toolRegistry;
        this.contextBuilder = options.contextBuilder || new ContextBuilder(options);
        this.logger = options.logger || console;
    }

    /**
     * 解析子代理执行时使用的 namespace。
     * 优先级：options.namespace > definition.namespace > session.namespace > ''
     * 支持 ${variable} 占位符替换（如 "char:${character}" -> "char:alice"）。
     * @param {Object} definition - 子代理定义
     * @param {Object} session - 会话状态
     * @param {Object} options - 调度选项
     * @returns {string}
     * @private
     */
    _resolveNamespace(definition, session, options) {
        let ns = options?.namespace || definition?.namespace || session?.namespace || '';
        if (!ns) return '';
        // 替换 ${variable} 占位符
        ns = String(ns).replace(/\$\{(\w+)\}/g, (_, key) => session?.[key] ?? '');
        return ns;
    }

    /**
     * 调度子代理
     * @param {string} agentName - 子代理名称
     * @param {string} task - 任务描述
     * @param {Object} session - 会话状态
     * @param {Object} ctx - 插件上下文
     * @param {Object} options - { injectFiles?, tools?, await?, namespace? }
     * @returns {Object} { text, steps, agent, namespace }
     */
    async dispatch(agentName, task, session, ctx, options = {}) {
        // 查找子代理定义
        const definition = this.agentLoader.get(agentName);
        if (!definition) {
            return { error: `子代理 "${agentName}" 不存在`, agent: agentName };
        }

        this.logger.info(`[subagent-dispatcher] 调度子代理: ${agentName}`);

        // 解析 namespace（SubTask 6.8 独立角色模式）
        const namespace = this._resolveNamespace(definition, session, options);

        // 把 namespace 注入 session 副本，供 state/memory 工具使用
        const scopedSession = namespace
            ? { ...session, namespace }
            : session;

        // 构建独立上下文（不包含主 Agent 的历史消息）
        const messages = this.contextBuilder.build(definition, scopedSession, [], task);

        // 获取工具声明（使用子代理自己的白名单）
        const tools = this.toolRegistry.getDeclarations(definition.tools || []);
        const executor = this.toolRegistry.createExecutor({
            session: scopedSession,
            ctx,
            definition,
            isSubAgent: true,
        });

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
                namespace,
            };
        } catch (e) {
            this.logger.error(`[subagent-dispatcher] 子代理 "${agentName}" 执行失败: ${e.message}`);
            return { error: e.message, agent: agentName, namespace };
        }
    }

    /**
     * 并行调度多个子代理
     * @param {string[]} agentNames
     * @param {string} task
     * @param {Object} session
     * @param {Object} ctx
     * @param {Object} [options] - { namespaces?: string[] } 每个子代理的 namespace
     */
    async dispatchParallel(agentNames, task, session, ctx, options = {}) {
        const namespaces = options.namespaces || [];
        const promises = agentNames.map((name, i) => {
            const ns = namespaces[i] || '';
            return this.dispatch(name, task, session, ctx, ns ? { namespace: ns } : {});
        });
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
