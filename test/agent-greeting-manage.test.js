/**
 * Agent 剧场开场白管理功能测试（编辑 / 新建 / 删除）
 *
 * 守护核心不变量：
 *   1. saveGreeting 编辑内置开场白：greetings 列表更新，原始角色卡文件绝不被修改
 *   2. addGreeting 新建模板：自动追加到 greetings 末尾（进入首楼切换机制）
 *   3. deleteGreeting 删除：从切换列表移除（内置项仅隐藏，角色卡文件不变）
 *   4. 校验：空文本 / 超长 / 非法索引均返回错误，不产生半写状态
 *   5. HTTP 端点：GET greetings + POST save/add/delete 全链路正确，错误响应含信息
 *
 * 测试方式：
 *   - 存储层：真实 ContextBuilder + 临时 assetsDir/dataDir（隔离，不触碰仓库 data）
 *   - HTTP 层：复用 agent-message-edit.test.js 同款 makeDeps/withServer 基建
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerAgentApi } from '../server/agent-api.js';
import { ContextBuilder } from '../server/agent/context-builder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const tmps = [];
function makeTmp() {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'stgw-greet-'));
    tmps.push(t);
    return t;
}
after(() => { for (const t of tmps) fs.rmSync(t, { recursive: true, force: true }); });

/** 构造完整 V2 角色卡 JSON fixture（3 条内置开场白） */
function fullCardJson(overrides = {}) {
    return {
        spec: 'chara_card_v2',
        data: {
            name: '开场测试角',
            description: '开场白管理测试角色。',
            first_mes: '内置开场一',
            alternate_greetings: ['内置开场二', '内置开场三'],
            ...overrides,
        },
    };
}

/** 构造 ContextBuilder（assetsDir + dataDir 均指向临时目录，完全隔离） */
function makeBuilder() {
    const dir = makeTmp();
    fs.mkdirSync(path.join(dir, 'characters'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    const builder = new ContextBuilder({ assetsDir: dir, dataDir: path.join(dir, 'data') });
    return { dir, builder };
}

/** 读取角色卡原始 JSON 内容（用于断言"角色卡文件未被修改"） */
function readCardRaw(dir, name = '开场测试角') {
    return fs.readFileSync(path.join(dir, 'characters', `${name}.json`), 'utf-8');
}

// ==================== 存储层：saveGreeting / addGreeting / deleteGreeting ====================

describe('存储层 - 开场白编辑（ContextBuilder）', () => {
    test('saveGreeting 编辑内置开场白：列表更新，角色卡文件不被修改', () => {
        const { dir, builder } = makeBuilder();
        const rawBefore = JSON.stringify(fullCardJson());
        fs.writeFileSync(path.join(dir, 'characters', '开场测试角.json'), rawBefore);

        const r = builder.saveGreeting('开场测试角', 1, '内置开场二（已编辑）');
        assert.ok(r.ok, `编辑应成功: ${r.error || ''}`);
        assert.deepStrictEqual(r.greetings, ['内置开场一', '内置开场二（已编辑）', '内置开场三']);

        // 角色卡文件保持原样（编辑绝不写回卡片）
        assert.strictEqual(readCardRaw(dir), rawBefore, '角色卡 JSON 必须逐字节不变');
        // 存储文件存在且含覆盖
        const store = JSON.parse(fs.readFileSync(
            path.join(dir, 'data', 'greetings', '开场测试角.json'), 'utf-8'));
        assert.strictEqual(store.overrides[1].text, '内置开场二（已编辑）');
        assert.strictEqual(store.overrides[1].hidden, false);
    });

    test('saveGreeting 编辑自定义开场白（index >= builtinCount）', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(path.join(dir, 'characters', '开场测试角.json'), JSON.stringify(fullCardJson()));
        builder.addGreeting('开场测试角', '自定义A');

        const r = builder.saveGreeting('开场测试角', 3, '自定义A（改）');
        assert.ok(r.ok);
        assert.deepStrictEqual(r.greetings, ['内置开场一', '内置开场二', '内置开场三', '自定义A（改）']);
    });

    test('addGreeting 新建模板：追加到末尾并进入切换列表（builtinCount 不变）', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(path.join(dir, 'characters', '开场测试角.json'), JSON.stringify(fullCardJson()));

        const list0 = builder.getGreetingList('开场测试角');
        assert.strictEqual(list0.builtinCount, 3, '内置条数 = first_mes + 2 个备用');

        const r = builder.addGreeting('开场测试角', '全新的自定义开场白');
        assert.ok(r.ok, `新建应成功: ${r.error || ''}`);
        assert.deepStrictEqual(r.greetings, ['内置开场一', '内置开场二', '内置开场三', '全新的自定义开场白']);

        const list1 = builder.getGreetingList('开场测试角');
        assert.strictEqual(list1.greetings.length, 4);
        assert.strictEqual(list1.greetings[3], '全新的自定义开场白', '自定义应排在末尾');
        assert.strictEqual(list1.builtinCount, 3, '内置条数不应因新建而变化');
    });

    test('deleteGreeting 删除内置项：仅隐藏，角色卡文件不变，索引稳定', () => {
        const { dir, builder } = makeBuilder();
        const rawBefore = JSON.stringify(fullCardJson());
        fs.writeFileSync(path.join(dir, 'characters', '开场测试角.json'), rawBefore);

        const r = builder.deleteGreeting('开场测试角', 1);
        assert.ok(r.ok);
        assert.deepStrictEqual(r.greetings, ['内置开场一', '内置开场三'], '内置二应被移除');

        assert.strictEqual(readCardRaw(dir), rawBefore, '角色卡 JSON 必须逐字节不变');
        const store = JSON.parse(fs.readFileSync(
            path.join(dir, 'data', 'greetings', '开场测试角.json'), 'utf-8'));
        assert.strictEqual(store.overrides[1].hidden, true, '内置项应以 hidden 标记而非删除');
        // 再次编辑该索引仍定位到内置二（索引稳定）
        const r2 = builder.saveGreeting('开场测试角', 1, '内置二复活');
        assert.ok(r2.ok);
        assert.deepStrictEqual(r2.greetings, ['内置开场一', '内置二复活', '内置开场三']);
    });

    test('deleteGreeting 删除自定义项：从列表移除', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(path.join(dir, 'characters', '开场测试角.json'), JSON.stringify(fullCardJson()));
        builder.addGreeting('开场测试角', '自定义A');
        builder.addGreeting('开场测试角', '自定义B');

        const r = builder.deleteGreeting('开场测试角', 3); // 索引 3 = 自定义A
        assert.ok(r.ok);
        assert.deepStrictEqual(r.greetings, ['内置开场一', '内置开场二', '内置开场三', '自定义B']);
    });

    test('校验：空文本 / 非文本 / 超长 / 非法索引均返回错误且不写存储', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(path.join(dir, 'characters', '开场测试角.json'), JSON.stringify(fullCardJson()));

        const errEmpty = builder.saveGreeting('开场测试角', 0, '   ');
        assert.strictEqual(errEmpty.ok, false);
        assert.match(errEmpty.error, /不能为空/);

        const errNonStr = builder.addGreeting('开场测试角', 12345);
        assert.strictEqual(errNonStr.ok, false);
        assert.match(errNonStr.error, /文本/);

        const errLong = builder.saveGreeting('开场测试角', 0, 'x'.repeat(5001));
        assert.strictEqual(errLong.ok, false);
        assert.match(errLong.error, /5000/);

        const errIdx = builder.deleteGreeting('开场测试角', -1);
        assert.strictEqual(errIdx.ok, false);
        assert.match(errIdx.error, /序号无效/);

        const errIdx2 = builder.saveGreeting('开场测试角', 'abc', '文本');
        assert.strictEqual(errIdx2.ok, false);
        assert.match(errIdx2.error, /序号无效/);

        // 上述失败均不应产生存储文件
        const storePath = path.join(dir, 'data', 'greetings', '开场测试角.json');
        assert.strictEqual(fs.existsSync(storePath), false, '校验失败不得落盘');
    });

    test('getGreetingList 空卡返回 null；正常卡含 builtinCount', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(path.join(dir, 'characters', '开场测试角.json'), JSON.stringify(fullCardJson()));

        assert.strictEqual(builder.getGreetingList('不存在卡'), null);
        const list = builder.getGreetingList('开场测试角');
        assert.strictEqual(list.builtinCount, 3);
        assert.strictEqual(list.character, '开场测试角');
    });
});

// ==================== HTTP 层：greetings 查询 + save/add/delete 端点 ====================

/** 构造依赖：_agentService 的 greeting 方法指向真实 ContextBuilder（临时目录隔离） */
function makeDeps(overrides = {}) {
    const builderState = makeBuilder();
    fs.writeFileSync(path.join(builderState.dir, 'characters', '开场测试角.json'), JSON.stringify(fullCardJson()));
    const cb = builderState.builder;
    const fakeAgentFramework = {
        _loaded: true,
        agentLoader: {
            list: () => [{ name: 'default-rp', displayName: '默认方案', tools: [] }],
            get: (name) => (name === 'default-rp' ? { name: 'default-rp', displayName: '默认方案' } : null),
            save: (name, yaml) => ({ name, displayName: name, savedYaml: yaml }),
            delete: () => {},
        },
        toolRegistry: { list: () => [] },
        agentRunner: { getLogs: () => [] },
        workspaceManager: { getEvents: () => [] },
        _agentService: {
            run: overrides.run || (async () => ({ runId: 'run-1', aborted: false, text: 'ok', result: null })),
            abortRun: () => true,
            getStatus: () => ({ activeAgents: [] }),
            getLastPrompt: () => null,
            getGreetings: (name) => cb.getGreetingList(name),
            saveGreeting: (name, index, text) => cb.saveGreeting(name, index, text),
            addGreeting: (name, text) => cb.addGreeting(name, text),
            deleteGreeting: (name, index) => cb.deleteGreeting(name, index),
        },
    };
    const pluginManager = {
        loader: { getPlugin: (name) => (name === 'agent-framework' ? fakeAgentFramework : null) },
    };
    return {
        getPluginManager: () => pluginManager,
        getLlmService: () => ({ chat: async () => '{}' }),
        theatreBroadcaster: {
            addClient: () => {},
            broadcastRunState: () => {},
            broadcastResult: () => {},
            broadcastState: () => {},
            shutdown: () => {},
        },
        configManager: { get: () => ({}) },
        logger: console,
        repoRoot: REPO_ROOT,
        staticDir: path.join(REPO_ROOT, 'public'),
        ...overrides,
    };
}

/** 启动临时 HTTP 服务，跑完自动关闭 */
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

describe('HTTP 层 - 开场白管理端点', () => {
    test('GET greetings 返回内置开场白列表 + builtinCount', async () => {
        await withServer(makeDeps(), async (base) => {
            const resp = await fetch(`${base}/api/agent-theatre/greetings?character=${encodeURIComponent('开场测试角')}`);
            assert.strictEqual(resp.status, 200);
            const data = await resp.json();
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.character, '开场测试角');
            assert.deepStrictEqual(data.greetings, ['内置开场一', '内置开场二', '内置开场三']);
            assert.strictEqual(data.builtinCount, 3);
        });
    });

    test('GET greetings 未指定角色卡返回空列表（仍 success）', async () => {
        await withServer(makeDeps(), async (base) => {
            const resp = await fetch(`${base}/api/agent-theatre/greetings`);
            const data = await resp.json();
            assert.strictEqual(data.success, true);
            assert.deepStrictEqual(data.greetings, []);
        });
    });

    test('POST save 编辑内置开场白并返回最新列表', async () => {
        await withServer(makeDeps(), async (base) => {
            const resp = await fetch(`${base}/api/agent-theatre/greetings/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character: '开场测试角', index: 0, text: '内置开场一（改）' }),
            });
            assert.strictEqual(resp.status, 200);
            const data = await resp.json();
            assert.strictEqual(data.success, true);
            assert.deepStrictEqual(data.greetings, ['内置开场一（改）', '内置开场二', '内置开场三']);
        });
    });

    test('POST add 新建开场白：追加到末尾', async () => {
        await withServer(makeDeps(), async (base) => {
            const resp = await fetch(`${base}/api/agent-theatre/greetings/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character: '开场测试角', text: '新开场白模板' }),
            });
            assert.strictEqual(resp.status, 200);
            const data = await resp.json();
            assert.strictEqual(data.success, true);
            assert.deepStrictEqual(data.greetings, ['内置开场一', '内置开场二', '内置开场三', '新开场白模板']);
        });
    });

    test('POST delete 删除开场白并从列表移除', async () => {
        await withServer(makeDeps(), async (base) => {
            const resp = await fetch(`${base}/api/agent-theatre/greetings/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character: '开场测试角', index: 2 }),
            });
            assert.strictEqual(resp.status, 200);
            const data = await resp.json();
            assert.strictEqual(data.success, true);
            assert.deepStrictEqual(data.greetings, ['内置开场一', '内置开场二']);
        });
    });

    test('校验失败返回 400 与错误信息（空文本 / 缺角色卡）', async () => {
        await withServer(makeDeps(), async (base) => {
            // 空文本
            const r1 = await fetch(`${base}/api/agent-theatre/greetings/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character: '开场测试角', text: '   ' }),
            });
            assert.strictEqual(r1.status, 400);
            const d1 = await r1.json();
            assert.strictEqual(d1.success, false);
            assert.match(d1.error, /不能为空/);

            // 缺角色卡
            const r2 = await fetch(`${base}/api/agent-theatre/greetings/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index: 0, text: 'x' }),
            });
            assert.strictEqual(r2.status, 400);
            const d2 = await r2.json();
            assert.match(d2.error, /角色卡/);

            // 越界索引（合并列表之外）也应被服务端拦截
            const r3 = await fetch(`${base}/api/agent-theatre/greetings/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character: '开场测试角', index: 999 }),
            });
            assert.strictEqual(r3.status, 400);
            const d3 = await r3.json();
            assert.strictEqual(d3.success, false);
        });
    });
});
