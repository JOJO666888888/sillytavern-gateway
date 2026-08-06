/**
 * 角色卡与世界书工具
 * 提供 character.read / worldbook.search：
 * - 供模板工作流"按需查阅角色卡与世界书"步骤使用（如 default-rp.yaml 工作流程第 3 步）
 * - 复用 server/runtime/card-loader.js 与 worldbook-engine.js 的归一化实现（支持 PNG 内嵌卡 / V1-V3 / 世界书条目归一化）
 *
 * P0-1 修复：此前 6 个模板 + 文档均声明了这两个工具，但从未在 ToolRegistry 注册，
 * getDeclarations 对缺失工具静默跳过，模型实际拿不到它们，导致默认方案工作流步骤无法执行。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadCharacterCardByName, listCharacterCards } from '../../../server/runtime/card-loader.js';
import { loadLorebook, normalizeLorebook } from '../../../server/runtime/worldbook-engine.js';

// ESM 没有 __dirname，手动构造
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// assets 根目录：与 server/plugin-permissions.js createAssetsService 保持一致（<repo>/assets）
const ASSETS_DIR = path.resolve(__dirname, '..', '..', '..', 'assets');
const CHARACTERS_DIR = path.join(ASSETS_DIR, 'characters');
const WORLDBOOKS_DIR = path.join(ASSETS_DIR, 'worldbooks');

/** 截断长文本为摘要片段 */
function truncate(text, max = 800) {
    const t = String(text || '').trim();
    if (t.length <= max) return t;
    return t.slice(0, max) + '…';
}

/** 列出世界书文件名（.json） */
function listWorldbookFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
}

/** 精确（含大小写回退）匹配世界书文件 */
function pickWorldbookFile(dir, name) {
    if (!fs.existsSync(dir)) return null;
    const ext = name.toLowerCase().endsWith('.json') ? '' : '.json';
    const exact = path.join(dir, name + ext);
    if (fs.existsSync(exact)) return exact;
    const base = name.toLowerCase();
    for (const f of listWorldbookFiles(dir)) {
        if (f.toLowerCase() === base + '.json') return path.join(dir, f);
    }
    return null;
}

/** 把世界书条目内容扁平化为 {book, uid, keys, content} 便于检索 */
function flattenEntries(entries) {
    return entries
        .filter(e => e && e.content)
        .map(e => ({
            uid: e.uid ?? '',
            keys: Array.isArray(e.keys) ? e.keys : [],
            content: e.content,
        }));
}

/** 判断条目是否命中查询关键词（keys 或 content 任一命中） */
function entryHit(entry, terms) {
    const haystack = [entry.content, ...entry.keys].join('\n').toLowerCase();
    return terms.some(t => haystack.includes(t));
}

export function createCharacterTools(options = {}) {
    // 允许测试注入资产目录（默认指向 <repo>/assets）
    const charsDir = options.charactersDir || CHARACTERS_DIR;
    const wbDir = options.worldbooksDir || WORLDBOOKS_DIR;

    const listWorldbookFilesFor = (dir) => {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    };

    return [
        {
            name: 'character.read',
            description: '按需读取角色卡设定（归一化返回 name/description/personality/scenario/mesExample/内嵌世界书概览）。用于查阅角色设定细节，不要全量塞进上下文。',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: '角色名（可带或不带 .json/.png 扩展名）' },
                },
                required: ['name'],
            },
            handler: async (args) => {
                const name = String(args?.name || '').trim();
                if (!name) return { error: '请提供角色名 name' };
                let card = null;
                try {
                    card = loadCharacterCardByName(charsDir, name);
                } catch (e) {
                    return { error: `角色卡解析失败: ${e.message}` };
                }
                if (!card) {
                    const available = listCharacterCards(charsDir).map(c => c.name);
                    return {
                        error: `角色卡不存在: ${name}`,
                        recoverable: true,
                        details: { available: available.length ? available : '(无角色卡)' },
                    };
                }
                return {
                    name: card.name || name,
                    description: truncate(card.description, 1500),
                    personality: truncate(card.personality, 1500),
                    scenario: truncate(card.scenario, 800),
                    mesExample: truncate(card.mesExample, 800),
                    systemPrompt: truncate(card.systemPrompt, 800),
                    postHistoryInstructions: truncate(card.postHistoryInstructions, 400),
                    alternateGreetingsCount: card.alternateGreetings?.length || 0,
                    characterBook: card.characterBook
                        ? {
                            name: card.characterBook.name || '',
                            entries: Array.isArray(card.characterBook.entries) ? card.characterBook.entries.length : 0,
                        }
                        : null,
                };
            },
        },
        {
            name: 'worldbook.search',
            description: '在世界书中按关键词检索设定条目，返回命中的条目内容片段。book 可选（不传则搜索全部世界书）。用于按需查阅世界观设定，不要全量塞进上下文。',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: '检索关键词（多个词用空格分隔，任一命中即返回）' },
                    book: { type: 'string', description: '世界书名（可选，默认搜索全部世界书）' },
                    limit: { type: 'number', description: '返回条目数上限（默认3，最多10）' },
                },
                required: ['query'],
            },
            handler: async (args) => {
                const query = String(args?.query || '').trim();
                if (!query) return { error: '请提供检索关键词 query' };
                const bookName = String(args?.book || '').trim();
                const limit = Math.max(1, Math.min(10, Number(args?.limit) || 3));
                const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

                // 收集 (book, filePath) 列表：指定书则单本，否则全部
                const books = [];
                if (bookName) {
                    const filePath = pickWorldbookFile(wbDir, bookName);
                    if (!filePath) {
                        const available = listWorldbookFilesFor(wbDir).map(f => f.replace(/\.json$/, ''));
                        return {
                            error: `世界书不存在: ${bookName}`,
                            recoverable: true,
                            details: { available: available.length ? available : '(无世界书)' },
                        };
                    }
                    books.push({ name: bookName, filePath });
                } else {
                    for (const f of listWorldbookFilesFor(wbDir)) {
                        books.push({ name: f.replace(/\.json$/, ''), filePath: path.join(wbDir, f) });
                    }
                }

                if (books.length === 0) {
                    return { error: '未找到任何世界书', recoverable: true, details: { available: [] } };
                }

                const hits = [];
                for (const { name, filePath } of books) {
                    let entries = [];
                    try {
                        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                        entries = normalizeLorebook(raw);
                    } catch (e) {
                        entries = []; // 单本解析失败跳过
                    }
                    for (const entry of flattenEntries(entries)) {
                        if (entryHit(entry, terms)) {
                            hits.push({
                                book: name,
                                keys: entry.keys,
                                content: truncate(entry.content, 800),
                            });
                            if (hits.length >= limit) break;
                        }
                    }
                    if (hits.length >= limit) break;
                }

                if (hits.length === 0) {
                    return { error: `未在世界书中检索到与「${query}」相关的条目`, recoverable: true, details: { queriedBooks: books.map(b => b.name) } };
                }
                return { query, count: hits.length, results: hits };
            },
        },
    ];
}
