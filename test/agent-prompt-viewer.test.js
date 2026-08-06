/**
 * 提示词查看器与上下文一致性测试（P2/P4/P5 修复）
 *
 * 守护：
 *   1. buildContextWithGreeting 共享组装：开场白注入 / 有历史不注入 / 全部历史透传（P5 单一组装路径）
 *   2. lastPromptMap 按"会话+角色卡"双维度缓存：切卡后不会命中旧卡记录（P4）
 *   3. POST /api/agent-theatre/prompt-preview：无 run 即可构建当前角色卡上下文（P2）
 *   4. 一致性：run 实际注入的 messages 与共享组装输出逐字节一致（P5）
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildContextWithGreeting } from '../server/agent/context-builder.js';
import { AgentRunner } from '../plugins/agent-framework/engine/agent-runner.js';
import { registerAgentApi } from '../server/agent-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// Windows libuv：等待句柄收尾，避免 --test-force-exit 撞上 UV_HANDLE_CLOSING 崩溃
after(async () => {
    await new Promise(r => setTimeout(r, 1200));
});

/** 假 ContextBuilder：记录每次 build 入参，按角色返回开场白（供共享组装函数调用） */
function makeFakeBuilder() {
    const buildCalls = [];
    return {
        buildCalls,
        selectGreeting(character, index = 0) {
            if (!character) return '';
            return `${character}开场白${index}`;
        },
        build(definition, session, history, userMessage) {
            buildCalls.push({ definition, session, history, userMessage });
            const messages = [{ role: 'system', content: 'sys' }];
            for (const h of history) messages.push({ ...h });
            if (userMessage) messages.push({ role: 'user', content: userMessage });
            return messages;
        },
    };
}

const DEF = { name: 'default-rp', displayName: '默认方案', context: { historyLimit: 20 } };

function makeRunner(cb, opts = {}) {
    return new AgentRunner({
        contextBuilder: cb,
        toolRegistry: { getDeclarations: () => [], createExecutor: () => async () => 'ok' },
        stateManager: { flush: () => {} },
        logger: { info: () => {}, error: () => {}, warn: () => {} },
        ...opts,
    });
}

describe('buildContextWithGreeting（P5 共享组装路径）', () => {
    test('无历史 + 有角色卡 → 注入开场白并追加说明段', () => {
        const cb = makeFakeBuilder();
        const { messages, greetingInjected } = buildContextWithGreeting(cb, DEF, { character: '艾丽丝', greetingIndex: 0 }, [], '你好');
        assert.strictEqual(greetingInjected, true);
        assert.deepStrictEqual(messages.map(m => m.role), ['system', 'assistant', 'user']);
        assert.strictEqual(messages[1].content, '艾丽丝开场白0');
        assert.match(messages[0].content, /开场白已展示/);
    });

    test('有历史 → 不注入开场白，历史完整透传', () => {
        const cb = makeFakeBuilder();
        const history = [
            { role: 'user', content: '之前1' }, { role: 'assistant', content: '回1' },
            { role: 'user', content: '之前2' }, { role: 'assistant', content: '回2' },
        ];
        const { messages, greetingInjected } = buildContextWithGreeting(cb, DEF, { character: '艾丽丝' }, history, '继续');
        assert.strictEqual(greetingInjected, false);
        assert.strictEqual(messages.length, 6, 'system + 4 条历史 + 当前输入 = 6');
        // 全部历史逐条保留且顺序不变
        assert.strictEqual(messages[1].content, '之前1');
        assert.strictEqual(messages[4].content, '回2');
        assert.strictEqual(messages[5].content, '继续');
    });

    test('无角色卡 / 无开场白 → 不注入', () => {
        const cb = makeFakeBuilder();
        const { greetingInjected } = buildContextWithGreeting(cb, DEF, {}, [], 'hi');
        assert.strictEqual(greetingInjected, false);
        const cb2 = makeFakeBuilder();
        cb2.selectGreeting = () => '';
        const { greetingInjected: g2 } = buildContextWithGreeting(cb2, DEF, { character: 'x' }, [], 'hi');
        assert.strictEqual(g2, false);
    });
});

describe('lastPromptMap 按 会话+角色卡 隔离（P4）', () => {
    test('不同角色卡各自保留 prompt，切卡后不命中旧卡记录', async () => {
        const cb = makeFakeBuilder();
        const runner = makeRunner(cb);
        await runner.run(DEF, { character: 'A', platform: 'native', chatId: 'x' }, [], '1', { llm: { runToolsStream: async () => ({ text: 'ok', steps: 0 }) } });
        await runner.run(DEF, { character: 'B', platform: 'native', chatId: 'x' }, [], '2', { llm: { runToolsStream: async () => ({ text: 'ok', steps: 0 }) } });

        const a = runner.getLastPrompt('native:x', 'A');
        const b = runner.getLastPrompt('native:x', 'B');
        assert.ok(a, 'A 卡应有自己的 prompt');
        assert.ok(b, 'B 卡应有自己的 prompt');
        // 关键：A 卡记录中首条 assistant 是 A 的开场白，B 卡记录中是 B 的开场白——互不串扰
        assert.strictEqual(a.messages[1].content, 'A开场白0');
        assert.strictEqual(b.messages[1].content, 'B开场白0');
        // 未指定角色：返回最近一次（B）
        const latest = runner.getLastPrompt('native:x');
        assert.strictEqual(latest.messages[1].content, 'B开场白0');
        // 未 run 过的角色卡：null（切到新卡未 run 时查看器不会显示旧卡内容）
        assert.strictEqual(runner.getLastPrompt('native:x', 'C'), null);
    });
});

describe('POST /api/agent-theatre/prompt-preview（P2 无 run 预览）', () => {
    function makeDeps(buildContextImpl) {
        const fakeAgentFramework = {
            _loaded: true,
            agentLoader: {
                list: () => [{ name: 'default-rp', displayName: '默认方案', tools: [] }],
                get: (name) => (name === 'default-rp' ? DEF : null),
                save: () => ({}),
                delete: () => {},
            },
            toolRegistry: { list: () => [] },
            agentRunner: { getLogs: () => [] },
            workspaceManager: { getEvents: () => [] },
            _agentService: {
                run: async () => ({ runId: 'r', aborted: false, text: 'ok', result: null }),
                buildContext: buildContextImpl,
                getLastPrompt: () => null,
                getGreetings: () => null,
                getHistoryLimit: () => 20,
                abortRun: () => true,
                getStatus: () => ({}),
            },
        };
        return {
            getPluginManager: () => ({ loader: { getPlugin: (n) => (n === 'agent-framework' ? fakeAgentFramework : null) } }),
            getLlmService: () => ({ chat: async () => '{}' }),
            theatreBroadcaster: {
                addClient: () => {}, broadcastRunState: () => {}, broadcastResult: () => {},
                broadcastState: () => {}, broadcast: () => {}, shutdown: () => {},
            },
            configManager: { get: () => ({}) },
            logger: console,
            repoRoot: REPO_ROOT,
            staticDir: path.join(REPO_ROOT, 'public'),
        };
    }

    async function withServer(deps, fn) {
        const app = express();
        app.use(express.json());
        registerAgentApi(app, deps);
        const server = http.createServer(app);
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        try { await fn(base); } finally { await new Promise(r => server.close(r)); }
    }

    test('未 run 也能返回当前角色卡的完整上下文（含开场白 + 全部历史）', async () => {
        let captured = null;
        const buildContextImpl = async (profile, session, history, userMessage) => {
            captured = { profile, session, history, userMessage };
            const messages = [{ role: 'system', content: 'sys' }];
            for (const h of history) messages.push({ ...h });
            messages.push({ role: 'user', content: userMessage });
            return { messages, greetingInjected: history.length === 0 && !!session.character };
        };
        await withServer(makeDeps(buildContextImpl), async (base) => {
            // 先通过 /input 让会话绑定角色卡 A 并积累历史
            await fetch(`${base}/api/agent-theatre/input?session=native:pv`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: '你好A', character: 'A' }),
            });
            // 无 run 的 preview：用当前角色卡槽历史构建上下文
            const resp = await fetch(`${base}/api/agent-theatre/prompt-preview?session=native:pv`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: '下一条输入' }),
            });
            const data = await resp.json();
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.preview, true);
            assert.strictEqual(data.character, 'A');
            assert.ok(data.prompt.messages.length >= 3, '应包含 system + 历史 + 当前输入');
            assert.ok(data.prompt.messages.some(m => m.content === '你好A'), '历史应包含角色卡 A 的上一轮输入');
            assert.strictEqual(data.prompt.messages[data.prompt.messages.length - 1].content, '下一条输入');
            assert.strictEqual(data.prompt.runId, null, '预览 runId 应为 null（未发送）');
        });
    });

    test('切到新角色卡后 preview 不携带旧卡历史（P4 隔离）', async () => {
        const calls = [];
        const buildContextImpl = async (profile, session, history) => {
            calls.push({ session, history });
            return { messages: [{ role: 'system', content: 'sys' }, ...history], greetingInjected: false };
        };
        await withServer(makeDeps(buildContextImpl), async (base) => {
            await fetch(`${base}/api/agent-theatre/input?session=native:pv2`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: 'A消息', character: 'A' }),
            });
            // 切到 B 并 preview
            const resp = await fetch(`${base}/api/agent-theatre/prompt-preview?session=native:pv2`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character: 'B' }),
            });
            const data = await resp.json();
            const last = calls[calls.length - 1];
            assert.strictEqual(data.character, 'B');
            assert.deepStrictEqual(last.history, [], 'B 卡 preview 的历史应为空，不得携带 A 的消息');
        });
    });

    test('Profile 不存在时返回 success:false（前端可降级）', async () => {
        const buildContextImpl = async () => { throw new Error('Agent profile "nope" 不存在'); };
        await withServer(makeDeps(buildContextImpl), async (base) => {
            const resp = await fetch(`${base}/api/agent-theatre/prompt-preview?session=native:pv3`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profile: 'nope' }),
            });
            const data = await resp.json();
            assert.strictEqual(data.success, false);
            assert.match(data.error, /不存在/);
        });
    });
});

describe('一致性：run 注入 == 共享组装输出（P5）', () => {
    test('同一状态下 buildContextWithGreeting 输出与 runner 捕获的 prompt 逐字节一致', async () => {
        const cb = makeFakeBuilder();
        const runner = makeRunner(cb);
        const session = { character: '艾丽丝', greetingIndex: 0, platform: 'native', chatId: 'c1' };
        const history = [{ role: 'user', content: '上一轮' }, { role: 'assistant', content: '上轮回' }];

        // 方式1：通过 runner（run 实际注入路径）捕获 prompt
        await runner.run(DEF, session, history, '本轮输入', { llm: { runToolsStream: async () => ({ text: 'ok', steps: 0 }) } });
        const runMessages = runner.getLastPrompt('native:c1', '艾丽丝').messages;

        // 方式2：共享组装函数（查看器预览路径）直接产出
        const { messages: previewMessages } = buildContextWithGreeting(cb, DEF, session, history, '本轮输入');

        assert.deepStrictEqual(previewMessages, runMessages, '预览输出应与 run 实际注入的 messages 完全一致');
    });
});
