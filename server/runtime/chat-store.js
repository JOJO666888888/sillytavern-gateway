/**
 * 后端聊天记录存储层（Agent 剧场聊天存档管理）
 *
 * 存储结构（层级化）：
 *   <dataRoot>/chats/
 *     <角色卡名标准化>/
 *       <角色卡名标准化>_<YYYYMMDDHHMMSS>.jsonl
 *
 * 文件内容与 SillyTavern 互通（复用 ChatArchive 的 JSONL 格式）：
 * 首行为元数据（user_name/character_name/create_date/chat_metadata.checksum），
 * 其余每行一条消息 { name, is_user, is_system, send_date, mes }。
 *
 * 设计要点：
 *   - 路径安全是硬性要求：所有文件操作先解析并校验位于 <dataRoot>/chats/ 内，防目录穿越；
 *   - 保存为同步 fs 调用（简单可靠），"后台执行"由调用方（定时器 / API）异步性体现；
 *   - 覆盖式保存用 ChatArchive 重建 + 原子写（.tmp + rename），失败自动重试最多 3 次；
 *   - 保存前自动备份（.bak-<ts>）：保存成功清理备份，失败保留备份便于恢复；
 *   - 校验和：chat_metadata.checksum = sha256(非 system 消息 "role|content" 拼接)。
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { ChatArchive } from './chat-archive.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('chat-store');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 默认数据根目录（与 context-builder 的 dataDir 默认值一致）：
 * <repoRoot>/data/plugins/agent-framework
 */
export const DEFAULT_DATA_ROOT = path.resolve(__dirname, '..', '..', 'data', 'plugins', 'agent-framework');

/** 保存失败时的最大尝试次数（初始 1 次 + 最多重试 2 次 = 3 次尝试） */
const MAX_ATTEMPTS = 3;

/**
 * 角色卡名标准化：
 *   删除首尾空白；非法字符 `/ \ : * ? " < > |` 与控制字符替换为 `_`；
 *   多个连续 `_` 合并为单 `_`；结果为空或全 `_` 时返回 `_default`；截断到 80 字符。
 * @param {string} name - 原始角色卡名
 * @returns {string}
 */
export function sanitizeName(name) {
    if (typeof name !== 'string') name = '';
    let s = name.trim();
    // 非法字符与控制字符全部替换为 _
    s = s.replace(/[/\\:*?"<>|]/g, '_').replace(/[\u0000-\u001F\u007F]/g, '_');
    // 多个连续 _ 合并为单 _
    s = s.replace(/_+/g, '_');
    // 结果为空或全 _ 时兜底
    if (!s || /^_+$/.test(s)) s = '_default';
    // 截断到 80 字符
    if (s.length > 80) s = s.slice(0, 80);
    return s;
}

/**
 * 生成时间戳字符串 `YYYYMMDDHHMMSS`（本地时区，零填充）。
 * @param {Date|number} [date] - 日期（默认当前时间）
 * @returns {string}
 */
export function timestamp(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
        `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 计算聊天记录校验和：sha256(消息行内容拼接)。
 * 规则：每条消息 `role|content` 用 \u0001 连接，多条消息整体用 \u0002 连接，取 hex。
 * 只对非 system 消息计算（system 消息为内部提示，不参与内容完整性校验）。
 * @param {Array<{role:string, content?:string}>} messages
 * @returns {string}
 */
export function computeChecksum(messages) {
    const parts = (messages || [])
        .filter((m) => m && m.role !== 'system')
        .map((m) => `${m.role}\u0001${m.content ?? ''}`);
    return createHash('sha256').update(parts.join('\u0002')).digest('hex');
}

/**
 * 解析 ST 风格 create_date（"YYYY-MM-DD HH:MM:SS"，本地时区）为毫秒时间戳。
 * @param {*} str
 * @returns {number|null}
 */
function _parseCreateDate(str) {
    if (typeof str !== 'string') return null;
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{1,2}):(\d{1,2})/.exec(str.trim());
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** 格式化 create_date 为 ST 兼容的 "YYYY-MM-DD HH:MM:SS" */
function _formatCreateDate(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 解析并校验聊天文件相对路径：解析后必须位于 <dataRoot>/chats/ 内，否则返回 null。
 * @param {string} dataRoot
 * @param {string} fileRel - 相对路径，如 "清月/清月_20260805103000.jsonl"
 * @returns {string|null} 绝对路径或 null（非法/穿越）
 */
function _resolvePath(dataRoot, fileRel) {
    if (typeof fileRel !== 'string' || !fileRel.trim()) return null;
    const chatsRoot = path.join(dataRoot, 'chats');
    const resolved = path.resolve(chatsRoot, fileRel);
    const rel = path.relative(chatsRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return resolved;
}

/** 把绝对路径转成相对 <dataRoot>/chats/ 的正斜杠相对路径（如 "清月/清月_x.jsonl"） */
function _toRelFile(dataRoot, targetPath) {
    const chatsRoot = path.join(dataRoot, 'chats');
    return path.relative(chatsRoot, targetPath).replace(/\\/g, '/');
}

/**
 * 解析聊天文件完整路径（目录自动创建）。
 * @param {string} dataRoot
 * @param {string} character - 角色卡名（空时用 _default）
 * @param {Date} [date] - 文件名时间戳基准
 * @returns {string} 绝对路径
 */
export function resolveChatFile(dataRoot, character, date = new Date()) {
    const dirName = sanitizeName(character);
    const filePath = path.join(dataRoot, 'chats', dirName, `${dirName}_${timestamp(date)}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return filePath;
}

/**
 * 扫描单个聊天文件，返回列表项元数据（只读首行 + 行数，不做全量 JSON 解析）。
 * @param {string} filePath - 绝对路径
 * @param {string} dirName - 所在目录名（角色目录）
 * @returns {object|null}
 */
function _scanChatFile(filePath, dirName) {
    let st;
    try { st = fs.statSync(filePath); } catch { return null; }
    let text;
    try { text = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
    const lines = text.split('\n').filter((l) => l.length > 0);

    // 首行元数据判定（与 ChatArchive.load 一致）
    let meta = null;
    let start = 0;
    if (lines.length > 0) {
        try {
            const first = JSON.parse(lines[0]);
            if (first && (first.user_name !== undefined || first.character_name !== undefined || first.chat_metadata !== undefined)) {
                meta = first;
                start = 1;
            }
        } catch { /* 首行非元数据，当作消息 */ }
    }

    const character = (meta && meta.character_name) || dirName || '_default';
    // 校验和：同一会话不同时间的重复存档内容一致，checksum 相同（用于列表去重）
    const chatMeta = (meta && meta.chat_metadata && typeof meta.chat_metadata === 'object') ? meta.chat_metadata : {};
    const checksum = typeof chatMeta.checksum === 'string' ? chatMeta.checksum : null;
    // 多存档系统：自定义存档元数据（名称 / 描述），挂在 chat_metadata，不破坏 ST 兼容
    const name = (typeof chatMeta.name === 'string' && chatMeta.name.trim()) ? chatMeta.name.trim() : '';
    const description = (typeof chatMeta.description === 'string') ? chatMeta.description.trim() : '';

    // preview：最后一条非系统消息，从后往前找（最多解析 30 行，防恶意长尾系统消息拖慢）
    let preview = '';
    let parsed = 0;
    for (let i = lines.length - 1; i >= start && parsed < 30; i--) {
        parsed++;
        let m = null;
        try { m = JSON.parse(lines[i]); } catch { continue; }
        if (!m || m.is_system) continue;
        preview = typeof m.mes === 'string' ? m.mes : '';
        break;
    }
    if (preview.length > 60) preview = preview.slice(0, 60);

    return {
        file: path.posix.join(dirName, path.basename(filePath)),
        character,
        name,
        description,
        createdAt: _parseCreateDate(meta && meta.create_date) || st.mtimeMs,
        updatedAt: st.mtimeMs,
        messageCount: lines.length - start,
        preview,
        checksum,
    };
}

/**
 * 列出聊天记录（分页 / 过滤 / 排序）。
 * @param {string} dataRoot
 * @param {object} [options]
 * @param {string} [options.character] - 角色卡名包含匹配（目录名 / 元数据 character_name，大小写不敏感）
 * @param {string} [options.keyword] - 关键词：先扫 preview，未命中再全文扫描消息行
 * @param {number} [options.from] - updatedAt 下界（ms）
 * @param {number} [options.to] - updatedAt 上界（ms）
 * @param {number} [options.page=1]
 * @param {number} [options.pageSize=20]
 * @param {string} [options.sort='updated'] - 'updated'（mtime 倒序，默认）| 'created'（create_date 倒序）
 * @returns {{total:number, page:number, pageSize:number, items:Array, deduped:number}}
 *   deduped 为因校验和相同被合并（隐藏）的重复存档条数。
 */
export function listChats(dataRoot, options = {}) {
    const {
        character = '',
        keyword = '',
        from,
        to,
        page = 1,
        pageSize = 20,
        sort = 'updated',
    } = options;

    const chatsRoot = path.join(dataRoot, 'chats');
    const items = [];
    if (fs.existsSync(chatsRoot)) {
        for (const dirName of fs.readdirSync(chatsRoot)) {
            const dirPath = path.join(chatsRoot, dirName);
            let dirStat;
            try { dirStat = fs.statSync(dirPath); } catch { continue; }
            if (!dirStat.isDirectory()) continue;
            for (const f of fs.readdirSync(dirPath)) {
                if (!f.endsWith('.jsonl')) continue;
                const item = _scanChatFile(path.join(dirPath, f), dirName);
                if (item) items.push(item);
            }
        }
    }

    // 过滤
    const kw = String(keyword || '').trim().toLowerCase();
    const charFilter = String(character || '').trim().toLowerCase();
    const fromNum = from != null ? Number(from) : NaN;
    const toNum = to != null ? Number(to) : NaN;
    const filtered = items.filter((item) => {
        if (charFilter && !(item.character.toLowerCase().includes(charFilter) || item.file.toLowerCase().includes(charFilter))) {
            return false;
        }
        if (!Number.isNaN(fromNum) && item.updatedAt < fromNum) return false;
        if (!Number.isNaN(toNum) && item.updatedAt > toNum) return false;
        if (kw) {
            // 先扫 preview（低成本），未命中再做全文扫描
            if (item.preview.toLowerCase().includes(kw)) return true;
            try {
                const content = fs.readFileSync(path.join(chatsRoot, item.file), 'utf-8');
                return content.toLowerCase().includes(kw);
            } catch { return false; }
        }
        return true;
    });

    // 去重：checksum 相同的文件视为同一会话的内容快照（重复保存产生的副本），
    // 只保留 updatedAt 最新的一份，避免管理界面出现重复条目。
    // 无 checksum 的旧文件（早期存档）无法判定内容是否一致，逐条展示。
    const seen = new Map();
    let deduped = 0;
    for (const item of filtered) {
        const key = item.checksum || item.file;
        const prev = seen.get(key);
        if (!prev) {
            seen.set(key, item);
        } else {
            deduped++;
            if (item.updatedAt > prev.updatedAt) seen.set(key, item);
        }
    }
    const unique = [...seen.values()];

    // 排序
    unique.sort((a, b) => {
        if (sort === 'created') return b.createdAt - a.createdAt;
        return b.updatedAt - a.updatedAt; // updated 默认：mtime 倒序
    });

    // 分页
    const safePage = Math.max(1, Math.floor(Number(page)) || 1);
    const safePageSize = Math.max(1, Math.floor(Number(pageSize)) || 20);
    const startIdx = (safePage - 1) * safePageSize;
    return {
        total: unique.length,
        page: safePage,
        pageSize: safePageSize,
        items: unique.slice(startIdx, startIdx + safePageSize),
        deduped,
    };
}

/**
 * 读取一条聊天记录（路径安全校验后交给 ChatArchive）。
 * @param {string} dataRoot
 * @param {string} fileRel - 相对路径，如 "清月/清月_20260805103000.jsonl"
 * @returns {object|null} 非法路径 / 文件不存在返回 null
 */
export function readChat(dataRoot, fileRel) {
    const filePath = _resolvePath(dataRoot, fileRel);
    if (!filePath || !fs.existsSync(filePath)) return null;

    const archive = new ChatArchive(filePath);
    const st = fs.statSync(filePath);
    const messages = archive.messages.map((m) => ({
        role: m.is_user ? 'user' : (m.is_system ? 'system' : 'assistant'),
        content: m.mes || '',
        name: m.name || '',
        sendDate: m.send_date || 0,
    }));

    // 校验和重算（无 checksum 的旧文件返回 null 表示"未校验"）
    const stored = archive.meta.chat_metadata && archive.meta.chat_metadata.checksum;
    let checksumOk = null;
    if (typeof stored === 'string' && stored.length > 0) {
        checksumOk = computeChecksum(messages) === stored;
    }

    return {
        file: fileRel,
        character: archive.meta.character_name || '',
        name: (archive.meta.chat_metadata && typeof archive.meta.chat_metadata.name === 'string') ? archive.meta.chat_metadata.name : '',
        description: (archive.meta.chat_metadata && typeof archive.meta.chat_metadata.description === 'string') ? archive.meta.chat_metadata.description : '',
        createdAt: _parseCreateDate(archive.meta.create_date) || st.mtimeMs,
        updatedAt: st.mtimeMs,
        messages,
        checksumOk,
    };
}

/** 原子写聊天文件（.tmp + rename；含测试注入的失败钩子，便于验证重试/备份逻辑） */
function _writeArchiveFile(filePath, meta, entries, hooks = {}) {
    if (hooks.failFirst && hooks.attempt === 1) {
        throw new Error('__testFailFirst: 模拟首次写入失败');
    }
    if (hooks.alwaysFail) {
        throw new Error('__testAlwaysFail: 模拟写入永久失败');
    }
    const lines = [JSON.stringify(meta), ...entries.map((m) => JSON.stringify(m))];
    const tmp = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, `${lines.join('\n')}\n`);
    fs.renameSync(tmp, filePath);
}

/** 同步忙等（重试间隔），保持保存函数为同步调用 */
function _sleepSync(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait */ }
}

/**
 * 保存聊天记录（新建或覆盖式更新）。
 *
 * 目标文件规则：
 *   - 传 prevFile（覆盖式更新当前会话）→ 沿用该文件（先做路径安全校验）；
 *   - 未传 → 先做内容级去重：若同角色目录已有「校验和一致」的文件（同一会话
 *     在不同时间被重复保存产生的副本），沿用其中最新的一份覆盖写入，并删除其余
 *     重复副本（内容一致，无信息损失）；否则新建 `<sanitizeName(character)>_<now>.jsonl`
 *     （同秒冲突自动退避 -1/-2）。
 *
 * 命名规则：角色卡名统一经 sanitizeName 标准化（空名兜底 `_default`），保证
 * 文件名、目录名与元数据 character_name 三者一致。
 *
 * 流程：备份（目标已存在 → .bak-<ts>）→ 用 ChatArchive 重建（保留原 create_date、
 * 写入 checksum）→ 原子写，失败自动重试最多 3 次 → 成功清理备份 / 失败保留备份。
 *
 * @param {string} dataRoot
 * @param {object} options
 * @param {string} [options.character] - 角色卡名（空用 _default）
 * @param {Array<{role:string, content:string}>} [options.messages]
 * @param {string} [options.userName] - 用户显示名
 * @param {string} [options.prevFile] - 覆盖式保存时沿用此相对路径文件
 * @param {boolean} [options.__testFailFirst] - 仅测试用：首次写入抛错，重试后成功
 * @param {boolean} [options.__testAlwaysFail] - 仅测试用：写入永久失败（验证备份保留）
 * @returns {{ok:boolean, file:string, savedAt:number|null, messageCount:number, retries:number, removedDuplicates:number, error?:string, backup?:string}}
 */
export function saveChat(dataRoot, options = {}) {
    const { character = '', messages = [], userName = 'User', prevFile } = options;
    const failFirst = !!options.__testFailFirst;
    const alwaysFail = !!options.__testAlwaysFail;
    // 角色卡名标准化：文件名 / 目录名 / 元数据 character_name 保持一致（空名兜底 _default）
    const charName = sanitizeName(character);

    // 确定目标文件
    let targetPath;
    let dupFiles = []; // 内容一致的重复副本（新建去重时收集，成功后删除）
    if (prevFile) {
        targetPath = _resolvePath(dataRoot, prevFile);
        if (!targetPath) {
            return {
                ok: false, file: prevFile, savedAt: null,
                messageCount: messages.length, retries: 0, error: '非法的文件路径',
            };
        }
    } else {
        // 内容级去重：校验和相同 = 同一会话的内容快照，复用最新一份，避免重复存档
        const wantChecksum = computeChecksum(messages);
        const dirPath = path.join(dataRoot, 'chats', charName);
        let best = null; // { path, mtimeMs }
        if (fs.existsSync(dirPath)) {
            for (const f of fs.readdirSync(dirPath)) {
                if (!f.endsWith('.jsonl')) continue;
                const p = path.join(dirPath, f);
                let st;
                try { st = fs.statSync(p); } catch { continue; }
                try {
                    const first = fs.readFileSync(p, 'utf-8').split('\n')[0];
                    const meta = JSON.parse(first || '{}');
                    const stored = meta && meta.chat_metadata && meta.chat_metadata.checksum;
                    if (typeof stored !== 'string' || stored !== wantChecksum) continue;
                } catch { continue; }
                if (!best || st.mtimeMs > best.mtimeMs) {
                    if (best) dupFiles.push(best.path);
                    best = { path: p, mtimeMs: st.mtimeMs };
                } else {
                    dupFiles.push(p);
                }
            }
        }
        if (best) {
            targetPath = best.path; // 复用内容一致的旧文件（覆盖写入），消除重复条目
        } else {
            targetPath = resolveChatFile(dataRoot, character, new Date());
            // 同秒新建冲突退避（罕见，防御性处理）
            let i = 1;
            const base = targetPath.slice(0, -'.jsonl'.length);
            while (fs.existsSync(targetPath)) {
                targetPath = `${base}-${i}.jsonl`;
                i++;
            }
        }
    }

    // 覆盖式保存保留原文件的 create_date
    let prevCreateDate = null;
    if (fs.existsSync(targetPath)) {
        try { prevCreateDate = new ChatArchive(targetPath).meta.create_date || null; } catch { /* 忽略 */ }
    }

    // 备份：目标已存在则先复制为 .bak-<ts>，保存成功后删除，失败保留
    let backupPath = null;
    if (fs.existsSync(targetPath)) {
        backupPath = `${targetPath}.bak-${Date.now()}`;
        try { fs.copyFileSync(targetPath, backupPath); } catch { backupPath = null; }
    }

    // 用 ChatArchive 重建：meta（character_name/user_name/create_date/chat_metadata.checksum）
    // + 逐条 append 到内存（复用其 entry 构造逻辑），随后整体原子写
    const archive = new ChatArchive(targetPath, {
        userName,
        characterName: charName,
        createDate: prevCreateDate || _formatCreateDate(),
    });
    archive.messages = []; // 覆盖式：丢弃构造时 load 的旧内容
    for (const msg of messages) {
        archive.append({
            isUser: msg.role === 'user',
            isSystem: msg.role === 'system',
            mes: msg.content || '',
            sendDate: Date.now(),
        });
    }
    archive.meta.chat_metadata = { checksum: computeChecksum(messages) };
    // 多存档系统：保留/写入自定义存档元数据（name/description）
    if (typeof options.name === 'string' && options.name.trim()) {
        archive.meta.chat_metadata.name = options.name.trim();
    } else if (fs.existsSync(targetPath) && prevCreateDate != null) {
        // 未提供名称时沿用旧文件已存在的名称（覆盖式保存不丢自定义名称）
        try {
            const old = new ChatArchive(targetPath).meta.chat_metadata || {};
            if (typeof old.name === 'string' && old.name.trim()) archive.meta.chat_metadata.name = old.name.trim();
            if (typeof old.description === 'string' && old.description.trim()) archive.meta.chat_metadata.description = old.description.trim();
        } catch { /* 忽略旧元数据读取失败 */ }
    }
    if (typeof options.description === 'string' && options.description.trim()) {
        archive.meta.chat_metadata.description = options.description.trim();
    }

    // 原子写 + 失败重试（最多 MAX_ATTEMPTS 次尝试）
    let failures = 0;
    let lastError = null;
    let ok = false;
    while (failures < MAX_ATTEMPTS && !ok) {
        try {
            _writeArchiveFile(targetPath, archive.meta, archive.messages, { failFirst, alwaysFail, attempt: failures + 1 });
            ok = true;
        } catch (e) {
            lastError = e;
            failures++;
            if (failures < MAX_ATTEMPTS) _sleepSync(200 * failures); // 200ms 递增
        }
    }

    if (ok && backupPath) {
        try { fs.rmSync(backupPath, { force: true }); } catch { /* 忽略 */ }
    }

    // 保存成功且新建去重时发现重复副本 → 删除（内容校验和一致，无信息损失）
    if (ok && dupFiles.length > 0) {
        for (const dup of dupFiles) {
            try { fs.rmSync(dup, { force: true }); } catch { /* 忽略 */ }
        }
    }

    const result = {
        ok,
        file: _toRelFile(dataRoot, targetPath),
        savedAt: ok ? Date.now() : null,
        messageCount: messages.length,
        retries: failures,
        removedDuplicates: dupFiles.length,
    };
    if (!ok) {
        result.error = (lastError && lastError.message) || '未知保存错误';
        if (backupPath && fs.existsSync(backupPath)) {
            result.backup = backupPath;
            result.note = '保存失败，已保留备份文件供恢复';
        }
    }
    return result;
}

/**
 * 批量删除聊天记录（逐个路径安全校验）。
 * @param {string} dataRoot
 * @param {string[]} files - 相对路径数组
 * @returns {{deleted:number, skipped:number}}
 */
export function deleteChats(dataRoot, files = []) {
    let deleted = 0;
    let skipped = 0;
    for (const rel of files) {
        const filePath = _resolvePath(dataRoot, rel);
        if (!filePath || !fs.existsSync(filePath)) { skipped++; continue; }
        try {
            fs.rmSync(filePath, { force: true });
            deleted++;
        } catch { skipped++; }
    }
    return { deleted, skipped };
}

/**
 * 为指定角色卡创建一个新的空存档（多存档管理系统核心能力）。
 * 存档只落在 <dataRoot>/chats/<角色>/ 下，与角色卡基础数据（assets/characters）完全隔离；
 * 删除该存档不影响角色卡本身。
 * @param {string} dataRoot
 * @param {object} options
 * @param {string} [options.character] - 角色卡名（空用 _default）
 * @param {string} [options.name] - 存档名称（可空）
 * @param {string} [options.description] - 存档描述（可空）
 * @returns {{ok:boolean, file:string, error?:string}}
 */
export function createArchive(dataRoot, options = {}) {
    const { character = '', name = '', description = '' } = options;
    let filePath = resolveChatFile(dataRoot, character, new Date());
    // 同秒新建冲突退避（罕见，防御性处理）
    let i = 1;
    const base = filePath.slice(0, -'.jsonl'.length);
    while (fs.existsSync(filePath)) {
        filePath = `${base}-${i}.jsonl`;
        i++;
    }
    const archive = new ChatArchive(filePath, {
        userName: 'User',
        characterName: sanitizeName(character),
        createDate: _formatCreateDate(),
    });
    archive.meta.chat_metadata = {};
    if (typeof name === 'string' && name.trim()) archive.meta.chat_metadata.name = name.trim();
    if (typeof description === 'string' && description.trim()) archive.meta.chat_metadata.description = description.trim();
    try {
        _writeArchiveFile(filePath, archive.meta, []);
    } catch (e) {
        return { ok: false, file: '', error: `创建存档失败: ${e.message}` };
    }
    return { ok: true, file: _toRelFile(dataRoot, filePath) };
}

/**
 * 更新存档的自定义元数据（名称 / 描述）。只改首行 chat_metadata，不动消息内容。
 * 存档不存在 / 路径非法返回 { ok:false }。
 * @param {string} dataRoot
 * @param {string} fileRel - 相对路径，如 "清月/清月_20260805103000.jsonl"
 * @param {object} meta - { name?, description? }
 * @returns {{ok:boolean, file?:string, error?:string}}
 */
export function updateArchiveMeta(dataRoot, fileRel, meta = {}) {
    const filePath = _resolvePath(dataRoot, fileRel);
    if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: '存档不存在或路径非法' };
    }
    const archive = new ChatArchive(filePath);
    archive.meta.chat_metadata = archive.meta.chat_metadata || {};
    if (typeof meta.name === 'string') archive.meta.chat_metadata.name = meta.name.trim();
    if (typeof meta.description === 'string') archive.meta.chat_metadata.description = meta.description.trim();
    try {
        _writeArchiveFile(filePath, archive.meta, archive.messages);
    } catch (e) {
        return { ok: false, error: `更新存档元数据失败: ${e.message}` };
    }
    return { ok: true, file: fileRel };
}

/** 比较两个文件内容是否一致（迁移幂等判断用） */
function _filesEqual(a, b) {
    try {
        return fs.readFileSync(a).equals(fs.readFileSync(b));
    } catch { return false; }
}

/**
 * 递归收集 legacyChatsDir 下的 .jsonl 文件（支持 ST 风格的「角色卡/xxx.jsonl」
 * 子目录结构）。新存储目录 <dataRoot>/chats 会被整体跳过，避免把已迁移文件再当旧档。
 * @param {string} dir - 待扫描目录
 * @param {string} chatsRoot - 新存储的 chats 根目录（用于跳过）
 * @param {string[]} out - 收集结果（绝对路径）
 */
function _collectLegacyFiles(dir, chatsRoot, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
        const p = path.join(dir, ent.name);
        // 跳过新存储目录本身（避免把已迁移的记录再次当作旧档处理）
        if (chatsRoot && path.resolve(p) === path.resolve(chatsRoot)) continue;
        if (ent.isDirectory()) {
            _collectLegacyFiles(p, chatsRoot, out);
        } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
            out.push(p);
        }
    }
}

/**
 * 迁移旧 ST 平铺存档（legacyChatsDir 下的 .jsonl，支持子目录）到新层级结构。
 * 复制而非移动（保留原文件）；目标已存在且内容相同则跳过（幂等），
 * 内容不同则加后缀 -1/-2…。
 * @param {string} dataRoot - 新数据根目录
 * @param {string} legacyChatsDir - 旧存档目录（默认 data/chats，可指向 SillyTavern 的 chats 目录）
 * @returns {{migrated:number, skipped:number, errors:Array<{file:string, error:string}>}}
 */
export function migrateLegacy(dataRoot, legacyChatsDir) {
    let migrated = 0;
    let skipped = 0;
    const errors = [];
    if (!fs.existsSync(legacyChatsDir)) return { migrated, skipped, errors };

    const chatsRoot = path.join(dataRoot, 'chats');
    // 旧档目录位于新存储内部（如误把 <dataRoot>/chats 指为旧档目录）→ 无需迁移
    const relToStore = path.relative(chatsRoot, legacyChatsDir);
    if (relToStore === '' || (!relToStore.startsWith('..') && !path.isAbsolute(relToStore))) {
        return { migrated, skipped, errors };
    }

    const files = [];
    _collectLegacyFiles(legacyChatsDir, chatsRoot, files);
    if (files.length === 0) return { migrated, skipped, errors };

    for (const srcPath of files) {
        const f = path.relative(legacyChatsDir, srcPath) || path.basename(srcPath);
        try {
            const archive = new ChatArchive(srcPath);
            const char = archive.meta.character_name || '_default';
            const dirName = sanitizeName(char);
            // 目标时间戳：优先元数据 create_date，其次文件 mtime
            const parsed = _parseCreateDate(archive.meta.create_date);
            const tsStr = parsed ? timestamp(new Date(parsed)) : timestamp(new Date(fs.statSync(srcPath).mtimeMs));
            const base = path.join(dataRoot, 'chats', dirName, `${dirName}_${tsStr}`);
            let target = `${base}.jsonl`;

            if (fs.existsSync(target)) {
                if (_filesEqual(srcPath, target)) {
                    skipped++; // 幂等：内容一致视为已迁移过
                    continue;
                }
                let i = 1;
                while (fs.existsSync(`${base}-${i}.jsonl`)) i++;
                target = `${base}-${i}.jsonl`;
            }

            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(srcPath, target); // 复制而非移动，保留原文件
            migrated++;
        } catch (e) {
            errors.push({ file: f, error: e.message });
            logger.warn(`迁移旧存档失败 ${f}: ${e.message}`);
        }
    }
    return { migrated, skipped, errors };
}

/**
 * 统计聊天存储（供审计/展示）。
 * @param {string} dataRoot
 * @returns {{totalFiles:number, totalCharacters:number, totalBytes:number}}
 */
export function getStoreStats(dataRoot) {
    const chatsRoot = path.join(dataRoot, 'chats');
    let totalFiles = 0;
    let totalCharacters = 0;
    let totalBytes = 0;
    if (fs.existsSync(chatsRoot)) {
        for (const dir of fs.readdirSync(chatsRoot)) {
            const dirPath = path.join(chatsRoot, dir);
            let dirStat;
            try { dirStat = fs.statSync(dirPath); } catch { continue; }
            if (!dirStat.isDirectory()) continue;
            let count = 0;
            for (const f of fs.readdirSync(dirPath)) {
                if (!f.endsWith('.jsonl')) continue;
                try { totalBytes += fs.statSync(path.join(dirPath, f)).size; } catch { /* 忽略 */ }
                count++;
            }
            if (count > 0) totalCharacters++;
            totalFiles += count;
        }
    }
    return { totalFiles, totalCharacters, totalBytes };
}

export default {
    DEFAULT_DATA_ROOT,
    sanitizeName,
    timestamp,
    computeChecksum,
    resolveChatFile,
    listChats,
    readChat,
    saveChat,
    deleteChats,
    migrateLegacy,
    getStoreStats,
};
