/**
 * 三界面端到端联调测试（Task 7.1）
 *
 * 守护 spec.md "Scenario: 同一引擎驱动多界面"：
 *   - 同一会话 Agent run 完成后，AgentRunResult 同时分发给 IM / ST / Native 三个适配器
 *   - 主适配器（primary）必调；旁路适配器（bypass）按 surfaceType 逐个调用
 *   - 任一适配器异常不影响其他适配器渲染（容错）
 *
 * 实现策略：
 *   - mock 一个 AgentRunner 产出 AgentRunResult（不依赖真实 LLM）
 *   - 注册 3 个测试适配器（im-test / st-test / native-test）到 SurfaceManager
 *   - 调 dispatch 验证 3 个适配器都收到 result
 *   - 验证主适配器 + 旁路适配器调用次数与接收到的内容
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

import { SurfaceManager } from '../server/agent/surface-manager.js';
import { AgentRunResult, AgentEventType } from '../server/agent/run-result.js';
import { silentLogger } from './helpers.js';

// ==================== mock AgentRunner ====================

/**
 * 构造一个 mock AgentRunner.run()，固定返回结构化 AgentRunResult。
 * 不依赖真实 LLM / 工具循环；模拟"一次 run 完成"产出的多面结果。
 *
 * @returns {{ run: Function, lastResult: AgentRunResult }}
 */
function mockAgentRunner() {
    const result = new AgentRunResult({
        runId: 'run-multi-1',
        meta: { viewMode: 'actor', style: 'default', turn: 3 },
    });
    result.addArtifact({ type: 'main', text: '正文段落 A。\n\n正文段落 B。' });
    result.addOption({ label: '1', text: '攻击' });
    result.addOption({ label: '2', text: '防御' });
    result.updateState({
        time: '傍晚',
        location: '寒月宫',
        characters: [{ name: '师尊', status: '慵懒', mood: '愉悦' }],
    });
    result.addEvent(AgentEventType.TOOL_CALL, { tool: 'state.write', args: { key: 'time' } });
    result.addEvent(AgentEventType.SUBAGENT, { agent: 'critic-style', ok: true });
    result.addEvent(AgentEventType.COMMIT, { promoted: ['output/draft.md'] });

    return {
        run: async () => ({
            runId: result.runId,
            result,
            text: result.getMainText(),
            steps: 2,
            subAgentResults: [{ agent: 'critic-style', ok: true }],
            promoted: ['output/draft.md'],
        }),
        lastResult: result,
    };
}

/**
 * 工厂：构造一个测试适配器（render 调用计数 + 收到的 result 列表）。
 *
 * @param {string} name
 * @param {string} surfaceType
 * @param {object} [opts] - { fail?: boolean }
 */
function makeTestAdapter(name, surfaceType, opts = {}) {
    const calls = [];
    const adapter = {
        name,
        surfaceType,
        async render(agentRunResult, ctx) {
            calls.push({ result: agentRunResult, ctx });
            if (opts.fail) {
                throw new Error(`${name} 渲染故意失败`);
            }
            return { ok: true, name, artifacts: agentRunResult.artifacts.length };
        },
    };
    adapter._calls = calls;
    return adapter;
}

// ==================== 测试 ====================

describe('SubTask 7.1: 三界面端到端联调', () => {
    let manager;
    let imAdapter, stAdapter, nativeAdapter;
    let runner;
    let ctx;

    beforeEach(() => {
        manager = new SurfaceManager({ logger: silentLogger });
        imAdapter = makeTestAdapter('im-test', 'im');
        stAdapter = makeTestAdapter('st-test', 'st');
        nativeAdapter = makeTestAdapter('native-test', 'native');
        runner = mockAgentRunner();
        ctx = { platform: 'qq', chatId: 'chat-1' };
    });

    test('三个适配器都注册后，getAdapters 返回全部', () => {
        manager.register(imAdapter);
        manager.register(stAdapter);
        manager.register(nativeAdapter);
        const list = manager.getAdapters();
        assert.strictEqual(list.length, 3);
        const names = list.map(a => a.name).sort();
        assert.deepStrictEqual(names, ['im-test', 'native-test', 'st-test']);
    });

    test('同一 AgentRunResult 同时分发给 IM / ST / Native 三个适配器', async () => {
        manager.register(imAdapter);
        manager.register(stAdapter);
        manager.register(nativeAdapter);

        const { result } = await runner.run();

        // 主适配器 IM；旁路 ST + Native
        const dispatchResults = await manager.dispatch(result, ctx, {
            primarySurfaceType: 'im',
            bypassSurfaceTypes: ['st', 'native'],
        });

        // 三个适配器都收到
        assert.strictEqual(imAdapter._calls.length, 1, 'IM 主适配器应被调用 1 次');
        assert.strictEqual(stAdapter._calls.length, 1, 'ST 旁路适配器应被调用 1 次');
        assert.strictEqual(nativeAdapter._calls.length, 1, 'Native 旁路适配器应被调用 1 次');

        // dispatch 返回 3 条记录
        assert.strictEqual(dispatchResults.length, 3);
        const kinds = dispatchResults.map(r => r.kind).sort();
        assert.deepStrictEqual(kinds, ['bypass', 'bypass', 'primary']);

        // 主适配器是 im（按 primarySurfaceType 解析）
        const primary = dispatchResults.find(r => r.kind === 'primary');
        assert.strictEqual(primary.adapter, 'im-test');
    });

    test('三个适配器收到的 result 是同一个对象（引用相等，无复制损失）', async () => {
        manager.register(imAdapter);
        manager.register(stAdapter);
        manager.register(nativeAdapter);

        const { result } = await runner.run();
        await manager.dispatch(result, ctx, {
            primarySurfaceType: 'im',
            bypassSurfaceTypes: ['st', 'native'],
        });

        assert.strictEqual(imAdapter._calls[0].result, result);
        assert.strictEqual(stAdapter._calls[0].result, result);
        assert.strictEqual(nativeAdapter._calls[0].result, result);
    });

    test('三个适配器都能读到完整 AgentRunResult 五要素', async () => {
        manager.register(imAdapter);
        manager.register(stAdapter);
        manager.register(nativeAdapter);

        const { result } = await runner.run();
        await manager.dispatch(result, ctx, {
            primarySurfaceType: 'im',
            bypassSurfaceTypes: ['st', 'native'],
        });

        for (const adapter of [imAdapter, stAdapter, nativeAdapter]) {
            const r = adapter._calls[0].result;
            assert.strictEqual(r.runId, 'run-multi-1');
            assert.strictEqual(r.artifacts.length, 1);
            assert.strictEqual(r.artifacts[0].type, 'main');
            assert.strictEqual(r.options.length, 2);
            assert.strictEqual(r.state.visible.location, '寒月宫');
            assert.ok(r.events.length >= 3, `${adapter.name} 应看到完整事件流`);
            assert.strictEqual(r.meta.viewMode, 'actor');
            assert.strictEqual(r.meta.turn, 3);
        }
    });

    test('主适配器失败不影响旁路适配器执行（容错）', async () => {
        // 主适配器故意抛错
        const failingIm = makeTestAdapter('im-fail', 'im', { fail: true });
        manager.register(failingIm);
        manager.register(stAdapter);
        manager.register(nativeAdapter);

        const { result } = await runner.run();
        const dispatchResults = await manager.dispatch(result, ctx, {
            primarySurfaceType: 'im',
            bypassSurfaceTypes: ['st', 'native'],
        });

        // 主适配器失败记录 error，但旁路继续执行
        const primary = dispatchResults.find(r => r.kind === 'primary');
        assert.ok(primary.error, '主适配器失败应记录 error');
        assert.match(primary.error, /渲染故意失败/);

        // 旁路都成功
        assert.strictEqual(stAdapter._calls.length, 1);
        assert.strictEqual(nativeAdapter._calls.length, 1);
        const bypassOk = dispatchResults
            .filter(r => r.kind === 'bypass')
            .every(r => r.result?.ok === true);
        assert.ok(bypassOk, '旁路适配器应全部成功');
    });

    test('旁路适配器失败不影响主适配器和其他旁路（容错）', async () => {
        const failingSt = makeTestAdapter('st-fail', 'st', { fail: true });
        manager.register(imAdapter);
        manager.register(failingSt);
        manager.register(nativeAdapter);

        const { result } = await runner.run();
        const dispatchResults = await manager.dispatch(result, ctx, {
            primarySurfaceType: 'im',
            bypassSurfaceTypes: ['st', 'native'],
        });

        // 主成功
        assert.strictEqual(imAdapter._calls.length, 1);
        const primary = dispatchResults.find(r => r.kind === 'primary');
        assert.strictEqual(primary.result.ok, true);

        // ST 失败但 Native 成功
        const stRecord = dispatchResults.find(r => r.adapter === 'st-fail');
        assert.ok(stRecord.error);
        assert.strictEqual(nativeAdapter._calls.length, 1);
    });

    test('主适配器为 Native（面板剧场）时，IM/ST 作为旁路也能消费', async () => {
        // 反过来：Agent 剧场面板是主，IM/ST 旁路同步消费
        manager.register(imAdapter);
        manager.register(stAdapter);
        manager.register(nativeAdapter);

        const { result } = await runner.run();
        await manager.dispatch(result, ctx, {
            primarySurfaceType: 'native',
            bypassSurfaceTypes: ['im', 'st'],
        });

        assert.strictEqual(nativeAdapter._calls.length, 1);
        assert.strictEqual(imAdapter._calls.length, 1);
        assert.strictEqual(stAdapter._calls.length, 1);
    });

    test('主适配器缺失时跳过主渲染但旁路仍执行', async () => {
        manager.register(imAdapter);
        manager.register(stAdapter);
        manager.register(nativeAdapter);

        const { result } = await runner.run();
        // 没有任何 surfaceType='panel' 的适配器
        const dispatchResults = await manager.dispatch(result, ctx, {
            primarySurfaceType: 'panel',
            bypassSurfaceTypes: ['st'],
        });

        // 主没找到 -> 没有记录；旁路 st 有
        const primaries = dispatchResults.filter(r => r.kind === 'primary');
        assert.strictEqual(primaries.length, 0);
        assert.strictEqual(stAdapter._calls.length, 1);
    });

    test('会话绑定主适配器（bindPrimary）后，dispatch 不传 primarySurfaceType 也能找到', async () => {
        manager.register(imAdapter);
        manager.register(stAdapter);
        manager.register(nativeAdapter);

        // 绑定会话主适配器
        manager.bindPrimary('qq:chat-1', 'im-test');

        const { result } = await runner.run();
        // 不传 primarySurfaceType，应通过 sessionPrimary 解析
        const dispatchResults = await manager.dispatch(result, ctx, {
            bypassSurfaceTypes: ['st', 'native'],
        });

        const primary = dispatchResults.find(r => r.kind === 'primary');
        assert.strictEqual(primary.adapter, 'im-test');
        assert.strictEqual(stAdapter._calls.length, 1);
        assert.strictEqual(nativeAdapter._calls.length, 1);
    });

    test('主适配器与旁路适配器重名时去重（避免重复渲染）', async () => {
        // 同一适配器同时被指定为 primary 与 bypass，dispatch 应去重
        manager.register(imAdapter);
        const { result } = await runner.run();
        const dispatchResults = await manager.dispatch(result, ctx, {
            primarySurfaceType: 'im',
            bypassSurfaceTypes: ['im'], // 与主重名
        });

        // 只调用一次
        assert.strictEqual(imAdapter._calls.length, 1);
        assert.strictEqual(dispatchResults.length, 1);
    });

    test('完整流程：mock runner.run -> 三个适配器 -> 各自渲染（无错）', async () => {
        manager.register(imAdapter);
        manager.register(stAdapter);
        manager.register(nativeAdapter);

        // 1. mock agent run
        const runOutput = await runner.run();
        assert.ok(runOutput.result instanceof AgentRunResult);

        // 2. dispatch 到三个适配器
        const results = await manager.dispatch(runOutput.result, ctx, {
            primarySurfaceType: 'im',
            bypassSurfaceTypes: ['st', 'native'],
        });

        // 3. 验证：3 个适配器都成功，主是 im
        assert.strictEqual(results.length, 3);
        const okCount = results.filter(r => r.result?.ok).length;
        assert.strictEqual(okCount, 3, '三个适配器应全部成功');

        // 4. 适配器各自能消费到的字段
        for (const adapter of [imAdapter, stAdapter, nativeAdapter]) {
            const r = adapter._calls[0].result;
            // 主文本
            assert.ok(r.getMainText().includes('正文段落 A'));
            // 选项
            assert.strictEqual(r.options.length, 2);
            // 状态
            assert.ok(r.state.visible.time);
            // 事件（时间线重建用）
            assert.ok(r.events.length >= 1);
        }
    });
});

describe('SubTask 7.1: dispatch 调用次数精准验证', () => {
    test('主 + N 个旁路适配器，总调用次数 = 1 + N（无重复）', async () => {
        const manager = new SurfaceManager({ logger: silentLogger });
        const im = makeTestAdapter('im', 'im');
        const st = makeTestAdapter('st', 'st');
        const native = makeTestAdapter('native', 'native');
        const extra = makeTestAdapter('extra-im', 'im'); // 同 type 的额外适配器
        manager.register(im);
        manager.register(st);
        manager.register(native);
        manager.register(extra);

        const result = AgentRunResult.fromRunResult('test', 0, 'r1');
        const dispatchResults = await manager.dispatch(result, { platform: 'qq', chatId: 'c' }, {
            primarySurfaceType: 'im',
            bypassSurfaceTypes: ['st', 'native', 'im'],
        });

        // 主 im 1 次（去重避免与 bypass 'im' 重复）
        // 旁路：st 1 + native 1 + extra-im 1（im type 下非主的另一个）
        assert.strictEqual(im._calls.length, 1, '主 im 应只调用 1 次（去重）');
        assert.strictEqual(extra._calls.length, 1, 'im type 下另一个适配器应被旁路调用 1 次');
        assert.strictEqual(st._calls.length, 1);
        assert.strictEqual(native._calls.length, 1);

        // dispatch 返回 4 条
        assert.strictEqual(dispatchResults.length, 4);
    });

    test('多次 dispatch 同一 result（多轮 RP），每个适配器调用次数线性增长', async () => {
        const manager = new SurfaceManager({ logger: silentLogger });
        const im = makeTestAdapter('im', 'im');
        const st = makeTestAdapter('st', 'st');
        const native = makeTestAdapter('native', 'native');
        manager.register(im);
        manager.register(st);
        manager.register(native);

        const result = AgentRunResult.fromRunResult('turn', 0, 'r1');
        for (let i = 0; i < 5; i++) {
            await manager.dispatch(result, { platform: 'qq', chatId: 'c' }, {
                primarySurfaceType: 'im',
                bypassSurfaceTypes: ['st', 'native'],
            });
        }

        // 5 轮 dispatch，每个适配器应被调用 5 次
        assert.strictEqual(im._calls.length, 5);
        assert.strictEqual(st._calls.length, 5);
        assert.strictEqual(native._calls.length, 5);

        // 每轮收到的 result 都是同一对象
        for (const c of im._calls) assert.strictEqual(c.result, result);
    });
});
