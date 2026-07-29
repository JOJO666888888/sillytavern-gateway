/**
 * 子代理工具
 * 调度子代理执行任务，列出可用子代理
 */

export function createSubAgentTools(subagentDispatcher) {
    return [
        {
            name: 'subagent.dispatch',
            description: '调度子代理执行任务。子代理拥有独立上下文，不共享主 Agent 的历史消息。',
            parameters: {
                type: 'object',
                properties: {
                    agent: { type: 'string', description: '子代理名称' },
                    task: { type: 'string', description: '任务描述' },
                    await: { type: 'boolean', description: '是否等待子代理完成（默认 true）' },
                },
                required: ['agent', 'task'],
            },
            handler: async (args, ctx) => {
                const options = { await: args.await !== false };
                // ctx.ctx 是插件上下文，ctx.session 是会话状态
                const pluginCtx = ctx.ctx;
                const session = ctx.session || {};

                if (!pluginCtx) {
                    return { error: '插件上下文不可用' };
                }

                try {
                    const result = await subagentDispatcher.dispatch(
                        args.agent,
                        args.task,
                        session,
                        pluginCtx,
                        options,
                    );
                    return result;
                } catch (e) {
                    return { error: `子代理调度失败: ${e.message}`, agent: args.agent };
                }
            },
        },
        {
            name: 'subagent.list',
            description: '列出所有可用的子代理。',
            parameters: { type: 'object', properties: {} },
            handler: async () => {
                const agents = subagentDispatcher.listAvailable();
                return { agents };
            },
        },
    ];
}
