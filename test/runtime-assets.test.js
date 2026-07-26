/**
 * 自建推理管线 - 资产层回归测试（P2-1/2/3）
 * 角色卡解析、世界书激活、聊天存档读写
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { loadCharacterCard, parseCharacterCardPng, normalizeCard, extractPngTextChunks } from '../server/runtime/card-loader.js';
import { normalizeLorebook, activateEntries } from '../server/runtime/worldbook-engine.js';
import { ChatArchive } from '../server/runtime/chat-archive.js';
import { tmpDir, buildCharacterPng } from './helpers.js';

const tmps = [];
function makeTmp() { const t = tmpDir(); tmps.push(t); return t.dir; }
after(() => { for (const t of tmps) t.cleanup(); });

describe('角色卡加载（PNG V2/V3 + JSON）', () => {
    test('解析 PNG tEXt 中的 V2 角色卡', () => {
        const dir = makeTmp();
        const file = path.join(dir, 'char.png');
        fs.writeFileSync(file, buildCharacterPng({
            spec: 'chara_card_v2',
            data: { name: '月见', description: '月下剑士', first_mes: '{{user}}，你来了。' },
        }));

        const card = loadCharacterCard(file);
        assert.strictEqual(card.name, '月见');
        assert.strictEqual(card.description, '月下剑士');
        assert.strictEqual(card.firstMes, '{{user}}，你来了。');
    });

    test('解析 zTXt（zlib 压缩）中的角色卡', () => {
        const dir = makeTmp();
        const file = path.join(dir, 'z.png');
        fs.writeFileSync(file, buildCharacterPng({
            spec: 'chara_card_v2',
            data: { name: '压缩卡', description: 'desc' },
        }, { compressed: true }));

        const card = loadCharacterCard(file);
        assert.strictEqual(card.name, '压缩卡');
    });

    test('V3（ccv3 关键字）优先于 V2', () => {
        const dir = makeTmp();
        const file = path.join(dir, 'v3.png');
        fs.writeFileSync(file, buildCharacterPng({
            spec: 'chara_card_v3',
            data: { name: 'V3角色', description: 'v3 desc' },
        }, { keyword: 'ccv3' }));

        const card = loadCharacterCard(file);
        assert.strictEqual(card.name, 'V3角色');
        assert.strictEqual(card.spec, 'chara_card_v3');
    });

    test('V1 扁平格式（无 spec/data）兼容', () => {
        const card = normalizeCard({ name: '老卡', description: 'v1 格式', first_mes: '你好' });
        assert.strictEqual(card.name, '老卡');
        assert.strictEqual(card.firstMes, '你好');
    });

    test('纯 JSON 角色卡', () => {
        const dir = makeTmp();
        const file = path.join(dir, 'c.json');
        fs.writeFileSync(file, JSON.stringify({ spec: 'chara_card_v2', data: { name: 'JSON卡' } }));
        assert.strictEqual(loadCharacterCard(file).name, 'JSON卡');
    });

    test('内嵌 character_book 被保留', () => {
        const card = normalizeCard({
            spec: 'chara_card_v2',
            data: { name: 'x', character_book: { entries: [{ keys: ['k'], content: 'c' }] } },
        });
        assert.ok(card.characterBook, '角色卡内嵌世界书应保留');
    });

    test('非 PNG 数据抛出清晰错误', () => {
        assert.throws(() => extractPngTextChunks(Buffer.from('not a png')), /不是有效的 PNG/);
    });

    test('PNG 无角色卡数据时抛出清晰错误', () => {
        const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]);
        assert.throws(() => parseCharacterCardPng(png), /未找到角色卡数据|不是有效/);
    });
});

describe('世界书引擎', () => {
    test('constant 条目始终激活', () => {
        const entries = normalizeLorebook({
            entries: [{ keys: [], content: '常驻设定', constant: true }],
        });
        const r = activateEntries(entries, '任意文本');
        assert.strictEqual(r.activated.length, 1);
    });

    test('关键词命中才激活', () => {
        const entries = normalizeLorebook({
            entries: [{ keys: ['魔法'], content: '魔法体系设定' }],
        });
        assert.strictEqual(activateEntries(entries, '今天天气不错').activated.length, 0);
        assert.strictEqual(activateEntries(entries, '我要学魔法').activated.length, 1);
    });

    test('大小写不敏感（默认）与敏感模式', () => {
        const insensitive = normalizeLorebook({ entries: [{ keys: ['Magic'], content: 'c' }] });
        assert.strictEqual(activateEntries(insensitive, 'use magic').activated.length, 1);

        const sensitive = normalizeLorebook({ entries: [{ keys: ['Magic'], content: 'c', case_sensitive: true }] });
        assert.strictEqual(activateEntries(sensitive, 'use magic').activated.length, 0);
    });

    test('selective 需辅助关键词同时命中', () => {
        const entries = normalizeLorebook({
            entries: [{ keys: ['剑'], secondary_keys: ['战斗'], content: '剑术', selective: true }],
        });
        assert.strictEqual(activateEntries(entries, '我有一把剑').activated.length, 0, '只命中主关键词不应激活');
        assert.strictEqual(activateEntries(entries, '用剑进行战斗').activated.length, 1);
    });

    test('按 position 分桶到 before/after', () => {
        const entries = normalizeLorebook({
            entries: [
                { keys: [], content: '前置', constant: true, position: 'before_char' },
                { keys: [], content: '后置', constant: true, position: 'after_char' },
            ],
        });
        const r = activateEntries(entries, '');
        assert.deepStrictEqual(r.beforeChar, ['前置']);
        assert.deepStrictEqual(r.afterChar, ['后置']);
    });

    test('按 insertion_order 排序', () => {
        const entries = normalizeLorebook({
            entries: [
                { keys: [], content: '第二', constant: true, insertion_order: 20 },
                { keys: [], content: '第一', constant: true, insertion_order: 10 },
            ],
        });
        assert.deepStrictEqual(activateEntries(entries, '').afterChar, ['第一', '第二']);
    });

    test('递归激活：已激活内容可触发新条目', () => {
        const entries = normalizeLorebook({
            entries: [
                { keys: ['入口'], content: '这里提到了 隐藏词' },
                { keys: ['隐藏词'], content: '隐藏设定' },
            ],
        });
        const r = activateEntries(entries, '走进入口', { maxRecursion: 2 });
        assert.strictEqual(r.activated.length, 2, '递归应激活第二条');
    });

    test('disable/enabled=false 的条目不激活', () => {
        const entries = normalizeLorebook({
            entries: [{ keys: [], content: 'x', constant: true, disable: true }],
        });
        assert.strictEqual(activateEntries(entries, '').activated.length, 0);
    });

    test('空内容条目被丢弃', () => {
        const entries = normalizeLorebook({ entries: [{ keys: ['k'], content: '' }] });
        assert.strictEqual(entries.length, 0);
    });
});

describe('聊天存档（.jsonl 与 ST 互通）', () => {
    test('追加消息并可重新读取', () => {
        const dir = makeTmp();
        const file = path.join(dir, 'chat.jsonl');

        const a1 = new ChatArchive(file, { userName: '我', characterName: '月见' });
        a1.append({ isUser: true, mes: '你好' });
        a1.append({ isUser: false, mes: '你好呀' });

        const a2 = new ChatArchive(file);
        assert.strictEqual(a2.length, 2);
        assert.strictEqual(a2.messages[0].mes, '你好');
        assert.strictEqual(a2.messages[0].is_user, true);
    });

    test('重复 load() 不会把历史追加两遍', () => {
        // 以前 load() 直接 push，而构造函数已经 load 过一次，
        // 外部再调一次历史就翻倍（3→6→9）。而"ST 在外部改了存档、
        // 网关重新载入"正是这套互通功能的正常用法，一旦触发，
        // 喂给模型的上下文就全是重复内容。
        const dir = makeTmp();
        const file = path.join(dir, 'reload.jsonl');
        const a = new ChatArchive(file, { userName: 'U', characterName: 'C' });
        a.append({ isUser: true, mes: '一' });
        a.append({ isUser: false, mes: '二' });
        a.append({ isUser: true, mes: '三' });

        const b = new ChatArchive(file);
        assert.strictEqual(b.messages.length, 3);
        b.load();
        assert.strictEqual(b.messages.length, 3, '重复 load 后条数应不变');
        b.load();
        assert.strictEqual(b.messages.length, 3, '第三次 load 后条数仍应不变');
        assert.deepStrictEqual(b.messages.map(m => m.mes), ['一', '二', '三']);
    });

    test('load() 会反映磁盘上的最新内容（ST 改档后重载）', () => {
        // 清空再读的另一面：外部把存档改短了，重载后应该跟着变短，
        // 而不是保留内存里的旧条目
        const dir = makeTmp();
        const file = path.join(dir, 'external.jsonl');
        const a = new ChatArchive(file, { userName: 'U', characterName: 'C' });
        a.append({ isUser: true, mes: 'A' });
        a.append({ isUser: false, mes: 'B' });

        const reader = new ChatArchive(file);
        assert.strictEqual(reader.messages.length, 2);

        // 模拟 ST 在外部重写了这个文件，只留一条
        const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
        fs.writeFileSync(file, lines.slice(0, 2).join('\n') + '\n', 'utf-8');

        reader.load();
        assert.strictEqual(reader.messages.length, 1);
        assert.strictEqual(reader.messages[0].mes, 'A');
    });

    test('首行写入 ST 兼容的元数据', () => {
        const dir = makeTmp();
        const file = path.join(dir, 'meta.jsonl');
        const a = new ChatArchive(file, { userName: 'U', characterName: 'C' });
        a.append({ isUser: true, mes: 'x' });

        const firstLine = JSON.parse(fs.readFileSync(file, 'utf-8').split('\n')[0]);
        assert.strictEqual(firstLine.user_name, 'U');
        assert.strictEqual(firstLine.character_name, 'C');
    });

    test('getHistory 转为 role/content 形式供 prompt 使用', () => {
        const dir = makeTmp();
        const a = new ChatArchive(path.join(dir, 'h.jsonl'), { characterName: 'C' });
        a.append({ isUser: true, mes: 'Q' });
        a.append({ isUser: false, mes: 'A' });

        const h = a.getHistory();
        assert.deepStrictEqual(h.map(m => m.role), ['user', 'assistant']);
        assert.strictEqual(h[1].content, 'A');
    });

    test('getHistory(limit) 只取最近 N 条', () => {
        const dir = makeTmp();
        const a = new ChatArchive(path.join(dir, 'l.jsonl'));
        for (let i = 0; i < 10; i++) a.append({ isUser: true, mes: `m${i}` });

        const h = a.getHistory(3);
        assert.strictEqual(h.length, 3);
        assert.strictEqual(h[2].content, 'm9');
    });

    test('is_system 消息不进入 history', () => {
        const dir = makeTmp();
        const a = new ChatArchive(path.join(dir, 's.jsonl'));
        a.append({ isUser: false, isSystem: true, mes: '系统提示' });
        a.append({ isUser: true, mes: '真实消息' });

        assert.strictEqual(a.getHistory().length, 1);
    });

    test('损坏行被跳过，不影响其余消息', () => {
        const dir = makeTmp();
        const file = path.join(dir, 'broken.jsonl');
        fs.writeFileSync(file,
            JSON.stringify({ user_name: 'U', character_name: 'C' }) + '\n' +
            '{ 这行不是合法 JSON\n' +
            JSON.stringify({ name: 'C', is_user: false, mes: '正常消息' }) + '\n');

        const a = new ChatArchive(file);
        assert.strictEqual(a.length, 1, '损坏行应被跳过而非导致整个存档加载失败');
        assert.strictEqual(a.messages[0].mes, '正常消息');
    });

    test('clear() 清空消息但保留元数据', () => {
        const dir = makeTmp();
        const file = path.join(dir, 'c.jsonl');
        const a = new ChatArchive(file, { characterName: '角色A' });
        a.append({ isUser: true, mes: 'x' });
        a.clear();

        const reloaded = new ChatArchive(file);
        assert.strictEqual(reloaded.length, 0);
        assert.strictEqual(reloaded.meta.character_name, '角色A');
    });
});
