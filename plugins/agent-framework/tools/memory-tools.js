/**
 * 记忆工具
 * 提供四层记忆的检索、更新和读取能力
 */

export function createMemoryTools(memoryEngine) {
    return [
        {
            name: 'memory.recall',
            description: '检索记忆。根据关键词匹配四层记忆（project/reference/feedback/user）中的相关段落。',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '检索关键词（空格分隔多个词）' },
                    limit: { type: 'number', description: '返回结果上限（默认5）' },
                },
                required: ['query'],
            },
            handler: async (args) => {
                const limit = args.limit || 5;
                const results = memoryEngine.recall(args.query, limit);
                return results;
            },
        },
        {
            name: 'memory.update',
            description: '更新记忆文件。type 可选：project(剧情进度)、reference(参考信息)、feedback(用户偏好)、user(用户设定)。',
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
            handler: async (args) => {
                const ok = memoryEngine.update(args.type, args.content);
                return { success: ok, type: args.type };
            },
        },
        {
            name: 'memory.read',
            description: '读取记忆文件内容。type 可选：project、reference、feedback、user。',
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
            handler: async (args) => {
                const content = memoryEngine.read(args.type);
                return { type: args.type, content: content || '' };
            },
        },
    ];
}
