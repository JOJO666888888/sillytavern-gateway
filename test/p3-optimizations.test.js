/**
 * P3-3：本优化计划（P0-P2）新增行为的回归测试。
 *
 * 覆盖：
 *   1. option-utils：选项提取 / 中文数字（P1-1）
 *   2. AgentRunner：正文选项填充 result.options + agent_event 实时回调（P1-1/P1-2）
 *   3. character-tools：character.read / worldbook.search（P0-1）
 *   4. MemoryEngine：summaryInterval 0 保持禁用（P1-4）
 *   5. ChatArchive：mtime 追踪（P2-2）
 *   6. redactPluginConfig：插件配置脱敏（P0-3）
 *   7. isValidPresetName：预设名白名单（P0-3）
 *   8. agent-api：history-sync 回填 + callbackId 选项回调（P1-1/P1-5）
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import http from 'http';
import { fileURLToPath } from 'url';

import { extractOptions, toChineseNum } from '../server/agent/option-utils.js';
import { AgentRunner } from '../plugins/agent-framework/engine/agent-runner.js';
import { createCharacterTools } from '../plugins/agent-framework/tools/character-tools.js';
import { MemoryEngine } from '../plugins/agent-framework/engine/memory-engine.js';
import { ChatArchive } from '../server/runtime/chat-archive.js';
import { redactPluginConfig } from '../server/plugin-manager.js';
import { isValidPresetName } from '../plugins/st-data-manager/index.js';
import { registerAgentApi } from '../server/agent-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// Windows libuv：http server 关闭与 undici keep-alive 连接回收有异步延迟，
// --test-force-exit 强杀时可能撞上 UV_HANDLE_CLOSING 断言崩溃（仓库已知问题，见 plugin-system.test.js）。
// 等待句柄收尾后再退出。
after(async () => {
    await new Promise(r => setTimeout(r, 1200));
});

function tmpDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ==================== 1. option-utils ====================

describe('option-utils（P1-1 选项提取共享模块）', () => {
    test('提取中文数字选项并从正文剥离', () => {
        const text = '酒馆灯火通明。\n\n>选项一：向酒保打听消息\n>选项二：独自坐在角落';
        const { mainText, options } = extractOptions(text);
        assert.strictEqual(options.length, 2);
        assert.strictEqual(options[0].index, '一');
        assert.strictEqual(options[0].content, '向酒保打听消息');
        assert.ok(mainText.includes('酒馆灯火通明'));
        assert.ok(!mainText.includes('>选项'));
    });

    test('提取阿拉伯数字选项（>10 项）与全角冒号', () => {
        const lines = [];
        for (let i = 1; i <= 12; i++) lines.push(`>选项${i}：选项${i}内容`);
        const { options } = extractOptions('正文。\n' + lines.join('\n'));
        assert.strictEqual(options.length, 12);
        assert.strictEqual(options[11].content, '选项12内容');
    });

    test('无选项时正文原样保留', () => {
        const { mainText, options } = extractOptions('  普通正文。  ');
        assert.strictEqual(options.length, 0);
        assert.ok(mainText.includes('普通正文'));
    });

    test('toChineseNum 1-10 中文、>10 阿拉伯', () => {
        assert.strictEqual(toChineseNum(1), '一');
        assert.strictEqual(toChineseNum(10), '十');
        assert.strictEqual(toChineseNum(11), '11');
    });

    test('空输入返回空', () => {
        assert.deepStrictEqual(extractOptions(''), { mainText: '', options: [] });
        assert.deepStrictEqual(extractOptions(null), { mainText: '', options: [] });
    });
});

// ==================== 2. AgentRunner 选项 + agent_event ====================

describe('AgentRunner（P1-1/P1-2 选项填充与事件广播）', () => {
    function makeRunner(llm, onAgentEvent) {
        return new AgentRunner({
            contextBuilder: {
                build: () => [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
            },
            toolRegistry: {
                getDeclarations: () => [{ name: 'state.read', description: '读取状态', parameters: {} }],
                createExecutor: () => async () => JSON.stringify({ ok: true }),
            },
            stateManager: { flush: () => {} },
            logger: { info: () => {}, error: () => {}, warn: () => {} },
            onAgentEvent,
        });
    }

    test('run 后正文选项被填充进 result.options，正文剥离选项行', async () => {
        const llm = {
            runToolsStream: async (messages, tools, executor) => {
                await executor('state.read', { key: 'time' }); // 触发 tool_call + state_change 事件
                return {
                    text: '你推开门，酒馆里人声鼎沸。\n\n>选项一：向酒保打听消息\n>选项二：直接离开',
                    steps: 1,
                };
            },
        };
        const events = [];
        const runner = makeRunner(llm, (sessionKey, ev) => events.push(ev));
        const out = await runner.run(
            { name: 't', tools: ['state.read'], model: {} },
            { platform: 'native', chatId: 'test' },
            [],
            '你好',
            { llm },
        );
        assert.ok(out.result, '应有 result');
        assert.strictEqual(out.result.options.length, 2, '选项应被填充');
        assert.strictEqual(out.result.options[0].text, '向酒保打听消息');
        assert.strictEqual(out.result.options[0].callbackId, 'select:option:一');
        assert.ok(!out.result.getMainText().includes('>选项'), '正文应剥离选项行');
        // agent_event 实时广播：tool_call + state_change 至少各一次
        const types = events.map(e => e.type);
        assert.ok(types.includes('tool_call'), `应广播 tool_call，实际 ${types.join(',')}`);
        assert.ok(types.includes('state_change'), `应广播 state_change，实际 ${types.join(',')}`);
    });
});

// ==================== 3. character-tools ====================

describe('character-tools（P0-1 角色卡/世界书工具）', () => {
    test('character.read 返回归一化角色卡；worldbook.search 命中条目', async () => {
        const { dir, cleanup } = tmpDir('ct-tools-');
        try {
            const charsDir = path.join(dir, 'characters');
            const wbDir = path.join(dir, 'worldbooks');
            fs.mkdirSync(charsDir, { recursive: true });
            fs.mkdirSync(wbDir, { recursive: true });
            fs.writeFileSync(path.join(charsDir, '艾丽丝.json'), JSON.stringify({
                spec: 'chara_card_v2',
                data: { name: '艾丽丝', description: '酒馆老板娘', personality: '热情', scenario: '', first_mes: '欢迎光临' },
            }));
            fs.writeFileSync(path.join(wbDir, '世界书A.json'), JSON.stringify({
                entries: [
                    { uid: 0, key: ['酒馆', '酒保'], content: '这家酒馆的麦酒远近闻名。', comment: 's1' },
                    { uid: 1, key: ['王城'], content: '王城是大陆的中心。', comment: 's2' },
                ],
            }));

            const [charTool, wbTool] = createCharacterTools({ charactersDir: charsDir, worldbooksDir: wbDir });

            const card = await charTool.handler({ name: '艾丽丝' });
            assert.strictEqual(card.name, '艾丽丝');
            assert.ok(card.description.includes('酒馆老板娘'));
            assert.ok(!card.error);

            const hit = await wbTool.handler({ query: '麦酒', book: '世界书A' });
            assert.strictEqual(hit.count, 1);
            assert.ok(hit.results[0].content.includes('麦酒'));

            const miss = await wbTool.handler({ query: '不存在的关键词' });
            assert.ok(miss.error, '无命中应返回可读错误');
        } finally {
            cleanup();
        }
    });

    test('character.read 对不存在角色卡返回可恢复错误（含可用列表）', async () => {
        const { dir, cleanup } = tmpDir('ct-tools-');
        try {
            const charsDir = path.join(dir, 'characters');
            fs.mkdirSync(charsDir, { recursive: true });
            const [charTool] = createCharacterTools({ charactersDir: charsDir });
            const res = await charTool.handler({ name: '不存在' });
            assert.ok(res.error, '应返回错误');
            assert.strictEqual(res.recoverable, true, '应为可恢复错误');
            assert.strictEqual(res.details.available, '(无角色卡)', '空目录可用列表为占位文案');
        } finally {
            cleanup();
        }
    });
});

// ==================== 4. MemoryEngine summaryInterval ====================

describe('MemoryEngine（P1-4 summaryInterval 语义）', () => {
    test('summaryInterval:0 保持禁用（不被 || 吞掉）', () => {
        const { dir, cleanup } = tmpDir('mem-int-');
        try {
            const eng = new MemoryEngine(dir, { summaryInterval: 0 });
            assert.strictEqual(eng.summaryInterval, 0);
            assert.strictEqual(eng.shouldSummarize(10), false, '0 时应永不触发摘要');
        } finally {
            cleanup();
        }
    });

    test('summaryInterval 缺省为 10', () => {
        const { dir, cleanup } = tmpDir('mem-int-');
        try {
            const eng = new MemoryEngine(dir, {});
            assert.strictEqual(eng.summaryInterval, 10);
            assert.strictEqual(eng.shouldSummarize(20), true);
        } finally {
            cleanup();
        }
    });
});

// ==================== 5. ChatArchive mtime ====================

describe('ChatArchive（P2-2 mtime 追踪）', () => {
    test('append 后 _mtimeMs 更新；外部改动后磁盘 mtime 与实例不一致', async () => {
        const { dir, cleanup } = tmpDir('ca-mtime-');
        try {
            const file = path.join(dir, 'chat.jsonl');
            const arc = new ChatArchive(file, { userName: 'User', characterName: '助手' });
            arc.append({ mes: '你好', isUser: true });
            assert.ok(arc._mtimeMs > 0, 'append 后应记录 mtime');
            const mtimeAfterAppend = arc._mtimeMs;

            // 模拟外部（如 ST）改动文件 → 磁盘 mtime 变化
            await new Promise(r => setTimeout(r, 20));
            fs.appendFileSync(file, '{"name":"外部","is_user":false,"mes":"外部插入","send_date":0}\n');
            const diskMtime = fs.statSync(file).mtimeMs;
            assert.notStrictEqual(diskMtime, mtimeAfterAppend, '外部改动后磁盘 mtime 应不同');

            // pipeline 缓存据此判断需重载
            assert.notStrictEqual(arc._mtimeMs, diskMtime);
            assert.strictEqual(arc.getHistory(10).length, 1, '内存历史尚未包含外部行');
        } finally {
            cleanup();
        }
    });
});

// ==================== 6. redactPluginConfig ====================

describe('redactPluginConfig（P0-3 插件配置脱敏）', () => {
    test('敏感键脱敏保留末 4 位，非敏感不变，不修改入参', () => {
        const input = { stUrl: 'http://localhost:8000', stAuth: 'abcde', nested: { apiKey: '12345678' } };
        const out = redactPluginConfig(input);
        assert.strictEqual(out.stUrl, 'http://localhost:8000');
        assert.strictEqual(out.stAuth, '***bcde');
        assert.strictEqual(out.nested.apiKey, '***5678');
        assert.strictEqual(input.stAuth, 'abcde', '入参不应被修改');
    });

    test('空字符串不打码；数组递归处理', () => {
        const out = redactPluginConfig({ keys: [{ token: 'abcd1234' }, 'x'], empty: '' });
        assert.strictEqual(out.keys[0].token, '***1234');
        assert.strictEqual(out.empty, '');
    });
});

// ==================== 7. isValidPresetName ====================

describe('isValidPresetName（P0-3 预设名白名单）', () => {
    test('合法名通过，路径穿越/分隔符/超长拒绝', () => {
        assert.strictEqual(isValidPresetName('my预设_1-a'), true);
        assert.strictEqual(isValidPresetName('default'), true);
        assert.strictEqual(isValidPresetName('../gateway'), false, '路径穿越应拒绝');
        assert.strictEqual(isValidPresetName('a/b'), false, '路径分隔符应拒绝');
        assert.strictEqual(isValidPresetName('a\\b'), false);
        assert.strictEqual(isValidPresetName(''), false);
        assert.strictEqual(isValidPresetName('x'.repeat(65)), false, '超长应拒绝');
    });
});

// ==================== 8. agent-api：history-sync + callbackId ====================

function makeDeps(overrides = {}) {
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
            run: overrides.run || (async () => ({ runId: 'run-1', aborted: false, text: 'ok', result: null })),
            abortRun: () => true,
            getStatus: () => ({ activeAgents: [] }),
            getLastPrompt: () => null,
            getGreetings: () => null,
            getHistoryLimit: (p) => { const d = fakeAgentFramework.agentLoader.get(p); return d?.context?.historyLimit || 20; },
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
        configManager: { get: () => ({}) },
        logger: console,
        repoRoot: REPO_ROOT,
        staticDir: path.join(REPO_ROOT, 'public'),
        ...overrides,
    };
}

async function withServer(deps, fn) {
    const app = express();
    app.use(express.json());
    // Windows 下快速连续起/关临时服务器时，undici keep-alive 可能残留指向已关闭
    // 端口的连接（ephemeral 端口复用）导致偶发 `fetch failed`（flaky）。
    // 强制响应头 Connection: close，让每个 fetch 都新建连接，规避该竞态。
    app.use((req, res, next) => { res.set('Connection', 'close'); next(); });
    registerAgentApi(app, deps);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    try {
        await fn(base);
    } finally {
        await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections?.(); // 立即销毁残留连接，避免端口复用竞态
        });
    }
}

describe('agent-api 优化行为（P1-1/P1-5）', () => {
    test('POST /api/agent-theatre/history-sync：服务端为空时采纳客户端历史', async () => {
        await withServer(makeDeps(), async (base) => {
            const url = `${base}/api/agent-theatre/history-sync?session=native:hs`;
            const r1 = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }),
            });
            const b1 = await r1.json();
            assert.strictEqual(b1.success, true);
            assert.strictEqual(b1.merged, 2, '首次应采纳 2 条');

            // 服务端已有历史：再次同步不应覆盖
            const r2 = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ history: [{ role: 'user', content: 'X' }] }),
            });
            const b2 = await r2.json();
            assert.strictEqual(b2.merged, 0, '服务端已有历史时不应覆盖');
            assert.strictEqual(b2.serverLength, 2);
        });
    });

    test('callbackId 选项回调：input 为空时映射为上一轮选项文本', async () => {
        let captured = null;
        const run = async (profile, input, session) => {
            captured = { profile, input, session };
            return {
                runId: 'r1',
                aborted: false,
                text: '你好，要喝点什么？',
                result: {
                    toJSON: () => ({ options: [{ text: '来一杯麦酒', callbackId: 'select:option:一' }] }),
                    getMainText: () => '你好，要喝点什么？',
                },
            };
        };
        await withServer(makeDeps({ run }), async (base) => {
            // 第一轮：普通输入，生成带选项的结果
            await fetch(`${base}/api/agent-theatre/input?session=native:cb`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: '来一杯' }),
            });
            // 第二轮：仅传 callbackId（模拟点击选项按钮）
            const resp = await fetch(`${base}/api/agent-theatre/input?session=native:cb`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callbackId: 'select:option:一' }),
            });
            const body = await resp.json();
            assert.strictEqual(body.success, true);
            assert.strictEqual(captured.input, '[选项回调] 来一杯麦酒', 'callbackId 应映射为选项文本');
        });
    });
});
