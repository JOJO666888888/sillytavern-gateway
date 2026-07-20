/**
 * Plugin Context - 插件上下文 API
 * 每个插件处理器被调用时收到的 ctx 对象
 */

import { OutboundMessage } from './adapters/base-adapter.js';

/**
 * 插件上下文 - 封装消息信息和操作方法
 */
export class PluginContext {
    /**
     * @param {object} options
     * @param {import('./adapters/base-adapter.js').InboundMessage} options.message - 原始入站消息
     * @param {import('./gateway-core.js').GatewayCore} options.gateway - 网关核心实例
     * @param {import('./session-manager.js').SessionManager} options.sessionManager - 会话管理器
     * @param {import('./utils/config.js').default} options.configManager - 配置管理器
     * @param {string} options.pluginName - 当前插件名称
     * @param {object} options.commandArgs - 命令参数（如果是命令触发）
     */
    constructor(options = {}) {
        const { message, gateway, sessionManager, configManager, pluginName, commandArgs } = options;

        // 消息信息
        this.message = message || null;
        this.platform = message?.platform || '';
        this.chatId = message?.chatId || '';
        this.chatType = message?.chatType || 'private';
        this.senderId = message?.senderId || '';
        this.senderName = message?.senderName || '';
        this.content = message?.content || '';
        this.messageId = message?.messageId || '';

        // 命令相关
        this.args = commandArgs || [];
        this.commandName = '';

        // 控制流
        this._propagationStopped = false;
        this._handled = false;

        // 内部服务引用
        this._gateway = gateway;
        this._sessionManager = sessionManager;
        this._configManager = configManager;
        this._pluginName = pluginName || '';
    }

    /**
     * 消息是否已被处理
     */
    get handled() {
        return this._handled;
    }

    set handled(value) {
        this._handled = value;
    }

    /**
     * 传播是否被阻止
     */
    get propagationStopped() {
        return this._propagationStopped;
    }

    // ==================== 回复方法 ====================

    /**
     * 回复到当前会话
     * @param {string} text - 回复内容
     * @param {object} options - 选项 { replyToId?, mediaUrls? }
     */
    async reply(text, options = {}) {
        if (!this._gateway || !this.message) {
            throw new Error('无法回复：缺少网关或消息上下文');
        }

        const outbound = new OutboundMessage({
            platform: this.platform,
            chatId: this.chatId,
            chatType: this.chatType,
            content: text,
            replyToId: options.replyToId || this.messageId,
            mediaUrls: options.mediaUrls || [],
        });

        this._gateway.sendMessage(outbound);
        this._handled = true;
        return outbound;
    }

    /**
     * 私聊回复指定用户
     * @param {string} userId - 用户 ID
     * @param {string} text - 回复内容
     */
    async replyPrivate(userId, text) {
        if (!this._gateway) {
            throw new Error('无法回复：缺少网关上下文');
        }

        const outbound = new OutboundMessage({
            platform: this.platform,
            chatId: userId,
            chatType: 'private',
            content: text,
        });

        this._gateway.sendMessage(outbound);
        this._handled = true;
        return outbound;
    }

    /**
     * 发送消息到任意目标
     * @param {string} platform - 目标平台
     * @param {string} chatId - 目标会话 ID
     * @param {string} text - 消息内容
     * @param {object} options - 选项
     */
    async send(platform, chatId, text, options = {}) {
        if (!this._gateway) {
            throw new Error('无法发送：缺少网关上下文');
        }

        const outbound = new OutboundMessage({
            platform,
            chatId,
            chatType: options.chatType || 'private',
            content: text,
            replyToId: options.replyToId || '',
            mediaUrls: options.mediaUrls || [],
        });

        this._gateway.sendMessage(outbound);
        return outbound;
    }

    // ==================== 会话操作 ====================

    /**
     * 获取当前会话历史
     * @param {number} limit - 最大条数（0 = 全部）
     */
    getHistory(limit = 0) {
        if (!this._sessionManager) return [];
        return this._sessionManager.getHistory(this.platform, this.chatId, limit);
    }

    /**
     * 清空当前会话历史
     */
    clearHistory() {
        if (!this._sessionManager) return;
        this._sessionManager.clearHistory(this.platform, this.chatId);
    }

    // ==================== 配置操作 ====================

    /**
     * 读取网关全局配置
     * @param {string} key - 配置路径（如 'adapters.qq.enabled'）
     */
    getConfig(key) {
        if (!this._configManager) return undefined;
        return this._configManager.get(key);
    }

    /**
     * 读取本插件配置（由 PluginManager 注入）
     * 实际实现由插件基类的 getConfig 提供
     */
    getPluginConfig() {
        // 由外部注入
        return this._pluginConfig || {};
    }

    /**
     * 保存本插件配置
     */
    setPluginConfig(data) {
        this._pluginConfig = data;
        if (this._savePluginConfig) {
            this._savePluginConfig(this._pluginName, data);
        }
    }

    // ==================== 网关服务 ====================

    /**
     * 获取所有适配器状态
     */
    getAdapters() {
        if (!this._gateway) return {};
        return this._gateway.getStatus().adapters;
    }

    /**
     * 获取所有会话列表
     */
    getSessions() {
        if (!this._sessionManager) return [];
        return this._sessionManager.listSessions();
    }

    // ==================== 控制流 ====================

    /**
     * 阻止消息继续传递给后续插件
     */
    stopPropagation() {
        this._propagationStopped = true;
        this._handled = true;
    }
}

export default PluginContext;
