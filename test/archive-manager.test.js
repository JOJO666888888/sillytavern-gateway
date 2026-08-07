/**
 * 多存档管理系统测试（archive-manager）
 *
 * 覆盖：
 *   - createArchive 为角色卡创建空存档（带名称/描述元数据）
 *   - updateArchiveMeta 更新存档名称/描述
 *   - listChats 返回 name/description 元数据
 *   - 数据隔离：删除存档不影响角色卡基础数据与其他存档
 *   - 100 次创建/删除循环稳定性
 *   - API 端点：archive-create / archive-meta
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    createArchive,
    updateArchiveMeta,
    listChats,
    readChat,
    deleteChats,
} from '../server/runtime/chat-store.js';
import { registerAgentApi, stopChatAutoSave } from '../server/agent-api.js';
import { tmpDir, sleep, silentLogger } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const tmps = [];
function makeTmp() {
    const t = tmpDir();
    tmps.push(t);
    return t.dir;
}
after(() => {
    for (const t of tmps) t.cleanup();
    stopChatAutoSave();
});

/** 构造注入依赖（与 chat-store.test.js 同款，精简） */
function makeDeps(dataRoot, overrides = {}) {
    const fakeAgentFramework = {
        _loaded: true,
        agentLoader: { list: () => [], get: () => null, save: () => ({}), delete: () => {}, agentsDir: path.join(dataRoot, 'agents') },
        toolRegistry: { list: () => [] },
        agentRunner: { getLogs: () => [] },
        workspaceManager: { getEvents: () => [] },
        _agentService: {
            run: async () => ({ runId: 'r', aborted: false, text: 'ok', result: null }),
            abortRun: () => true,
            getStatus: () => ({ activeAgents: [] }),
            getLastPrompt: () => null,
            getGreetings: () => null,
        },
    };
    const pluginManager = { loader: { getPlugin: (n) => (n === 'agent-framework' ? fakeAgentFramework : null) } };
    return {
        getPluginManager: () => pluginManager,
        getLlmService: () => ({ chat: async () => '{}' }),
        theatreBroadcaster: { addClient: () => {}, broadcastRunState: () => {}, broadcastResult: () => {}, broadcastState: () => {}, shutdown: () => {} },
        configManager: { get: () => ({}) },
        logger: silentLogger,
        repoRoot: REPO_ROOT,
        staticDir: path.join(REPO_ROOT, 'public'),
        chatDataRoot: dataRoot,
        ...overrides,
    };
}

async function withServer(dataRoot, fn) {
    const app = express();
    app.use(express.json());
    registerAgentApi(app, makeDeps(dataRoot));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await fn(base);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

describe('createArchive 多存档创建', () => {
    test('为角色卡创建命名存档，元数据落盘', () => {
        const root = makeTmp();
        const r = createArchive(root, { character: '清月', name: '主线攻略', description: '第一次主线存档' });
        assert.strictEqual(r.ok, true);
        assert.ok(r.file.includes('清月/'), `file 应含角色目录: ${r.file}`);

        // 读回验证元数据
        const chat = readChat(root, r.file);
        assert.strictEqual(chat.name, '主线攻略');
        assert.strictEqual(chat.description, '第一次主线存档');
        assert.strictEqual(chat.messages.length, 0, '新建存档应为空');
    });

    test('同一角色卡可创建多个独立存档', () => {
        const root = makeTmp();
        const r1 = createArchive(root, { character: '清月', name: '存档A' });
        const r2 = createArchive(root, { character: '清月', name: '存档B' });
        assert.ok(r1.file !== r2.file, '两个存档文件必须不同');
        const list = listChats(root, { pageSize: 50 });
        const mine = list.items.filter((i) => i.character === '清月');
        assert.strictEqual(mine.length, 2, '应列出 2 个存档');
        assert.deepStrictEqual(mine.map((i) => i.name).sort(), ['存档A', '存档B']);
    });

    test('不同角色卡的存档互不干扰（按角色隔离）', () => {
        const root = makeTmp();
        createArchive(root, { character: '清月', name: '清月存档' });
        createArchive(root, { character: '疏影', name: '疏影存档' });
        const qy = listChats(root, { character: '清月' });
        assert.strictEqual(qy.items.length, 1);
        assert.strictEqual(qy.items[0].name, '清月存档');
        const sy = listChats(root, { character: '疏影' });
        assert.strictEqual(sy.items.length, 1);
        assert.strictEqual(sy.items[0].name, '疏影存档');
    });
});

describe('updateArchiveMeta 存档元数据更新', () => {
    test('更新名称/描述后 listChats 反映新值', () => {
        const root = makeTmp();
        const r = createArchive(root, { character: '清月', name: '旧名', description: '旧描述' });
        const upd = updateArchiveMeta(root, r.file, { name: '新名', description: '新描述' });
        assert.strictEqual(upd.ok, true);
        const list = listChats(root, { character: '清月' });
        assert.strictEqual(list.items[0].name, '新名');
        assert.strictEqual(list.items[0].description, '新描述');
    });

    test('更新不存在的存档返回 ok:false', () => {
        const root = makeTmp();
        const upd = updateArchiveMeta(root, '清月/不存在.jsonl', { name: 'x' });
        assert.strictEqual(upd.ok, false);
    });

    test('路径穿越被拒绝', () => {
        const root = makeTmp();
        const upd = updateArchiveMeta(root, '../../etc/passwd', { name: 'x' });
        assert.strictEqual(upd.ok, false);
    });
});

describe('存档删除与角色卡数据安全隔离', () => {
    test('删除单个存档不影响该角色卡的其他存档', () => {
        const root = makeTmp();
        const a1 = createArchive(root, { character: '清月', name: '存档1' });
        const a2 = createArchive(root, { character: '清月', name: '存档2' });
        const a3 = createArchive(root, { character: '清月', name: '存档3' });

        const del = deleteChats(root, [a2.file]);
        assert.strictEqual(del.deleted, 1);

        const remain = listChats(root, { character: '清月' });
        assert.strictEqual(remain.items.length, 2, '其余存档应保留');
        assert.deepStrictEqual(remain.items.map((i) => i.name).sort(), ['存档1', '存档3']);
    });

    test('删除角色卡全部存档后角色卡目录仍存在（基础数据隔离）', () => {
        const root = makeTmp();
        // 模拟角色卡目录（assets/characters 是独立的，这里模拟同 repo 下的资产目录不受影响）
        const charDir = path.join(root, '..', 'assets', 'characters');
        fs.mkdirSync(charDir, { recursive: true });
        const cardFile = path.join(charDir, '清月.png');
        fs.writeFileSync(cardFile, 'FAKE_PNG');

        const a1 = createArchive(root, { character: '清月', name: '存档1' });
        const a2 = createArchive(root, { character: '清月', name: '存档2' });
        deleteChats(root, [a1.file, a2.file]);

        // 存档目录里的角色子目录被删空后，角色卡资产文件必须完好
        assert.strictEqual(fs.existsSync(cardFile), true, '角色卡文件不应受影响');
        assert.strictEqual(fs.readFileSync(cardFile, 'utf-8'), 'FAKE_PNG');
        // 无存档残留
        const remain = listChats(root, { character: '清月' });
        assert.strictEqual(remain.items.length, 0);
    });

    test('存档删除仅作用于 chats 目录（路径穿越防护）', () => {
        const root = makeTmp();
        const victim = path.join(root, '..', 'secret.jsonl');
        fs.writeFileSync(victim, 'secret');
        const del = deleteChats(root, ['../secret.jsonl', '..\\..\\secret.jsonl']);
        assert.strictEqual(del.deleted, 0);
        assert.strictEqual(fs.existsSync(victim), true);
        fs.unlinkSync(victim);
    });
});

describe('100 次创建/删除循环稳定性', () => {
    test('循环 100 次创建+删除存档无异常、无残留', () => {
        const root = makeTmp();
        for (let i = 0; i < 100; i++) {
            const r = createArchive(root, { character: '循环角色', name: `存档${i}` });
            assert.strictEqual(r.ok, true, `第 ${i} 次创建失败`);
            const del = deleteChats(root, [r.file]);
            assert.strictEqual(del.deleted, 1, `第 ${i} 次删除失败`);
        }
        const remain = listChats(root, { character: '循环角色' });
        assert.strictEqual(remain.items.length, 0, '100 次循环后应无残留');
    });
});

describe('多存档 API 端点', () => {
    test('archive-create / archive-meta 端点正常', async () => {
        const root = makeTmp();
        await withServer(root, async (base) => {
            // 创建
            const create = await fetch(`${base}/api/agent-theatre/chats/archive-create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ character: '清月', name: 'API存档', description: 'API创建' }),
            });
            const cj = await create.json();
            assert.strictEqual(create.status, 200);
            assert.strictEqual(cj.success, true);
            assert.ok(cj.file);

            // 更新元数据
            const meta = await fetch(`${base}/api/agent-theatre/chats/archive-meta`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file: cj.file, name: '改名', description: '改描述' }),
            });
            const mj = await meta.json();
            assert.strictEqual(mj.success, true);

            // 列表反映新元数据
            const list = await fetch(`${base}/api/agent-theatre/chats?character=${encodeURIComponent('清月')}`);
            const lj = await list.json();
            assert.strictEqual(lj.items.length, 1);
            assert.strictEqual(lj.items[0].name, '改名');
            assert.strictEqual(lj.items[0].description, '改描述');

            // 存档操作日志已写入
            const logPath = path.join(root, 'archive-ops.log');
            assert.strictEqual(fs.existsSync(logPath), true, '操作日志文件应存在');
            const logText = fs.readFileSync(logPath, 'utf-8');
            assert.ok(logText.includes('"op":"create"'), '日志应含 create 记录');
            assert.ok(logText.includes('"op":"meta"'), '日志应含 meta 记录');
        });
    });

    test('archive-create 缺少角色名时仍可创建（_default 兜底）', async () => {
        const root = makeTmp();
        await withServer(root, async (base) => {
            const create = await fetch(`${base}/api/agent-theatre/chats/archive-create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: '默认存档' }),
            });
            const cj = await create.json();
            assert.strictEqual(create.status, 200);
            assert.strictEqual(cj.success, true);
        });
    });
});
