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
            sendTimeout: configManager.get('messageQueue.sendTimeout'),
        });
        this.messageHandlers = [];        // 消息处理函数列表
        this.outboundFilters = [];        // 出站消息过滤器列表
        this.inboundFilters = [];         // 入站消息过滤器列表（在命令路由/会话历史之前应用）
        this.messageLog = [];             // 最近消息日志（仅观测用，会截断）
        this.maxLogSize = 200;
        this.running = false;
        this._commandRouter = null;       // 命令路由器引用（供命令同步使用）

        // 入站待处理队列（供 ST 前端可靠消费）。
        // 与 messageLog（观测、截断到 100 字符、只留 20 条）彻底分离：
        // 这里保存需要 ST AI 回复的完整入站消息，带唯一 ID + ack 语义，
        // 前端拉取处理后回 ack 才移除 → 不再因日志截断/滚动导致消息被截断或丢失。
        this.inboundQueue = [];
        this.maxInboundQueue = 500;       // 上限，超出丢弃最旧并告警（不静默）
        this._inboundSeq = 0;

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

            // 连接成功后延迟自动同步命令列表（避免干扰连接初始化流程）
            if (this._commandRouter) {
                setTimeout(() => {
                    const commands = this._commandRouter.getCommandsForSync();
                    adapter.syncCommands(commands).catch(err => {
                        logger.error(`[${name}] 命令同步失败: ${err.message}`);
                    });
                }, 2000);
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

        // 并行启动所有已启用的适配器（避免单个适配器超时阻塞整个网关）
        const adapterConfigs = configManager.get('adapters') || {};
        const startPromises = [];
        for (const [name, adapter] of this.adapters) {
            const config = adapterConfigs[name];
            if (config && config.enabled) {
                logger.info(`启动适配器: ${name}`);
                // 并行启动，单个失败不影响其他适配器和 HTTP 服务
                startPromises.push(
                    adapter.start().catch(error => {
                        logger.error(`适配器 ${name} 启动失败: ${error.message}`);
                    })
                );
            } else {
                logger.info(`适配器 ${name} 未启用，跳过`);
            }
        }

        // 不等待所有适配器连接完成，HTTP 服务立即可用
        // 适配器连接结果通过事件异步通知
        if (startPromises.length > 0) {
            Promise.allSettled(startPromises).then(results => {
                const connected = results.filter(r => r.status === 'fulfilled').length;
                logger.info(`适配器启动完成: ${connected}/${results.length} 成功`);
            });
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

        // 入站过滤器链：在记录日志/emit/分发到命令路由与会话历史**之前**应用。
        // 插件可在此改写消息（脱敏、翻译、规范化）或返回 null 拦截（黑名单、限流）。
        // 与出站过滤链对称。返回 null 表示消息被拦截：不记录、不 emit、不分发。
        const filtered = this.applyInboundFilters(message);
        if (!filtered) {
            logger.debug(`[${platform}] 入站消息被过滤器拦截，已丢弃`);
            return;
        }
        message = filtered;

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
     *   @param {boolean} options.bypassFilters - R1: 绕过出站过滤器链（用于补发衍生消息）
     *   @param {boolean} options.skipDedup - R2: 跳过 15 秒去重检查（用于有意重复的消息）
     */
    sendMessage(message, options = {}) {
        this.addMessageLog('outbound', message);
        // R1/R2: 将发送选项标记到消息 metadata 上，使其能穿越队列到达 dispatchOutbound
        if (options.bypassFilters || options.skipDedup) {
            message.metadata = message.metadata || {};
            if (options.bypassFilters) message.metadata._bypassFilters = true;
            if (options.skipDedup) message.metadata.skipDedup = true;
        }
        this.messageQueue.enqueue(message, options);
    }

    /**
     * 直接发送消息（不经过队列）
     * @param {OutboundMessage} message
     * @param {object} options - 发送选项
     *   @param {boolean} options.bypassFilters - R1: 绕过出站过滤器链
     *   @param {boolean} options.skipDedup - R2: 跳过去重检查
     * @returns {Promise<boolean>}
     */
    async sendDirect(message, options = {}) {
        this.addMessageLog('outbound', message);
        // R1/R2: 将发送选项标记到消息 metadata 上
        if (options.bypassFilters || options.skipDedup) {
            message.metadata = message.metadata || {};
            if (options.bypassFilters) message.metadata._bypassFilters = true;
            if (options.skipDedup) message.metadata.skipDedup = true;
        }
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
            pluginName: options.pluginName || null, // 归属插件（供禁用/卸载时框架强制回收）
        };
        this.outboundFilters.push(entry);
        this.outboundFilters.sort((a, b) => a.priority - b.priority);
        logger.info(`出站过滤器已注册: ${entry.name} (priority: ${entry.priority}${entry.pluginName ? `, plugin: ${entry.pluginName}` : ''})`);
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
     * 移除某插件注册的所有出站过滤器（框架代管回收的安全网）
     * @param {string} pluginName
     * @returns {number} 移除数量
     */
    removeOutboundFiltersByPlugin(pluginName) {
        if (!pluginName) return 0;
        const before = this.outboundFilters.length;
        this.outboundFilters = this.outboundFilters.filter(f => f.pluginName !== pluginName);
        const removed = before - this.outboundFilters.length;
        if (removed > 0) logger.info(`已回收插件 ${pluginName} 的 ${removed} 个出站过滤器`);
        return removed;
    }

    // ==================== 入站过滤器（与出站对称） ====================

    /**
     * 注册入站消息过滤器。
     * 在消息被记录/emit/分发到命令路由与会话历史**之前**依次应用。
     * @param {Function} filter - (message: InboundMessage) => InboundMessage|null
     *   返回修改后的消息（可改写内容/字段），返回 null 表示拦截该消息（后续处理全部跳过）
     * @param {object} options - { name?: string, priority?: number, pluginName?: string }
     * @returns {Function} 取消注册的函数
     */
    addInboundFilter(filter, options = {}) {
        const entry = {
            filter,
            name: options.name || 'anonymous',
            priority: options.priority ?? 100,
            pluginName: options.pluginName || null, // 归属插件（供禁用/卸载时框架强制回收）
        };
        this.inboundFilters.push(entry);
        this.inboundFilters.sort((a, b) => a.priority - b.priority);
        logger.info(`入站过滤器已注册: ${entry.name} (priority: ${entry.priority}${entry.pluginName ? `, plugin: ${entry.pluginName}` : ''})`);
        return () => {
            const idx = this.inboundFilters.indexOf(entry);
            if (idx > -1) this.inboundFilters.splice(idx, 1);
        };
    }

    /**
     * 移除指定名称的入站过滤器
     * @param {string} name
     */
    removeInboundFilter(name) {
        this.inboundFilters = this.inboundFilters.filter(f => f.name !== name);
    }

    /**
     * 移除某插件注册的所有入站过滤器（框架代管回收的安全网）
     * @param {string} pluginName
     * @returns {number} 移除数量
     */
    removeInboundFiltersByPlugin(pluginName) {
        if (!pluginName) return 0;
        const before = this.inboundFilters.length;
        this.inboundFilters = this.inboundFilters.filter(f => f.pluginName !== pluginName);
        const removed = before - this.inboundFilters.length;
        if (removed > 0) logger.info(`已回收插件 ${pluginName} 的 ${removed} 个入站过滤器`);
        return removed;
    }

    /**
     * 应用入站过滤器链
     * @param {InboundMessage} message
     * @returns {InboundMessage|null} 过滤后的消息，或 null（被拦截）
     */
    applyInboundFilters(message) {
        let msg = message;
        for (const entry of this.inboundFilters) {
            try {
                msg = entry.filter(msg);
                if (msg === null) {
                    logger.debug(`入站消息被过滤器 ${entry.name} 拦截`);
                    return null;
                }
            } catch (error) {
                // 单个过滤器出错不打断链，也不吞掉消息（fail-open：坏插件不该让网关聋掉）
                logger.error(`入站过滤器 ${entry.name} 执行失败: ${error.message}`);
            }
        }
        return msg;
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
        // R1: 检查是否绕过过滤器链（补发衍生消息时使用）
        const bypassFilters = message.metadata?._bypassFilters === true;

        // 应用出站过滤器（除非标记了 bypassFilters）
        const filtered = bypassFilters ? message : this.applyOutboundFilters(message);
        if (!filtered) return false;
        if (filtered !== message && filtered.content !== message.content) {
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

        // R2: 检查是否跳过去重检查（有意重复的消息）
        const skipDedup = message.metadata?.skipDedup === true;

        try {
            // 长文本分段发送
            const segments = adapter.splitMessage(message.content, this.getMaxLength(message.platform));

            for (let i = 0; i < segments.length; i++) {
                const segment = segments[i];
                const isLast = i === segments.length - 1;
                // 出站去重: 防止消息队列重试时重复发送相同内容到同一目标
                // R2: skipDedup 标记的消息跳过此检查
                let dedupKey = null;
                if (!skipDedup) {
                    dedupKey = `${message.platform}|${message.chatId}|${this._hashContent(segment)}`;
                    const lastSent = this._recentOutbound.get(dedupKey);
                    if (lastSent && (Date.now() - lastSent) < this._outboundDedupWindow) {
                        logger.warn(`[${message.platform}] 跳过重复发送 (${Date.now() - lastSent}ms 内已发送过相同内容)`);
                        continue;
                    }
                }

                const segMsg = new OutboundMessage({
                    ...message,
                    content: segment,
                    // 媒体只随最后一段发送，避免长文本分段时媒体被重复发送
                    media: isLast ? (message.media || message.mediaUrls) : [],
                });
                await adapter.send(segMsg);

                // 记录已发送（用于去重）
                if (dedupKey) {
                    this._recentOutbound.set(dedupKey, Date.now());
                }

                // 分段间添加小延迟避免频率限制
                if (segments.length > 1) {
                    await this.delay(500);
                }
            }

            // 定期清理过期的去重条目
            this._cleanDedupCache();

            logger.info(`[${message.platform}] 消息已发送到 ${message.chatId}${bypassFilters ? ' (绕过过滤器)' : ''}${skipDedup ? ' (跳过去重)' : ''}`);
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
     * 将一条入站消息放入待处理队列（需要 ST AI 回复的消息）。
     * @param {InboundMessage} message
     * @returns {string} 分配的队列条目 ID
     */
    enqueueInbound(message) {
        // 上限保护：超出时丢弃最旧并告警（绝不静默）
        if (this.inboundQueue.length >= this.maxInboundQueue) {
            const dropped = this.inboundQueue.shift();
            logger.warn(`入站队列已满 (${this.maxInboundQueue})，丢弃最旧消息 id=${dropped?.id}（前端消费过慢或未连接）`);
        }
        const id = `${Date.now()}-${++this._inboundSeq}`;
        this.inboundQueue.push({
            id,
            platform: message.platform,
            chatId: message.chatId,
            chatType: message.chatType || 'private',
            senderId: message.senderId || '',
            senderName: message.senderName || '',
            content: message.content || '',      // 完整内容，不截断
            mediaUrls: message.mediaUrls || [],
            mentioned: message.mentioned || false,
            timestamp: message.timestamp || Date.now(),
        });
        return id;
    }

    /**
     * 获取待处理入站消息（不移除，由前端 ack 后移除）
     * @param {number} limit - 最多返回条数，0/未传=全部
     * @returns {Array<object>}
     */
    getPendingInbound(limit = 0) {
        return limit > 0 ? this.inboundQueue.slice(0, limit) : this.inboundQueue.slice();
    }

    /**
     * 确认并移除已处理的入站消息
     * @param {string[]} ids
     * @returns {number} 实际移除条数
     */
    ackInbound(ids) {
        if (!Array.isArray(ids) || ids.length === 0) return 0;
        const set = new Set(ids);
        const before = this.inboundQueue.length;
        this.inboundQueue = this.inboundQueue.filter(item => !set.has(item.id));
        return before - this.inboundQueue.length;
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
            // 标记插件命令：以 / 开头的入站消息，前端应过滤不注入 ST
            isCommand: direction === 'inbound' && typeof message.content === 'string' && message.content.trim().startsWith('/'),
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
