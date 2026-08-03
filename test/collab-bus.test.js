/**
 * Phase 3 多 Agent 协作测试（任务 4）
 *
 * 覆盖：
 *   - CollabBus：消息校验、订阅分发、request-应答、超时、recv 邮箱、close 清理
 *   - collab 工具：collab.send / collab.request / collab.state_sync / collab.recv
 *   - AgentRunner 任务分配：_splitBySections 切块、_runSubAgentSpec split_by_section 调度
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { silentLogger } from './helpers.js';
import { CollabBus } from '../plugins/agent-framework/engine/collab-bus.js';
import { createCollabTools } from '../plugins/agent-framework/tools/collab-tools.js';
import { AgentRunner } from '../plugins/agent-framework/engine/agent-runner.js';

describe('CollabBus 协作总线', () => {
    test('publish 返回带 seq/ts 的完整消息', () => {
        const bus = new CollabBus();
        const msg = bus.publish({ from: 'a', type: 'broadcast', topic: 't1', payload: { x: 1 }, runId: 'r1' });
        assert.strictEqual(msg.from, 'a');
        assert.strictEqual(msg.topic, 't1');
        assert.ok(msg.seq > 0, '应生成递增 seq');
        assert.ok(msg.ts > 0, '应带时间戳');
        assert.strictEqual(msg.to, '', 'to 缺省为空（广播）');
    });

    test('消息校验：缺 from/topic 或 type 非法被拒绝', () => {
        const bus = new CollabBus();
        assert.ok(bus.publish({ type: 'broadcast', topic: 't' }).error, '缺 from 应拒绝');
        assert.ok(bus.publish({ from: 'a', type: 'broadcast' }).error, '缺 topic 应拒绝');
        assert.ok(bus.publish({ from: 'a', topic: 't' }).error, '缺 type 应拒绝');
        assert.ok(bus.publish({ from: 'a', type: 'pigeon', topic: 't' }).error, 'type 非枚举应拒绝');
        assert.ok(!bus.publish({ from: 'a', type: 'response', topic: 't' }).error, '合法消息应通过');
    });

    test('subscribe 订阅者可收到广播', () => {
        const bus = new CollabBus();
        const received = [];
        bus.subscribe('draft_review', (msg) => received.push(msg));
        bus.publish({ from: 'a', type: 'broadcast', topic: 'draft_review', payload: { draft: 'hello' } });
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].payload.draft, 'hello');
    });

    test('unsubscribe 后不再收到消息', () => {
        const bus = new CollabBus();
        let count = 0;
        const off = bus.subscribe('t', () => count++);
        bus.publish({ from: 'a', type: 'broadcast', topic: 't' });
        off();
        bus.publish({ from: 'a', type: 'broadcast', topic: 't' });
        assert.strictEqual(count, 1);
    });

    test('request-应答：同 topic 的 response 到达后 resolve', async () => {
        const bus = new CollabBus();
        const p = bus.request('q1', { q: 1 }, { timeoutMs: 500 });
        bus.publish({ from: 'b', type: 'response', topic: 'q1', payload: { answer: 42 }, runId: 'r1' });
        const reply = await p;
        assert.strictEqual(reply.payload.answer, 42);
        assert.strictEqual(reply.from, 'b');
    });

    test('request 超时返回 { error: "timeout" }', async () => {
        const bus = new CollabBus();
        const reply = await bus.request('q-timeout', {}, { timeoutMs: 30 });
        assert.strictEqual(reply.error, 'timeout');
        assert.strictEqual(reply.topic, 'q-timeout');
    });

    test('recv 拉取 runId 邮箱并消费（不串扰其他 runId）', () => {
        const bus = new CollabBus();
        bus.publish({ from: 'a', type: 'broadcast', topic: 't1', payload: { n: 1 }, runId: 'r1' });
        bus.publish({ from: 'a', type: 'state_sync', topic: 't2', payload: { n: 2 }, runId: 'r1' });
        bus.publish({ from: 'c', type: 'broadcast', topic: 't1', payload: { n: 3 }, runId: 'r2' });

        const msgs = bus.recv('r1', 't1');
        assert.strictEqual(msgs.length, 1);
        assert.strictEqual(msgs[0].payload.n, 1);
        // 二次拉取为空（已消费）
        assert.deepStrictEqual(bus.recv('r1', 't1'), []);
        // 其他 topic / runId 不受影响
        assert.strictEqual(bus.recv('r1', 't2').length, 1);
        assert.strictEqual(bus.recv('r2', 't1').length, 1);
        // 无 runId 的消息不进邮箱
        assert.deepStrictEqual(bus.recv('rX', 't1'), []);
    });

    test('close(runId) 清理邮箱与挂起请求', async () => {
        const bus = new CollabBus();
        bus.publish({ from: 'a', type: 'broadcast', topic: 't1', runId: 'r1' });
        const pending = bus.request('t1', {}, { timeoutMs: 5000, runId: 'r1' });
        bus.close('r1');
        assert.deepStrictEqual(bus.recv('r1', 't1'), [], 'close 后邮箱应清空');
        const reply = await pending;
        assert.strictEqual(reply.error, 'run_closed', 'close 应 resolve 挂起请求为 run_closed');
    });
});

describe('collab.* 协作工具', () => {
    test('工具声明齐全（send/request/state_sync/recv）', () => {
        const tools = createCollabTools(new CollabBus());
        const names = tools.map(t => t.name);
        assert.deepStrictEqual(names, ['collab.send', 'collab.request', 'collab.state_sync', 'collab.recv']);
        for (const t of tools) {
            assert.ok(t.parameters, `${t.name} 应带 JSON Schema 参数`);
            assert.strictEqual(typeof t.handler, 'function');
        }
    });

    test('collab.send 广播并带 from/runId 绑定', async () => {
        const bus = new CollabBus();
        const tools = createCollabTools(bus);
        const received = [];
        bus.subscribe('draft_review', (m) => received.push(m));
        const ctx = { runId: 'run-9', definition: { name: 'main-agent' } };
        const send = tools.find(t => t.name === 'collab.send');
        const ret = await send.handler({ topic: 'draft_review', payload: { draft: '正文' } }, ctx);
        assert.ok(ret.ok);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].from, 'main-agent');
        assert.strictEqual(received[0].runId, 'run-9');
        assert.strictEqual(received[0].payload.draft, '正文');
    });

    test('collab.recv 拉取本 run 的邮箱消息', async () => {
        const bus = new CollabBus();
        const tools = createCollabTools(bus);
        bus.publish({ from: 'critic', type: 'broadcast', topic: 'feedback', payload: { ok: true }, runId: 'run-1' });
        const recv = tools.find(t => t.name === 'collab.recv');
        const ret = await recv.handler({ topic: 'feedback' }, { runId: 'run-1' });
        assert.strictEqual(ret.count, 1);
        assert.strictEqual(ret.messages[0].from, 'critic');
        // 再次拉取为空
        const again = await recv.handler({ topic: 'feedback' }, { runId: 'run-1' });
        assert.strictEqual(again.count, 0);
    });

    test('collab.request 发布 request 并返回应答', async () => {
        const bus = new CollabBus();
        const tools = createCollabTools(bus);
        const req = tools.find(t => t.name === 'collab.request');
        // 模拟应答方：订阅 topic，收到 request 后回 response
        bus.subscribe('consensus', (msg) => {
            if (msg.type === 'request') {
                bus.publish({ from: 'judge', type: 'response', topic: 'consensus', payload: { decision: 'pass' }, runId: msg.runId });
            }
        });
        const ret = await req.handler({ topic: 'consensus', payload: { q: 'x' } }, { runId: 'run-2', definition: { name: 'a' } });
        assert.ok(ret.ok);
        assert.strictEqual(ret.response.decision, 'pass');
    });
});

describe('AgentRunner 任务分配（Phase 3）', () => {
    test('_splitBySections 按段落平均切块', () => {
        const runner = new AgentRunner({ logger: silentLogger });
        const chunks = runner._splitBySections('A段\n\nB段\n\nC段\n\nD段', 2);
        assert.deepStrictEqual(chunks, ['A段\n\nB段', 'C段\n\nD段']);
        // 少于 n 段时整段返回
        assert.deepStrictEqual(runner._splitBySections('仅一段', 3), ['仅一段']);
        // 空文本返回 n 个空块
        assert.deepStrictEqual(runner._splitBySections('', 2), ['', '']);
    });

    test('split_by_section：按 sections 数并行调度，传 parentResult', async () => {
        const calls = [];
        const runner = new AgentRunner({
            logger: silentLogger,
            subagentDispatcher: {
                dispatch: async (name, task, session, ctx, opts) => {
                    calls.push({ name, task, opts });
                    return { text: `评审:${name}`, agent: name };
                },
            },
        });
        const result = await runner._runSubAgentSpec(
            { name: 'critic', task: { divide: 'split_by_section', sections: ['开篇', '高潮'] } },
            '段1\n\n段2\n\n段3\n\n段4',
            {},
            {},
            'run-7',
        );
        assert.strictEqual(result.mode, 'split_by_section');
        assert.strictEqual(result.count, 2);
        assert.strictEqual(calls.length, 2, '应调度 2 次');
        assert.strictEqual(calls[0].name, 'critic');
        assert.ok(calls[0].task.includes('段1'), '第一块应含前两段');
        assert.ok(calls[1].task.includes('段3'), '第二块应含后两段');
        // parentResult 与 runId 透传
        assert.strictEqual(calls[0].opts.runId, 'run-7');
        assert.ok(calls[0].opts.parentResult.includes('段1'));
    });

    test('常规模式：单次调度 + parentResult/runId 透传', async () => {
        const calls = [];
        const runner = new AgentRunner({
            logger: silentLogger,
            subagentDispatcher: {
                dispatch: async (name, task, session, ctx, opts) => {
                    calls.push({ name, task, opts });
                    return { text: 'ok', agent: name };
                },
            },
        });
        await runner._runSubAgentSpec({ name: 'reviewer' }, '主稿内容', {}, {}, 'run-8');
        assert.strictEqual(calls.length, 1);
        assert.ok(calls[0].task.includes('主稿内容'));
        assert.strictEqual(calls[0].opts.runId, 'run-8');
        assert.ok(calls[0].opts.parentResult.includes('主稿内容'));
    });

    test('consensus 模式：按顺序反馈基础版执行并 warn', async () => {
        const warns = [];
        const runner = new AgentRunner({
            logger: { ...silentLogger, warn: (m) => warns.push(String(m)) },
            subagentDispatcher: {
                dispatch: async (name, task, session, ctx, opts) => ({ text: 'ok', agent: name }),
            },
        });
        const result = await runner._triggerSubAgents(
            { subAgents: [{ name: 'voter', trigger: 'after_draft', task: { divide: 'consensus' } }] },
            '主稿',
            {},
            {},
            'run-9',
        );
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].text, 'ok');
        assert.ok(warns.some(w => w.includes('consensus')), '应记录 consensus 排期警告');
    });
});
