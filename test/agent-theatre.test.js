/**
 * Agent 剧场 SSE 广播器测试（Task 4.4 / 4.5）
 *
 * 守护 spec.md "Scenario: Agent 剧场实时事件流" 与 PROTOTYPE.md §3.4：
 *   - TheatreBroadcaster.addClient 注册 SSE 客户端，写入正确响应头
 *   - broadcast 按 sessionKey 精准推送（会话隔离 + 全局订阅）
 *   - broadcastResult / broadcastEvent / broadcastState / broadcastTokenDelta 消息类型正确
 *   - 客户端关闭/写入失败时自动清理，totalClients 准确
 *   - shutdown 关闭所有连接并停止心跳
 *   - SSE 协议格式：event:/data: 行 + 双换行分隔
 *
 * 用 mock res（实现 writeHead/write/on/close）捕获 SSE 输出，不启动真实 HTTP。
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { TheatreBroadcaster } from '../server/agent/theatre-broadcaster.js';

// ==================== mock SSE res ====================

/**
 * 构造 mock ServerResponse，捕获 writeHead/write 输出。
 * 模拟 SSE 长连接：write 内容累积到 chunks，close/error 触发事件。
 */
function mockSseRes() {
    const listeners = {};
    const chunks = [];
    const res = {
        statusCode: 0,
        headers: {},
        chunks,
        ended: false,
        writeHead(code, headers) {
            this.statusCode = code;
            Object.assign(this.headers, headers || {});
        },
        write(data) {
            chunks.push(typeof data === 'string' ? data : data.toString());
            return true;
        },
        end() { this.ended = true; },
        on(event, handler) {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(handler);
        },
        emit(event, ...args) {
            for (const h of (listeners[event] || [])) h(...args);
        },
    };
    res._listeners = listeners;
    return res;
}

/**
 * 从累积的 SSE chunks 解析出所有事件。
 * SSE 帧以双换行分隔，每帧含 event:/data: 行。
 * @param {string[]} chunks
 * @returns {Array<{event:string, data:object}>}
 */
function parseSseEvents(chunks) {
    const raw = chunks.join('');
    const frames = raw.split('\n\n');
    const events = [];
    for (const frame of frames) {
        if (!frame.trim()) continue;
        // 跳过 retry 行（非事件帧）
        if (frame.startsWith('retry:')) continue;
        let eventName = 'message';
        let dataStr = '';
        for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
        }
        let data = {};
        if (dataStr) {
            try { data = JSON.parse(dataStr); } catch { data = { raw: dataStr }; }
        }
        events.push({ event: eventName, data });
    }
    return events;
}

// ==================== 测试 ====================

describe('TheatreBroadcaster - addClient & SSE 头', () => {
    let b;
    beforeEach(() => { b = new TheatreBroadcaster(); });
    afterEach(() => { b.shutdown(); });

    test('addClient 写入 SSE 必备响应头', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:default');
        assert.strictEqual(res.statusCode, 200);
        assert.match(res.headers['Content-Type'], /text\/event-stream/);
        assert.strictEqual(res.headers['Cache-Control'], 'no-cache, no-transform');
        assert.strictEqual(res.headers['Connection'], 'keep-alive');
        assert.strictEqual(res.headers['X-Accel-Buffering'], 'no');
    });

    test('addClient 发送 retry 初始行', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:default');
        assert.ok(res.chunks.join('').includes('retry: 3000'));
    });

    test('addClient 注册到对应 session', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:chat1');
        assert.ok(b.sessions.has('native:chat1'));
        assert.strictEqual(b.totalClients(), 1);
    });

    test('addClient 无 sessionKey 注册到全局', () => {
        const res = mockSseRes();
        b.addClient(res, '');
        assert.strictEqual(b.globalClients.size, 1);
        assert.strictEqual(b.totalClients(), 1);
    });

    test('addClient 无 sessionKey 参数也注册到全局', () => {
        const res = mockSseRes();
        b.addClient(res);
        assert.strictEqual(b.globalClients.size, 1);
    });
});

describe('TheatreBroadcaster - 会话隔离 & 广播', () => {
    let b;
    beforeEach(() => { b = new TheatreBroadcaster(); });
    afterEach(() => { b.shutdown(); });

    test('broadcast 只推送给指定 session 的客户端', () => {
        const res1 = mockSseRes();
        const res2 = mockSseRes();
        b.addClient(res1, 'native:chatA');
        b.addClient(res2, 'native:chatB');

        b.broadcast('native:chatA', 'agent_event', { event: { type: 'tool_call' } });

        const ev1 = parseSseEvents(res1.chunks);
        const ev2 = parseSseEvents(res2.chunks);
        assert.ok(ev1.some(e => e.event === 'agent_event'));
        assert.strictEqual(ev2.length, 0); // chatB 不应收到
    });

    test('broadcast 同时推送给全局客户端', () => {
        const resSession = mockSseRes();
        const resGlobal = mockSseRes();
        b.addClient(resSession, 'native:chatA');
        b.addClient(resGlobal, ''); // 全局订阅

        b.broadcast('native:chatA', 'agent_event', { event: { type: 'tool_call' } });

        const evS = parseSseEvents(resSession.chunks);
        const evG = parseSseEvents(resGlobal.chunks);
        assert.ok(evS.some(e => e.event === 'agent_event'));
        assert.ok(evG.some(e => e.event === 'agent_event'), '全局客户端应收到所有会话事件');
    });

    test('broadcast 未匹配 session 只推送给全局', () => {
        const resGlobal = mockSseRes();
        b.addClient(resGlobal, '');

        b.broadcast('native:nonexistent', 'agent_event', { event: {} });

        const ev = parseSseEvents(resGlobal.chunks);
        assert.ok(ev.some(e => e.event === 'agent_event'));
    });

    test('多客户端订阅同一 session 全部收到', () => {
        const res1 = mockSseRes();
        const res2 = mockSseRes();
        b.addClient(res1, 'native:shared');
        b.addClient(res2, 'native:shared');

        b.broadcast('native:shared', 'agent_event', { event: {} });

        const ev1 = parseSseEvents(res1.chunks);
        const ev2 = parseSseEvents(res2.chunks);
        assert.ok(ev1.some(e => e.event === 'agent_event'));
        assert.ok(ev2.some(e => e.event === 'agent_event'));
    });
});

describe('TheatreBroadcaster - 消息类型封装', () => {
    let b;
    beforeEach(() => { b = new TheatreBroadcaster(); });
    afterEach(() => { b.shutdown(); });

    test('broadcastResult 推送 agent_result 事件', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:default');
        const payload = { runId: 'r1', result: { runId: 'r1' }, text: '正文' };
        b.broadcastResult('native:default', payload);

        const events = parseSseEvents(res.chunks);
        const resultEv = events.find(e => e.event === 'agent_result');
        assert.ok(resultEv, '应推送 agent_result 事件');
        assert.strictEqual(resultEv.data.runId, 'r1');
        assert.strictEqual(resultEv.data.text, '正文');
    });

    test('broadcastEvent 推送 agent_event 事件（包装在 { event } 内）', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:default');
        const event = { type: 'tool_call', payload: { tool: 'state.set' } };
        b.broadcastEvent('native:default', event);

        const events = parseSseEvents(res.chunks);
        const ev = events.find(e => e.event === 'agent_event');
        assert.ok(ev);
        assert.strictEqual(ev.data.event.type, 'tool_call');
        assert.strictEqual(ev.data.event.payload.tool, 'state.set');
    });

    test('broadcastState 推送 state 事件', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:default');
        const state = { visible: { turn: 3 } };
        b.broadcastState('native:default', state);

        const events = parseSseEvents(res.chunks);
        const ev = events.find(e => e.event === 'state');
        assert.ok(ev);
        assert.strictEqual(ev.data.state.visible.turn, 3);
    });

    test('broadcastTokenDelta 推送 token_delta 事件', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:default');
        b.broadcastTokenDelta('native:default', '片段', 'run-1');

        const events = parseSseEvents(res.chunks);
        const ev = events.find(e => e.event === 'token_delta');
        assert.ok(ev);
        assert.strictEqual(ev.data.delta, '片段');
        assert.strictEqual(ev.data.runId, 'run-1');
    });
});

describe('TheatreBroadcaster - run_state 广播（P2 停止生成）', () => {
    let b;
    beforeEach(() => { b = new TheatreBroadcaster(); });
    afterEach(() => { b.shutdown(); });

    test('broadcastRunState 推送 run_state 事件且数据正确', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:default');
        b.broadcastRunState('native:default', 'run-1', 'running');

        const events = parseSseEvents(res.chunks);
        const ev = events.find(e => e.event === 'run_state');
        assert.ok(ev, '应推送 run_state 事件');
        assert.strictEqual(ev.data.runId, 'run-1');
        assert.strictEqual(ev.data.state, 'running');
    });

    test('broadcastRunState 未传 runId 时序列化为 null（running 早期事件）', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:default');
        b.broadcastRunState('native:default', null, 'running');

        const events = parseSseEvents(res.chunks);
        const ev = events.find(e => e.event === 'run_state');
        assert.ok(ev);
        assert.strictEqual(ev.data.runId, null);
        assert.strictEqual(ev.data.state, 'running');
    });

    test('broadcastRunState 支持 aborted / completed / error 终态', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:default');
        b.broadcastRunState('native:default', 'run-1', 'aborting');
        b.broadcastRunState('native:default', 'run-1', 'aborted');
        b.broadcastRunState('native:default', 'run-1', 'completed');
        b.broadcastRunState('native:default', null, 'error');

        const events = parseSseEvents(res.chunks).filter(e => e.event === 'run_state');
        assert.deepStrictEqual(events.map(e => e.data.state), ['aborting', 'aborted', 'completed', 'error']);
        assert.strictEqual(events[1].data.runId, 'run-1');
        assert.strictEqual(events[3].data.runId, null);
    });

    test('直接 broadcast run_state 事件同样可被解析（SSE 通用性）', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:default');
        b.broadcast('native:default', 'run_state', { runId: 'r1', state: 'aborted' });

        const events = parseSseEvents(res.chunks);
        const ev = events.find(e => e.event === 'run_state');
        assert.ok(ev);
        assert.strictEqual(ev.data.runId, 'r1');
        assert.strictEqual(ev.data.state, 'aborted');
    });

    test('run_state 事件按 session 隔离推送', () => {
        const resA = mockSseRes();
        const resB = mockSseRes();
        b.addClient(resA, 'native:chatA');
        b.addClient(resB, 'native:chatB');

        b.broadcastRunState('native:chatA', 'run-1', 'running');

        const evA = parseSseEvents(resA.chunks).find(e => e.event === 'run_state');
        const evB = parseSseEvents(resB.chunks).find(e => e.event === 'run_state');
        assert.ok(evA, '会话 A 应收到 run_state');
        assert.ok(!evB, '会话 B 不应收到 run_state');
    });
});

describe('TheatreBroadcaster - SSE 协议格式', () => {
    let b;
    beforeEach(() => { b = new TheatreBroadcaster(); });
    afterEach(() => { b.shutdown(); });

    test('SSE 帧以 event:/data:/双换行格式输出', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:default');
        b.broadcast('native:default', 'agent_event', { x: 1 });

        const raw = res.chunks.join('');
        // 应包含 event: 行
        assert.ok(raw.includes('event: agent_event\n'));
        // 应包含 data: 行（JSON）
        assert.ok(raw.includes('data: {"x":1}\n'));
        // 帧以双换行结尾
        assert.ok(raw.includes('\n\n'));
    });

    test('data 为 undefined 时输出空对象', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:default');
        b.broadcast('native:default', 'ping');

        const events = parseSseEvents(res.chunks);
        const ev = events.find(e => e.event === 'ping');
        assert.ok(ev);
        assert.deepStrictEqual(ev.data, {});
    });
});

describe('TheatreBroadcaster - 客户端清理', () => {
    let b;
    beforeEach(() => { b = new TheatreBroadcaster(); });
    afterEach(() => { b.shutdown(); });

    test('res close 事件触发客户端移除', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:default');
        assert.strictEqual(b.totalClients(), 1);

        // 模拟客户端断开
        res.emit('close');
        assert.strictEqual(b.totalClients(), 0);
        assert.ok(!b.sessions.has('native:default'));
    });

    test('res error 事件触发客户端移除', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:default');
        assert.strictEqual(b.totalClients(), 1);

        res.emit('error', new Error('connection reset'));
        assert.strictEqual(b.totalClients(), 0);
    });

    test('写入失败时自动清理失活客户端', () => {
        const res = mockSseRes();
        // 让 write 仅在首次（addClient 的 retry 初始行）成功，后续写入抛错模拟连接已断
        let callCount = 0;
        res.write = () => {
            callCount++;
            if (callCount > 1) throw new Error('write EPIPE');
            return true;
        };
        b.addClient(res, 'native:default');
        assert.strictEqual(b.totalClients(), 1);

        b.broadcast('native:default', 'agent_event', { event: {} });
        // 写入失败后客户端应被清理
        assert.strictEqual(b.totalClients(), 0);
    });

    test('removeClient 幂等（多次调用不报错）', () => {
        const res = mockSseRes();
        const client = b.addClient(res, 'native:default');
        b.removeClient(client);
        b.removeClient(client); // 再次移除不应抛错
        assert.strictEqual(b.totalClients(), 0);
    });

    test('session 客户端全移除后 session key 自动删除', () => {
        const res1 = mockSseRes();
        const res2 = mockSseRes();
        const c1 = b.addClient(res1, 'native:chat');
        const c2 = b.addClient(res2, 'native:chat');
        assert.ok(b.sessions.has('native:chat'));

        b.removeClient(c1);
        b.removeClient(c2);
        assert.ok(!b.sessions.has('native:chat'), '所有客户端移除后 session key 应被删除');
    });
});

describe('TheatreBroadcaster - totalClients', () => {
    let b;
    beforeEach(() => { b = new TheatreBroadcaster(); });
    afterEach(() => { b.shutdown(); });

    test('totalClients 统计 session + 全局客户端', () => {
        b.addClient(mockSseRes(), 's1');
        b.addClient(mockSseRes(), 's2');
        b.addClient(mockSseRes(), '');
        assert.strictEqual(b.totalClients(), 3);
    });

    test('totalClients 空时为 0', () => {
        assert.strictEqual(b.totalClients(), 0);
    });
});

describe('TheatreBroadcaster - shutdown', () => {
    test('shutdown 关闭所有连接并清空集合', () => {
        const b = new TheatreBroadcaster();
        const res1 = mockSseRes();
        const res2 = mockSseRes();
        const resGlobal = mockSseRes();
        b.addClient(res1, 's1');
        b.addClient(res2, 's2');
        b.addClient(resGlobal, '');

        b.shutdown();
        assert.strictEqual(b.totalClients(), 0);
        assert.strictEqual(b.sessions.size, 0);
        assert.strictEqual(b.globalClients.size, 0);
        // 所有 res 应被 end
        assert.ok(res1.ended);
        assert.ok(res2.ended);
        assert.ok(resGlobal.ended);
    });

    test('shutdown 幂等（多次调用不报错）', () => {
        const b = new TheatreBroadcaster();
        b.shutdown();
        b.shutdown(); // 不应抛错
        assert.strictEqual(b.totalClients(), 0);
    });

    test('shutdown 后心跳计时器已清除', () => {
        const b = new TheatreBroadcaster();
        assert.ok(b._heartbeatTimer, '构造后应有心跳计时器');
        b.shutdown();
        assert.strictEqual(b._heartbeatTimer, null);
    });
});

describe('TheatreBroadcaster - 集成场景', () => {
    let b;
    beforeEach(() => { b = new TheatreBroadcaster(); });
    afterEach(() => { b.shutdown(); });

    test('一次 Agent run：先 event 后 result，客户端按序收到', () => {
        const res = mockSseRes();
        b.addClient(res, 'native:story');

        // 模拟 run 过程：先推工具调用事件，再推完整结果
        b.broadcastEvent('native:story', { type: 'tool_call', payload: { tool: 'state.set' } });
        b.broadcastEvent('native:story', { type: 'state_change', payload: { label: '时间推进' } });
        b.broadcastResult('native:story', {
            runId: 'run-42',
            result: { runId: 'run-42', artifacts: [{ type: 'main', text: '故事正文' }] },
            text: '故事正文',
        });

        const events = parseSseEvents(res.chunks);
        // 应有 2 个 agent_event + 1 个 agent_result，按推送顺序
        const eventSeq = events.filter(e => e.event === 'agent_event');
        const resultSeq = events.filter(e => e.event === 'agent_result');
        assert.strictEqual(eventSeq.length, 2);
        assert.strictEqual(resultSeq.length, 1);
        assert.strictEqual(eventSeq[0].data.event.payload.tool, 'state.set');
        assert.strictEqual(resultSeq[0].data.runId, 'run-42');
        assert.strictEqual(resultSeq[0].data.text, '故事正文');
    });

    test('多端订阅同一会话：面板 + 移动端都收到结果', () => {
        const panelRes = mockSseRes();
        const mobileRes = mockSseRes();
        b.addClient(panelRes, 'native:game');
        b.addClient(mobileRes, 'native:game');

        b.broadcastResult('native:game', { runId: 'r1', text: '同步内容' });

        const panelEv = parseSseEvents(panelRes.chunks).find(e => e.event === 'agent_result');
        const mobileEv = parseSseEvents(mobileRes.chunks).find(e => e.event === 'agent_result');
        assert.ok(panelEv);
        assert.ok(mobileEv);
        assert.strictEqual(panelEv.data.text, '同步内容');
        assert.strictEqual(mobileEv.data.text, '同步内容');
    });
});

// ==================== rerun 输入推导逻辑测试 ====================

/**
 * 复刻 server/index.js 中 /api/agent-theatre/input 路由的 actualInput 推导逻辑。
 * 该逻辑深度耦合在 Express 路由内（依赖 theatreSessions、agentService 等模块级变量），
 * 无法直接单元测试路由本身，这里提取核心推导逻辑做守护测试。
 *
 * 规则：
 *   - 非 rerun：actualInput = input || (callbackId ? `[选项回调] ${callbackId}` : '')
 *   - rerun：从 sess.lastInput 推导，若以 'select:' 开头视为 callbackId
 *
 * @param {object} args - { input, callbackId, rerun, sess }
 * @returns {{ actualInput: string, shouldUpdateLastInput: boolean, hasLastInput: boolean }}
 */
function deriveActualInput({ input, callbackId, rerun, sess }) {
    const hasLastInput = !!(sess && sess.lastInput);
    let actualInput = '';

    if (rerun) {
        const lastInput = sess.lastInput;
        if (typeof lastInput === 'string' && lastInput.startsWith('select:')) {
            actualInput = `[选项回调] ${lastInput}`;
        } else {
            actualInput = lastInput || '';
        }
    } else {
        actualInput = input || '';
        if (!actualInput && callbackId) {
            actualInput = `[选项回调] ${callbackId}`;
        }
    }

    const shouldUpdateLastInput = !rerun;
    return { actualInput, shouldUpdateLastInput, hasLastInput };
}

describe('rerun 输入推导逻辑', () => {
    test('普通文本输入：lastInput 存文本，rerun 时原样返回', () => {
        const sess = { lastInput: '向森林深处走去', turn: 2 };
        const r = deriveActualInput({ rerun: true, sess });
        assert.strictEqual(r.actualInput, '向森林深处走去');
        assert.strictEqual(r.shouldUpdateLastInput, false);
        assert.strictEqual(r.hasLastInput, true);
    });

    test('callbackId 输入：lastInput 存 select: 前缀，rerun 时还原为 [选项回调] 格式', () => {
        const sess = { lastInput: 'select:option:1', turn: 1 };
        const r = deriveActualInput({ rerun: true, sess });
        assert.strictEqual(r.actualInput, '[选项回调] select:option:1');
        assert.strictEqual(r.shouldUpdateLastInput, false);
    });

    test('rerun 时 lastInput 为空应被拦截（hasLastInput=false）', () => {
        const sess = { lastInput: null, turn: 0 };
        const r = deriveActualInput({ rerun: true, sess });
        assert.strictEqual(r.hasLastInput, false);
        assert.strictEqual(r.actualInput, '');
    });

    test('rerun 时 lastInput 为 undefined（首次会话）应被拦截', () => {
        const sess = {};
        const r = deriveActualInput({ rerun: true, sess });
        assert.strictEqual(r.hasLastInput, false);
    });

    test('非 rerun 普通输入：actualInput 用 input，shouldUpdateLastInput=true', () => {
        const r = deriveActualInput({ input: '你好世界', callbackId: null, rerun: false, sess: {} });
        assert.strictEqual(r.actualInput, '你好世界');
        assert.strictEqual(r.shouldUpdateLastInput, true);
    });

    test('非 rerun callbackId 输入：actualInput 用 [选项回调] 格式', () => {
        const r = deriveActualInput({ input: null, callbackId: 'select:option:2', rerun: false, sess: {} });
        assert.strictEqual(r.actualInput, '[选项回调] select:option:2');
        assert.strictEqual(r.shouldUpdateLastInput, true);
    });

    test('非 rerun input+callbackId 同时存在：input 优先', () => {
        const r = deriveActualInput({ input: '自由文本', callbackId: 'select:option:1', rerun: false, sess: {} });
        assert.strictEqual(r.actualInput, '自由文本');
    });

    test('rerun 与非 rerun 对同一 lastInput 推导结果一致（callbackId 场景）', () => {
        const callbackId = 'select:option:3';
        // 非 rerun 首次
        const first = deriveActualInput({ input: null, callbackId, rerun: false, sess: {} });
        // rerun 复用
        const sess = { lastInput: callbackId };
        const rerun = deriveActualInput({ rerun: true, sess });
        assert.strictEqual(first.actualInput, rerun.actualInput);
    });

    test('rerun 与非 rerun 对同一 lastInput 推导结果一致（普通文本场景）', () => {
        const text = '探索废弃的城堡';
        const first = deriveActualInput({ input: text, callbackId: null, rerun: false, sess: {} });
        const sess = { lastInput: text };
        const rerun = deriveActualInput({ rerun: true, sess });
        assert.strictEqual(first.actualInput, rerun.actualInput);
    });
});

// ==================== validate-run 参数校验逻辑测试 ====================

/**
 * 复刻 server/index.js 中 /api/agent-theatre/validate-run 的参数校验逻辑。
 *
 * @param {object} body - { name, yaml }
 * @returns {{ valid: boolean, error?: string }}
 */
function validateRunParams(body) {
    const { name, yaml } = body || {};
    if (!name || !yaml) {
        return { valid: false, error: '需要 name 和 yaml' };
    }
    return { valid: true };
}

describe('validate-run 参数校验', () => {
    test('缺少 name 时返回无效', () => {
        const r = validateRunParams({ yaml: 'name: test' });
        assert.strictEqual(r.valid, false);
        assert.strictEqual(r.error, '需要 name 和 yaml');
    });

    test('缺少 yaml 时返回无效', () => {
        const r = validateRunParams({ name: 'default-rp' });
        assert.strictEqual(r.valid, false);
        assert.strictEqual(r.error, '需要 name 和 yaml');
    });

    test('name 和 yaml 都为空时返回无效', () => {
        const r = validateRunParams({});
        assert.strictEqual(r.valid, false);
    });

    test('body 为 null/undefined 时返回无效', () => {
        const r = validateRunParams(null);
        assert.strictEqual(r.valid, false);
    });

    test('name 和 yaml 都存在时返回有效', () => {
        const r = validateRunParams({ name: 'default-rp', yaml: 'name: default-rp\nmodel:\n  temperature: 0.8' });
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.error, undefined);
    });

    test('name 为空字符串时返回无效', () => {
        const r = validateRunParams({ name: '', yaml: 'name: test' });
        assert.strictEqual(r.valid, false);
    });

    test('yaml 为空字符串时返回无效', () => {
        const r = validateRunParams({ name: 'default-rp', yaml: '' });
        assert.strictEqual(r.valid, false);
    });
});
