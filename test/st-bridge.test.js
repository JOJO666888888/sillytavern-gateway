/**
 * ST 兼容前端桥测试（Task 3）
 *
 * 守护 spec.md "Scenario: ST 兼容前端桥" 与 PROTOTYPE.md §3.5：
 *   - 资产读写（角色卡 / 聊天存档 / 预设 / 世界书）复用网关资产目录
 *   - 路径穿越防护：_safeName 拒绝 ../ 与路径分隔符
 *   - /api/generate 双模式：Agent 模式（agentService.run）vs 非 Agent 模式（nativeRuntime.generate）
 *   - ST 启动桩：/api/settings 与 /csrf-token 返回最小可启动结构
 *
 * 不启动真实 HTTP 服务，直接调用 createStShim 返回的处理函数，用 mock req/res。
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import { createStShim } from '../server/compat/st-shim.js';
import { AgentRunResult } from '../server/agent/run-result.js';
import { tmpDir, silentLogger, buildCharacterPng } from './helpers.js';

// ==================== mock req/res ====================

/**
 * 构造 mock Express req。
 * @param {object} opts - { params, query, body }
 */
function mockReq(opts = {}) {
    return {
        params: opts.params || {},
        query: opts.query || {},
        body: opts.body || {},
    };
}

/**
 * 构造 mock Express res，捕获 status/json/send。
 * 链式调用兼容 res.status().json()。
 */
function mockRes() {
    const res = {
        statusCode: 200,
        _json: null,
        _sent: false,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        json(body) { this._json = body; this._sent = true; return this; },
        send(body) { this._json = body; this._sent = true; return this; },
        type(t) { this.headers['Content-Type'] = t; return this; },
        setHeader(k, v) { this.headers[k] = v; return this; },
    };
    return res;
}

// ==================== 共享夹具 ====================

let dir;
let cleanupFn;

function setupDirs() {
    const t = tmpDir('stgw-st-bridge-');
    dir = t.dir;
    cleanupFn = t.cleanup;
    // 预置资产
    fs.mkdirSync(path.join(dir, 'characters'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'worldbooks'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'chats'), { recursive: true });
}

function teardownDirs() {
    if (cleanupFn) cleanupFn();
    dir = null;
    cleanupFn = null;
}

/** 构造一个最小角色卡 JSON（ST V2 嵌套结构） */
function sampleCard(name) {
    return {
        spec: 'chara_card_v2',
        data: {
            name,
            description: '测试角色',
            personality: '冷静',
            scenario: '测试场景',
            first_mes: '你好',
            mes_example: '',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            character_book: null,
            tags: [],
            creator: 'test',
            character_version: '1.0',
            creator_notes: '',
            extensions: {},
        },
    };
}

// ==================== 测试 ====================

describe('ST Shim - 资产读写', () => {
    beforeEach(setupDirs);
    afterEach(teardownDirs);

    test('writeCharacter + getCharacter + listCharacters 闭环', async () => {
        const shim = createStShim({ dirs: { characters: path.join(dir, 'characters') }, logger: silentLogger });

        // 写入
        const writeRes = mockRes();
        await shim.writeCharacter(mockReq({ body: sampleCard('Alice') }), writeRes);
        assert.strictEqual(writeRes.statusCode, 200);
        assert.strictEqual(writeRes._json.name, 'Alice');
        // 文件确实落盘
        assert.ok(fs.existsSync(path.join(dir, 'characters', 'Alice.json')));

        // 列表
        const listRes = mockRes();
        await shim.listCharacters(mockReq(), listRes);
        assert.strictEqual(listRes.statusCode, 200);
        assert.ok(Array.isArray(listRes._json));
        assert.strictEqual(listRes._json[0].name, 'Alice');
        assert.strictEqual(listRes._json[0].avatar, 'Alice');

        // 读取
        const getRes = mockRes();
        await shim.getCharacter(mockReq({ params: { name: 'Alice' } }), getRes);
        assert.strictEqual(getRes.statusCode, 200);
        assert.strictEqual(getRes._json.spec, 'chara_card_v2');
        assert.strictEqual(getRes._json.data.name, 'Alice');
        assert.strictEqual(getRes._json.data.first_mes, '你好');
    });

    test('getCharacter 支持读取 PNG 角色卡', async () => {
        const charactersDir = path.join(dir, 'characters');
        // 写入一个 PNG 角色卡
        const pngBuf = buildCharacterPng({ name: 'PngHero', description: 'PNG角色', first_mes: '嗨' });
        fs.writeFileSync(path.join(charactersDir, 'PngHero.png'), pngBuf);

        const shim = createStShim({ dirs: { characters: charactersDir }, logger: silentLogger });
        const getRes = mockRes();
        await shim.getCharacter(mockReq({ params: { name: 'PngHero' } }), getRes);
        assert.strictEqual(getRes.statusCode, 200);
        assert.strictEqual(getRes._json.data.name, 'PngHero');
    });

    test('getCharacter 不存在返回 404', async () => {
        const shim = createStShim({ dirs: { characters: path.join(dir, 'characters') }, logger: silentLogger });
        const getRes = mockRes();
        await shim.getCharacter(mockReq({ params: { name: 'Nobody' } }), getRes);
        assert.strictEqual(getRes.statusCode, 404);
    });

    test('writeCharacter 缺少 name 返回 400', async () => {
        const shim = createStShim({ dirs: { characters: path.join(dir, 'characters') }, logger: silentLogger });
        const writeRes = mockRes();
        await shim.writeCharacter(mockReq({ body: { spec: 'chara_card_v2', data: {} } }), writeRes);
        assert.strictEqual(writeRes.statusCode, 400);
    });

    test('listCharacters 空目录返回空数组', async () => {
        const shim = createStShim({ dirs: { characters: path.join(dir, 'characters') }, logger: silentLogger });
        const listRes = mockRes();
        await shim.listCharacters(mockReq(), listRes);
        assert.strictEqual(listRes.statusCode, 200);
        assert.deepStrictEqual(listRes._json, []);
    });
});

describe('ST Shim - 路径穿越防护', () => {
    beforeEach(setupDirs);
    afterEach(teardownDirs);

    test('getCharacter 拒绝 ../ 穿越尝试', async () => {
        const shim = createStShim({ dirs: { characters: path.join(dir, 'characters') }, logger: silentLogger });
        const res = mockRes();
        await shim.getCharacter(mockReq({ params: { name: '../../../etc/passwd' } }), res);
        assert.strictEqual(res.statusCode, 400);
        assert.match(res._json.error, /非法/);
    });

    test('getCharacter 拒绝路径分隔符', async () => {
        const shim = createStShim({ dirs: { characters: path.join(dir, 'characters') }, logger: silentLogger });
        const res1 = mockRes();
        await shim.getCharacter(mockReq({ params: { name: 'foo/bar' } }), res1);
        assert.strictEqual(res1.statusCode, 400);

        const res2 = mockRes();
        await shim.getCharacter(mockReq({ params: { name: 'foo\\bar' } }), res2);
        assert.strictEqual(res2.statusCode, 400);
    });

    test('readChat 拒绝恶意 fileId', async () => {
        const shim = createStShim({ dirs: { chats: path.join(dir, 'chats') }, logger: silentLogger });
        const res = mockRes();
        await shim.readChat(mockReq({ params: { characterName: 'Alice', fileId: '../../secret' } }), res);
        assert.strictEqual(res.statusCode, 400);
    });

    test('writeCharacter 拒绝恶意 name（不落盘到目录外）', async () => {
        const shim = createStShim({ dirs: { characters: path.join(dir, 'characters') }, logger: silentLogger });
        const res = mockRes();
        await shim.writeCharacter(mockReq({ body: { data: { name: '../evil' } } }), res);
        assert.strictEqual(res.statusCode, 400);
        // 确认没有在目录外创建文件
        assert.ok(!fs.existsSync(path.join(dir, 'evil.json')));
    });

    test('合法含点号的角色名（如 v1.2）被放行', async () => {
        const shim = createStShim({ dirs: { characters: path.join(dir, 'characters') }, logger: silentLogger });
        const writeRes = mockRes();
        await shim.writeCharacter(mockReq({ body: sampleCard('Hero.v1.2') }), writeRes);
        assert.strictEqual(writeRes.statusCode, 200);
        const getRes = mockRes();
        await shim.getCharacter(mockReq({ params: { name: 'Hero.v1.2' } }), getRes);
        assert.strictEqual(getRes.statusCode, 200);
        assert.strictEqual(getRes._json.data.name, 'Hero.v1.2');
    });
});

describe('ST Shim - 聊天存档', () => {
    beforeEach(setupDirs);
    afterEach(teardownDirs);

    test('writeChat + readChat + listChats 闭环', async () => {
        const shim = createStShim({ dirs: { chats: path.join(dir, 'chats') }, logger: silentLogger });

        // 写入
        const messages = [
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '你好啊' },
        ];
        const writeRes = mockRes();
        await shim.writeChat(mockReq({
            params: { characterName: 'Alice', fileId: 'chat1' },
            body: { messages },
        }), writeRes);
        assert.strictEqual(writeRes.statusCode, 200);
        assert.ok(fs.existsSync(path.join(dir, 'chats', 'Alice', 'chat1.jsonl')));

        // 列表
        const listRes = mockRes();
        await shim.listChats(mockReq({ params: { characterName: 'Alice' } }), listRes);
        assert.strictEqual(listRes.statusCode, 200);
        assert.ok(Array.isArray(listRes._json));
        assert.ok(listRes._json.includes('chat1'));

        // 读取
        const readRes = mockRes();
        await shim.readChat(mockReq({ params: { characterName: 'Alice', fileId: 'chat1' } }), readRes);
        assert.strictEqual(readRes.statusCode, 200);
        assert.strictEqual(readRes._json.file_name, 'chat1');
        assert.strictEqual(readRes._json.messages.length, 2);
        assert.strictEqual(readRes._json.messages[0].content, '你好');
    });

    test('readChat 不存在返回 404', async () => {
        const shim = createStShim({ dirs: { chats: path.join(dir, 'chats') }, logger: silentLogger });
        const res = mockRes();
        await shim.readChat(mockReq({ params: { characterName: 'Alice', fileId: 'nope' } }), res);
        assert.strictEqual(res.statusCode, 404);
    });

    test('writeChat 接受数组形式 body', async () => {
        const shim = createStShim({ dirs: { chats: path.join(dir, 'chats') }, logger: silentLogger });
        const res = mockRes();
        await shim.writeChat(mockReq({
            params: { characterName: 'Bob', fileId: 'c1' },
            body: [{ role: 'user', content: 'hi' }],
        }), res);
        assert.strictEqual(res.statusCode, 200);
        // 文件内容应为合法 JSONL
        const content = fs.readFileSync(path.join(dir, 'chats', 'Bob', 'c1.jsonl'), 'utf-8');
        assert.ok(content.includes('"hi"'));
    });

    test('listChats 空角色目录返回空数组', async () => {
        const shim = createStShim({ dirs: { chats: path.join(dir, 'chats') }, logger: silentLogger });
        const res = mockRes();
        await shim.listChats(mockReq({ params: { characterName: 'Ghost' } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res._json, []);
    });
});

describe('ST Shim - 预设 & 世界书', () => {
    beforeEach(setupDirs);
    afterEach(teardownDirs);

    test('listPresets + getPreset 闭环', async () => {
        const presetsDir = path.join(dir, 'presets');
        fs.writeFileSync(path.join(presetsDir, 'myPreset.json'), JSON.stringify({ temperature: 0.8 }));

        const shim = createStShim({ dirs: { presets: presetsDir }, logger: silentLogger });

        const listRes = mockRes();
        await shim.listPresets(mockReq(), listRes);
        assert.strictEqual(listRes.statusCode, 200);
        assert.ok(listRes._json.includes('myPreset'));

        const getRes = mockRes();
        await shim.getPreset(mockReq({ params: { name: 'myPreset' } }), getRes);
        assert.strictEqual(getRes.statusCode, 200);
        assert.strictEqual(getRes._json.temperature, 0.8);
    });

    test('getPreset 不存在返回 404', async () => {
        const shim = createStShim({ dirs: { presets: path.join(dir, 'presets') }, logger: silentLogger });
        const res = mockRes();
        await shim.getPreset(mockReq({ params: { name: 'none' } }), res);
        assert.strictEqual(res.statusCode, 404);
    });

    test('listWorldbooks + getWorldbook 闭环', async () => {
        const wbDir = path.join(dir, 'worldbooks');
        fs.writeFileSync(path.join(wbDir, 'lore.json'), JSON.stringify({ entries: [] }));

        const shim = createStShim({ dirs: { worldbooks: wbDir }, logger: silentLogger });

        const listRes = mockRes();
        await shim.listWorldbooks(mockReq(), listRes);
        assert.strictEqual(listRes.statusCode, 200);
        assert.ok(listRes._json.includes('lore'));

        const getRes = mockRes();
        await shim.getWorldbook(mockReq({ params: { name: 'lore' } }), getRes);
        assert.strictEqual(getRes.statusCode, 200);
        assert.deepStrictEqual(getRes._json.entries, []);
    });

    test('getWorldbook 拒绝路径穿越', async () => {
        const shim = createStShim({ dirs: { worldbooks: path.join(dir, 'worldbooks') }, logger: silentLogger });
        const res = mockRes();
        await shim.getWorldbook(mockReq({ params: { name: '../secret' } }), res);
        assert.strictEqual(res.statusCode, 400);
    });
});

describe('ST Shim - /api/generate Agent 模式', () => {
    beforeEach(setupDirs);
    afterEach(teardownDirs);

    test('Agent 模式调用 agentService.run 并返回 ST 兼容 message', async () => {
        // mock agentService.run 返回 AgentRunResult
        const fakeResult = AgentRunResult.fromRunResult('Agent 回复内容', 2, 'run-123', { style: '文风A' });
        fakeResult.addOption({ label: '选项1', text: '前进' });
        const agentService = {
            run: async (_profile, _input, _session, _ctx) => ({
                runId: 'run-123',
                result: fakeResult,
                text: 'Agent 回复内容',
            }),
        };
        const llmService = { runTools: async () => ({}) };
        const shim = createStShim({
            dirs: { characters: path.join(dir, 'characters') },
            agentService,
            llmService,
            logger: silentLogger,
        });

        const res = mockRes();
        await shim.generate(mockReq({
            body: {
                agentMode: true,
                prompt: '你好',
                character_name: 'Alice',
                chat: 'st:Alice',
            },
        }), res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res._json.message, 'Agent 回复内容');
        assert.ok(Array.isArray(res._json.results));
        assert.strictEqual(res._json.results[0].message, 'Agent 回复内容');
        assert.strictEqual(res._json._agentMeta.runId, 'run-123');
        assert.strictEqual(res._json._agentMeta.options.length, 1);
    });

    test('Agent 模式无 agentService 返回 503', async () => {
        const shim = createStShim({
            dirs: { characters: path.join(dir, 'characters') },
            agentService: null,
            llmService: { runTools: async () => ({}) },
            logger: silentLogger,
        });
        const res = mockRes();
        await shim.generate(mockReq({ body: { agentMode: true, prompt: 'hi' } }), res);
        assert.strictEqual(res.statusCode, 503);
        assert.match(res._json.error, /agent-framework/);
    });

    test('Agent 模式无 llmService 返回 503', async () => {
        const shim = createStShim({
            dirs: { characters: path.join(dir, 'characters') },
            agentService: { run: async () => ({}) },
            llmService: null,
            logger: silentLogger,
        });
        const res = mockRes();
        await shim.generate(mockReq({ body: { agentMode: true, prompt: 'hi' } }), res);
        assert.strictEqual(res.statusCode, 503);
        assert.match(res._json.error, /runtime\.llm/);
    });

    test('Agent 模式从 messages 提取最后一条 user 消息作为 input', async () => {
        let capturedInput = '';
        const agentService = {
            run: async (_profile, input) => {
                capturedInput = input;
                return { runId: 'r1', result: AgentRunResult.fromRunResult('ok', 0, 'r1'), text: 'ok' };
            },
        };
        const shim = createStShim({
            dirs: { characters: path.join(dir, 'characters') },
            agentService,
            llmService: { runTools: async () => ({}) },
            logger: silentLogger,
        });
        const res = mockRes();
        await shim.generate(mockReq({
            body: {
                agentMode: true,
                messages: [
                    { role: 'system', content: '系统提示' },
                    { role: 'user', content: '第一句' },
                    { role: 'assistant', content: '回复' },
                    { role: 'user', content: '最新一句' },
                ],
            },
        }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(capturedInput, '最新一句');
    });

    test('config.runtime.agentMode=true 全局开关生效（无需请求体 agentMode）', async () => {
        const agentService = {
            run: async () => ({ runId: 'r1', result: AgentRunResult.fromRunResult('ok', 0, 'r1'), text: 'ok' }),
        };
        const configManager = { get: (k) => k === 'runtime.agentMode' ? true : undefined };
        const shim = createStShim({
            dirs: { characters: path.join(dir, 'characters') },
            agentService,
            llmService: { runTools: async () => ({}) },
            configManager,
            logger: silentLogger,
        });
        const res = mockRes();
        await shim.generate(mockReq({ body: { prompt: 'hi' } }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res._json.message, 'ok');
    });

    test('Agent run 抛错返回 500', async () => {
        const agentService = {
            run: async () => { throw new Error('LLM 爆炸'); },
        };
        const shim = createStShim({
            dirs: { characters: path.join(dir, 'characters') },
            agentService,
            llmService: { runTools: async () => ({}) },
            logger: silentLogger,
        });
        const res = mockRes();
        await shim.generate(mockReq({ body: { agentMode: true, prompt: 'hi' } }), res);
        assert.strictEqual(res.statusCode, 500);
        assert.match(res._json.error, /LLM 爆炸/);
    });
});

describe('ST Shim - /api/generate 非 Agent 模式', () => {
    beforeEach(setupDirs);
    afterEach(teardownDirs);

    test('非 Agent 模式透传 nativeRuntime.generate', async () => {
        let capturedArgs = {};
        const nativeRuntime = {
            generate: async (platform, chatId, input, opts) => {
                capturedArgs = { platform, chatId, input, opts };
                return '原生管线回复';
            },
        };
        const shim = createStShim({
            dirs: { characters: path.join(dir, 'characters') },
            nativeRuntime,
            logger: silentLogger,
        });
        const res = mockRes();
        await shim.generate(mockReq({
            body: { agentMode: false, prompt: '你好', character_name: 'Alice', chat: 'st:Alice' },
        }), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res._json.message, '原生管线回复');
        assert.strictEqual(capturedArgs.platform, 'st');
        assert.strictEqual(capturedArgs.chatId, 'st:Alice');
        assert.strictEqual(capturedArgs.input, '你好');
    });

    test('非 Agent 模式无 nativeRuntime 返回 503', async () => {
        const shim = createStShim({
            dirs: { characters: path.join(dir, 'characters') },
            nativeRuntime: null,
            logger: silentLogger,
        });
        const res = mockRes();
        await shim.generate(mockReq({ body: { agentMode: false, prompt: 'hi' } }), res);
        assert.strictEqual(res.statusCode, 503);
        assert.match(res._json.error, /runtime\.enabled/);
    });
});

describe('ST Shim - 启动桩', () => {
    test('getSettings 返回最小可启动结构', async () => {
        const shim = createStShim({ dirs: {}, logger: silentLogger });
        const res = mockRes();
        await shim.getSettings(mockReq(), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res._json.user_name, 'User');
        assert.strictEqual(res._json._gateway, true);
        // ST 启动必需字段存在
        assert.ok('preset' in res._json);
        assert.ok('temperature' in res._json);
        assert.ok('st_extension_settings' in res._json);
    });

    test('getCsrfToken 返回固定 token', async () => {
        const shim = createStShim({ dirs: {}, logger: silentLogger });
        const res = mockRes();
        await shim.getCsrfToken(mockReq(), res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res._json.token);
        assert.strictEqual(typeof res._json.token, 'string');
    });
});

describe('ST Shim - 资产目录自动创建', () => {
    test('首次访问自动创建资产目录', () => {
        const t = tmpDir('stgw-st-bridge-auto-');
        try {
            const charactersDir = path.join(t.dir, 'characters');
            assert.ok(!fs.existsSync(charactersDir));
            // 构造 createStShim 时会 ensureDir
            createStShim({ dirs: { characters: charactersDir }, logger: silentLogger });
            assert.ok(fs.existsSync(charactersDir));
        } finally {
            t.cleanup();
        }
    });
});
