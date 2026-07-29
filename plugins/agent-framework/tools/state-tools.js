/**
 * 状态工具
 * 提供会话状态的读取、写入和列表能力
 */

export function createStateTools(stateManager) {
    return [
        {
            name: 'state.read',
            description: '读取当前会话的状态。不传key则返回全部状态。',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: '状态键名（可选）' },
                },
            },
            handler: async (args, ctx) => {
                const platform = ctx.session?.platform || 'unknown';
                const chatId = ctx.session?.chatId || 'unknown';
                const value = stateManager.read(platform, chatId, args.key);
                return value;
            },
        },
        {
            name: 'state.write',
            description: '写入会话状态。',
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
                stateManager.write(platform, chatId, args.key, args.value);
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
                return stateManager.list(platform, chatId);
            },
        },
    ];
}
