/**
 * 脚本库（对标酒馆助手 Tavern-Helper）测试。
 *
 * 覆盖：
 *   1. ScriptStore：CRUD / 版本快照 / 全局-角色隔离 / 批量导入
 *   2. 沙箱执行：基本 JS / getChatMessages / 变量 API / triggerSlash / Mvu / 事件按钮
 *   3. 事件分发：emitToSession（MESSAGE_RECEIVED / 按钮）
 *   4. agent-api 集成：scripts CRUD / run / sync / 角色加载自动同步 / 每轮事件触发
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

import { ScriptStore } from '../server/agent/script-store.js';
import { ScriptEngine, SCRIPT_EVENTS, extractCardScripts } from '../server/agent/script-engine.js';
import { registerAgentApi } from '../server/agent-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

after(async () => { await new Promise(r => setTimeout(r, 1200)); });

// ==================== 1. ScriptStore ====================

describe('ScriptStore 存储', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scripts-'));

    test('CRUD + 版本快照 + 全局/角色隔离', () => {
        const store = new ScriptStore(tmpDir);
        const s1 = store.createScript({ scope: 'global', name: '自动总结', content: '// v1' });
        assert.ok(s1.id, '应有 id');
        // 更新 content → 自动留版本快照
        const s2 = store.updateScript({ scope: 'global', id: s1.id, patch: { content: '// v2' } });
        assert.strictEqual(s2.content, '// v2');
        const versions = store.getVersions('global', '', s1.id);
        assert.strictEqual(versions.length, 1);
        assert.strictEqual(versions[0].content, '// v1');
        // 回滚
        const s3 = store.restoreVersion('global', '', s1.id, versions[0].ts);
        assert.strictEqual(s3.content, '// v1');
        // 角色脚本与全局隔离
        store.createScript({ scope: 'character', character: '络络', name: '角色脚本', content: 'x' });
        assert.strictEqual(store.listScripts('global').length, 1);
        assert.strictEqual(store.listScripts('character', '络络').length, 1);
        assert.strictEqual(store.listScripts('character', '苏苏').length, 0);
        // 删除
        assert.strictEqual(store.deleteScript({ scope: 'global', id: s1.id }), true);
        assert.strictEqual(store.listScripts('global').length, 0);
    });

    test('批量导入：同 id 覆盖更新、新 id 追加', () => {
        const store = new ScriptStore(tmpDir);
        const a = { id: 'fixed-id', name: 'A', content: '// a1' };
        const r1 = store.importScripts('global', '', [a, { name: 'B', content: '// b1' }]);
        assert.strictEqual(r1.imported, 2);
        const r2 = store.importScripts('global', '', [{ id: 'fixed-id', name: 'A', content: '// a2' }]);
        assert.strictEqual(r2.updated, 1);
        const scripts = store.listScripts('global');
        assert.strictEqual(scripts.length, 2);
        assert.strictEqual(scripts.find(s => s.id === 'fixed-id').content, '// a2');
    });
});

// ==================== 2. 沙箱执行（ScriptEngine 单元） ====================

function makeEngine(tmpDir, initialStat = {}) {
    const store = new ScriptStore(tmpDir);
    const state = { statData: { ...initialStat }, history: [] };
    const engine = new ScriptEngine({
        store,
        getHistory: () => state.history,
        getStatData: () => state.statData,
        setStatData: (_sk, _c, data) => { state.statData = data; },
        getCharName: () => '络络',
        getUserName: () => 'User',
        makeLlmClient: () => null,
        logger: console,
        timeoutMs: 3000,
    });
    return { store, engine, state };
}

describe('ScriptEngine 沙箱执行', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sandbox-'));

    test('基本 JS 执行 + console 日志捕获 + 死循环超时', async () => {
        const { engine, store } = makeEngine(tmpDir);
        const script = store.createScript({ scope: 'global', name: 't1', content: 'console.log("hello"); let a = 1 + 2; __setPipe("sum=" + a);' });
        const r = await engine.runScript({ sessionKey: 'sk', scope: 'global', script, scriptId: script.id });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.result, 'sum=3');
        assert.ok(r.logs.some(l => l.includes('hello')));
        // 死循环超时（timeoutMs=3000 太长，用小超时实例）
        const e2 = new ScriptEngine({ store, getHistory: () => [], getStatData: () => ({}), setStatData: () => {}, getCharName: () => '', getUserName: () => 'User', makeLlmClient: () => null, logger: console, timeoutMs: 200 });
        const r2 = await e2.runScript({ sessionKey: 'sk', scope: 'global', script: { ...script, content: 'while(true){}' } });
        assert.strictEqual(r2.ok, false);
        assert.ok((r2.error || '').includes('timed out') || (r2.error || '').includes('超时'), `应超时：${r2.error}`);
    });

    test('getChatMessages / getLastMessageId / 消息映射', async () => {
        const { engine, store, state } = makeEngine(tmpDir);
        state.history = [
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '你好呀' },
        ];
        const script = store.createScript({ scope: 'global', name: 't2', content: `
            const msgs = getChatMessages(-2);
            const last = getLastMessageId();
            __setPipe(msgs.length + '|' + msgs[0].role + '|' + msgs[0].message + '|' + last);
        ` });
        const r = await engine.runScript({ sessionKey: 'sk', scope: 'global', script });
        assert.strictEqual(r.result, '2|user|你好|1');
    });

    test('变量 API：getVariables(chat)=MVU stat_data；replaceVariables 写回', async () => {
        const { engine, store, state } = makeEngine(tmpDir, { 好感度: 60 });
        const script = store.createScript({ scope: 'global', name: 't3', content: `
            const cur = getVariables({ type: 'chat' });
            replaceVariables({ ...cur, 心情: '开心' }, { type: 'chat' });
            __setPipe(getVariables({ type: 'chat' }).好感度);
        ` });
        const r = await engine.runScript({ sessionKey: 'sk', scope: 'global', script });
        assert.strictEqual(r.result, 60, 'MVU 变量值应经管道返回');
        assert.strictEqual(state.statData['心情'], '开心', 'replaceVariables 应写回 stat_data');
    });

    test('Mvu.getMvuData / parseMessage / 事件按钮触发', async () => {
        const { engine, store, state } = makeEngine(tmpDir, { 角色: { 络络: { 好感度: 20 } } });
        const script = store.createScript({ scope: 'global', name: 't4', content: `
            eventOn(getButtonEvent('推进'), () => {
                const d = Mvu.getMvuData({ type: 'chat' });
                const next = Mvu.parseMessage("_.set('角色.络络.好感度', 50);", d);
                Mvu.replaceMvuData(next, { type: 'chat' });
                __setPipe('ok:' + Mvu.getMvuData({ type: 'chat' }).stat_data['角色']['络络']['好感度']);
            });
        ` });
        const r = await engine.runScript({ sessionKey: 'sk', scope: 'global', script, buttonName: '推进' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.result, 'ok:50');
        assert.strictEqual(state.statData['角色']['络络']['好感度'], 50, 'Mvu.replaceMvuData 应写回 stat_data');
    });

    test('triggerSlash：/pass | /echo 管道', async () => {
        const { engine, store } = makeEngine(tmpDir);
        const script = store.createScript({ scope: 'global', name: 't5', content: `
            const out = await triggerSlash('/pass 你好 | /echo');
            __setPipe(out);
        ` });
        const r = await engine.runScript({ sessionKey: 'sk', scope: 'global', script });
        assert.strictEqual(r.result, '你好');
    });

    test('事件分发：emitToSession 触发启用脚本的 MESSAGE_RECEIVED', async () => {
        const { engine, store, state } = makeEngine(tmpDir, { 计数: 0 });
        store.createScript({ scope: 'global', name: 'auto', content: `
            eventOn(tavern_events.MESSAGE_RECEIVED, (data) => {
                const cur = getVariables({ type: 'chat' });
                replaceVariables({ ...cur, 计数: (cur.计数 || 0) + 1 }, { type: 'chat' });
            });
        ` });
        await engine.emitToSession({ sessionKey: 'sk', character: '', eventType: SCRIPT_EVENTS.MESSAGE_RECEIVED, args: { message_id: 3 } });
        assert.strictEqual(state.statData['计数'], 1, '事件监听器应执行并修改 stat_data');
    });

    test('extractCardScripts：新旧字段兼容', () => {
        const card = { extensions: { tavern_helper: { scripts: [{ id: 'x', content: '//' }], variables: { a: 1 } } } };
        const r = extractCardScripts(card);
        assert.strictEqual(r.scripts.length, 1);
        assert.strictEqual(r.variables.a, 1);
        const legacy = { extensions: { TavernHelper_scripts: [{ id: 'y', content: '//' }], TavernHelper_characterScriptVariables: { b: 2 } } };
        const r2 = extractCardScripts(legacy);
        assert.strictEqual(r2.scripts[0].id, 'y');
        assert.strictEqual(r2.variables.b, 2);
    });
});

// ==================== 3. agent-api 集成 ====================

function makeDeps(overrides = {}) {
    const tmpDir = overrides.tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'st-scripts-api-'));
    const scriptStore = new ScriptStore(tmpDir);
    const fakeAgentFramework = {
        _loaded: true,
        agentLoader: {
            list: () => [{ name: 'default-rp' }],
            get: () => ({ name: 'default-rp', context: { historyLimit: 20 } }),
            save: () => ({}),
            delete: () => {},
        },
        toolRegistry: { list: () => [] },
        agentRunner: { getLogs: () => [] },
        workspaceManager: { getEvents: () => [] },
        _agentService: {
            run: overrides.run || (async () => ({ runId: 'r1', aborted: false, text: 'ok', result: { toJSON: () => ({}), getMainText: () => 'ok' } })),
            abortRun: () => true,
            getStatus: () => ({}),
            getLastPrompt: () => null,
            getGreetings: () => null,
            getHistoryLimit: () => 20,
        },
    };
    return {
        getPluginManager: () => ({ loader: { getPlugin: (n) => (n === 'agent-framework' ? fakeAgentFramework : null) } }),
        getLlmService: () => ({ chat: async () => '{}' }),
        theatreBroadcaster: {
            addClient: () => {},
            broadcastRunState: () => {},
            broadcastResult: () => {},
            broadcastState: () => {},
            shutdown: () => {},
        },
        configManager: {
            get: (key) => {
                const cfg = overrides.config || {};
                if (key === 'runtime.agentCompat') return cfg.agentCompat || { enabled: false };
                if (key === 'runtime') return cfg.runtime || {};
                return undefined;
            },
        },
        logger: console,
        repoRoot: REPO_ROOT,
        staticDir: path.join(REPO_ROOT, 'public'),
        chatDataRoot: tmpDir,
        scriptStore,
        ...overrides,
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

describe('agent-api 脚本库端点', () => {
    test('scripts CRUD / run / versions / restore 全链路', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scripts-crud-'));
        const deps = makeDeps({ tmpDir });
        await withServer(deps, async (base) => {
            // 新建
            const created = await fetch(`${base}/api/agent-theatre/scripts?session=native:s1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: '测试脚本', content: 'console.log("hi"); __setPipe("done");' }),
            }).then(r => r.json());
            assert.strictEqual(created.success, true);
            const id = created.script.id;
            // 列表
            const list = await fetch(`${base}/api/agent-theatre/scripts?scope=global&session=native:s1`).then(r => r.json());
            assert.strictEqual(list.scripts.length, 1);
            // 更新（留版本）
            const updated = await fetch(`${base}/api/agent-theatre/scripts/${id}?scope=global&session=native:s1`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: '// v2' }),
            }).then(r => r.json());
            assert.strictEqual(updated.script.content, '// v2');
            const vers = await fetch(`${base}/api/agent-theatre/scripts/${id}/versions?scope=global&session=native:s1`).then(r => r.json());
            assert.strictEqual(vers.versions.length, 1);
            // 回滚
            const restored = await fetch(`${base}/api/agent-theatre/scripts/${id}/restore?scope=global&session=native:s1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ts: vers.versions[0].ts }),
            }).then(r => r.json());
            assert.ok(restored.script.content.includes('console.log'));
            // 运行
            const run = await fetch(`${base}/api/agent-theatre/scripts/${id}/run?scope=global&session=native:s1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }).then(r => r.json());
            assert.strictEqual(run.success, true);
            assert.strictEqual(run.result, 'done');
            // 删除
            const del = await fetch(`${base}/api/agent-theatre/scripts/${id}?scope=global&session=native:s1`, { method: 'DELETE' }).then(r => r.json());
            assert.strictEqual(del.success, true);
        });
    });

    test('角色卡加载自动同步 tavern_helper 脚本 + 每轮事件触发写回 stat_data', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scripts-sync-'));
        const charDir = path.join(tmpDir, 'cards');
        fs.mkdirSync(charDir, { recursive: true });
        // 角色卡：含 tavern_helper.scripts（监听 MESSAGE_RECEIVED 计数）
        const card = {
            name: '络络',
            description: '', personality: '', scenario: '', first_mes: '你好', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
            extensions: {
                tavern_helper: {
                    scripts: [{
                        id: 'card-script-1', name: '卡内计数器', enabled: true, content:
                            'eventOn(tavern_events.MESSAGE_RECEIVED, (data) => {' +
                            '  const cur = getVariables({ type: "chat" });' +
                            '  replaceVariables({ ...cur, 轮次: (cur.轮次 || 0) + 1 }, { type: "chat" });' +
                            '});',
                        info: '自动计数', button: { enabled: false, buttons: [] }, data: {}, export_with: { data: true, button: true },
                    }],
                    variables: { 初始好感度: 42 },
                },
            },
            tags: [], creator: '', character_version: '1.0',
        };
        fs.writeFileSync(path.join(charDir, '络络.json'), JSON.stringify(card));
        const deps = makeDeps({
            tmpDir,
            config: { agentCompat: { enabled: false }, runtime: { charactersDir: charDir } },
            run: async () => ({ runId: 'r1', aborted: false, text: 'ok', result: { toJSON: () => ({}), getMainText: () => '正文' } }),
        });
        await withServer(deps, async (base) => {
            // 首轮 /input：角色加载 → 自动同步卡内脚本（安全默认：首次导入强制禁用）
            const r1 = await fetch(`${base}/api/agent-theatre/input?session=native:sync1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: '开始', character: '络络' }),
            }).then(r => r.json());
            assert.strictEqual(r1.success, true);
            // 角色脚本库应已同步卡内脚本，且默认禁用（防加载卡即自动执行不可信脚本）
            const list = await fetch(`${base}/api/agent-theatre/scripts?scope=character&character=络络&session=native:sync1`).then(r => r.json());
            const cardScript = list.scripts.find(s => s.id === 'card-script-1');
            assert.ok(cardScript, '角色卡脚本应自动导入');
            assert.strictEqual(cardScript.enabled, false, '首次导入默认禁用（需手动启用）');
            // 手动启用脚本（用户在小手机脚本 tab 勾选）
            const en = await fetch(`${base}/api/agent-theatre/scripts/card-script-1?scope=character&character=络络&session=native:sync1`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: true }),
            }).then(r => r.json());
            assert.strictEqual(en.success, true);
            // 第二轮：启用后每轮事件触发脚本 → stat_data.轮次 = 1
            await fetch(`${base}/api/agent-theatre/input?session=native:sync1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: '继续', character: '络络' }),
            });
            await new Promise((resolve) => setTimeout(resolve, 300));
            const st = await fetch(`${base}/api/agent-theatre/state?session=native:sync1`).then(r => r.json());
            assert.strictEqual(st.variables.stat_data['轮次'], 1, '启用后每轮事件应触发脚本写回 stat_data');
            // 第三轮：轮次 → 2
            await fetch(`${base}/api/agent-theatre/input?session=native:sync1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: '继续', character: '络络' }),
            });
            await new Promise((resolve) => setTimeout(resolve, 300));
            const st2 = await fetch(`${base}/api/agent-theatre/state?session=native:sync1`).then(r => r.json());
            assert.strictEqual(st2.variables.stat_data['轮次'], 2, '第二轮事件应累加');
        });
    });

    test('scripts/sync 手动同步 + 手动导入', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scripts-imp-'));
        const charDir = path.join(tmpDir, 'cards');
        fs.mkdirSync(charDir, { recursive: true });
        const card = {
            name: '苏苏', description: '', personality: '', scenario: '', first_mes: '嗨', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
            extensions: { tavern_helper: { scripts: [{ id: 'c2', name: '苏苏脚本', content: 'console.log("su");', enabled: true, button: { enabled: true, buttons: [] }, data: {}, export_with: {} }], variables: {} } },
            tags: [], creator: '', character_version: '1.0',
        };
        fs.writeFileSync(path.join(charDir, '苏苏.json'), JSON.stringify(card));
        const deps = makeDeps({ tmpDir, config: { runtime: { charactersDir: charDir } } });
        await withServer(deps, async (base) => {
            // 手动同步
            const sync = await fetch(`${base}/api/agent-theatre/scripts/sync?session=native:imp1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character: '苏苏' }),
            }).then(r => r.json());
            assert.strictEqual(sync.success, true);
            assert.strictEqual(sync.imported, 1);
            // 手动导入（文本）
            const imp = await fetch(`${base}/api/agent-theatre/scripts/import?scope=global&session=native:imp1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: '手动脚本', content: 'console.log(1);' }),
            }).then(r => r.json());
            assert.strictEqual(imp.success, true);
            assert.strictEqual(imp.imported, 1);
        });
    });
});
