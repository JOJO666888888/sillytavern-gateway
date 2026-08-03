/**
 * 记忆工具
 * 提供四层记忆的检索、更新和读取能力
 *
 * SubTask 6.8 独立角色模式：从 ctx.session.namespace 读取命名空间，
 * 传递给 MemoryEngine 实现角色独立记忆（认知隔离）。
 * - 全局记忆（namespace 为空）：GM 层面的剧情记忆，所有角色共享
 * - 角色独立记忆（namespace='char:alice'）：该角色独享的记忆，其他角色不可见
 */

export function createMemoryTools(memoryEngine) {
    return [
        {
            name: 'memory.recall',
            description: '检索记忆。根据关键词匹配四层记忆（project/reference/feedback/user）中的相关段落。独立角色模式下检索该角色 namespace 的独立记忆。',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '检索关键词（空格分隔多个词）' },
                    limit: { type: 'number', description: '返回结果上限（默认5）' },
                },
                required: ['query'],
            },
            handler: async (args, ctx) => {
                const limit = args.limit || 5;
                const namespace = ctx?.session?.namespace || '';
                const results = await memoryEngine.recall(args.query, limit, namespace);
                return results;
            },
        },
        {
            name: 'memory.update',
            description: '更新记忆文件。type 可选：project(剧情进度)、reference(参考信息)、feedback(用户偏好)、user(用户设定)。独立角色模式下写入该角色 namespace 的独立记忆。',
            parameters: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        enum: ['project', 'reference', 'feedback', 'user'],
                        description: '记忆类型',
                    },
                    content: { type: 'string', description: '记忆内容（会覆盖原有内容）' },
                },
                required: ['type', 'content'],
            },
            handler: async (args, ctx) => {
                const namespace = ctx?.session?.namespace || '';
                const ok = memoryEngine.update(args.type, args.content, namespace);
                return { success: ok, type: args.type };
            },
        },
        {
            name: 'memory.read',
            description: '读取记忆文件内容。type 可选：project、reference、feedback、user。独立角色模式下读取该角色 namespace 的独立记忆。',
            parameters: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        enum: ['project', 'reference', 'feedback', 'user'],
                        description: '记忆类型',
                    },
                },
                required: ['type'],
            },
            handler: async (args, ctx) => {
                const namespace = ctx?.session?.namespace || '';
                const content = memoryEngine.read(args.type, namespace);
                return { type: args.type, content: content || '' };
            },
        },
    ];
}
