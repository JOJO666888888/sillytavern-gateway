/**
 * 协作总线（Phase 3 多 Agent 协作基础框架）
 *
 * 进程内事件总线，用于同一次 Agent run 内多个 Agent 之间的通信：
 * - publish(msg)：按 topic 分发消息，并写入该 runId 的邮箱（mailbox）供 Agent 用 collab.recv 拉取
 * - subscribe(topic, handler) / unsubscribe(topic, handler)：进程内订阅（供插件代码使用）
 * - request(topic, payload, { timeoutMs, runId })：请求-应答，超时 resolve { error: 'timeout' }
 * - close(runId)：run 结束清理该 runId 的邮箱与挂起请求
 *
 * 消息结构：{ from, to?, type, topic, payload, runId, seq, ts }
 *   type 枚举：'request' | 'response' | 'broadcast' | 'state_sync'
 * 校验规则：from / type / topic 必填，type 在枚举内；to 可选（缺省即广播）。
 */
const MSG_TYPES = ['request', 'response', 'broadcast', 'state_sync'];

export class CollabBus {
    constructor() {
        this._subscribers = new Map();  // topic -> Set<handler>
        this._mailbox = new Map();      // runId -> Map<topic, msg[]>
        this._pending = new Map();      // seq -> { resolve, timer, runId }
        this._seq = 0;
    }

    _validate(msg) {
        if (!msg || typeof msg !== 'object') return '消息必须是对象';
        if (!msg.from || typeof msg.from !== 'string') return 'from（发送方名称）必填';
        if (!msg.topic || typeof msg.topic !== 'string') return 'topic（消息主题）必填';
        if (!MSG_TYPES.includes(msg.type)) return `type 必须在 ${MSG_TYPES.join(' / ')} 中`;
        return null;
    }

    _nextSeq() {
        return ++this._seq;
    }

    /**
     * 发布消息：同步分发到订阅者，并写入 runId 邮箱（供 collab.recv 拉取）。
     * @param {object} msg - { from, to?, type, topic, payload, runId? }
     * @returns {object} 完整消息（含 seq/ts）；校验失败返回 { error }
     */
    publish(msg) {
        const err = this._validate(msg);
        if (err) return { error: `消息校验失败：${err}` };
        const full = { seq: this._nextSeq(), ts: Date.now(), to: msg.to || '', ...msg };

        // 1. 同步分发到订阅者
        const handlers = this._subscribers.get(full.topic);
        if (handlers) {
            for (const h of Array.from(handlers)) {
                try { h(full); } catch (_) { /* 单个订阅者异常不影响总线 */ }
            }
        }

        // 2. 写入邮箱（带 runId 的消息才保留，供 Agent 工具拉取）
        if (full.runId) {
            if (!this._mailbox.has(full.runId)) this._mailbox.set(full.runId, new Map());
            const box = this._mailbox.get(full.runId);
            if (!box.has(full.topic)) box.set(full.topic, []);
            box.get(full.topic).push(full);
        }
        return full;
    }

    /**
     * 订阅主题。返回退订函数。
     * @param {string} topic
     * @param {Function} handler
     * @returns {Function} unsubscribe
     */
    subscribe(topic, handler) {
        if (!this._subscribers.has(topic)) this._subscribers.set(topic, new Set());
        this._subscribers.get(topic).add(handler);
        return () => this.unsubscribe(topic, handler);
    }

    unsubscribe(topic, handler) {
        this._subscribers.get(topic)?.delete(handler);
    }

    /**
     * 拉取该 runId 指定 topic 的待处理消息（消费后从邮箱移除）。
     * @param {string} runId
     * @param {string} topic
     * @returns {Array} 消息数组
     */
    recv(runId, topic) {
        if (!runId) return [];
        const box = this._mailbox.get(runId);
        if (!box) return [];
        const msgs = box.get(topic) || [];
        box.delete(topic);
        if (box.size === 0) this._mailbox.delete(runId);
        return msgs;
    }

    /**
     * 请求-应答：等待该 topic 上任意 type='response' 的消息。
     * @param {string} topic
     * @param {object} [payload]
     * @param {object} [options] - { timeoutMs?, runId? }
     * @returns {Promise<object>} 应答消息；超时返回 { error: 'timeout', topic }
     */
    request(topic, payload, options = {}) {
        const { timeoutMs = 30000, runId = '' } = options;
        return new Promise((resolve) => {
            const seq = this._nextSeq();
            const handler = (msg) => {
                if (msg.type !== 'response') return;
                if (runId && msg.runId && msg.runId !== runId) return;
                this._settle(seq);
                resolve(msg);
            };
            this.subscribe(topic, handler);
            const timer = setTimeout(() => {
                this.unsubscribe(topic, handler);
                this._settle(seq);
                resolve({ error: 'timeout', topic, timeoutMs });
            }, timeoutMs);
            this._pending.set(seq, { resolve, timer, runId });
        });
    }

    _settle(seq) {
        const p = this._pending.get(seq);
        if (p) {
            clearTimeout(p.timer);
            this._pending.delete(seq);
        }
    }

    /**
     * run 结束清理：该 runId 的邮箱 + 挂起的请求（resolve { error: 'run_closed' }）。
     * @param {string} runId
     */
    close(runId) {
        if (!runId) return;
        this._mailbox.delete(runId);
        for (const [seq, p] of Array.from(this._pending.entries())) {
            if (p.runId === runId) {
                clearTimeout(p.timer);
                this._pending.delete(seq);
                p.resolve({ error: 'run_closed', topic: '' });
            }
        }
    }
}
