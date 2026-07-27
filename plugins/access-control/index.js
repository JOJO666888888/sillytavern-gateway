/**
 * 权限管理插件
 *
 * 两条能力：
 *   1. 管理命令（仅管理员）：/ban /unban /banlist 维护黑名单
 *   2. 入站过滤器：被拉黑用户的消息在进入命令路由/历史/推理**之前**即被拦截；
 *      可选每人每分钟消息上限（简单滑动窗口限流）。
 *
 * 黑名单持久化在插件配置里（setConfig 自动落盘）。
 * 需要 "gateway.inbound"（拦截入站）权限。管理命令用 adminOnly 收口。
 *
 * 身份格式统一为 "platform:senderId"，也兼容裸 senderId。
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class AccessControlPlugin extends GatewayPlugin {
    static commands = [
        { name: 'ban', handler: 'handleBan', adminOnly: true, description: '拉黑用户', usage: '/ban <platform:senderId 或 senderId>' },
        { name: 'unban', handler: 'handleUnban', adminOnly: true, description: '解禁用户', usage: '/unban <身份>' },
        { name: 'banlist', handler: 'handleBanlist', adminOnly: true, description: '查看黑名单', usage: '/banlist' },
    ];

    constructor(options) {
        super(options);
        this._removeInbound = null;
        // senderKey -> 时间戳数组（滑动窗口限流用）
        this._rateBuckets = new Map();
    }

    async onLoad() {
        const gateway = this._services.gateway;
        if (gateway?.addInboundFilter) {
            this._removeInbound = gateway.addInboundFilter(
                (msg) => this.filterInbound(msg),
                { name: 'access-control', priority: 5 }, // 很靠前，先于其它过滤器
            );
            this.logger.info('访问控制入站过滤器已注册');
        } else {
            this.logger.warn('未获得 addInboundFilter，请确认已授予 gateway.inbound 权限');
        }
    }

    async onUnload() {
        if (this._removeInbound) { this._removeInbound(); this._removeInbound = null; }
        this._rateBuckets.clear();
    }

    // ==================== 入站过滤 ====================

    filterInbound(message) {
        if (!message) return message;
        const key = `${message.platform}:${message.senderId}`;

        // 黑名单拦截
        const blocklist = this.getConfig('blocklist') || [];
        if (blocklist.includes(key) || blocklist.includes(String(message.senderId))) {
            this.logger.debug(`拦截黑名单用户: ${key}`);
            return null;
        }

        // 限流
        const limit = this.getConfig('rateLimit') || 0;
        if (limit > 0 && this._isRateLimited(key, limit)) {
            this.logger.debug(`用户 ${key} 触发限流（${limit}/分钟）`);
            return null;
        }

        return message;
    }

    /** 滑动窗口限流：60 秒内消息数超过 limit 即拦截 */
    _isRateLimited(key, limit) {
        const now = Date.now();
        const windowStart = now - 60_000;
        let bucket = this._rateBuckets.get(key) || [];
        // 丢掉窗口外的时间戳
        bucket = bucket.filter(t => t > windowStart);
        bucket.push(now);
        this._rateBuckets.set(key, bucket);
        return bucket.length > limit;
    }

    // ==================== 管理命令 ====================

    async handleBan(ctx) {
        const target = ctx.args[0];
        if (!target) return ctx.reply('用法: /ban <platform:senderId 或 senderId>');
        const list = [...(this.getConfig('blocklist') || [])];
        if (list.includes(target)) return ctx.reply(`${target} 已在黑名单中`);
        list.push(target);
        this.setConfig('blocklist', list);
        return ctx.reply(`✅ 已拉黑 ${target}`);
    }

    async handleUnban(ctx) {
        const target = ctx.args[0];
        if (!target) return ctx.reply('用法: /unban <身份>');
        const list = (this.getConfig('blocklist') || []).filter(x => x !== target);
        this.setConfig('blocklist', list);
        return ctx.reply(`✅ 已解禁 ${target}`);
    }

    async handleBanlist(ctx) {
        const list = this.getConfig('blocklist') || [];
        if (!list.length) return ctx.reply('黑名单为空');
        return ctx.reply(`🚫 黑名单（${list.length}）:\n${list.map(x => `  · ${x}`).join('\n')}`);
    }
}
