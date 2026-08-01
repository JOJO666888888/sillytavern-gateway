/**
 * AgentRunResult 数据契约测试（Task 1.1 / 1.5）
 *
 * 守护 spec.md "Scenario: 结构化输出契约"：
 *   artifacts / options / state / events / meta 五要素 + AgentEvent 类型校验。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { AgentRunResult, AgentEvent, AgentEventType } from '../server/agent/run-result.js';

describe('AgentRunResult 构造与默认值', () => {
    test('空构造产生合法空结构', () => {
        const r = new AgentRunResult();
        assert.strictEqual(r.runId, '');
        assert.deepStrictEqual(r.artifacts, []);
        assert.deepStrictEqual(r.options, []);
        assert.deepStrictEqual(r.state, { visible: {}, private: {} });
        assert.deepStrictEqual(r.events, []);
        assert.strictEqual(r.meta.viewMode, 'first');
        assert.strictEqual(r.meta.style, '');
        assert.strictEqual(r.meta.turn, 0);
        assert.strictEqual(r.meta.referencedMemory, '');
    });

    test('预置 artifacts / options / events / state / meta', () => {
        const r = new AgentRunResult({
            runId: 'r1',
            artifacts: [{ type: 'outline', text: '大纲' }],
            options: [{ label: 'A', text: '前进' }],
            state: { visible: { turn: 1 }, private: { secret: 'x' } },
            events: [{ type: 'tool_call', payload: { tool: 't' } }],
            meta: { viewMode: 'third', style: '去八股', turn: 5 },
        });
        assert.strictEqual(r.runId, 'r1');
        assert.strictEqual(r.artifacts.length, 1);
        assert.strictEqual(r.artifacts[0].type, 'outline');
        assert.strictEqual(r.options[0].label, 'A');
        assert.strictEqual(r.state.visible.turn, 1);
        assert.strictEqual(r.state.private.secret, 'x');
        assert.strictEqual(r.events.length, 1);
        assert.strictEqual(r.meta.viewMode, 'third');
        assert.strictEqual(r.meta.style, '去八股');
        assert.strictEqual(r.meta.turn, 5);
    });
});

describe('AgentRunResult.fromRunResult', () => {
    test('主文本作为 type=main 的 artifact', () => {
        const r = AgentRunResult.fromRunResult('正文内容', 3, 'run-1', { style: '文风A' });
        assert.strictEqual(r.runId, 'run-1');
        assert.strictEqual(r.artifacts.length, 1);
        assert.strictEqual(r.artifacts[0].type, 'main');
        assert.strictEqual(r.artifacts[0].text, '正文内容');
        assert.strictEqual(r.meta.style, '文风A');
    });

    test('空文本不产生 artifact', () => {
        const r = AgentRunResult.fromRunResult('', 0, 'r2');
        assert.strictEqual(r.artifacts.length, 0);
    });
});

describe('addArtifact / addOption', () => {
    test('addArtifact 自动生成 id 并保留文本', () => {
        const r = new AgentRunResult();
        r.addArtifact({ type: 'draft', text: '草稿' });
        assert.strictEqual(r.artifacts[0].id, 'art-1');
        assert.strictEqual(r.artifacts[0].text, '草稿');
        r.addArtifact({ id: 'custom', text: 123 });
        assert.strictEqual(r.artifacts[1].id, 'custom');
        assert.strictEqual(r.artifacts[1].text, '123');
    });

    test('addOption 自动生成 callbackId', () => {
        const r = new AgentRunResult();
        r.addOption({ label: '1', text: '攻击' });
        r.addOption({ label: '2', text: '防御', callbackId: 'cb-x' });
        assert.strictEqual(r.options[0].callbackId, 'cb-1');
        assert.strictEqual(r.options[1].callbackId, 'cb-x');
    });
});

describe('addEvent + seq 单调递增', () => {
    test('addEvent 返回 AgentEvent 且 seq 从 1 起递增', () => {
        const r = new AgentRunResult();
        const e1 = r.addEvent(AgentEventType.TOOL_CALL, { tool: 'a' });
        const e2 = r.addEvent(AgentEventType.STATE_CHANGE, { key: 'k' });
        assert.ok(e1 instanceof AgentEvent);
        assert.strictEqual(e1.seq, 1);
        assert.strictEqual(e2.seq, 2);
        assert.strictEqual(r.events.length, 2);
        assert.strictEqual(r.events[0].type, 'tool_call');
        assert.strictEqual(r.events[1].payload.key, 'k');
    });

    test('通过构造 events 预置的事件也会自增 seq', () => {
        const r = new AgentRunResult({
            events: [
                { type: 'checkpoint', payload: { label: 'init' } },
                { type: 'draft', payload: {} },
            ],
        });
        assert.strictEqual(r.events[0].seq, 1);
        assert.strictEqual(r.events[1].seq, 2);
        // 后续 addEvent 继续 3
        const e3 = r.addEvent('commit', { promoted: [] });
        assert.strictEqual(e3.seq, 3);
    });
});

describe('updateState / updateMeta', () => {
    test('updateState 默认合并到 visible 层', () => {
        const r = new AgentRunResult();
        r.updateState({ turn: 1 });
        r.updateState({ scene: '酒馆' });
        assert.deepStrictEqual(r.state.visible, { turn: 1, scene: '酒馆' });
        assert.deepStrictEqual(r.state.private, {});
    });

    test('updateState 指定 private 层', () => {
        const r = new AgentRunResult();
        r.updateState({ secret: 'x' }, 'private');
        assert.strictEqual(r.state.private.secret, 'x');
    });

    test('updateState 非法 visibility 被忽略', () => {
        const r = new AgentRunResult();
        r.updateState({ a: 1 }, 'weird');
        assert.deepStrictEqual(r.state.visible, {});
    });

    test('updateMeta 合并', () => {
        const r = new AgentRunResult({ meta: { turn: 1 } });
        r.updateMeta({ style: '文风B' });
        assert.strictEqual(r.meta.turn, 1);
        assert.strictEqual(r.meta.style, '文风B');
    });
});

describe('getMainText', () => {
    test('优先返回 type=main 的 artifact', () => {
        const r = new AgentRunResult();
        r.addArtifact({ type: 'outline', text: '大纲' });
        r.addArtifact({ type: 'main', text: '正文' });
        assert.strictEqual(r.getMainText(), '正文');
    });

    test('无 main 时回退首个 artifact', () => {
        const r = new AgentRunResult();
        r.addArtifact({ type: 'draft', text: '草稿' });
        assert.strictEqual(r.getMainText(), '草稿');
    });

    test('无 artifact 返回空串', () => {
        assert.strictEqual(new AgentRunResult().getMainText(), '');
    });
});

describe('toJSON 往返', () => {
    test('序列化包含全部五要素且可重建', () => {
        const r = AgentRunResult.fromRunResult('正文', 2, 'r3', { turn: 1 });
        r.addOption({ label: 'A', text: '前进' });
        r.updateState({ turn: 1 });
        r.addEvent(AgentEventType.CHECKPOINT, { label: 'init' });

        const json = r.toJSON();
        assert.strictEqual(json.runId, 'r3');
        assert.strictEqual(json.artifacts[0].text, '正文');
        assert.strictEqual(json.options[0].label, 'A');
        assert.strictEqual(json.state.visible.turn, 1);
        assert.strictEqual(json.events[0].type, 'checkpoint');
        assert.strictEqual(json.events[0].seq, 1);
        assert.ok(typeof json.events[0].timestamp === 'number');

        // 可被 JSON.parse 重建
        const rebuilt = JSON.parse(JSON.stringify(json));
        assert.strictEqual(rebuilt.artifacts[0].text, '正文');
    });
});

describe('AgentEvent 类型校验', () => {
    test('合法类型正常构造', () => {
        for (const t of Object.values(AgentEventType)) {
            const e = new AgentEvent({ type: t });
            assert.strictEqual(e.type, t);
            assert.deepStrictEqual(e.payload, {});
            assert.strictEqual(e.seq, 0);
            assert.ok(typeof e.timestamp === 'number');
        }
    });

    test('非法类型抛错', () => {
        assert.throws(() => new AgentEvent({ type: 'not_a_type' }), /非法 AgentEvent 类型/);
    });

    test('AgentEvent.create 工厂', () => {
        const e = AgentEvent.create('subagent', { agent: 'critic' }, 9);
        assert.strictEqual(e.type, 'subagent');
        assert.strictEqual(e.payload.agent, 'critic');
        assert.strictEqual(e.seq, 9);
    });

    test('toJSON', () => {
        const e = new AgentEvent({ type: 'commit', payload: { promoted: ['a.md'] }, seq: 2 });
        const j = e.toJSON();
        assert.deepStrictEqual(j, {
            type: 'commit',
            payload: { promoted: ['a.md'] },
            seq: 2,
            timestamp: e.timestamp,
        });
    });
});
