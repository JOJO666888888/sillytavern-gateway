/**
 * 用户自定义角色档案（user-profile-store）测试
 *
 * 覆盖：
 *   - store 单测：默认值 / save 合并清洗 / 持久化（新实例读回）/ 损坏文件回退默认 + 备份
 *   - GET/POST /api/user-profile 端点（注入隔离 store，避免污染真实 data 目录）
 *   - ContextBuilder 注入：人设段注入 / {{user}} 宏替换 / session.userName 优先级
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';
import { tmpDir } from './helpers.js';
import { createUserProfileStore } from '../server/runtime/user-profile-store.js';
import { ContextBuilder } from '../server/agent/context-builder.js';
import { registerAgentApi } from '../server/agent-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const tmps = [];
function makeTmp() { const t = tmpDir('stgw-up-'); tmps.push(t); return t.dir; }
after(() => { for (const t of tmps) t.cleanup(); });

// Windows libuv：释放 http server 句柄，防 UV_HANDLE_CLOSING 崩溃（仓库已知问题）
after(async () => { await new Promise(r => setTimeout(r, 1200)); });

// ==================== store 单测 ====================

describe('user-profile-store - 基础行为', () => {
    test('默认值：{ name: "user", persona: "" }（文件不存在）', () => {
        const store = createUserProfileStore({ filePath: path.join(makeTmp(), 'up.json') });
        assert.deepStrictEqual(store.get(), { name: 'user', persona: '' });
    });

    test('get() 返回深拷贝，外部篡改不影响内部态', () => {
        const store = createUserProfileStore({ filePath: path.join(makeTmp(), 'up.json') });
        store.save({ name: '阿星' });
        const a = store.get();
        a.name = '被篡改';
        assert.strictEqual(store.get().name, '阿星');
    });

    test('save 合并更新：只传 name 保留 persona', () => {
        const store = createUserProfileStore({ filePath: path.join(makeTmp(), 'up.json') });
        store.save({ persona: '人设A' });
        const p = store.save({ name: '小明' });
        assert.strictEqual(p.name, '小明');
        assert.strictEqual(p.persona, '人设A', '只更新 name 时 persona 应保留');
        assert.deepStrictEqual(store.get(), { name: '小明', persona: '人设A' });
    });

    test('save 清洗：name 去首尾空白、空回退 user', () => {
        const store = createUserProfileStore({ filePath: path.join(makeTmp(), 'up.json') });
        assert.strictEqual(store.save({ name: '  阿星  ' }).name, '阿星', '去首尾空白');
        assert.strictEqual(store.save({ name: '   ' }).name, 'user', '全空白回退 user');
        assert.strictEqual(store.save({ name: '' }).name, 'user', '空串回退 user');
    });

    test('save 清洗：name 超长截断到 32', () => {
        const store = createUserProfileStore({ filePath: path.join(makeTmp(), 'up.json') });
        const long = '名'.repeat(50);
        const p = store.save({ name: long });
        assert.strictEqual(p.name.length, 32);
        assert.strictEqual(p.name, '名'.repeat(32));
    });

    test('save 清洗：persona 非字符串回退空串、超长截断到 2000', () => {
        const store = createUserProfileStore({ filePath: path.join(makeTmp(), 'up.json') });
        assert.strictEqual(store.save({ persona: 123 }).persona, '', '非字符串回退空串');
        assert.strictEqual(store.save({ persona: null }).persona, '');
        const long = '字'.repeat(2500);
        const p = store.save({ persona: long });
        assert.strictEqual(p.persona.length, 2000, '超长截断到 2000');
    });

    test('持久化：新实例读回已保存配置', () => {
        const file = path.join(makeTmp(), 'up.json');
        const s1 = createUserProfileStore({ filePath: file });
        s1.save({ name: '阿星', persona: '人设内容' });
        const s2 = createUserProfileStore({ filePath: file });
        assert.deepStrictEqual(s2.get(), { name: '阿星', persona: '人设内容' });
    });

    test('损坏文件：回退默认值并生成 .corrupt.<ts> 备份', () => {
        const dir = makeTmp();
        const file = path.join(dir, 'user-profile.json');
        fs.writeFileSync(file, '{{{ not json');
        const store = createUserProfileStore({ filePath: file });
        assert.deepStrictEqual(store.get(), { name: 'user', persona: '' }, '损坏时回退默认值');
        const backups = fs.readdirSync(dir).filter(f => f.startsWith('user-profile.json.corrupt.'));
        assert.ok(backups.length >= 1, '应生成损坏备份文件');
        assert.strictEqual(fs.readFileSync(path.join(dir, backups[0]), 'utf-8'), '{{{ not json', '备份应保留原文件内容');
    });

    test('进程内缓存：save 后 get 立即返回新值，不重复读盘', () => {
        const file = path.join(makeTmp(), 'up.json');
        const store = createUserProfileStore({ filePath: file });
        store.save({ name: 'A' });
        // 绕过 store 直接改盘：缓存未失效时 get 仍返回缓存值（不重复读盘）
        fs.writeFileSync(file, JSON.stringify({ name: 'B', persona: '' }));
        assert.strictEqual(store.get().name, 'A', '缓存生效期间不应重读磁盘');
    });
});

// ==================== 端点测试 ====================

/** 构造 registerAgentApi 的注入依赖（mock pluginManager / llmService） */
function makeDeps(overrides = {}) {
    const fakeAgentFramework = {
        _loaded: true,
        agentLoader: { list: () => [], get: () => null, save: () => ({}), delete: () => {} },
        toolRegistry: { list: () => [] },
        agentRunner: { getLogs: () => [] },
        workspaceManager: { getEvents: () => [] },
        _agentService: {
            run: async () => ({ runId: 'run-1', aborted: false, text: 'ok', result: null }),
            abortRun: () => true,
            getStatus: () => ({ activeAgents: [] }),
            getLastPrompt: () => null,
            getGreetings: () => null,
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

/** 启动临时 HTTP 服务，注入隔离 userProfileStore，回调收到 base URL */
async function withServer(store, fn) {
    const app = express();
    app.use(express.json());
    registerAgentApi(app, makeDeps({ userProfileStore: store }));
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

describe('registerAgentApi - /api/user-profile 端点', () => {
    test('GET 返回默认配置', async () => {
        const store = createUserProfileStore({ filePath: path.join(makeTmp(), 'up.json') });
        await withServer(store, async (base) => {
            const resp = await fetch(`${base}/api/user-profile`);
            assert.strictEqual(resp.status, 200);
            const body = await resp.json();
            assert.strictEqual(body.success, true);
            assert.deepStrictEqual(body.profile, { name: 'user', persona: '' });
        });
    });

    test('POST 后 GET 读回', async () => {
        const store = createUserProfileStore({ filePath: path.join(makeTmp(), 'up.json') });
        await withServer(store, async (base) => {
            const post = await fetch(`${base}/api/user-profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: '阿星', persona: '我是测试人设' }),
            });
            assert.strictEqual(post.status, 200);
            const postBody = await post.json();
            assert.strictEqual(postBody.success, true);
            assert.deepStrictEqual(postBody.profile, { name: '阿星', persona: '我是测试人设' });

            const get = await fetch(`${base}/api/user-profile`);
            const getBody = await get.json();
            assert.deepStrictEqual(getBody.profile, { name: '阿星', persona: '我是测试人设' });
        });
    });

    test('POST 非法值回退默认（空白 name / 非字符串 persona）', async () => {
        const store = createUserProfileStore({ filePath: path.join(makeTmp(), 'up.json') });
        await withServer(store, async (base) => {
            const post = await fetch(`${base}/api/user-profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: '   ', persona: 123 }),
            });
            assert.strictEqual(post.status, 200);
            const postBody = await post.json();
            assert.deepStrictEqual(postBody.profile, { name: 'user', persona: '' }, '非法值应回退默认');

            const get = await fetch(`${base}/api/user-profile`);
            const getBody = await get.json();
            assert.deepStrictEqual(getBody.profile, { name: 'user', persona: '' });
        });
    });

    test('POST 部分字段：只传 persona 保留已有 name', async () => {
        const store = createUserProfileStore({ filePath: path.join(makeTmp(), 'up.json') });
        await withServer(store, async (base) => {
            await fetch(`${base}/api/user-profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: '小明' }),
            });
            const post = await fetch(`${base}/api/user-profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ persona: '新的人设' }),
            });
            const body = await post.json();
            assert.deepStrictEqual(body.profile, { name: '小明', persona: '新的人设' }, '部分更新不应覆盖已有字段');
        });
    });
});

// ==================== ContextBuilder 注入测试 ====================

describe('ContextBuilder - 用户自定义角色注入', () => {
    /** 构造 assetsDir 指向临时目录、注入隔离 userProfileStore 的 builder */
    function makeBuilder(store) {
        const dir = makeTmp();
        return new ContextBuilder({ assetsDir: dir, userProfileStore: store });
    }

    function systemOf(messages) {
        return messages.find(m => m.role === 'system')?.content || '';
    }

    test('提供人设时 system 含 【用户人设】 与 persona 文本', () => {
        const dir = makeTmp();
        const store = createUserProfileStore({ filePath: path.join(dir, 'up.json') });
        store.save({ name: '阿星', persona: '你是我最信任的助手。' });
        const builder = makeBuilder(store);
        const system = systemOf(builder.build(
            { name: 'x', systemPrompt: '系统设定' },
            { platform: 't', chatId: 'p1' },
            [], 'hi',
        ));
        assert.ok(system.includes('【用户人设】'), '应注入【用户人设】段');
        assert.ok(system.includes('你是我最信任的助手。'), '应包含 persona 文本');
    });

    test('未提供人设时 system 不含 【用户人设】 段', () => {
        const dir = makeTmp();
        const store = createUserProfileStore({ filePath: path.join(dir, 'up.json') });
        store.save({ name: '阿星' }); // 只设置 name，不设置 persona
        const builder = makeBuilder(store);
        const system = systemOf(builder.build(
            { name: 'x', systemPrompt: '系统设定' },
            { platform: 't', chatId: 'p2' },
            [], 'hi',
        ));
        assert.ok(!system.includes('【用户人设】'), '无人设时不应注入该段');
    });

    test('{{user}} 宏替换为自定义配置名', () => {
        const dir = makeTmp();
        const store = createUserProfileStore({ filePath: path.join(dir, 'up.json') });
        store.save({ name: '阿星' });
        const builder = makeBuilder(store);
        const system = systemOf(builder.build(
            { name: 'x', systemPrompt: '{{user}} 是主角' },
            { platform: 't', chatId: 'p3' },
            [], 'hi',
        ));
        assert.ok(system.includes('阿星 是主角'), `{{user}} 应替换为配置名，实际: ${system}`);
        assert.ok(!system.includes('{{user}}'), '占位符不应残留');
    });

    test('session.userName 优先于自定义配置名', () => {
        const dir = makeTmp();
        const store = createUserProfileStore({ filePath: path.join(dir, 'up.json') });
        store.save({ name: '阿星' });
        const builder = makeBuilder(store);
        const system = systemOf(builder.build(
            { name: 'x', systemPrompt: '{{user}} 是主角' },
            { platform: 't', chatId: 'p4', userName: 'Master' },
            [], 'hi',
        ));
        assert.ok(system.includes('Master 是主角'), `session.userName 应优先，实际: ${system}`);
        assert.ok(!system.includes('阿星'), '配置名不应覆盖会话级覆盖');
    });

    test('未配置任何档案时 {{user}} 回退默认 user', () => {
        const dir = makeTmp();
        const store = createUserProfileStore({ filePath: path.join(dir, 'up.json') });
        const builder = makeBuilder(store);
        const system = systemOf(builder.build(
            { name: 'x', systemPrompt: '{{user}}' },
            { platform: 't', chatId: 'p5' },
            [], 'hi',
        ));
        assert.strictEqual(system, 'user');
    });
});
