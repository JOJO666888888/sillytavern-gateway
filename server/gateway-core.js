import EventEmitter from 'eventemitter3';
import { createLogger } from './utils/logger.js';
import { MessageQueue } from './message-queue.js';
import { InboundMessage, OutboundMessage, ConnectionState } from './adapters/base-adapter.js';
import configManager from './utils/config.js';

const logger = createLogger('gateway-core');

/**
 * 网关核心 - 消息总线 + 路由引擎
 * 负责管理所有平台适配器、消息路由、会话管理
 */
export class GatewayCore extends EventEmitter {
    constructor() {
        super();
        this.adapters = new Map();        // name -> PlatformAdapter
        this.messageQueue = new MessageQueue({
            maxRetries: configManager.get('messageQueue.maxRetries'),
            retryDelay: configManager.get('messageQueue.retryDelay'),
            maxLength: configManager.get('messageQueue.maxLength'),
        });
        this.messageHandlers = [];        // 消息处理函数列表
        this.outboundFilters = [];        // 出站消息过滤器列表
        this.messageLog = [];             // 最近消息日志
        this.maxLogSize = 200;
        this.running = false;
        this._commandRouter = null;       // 命令路由器引用（供命令同步使用）

        // 出站去重缓存: 防止消息队列重试时重复发送相同内容
        // key: "platform|chatId|contentHash", value: timestamp
        this._recentOutbound = new Map();
        this._outboundDedupWindow = 15000; // 15秒内相同内容同目标视为重复

        // 设置消息队列的发送处理器
        this.messageQueue.setSendHandler(async (msg) => {
            return await this.dispatchOutbound(msg);
        });
    }

    /**
     * 注册平台适配器
     * @param {string} name - 平台名称
     * @param {PlatformAdapter} adapter - 适配器实例
     */
    registerAdapter(name, adapter) {
        if (this.adapters.has(name)) {
            logger.warn(`适配器 ${name} 已存在，将被替换`);
            this.unregisterAdapter(name);
        }

        this.adapters.set(name, adapter);

        // 绑定适配器事件
        adapter.on('message', (msg) => this.handleInbound(name, msg));
        adapter.on('connected', () => {
            logger.info(`[${name}] 已连接`);
            this.emit('adapterConnected', name);

            // 连接成功后自动同步命令列表
            if (this._commandRouter) {
                const commands = this._commandRouter.getCommandsForSync();
                adapter.syncCommands(commands).catch(err => {
                    logger.error(`[${name}] 命令同步失败: ${err.message}`);
                });
            }
        });
        adapter.on('disconnected', (reason) => {
            logger.warn(`[${name}] 已断开: ${reason}`);
            this.emit('adapterDisconnected', name, reason);
        });
        adapter.on('error', (error) => {
            logger.error(`[${name}] 错误: ${error.message}`);
            this.emit('adapterError', name, error);
        });
        adapter.on('statusChange', (oldState, newState) => {
            this.emit('adapterStatusChange', name, oldState, newState);
        });

        logger.info(`适配器已注册: ${name}`);
    }

    /**
     * 注销平台适配器
     * @param {string} name
     */
    unregisterAdapter(name) {
        const adapter = this.adapters.get(name);
        if (adapter) {
            adapter.removeAllListeners();
            adapter.stop();
            this.adapters.delete(name);
            logger.info(`适配器已注销: ${name}`);
        }
    }

    /**
     * 启动网关（启动所有已启用的适配器）
     */
    async start() {
        if (this.running) {
            logger.warn('网关已在运行中');
            return;
        }

        this.running = true;
        this.messageQueue.start();
        logger.info('网关核心已启动');

        // 启动所有已启用的适配器
        const adapterConfigs = configManager.get('adapters') || {};
        for (const [name, adapter] of this.adapters) {
            const config = adapterConfigs[name];
            if (config && config.enabled) {
                logger.info(`启动适配器: ${name}`);
                await adapter.start();
            } else {
                logger.info(`适配器 ${name} 未启用，跳过`);
            }
        }

        this.emit('started');
    }

    /**
     * 停止网关
     */
    async stop() {
        if (!this.running) return;

        this.running = false;
        this.messageQueue.stop();

        for (const [name, adapter] of this.adapters) {
            logger.info(`停止适配器: ${name}`);
            await adapter.stop();
        }

        logger.info('网关核心已停止');
        this.emit('stopped');
    }

    /**
     * 处理入站消息
     * @param {string} platform - 来源平台
     * @param {InboundMessage} message - 入站消息
     */
    handleInbound(platform, message) {
        message.platform = platform;

        // 记录消息日志
        this.addMessageLog('inbound', message);

        logger.info(`[${platform}] 收到消息: ${message.senderName}: ${message.content.substring(0, 50)}...`);

        // 触发消息事件
        this.emit('message', message);

        // 调用所有消息处理器
        for (const handler of this.messageHandlers) {
            try {
                handler(message);
            } catch (error) {
                logger.error(`消息处理器执行失败: ${error.message}`);
            }
        }
    }

    /**
     * 发送消息到指定平台（通过队列）
     * @param {OutboundMessage} message
     * @param {object} options - 队列选项
     */
    sendMessage(message, options = {}) {
        this.addMessageLog('outbound', message);
        this.messageQueue.enqueue(message, options);
    }

    /**
     * 直接发送消息（不经过队列）
     * @param {OutboundMessage} message
     * @returns {Promise<boolean>}
     */
    async sendDirect(message) {
        this.addMessageLog('outbound', message);
        return await this.dispatchOutbound(message);
    }

    /**
     * 注册出站消息过滤器
     * @param {Function} filter - (message: OutboundMessage) => OutboundMessage|null
     *   返回修改后的消息，返回 null 表示丢弃该消息
     * @param {object} options - { name?: string, priority?: number }
     * @returns {Function} 取消注册的函数
     */
    addOutboundFilter(filter, options = {}) {
        const entry = {
            filter,
            name: options.name || 'anonymous',
            priority: options.priority ?? 100,
        };
        this.outboundFilters.push(entry);
        this.outboundFilters.sort((a, b) => a.priority - b.priority);
        logger.info(`出站过滤器已注册: ${entry.name} (priority: ${entry.priority})`);
        return () => {
            const idx = this.outboundFilters.indexOf(entry);
            if (idx > -1) this.outboundFilters.splice(idx, 1);
        };
    }

    /**
     * 移除指定名称的出站过滤器
     * @param {string} name
     */
    removeOutboundFilter(name) {
        this.outboundFilters = this.outboundFilters.filter(f => f.name !== name);
    }

    /**
     * 应用出站过滤器链
     * @param {OutboundMessage} message
     * @returns {OutboundMessage|null}
     */
    applyOutboundFilters(message) {
        let msg = message;
        for (const entry of this.outboundFilters) {
            try {
                msg = entry.filter(msg);
                if (msg === null) {
                    logger.debug(`消息被过滤器 ${entry.name} 丢弃`);
                    return null;
                }
            } catch (error) {
                logger.error(`出站过滤器 ${entry.name} 执行失败: ${error.message}`);
            }
        }
        return msg;
    }

    /**
     * 分发出站消息到对应适配器
     * @param {OutboundMessage} message
     * @returns {Promise<boolean>}
     */
    async dispatchOutbound(message) {
        // 应用出站过滤器
        const filtered = this.applyOutboundFilters(message);
        if (!filtered) return false;
        if (filtered.content !== message.content) {
            message = filtered;
        }

        const adapter = this.adapters.get(message.platform);
        if (!adapter) {
            const err = new Error(`未找到平台适配器: ${message.platform}`);
            logger.error(err.message);
            throw err;
        }

        if (!adapter.isConnected()) {
            const err = new Error(`[${message.platform}] 适配器未连接 (${adapter.state})，无法发送`);
            logger.warn(err.message);
            throw err;
        }

        try {
            // 长文本分段发送
            const segments = adapter.splitMessage(message.content, this.getMaxLength(message.platform));

            for (const segment of segments) {
                // 出站去重: 防止消息队列重试时重复发送相同内容到同一目标
                const dedupKey = `${message.platform}|${message.chatId}|${this._hashContent(segment)}`;
                const lastSent = this._recentOutbound.get(dedupKey);
                if (lastSent && (Date.now() - lastSent) < this._outboundDedupWindow) {
                    logger.warn(`[${message.platform}] 跳过重复发送 (${Date.now() - lastSent}ms 内已发送过相同内容)`);
                    continue;
                }

                const segMsg = new OutboundMessage({
                    ...message,
                    content: segment,
                });
                await adapter.send(segMsg);

                // 记录已发送（用于去重）
                this._recentOutbound.set(dedupKey, Date.now());

                // 分段间添加小延迟避免频率限制
                if (segments.length > 1) {
                    await this.delay(500);
                }
            }

            // 定期清理过期的去重条目
            this._cleanDedupCache();

            logger.info(`[${message.platform}] 消息已发送到 ${message.chatId}`);
            return true;
        } catch (error) {
            logger.error(`[${message.platform}] 发送失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 广播消息到所有已连接平台
     * @param {string} content - 消息内容
     * @param {object} options - 选项
     */
    broadcast(content, options = {}) {
        for (const [name, adapter] of this.adapters) {
            if (adapter.isConnected()) {
                // 广播需要指定目标，这里只是示例
                logger.info(`广播到 ${name}: ${content.substring(0, 30)}...`);
            }
        }
    }

    /**
     * 注册消息处理器
     * @param {Function} handler - (InboundMessage) => void
     * @returns {Function} 取消注册的函数
     */
    onMessage(handler) {
        this.messageHandlers.push(handler);
        return () => {
            const index = this.messageHandlers.indexOf(handler);
            if (index > -1) {
                this.messageHandlers.splice(index, 1);
            }
        };
    }

    /**
     * 获取所有适配器状态
     */
    getStatus() {
        const status = {};
        for (const [name, adapter] of this.adapters) {
            status[name] = adapter.getStatus();
        }
        return {
            running: this.running,
            adapters: status,
            queue: this.messageQueue.getStatus(),
            recentMessages: this.messageLog.slice(-20),
        };
    }

    /**
     * 获取指定适配器
     * @param {string} name
     */
    getAdapter(name) {
        return this.adapters.get(name);
    }

    /**
     * 注入命令路由器引用（供命令同步使用）
     * @param {import('./command-router.js').CommandRouter} router
     */
    setCommandRouter(router) {
        this._commandRouter = router;
    }

    /**
     * 同步命令列表到所有已连接平台
     * @param {Array<{name: string, description: string}>} commands - 命令列表
     */
    async syncAllCommands(commands) {
        for (const [name, adapter] of this.adapters) {
            if (adapter.isConnected()) {
                try {
                    await adapter.syncCommands(commands);
                } catch (error) {
                    logger.error(`同步命令到 ${name} 失败: ${error.message}`);
                }
            }
        }
    }

    /**
     * 获取平台消息最大长度
     */
    getMaxLength(platform) {
        const limits = {
            qq: 4500,
            telegram: 4096,
            discord: 2000,
        };
        return limits[platform] || 4000;
    }

    /**
     * 添加消息日志
     */
    addMessageLog(direction, message) {
        this.messageLog.push({
            direction,
            platform: message.platform,
            chatId: message.chatId,
            chatType: message.chatType || 'private',
            senderName: message.senderName || '',
            content: message.content?.substring(0, 100),
            timestamp: Date.now(),
        });

        if (this.messageLog.length > this.maxLogSize) {
            this.messageLog.shift();
        }
    }

    /**
     * 延迟工具函数
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 对消息内容做简单哈希（用于去重键）
     * @param {string} content
     * @returns {string} 8位十六进制哈希
     */
    _hashContent(content) {
        let hash = 5381;
        for (let i = 0; i < content.length; i++) {
            hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    /**
     * 清理过期的去重缓存条目（超过去重窗口2倍的条目）
     */
    _cleanDedupCache() {
        const cutoff = Date.now() - this._outboundDedupWindow * 2;
        for (const [key, ts] of this._recentOutbound) {
            if (ts < cutoff) this._recentOutbound.delete(key);
        }
    }
}

// 单例导出
export const gatewayCore = new GatewayCore();
export default gatewayCore;
