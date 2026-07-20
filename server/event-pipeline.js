/**
 * Event Pipeline - 事件管线
 * 消息到达后按优先级依次调用已注册的 listener
 * 支持 stopPropagation() 中断管线
 */

import { createLogger } from './utils/logger.js';
import { PluginContext } from './plugin-context.js';

const logger = createLogger('event-pipeline');

/**
 * 事件管线
 */
export class EventPipeline {
    constructor() {
        // 监听器列表（按 priority 排序）
        this.listeners = [];
        this._sorted = true;
    }

    /**
     * 注册事件监听器
     * @param {object} listener
     * @param {string} listener.event - 事件类型（'message', 'notice', 'request' 等）
     * @param {object} listener.filter - 过滤条件 { platform?, chatType?, chatId?, senderId? }
     * @param {string} listener.pluginName - 所属插件名
     * @param {number} listener.priority - 优先级（数字越小越先执行，默认 100）
     * @param {Function} listener.handler - 处理函数 (ctx) => void
     */
    register(listener) {
        this.listeners.push({
            event: listener.event || 'message',
            filter: listener.filter || {},
            pluginName: listener.pluginName || 'unknown',
            priority: listener.priority ?? 100,
            handler: listener.handler,
        });
        this._sorted = false;
        logger.debug(`监听器已注册: ${listener.pluginName} -> ${listener.event} (priority: ${listener.priority ?? 100})`);
    }

    /**
     * 注销指定插件的所有监听器
     * @param {string} pluginName
     */
    unregisterByPlugin(pluginName) {
        const before = this.listeners.length;
        this.listeners = this.listeners.filter(l => l.pluginName !== pluginName);
        const removed = before - this.listeners.length;
        if (removed > 0) {
            logger.debug(`已注销插件 ${pluginName} 的 ${removed} 个监听器`);
        }
    }

    /**
     * 分发消息到管线
     * @param {import('./adapters/base-adapter.js').InboundMessage} message
     * @param {object} services - 服务引用
     * @returns {Promise<boolean>} 是否被某个插件处理
     */
    async dispatch(message, services = {}) {
        // 确保按优先级排序
        if (!this._sorted) {
            this.listeners.sort((a, b) => a.priority - b.priority);
            this._sorted = true;
        }

        const eventType = message.type || 'message';
        let handled = false;

        for (const listener of this.listeners) {
            // 事件类型匹配
            if (listener.event !== eventType && listener.event !== '*') {
                continue;
            }

            // 过滤条件匹配
            if (!this.matchFilter(listener.filter, message)) {
                continue;
            }

            // 构建上下文
            const ctx = new PluginContext({
                message,
                gateway: services.gateway,
                sessionManager: services.sessionManager,
                configManager: services.configManager,
                pluginName: listener.pluginName,
            });

            try {
                await listener.handler(ctx);

                if (ctx.handled) {
                    handled = true;
                }

                // 检查是否阻止传播
                if (ctx.propagationStopped) {
                    logger.debug(`消息传播被插件 ${listener.pluginName} 阻止`);
                    break;
                }
            } catch (error) {
                // 单个插件错误不影响管线
                logger.error(`插件 ${listener.pluginName} 监听器执行失败: ${error.message}`);
            }
        }

        return handled;
    }

    /**
     * 匹配过滤条件
     * @param {object} filter - 过滤条件
     * @param {object} message - 消息对象
     * @returns {boolean}
     */
    matchFilter(filter, message) {
        if (!filter || Object.keys(filter).length === 0) {
            return true; // 无过滤条件 = 匹配所有
        }

        for (const [key, value] of Object.entries(filter)) {
            if (value === undefined || value === null || value === '*') {
                continue;
            }

            // 支持数组（匹配其中之一）
            if (Array.isArray(value)) {
                if (!value.includes(message[key])) {
                    return false;
                }
            } else if (message[key] !== value) {
                return false;
            }
        }

        return true;
    }

    /**
     * 获取所有已注册监听器
     */
    listListeners() {
        return this.listeners.map(l => ({
            event: l.event,
            filter: l.filter,
            plugin: l.pluginName,
            priority: l.priority,
        }));
    }
}

export default EventPipeline;
