import { createLogger } from './logger.js';

const logger = createLogger('reconnect');

/**
 * 指数退避重连策略
 * 支持抖动(jitter)避免惊群效应
 */
export class ReconnectStrategy {
    /**
     * @param {object} options
     * @param {number} options.initialDelay - 初始重连延迟 (ms)，默认 1000
     * @param {number} options.maxDelay - 最大重连延迟 (ms)，默认 60000
     * @param {number} options.multiplier - 退避倍数，默认 2
     * @param {number} options.maxRetries - 最大重试次数，0=无限，默认 0
     * @param {boolean} options.jitter - 是否添加随机抖动，默认 true
     */
    constructor(options = {}) {
        this.initialDelay = options.initialDelay || 1000;
        this.maxDelay = options.maxDelay || 60000;
        this.multiplier = options.multiplier || 2;
        this.maxRetries = options.maxRetries || 0;
        this.jitter = options.jitter !== undefined ? options.jitter : true;

        this.currentDelay = this.initialDelay;
        this.retryCount = 0;
        this.timer = null;
        this.active = false;
    }

    /**
     * 计算下一次重连延迟
     * @returns {number} 延迟毫秒数
     */
    getNextDelay() {
        let delay = this.currentDelay;

        if (this.jitter) {
            // 添加 ±25% 的随机抖动
            const jitterRange = delay * 0.25;
            delay += (Math.random() * 2 - 1) * jitterRange;
        }

        return Math.min(Math.max(Math.round(delay), 100), this.maxDelay);
    }

    /**
     * 调度一次重连
     * @param {Function} callback - 重连回调函数
     * @returns {Promise<boolean>} 是否成功调度（false表示超过最大重试次数）
     */
    scheduleReconnect(callback) {
        if (this.maxRetries > 0 && this.retryCount >= this.maxRetries) {
            logger.warn(`已达到最大重试次数 (${this.maxRetries})，停止重连`);
            this.active = false;
            return false;
        }

        const delay = this.getNextDelay();
        this.retryCount++;
        this.active = true;

        logger.info(`第 ${this.retryCount} 次重连，等待 ${delay}ms...`);

        this.timer = setTimeout(async () => {
            try {
                await callback();
            } catch (error) {
                logger.error(`重连回调执行失败: ${error.message}`);
            }
        }, delay);

        // 指数增长当前延迟
        this.currentDelay = Math.min(this.currentDelay * this.multiplier, this.maxDelay);
        return true;
    }

    /**
     * 重置重连状态（连接成功后调用）
     */
    reset() {
        this.currentDelay = this.initialDelay;
        this.retryCount = 0;
        this.active = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /**
     * 取消待执行的重连
     */
    cancel() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.active = false;
    }

    /**
     * 获取当前状态
     */
    getStatus() {
        return {
            active: this.active,
            retryCount: this.retryCount,
            currentDelay: this.currentDelay,
            maxRetries: this.maxRetries,
        };
    }
}

export default ReconnectStrategy;
