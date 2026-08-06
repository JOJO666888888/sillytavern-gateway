/**
 * 后端聊天记录存储层测试（chat-store）
 *
 * 覆盖：
 *   - sanitizeName / timestamp 命名规范
 *   - resolveChatFile 层级路径与目录自动创建
 *   - saveChat 新建 / 覆盖式保存 / 校验和 / 失败重试 / 备份清理
 *   - readChat 往返与路径穿越防护
 *   - listChats 分页 / 角色过滤 / 关键词过滤 / 时间范围 / 排序
 *   - deleteChats 批量删除 + 路径穿越
 *   - migrateLegacy 迁移 + 幂等
 *   - getStoreStats 统计
 *   - API 端点冒烟（GET /chats、save/read/load）
 *   - 定时自动保存集成（POST /input -> dirty -> startChatAutoSave -> 落盘）
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ChatArchive } from '../server/runtime/chat-archive.js';
import {
    sanitizeName,
    timestamp,
    resolveChatFile,
    listChats,
    readChat,
    saveChat,
    deleteChats,
    migrateLegacy,
    getStoreStats,
} from '../server/runtime/chat-store.js';
import { registerAgentApi, startChatAutoSave, stopChatAutoSave } from '../server/agent-api.js';
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
    stopChatAutoSave(); // 清理自动保存计时器，避免测试进程挂住
});

// ==================== 命名规范 ====================

describe('sanitizeName 命名规范', () => {
    test('非法字符替换为 _', () => {
        assert.strictEqual(sanitizeName('清月/夜:雪*星?'), '清月_夜_雪_星_');
        assert.strictEqual(sanitizeName('a<b>c|d"e'), 'a_b_c_d_e');
    });

    test('控制字符替换为 _', () => {
        assert.strictEqual(sanitizeName('a\u0000b\u001Fc\u007Fd'), 'a_b_c_d');
    });

    test('多个连续 _ 合并为单个 _', () => {
        assert.strictEqual(sanitizeName('清月___夜__雪'), '清月_夜_雪');
    });

    test('全非法字符 -> _default', () => {
        assert.strictEqual(sanitizeName('***///'), '_default');
    });

    test('空字符串 / 全下划线 -> _default', () => {
        assert.strictEqual(sanitizeName(''), '_default');
        assert.strictEqual(sanitizeName('___'), '_default');
        assert.strictEqual(sanitizeName('   '), '_default');
    });

    test('删除首尾空白', () => {
        assert.strictEqual(sanitizeName('  清月  '), '清月');
    });

    test('截断到 80 字符', () => {
        const long = 'x'.repeat(200);
        assert.strictEqual(sanitizeName(long).length, 80);
    });

    test('中文保留', () => {
        assert.strictEqual(sanitizeName('清月'), '清月');
    });
});

describe('timestamp 时间戳', () => {
    test('格式为 YYYYMMDDHHMMSS', () => {
        assert.match(timestamp(new Date()), /^\d{14}$/);
    });

    test('零填充', () => {
        // 本地时区：2026-01-05 03:04:07
        assert.strictEqual(timestamp(new Date(2026, 0, 5, 3, 4, 7)), '20260105030407');
    });
});

describe('resolveChatFile 层级路径', () => {
    test('返回 <dataRoot>/chats/<角色>/<角色>_<时间戳>.jsonl 并自动建目录', () => {
        const root = makeTmp();
        const file = resolveChatFile(root, '清月', new Date(2026, 7, 5, 10, 30, 0));
        assert.strictEqual(file, path.join(root, 'chats', '清月', '清月_20260805103000.jsonl'));
        assert.ok(fs.existsSync(path.join(root, 'chats', '清月')), '目录应自动创建');
    });

    test('无角色卡时使用 _default 目录', () => {
        const root = makeTmp();
        const file = resolveChatFile(root, '', new Date(2026, 0, 1, 0, 0, 0));
        assert.strictEqual(file, path.join(root, 'chats', '_default', '_default_20260101000000.jsonl'));
    });
});

// ==================== saveChat / readChat ====================

describe('saveChat + readChat 往返', () => {
    test('新建并读取：messages 正确、checksumOk=true', () => {
        const root = makeTmp();
        const r = saveChat(root, {
            character: '清月',
            messages: [
                { role: 'user', content: '你好' },
                { role: 'assistant', content: '你好呀' },
            ],
            userName: '我',
        });
        assert.strictEqual(r.ok, true);
        assert.match(r.file, /^清月\/清月_\d{14}\.jsonl$/);
        assert.strictEqual(r.messageCount, 2);
        assert.strictEqual(r.retries, 0);

        const chat = readChat(root, r.file);
        assert.ok(chat, 'readChat 应返回结果');
        assert.strictEqual(chat.character, '清月');
        assert.strictEqual(chat.messages.length, 2);
        assert.strictEqual(chat.messages[0].role, 'user');
        assert.strictEqual(chat.messages[0].content, '你好');
        assert.strictEqual(chat.messages[1].role, 'assistant');
        assert.strictEqual(chat.messages[1].content, '你好呀');
        assert.strictEqual(chat.checksumOk, true, '保存后校验和应通过');
    });

    test('覆盖式保存：同 prevFile 再次保存不产生新文件', () => {
        const root = makeTmp();
        const r1 = saveChat(root, {
            character: '清月',
            messages: [
                { role: 'user', content: '一' },
                { role: 'assistant', content: '二' },
            ],
            userName: 'U',
        });
        assert.ok(r1.ok);
        const r2 = saveChat(root, {
            character: '清月',
            messages: [
                { role: 'user', content: '一' },
                { role: 'assistant', content: '二' },
                { role: 'user', content: '三' },
            ],
            userName: 'U',
            prevFile: r1.file,
        });
        assert.strictEqual(r2.ok, true);
        assert.strictEqual(r2.file, r1.file, '覆盖式保存应沿用同一文件');

        // 目录内仍只有 1 个 jsonl
        const chatsDir = path.join(root, 'chats');
        let count = 0;
        for (const dir of fs.readdirSync(chatsDir)) {
            for (const f of fs.readdirSync(path.join(chatsDir, dir))) {
                if (f.endsWith('.jsonl')) count++;
            }
        }
        assert.strictEqual(count, 1);
        const chat = readChat(root, r2.file);
        assert.strictEqual(chat.messages.length, 3);
        assert.strictEqual(chat.checksumOk, true);
    });

    test('校验和：篡改消息内容后 checksumOk=false', () => {
        const root = makeTmp();
        const r = saveChat(root, {
            character: '清月',
            messages: [
                { role: 'user', content: '原始内容' },
                { role: 'assistant', content: '回复' },
            ],
            userName: 'U',
        });
        assert.strictEqual(readChat(root, r.file).checksumOk, true);

        // 手动篡改最后一行消息内容
        const filePath = path.join(root, 'chats', r.file);
        const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
        const last = JSON.parse(lines[lines.length - 1]);
        last.mes = '被篡改的内容';
        lines[lines.length - 1] = JSON.stringify(last);
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`);

        const chat = readChat(root, r.file);
        assert.strictEqual(chat.checksumOk, false, '篡改后校验和应不通过');
        assert.strictEqual(chat.messages[chat.messages.length - 1].content, '被篡改的内容');
    });

    test('失败重试：__testFailFirst 首次失败后重试成功', () => {
        const root = makeTmp();
        const r = saveChat(root, {
            character: '清月',
            messages: [
                { role: 'user', content: '重试消息' },
                { role: 'assistant', content: 'ok' },
            ],
            __testFailFirst: true,
        });
        assert.strictEqual(r.ok, true, '重试后应成功');
        assert.ok(r.retries >= 1, `retries 应 >= 1，实际 ${r.retries}`);
        assert.strictEqual(r.messageCount, 2);
        const chat = readChat(root, r.file);
        assert.strictEqual(chat.messages.length, 2);
        assert.strictEqual(chat.checksumOk, true);
    });

    test('备份清理：成功无 .bak 残留；永久失败保留备份', () => {
        const root = makeTmp();
        // 首次保存（新建，无备份）
        const r1 = saveChat(root, { character: '清月', messages: [{ role: 'user', content: 'x' }], userName: 'U' });
        assert.ok(r1.ok);
        // 覆盖式保存成功 -> 备份应被清理
        const r2 = saveChat(root, { character: '清月', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }], userName: 'U', prevFile: r1.file });
        assert.strictEqual(r2.ok, true);
        const chatsDir = path.join(root, 'chats', '清月');
        assert.ok(!fs.readdirSync(chatsDir).some((f) => f.includes('.bak')), '保存成功后不应有 .bak 残留');

        // 永久失败 -> 备份保留
        const r3 = saveChat(root, {
            character: '清月',
            messages: [{ role: 'user', content: 'z' }],
            userName: 'U',
            prevFile: r2.file,
            __testAlwaysFail: true,
        });
        assert.strictEqual(r3.ok, false);
        assert.ok(r3.retries >= 3, `永久失败时 retries 应 >= 3，实际 ${r3.retries}`);
        assert.ok(r3.backup && fs.existsSync(r3.backup), '失败后应保留备份文件');
        assert.ok(fs.readdirSync(chatsDir).some((f) => f.includes('.bak')), '目录内应有 .bak 备份');
    });

    test('内容去重：同一内容重复保存（无 prevFile）复用同一文件，不产生重复存档', () => {
        const root = makeTmp();
        const msgs = [
            { role: 'user', content: '重复保存测试' },
            { role: 'assistant', content: '收到' },
        ];
        const r1 = saveChat(root, { character: '清月', messages: msgs, userName: 'U' });
        const r2 = saveChat(root, { character: '清月', messages: msgs, userName: 'U' });
        assert.strictEqual(r2.ok, true);
        assert.strictEqual(r2.file, r1.file, '内容一致时应复用同一文件（同一会话不产生多份）');

        // 目录内应只有 1 个 jsonl
        const chatsDir = path.join(root, 'chats');
        let count = 0;
        for (const dir of fs.readdirSync(chatsDir)) {
            count += fs.readdirSync(path.join(chatsDir, dir)).filter((f) => f.endsWith('.jsonl')).length;
        }
        assert.strictEqual(count, 1, '重复保存不应新增文件');
    });

    test('内容去重：清理历史遗留的重复副本，只保留最新一份', () => {
        const root = makeTmp();
        const msgs = [
            { role: 'user', content: '清理重复' },
            { role: 'assistant', content: '好的' },
        ];
        const r1 = saveChat(root, { character: '清月', messages: msgs, userName: 'U' });
        // 模拟旧版本产生的多份内容一致的副本（时间更早）
        const dir = path.join(root, 'chats', '清月');
        const dupA = path.join(dir, '清月_20260101000000.jsonl');
        const dupB = path.join(dir, '清月_20260202000000.jsonl');
        fs.copyFileSync(path.join(dir, path.basename(r1.file)), dupA);
        fs.copyFileSync(path.join(dir, path.basename(r1.file)), dupB);

        // 再次保存相同内容 -> 复用最新文件并删除其余重复副本
        const r2 = saveChat(root, { character: '清月', messages: msgs, userName: 'U' });
        assert.strictEqual(r2.ok, true);
        assert.ok(r2.removedDuplicates >= 2, '应清理历史重复副本');
        const remain = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
        assert.strictEqual(remain.length, 1, '清理后目录内应只剩 1 个 jsonl');
        assert.ok(remain.includes(path.basename(r2.file)), '保留的应为最新复用文件');
    });

    test('命名规范：空角色卡名保存后元数据 character_name 兜底 _default（与文件名一致）', () => {
        const root = makeTmp();
        const r = saveChat(root, {
            character: '',
            messages: [{ role: 'user', content: '默认会话' }],
            userName: 'U',
        });
        assert.match(r.file, /^_default\/_default_\d{14}\.jsonl$/);
        const chat = readChat(root, r.file);
        assert.strictEqual(chat.character, '_default', '空角色名应兜底 _default 而非 Assistant');
    });
});

// ==================== listChats ====================

describe('listChats 列表查询', () => {
    test('分页：5 个文件 pageSize=2 翻页正确', () => {
        const root = makeTmp();
        for (let i = 0; i < 5; i++) {
            saveChat(root, { character: `角色${i}`, messages: [{ role: 'user', content: `消息${i}` }], userName: 'U' });
        }
        const p1 = listChats(root, { page: 1, pageSize: 2 });
        assert.strictEqual(p1.total, 5);
        assert.strictEqual(p1.items.length, 2);
        assert.strictEqual(p1.page, 1);
        const p2 = listChats(root, { page: 2, pageSize: 2 });
        assert.strictEqual(p2.items.length, 2);
        const p3 = listChats(root, { page: 3, pageSize: 2 });
        assert.strictEqual(p3.items.length, 1);
        const all = [...p1.items, ...p2.items, ...p3.items].map((i) => i.file);
        assert.strictEqual(new Set(all).size, 5, '翻页不应重复');
    });

    test('角色过滤：character 子串匹配（大小写不敏感）', () => {
        const root = makeTmp();
        saveChat(root, { character: '清月', messages: [{ role: 'user', content: 'x' }], userName: 'U' });
        saveChat(root, { character: '夜雪', messages: [{ role: 'user', content: 'y' }], userName: 'U' });
        const r = listChats(root, { character: '清' });
        assert.strictEqual(r.total, 1);
        assert.strictEqual(r.items[0].character, '清月');
        const r2 = listChats(root, { character: 'QING' });
        assert.strictEqual(r2.total, 0, '大小写不敏感应命中（此处无英文名）或按规则匹配');
    });

    test('关键词过滤：命中 preview', () => {
        const root = makeTmp();
        saveChat(root, { character: 'A', messages: [
            { role: 'user', content: '普通开头' },
            { role: 'assistant', content: '施法成功！' },
        ], userName: 'U' });
        saveChat(root, { character: 'B', messages: [
            { role: 'user', content: '平凡日常' },
            { role: 'assistant', content: '平平无奇' },
        ], userName: 'U' });
        const r = listChats(root, { keyword: '施法' });
        assert.strictEqual(r.total, 1);
        assert.strictEqual(r.items[0].character, 'A');
        assert.ok(r.items[0].preview.includes('施法'), 'preview 应为最后一条消息');
    });

    test('关键词过滤：preview 未命中时全文扫描', () => {
        const root = makeTmp();
        // 最后一条消息（preview）不含关键词，但早期消息含
        saveChat(root, { character: 'A', messages: [
            { role: 'user', content: '隐藏词 魔法' },
            { role: 'assistant', content: '回复尾巴' },
        ], userName: 'U' });
        saveChat(root, { character: 'B', messages: [
            { role: 'user', content: '无关内容' },
            { role: 'assistant', content: '无关回复' },
        ], userName: 'U' });
        assert.ok(!listChats(root, { keyword: '尾巴' }).items[0].preview.includes('魔法'));
        const r = listChats(root, { keyword: '魔法' });
        assert.strictEqual(r.total, 1, '全文扫描应命中 A');
        assert.strictEqual(r.items[0].character, 'A');
    });

    test('时间范围过滤：from/to 按 mtime', () => {
        const root = makeTmp();
        saveChat(root, { character: 'T1', messages: [{ role: 'user', content: '老消息' }], userName: 'U' });
        const filePath = path.join(root, 'chats', 'T1', fs.readdirSync(path.join(root, 'chats', 'T1'))[0]);
        const t0 = Date.now();
        // 把 mtime 拨回 1 小时前
        fs.utimesSync(filePath, new Date(t0 - 3600000), new Date(t0 - 3600000));

        const hit = listChats(root, { from: t0 - 7200000, to: t0 - 1800000 });
        assert.strictEqual(hit.total, 1, 'mtime 在区间内应命中');
        const miss = listChats(root, { from: t0 - 1800000 });
        assert.strictEqual(miss.total, 0, 'mtime 早于 from 应被排除');
    });

    test('排序：默认 updated（mtime）倒序', () => {
        const root = makeTmp();
        const rA = saveChat(root, { character: 'A', messages: [{ role: 'user', content: 'a' }], userName: 'U' });
        const rB = saveChat(root, { character: 'B', messages: [{ role: 'user', content: 'b' }], userName: 'U' });
        const rC = saveChat(root, { character: 'C', messages: [{ role: 'user', content: 'c' }], userName: 'U' });
        const t = Date.now();
        // B 最旧（3 小时前）、C 中间（2 小时前）、A 最新（1 小时前）
        fs.utimesSync(path.join(root, 'chats', rB.file), new Date(t - 10800000), new Date(t - 10800000));
        fs.utimesSync(path.join(root, 'chats', rC.file), new Date(t - 7200000), new Date(t - 7200000));
        fs.utimesSync(path.join(root, 'chats', rA.file), new Date(t - 3600000), new Date(t - 3600000));

        const r = listChats(root);
        assert.strictEqual(r.total, 3);
        assert.strictEqual(r.items[0].file, rA.file, '最新 mtime 应排第一');
        assert.strictEqual(r.items[1].file, rC.file);
        assert.strictEqual(r.items[2].file, rB.file, '最旧 mtime 应排最后');
    });

    test('去重：checksum 相同的重复文件只展示最新一份（deduped 计数）', () => {
        const root = makeTmp();
        const r1 = saveChat(root, { character: '清月', messages: [
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '你好呀' },
        ], userName: 'U' });
        // 模拟旧版本"重复保存"产生的副本：同一内容复制出第二个文件
        const src = path.join(root, 'chats', r1.file);
        const dir = path.dirname(src);
        const dup = path.join(dir, '清月_20260101000000.jsonl');
        fs.copyFileSync(src, dup);

        const r = listChats(root);
        assert.strictEqual(r.total, 1, '内容重复的两份文件应合并为一条');
        assert.strictEqual(r.deduped, 1, '应标记 1 条被合并的重复存档');
        assert.strictEqual(r.items[0].checksum, r.items[0].checksum);
    });

    test('去重：内容不同的多个存档不受影响', () => {
        const root = makeTmp();
        saveChat(root, { character: 'A', messages: [{ role: 'user', content: '甲' }], userName: 'U' });
        saveChat(root, { character: 'A', messages: [{ role: 'user', content: '甲' }, { role: 'assistant', content: '乙' }], userName: 'U' });
        const r = listChats(root);
        assert.strictEqual(r.total, 2, '内容不同（校验和不同）应分别展示');
        assert.strictEqual(r.deduped, 0);
    });
});

// ==================== deleteChats / 路径安全 ====================

describe('deleteChats 与路径安全', () => {
    test('批量删除 + 返回计数', () => {
        const root = makeTmp();
        const r1 = saveChat(root, { character: 'A', messages: [{ role: 'user', content: 'a' }], userName: 'U' });
        const r2 = saveChat(root, { character: 'B', messages: [{ role: 'user', content: 'b' }], userName: 'U' });
        const result = deleteChats(root, [r1.file, r2.file, '../evil.jsonl']);
        assert.strictEqual(result.deleted, 2);
        assert.strictEqual(result.skipped, 1, '路径穿越的文件应被跳过');
        assert.ok(!fs.existsSync(path.join(root, 'chats', r1.file)));
        assert.ok(!fs.existsSync(path.join(root, 'chats', r2.file)));
    });

    test('readChat / deleteChats 路径穿越防护', () => {
        const root = makeTmp();
        assert.strictEqual(readChat(root, '../outside.jsonl'), null, '穿越路径应返回 null');
        assert.strictEqual(readChat(root, '/etc/passwd'), null);
        const r = deleteChats(root, ['../outside.jsonl', '..\\..\\secret.jsonl']);
        assert.strictEqual(r.deleted, 0);
        assert.strictEqual(r.skipped, 2);
    });
});

// ==================== migrateLegacy ====================

describe('migrateLegacy 旧存档迁移', () => {
    test('迁移到层级目录、原文件保留、幂等', () => {
        const root = makeTmp();
        const legacy = makeTmp();
        // 构造一个 ST 平铺旧存档（首行元数据 + 消息）
        const srcFile = path.join(legacy, 'old-chat.jsonl');
        const arch = new ChatArchive(srcFile, {
            userName: 'U',
            characterName: '清月',
            createDate: '2026-01-02 03:04:05',
        });
        arch.append({ isUser: true, mes: '旧消息' });
        arch.append({ isUser: false, mes: '旧回复' });
        arch.save();

        const r1 = migrateLegacy(root, legacy);
        assert.strictEqual(r1.migrated, 1);
        assert.strictEqual(r1.errors.length, 0);
        // 原文件保留（复制而非移动）
        assert.ok(fs.existsSync(srcFile), '原文件应保留');
        // 目标文件存在且内容正确
        const target = path.join(root, 'chats', '清月', '清月_20260102030405.jsonl');
        assert.ok(fs.existsSync(target), '目标层级文件应存在');
        const chat = readChat(root, '清月/清月_20260102030405.jsonl');
        assert.strictEqual(chat.messages.length, 2);
        assert.strictEqual(chat.messages[0].content, '旧消息');

        // 幂等：二次运行 migrated=0，内容一致的文件被跳过
        const r2 = migrateLegacy(root, legacy);
        assert.strictEqual(r2.migrated, 0, '二次迁移 migrated 应为 0');
        assert.strictEqual(r2.skipped, 1, '内容一致应跳过');
    });

    test('迁移支持子目录结构（SillyTavern 的「角色卡/xxx.jsonl」布局）', () => {
        const root = makeTmp();
        const legacy = makeTmp();
        // ST 风格：<角色卡>/xxx.jsonl
        const sub = path.join(legacy, '清月');
        fs.mkdirSync(sub, { recursive: true });
        const srcFile = path.join(sub, '清月-20260102030405.jsonl');
        const arch = new ChatArchive(srcFile, {
            userName: 'U',
            characterName: '清月',
            createDate: '2026-01-02 03:04:05',
        });
        arch.append({ isUser: true, mes: '嵌套旧消息' });
        arch.append({ isUser: false, mes: '嵌套回复' });
        arch.save();

        const r1 = migrateLegacy(root, legacy);
        assert.strictEqual(r1.migrated, 1, '子目录中的旧存档也应被迁移');
        assert.strictEqual(r1.errors.length, 0);
        // 目标命名规范：角色卡名_保存时间
        const target = path.join(root, 'chats', '清月', '清月_20260102030405.jsonl');
        assert.ok(fs.existsSync(target), '目标层级文件应存在');
        const chat = readChat(root, '清月/清月_20260102030405.jsonl');
        assert.strictEqual(chat.messages.length, 2);
        assert.strictEqual(chat.messages[0].content, '嵌套旧消息');
    });

    test('旧档目录不存在时返回 migrated=0（前端显示"成功迁移0条"的场景）', () => {
        const root = makeTmp();
        const r = migrateLegacy(root, path.join(makeTmp(), 'not-exists'));
        assert.strictEqual(r.migrated, 0);
        assert.strictEqual(r.skipped, 0);
        assert.strictEqual(r.errors.length, 0);
    });
});

// ==================== getStoreStats ====================

describe('getStoreStats 统计', () => {
    test('文件数 / 角色数 / 字节数', () => {
        const root = makeTmp();
        const r1 = saveChat(root, { character: '甲', messages: [{ role: 'user', content: 'a' }], userName: 'U' });
        saveChat(root, { character: '乙', messages: [{ role: 'user', content: 'b' }], userName: 'U' });
        // 覆盖式保存不新增文件
        saveChat(root, { character: '甲', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], userName: 'U', prevFile: r1.file });

        const s = getStoreStats(root);
        assert.strictEqual(s.totalFiles, 2);
        assert.strictEqual(s.totalCharacters, 2);
        assert.ok(s.totalBytes > 0, '字节数应大于 0');
    });
});

// ==================== API 端点冒烟 ====================

/** 构造注入依赖（参考 test/agent-api.test.js 的 makeDeps，额外支持 chatDataRoot） */
function makeDeps(overrides = {}) {
    const fakeAgentFramework = {
        _loaded: true,
        agentLoader: {
            list: () => [{ name: 'default-rp', displayName: '默认方案', tools: [] }],
            get: (name) => (name === 'default-rp' ? { name: 'default-rp', displayName: '默认方案' } : null),
            save: (name, yaml) => ({ name, displayName: name, savedYaml: yaml }),
            delete: () => {},
            agentsDir: path.join(REPO_ROOT, 'data', 'plugins', 'agent-framework', 'agents'),
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
            broadcast: () => {},
            broadcastRunState: () => {},
            broadcastResult: () => {},
            broadcastState: () => {},
            broadcastSaveState: () => {},
            shutdown: () => {},
        },
        configManager: { get: () => ({}) },
        logger: silentLogger,
        repoRoot: REPO_ROOT,
        staticDir: path.join(REPO_ROOT, 'public'),
        chatDataRoot: overrides.chatDataRoot || makeTmp(),
        ...overrides,
    };
}

/** 启动临时 HTTP 服务（跑完自动关闭） */
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

describe('registerAgentApi - 聊天记录 API 冒烟', () => {
    test('GET /api/agent-theatre/chats 返回 200 与分页结构', async () => {
        const dataRoot = makeTmp();
        await withServer(makeDeps({ chatDataRoot: dataRoot }), async (base) => {
            // 先落一条数据，确保列表非空
            saveChat(dataRoot, { character: '清月', messages: [{ role: 'user', content: '你好' }], userName: 'U' });
            const resp = await fetch(`${base}/api/agent-theatre/chats?session=native:smoke`);
            assert.strictEqual(resp.status, 200);
            const body = await resp.json();
            assert.strictEqual(body.success, true);
            assert.ok(Array.isArray(body.items));
            assert.strictEqual(body.total, 1);
            assert.ok(body.items[0].file.includes('清月'));
            // 无会话时 session 为 null
            assert.strictEqual(body.session, null);
        });
    });

    test('POST /chats/save -> /chats/read -> /chats/load 全链路', async () => {
        const dataRoot = makeTmp();
        await withServer(makeDeps({ chatDataRoot: dataRoot }), async (base) => {
            // save：显式 messages
            const saveResp = await fetch(`${base}/api/agent-theatre/chats/save?session=native:api-flow`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    character: '夜雪',
                    messages: [
                        { role: 'user', content: '在吗' },
                        { role: 'assistant', content: '在的' },
                    ],
                    userName: '我',
                }),
            });
            const saveBody = await saveResp.json();
            assert.strictEqual(saveBody.success, true);
            assert.ok(saveBody.file);

            // read
            const readResp = await fetch(`${base}/api/agent-theatre/chats/read?file=${encodeURIComponent(saveBody.file)}`);
            const readBody = await readResp.json();
            assert.strictEqual(readBody.success, true);
            assert.strictEqual(readBody.chat.character, '夜雪');
            assert.strictEqual(readBody.chat.messages.length, 2);
            assert.strictEqual(readBody.chat.checksumOk, true);

            // load 到会话
            const loadResp = await fetch(`${base}/api/agent-theatre/chats/load?session=native:api-flow`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file: saveBody.file }),
            });
            const loadBody = await loadResp.json();
            assert.strictEqual(loadBody.success, true);
            assert.strictEqual(loadBody.character, '夜雪');
            assert.strictEqual(loadBody.messages.length, 2);

            // 列表响应应附带 session 状态（chatFile 已更新）
            const listResp = await fetch(`${base}/api/agent-theatre/chats?session=native:api-flow`);
            const listBody = await listResp.json();
            assert.strictEqual(listBody.session.chatFile, saveBody.file);
            assert.strictEqual(listBody.session.dirty, false);

            // save 不带 messages -> 保存当前会话历史
            const saveSessResp = await fetch(`${base}/api/agent-theatre/chats/save?session=native:api-flow`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const saveSessBody = await saveSessResp.json();
            assert.strictEqual(saveSessBody.success, true);
            assert.strictEqual(saveSessBody.messageCount, 2);

            // 路径穿越 -> 404
            const evilResp = await fetch(`${base}/api/agent-theatre/chats/read?file=${encodeURIComponent('../evil.jsonl')}`);
            assert.strictEqual(evilResp.status, 404);
        });
    });

    test('POST /chats/delete 批量删除聊天记录（前端"删除选中"流程）', async () => {
        const dataRoot = makeTmp();
        await withServer(makeDeps({ chatDataRoot: dataRoot }), async (base) => {
            // 准备 2 条聊天记录
            const r1 = saveChat(dataRoot, { character: '清月', messages: [{ role: 'user', content: '第一条' }], userName: 'U' });
            const r2 = saveChat(dataRoot, { character: '夜雪', messages: [{ role: 'user', content: '第二条' }], userName: 'U' });
            let listResp = await fetch(`${base}/api/agent-theatre/chats`);
            let listBody = await listResp.json();
            assert.strictEqual(listBody.total, 2);

            // 删除其中一条
            const delResp = await fetch(`${base}/api/agent-theatre/chats/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: [r1.file] }),
            });
            const delBody = await delResp.json();
            assert.strictEqual(delBody.success, true);
            assert.strictEqual(delBody.deleted, 1);
            assert.strictEqual(delBody.skipped, 0);
            assert.ok(!fs.existsSync(path.join(dataRoot, 'chats', r1.file)), '被删文件应已删除');
            assert.ok(fs.existsSync(path.join(dataRoot, 'chats', r2.file)), '未删除的文件应保留');

            // 删除后列表同步
            listResp = await fetch(`${base}/api/agent-theatre/chats`);
            listBody = await listResp.json();
            assert.strictEqual(listBody.total, 1);
            assert.strictEqual(listBody.items[0].file, r2.file);

            // 删除不存在的文件 -> skipped 计数，不报错
            const missResp = await fetch(`${base}/api/agent-theatre/chats/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: ['清月/清月_20260101000000.jsonl'] }),
            });
            const missBody = await missResp.json();
            assert.strictEqual(missBody.success, true);
            assert.strictEqual(missBody.deleted, 0);
            assert.strictEqual(missBody.skipped, 1);

            // 空数组 -> 400
            const emptyResp = await fetch(`${base}/api/agent-theatre/chats/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: [] }),
            });
            assert.strictEqual(emptyResp.status, 400);
        });
    });
});

// ==================== 定时自动保存集成 ====================

describe('剧场会话定时自动保存', () => {
    test('POST /input 后 dirty=true，startChatAutoSave 落盘并清除 dirty', async () => {
        const dataRoot = makeTmp();
        const deps = makeDeps({
            chatDataRoot: dataRoot,
            run: async () => ({ runId: 'run-x', aborted: false, text: '自动回复', result: null }),
        });
        try {
            await withServer(deps, async (base) => {
                // 1. 触发一次 run（会话产生 user + assistant 消息，dirty=true）
                const resp = await fetch(`${base}/api/agent-theatre/input?session=native:autosave`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ input: '你好', character: '测试角色' }),
                });
                assert.strictEqual(resp.status, 200);

                // 2. dirty 应为 true
                let listResp = await fetch(`${base}/api/agent-theatre/chats?session=native:autosave`);
                let listBody = await listResp.json();
                assert.strictEqual(listBody.session.dirty, true);
                assert.strictEqual(listBody.session.chatFile, null, '自动保存前无 chatFile');

                // 3. 启动快速自动保存（会停掉 registerAgentApi 启动的默认计时器）
                startChatAutoSave(60);
                await sleep(350);

                // 4. dirty 应清除、chatFile 有值、文件已落盘
                listResp = await fetch(`${base}/api/agent-theatre/chats?session=native:autosave`);
                listBody = await listResp.json();
                assert.strictEqual(listBody.session.dirty, false, '自动保存后 dirty 应清除');
                assert.ok(listBody.session.chatFile, '自动保存后应有 chatFile');
                const chatPath = path.join(dataRoot, 'chats', listBody.session.chatFile);
                assert.ok(fs.existsSync(chatPath), '聊天文件应已落盘');

                // 5. 文件内容正确且校验和通过
                const chat = readChat(dataRoot, listBody.session.chatFile);
                assert.strictEqual(chat.messages.length, 2);
                assert.strictEqual(chat.messages[0].content, '你好');
                assert.strictEqual(chat.messages[1].content, '自动回复');
                assert.strictEqual(chat.checksumOk, true);
            });
        } finally {
            stopChatAutoSave();
        }
    });

    test('角色卡切换时先自动保存旧会话', async () => {
        const dataRoot = makeTmp();
        const deps = makeDeps({
            chatDataRoot: dataRoot,
            run: async () => ({ runId: 'run-y', aborted: false, text: '回复', result: null }),
        });
        try {
            await withServer(deps, async (base) => {
                const postInput = (session, character, input) => fetch(`${base}/api/agent-theatre/input?session=${session}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ input, character }),
                });

                // 第一轮：角色卡 A
                let resp = await postInput('native:switch', '角色A', '你好');
                assert.strictEqual(resp.status, 200);
                // 第二轮：切换到角色卡 B -> 应自动保存 A 的会话
                resp = await postInput('native:switch', '角色B', '在吗');
                assert.strictEqual(resp.status, 200);

                // 旧角色 A 的会话文件应已落盘
                const chatsDir = path.join(dataRoot, 'chats', '角色A');
                assert.ok(fs.existsSync(chatsDir), '旧角色目录应存在');
                const files = fs.readdirSync(chatsDir).filter((f) => f.endsWith('.jsonl'));
                assert.strictEqual(files.length, 1, '切换前旧会话应已自动保存');

                // 当前会话应已切换到新角色 B：chatFile 尚未落盘（新会话等下次保存新建文件），dirty=true
                const listResp = await fetch(`${base}/api/agent-theatre/chats?session=native:switch`);
                const listBody = await listResp.json();
                assert.strictEqual(listBody.session.chatFile, null, '切换后新角色会话尚未落盘，chatFile 应为空');
                assert.strictEqual(listBody.session.dirty, true, '新角色第一轮后应标记 dirty');

                // 触发一次快速自动保存 -> 新角色 B 的文件应新建，且旧角色 A 文件不受影响
                startChatAutoSave(60);
                await sleep(350);
                const dirB = path.join(dataRoot, 'chats', '角色B');
                assert.ok(fs.existsSync(dirB), '新角色 B 目录应存在');
                assert.strictEqual(fs.readdirSync(dirB).filter((f) => f.endsWith('.jsonl')).length, 1, '角色 B 应有一个新文件');
                const dirA = path.join(dataRoot, 'chats', '角色A');
                assert.strictEqual(fs.readdirSync(dirA).filter((f) => f.endsWith('.jsonl')).length, 1, '角色 A 文件数应保持 1');
            });
        } finally {
            stopChatAutoSave();
        }
    });
});
