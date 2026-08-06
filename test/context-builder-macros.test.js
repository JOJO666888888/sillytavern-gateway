/**
 * ContextBuilder 宏机制测试（Agent 独立管线集成 ST 宏）
 *
 * 守护：
 *   - systemPrompt / 资产文本 / injectFiles 文件内容 / history / userMessage 统一过宏
 *   - setvar/getvar 会话级持久（同一 sessionKey 跨 build 轮次生效）+ 会话隔离
 *   - {{char}}/{{user}} 替换（charName 优先 session.charName，回退角色卡 card.name / Assistant）
 *   - enableMacros:false 时仅替换 {{char}}/{{user}}（向后兼容，与 preset-engine 一致）
 *   - 路径/变量名替换（_replaceVars）不过宏（插图表路径用例守护）
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { tmpDir } from './helpers.js';
import { ContextBuilder } from '../server/agent/context-builder.js';

const tmps = [];
function makeTmp() { const t = tmpDir('stgw-macro-'); tmps.push(t); return t.dir; }
after(() => { for (const t of tmps) t.cleanup(); });

/** 构造 assetsDir/dataDir 指向临时目录的 ContextBuilder（可传额外选项如 enableMacros） */
function makeBuilder(opts = {}) {
    const dir = makeTmp();
    fs.mkdirSync(path.join(dir, 'characters'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'worldbooks'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    return {
        dir,
        builder: new ContextBuilder({ assetsDir: dir, dataDir: path.join(dir, 'data'), ...opts }),
    };
}

/** 取 system 消息 content */
function systemOf(messages) {
    return messages.find(m => m.role === 'system')?.content || '';
}

// ==================== a: systemPrompt roll 宏 ====================

describe('a - systemPrompt 中 roll 宏展开', () => {
    test('{{roll:1d10}} 展开为 1-10、{{roll:1d34}} 展开为 1-34', () => {
        const { builder } = makeBuilder();
        const def = { name: 'x', systemPrompt: '{{roll:1d10}}|{{roll:1d34}}' };
        const system = systemOf(builder.build(def, { platform: 't', chatId: 'a1' }, [], 'hi'));
        const [d10, d34] = system.split('|').map(s => parseInt(s, 10));
        assert.ok(d10 >= 1 && d10 <= 10, `1d10 期望 1-10，得到 ${d10}`);
        assert.ok(d34 >= 1 && d34 <= 34, `1d34 期望 1-34，得到 ${d34}`);
        assert.ok(!system.includes('{{roll'), 'roll 标签应被完全移除');
    });
});

// ==================== b: setvar/getvar ====================

describe('b - setvar/getvar 宏变量', () => {
    test('{{setvar::MasterMemory::  }} 空值声明后 {{getvar::MasterMemory}} 得空串', () => {
        const { builder } = makeBuilder();
        const def = { name: 'x', systemPrompt: '{{setvar::MasterMemory::  }}记忆[{{getvar::MasterMemory}}]' };
        const system = systemOf(builder.build(def, { platform: 't', chatId: 'b1' }, [], 'hi'));
        assert.ok(!system.includes('{{setvar') && !system.includes('{{getvar'), 'setvar/getvar 标签应被移除');
        assert.match(system, /^记忆\[ *\]$/, '空值声明展开后括号内应仅剩空白');
    });

    test('非空 setvar/getvar 链正常展开', () => {
        const { builder } = makeBuilder();
        const def = { name: 'x', systemPrompt: '{{setvar::x::abc}}{{getvar::x}}' };
        const system = systemOf(builder.build(def, { platform: 't', chatId: 'b2' }, [], 'hi'));
        assert.strictEqual(system, 'abc');
    });

    test('value 含 :: 也能完整保留', () => {
        const { builder } = makeBuilder();
        const def = { name: 'x', systemPrompt: '{{setvar::x::a::b::c}}{{getvar::x}}' };
        const system = systemOf(builder.build(def, { platform: 't', chatId: 'b3' }, [], 'hi'));
        assert.strictEqual(system, 'a::b::c');
    });
});

// ==================== c: {{char}}/{{user}} ====================

describe('c - {{char}}/{{user}} 替换', () => {
    test('替换为 session.charName / session.userName', () => {
        const { builder } = makeBuilder();
        const def = { name: 'x', systemPrompt: '{{char}} 对 {{user}} 说话' };
        const session = { platform: 't', chatId: 'c1', charName: '清月', userName: 'Master' };
        const system = systemOf(builder.build(def, session, [], 'hi'));
        assert.strictEqual(system, '清月 对 Master 说话');
    });

    test('无 charName 时回退角色卡真实 card.name', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(path.join(dir, 'characters', '清月.json'), JSON.stringify({
            spec: 'chara_card_v2',
            data: { name: '清月', description: '月下仙子' },
        }));
        const system = systemOf(builder.build(
            { name: 'x', systemPrompt: '{{char}}' },
            { platform: 't', chatId: 'c2', character: '清月' },
            [], 'hi',
        ));
        assert.strictEqual(system, '清月');
    });

    test('无 charName/character 时 {{char}} 回退 Assistant、{{user}} 回退 user', () => {
        const { builder } = makeBuilder();
        const system = systemOf(builder.build(
            { name: 'x', systemPrompt: '{{char}}/{{user}}' },
            { platform: 't', chatId: 'c3' },
            [], 'hi',
        ));
        assert.strictEqual(system, 'Assistant/user');
    });
});

// ==================== d: 会话级持久 ====================

describe('d - 会话级宏变量持久化', () => {
    test('同一 sessionKey 第一次 build setvar，第二次 build getvar 可读', () => {
        const { builder } = makeBuilder();
        const session = { platform: 't', chatId: 'd1' };
        builder.build({ name: 'x', systemPrompt: '{{setvar::MasterMemory::重要记忆}}' }, session, [], 'hi');
        const system = systemOf(builder.build(
            { name: 'x', systemPrompt: '记忆[{{getvar::MasterMemory}}]' },
            session, [], 'hi',
        ));
        assert.strictEqual(system, '记忆[重要记忆]');
    });
});

// ==================== e: 会话隔离 ====================

describe('e - 会话隔离', () => {
    test('不同 sessionKey 同名变量互不串台', () => {
        const { builder } = makeBuilder();
        const s1 = { platform: 't', chatId: 'e1' };
        const s2 = { platform: 't', chatId: 'e2' };
        builder.build({ name: 'x', systemPrompt: '{{setvar::shared::A}}' }, s1, [], 'hi');
        builder.build({ name: 'x', systemPrompt: '{{setvar::shared::B}}' }, s2, [], 'hi');
        const sys1 = systemOf(builder.build({ name: 'x', systemPrompt: '[{{getvar::shared}}]' }, s1, [], 'hi'));
        const sys2 = systemOf(builder.build({ name: 'x', systemPrompt: '[{{getvar::shared}}]' }, s2, [], 'hi'));
        assert.strictEqual(sys1, '[A]');
        assert.strictEqual(sys2, '[B]');
    });
});

// ==================== f: enableMacros:false ====================

describe('f - enableMacros:false 向后兼容', () => {
    test('{{setvar::a::b}} 原样保留、{{user}} 仍被替换', () => {
        const { builder } = makeBuilder({ enableMacros: false });
        const def = { name: 'x', systemPrompt: '{{setvar::a::b}}{{user}} 你好' };
        const system = systemOf(builder.build(def, { platform: 't', chatId: 'f1', userName: 'Master' }, [], 'hi'));
        assert.ok(system.includes('{{setvar::a::b}}'), '关闭宏时 setvar 标签应原样保留');
        assert.ok(system.includes('Master'), '{{user}} 仍应被替换');
    });
});

// ==================== g: injectFiles 文件内容 ====================

describe('g - injectFiles 文件内容过宏', () => {
    test('文件中的 {{roll:1d6}} 展开为 1-6', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(path.join(dir, 'data', 'memory.md'), '记忆片段：今日掷骰 {{roll:1d6}}');
        const def = { name: 'x', systemPrompt: 'sys', context: { injectFiles: ['memory.md'] } };
        const system = systemOf(builder.build(def, { platform: 't', chatId: 'g1' }, [], 'hi'));
        assert.ok(system.includes('记忆片段：今日掷骰 '), '文件内容应注入');
        const m = system.match(/今日掷骰 (\d+)/);
        assert.ok(m, '文件中的 roll 宏应展开为数字');
        const n = Number(m[1]);
        assert.ok(n >= 1 && n <= 6, `1d6 期望 1-6，得到 ${m[1]}`);
        assert.ok(!system.includes('{{roll'), 'roll 标签应被移除');
    });
});

// ==================== h: history / userMessage ====================

describe('h - history 与 userMessage 过宏', () => {
    test('content 中的 {{user}}/{{roll:1d4}} 被展开，且不改动原 history', () => {
        const { builder } = makeBuilder();
        const def = { name: 'x', systemPrompt: 'sys' };
        const session = { platform: 't', chatId: 'h1', charName: '清月', userName: 'Master' };
        const history = [
            { role: 'user', content: '{{user}} 掷骰 {{roll:1d4}}' },
            { role: 'assistant', content: '{{char}} 回应' },
        ];
        const messages = builder.build(def, session, history, '{{user}} 继续 {{roll:1d4}}');

        assert.strictEqual(messages[1].role, 'user');
        assert.match(messages[1].content, /^Master 掷骰 [1-4]$/, 'history 中 {{user}} 与 1d4 应展开');
        assert.strictEqual(messages[2].content, '清月 回应', 'history 中 {{char}} 应展开');

        const last = messages[messages.length - 1];
        assert.strictEqual(last.role, 'user');
        assert.match(last.content, /^Master 继续 [1-4]$/, 'userMessage 中 {{user}} 与 1d4 应展开');

        assert.strictEqual(history[0].content, '{{user}} 掷骰 {{roll:1d4}}', '不应就地修改调用方 history');
        assert.strictEqual(history[1].content, '{{char}} 回应');
    });
});

// ==================== i: 插图表路径 ====================

describe('i - 插图表路径宏展开', () => {
    test('SFW/qingyue/gxcp/happy/{{roll:1d10}} 展开为 1-10 结尾', () => {
        const { builder } = makeBuilder();
        const messages = builder.build(
            { name: 'x', systemPrompt: 'sys' },
            { platform: 't', chatId: 'i1' },
            [],
            'image: SFW/qingyue/gxcp/happy/{{roll:1d10}}',
        );
        const last = messages[messages.length - 1];
        const m = last.content.match(/^image: SFW\/qingyue\/gxcp\/happy\/(\d+)$/);
        assert.ok(m, `路径应展开为数字结尾，得到 ${last.content}`);
        const n = Number(m[1]);
        assert.ok(n >= 1 && n <= 10, `期望 1-10，得到 ${m[1]}`);
    });
});
