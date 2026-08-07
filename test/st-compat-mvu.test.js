/**
 * ST 兼容（P0）：MVU 兼容运行时 + agent-api 集成测试。
 *
 * 覆盖：
 *   1. mvu-engine 路径工具（中文路径 / 数组 / "-" 追加）
 *   2. 三语法差分解析：JSON Patch 块 / set|old→new|() 命令行 / _.set('path', v)
 *   3. applyMvuToText 应用到快照（replace/delta/insert/remove/move + 数字 coerce）
 *   4. formatVariables（YAML 块、$ 前缀键忽略）
 *   5. expandMessageVariables（get/format_message_variable / lastMessageId / isMobile）
 *   6. stripForDisplay（剥离 UpdateVariable/StatusPlaceHolder/Analysis）
 *   7. agent-api：/input 应用 MVU 并广播 variables；/variables-set；/history-truncate
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

import {
    normalizePath, getByPath, setByPath, removeByPath,
    parseJsonPatch, parseCommandLines, parseUnderscoreSet,
    applyCommand, applyMvuToText, parseUpdateBlock, applyCommands,
    formatVariables, expandMessageVariables, stripForDisplay,
} from '../server/agent/mvu-engine.js';
import { registerAgentApi } from '../server/agent-api.js';
import {
    runVariableProcessor,
    runChronicleProcessor,
    extractInitVariables,
    extractUpdateRules,
} from '../server/agent/st-processors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

after(async () => { await new Promise(r => setTimeout(r, 1200)); });

// ==================== 1. 路径工具 ====================

describe('mvu-engine 路径工具', () => {
    test('normalizePath 支持 /a/b/c 与 a.b.c 与中文键', () => {
        assert.deepStrictEqual(normalizePath('/角色/络络/好感度'), ['角色', '络络', '好感度']);
        assert.deepStrictEqual(normalizePath('角色.络络.好感度'), ['角色', '络络', '好感度']);
        assert.deepStrictEqual(normalizePath('/世界/时间'), ['世界', '时间']);
    });

    test('setByPath / getByPath 自动创建中间对象', () => {
        const o = {};
        setByPath(o, '角色.络络.好感度', 30);
        assert.strictEqual(getByPath(o, '角色.络络.好感度'), 30);
        assert.strictEqual(getByPath(o, '角色.不存在'), undefined);
        assert.strictEqual(getByPath({ a: 1 }, 'a.b'), undefined);
    });

    test('数组 "-" 追加与下标删除', () => {
        const o = { 物品栏: [] };
        setByPath(o, '物品栏.-', '面包');
        setByPath(o, '物品栏.-', '水');
        assert.deepStrictEqual(o.物品栏, ['面包', '水']);
        removeByPath(o, '物品栏.0');
        assert.deepStrictEqual(o.物品栏, ['水']);
    });
});

// ==================== 2. 三语法解析 ====================

describe('mvu-engine 差分解析', () => {
    test('parseJsonPatch 支持围栏包裹与纯数组', () => {
        const arr = parseJsonPatch('```json\n[{"op":"replace","path":"/a","value":1}]\n```');
        assert.strictEqual(arr.length, 1);
        assert.strictEqual(arr[0].op, 'replace');
        const arr2 = parseJsonPatch('[{"op":"delta","path":"/b","value":5}]');
        assert.strictEqual(arr2[0].op, 'delta');
        assert.strictEqual(parseJsonPatch('无 JSON').length, 0);
    });

    test('parseCommandLines 解析 set|path=old→new|(理由)', () => {
        const cmds = parseCommandLines('set|悠纪.好感度=0→1|(初次见面)\nadd|金币=10|(捡到)');
        assert.strictEqual(cmds.length, 2);
        assert.strictEqual(cmds[0].op, 'set');
        assert.strictEqual(cmds[0].path, '悠纪.好感度');
        assert.strictEqual(cmds[0].value, 1);
        assert.strictEqual(cmds[1].op, 'add');
        assert.strictEqual(cmds[1].value, 10);
    });

    test('parseUnderscoreSet 解析 _.set("path", value)', () => {
        const cmds = parseUnderscoreSet("_.set('角色.络络.好感度', 30)\n_.set(\"心情\", \"害羞\")");
        assert.strictEqual(cmds.length, 2);
        assert.strictEqual(cmds[0].path, '角色.络络.好感度');
        assert.strictEqual(cmds[0].value, 30);
        assert.strictEqual(cmds[1].path, '心情');
        assert.strictEqual(cmds[1].value, '害羞');
    });

    test('parseUpdateBlock 提取 Analysis + JSONPatch', () => {
        const text = '<UpdateVariable>\n<Analysis>time passed: 1h</Analysis>\n<JSONPatch>\n[{"op":"replace","path":"/好感度","value":68}]\n</JSONPatch>\n</UpdateVariable>';
        const r = parseUpdateBlock(text);
        assert.ok(r.block);
        assert.ok(r.analysis.includes('time passed'));
        assert.strictEqual(r.jsonPatch.length, 1);
    });
});

// ==================== 3. applyMvuToText ====================

describe('mvu-engine 应用到快照', () => {
    test('JSON Patch：replace/delta/insert/remove/move', () => {
        const snap = { 角色: { 络络: { 好感度: 60, 心情: '平静' } }, 物品栏: ['剑'] };
        const text = '<UpdateVariable><JSONPatch>\n' +
            '[{"op":"replace","path":"/角色/络络/好感度","value":68},\n' +
            '{"op":"delta","path":"/角色/络络/好感度","value":2},\n' +
            '{"op":"insert","path":"/物品栏/-","value":"盾牌"},\n' +
            '{"op":"remove","path":"/物品栏/0"},\n' +
            '{"op":"move","from":"/角色/络络/心情","to":"/角色/心情备份"}]\n' +
            '</JSONPatch></UpdateVariable>';
        const r = applyMvuToText(text, snap);
        assert.strictEqual(r.changed, true);
        assert.strictEqual(r.snapshot.角色.络络.好感度, 70); // 68 → delta +2
        assert.deepStrictEqual(r.snapshot.物品栏, ['盾牌']);
        assert.strictEqual(r.snapshot.角色.心情备份, '平静');
        assert.strictEqual(r.snapshot.角色.络络.心情, undefined);
    });

    test('传统命令行 + _.set 混合应用，原快照不被污染', () => {
        const snap = { 好感度: 0, 心情: '平静' };
        const text = '<UpdateVariable>\nset|好感度=0→1|(初次见面)\n</UpdateVariable>\n_.set(\'心情\', \'害羞\')';
        const r = applyMvuToText(text, snap);
        assert.strictEqual(r.snapshot.好感度, 1);
        assert.strictEqual(r.snapshot.心情, '害羞');
        assert.strictEqual(snap.好感度, 0, '原快照不应被污染');
    });

    test('无命令块时返回未变更副本', () => {
        const r = applyMvuToText('普通正文，没有变量更新。', { a: 1 });
        assert.strictEqual(r.changed, false);
        assert.deepStrictEqual(r.snapshot, { a: 1 });
    });
});

// ==================== 4. formatVariables ====================

describe('mvu-engine formatVariables', () => {
    test('嵌套对象输出 YAML 风格，$ 前缀键忽略', () => {
        const out = formatVariables({ 好感度: 68, 角色: { 名字: '络络', $内部: 'x' }, 列表: [1, 2] });
        assert.ok(out.includes('好感度: 68'));
        assert.ok(out.includes('角色:'));
        assert.ok(out.includes('名字: 络络'));
        assert.ok(!out.includes('$内部'), '$ 前缀键不应输出');
        assert.ok(out.includes('- 1'));
    });
});

// ==================== 5. expandMessageVariables ====================

describe('mvu-engine 宏展开', () => {
    test('get/format_message_variable / lastMessageId / isMobile', () => {
        const vars = { 好感度: 68, 角色: { 名字: '络络' } };
        const text = '{{get_message_variable::好感度}}|{{format_message_variable::角色}}|{{lastMessageId}}|{{isMobile}}';
        const out = expandMessageVariables(text, vars, { historyLength: 7, isMobile: false });
        assert.strictEqual(out, '68|名字: 络络|6|false');
    });

    test('不存在路径返回空串', () => {
        assert.strictEqual(expandMessageVariables('{{get_message_variable::不存在的键}}', { a: 1 }), '');
    });
});

// ==================== 6. stripForDisplay ====================

describe('mvu-engine stripForDisplay', () => {
    test('剥离 UpdateVariable/StatusPlaceHolder/Analysis，保留正文', () => {
        const text = '正文内容。\n<UpdateVariable><Analysis>x</Analysis><JSONPatch>[]</JSONPatch></UpdateVariable>\n<StatusPlaceHolderImpl/>';
        const out = stripForDisplay(text);
        assert.ok(out.includes('正文内容'));
        assert.ok(!out.includes('UpdateVariable'));
        assert.ok(!out.includes('StatusPlaceHolder'));
        assert.ok(!out.includes('Analysis'));
    });
});

// ==================== 7. agent-api 集成 ====================

function makeDeps(overrides = {}) {
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
            run: overrides.run || (async () => ({ runId: 'r1', aborted: false, text: 'ok', result: null })),
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
        // R1: 默认关闭处理器（现有用例走"标签解析"兼容路径）；config.agentCompat 可开启处理器路径
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

describe('agent-api MVU 兼容端点', () => {
    test('/input 应用 <UpdateVariable> 并返回更新后的 variables', async () => {
        const run = async (profile, input, session) => {
            assert.strictEqual(session.variables['好感度'], 60, '会话级 stat_data 应传入 run（context-builder 展开用）');
            return {
                runId: 'r1',
                aborted: false,
                text: '她脸红了。',
                result: {
                    toJSON: () => ({ options: [] }),
                    getMainText: () => '<maintext>她脸红了。</maintext>\n<UpdateVariable><JSONPatch>\n[{"op":"delta","path":"/好感度","value":8}]\n</JSONPatch></UpdateVariable>',
                },
            };
        };
        await withServer(makeDeps({ run }), async (base) => {
            // 先初始化好感度=60
            await fetch(`${base}/api/agent-theatre/variables-set?session=native:mvu1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ variables: { 好感度: 60 } }),
            });
            const resp = await fetch(`${base}/api/agent-theatre/input?session=native:mvu1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: '继续' }),
            });
            const body = await resp.json();
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.variables.stat_data['好感度'], 68, 'delta +8 应生效');
            assert.ok(!body.text.includes('UpdateVariable'), '显示文本应剥离 UpdateVariable');
            assert.ok(body.text.includes('她脸红了'), '正文应保留');
        });
    });

    test('/variables-set 整体替换 stat_data；/state 返回 variables', async () => {
        await withServer(makeDeps(), async (base) => {
            const url = `${base}/api/agent-theatre/variables-set?session=native:mvu2`;
            await fetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ variables: { 世界: { 时代: '2020' }, 角色: { 络络: { 好感度: 30 } } } }),
            });
            const st = await fetch(`${base}/api/agent-theatre/state?session=native:mvu2`).then(r => r.json());
            assert.strictEqual(st.variables.stat_data['世界']['时代'], '2020');
            assert.strictEqual(st.variables.stat_data['角色']['络络']['好感度'], 30);
        });
    });

    test('/history-truncate 截断角色卡槽历史', async () => {
        const run = async () => ({ runId: 'r1', aborted: false, text: 'ok', result: { toJSON: () => ({}), getMainText: () => 'ok' } });
        await withServer(makeDeps({ run }), async (base) => {
            const inputUrl = `${base}/api/agent-theatre/input?session=native:mvu3`;
            // 两轮对话 → 历史 4 条（user+assistant ×2）
            for (let i = 0; i < 2; i++) {
                await fetch(inputUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: '第' + i + '轮' }) });
            }
            const before = await fetch(`${base}/api/agent-theatre/state?session=native:mvu3`).then(r => r.json());
            assert.strictEqual(before.turn, 2, '两轮对话后 turn=2');
            const trunc = await fetch(`${base}/api/agent-theatre/history-truncate?session=native:mvu3`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keepMessages: 2 }),
            }).then(r => r.json());
            assert.strictEqual(trunc.success, true);
            assert.strictEqual(trunc.keepMessages, 2);
            assert.ok(trunc.truncated >= 2);
        });
    });
});

// ==================== 8. st-processors 纯函数（R1 专业子代理） ====================

describe('st-processors 纯函数（R1 专业子代理）', () => {
    test('extractInitVariables 解析 JSON / YAML / 极简三形态', () => {
        const jsonCard = { characterBook: { entries: [{ name: '[initvar] 初始变量', content: '{"角色":{"络络":{"好感度":20}}}' }] } };
        assert.deepStrictEqual(extractInitVariables(jsonCard), { 角色: { 络络: { 好感度: 20 } } });
        const yamlCard = { characterBook: { entries: [{ name: '[initvar]', content: '角色:\n  络络:\n    心情: 平静' }] } };
        assert.deepStrictEqual(extractInitVariables(yamlCard), { 角色: { 络络: { 心情: '平静' } } });
        const minimalCard = { characterBook: { entries: [{ name: 'initvar', content: '好感度: 30\n金币: 100' }] } };
        assert.deepStrictEqual(extractInitVariables(minimalCard), { 好感度: 30, 金币: 100 });
        assert.strictEqual(extractInitVariables({ characterBook: { entries: [] } }), null, '无 initvar 返回 null');
        assert.strictEqual(extractInitVariables(null), null);
    });

    test('extractUpdateRules 提取变量更新规则条目', () => {
        const card = { characterBook: { entries: [{ name: '变量更新规则', content: '好感度受重大事件影响' }] } };
        assert.strictEqual(extractUpdateRules(card), '好感度受重大事件影响');
        assert.strictEqual(extractUpdateRules({ characterBook: { entries: [] } }), '');
    });

    test('runVariableProcessor 输出 JSON Patch 并应用（fake client）', async () => {
        const fakeClient = { generate: async () => '[{"op":"delta","path":"/好感度","value":8},{"op":"replace","path":"/心情","value":"开心"}]' };
        const cm = { get: (k) => (k === 'runtime.agentCompat' ? { enabled: true, variableProcessor: { enabled: true } } : {}) };
        const proc = await runVariableProcessor({
            configManager: cm, mainText: '她笑了。', statData: { 好感度: 60, 心情: '平静' },
            clientFactory: () => fakeClient,
        });
        assert.ok(proc, '应返回 { patch, raw }');
        assert.strictEqual(proc.patch.length, 2);
        const r = applyCommands({ 好感度: 60, 心情: '平静' }, proc.patch);
        assert.strictEqual(r.snapshot.好感度, 68, 'delta +8 应生效');
        assert.strictEqual(r.snapshot.心情, '开心');
    });

    test('runVariableProcessor 未启用 / 无模型返回 null（不抛错）', async () => {
        const cmOff = { get: () => ({ enabled: false }) };
        assert.strictEqual(await runVariableProcessor({ configManager: cmOff, mainText: 'x', statData: {} }), null);
        const cmNoModel = { get: (k) => (k === 'runtime.agentCompat' ? { enabled: true, variableProcessor: {} } : {}) };
        assert.strictEqual(await runVariableProcessor({ configManager: cmNoModel, mainText: 'x', statData: {} }), null);
    });

    test('runChronicleProcessor 生成总结（fake client）；未启用返回 null', async () => {
        const fakeClient = { generate: async () => '络络在咖啡馆偶遇老友，得知关键线索。' };
        const cm = { get: (k) => (k === 'runtime.agentCompat' ? { enabled: true, chronicle: { enabled: true } } : {}) };
        const s = await runChronicleProcessor({ configManager: cm, mainText: '正文……', characterName: '络络', clientFactory: () => fakeClient });
        assert.ok(s && s.includes('咖啡馆'));
        const cmOff = { get: () => ({ enabled: false }) };
        assert.strictEqual(await runChronicleProcessor({ configManager: cmOff, mainText: 'x' }), null);
    });
});

// ==================== 9. R1 集成：角色卡 [initvar] 初始化 + 切换隔离 + 处理器路径 ====================

/** 写入临时 JSON 角色卡（含内嵌世界书 entries），返回文件路径 */
function writeTempCard(dir, name, bookEntries) {
    const card = {
        name,
        description: 'test',
        personality: '',
        scenario: '',
        first_mes: `你好，我是${name}。`,
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        character_book: {
            name: 'test book',
            entries: (bookEntries || []).map((e, i) => ({
                keys: [e.name], content: e.content, extensions: {}, enabled: true,
                insertion_order: i, case_sensitive: false, name: e.name, priority: 10,
                id: i, comment: '', selective: false, constant: false, position: 'before_char',
            })),
        },
        tags: [], creator: '', character_version: '1.0', extensions: {},
    };
    const p = path.join(dir, name + '.json');
    fs.writeFileSync(p, JSON.stringify(card));
    return p;
}

describe('R1 角色卡槽变量初始化与切换隔离', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-mvu-cards-'));
    writeTempCard(tmpDir, '络络', [{ name: '[initvar] 初始变量', content: '{"角色":{"络络":{"好感度":20,"心情":"平静"}}}' }]);
    writeTempCard(tmpDir, '苏苏', [{ name: '[initvar] 初始变量', content: '{"角色":{"苏苏":{"灵力":100}}}' }]);

    test('切换角色卡后初始变量按新卡 [initvar] 重置（不残留旧卡）', async () => {
        const run = async () => ({ runId: 'r1', aborted: false, text: 'ok', result: { toJSON: () => ({}), getMainText: () => '正文' } });
        const deps = makeDeps({
            run,
            config: { agentCompat: { enabled: false }, runtime: { charactersDir: tmpDir } },
        });
        await withServer(deps, async (base) => {
            // 角色 A 首轮：stat_data 空 → 自动从卡内 [initvar] 初始化
            let r = await fetch(`${base}/api/agent-theatre/input?session=native:iso1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: '开始', character: '络络' }),
            }).then(x => x.json());
            assert.strictEqual(r.variables.stat_data['角色']['络络']['好感度'], 20, 'A 卡初始变量生效');
            assert.strictEqual(r.variables.initSource, '络络');

            // 角色 B 首轮：新卡槽 stat_data 空 → 重新初始化，A 的变量不残留
            r = await fetch(`${base}/api/agent-theatre/input?session=native:iso1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: '开始', character: '苏苏' }),
            }).then(x => x.json());
            assert.strictEqual(r.variables.stat_data['角色']['苏苏']['灵力'], 100, 'B 卡初始变量生效');
            assert.strictEqual(r.variables.stat_data['角色']['络络'], undefined, '旧卡初始变量不得残留');
            assert.strictEqual(r.variables.initSource, '苏苏');

            // 切回角色 A：槽位隔离，A 的 stat_data 可恢复
            r = await fetch(`${base}/api/agent-theatre/input?session=native:iso1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: '继续', character: '络络' }),
            }).then(x => x.json());
            assert.strictEqual(r.variables.stat_data['角色']['络络']['好感度'], 20, '切回 A 恢复 A 的变量');
        });
    });

    test('/input 走变量处理子 Agent：via=processor + 编年史广播 + mvuHistory 标记', async () => {
        const fakeClient = {
            generate: async (msgs) => msgs.some(m => m.role === 'system' && m.content.includes('变量管理'))
                ? '[{"op":"delta","path":"/角色/络络/好感度","value":5}]'
                : '络络在城门口遇到神秘人，好感度上升。',
        };
        const run = async () => ({ runId: 'r1', aborted: false, text: '她笑了。', result: { toJSON: () => ({}), getMainText: () => '她笑了。' } });
        const deps = makeDeps({
            run,
            processorClientFactory: () => fakeClient,
            config: {
                agentCompat: { enabled: true, variableProcessor: { enabled: true }, chronicle: { enabled: true } },
                runtime: { charactersDir: tmpDir },
            },
        });
        await withServer(deps, async (base) => {
            const r = await fetch(`${base}/api/agent-theatre/input?session=native:proc1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: '继续', character: '络络' }),
            }).then(x => x.json());
            assert.strictEqual(r.variables.stat_data['角色']['络络']['好感度'], 25, '处理器 delta +5 应生效（20+5）');
            assert.strictEqual(r.variables.lastUpdate.via, 'processor', '更新来源应为变量处理子 Agent');
            assert.ok(Array.isArray(r.chronicle) && r.chronicle.length >= 1, '编年史应随结果广播');
            assert.ok(r.chronicle[0].content.includes('络络'), '编年史内容来自 chronicle 子代理');
            // /state 返回变量变更历史（带 via 标记，前端可视化）
            const st = await fetch(`${base}/api/agent-theatre/state?session=native:proc1`).then(x => x.json());
            assert.ok(Array.isArray(st.mvuHistory) && st.mvuHistory.length >= 1);
            assert.strictEqual(st.mvuHistory[0].via, 'processor');
            assert.strictEqual(st.variables.lastUpdate.via, 'processor');
        });
    });

    test('/variables-reset 重置角色卡槽变量与编年史', async () => {
        const run = async () => ({ runId: 'r1', aborted: false, text: 'ok', result: { toJSON: () => ({}), getMainText: () => '正文' } });
        const deps = makeDeps({ run, config: { agentCompat: { enabled: false } } });
        await withServer(deps, async (base) => {
            await fetch(`${base}/api/agent-theatre/variables-set?session=native:reset1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ variables: { 好感度: 42 } }),
            });
            const r = await fetch(`${base}/api/agent-theatre/variables-reset?session=native:reset1`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
            }).then(x => x.json());
            assert.strictEqual(r.success, true);
            const st = await fetch(`${base}/api/agent-theatre/state?session=native:reset1`).then(x => x.json());
            assert.deepStrictEqual(st.variables.stat_data, {}, '重置后 stat_data 为空');
            assert.deepStrictEqual(st.chronicle, [], '重置后编年史为空');
        });
    });
});
