import EventEmitter from 'eventemitter3';
import { createLogger } from '../utils/logger.js';
import { ReconnectStrategy } from '../utils/reconnect.js';

/**
 * 连接状态枚举
 */
export const ConnectionState = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    ERROR: 'error',
};

/**
 * 标准入站消息
 */
export class InboundMessage {
    constructor(data = {}) {
        this.platform = data.platform || 'unknown';   // 'qq' | 'telegram' | 'discord'
        this.messageId = data.messageId || '';        // 平台原始消息ID
        this.chatId = data.chatId || '';              // 会话标识
        this.chatType = data.chatType || 'private';   // 'private' | 'group' | 'channel'
        this.senderId = data.senderId || '';          // 发送者ID
        this.senderName = data.senderName || '';      // 发送者昵称
        this.content = data.content || '';            // 文本内容
        this.mediaUrls = data.mediaUrls || [];        // 媒体附件URL列表
        this.timestamp = data.timestamp || Date.now();// 时间戳
        this.raw = data.raw || null;                  // 原始平台数据
        this.mentioned = data.mentioned || false;     // 是否@了机器人
        this.replyToId = data.replyToId || '';        // 回复的消息ID
    }
}

/**
 * 标准出站消息
 */
export class OutboundMessage {
    constructor(data = {}) {
        this.platform = data.platform || 'unknown';
        this.chatId = data.chatId || '';
        this.chatType = data.chatType || 'private';
        this.content = data.content || '';
        this.mediaUrls = data.mediaUrls || [];
        this.replyToId = data.replyToId || '';
        this.metadata = data.metadata || {};          // 平台特定元数据
    }
}

/**
 * 平台适配器基类
 * 所有平台适配器必须继承此类并实现抽象方法
 *
 * 事件:
 * - 'message' (InboundMessage) - 收到消息
 * - 'connected' () - 连接成功
 * - 'disconnected' (reason) - 连接断开
 * - 'error' (error) - 发生错误
 * - 'statusChange' (oldState, newState) - 状态变化
 */
export class PlatformAdapter extends EventEmitter {
    /**
     * @param {string} name - 适配器名称
     * @param {object} config - 适配器配置
     */
    constructor(name, config = {}) {
        super();
        this.name = name;
        this.config = config;
        this.logger = createLogger(`adapter:${name}`);
        this.state = ConnectionState.DISCONNECTED;
        this.connectedAt = null;
        this.reconnectStrategy = new ReconnectStrategy({
            initialDelay: config.reconnectInterval || 5000,
            maxDelay: config.maxReconnectInterval || 60000,
            maxRetries: 0, // 无限重试
        });
        this._shouldReconnect = true;
    }

    /**
     * 建立连接（子类必须实现）
     * @abstract
     */
    async connect() {
        throw new Error(`${this.name}: connect() 未实现`);
    }

    /**
     * 断开连接（子类必须实现）
     * @abstract
     */
    async disconnect() {
        throw new Error(`${this.name}: disconnect() 未实现`);
    }

    /**
     * 发送消息（子类必须实现）
     * @param {OutboundMessage} message
     * @returns {Promise<boolean>} 是否发送成功
     * @abstract
     */
    async send(message) {
        throw new Error(`${this.name}: send() 未实现`);
    }

    /**
     * 设置连接状态并触发事件
     * @param {string} newState
     */
    setState(newState) {
        const oldState = this.state;
        if (oldState !== newState) {
            this.state = newState;
            if (newState === ConnectionState.CONNECTED) {
                this.connectedAt = Date.now();
                this.reconnectStrategy.reset();
            }
            this.emit('statusChange', oldState, newState);
            this.logger.info(`状态变更: ${oldState} -> ${newState}`);
        }
    }

    /**
     * 获取当前状态
     */
    getStatus() {
        return {
            name: this.name,
            state: this.state,
            connectedAt: this.connectedAt,
            uptime: this.connectedAt ? Date.now() - this.connectedAt : 0,
            reconnect: this.reconnectStrategy.getStatus(),
        };
    }

    /**
     * 是否已连接
     */
    isConnected() {
        return this.state === ConnectionState.CONNECTED;
    }

    /**
     * 验证连接（子类可覆盖以实现凭据校验/连通性测试）
     * 默认实现：仅报告当前连接状态。
     * @returns {Promise<{ok: boolean, state: string, message: string, detail?: object}>}
     */
    async verify() {
        return {
            ok: this.isConnected(),
            state: this.state,
            message: this.isConnected() ? '已连接' : `未连接 (${this.state})`,
        };
    }

    /**
     * 处理连接断开，触发自动重连
     * @param {string} reason - 断开原因
     */
    handleDisconnect(reason) {
        this.setState(ConnectionState.DISCONNECTED);
        this.emit('disconnected', reason);
        this.logger.warn(`连接断开: ${reason}`);

        if (this._shouldReconnect && this.config.enabled !== false) {
            this.setState(ConnectionState.RECONNECTING);
            this.reconnectStrategy.scheduleReconnect(() => this.connect());
        }
    }

    /**
     * 安全启动（带错误处理）
     */
    async start() {
        try {
            this._shouldReconnect = true;
            await this.connect();
        } catch (error) {
            this.logger.error(`启动失败: ${error.message}`);
            this.emit('error', error);
            this.handleDisconnect(error.message);
        }
    }

    /**
     * 安全停止
     */
    async stop() {
        this._shouldReconnect = false;
        this.reconnectStrategy.cancel();
        try {
            await this.disconnect();
        } catch (error) {
            this.logger.error(`停止时出错: ${error.message}`);
        }
        this.setState(ConnectionState.DISCONNECTED);
    }

    /**
     * 将长文本分段（各平台有字符限制）
     * @param {string} text - 原始文本
     * @param {number} maxLength - 最大长度
     * @returns {string[]} 分段后的文本数组
     */
    splitMessage(text, maxLength = 4000) {
        if (!text || text.length <= maxLength) {
            return [text];
        }

        const segments = [];
        let remaining = text;

        while (remaining.length > 0) {
            if (remaining.length <= maxLength) {
                segments.push(remaining);
                break;
            }

            // 尝试在换行处分割
            let splitIndex = remaining.lastIndexOf('\n', maxLength);
            if (splitIndex < maxLength * 0.5) {
                // 没有合适的换行，尝试空格
                splitIndex = remaining.lastIndexOf(' ', maxLength);
            }
            if (splitIndex < maxLength * 0.5) {
                // 强制截断
                splitIndex = maxLength;
            }

            segments.push(remaining.substring(0, splitIndex));
            remaining = remaining.substring(splitIndex).trimStart();
        }

        return segments;
    }
}

export default PlatformAdapter;
