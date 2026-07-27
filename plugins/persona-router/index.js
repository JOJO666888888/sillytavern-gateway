/**
 * 角色路由插件（Persona Router）
 *
 * 为每个会话独立切换「人设」（system prompt），再用网关配置的 LLM 以该人设对话：
 *   - /persona                列出所有可用人设，并显示当前会话正在用哪个
 *   - /persona <名字>         把当前会话切换到指定人设
 *   - /persona reset          恢复默认人设
 *   - 可选：对非命令消息自动回复（私聊直接答；群聊仅在被 @ 时答）
 *
 * 人设定义在配置的 personas 里（名字 -> system prompt）。每个会话选中的人设
 * 记在 sessionPersonas（platform:chatId -> 人设名），通过 setConfig 持久化。
 *
 * 需要 "llm"（调用模型）+ "sessions"（读写会话历史）权限，拿不到 API key。
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class PersonaRouterPlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'persona',
            alias: ['人设', '角色'],
            handler: 'handlePersona',
            description: '查看/切换当前会话的 AI 人设',
            usage: '/persona            列出人设\n/persona <名字>     切换人设\n/persona reset      恢复默认',
        },
    ];

    static listeners = [
        {
            event: 'message',
            filter: {},
            handler: 'onMessage',
            priority: 150,
        },
    ];

    /** 会话键：platform:chatId */
    _sessionKey(ctx) {
        return `${ctx.platform}:${ctx.chatId}`;
    }

    /** 取当前会话选中的人设名（未选则用默认） */
    _currentPersonaName(ctx) {
        const map = this.getConfig('sessionPersonas') || {};
        return map[this._sessionKey(ctx)] || this.getConfig('defaultPersona') || 'default';
    }

    /** 取人设的 system prompt（找不到就回退默认人设，再回退硬编码） */
    _personaPrompt(name) {
        const personas = this.getConfig('personas') || {};
        if (personas[name]) return personas[name];
        const def = this.getConfig('defaultPersona') || 'default';
        return personas[def] || '你是一个乐于助人的助手。';
    }

    async handlePersona(ctx) {
        const arg = ctx.args.join(' ').trim();
        const personas = this.getConfig('personas') || {};
        const names = Object.keys(personas);
        const current = this._currentPersonaName(ctx);

        // 无参数：列出人设
        if (!arg) {
            const lines = names.map((n) => `${n === current ? '▶' : '·'} ${n}`);
            return ctx.reply(
                `🎭 当前人设：${current}\n可用人设：\n${lines.join('\n')}\n\n用 /persona <名字> 切换`
            );
        }

        // 重置
        if (arg === 'reset' || arg === '重置' || arg === '默认') {
            this._setSessionPersona(ctx, null);
            return ctx.reply(`↩️ 已恢复默认人设：${this.getConfig('defaultPersona') || 'default'}`);
        }

        // 切换
        if (!personas[arg]) {
            return ctx.reply(`未找到人设「${arg}」。可用：${names.join('、')}`);
        }
        this._setSessionPersona(ctx, arg);
        // 切换人设后清空对话记忆，避免旧人设的上下文串味
        ctx.clearHistory();
        return ctx.reply(`✅ 已切换到人设「${arg}」，对话记忆已清空`);
    }

    /** 写入/清除当前会话的人设选择并持久化 */
    _setSessionPersona(ctx, name) {
        const map = { ...(this.getConfig('sessionPersonas') || {}) };
        const key = this._sessionKey(ctx);
        if (name) map[key] = name;
        else delete map[key];
        this.setConfig('sessionPersonas', map);
    }

    /** 自动回复：私聊直接答；群聊仅在被 @ 时答。命令消息跳过。 */
    async onMessage(ctx) {
        if (!this.getConfig('autoReply')) return;
        const content = (ctx.content || '').trim();
        if (!content || content.startsWith('/')) return;

        const isGroup = ctx.chatType === 'group' || ctx.chatType === 'channel';
        if (isGroup) {
            if (!this.getConfig('autoReplyInGroup')) return;
            if (!ctx.message?.mentioned) return;
        }

        await this._respond(ctx, content);
        ctx.stopPropagation();
    }

    /** 用当前会话人设构造消息，调用 LLM，回复并写入历史 */
    async _respond(ctx, userText) {
        const personaName = this._currentPersonaName(ctx);
        const systemPrompt = this._personaPrompt(personaName);
        const historyLimit = this.getConfig('historyLimit') ?? 10;

        const messages = [{ role: 'system', content: systemPrompt }];

        if (historyLimit > 0) {
            const history = ctx.getHistory(historyLimit * 2);
            for (const h of history) {
                if (h.role === 'user' || h.role === 'assistant') {
                    messages.push({ role: h.role, content: h.content });
                }
            }
        }
        messages.push({ role: 'user', content: userText });

        try {
            const reply = await ctx.llm.chat(messages, {
                temperature: this.getConfig('temperature') ?? 0.8,
                max_tokens: this.getConfig('maxTokens') ?? 1024,
            });

            await ctx.reply(reply);

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
