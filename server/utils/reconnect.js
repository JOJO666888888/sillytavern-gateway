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
    /**
     * @param {object} options
     * @param {import('winston').Logger} [options.logger] - 注入 logger，使重连日志归属到具体平台
     */
    constructor(options = {}) {
        // 使用 ?? 而非 ||，允许显式配置 0（如 initialDelay:0 / maxRetries:0 无限重试语义）
        this.initialDelay = options.initialDelay ?? 1000;
        this.maxDelay = options.maxDelay ?? 60000;
        this.multiplier = options.multiplier ?? 2;
        this.maxRetries = options.maxRetries ?? 0;
        this.jitter = options.jitter !== undefined ? options.jitter : true;
        this.logger = options.logger || logger;

        this.currentDelay = this.initialDelay;
        this.retryCount = 0;
        this.timer = null;
        this.active = false;
        this._callback = null;
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
        // 记住回调，供失败后自动续接下一次重连使用
        if (callback) this._callback = callback;
        const cb = this._callback;
        if (!cb) {
            this.logger.error('scheduleReconnect 无可用回调');
            return false;
        }

        // 关键：调度前取消可能存在的旧定时器，避免 ws error+close 双事件、
        // start() catch 与适配器内部事件重复调度导致的“并发重连/重复连接”。
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (this.maxRetries > 0 && this.retryCount >= this.maxRetries) {
            this.logger.warn(`已达到最大重试次数 (${this.maxRetries})，停止重连`);
            this.active = false;
            return false;
        }

        const delay = this.getNextDelay();
        this.retryCount++;
        this.active = true;

        this.logger.info(`第 ${this.retryCount} 次重连，等待 ${delay}ms...`);

        this.timer = setTimeout(async () => {
            this.timer = null;
            try {
                await cb();
                // 成功与否由 cb 内部通过 setState(CONNECTED)->reset() 决定；
                // 若 cb 正常返回但连接并未真正建立，稳定判定/后续 disconnect 会再次触发调度。
            } catch (error) {
                // 关键：回调失败时自动续接下一次重连，不再依赖调用方在 connect() 内
                // 手动再调 handleDisconnect（Telegram/Discord 此前不遵守该隐式契约，
                // 导致首次重连失败后“静默死亡”）。
                this.logger.warn(`重连尝试失败: ${error.message}，将继续重试`);
                if (this.active) {
                    this.scheduleReconnect();
                }
            }
        }, delay);
        if (typeof this.timer?.unref === 'function') this.timer.unref();

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
