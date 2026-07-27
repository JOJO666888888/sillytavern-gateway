/**
 * 群管理插件（Group Manager）
 *
 * 面向群聊的两类辅助能力：
 *   1. 关键词自动回复：命中配置的关键词就自动回复固定话术（带冷却，避免刷屏）。
 *      - keywordMode: "contains"（包含）| "exact"（完全匹配）| "prefix"（前缀）
 *      - keywordInGroupOnly: 仅在群聊/频道生效
 *   2. 管理命令（仅管理员）：
 *      - /announce <文本>   把公告广播到当前会话
 *      - /gm keywords       查看当前关键词表
 *
 * 注意：本网关的入站管线只分发 message 事件，成员入群等 notice 事件不会到达插件，
 * 因此这里不提供“进群欢迎”功能（无法可靠触发），改以关键词/公告覆盖群管高频需求。
 *
 * 需要 "gateway.send"（主动发送消息）权限。
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class GroupManagerPlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'announce',
            alias: ['公告'],
            handler: 'handleAnnounce',
            adminOnly: true,
            description: '在当前会话发布一条公告',
            usage: '/announce <公告内容>',
        },
        {
            name: 'gm',
            handler: 'handleGm',
            adminOnly: true,
            description: '群管理工具',
            usage: '/gm keywords   查看关键词表',
        },
    ];

    static listeners = [
        {
            event: 'message',
            filter: {},
            handler: 'onMessage',
            priority: 200, // 靠后，让命令与对话类插件先处理
        },
    ];

    constructor(options) {
        super(options);
        // 关键词冷却：`${chatKey}::${match}` -> 上次触发时间戳
        this._cooldowns = new Map();
    }

    // ==================== 关键词自动回复 ====================

    async onMessage(ctx) {
        const content = (ctx.content || '').trim();
        if (!content || content.startsWith('/')) return;

        if (this.getConfig('keywordInGroupOnly')) {
            const isGroup = ctx.chatType === 'group' || ctx.chatType === 'channel';
            if (!isGroup) return;
        }

        const hit = this._matchKeyword(content);
        if (!hit) return;

        // 冷却：同一会话同一关键词，cooldown 秒内只回一次
        const cooldown = (this.getConfig('keywordCooldownSeconds') ?? 10) * 1000;
        const key = `${ctx.platform}:${ctx.chatId}::${hit.match}`;
        const now = Date.now();
        if (cooldown > 0) {
            const last = this._cooldowns.get(key) || 0;
            if (now - last < cooldown) return;
            this._cooldowns.set(key, now);
        }

        await ctx.reply(hit.reply);
        ctx.stopPropagation();
    }

    /** 按 keywordMode 匹配关键词，返回命中的 {match, reply} 或 null */
    _matchKeyword(content) {
        const keywords = this.getConfig('keywords') || [];
        const mode = this.getConfig('keywordMode') || 'contains';
        for (const kw of keywords) {
            if (!kw || !kw.match) continue;
            const m = String(kw.match);
            let matched = false;
            if (mode === 'exact') matched = content === m;
            else if (mode === 'prefix') matched = content.startsWith(m);
            else matched = content.includes(m); // contains
            if (matched) return kw;
        }
        return null;
    }

    // ==================== 管理命令 ====================

    async handleAnnounce(ctx) {
        const text = ctx.args.join(' ').trim();
        if (!text) return ctx.reply('用法: /announce <公告内容>');
        // 用 send 主动发送（需要 gateway.send 权限），带醒目前缀
        await ctx.send(ctx.platform, ctx.chatId, `📢 【公告】${text}`, { chatType: ctx.chatType });
        return;
    }

    async handleGm(ctx) {
        const sub = (ctx.args[0] || '').trim();
        if (sub === 'keywords' || sub === '关键词') {
            const keywords = this.getConfig('keywords') || [];
            if (!keywords.length) return ctx.reply('未配置关键词');
            const mode = this.getConfig('keywordMode') || 'contains';
            const lines = keywords.map((k) => `  · [${k.match}] → ${k.reply}`);
            return ctx.reply(`🔑 关键词（模式：${mode}）:\n${lines.join('\n')}`);
        }
        return ctx.reply('用法: /gm keywords   查看关键词表');
    }
}
