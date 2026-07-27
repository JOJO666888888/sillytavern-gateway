/**
 * LLM 直连插件
 *
 * 让机器人用网关配置的 LLM（runtime.llm）直接对话：
 *   - /chat <问题>          单轮问答
 *   - /chat clear           清空当前会话的对话记忆
 *   - 可选：对非命令消息自动回复（私聊直接答；群聊仅在被 @ 时答）
 *
 * 带多轮记忆：把最近 historyLimit 轮对话作为上下文送入模型。
 * 需要 "llm"（调用模型）+ "sessions"（读写会话历史）权限，拿不到 API key。
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class LLMChatPlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'chat',
            alias: ['问', '聊天'],
            handler: 'handleChat',
            description: '与 AI 对话（带多轮记忆）',
            usage: '/chat <问题>  或  /chat clear 清空记忆',
        },
    ];

    static listeners = [
        {
            event: 'message',
            filter: {},
            handler: 'onMessage',
            priority: 150, // 低于命令，让 /chat 等命令先处理
        },
    ];

    async handleChat(ctx) {
        const arg = ctx.args.join(' ').trim();
        if (arg === 'clear' || arg === '清空') {
            ctx.clearHistory();
            return ctx.reply('🧹 已清空对话记忆');
        }
        if (!arg) return ctx.reply('用法: /chat <问题>（/chat clear 清空记忆）');
        return this._respond(ctx, arg);
    }

    /**
     * 自动回复：私聊直接答；群聊仅在被 @ 时答。命令消息（/开头）跳过。
     */
    async onMessage(ctx) {
        if (!this.getConfig('autoReply')) return;
        const content = (ctx.content || '').trim();
        if (!content || content.startsWith('/')) return;

        const isGroup = ctx.chatType === 'group' || ctx.chatType === 'channel';
        if (isGroup) {
            // 群聊需开启开关且被 @
            if (!this.getConfig('autoReplyInGroup')) return;
            if (!ctx.message?.mentioned) return;
        }

        await this._respond(ctx, content);
        // 标记已处理，阻止后续监听器重复回复
        ctx.stopPropagation();
    }

    /** 构造消息（system + 历史 + 本轮），调用 LLM，回复并写入历史 */
    async _respond(ctx, userText) {
        const systemPrompt = this.getConfig('systemPrompt') || '你是一个乐于助人的助手。';
        const historyLimit = this.getConfig('historyLimit') ?? 10;

        const messages = [{ role: 'system', content: systemPrompt }];

        // 带入历史（会话历史里存的就是 {role, content} 形状）
        if (historyLimit > 0) {
            const history = ctx.getHistory(historyLimit * 2); // 一轮=用户+助手两条
            for (const h of history) {
                if (h.role === 'user' || h.role === 'assistant') {
                    messages.push({ role: h.role, content: h.content });
                }
            }
        }
        messages.push({ role: 'user', content: userText });

        try {
            const reply = await ctx.llm.chat(messages, {
                temperature: this.getConfig('temperature') ?? 0.7,
                max_tokens: this.getConfig('maxTokens') ?? 1024,
            });

            await ctx.reply(reply);

            // 写入会话历史，供下一轮记忆
            const sm = this._services.sessionManager;
            if (sm?.addMessage) {
                sm.addMessage(ctx.platform, ctx.chatId, { role: 'user', content: userText, name: ctx.senderName });
                sm.addMessage(ctx.platform, ctx.chatId, { role: 'assistant', content: reply });
            }
        } catch (e) {
            this.logger.error(`LLM 调用失败: ${e.message}`);
            await ctx.reply(`抱歉，AI 暂时无法回复：${e.message}`);
        }
    }
}
