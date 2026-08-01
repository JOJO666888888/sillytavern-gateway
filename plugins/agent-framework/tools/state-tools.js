/**
 * 状态工具
 * 提供会话状态的读取、写入和列表能力
 *
 * SubTask 6.8 独立角色模式：从 ctx.session.namespace 读取命名空间，
 * 传递给 StateManager 实现角色私有状态隔离。
 * - 全局状态（namespace 为空）：世界状态，所有角色共享
 * - 角色私有状态（namespace='char:alice'）：该角色独享的状态
 */

export function createStateTools(stateManager) {
    return [
        {
            name: 'state.read',
            description: '读取当前会话的状态。不传key则返回全部状态。独立角色模式下读取该角色 namespace 的私有状态。',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: '状态键名（可选）' },
                },
            },
            handler: async (args, ctx) => {
                const platform = ctx.session?.platform || 'unknown';
                const chatId = ctx.session?.chatId || 'unknown';
                const namespace = ctx.session?.namespace || '';
                const value = stateManager.read(platform, chatId, args.key, namespace);
                return value;
            },
        },
        {
            name: 'state.write',
            description: '写入会话状态。独立角色模式下写入该角色 namespace 的私有状态。',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: '状态键名' },
                    value: { description: '状态值（任意类型）' },
                },
                required: ['key', 'value'],
            },
            handler: async (args, ctx) => {
                const platform = ctx.session?.platform || 'unknown';
                const chatId = ctx.session?.chatId || 'unknown';
                const namespace = ctx.session?.namespace || '';
                stateManager.write(platform, chatId, args.key, args.value, namespace);
                return { success: true, key: args.key };
            },
        },
        {
            name: 'state.list',
            description: '列出当前会话的所有状态键。',
            parameters: { type: 'object', properties: {} },
            handler: async (args, ctx) => {
                const platform = ctx.session?.platform || 'unknown';
                const chatId = ctx.session?.chatId || 'unknown';
                const namespace = ctx.session?.namespace || '';
                return stateManager.list(platform, chatId, namespace);
            },
        },
        {
            name: 'state.delete',
            description: '删除指定状态键。',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: '要删除的状态键名' },
                },
                required: ['key'],
            },
            handler: async (args, ctx) => {
                const platform = ctx.session?.platform || 'unknown';
                const chatId = ctx.session?.chatId || 'unknown';
                const namespace = ctx.session?.namespace || '';
                stateManager.delete(platform, chatId, args.key, namespace);
                return { success: true, key: args.key };
            },
        },
    ];
}
