/**
 * Agent 剧场事件广播器（SSE EventBroadcaster）
 *
 * 管理 SSE 客户端订阅，把 AgentRunResult / AgentEvent / token_delta 推送给
 * 所有已连接的 "Agent 剧场" 前端。比 WebSocket 简单：复用 http server 的
 * 长连接，无需协议升级，浏览器原生 EventSource 直连。
 *
 * 推送消息类型（与 PROTOTYPE.md §3.4 一致）：
 *   - agent_event:  { event: AgentEvent }                  单个事件（工具调用/状态变更/子代理…）
 *   - agent_result: { result: AgentRunResult }              一次 run 完成的完整结果
 *   - token_delta:  { delta: string, runId: string }        流式增量（预留，runner 当前不产出）
 *   - state:        { state: object }                       当前会话状态快照
 *   - heartbeat:    (无 data)                               周期心跳，防止代理超时断开
 *
 * 客户端通过 EventSource 订阅 /api/agent-theatre/stream?session=<key>，
 * 服务端按 session 维护客户端列表（同一会话可多端订阅，如面板 + 移动端）。
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('theatre-broadcaster');

/**
 * SSE 心跳间隔（毫秒）。Nginx/反代默认 60s 超时，30s 心跳足够保活。
 */
const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * 单个 SSE 客户端订阅封装。
 * 不直接持有 res，而是把写入操作收敛到 send()，便于错误时统一清理。
 */
class SseClient {
    /**
     * @param {import('http').ServerResponse} res
     * @param {string} sessionKey - 订阅的会话 key（"platform:chatId"）
     */
    constructor(res, sessionKey) {
        this.res = res;
        this.sessionKey = sessionKey;
        this.alive = true;
        this.createdAt = Date.now();
    }

    /**
     * 推送一条 SSE 事件。
     * @param {string} eventName - 事件名（agent_event / agent_result / token_delta / state / heartbeat）
     * @param {object} [data] - 数据对象（自动 JSON 序列化）
     */
    send(eventName, data) {
        if (!this.alive) return false;
        try {
            this.res.write(`event: ${eventName}\n`);
            this.res.write(`data: ${JSON.stringify(data ?? {})}\n\n`);
            return true;
        } catch (e) {
            this.alive = false;
            logger.debug(`[sse] 写入失败，标记客户端失活: ${e.message}`);
            return false;
        }
    }

    /** 关闭连接 */
    close() {
        if (!this.alive) return;
        this.alive = false;
        try { this.res.end(); } catch { /* ignore */ }
    }
}

/**
 * Agent 剧场事件广播器。
 *
 * 按 sessionKey 维护多个 SSE 客户端，agent run 完成时调用 broadcastResult
 * 把 AgentRunResult 推送给该会话的所有订阅者。
 */
export class TheatreBroadcaster {
    constructor() {
        /** @type {Map<string, Set<SseClient>>} sessionKey -> clients */
        this.sessions = new Map();
        /** 全局客户端（未指定 session，订阅所有） */
        this.globalClients = new Set();
        this._heartbeatTimer = null;
        this._startHeartbeat();
    }

    /**
     * 注册一个 SSE 客户端。
     * @param {import('http').ServerResponse} res
     * @param {string} [sessionKey] - 订阅的会话 key；未传则订阅全局
     * @returns {SseClient}
     */
    addClient(res, sessionKey) {
        // SSE 必备头：禁用缓冲、声明事件流
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            // Nginx 代理友好：显式禁用 gzip，避免压缩缓冲导致事件延迟
            'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n'); // 客户端断开后 3s 自动重连

        const client = new SseClient(res, sessionKey || '');
        if (sessionKey) {
            if (!this.sessions.has(sessionKey)) this.sessions.set(sessionKey, new Set());
            this.sessions.get(sessionKey).add(client);
        } else {
            this.globalClients.add(client);
        }

        // 客户端关闭时清理
        res.on('close', () => this.removeClient(client));
        res.on('error', () => this.removeClient(client));

        logger.info(`[sse] 新客户端订阅 session=${sessionKey || '(global)'}, 当前总数=${this.totalClients()}`);
        return client;
    }

    /**
     * 移除客户端。
     *
     * 注意：不靠 alive 标志提前 return。send() 写入失败时会把 alive 置 false，
     * broadcast 随后调 removeClient 清理——若此处提前 return，客户端会永远留在
     * sessions Map 里造成泄漏。Set.delete 本身幂等，多次调用安全。
     * @param {SseClient} client
     */
    removeClient(client) {
        client.alive = false;
        const sk = client.sessionKey;
        if (sk && this.sessions.has(sk)) {
            this.sessions.get(sk).delete(client);
            if (this.sessions.get(sk).size === 0) this.sessions.delete(sk);
        } else {
            this.globalClients.delete(client);
        }
    }

    /** 当前总客户端数（含全局） */
    totalClients() {
        let n = this.globalClients.size;
        for (const set of this.sessions.values()) n += set.size;
        return n;
    }

    /**
     * 向某会话的所有订阅者（含全局）推送一条事件。
     * @param {string} sessionKey
     * @param {string} eventName
     * @param {object} [data]
     */
    broadcast(sessionKey, eventName, data) {
        const targets = [];
        if (sessionKey && this.sessions.has(sessionKey)) {
            for (const c of this.sessions.get(sessionKey)) targets.push(c);
        }
        for (const c of this.globalClients) targets.push(c);

        const dead = [];
        for (const c of targets) {
            if (!c.send(eventName, data)) dead.push(c);
        }
        for (const c of dead) this.removeClient(c);
    }

    /**
     * 推送一次 run 的完整 AgentRunResult。
     * @param {string} sessionKey
     * @param {{runId:string, result:object, text?:string}} payload
     */
    broadcastResult(sessionKey, payload) {
        this.broadcast(sessionKey, 'agent_result', payload);
    }

    /**
     * 推送单个 AgentEvent（工具调用 / 状态变更 / 子代理…）。
     * @param {string} sessionKey
     * @param {object} event
     */
    broadcastEvent(sessionKey, event) {
        this.broadcast(sessionKey, 'agent_event', { event });
    }

    /**
     * 推送当前会话状态快照。
     * @param {string} sessionKey
     * @param {object} state
     */
    broadcastState(sessionKey, state) {
        this.broadcast(sessionKey, 'state', { state });
    }

    /**
     * 推送流式 token 增量（预留）。
     * @param {string} sessionKey
     * @param {string} delta
     * @param {string} runId
     */
    broadcastTokenDelta(sessionKey, delta, runId) {
        this.broadcast(sessionKey, 'token_delta', { delta, runId });
    }

    /**
     * 推送 run 生命周期状态（P2）：running / aborting / aborted / completed / error。
     * @param {string} sessionKey
     * @param {string|null} runId - run 尚未生成时传 null（如 running 事件）
     * @param {string} state
     */
    broadcastRunState(sessionKey, runId, state) {
        this.broadcast(sessionKey, 'run_state', { runId: runId || null, state });
    }

    /**
     * 推送最近一次注入的完整提示词（P2，前端提示词查看器实时刷新）。
     * data = { prompt: { messages, builtAt, runId } }，messages 为 [{role, content}] 数组。
     * @param {string} sessionKey
     * @param {{messages:Array, builtAt:number, runId:string}} prompt
     */
    broadcastPromptBuilt(sessionKey, prompt) {
        this.broadcast(sessionKey, 'prompt_built', { prompt });
    }

    /**
     * 推送聊天存档自动保存状态（聊天记录持久化）。
     * data = { state: 'saved' | 'save_failed', savedAt, error? }
     * @param {string} sessionKey
     * @param {{state:string, savedAt:number|null, error?:string}} payload
     */
    broadcastSaveState(sessionKey, payload) {
        this.broadcast(sessionKey, 'save_state', payload);
    }

    /** 启动周期心跳 */
    _startHeartbeat() {
        if (this._heartbeatTimer) return;
        this._heartbeatTimer = setInterval(() => {
            // 给所有客户端发心跳，顺便清理失活连接
            const allClients = [...this.globalClients];
            for (const set of this.sessions.values()) allClients.push(...set);
            const dead = [];
            for (const c of allClients) {
                if (!c.send('heartbeat', { ts: Date.now() })) dead.push(c);
            }
            for (const c of dead) this.removeClient(c);
        }, HEARTBEAT_INTERVAL_MS);
        // 心跳计时器不阻止进程退出
        if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
    }

    /** 关闭所有连接、停止心跳（进程退出时调用） */
    shutdown() {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
        for (const c of this.globalClients) c.close();
        this.globalClients.clear();
        for (const set of this.sessions.values()) {
            for (const c of set) c.close();
        }
        this.sessions.clear();
    }
}

export default TheatreBroadcaster;
