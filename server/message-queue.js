import { createLogger } from './utils/logger.js';

const logger = createLogger('message-queue');

/**
 * 消息队列 - 确保消息可靠投递
 * 支持重试、优先级、超时
 */
export class MessageQueue {
    /**
     * @param {object} options
     * @param {number} options.maxRetries - 最大重试次数，默认 3
     * @param {number} options.retryDelay - 重试间隔 (ms)，默认 2000
     * @param {number} options.maxLength - 队列最大长度，默认 100
     * @param {number} options.processInterval - 处理间隔 (ms)，默认 100
     */
    constructor(options = {}) {
        this.maxRetries = options.maxRetries || 3;
        this.retryDelay = options.retryDelay || 2000;
        this.maxLength = options.maxLength || 100;
        this.processInterval = options.processInterval || 100;

        this.queue = [];
        this.processing = false;
        this.timer = null;
        this.sendHandler = null;
        this.stats = {
            total: 0,
            success: 0,
            failed: 0,
            retries: 0,
        };
    }

    /**
     * 设置发送处理函数
     * @param {Function} handler - async (message) => boolean
     */
    setSendHandler(handler) {
        this.sendHandler = handler;
    }

    /**
     * 入队消息
     * @param {object} message - 待发送的消息
     * @param {object} options - 选项
     * @param {number} options.priority - 优先级 (0=普通, 1=高)
     * @returns {boolean} 是否成功入队
     */
    enqueue(message, options = {}) {
        if (this.queue.length >= this.maxLength) {
            logger.warn(`队列已满 (${this.maxLength})，丢弃最早的消息`);
            this.queue.shift();
        }

        const item = {
            message,
            priority: options.priority || 0,
            retries: 0,
            createdAt: Date.now(),
            nextRetryAt: 0,
        };

        if (item.priority > 0) {
            // 高优先级插入队列前端
            this.queue.unshift(item);
        } else {
            this.queue.push(item);
        }

        this.stats.total++;
        logger.debug(`消息入队，当前队列长度: ${this.queue.length}`);
        return true;
    }

    /**
     * 启动队列处理
     */
    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.processQueue(), this.processInterval);
        logger.info('消息队列已启动');
    }

    /**
     * 停止队列处理
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        logger.info('消息队列已停止');
    }

    /**
     * 处理队列中的消息
     */
    async processQueue() {
        if (this.processing || this.queue.length === 0 || !this.sendHandler) {
            return;
        }

        this.processing = true;

        try {
            const now = Date.now();
            const item = this.queue.find(i => i.nextRetryAt <= now);

            if (!item) {
                return;
            }

            // 从队列中移除
            const index = this.queue.indexOf(item);
            if (index > -1) {
                this.queue.splice(index, 1);
            }

            try {
                const success = await this.sendHandler(item.message);
                if (success) {
                    this.stats.success++;
                    logger.debug(`消息发送成功`);
                } else {
                    throw new Error('发送返回 false');
                }
            } catch (error) {
                item.retries++;
                this.stats.retries++;

                if (item.retries < this.maxRetries) {
                    // 重新入队等待重试
                    item.nextRetryAt = Date.now() + this.retryDelay * item.retries;
                    this.queue.push(item);
                    logger.warn(`消息发送失败，第 ${item.retries} 次重试: ${error.message}`);
                } else {
                    this.stats.failed++;
                    logger.error(`消息发送最终失败 (已重试 ${item.retries} 次): ${error.message}`);
                }
            }
        } finally {
            this.processing = false;
        }
    }

    /**
     * 获取队列状态
     */
    getStatus() {
        return {
            length: this.queue.length,
            processing: this.processing,
            stats: { ...this.stats },
        };
    }

    /**
     * 清空队列
     */
    clear() {
        this.queue = [];
        logger.info('队列已清空');
    }
}

export default MessageQueue;
