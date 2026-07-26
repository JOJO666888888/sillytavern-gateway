#!/usr/bin/env node
/**
 * 拿真实 SillyTavern 资产压一遍自建管线的解析器。
 *
 * 存在的理由：card-loader / worldbook-engine / preset-engine / chat-archive
 * 此前只吃过 test/helpers.js 里手写的合成 fixture。真实 ST 数据是另一回事——
 * 卡片有 V1/V2/V3 三种规格、世界书 entries 可能是对象也可能是数组、
 * 预设来自不同 ST 版本、存档里混着历史遗留字段。合成样本测不出这些。
 *
 * 用法：
 *   node scripts/validate-st-assets.js [ST数据目录]
 *   默认 /root/SillyTavern/data/default-user
 *
 * 只读，不写任何东西。退出码非 0 表示有解析失败。
 */
import fs from 'fs';
import path from 'path';
import { loadCharacterCard } from '../server/runtime/card-loader.js';
import { loadLorebook, activateEntries } from '../server/runtime/worldbook-engine.js';
import { loadPreset, buildPrompt } from '../server/runtime/preset-engine.js';
import { ChatArchive } from '../server/runtime/chat-archive.js';

const ST_DATA = process.argv[2] || '/root/SillyTavern/data/default-user';
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };
const results = [];

/** 只列目录下直接的文件，不递归 —— characters/ 的子目录里是表情立绘，不是角色卡 */
function filesIn(dir, ext) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.toLowerCase().endsWith(ext))
        .map(e => path.join(dir, e.name));
}

/** 递归列出（聊天存档按角色分子目录存放，需要递归） */
function walk(dir, ext) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p, ext));
        else if (e.name.toLowerCase().endsWith(ext)) out.push(p);
    }
    return out;
}

function run(label, files, fn) {
    const fails = [];
    const notes = [];
    for (const f of files) {
        try {
            const n = fn(f);
            if (n) notes.push({ file: path.basename(f), n });
        } catch (e) {
            fails.push({ file: path.basename(f), err: e.message });
        }
    }
    results.push({ label, total: files.length, fails, notes });
    const color = fails.length ? C.r : C.g;
    console.log(`\n${color}■${C.x} ${label}: ${files.length - fails.length}/${files.length} 解析成功`);
    for (const { file, err } of fails.slice(0, 10)) {
        console.log(`   ${C.r}✗${C.x} ${file}\n     ${C.d}${err}${C.x}`);
    }
    if (fails.length > 10) console.log(`   ${C.d}…还有 ${fails.length - 10} 个失败${C.x}`);
    for (const { file, n } of notes.slice(0, 6)) console.log(`   ${C.y}!${C.x} ${file} — ${n}`);
    if (notes.length > 6) console.log(`   ${C.d}…还有 ${notes.length - 6} 条提示${C.x}`);
}

console.log(`ST 数据目录: ${ST_DATA}`);

// ── 角色卡 ───────────────────────────────────────────────
const cards = filesIn(path.join(ST_DATA, 'characters'), '.png');
const cardStats = { v1: 0, v2: 0, v3: 0, withBook: 0, emptyPersona: 0 };
run('角色卡 (PNG tEXt/zTXt)', cards, (f) => {
    const c = loadCharacterCard(f);
    if (!c) throw new Error('返回 null/undefined');
    if (!c.name) return '解析出的卡没有 name';
    const spec = String(c.spec || 'v1');
    if (spec.includes('v3')) cardStats.v3++; else if (spec.includes('v2')) cardStats.v2++; else cardStats.v1++;
    if (c.characterBook) cardStats.withBook++;
    // 三字段全空在现代中文卡里很常见（内容都放内嵌 character_book 里），
    // 只有当它同时没有内嵌世界书时才真的等于"这张卡没有人设"
    if (!c.description && !c.personality && !c.scenario) {
        cardStats.emptyPersona++;
        if (!c.characterBook) return '人设三字段全空且无内嵌世界书 → 注入后几乎没有内容';
    }
    return null;
});
console.log(`   ${C.d}规格分布: V3=${cardStats.v3} V2=${cardStats.v2} V1=${cardStats.v1}`
    + ` | 带内嵌世界书 ${cardStats.withBook} 张 | 人设三字段为空 ${cardStats.emptyPersona} 张${C.x}`);

// ── 世界书 ───────────────────────────────────────────────
const books = filesIn(path.join(ST_DATA, 'worlds'), '.json');
let bookEntryTotal = 0, bookActivated = 0;
run('世界书 (lorebook)', books, (f) => {
    // loadLorebook 直接返回归一化后的条目数组
    const entries = loadLorebook(f);
    if (!Array.isArray(entries)) throw new Error(`应返回数组，实际 ${typeof entries}`);
    bookEntryTotal += entries.length;
    if (entries.length === 0) return '归一化后 0 条（可能全是空内容条目）';
    const kws = entries.flatMap(e => e.keys || []).filter(Boolean);
    const act = activateEntries(entries, kws.slice(0, 30).join(' ') || 'x', { scanDepth: 5, maxRecursion: 2 });
    if (!act || !Array.isArray(act.activated)) throw new Error('activateEntries 返回结构异常');
    bookActivated += act.activated.length;
    const hasConstant = entries.some(e => e.constant);
    if (kws.length > 0 && act.activated.length === 0 && !hasConstant) {
        return `${entries.length} 条、关键词齐全，但用自己的关键词扫描激活出 0 条`;
    }
    return null;
});
console.log(`   ${C.d}共归一化 ${bookEntryTotal} 条条目，自扫描共激活 ${bookActivated} 条${C.x}`);

// ── 预设 ─────────────────────────────────────────────────
const presets = ['OpenAI Settings', 'TextGen Settings', 'presets']
    .flatMap(d => filesIn(path.join(ST_DATA, d), '.json'));
let stOrderCount = 0, litChars = 0;
run('预设 (prompt_order 还原)', presets, (f) => {
    const p = loadPreset(f);
    if (!p) throw new Error('返回 null/undefined');
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
    const isChatCompletion = Array.isArray(raw.prompts) && raw.prompts.length > 0
        && Array.isArray(raw.prompt_order);
    if (!isChatCompletion) return null;   // 不是 ChatCompletion 预设，不适用
    if (p.orderSource !== 'st_prompt_order') {
        return `有 ${raw.prompts.length} 条 prompts + prompt_order，却回退成 ${p.orderSource}`;
    }
    stOrderCount++;
    const lits = (p.order || []).filter(x => x && typeof x === 'object' && x.type === 'literal');
    litChars += lits.reduce((n, x) => n + (x.content || '').length, 0);
    if ((p.order || []).length === 0) return `prompt_order 还原出空顺序`;
    return null;
});
console.log(`   ${C.d}${stOrderCount} 个预设走 ST prompt_order 还原，共保留 ${litChars} 字符的固定文本${C.x}`);

// ── 聊天存档 ─────────────────────────────────────────────
const chats = walk(path.join(ST_DATA, 'chats'), '.jsonl');
let msgTotal = 0;
run('聊天存档 (.jsonl 与 ST 互通)', chats, (f) => {
    const lines = fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean);
    // 构造函数已经 load() 过了，不要再调一次
    const a = new ChatArchive(f);
    if (!Array.isArray(a.messages)) throw new Error('messages 不是数组');
    msgTotal += a.messages.length;
    if (lines.length <= 1) return null;
    const expected = lines.length - 1;   // 首行是 metadata
    if (a.messages.length !== expected) {
        return `条数对不上：文件 ${expected} 条，解析出 ${a.messages.length} 条`;
    }
    return null;
});
console.log(`   ${C.d}共读入 ${msgTotal} 条历史消息${C.x}`);

// load() 幂等性：ST 在外部改了存档文件后重新载入是这套互通功能的正常用法
console.log(`\n${C.d}── load() 幂等性 ──${C.x}`);
if (chats.length) {
    const a = new ChatArchive(chats[0]);
    const n1 = a.messages.length;
    a.load();
    const n2 = a.messages.length;
    if (n1 !== n2) {
        console.log(`   ${C.r}✗${C.x} 重复 load() 会累加：${n1} → ${n2}（应保持 ${n1}）`);
        results.push({ label: 'load() 幂等', total: 1, fails: [{ file: path.basename(chats[0]), err: `${n1} → ${n2}` }], notes: [] });
    } else {
        console.log(`   ${C.g}✓${C.x} 重复 load() 保持 ${n1} 条`);
    }
}

// ── 端到端：真卡 + 真世界书 + 真预设 组装一次 prompt ────────
console.log(`\n${C.d}── 端到端：用真实资产组装 prompt（不调 LLM）──${C.x}`);
try {
    const card = cards.length ? loadCharacterCard(cards[0]) : null;
    const entries = books.length ? loadLorebook(books[0]) : [];
    const preset = presets.length ? loadPreset(presets[0]) : null;
    const scan = [card?.description, card?.firstMes, '你好'].filter(Boolean).join(' ');
    const world = activateEntries(entries, scan, { scanDepth: 5, maxRecursion: 2 });
    // buildPrompt 的入参是 card（不是 character），返回 { messages, sampling }
    const { messages: msgs, sampling } = buildPrompt({
        card, preset, world,
        history: [{ role: 'user', content: '你好' }],
        userInput: '你好',
        userName: '测试用户',
    });
    if (!Array.isArray(msgs) || msgs.length === 0) throw new Error(`buildPrompt 返回 ${JSON.stringify(msgs).slice(0, 80)}`);
    const chars = msgs.reduce((n, m) => n + String(m.content ?? '').length, 0);
    console.log(`   ${C.g}✓${C.x} ${msgs.length} 条 message，正文合计 ${chars} 字符`);
    console.log(`   ${C.d}卡=${card?.name}  世界书=${path.basename(books[0] || '-')}(激活 ${world.activated?.length ?? 0} 条)  预设=${path.basename(presets[0] || '-')}${C.x}`);
    console.log(`   ${C.d}role 分布: ${[...new Set(msgs.map(m => m.role))].join(', ')}  采样参数: ${Object.keys(sampling || {}).join(',') || '(空)'}${C.x}`);
} catch (e) {
    console.log(`   ${C.r}✗${C.x} 组装失败: ${e.message}`);
    console.log(`   ${C.d}${(e.stack || '').split('\n').slice(1, 3).join('\n')}${C.x}`);
    results.push({ label: '端到端组装', total: 1, fails: [{ file: '-', err: e.message }], notes: [] });
}

const totalFail = results.reduce((n, r) => n + r.fails.length, 0);
const totalNote = results.reduce((n, r) => n + r.notes.length, 0);
const totalAll = results.reduce((n, r) => n + r.total, 0);
console.log(`\n${'─'.repeat(62)}`);
console.log(`共 ${totalAll} 个文件：${totalFail ? C.r : C.g}${totalFail} 个失败${C.x}，${totalNote} 条提示`);
process.exit(totalFail > 0 ? 1 : 0);
