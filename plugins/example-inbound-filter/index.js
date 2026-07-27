/**
 * 入站过滤示例插件
 *
 * 演示 addInboundFilter：在消息进入命令路由 / 会话历史 / 推理管线**之前**，
 *   - 脱敏（把手机号替换为 [手机号]）
 *   - 拦截黑名单用户（返回 null，网关直接丢弃该消息）
 *
 * 入站过滤器需要 "gateway.inbound" 权限（medium 风险，非默认授予）。
 * 这是移植 AstrBot 消息预处理/拦截型插件的参考样板。
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';

const PHONE_RE = /1\d{10}/g;

export default class InboundFilterExamplePlugin extends GatewayPlugin {
    constructor(options) {
        super(options);
        this._removeInbound = null;
    }

    async onLoad() {
        const gateway = this._services.gateway;
        if (gateway?.addInboundFilter) {
            // 保存注销函数，onUnload 时调用；框架也会在禁用/卸载时兜底回收
            this._removeInbound = gateway.addInboundFilter(
                (msg) => this.filterInbound(msg),
                { name: 'example-inbound', priority: 10 },
            );
            this.logger.info('入站过滤器已注册');
        } else {
            this.logger.warn('未获得 addInboundFilter，请确认已授予 gateway.inbound 权限');
        }
    }

    async onUnload() {
        if (this._removeInbound) {
            this._removeInbound();
            this._removeInbound = null;
        }
    }

    /**
     * @param {import('../../server/adapters/base-adapter.js').InboundMessage} message
     * @returns {object|null} 改写后的消息，或 null（拦截）
     */
    filterInbound(message) {
        if (!message?.content) return message;

        // 拦截黑名单用户
        const blocklist = this.getConfig('blocklist') || [];
        if (blocklist.includes(message.senderId)) {
            this.logger.debug(`拦截黑名单用户消息: ${message.senderId}`);
            return null;
        }

        // 脱敏手机号
        if (this.getConfig('redactPhone') !== false) {
            message.content = message.content.replace(PHONE_RE, '[手机号]');
        }

        return message;
    }
}
