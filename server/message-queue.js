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
        this.maxRetries = options.maxRetries ?? 3;
        this.retryDelay = options.retryDelay ?? 2000;
        this.maxLength = options.maxLength ?? 100;
        this.processInterval = options.processInterval ?? 100;
        // 单条消息发送超时：避免某次 send 永久挂起锁死整个队列
        this.sendTimeout = options.sendTimeout ?? 30000;
        // 死信队列容量（发送最终失败的消息，供审计/人工补发）
        this.maxDeadLetter = options.maxDeadLetter ?? 50;

        this.queue = [];
        this.processing = false;
        this.timer = null;
        this.sendHandler = null;
        this.deadLetter = [];
        this.onDeadLetter = null; // 可选回调: (item, error) => void
        this.stats = {
            total: 0,
            success: 0,
            failed: 0,
            retries: 0,
            dropped: 0,
        };
    }

    /** 取消息的会话键，用于 per-chat 顺序保证 */
    _chatKeyOf(message) {
        return `${message?.platform || '?'}|${message?.chatId || '?'}`;
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
        // 背压：队满时拒绝新消息并返回 false（不再静默丢队头破坏顺序/丢高优先级）。
        // 调用方可据此感知拥塞。
        if (this.queue.length >= this.maxLength) {
            this.stats.dropped++;
            logger.warn(`队列已满 (${this.maxLength})，拒绝新消息（背压）`);
            return false;
        }

        const item = {
            message,
            priority: options.priority || 0,
            retries: 0,
            createdAt: Date.now(),
            nextRetryAt: 0,
            seq: this._seq = (this._seq || 0) + 1, // 稳定序号，保证同优先级 FIFO
        };

        // 高优先级插到队首之后仍保持同优先级 FIFO；普通消息追加队尾。
        // 注意：per-chat 顺序在选取阶段（_selectNext）保证，这里只做粗排。
        if (item.priority > 0) {
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
        // 复位处理锁，避免"处理中途 stop → 重启后永不处理"
        this.processing = false;
        logger.info('消息队列已停止');
    }

    /**
     * 选取下一条可发送的消息，保证 per-chat FIFO：
     * 同一会话的后续消息必须等它前面的消息发送完成；不同会话互不阻塞。
     * @param {number} now
     * @returns {object|null}
     */
    _selectNext(now) {
        const blockedChats = new Set();
        for (const item of this.queue) {
            const chat = this._chatKeyOf(item.message);
            if (blockedChats.has(chat)) continue; // 该会话已有更早的消息未发出，后续必须等待
            if (item.nextRetryAt <= now) {
                return item;
            }
            // 该会话队首消息尚在退避中 → 阻塞它之后的同会话消息
            blockedChats.add(chat);
        }
        return null;
    }

    /** 带超时地调用发送处理器，避免单条挂起锁死整个队列 */
    async _sendWithTimeout(message) {
        if (!this.sendTimeout || this.sendTimeout <= 0) {
            return await this.sendHandler(message);
        }
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`发送超时 (${this.sendTimeout}ms)`)), this.sendTimeout);
        });
        try {
            return await Promise.race([this.sendHandler(message), timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 处理队列中的消息
     */
    async processQueue() {
        if (this.processing || this.queue.length === 0 || !this.sendHandler) {
            return;
        }

        const now = Date.now();
        const item = this._selectNext(now);
        if (!item) return;

        this.processing = true;
        try {
            let success = false;
            try {
                success = await this._sendWithTimeout(item.message);
                if (!success) throw new Error('发送返回 false');
                // 成功：从队列移除
                this._remove(item);
                this.stats.success++;
                logger.debug('消息发送成功');
            } catch (error) {
                item.retries++;
                this.stats.retries++;
                if (item.retries < this.maxRetries) {
                    // 关键：失败的消息保留在原位置（不推队尾），仅推迟其可发送时间，
                    // 从而保证同会话消息不会因重试而乱序。
                    item.nextRetryAt = Date.now() + this.retryDelay * item.retries;
                    logger.warn(`[${this._chatKeyOf(item.message)}] 发送失败，第 ${item.retries} 次重试: ${error.message}`);
                } else {
                    // 最终失败：移入死信队列，保留内容供审计/补发，并触发回调
                    this._remove(item);
                    this.stats.failed++;
                    this._pushDeadLetter(item, error);
                    logger.error(`[${this._chatKeyOf(item.message)}] 消息最终失败 (重试 ${item.retries} 次): ${error.message}`);
                }
            }
        } finally {
            this.processing = false;
        }
    }

    /** 从队列移除指定 item */
    _remove(item) {
        const idx = this.queue.indexOf(item);
        if (idx > -1) this.queue.splice(idx, 1);
    }

    /** 记录死信 */
    _pushDeadLetter(item, error) {
        const entry = {
            message: item.message,
            retries: item.retries,
            error: error?.message || String(error),
            failedAt: Date.now(),
        };
        this.deadLetter.push(entry);
        while (this.deadLetter.length > this.maxDeadLetter) this.deadLetter.shift();
        if (typeof this.onDeadLetter === 'function') {
            try { this.onDeadLetter(entry); } catch (_) { /* ignore */ }
        }
    }

    /**
     * 获取队列状态
     */
    getStatus() {
        return {
            length: this.queue.length,
            processing: this.processing,
            deadLetter: this.deadLetter.length,
            stats: { ...this.stats },
        };
    }

    /** 取出并清空死信队列（供补发/审计） */
    drainDeadLetter() {
        const items = this.deadLetter;
        this.deadLetter = [];
        return items;
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
