/**
 * 角色卡切换上下文隔离测试（P4-1 修复）
 *
 * 守护：同一面板会话（sessionKey）下切换角色卡后，新角色卡的 LLM 上下文
 * 只包含该角色卡自己的历史——旧卡的 AI 回复 / 用户输入 / 选项回调 / 开场白
 * 绝不混入新卡；切回旧卡时其历史可恢复。
 *
 * 覆盖场景：
 *   1. 切换后新卡 history 为空、切回旧卡历史恢复（互不混入）
 *   2. 新卡首轮 turn 从 1 重新计数
 *   3. rerun 跨角色隔离（新卡无上一轮输入 → 400）
 *   4. 选项回调跨角色隔离（不解析旧卡选项）
 *   5. history-sync 按角色归槽
 *   6. /chats/load 载入档只进该角色槽
 *   7. /chats/clear-session 只清当前角色槽
 *   8. charState：旧版会话（会话级 history）迁移到旧角色槽（单元测试）
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';

import { registerAgentApi, charState } from '../server/agent-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// Windows libuv：http server / undici 连接回收有异步延迟，等待句柄收尾避免 UV_HANDLE_CLOSING 崩溃
after(async () => {
    await new Promise(r => setTimeout(r, 1200));
});

function tmpDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 构造注入依赖：fake run 逐次记录调用参数，并按输入返回确定性结果。
 * @param {object} [opts]
 * @param {(call: object) => object} [opts.respond] - 自定义响应（返回 run 结果对象）
 */
function makeDeps(opts = {}) {
    const calls = [];
    const fakeAgentFramework = {
        _loaded: true,
        agentLoader: {
            list: () => [{ name: 'default-rp', displayName: '默认方案', tools: [] }],
            get: (name) => (name === 'default-rp' ? { name: 'default-rp', context: { historyLimit: 20 } } : null),
            save: () => ({}),
            delete: () => {},
        },
        toolRegistry: { list: () => [] },
        agentRunner: { getLogs: () => [] },
        workspaceManager: { getEvents: () => [] },
        _agentService: {
            run: async (profile, input, session, ctx) => {
                const call = { profile, input, session, ctx };
                calls.push(call);
                if (opts.respond) return opts.respond(call);
                const resultObj = {
                    toJSON: () => ({ options: [] }),
                    getMainText: () => `${input}→AI`,
                };
                return { runId: `run-${calls.length}`, aborted: false, text: `${input}→AI`, result: resultObj };
            },
            abortRun: () => true,
            getStatus: () => ({ activeAgents: [] }),
            getLastPrompt: () => null,
            getGreetings: () => null,
            getHistoryLimit: (p) => { const d = fakeAgentFramework.agentLoader.get(p); return d?.context?.historyLimit || 20; },
        },
    };
    return {
        deps: {
            getPluginManager: () => ({ loader: { getPlugin: (n) => (n === 'agent-framework' ? fakeAgentFramework : null) } }),
            getLlmService: () => ({ chat: async () => '{}' }),
            theatreBroadcaster: {
                addClient: () => {},
                broadcastRunState: () => {},
                broadcastResult: () => {},
                broadcastState: () => {},
                broadcast: () => {},
                shutdown: () => {},
            },
            configManager: { get: () => ({}) },
            logger: console,
            repoRoot: REPO_ROOT,
            staticDir: path.join(REPO_ROOT, 'public'),
            chatDataRoot: opts.chatDataRoot || path.join(REPO_ROOT, 'data', 'plugins', 'agent-framework'),
        },
        calls,
    };
}

async function withServer(deps, fn) {
    const app = express();
    app.use(express.json());
    registerAgentApi(app, deps);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    try {
        await fn(base);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

/** 发一条 /input（便捷封装） */
function postInput(base, session, body) {
    return fetch(`${base}/api/agent-theatre/input?session=${encodeURIComponent(session)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then(r => r.json());
}

describe('角色卡切换上下文隔离（P4-1）', () => {
    test('切换角色卡后新卡历史为空、切回旧卡历史恢复（互不混入）', async () => {
        const chatRoot = tmpDir('iso-chat-');
        try {
            const { deps, calls } = makeDeps({ chatDataRoot: chatRoot.dir });
            await withServer(deps, async (base) => {
                // 卡 A 聊 2 轮
                await postInput(base, 'native:iso1', { input: 'A你好', character: 'A' });
                await postInput(base, 'native:iso1', { input: 'A再来', character: 'A' });
                // 切到卡 B 发首条：run 收到的 history 必须为空（不含 A 的消息）
                await postInput(base, 'native:iso1', { input: 'B你好', character: 'B' });
                const callB = calls[calls.length - 1];
                assert.strictEqual(callB.session.character, 'B');
                assert.deepStrictEqual(callB.session.history, [], `卡B首轮 history 应为空，实际 ${JSON.stringify(callB.session.history)}`);
                assert.deepStrictEqual(callB.ctx.history, [], 'ctx.history 同样为空');
                assert.ok(!callB.session.history.some(m => String(m.content).startsWith('A')), '不得包含卡A消息');

                // 切回卡 A：历史应恢复为 A 的两轮消息（不含 B 的）
                await postInput(base, 'native:iso1', { input: 'A回来了', character: 'A' });
                const callA = calls[calls.length - 1];
                assert.strictEqual(callA.session.character, 'A');
                const contents = callA.session.history.map(m => m.content).join('|');
                assert.ok(contents.includes('A你好'), '应包含卡A首轮输入');
                assert.ok(contents.includes('A再来'), '应包含卡A第二轮输入');
                assert.ok(!contents.includes('B你好'), `不得包含卡B消息，实际 ${contents}`);
            });
        } finally {
            chatRoot.cleanup();
        }
    });

    test('新卡首轮 turn 从 1 重新计数（回合数隔离）', async () => {
        const chatRoot = tmpDir('iso-chat-');
        try {
            const { deps, calls } = makeDeps({ chatDataRoot: chatRoot.dir });
            await withServer(deps, async (base) => {
                await postInput(base, 'native:iso2', { input: 'A1', character: 'A' });
                await postInput(base, 'native:iso2', { input: 'A2', character: 'A' });
                assert.strictEqual(calls[calls.length - 1].session.turn, 2, '卡A第二轮 turn=2');
                await postInput(base, 'native:iso2', { input: 'B1', character: 'B' });
                assert.strictEqual(calls[calls.length - 1].session.turn, 1, '卡B首轮 turn=1（从新计数）');
            });
        } finally {
            chatRoot.cleanup();
        }
    });

    test('rerun 跨角色隔离：新卡无上一轮输入返回 400', async () => {
        const chatRoot = tmpDir('iso-chat-');
        try {
            const { deps } = makeDeps({ chatDataRoot: chatRoot.dir });
            await withServer(deps, async (base) => {
                await postInput(base, 'native:iso3', { input: 'A输入', character: 'A' });
                // 切到卡 B 后 rerun：B 槽无 lastInput → 400
                const resp = await fetch(`${base}/api/agent-theatre/input?session=native:iso3`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rerun: true, character: 'B' }),
                });
                assert.strictEqual(resp.status, 400, '新卡无上一轮输入应拒绝重跑');
                // 卡 A rerun 正常（历史/输入都在 A 槽）
                const respA = await fetch(`${base}/api/agent-theatre/input?session=native:iso3`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rerun: true, character: 'A' }),
                });
                assert.strictEqual(respA.status, 200, '旧卡 rerun 应正常');
            });
        } finally {
            chatRoot.cleanup();
        }
    });

    test('选项回调跨角色隔离：不解析旧卡选项', async () => {
        const chatRoot = tmpDir('iso-chat-');
        try {
            const { deps, calls } = makeDeps({
                chatDataRoot: chatRoot.dir,
                respond: (call) => {
                    // 卡 A 的首轮产出带选项的结果
                    const withOptions = {
                        toJSON: () => ({ options: [{ text: 'A的选项', callbackId: 'select:option:一' }] }),
                        getMainText: () => 'A正文',
                    };
                    return { runId: 'r', aborted: false, text: 'A正文', result: withOptions };
                },
            });
            await withServer(deps, async (base) => {
                await postInput(base, 'native:iso4', { input: 'A输入', character: 'A' });
                // 切到卡 B，仅传旧卡（A）的 callbackId：B 槽无 lastResult，应退化为原始 callbackId 文本
                await postInput(base, 'native:iso4', { callbackId: 'select:option:一', character: 'B' });
                const last = calls[calls.length - 1];
                assert.strictEqual(last.session.character, 'B');
                assert.strictEqual(last.input, '[选项回调] select:option:一', '不得解析出卡A的选项文本');
            });
        } finally {
            chatRoot.cleanup();
        }
    });

    test('history-sync 按角色归槽：不同角色本地历史互不串扰', async () => {
        await withServer(makeDeps().deps, async (base) => {
            const url = `${base}/api/agent-theatre/history-sync?session=native:iso5`;
            // 卡 A 的本地历史
            const rA = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character: 'A', history: [{ role: 'user', content: 'A本地1' }, { role: 'assistant', content: 'A本地回' }] }),
            });
            assert.strictEqual((await rA.json()).merged, 2);
            // 卡 B 的本地历史（独立槽）
            const rB = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character: 'B', history: [{ role: 'user', content: 'B本地1' }] }),
            });
            assert.strictEqual((await rB.json()).merged, 1);
            // 卡 A 再次同步新历史 → A 槽已有历史，不应覆盖
            const rA2 = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character: 'A', history: [{ role: 'user', content: 'A覆盖尝试' }] }),
            });
            const bA2 = await rA2.json();
            assert.strictEqual(bA2.merged, 0, 'A 槽已有历史不应被覆盖');
            assert.strictEqual(bA2.serverLength, 2);
        });
    });

    test('/chats/load 载入档只进该角色槽，切到其它卡不混入', async () => {
        const chatRoot = tmpDir('iso-chat-');
        try {
            const { deps, calls } = makeDeps({ chatDataRoot: chatRoot.dir });
            await withServer(deps, async (base) => {
                // 先保存一份卡 A 的聊天档
                const saveResp = await fetch(`${base}/api/agent-theatre/chats/save?session=native:iso6`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ character: 'A', messages: [{ role: 'user', content: '档A1' }, { role: 'assistant', content: '档A回' }] }),
                });
                const saved = await saveResp.json();
                assert.strictEqual(saved.success, true);
                // 载入 A 档 → 写入 A 槽，sess.character 同步为 A
                const loadResp = await fetch(`${base}/api/agent-theatre/chats/load?session=native:iso6`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ file: saved.file }),
                });
                const loaded = await loadResp.json();
                assert.strictEqual(loaded.success, true);
                assert.strictEqual(loaded.messages.length, 2);
                // 切到卡 B 发消息：B 的 history 必须为空（A 档内容不得混入）
                await postInput(base, 'native:iso6', { input: 'B消息', character: 'B' });
                const last = calls[calls.length - 1];
                assert.deepStrictEqual(last.session.history, [], `卡B不得携带载入的A档内容，实际 ${JSON.stringify(last.session.history)}`);
            });
        } finally {
            chatRoot.cleanup();
        }
    });

    test('/chats/clear-session 只清当前角色槽，其它角色历史保留', async () => {
        const chatRoot = tmpDir('iso-chat-');
        try {
            const { deps, calls } = makeDeps({ chatDataRoot: chatRoot.dir });
            await withServer(deps, async (base) => {
                await postInput(base, 'native:iso7', { input: 'A1', character: 'A' });
                await postInput(base, 'native:iso7', { input: 'A2', character: 'A' });
                // 切到卡 B（A 的槽被归档保留）
                await postInput(base, 'native:iso7', { input: 'B1', character: 'B' });
                // 当前是 B：clear-session 只清 B 槽
                const clearResp = await fetch(`${base}/api/agent-theatre/chats/clear-session?session=native:iso7`, {
                    method: 'POST',
                });
                assert.strictEqual((await clearResp.json()).cleared, true);
                // B 再发消息：history 应为空（B 槽已清）
                await postInput(base, 'native:iso7', { input: 'B再来', character: 'B' });
                assert.deepStrictEqual(calls[calls.length - 1].session.history, [], 'B槽应已被清空');
                // 切回 A：A 的历史应完整保留（未被 clear 波及）
                await postInput(base, 'native:iso7', { input: 'A回来', character: 'A' });
                const contents = calls[calls.length - 1].session.history.map(m => m.content).join('|');
                assert.ok(contents.includes('A1') && contents.includes('A2'), `A槽历史应保留，实际 ${contents}`);
            });
        } finally {
            chatRoot.cleanup();
        }
    });
});

describe('charState（P4-1 单元）', () => {
    test('同一会话不同角色返回独立卡槽，互不影响', () => {
        const sess = {};
        const a = charState(sess, 'A');
        const b = charState(sess, 'B');
        assert.notStrictEqual(a, b, '不同角色应返回不同卡槽');
        a.history.push({ role: 'user', content: 'A消息' });
        assert.strictEqual(b.history.length, 0, 'A 的写入不得影响 B');
    });

    test('空角色（未绑定）与具名角色相互隔离', () => {
        const sess = {};
        const none = charState(sess, '');
        const named = charState(sess, '艾丽丝');
        none.history.push({ role: 'user', content: 'x' });
        assert.strictEqual(named.history.length, 0);
    });

    test('旧版会话（会话级 history）迁移到旧角色槽，不丢失历史', () => {
        const legacy = {
            character: '旧卡',
            history: [{ role: 'user', content: '旧消息1' }, { role: 'assistant', content: '旧回复' }],
            turn: 3,
            lastInput: '旧输入',
            dirty: true,
        };
        const slot = charState(legacy, '旧卡');
        assert.strictEqual(slot.history.length, 2, '历史应迁移到旧卡槽');
        assert.strictEqual(slot.turn, 3);
        assert.strictEqual(slot.lastInput, '旧输入');
        assert.strictEqual(slot.dirty, true);
        // 迁移后会话级字段不再作为权威（访问新卡槽为空）
        const other = charState(legacy, '新卡');
        assert.strictEqual(other.history.length, 0);
    });

    test('charState 幂等：重复取同一角色返回同一实例', () => {
        const sess = {};
        assert.strictEqual(charState(sess, 'A'), charState(sess, 'A'));
    });
});
