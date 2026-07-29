/**
 * 叙事工具
 * 调用 LLM 生成正文内容
 */

export function createNarrativeTools() {
    return [
        {
            name: 'narrative.generate',
            description: '调用 LLM 生成正文内容。可指定文风。',
            parameters: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: '生成提示词（描述要生成的内容）' },
                    style: { type: 'string', description: '文风名称（可选，对应 styles/ 目录下的文件名）' },
                },
                required: ['prompt'],
            },
            handler: async (args, ctx) => {
                // ctx.ctx 是插件上下文，包含 llm
                const llm = ctx.ctx?.llm;
                if (!llm) {
                    return { error: 'LLM 不可用' };
                }

                const messages = [
                    {
                        role: 'system',
                        content: args.style
                            ? `你是一个创意写作助手。请按照「${args.style}」文风生成正文内容。`
                            : '你是一个创意写作助手。请根据提示词生成生动的正文内容。',
                    },
                    { role: 'user', content: args.prompt },
                ];

                try {
                    const text = await llm.chat(messages, { temperature: 0.8, max_tokens: 2048 });
                    return { text: text || '' };
                } catch (e) {
                    return { error: `生成失败: ${e.message}` };
                }
            },
        },
    ];
}
