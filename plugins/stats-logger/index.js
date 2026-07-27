/**
 * 日志统计插件（Stats Logger）
 *
 * 通过入站过滤器（不拦截，只观测）统计流经网关的消息量：
 *   - 按平台计数
 *   - 按会话（platform:chatId）计数
 *   - 按用户（platform:senderId）计数
 *
 * 提供查询命令：
 *   - /stats            总览（总量 + 各平台）
 *   - /stats top        消息最多的会话与用户 Top N
 *   - /stats reset      清零（仅管理员）
 *
 * 计数是进程内内存态（重启即清零），不落盘，避免污染存储。
 * 需要 "gateway.inbound"（挂载入站过滤器观测）权限。过滤器只读不改，原样放行。
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class StatsLoggerPlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'stats',
            alias: ['统计'],
            handler: 'handleStats',
            description: '查看消息统计',
            usage: '/stats [top|reset]',
        },
    ];

    constructor(options) {
        super(options);
        this._removeInbound = null;
        this._startedAt = Date.now();
        this._reset();
    }

    _reset() {
        this._total = 0;
        this._byPlatform = new Map();
        this._byChat = new Map();
        this._byUser = new Map();
        this._startedAt = Date.now();
    }

    async onLoad() {
        const gateway = this._services.gateway;
        if (gateway?.addInboundFilter) {
            this._removeInbound = gateway.addInboundFilter(
                (msg) => this._observe(msg),
                { name: 'stats-logger', priority: 100 }, // 靠后，尽量在其它拦截器放行后再计数
            );
            this.logger.info('统计入站过滤器已注册');
        } else {
            this.logger.warn('未获得 addInboundFilter，请确认已授予 gateway.inbound 权限');
        }
    }

    async onUnload() {
        if (this._removeInbound) { this._removeInbound(); this._removeInbound = null; }
    }

    /** 入站观测：只计数，原样返回消息（绝不拦截） */
    _observe(message) {
        if (!message) return message;
        this._total += 1;
        this._bump(this._byPlatform, message.platform || 'unknown');
        this._bump(this._byChat, `${message.platform}:${message.chatId}`);
        this._bump(this._byUser, `${message.platform}:${message.senderId}`);
        return message;
    }

    _bump(map, key) {
        map.set(key, (map.get(key) || 0) + 1);
    }

    _isAdmin(ctx) {
        // 读网关 admins 白名单（格式 "platform:senderId" 或裸 senderId）。
        // 插件的收窄服务不含 configManager，改用 ctx 上注入的 _configManager
        // （与 CommandRouter 的 adminOnly 判定同源）。
        const cfg = ctx._configManager;
        const admins = cfg?.get?.('admins') || [];
        const key = `${ctx.platform}:${ctx.senderId}`;
        return admins.includes(key) || admins.includes(String(ctx.senderId));
    }

    async handleStats(ctx) {
        const sub = (ctx.args[0] || '').trim();

        if (sub === 'reset' || sub === '清零') {
            if (!this._isAdmin(ctx)) return ctx.reply('仅管理员可清零统计');
            this._reset();
            return ctx.reply('✅ 统计已清零');
        }

        if (sub === 'top') {
            const n = this.getConfig('topN') || 10;
            const chats = this._top(this._byChat, n);
            const users = this._top(this._byUser, n);
            const fmt = (arr) => arr.length ? arr.map(([k, v], i) => `  ${i + 1}. ${k} — ${v}`).join('\n') : '  （无）';
            return ctx.reply(`🏆 Top ${n} 会话:\n${fmt(chats)}\n\n🏆 Top ${n} 用户:\n${fmt(users)}`);
        }

        // 总览
        const uptimeMin = Math.floor((Date.now() - this._startedAt) / 60000);
        const platforms = [...this._byPlatform.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([p, c]) => `  · ${p}: ${c}`)
            .join('\n') || '  （无）';
        return ctx.reply(
            `📊 消息统计（自 ${uptimeMin} 分钟前）\n`
            + `总量: ${this._total}\n`
            + `会话数: ${this._byChat.size}  用户数: ${this._byUser.size}\n`
            + `各平台:\n${platforms}\n\n`
            + `用 /stats top 看排行`
        );
    }

    /** 取 Map 中计数最高的 n 项，返回 [[key, count], ...] */
    _top(map, n) {
        return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    }
}
