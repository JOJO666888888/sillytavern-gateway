/**
 * MVU 兼容运行时（SillyTavern MagVarUpdate 生态 → agent 剧场）
 *
 * 适配而非重开发：角色卡按 MVU 生态输出的 `<UpdateVariable>` 差分块，
 * 由本引擎解析并应用到会话级 stat_data 快照，无需安装酒馆助手 / MVU 脚本。
 *
 * 支持的差分语法（三套并存，兼容不同版本的角色卡）：
 *   1. JSON Patch 块（MVU ZOD 现行格式，RFC 6902 子集）
 *        <UpdateVariable>
 *        <Analysis>...</Analysis>
 *        <JSONPatch>
 *        [ { "op":"replace", "path":"/角色/络络/好感度", "value": 30 }, ... ]
 *        </JSONPatch>
 *        </UpdateVariable>
 *   2. 传统命令行（stat_var.md 时代）
 *        set|角色.络络.好感度=0→1|(理由)
 *   3. `_.set` 命令（酒馆助手脚本式）
 *        _.set('角色.络络.好感度', 30)
 *
 * 设计要点：
 *   - 路径归一化：支持 `/a/b/c`（JSON Patch）与 `a.b.c`（点分）两种写法，中文键名安全。
 *   - 数值处理：delta 对数字做加减；写入前对数字尝试 Number 化（保留字符串原样）。
 *   - 显示剥离：`<UpdateVariable>` 块与 `<StatusPlaceHolderImpl/>` 占位符从显示文本移除，
 *     但保留在原始消息中（供模型下一轮上下文读取，与 ST/MVU 行为一致）。
 */

/** 深度克隆（用于每次应用前复制快照，避免污染上一状态） */
function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    return structuredClone(v);
}

/** 规范化路径："/a/b/c"、"a.b.c"、数组下标 "-"（追加） */
export function normalizePath(path) {
    const p = String(path || '');
    const cleaned = p.replace(/^\//, '').replace(/\/$/, '');
    if (!cleaned) return [];
    return cleaned.split(/[./]/).filter(Boolean);
}

/** 按路径读取（安全，不存在返回 undefined） */
export function getByPath(obj, path) {
    const parts = normalizePath(path);
    let cur = obj;
    for (const key of parts) {
        if (cur === null || cur === undefined) return undefined;
        cur = cur[key];
    }
    return cur;
}

/** 按路径写入（自动创建中间对象；"-" 表示数组追加） */
export function setByPath(obj, path, value) {
    const parts = normalizePath(path);
    if (parts.length === 0) return;
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        const nextKey = parts[i + 1];
        if (cur[key] === null || cur[key] === undefined || typeof cur[key] !== 'object') {
            cur[key] = /^\d+$/.test(nextKey) || nextKey === '-' ? [] : {};
        }
        cur = cur[key];
    }
    const last = parts[parts.length - 1];
    if (last === '-') {
        if (!Array.isArray(cur)) cur = [];
        cur.push(value);
    } else {
        cur[last] = value;
    }
}

/** 删除路径键（数组元素按下标删除） */
export function removeByPath(obj, path) {
    const parts = normalizePath(path);
    if (parts.length === 0) return;
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return;
        cur = cur[parts[i]];
    }
    if (cur === null || cur === undefined || typeof cur !== 'object') return;
    const last = parts[parts.length - 1];
    if (Array.isArray(cur)) {
        const idx = Number(last);
        if (Number.isInteger(idx) && idx >= 0 && idx < cur.length) cur.splice(idx, 1);
    } else {
        delete cur[last];
    }
}

/** 尝试把字符串解析为字面量（数字/布尔/null/JSON），失败返回原字符串 */
function coerce(value) {
    if (typeof value !== 'string') return value;
    const t = value.trim();
    if (t === '') return '';
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^[-+]?\d+(\.\d+)?$/.test(t)) return Number(t);
    try {
        if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
            return JSON.parse(t);
        }
    } catch (_) { /* 非 JSON，按字符串 */ }
    return value;
}

/** 解析 JSON Patch 文本（可能被 ```json 围栏包裹，也可能直接是数组文本） */
export function parseJsonPatch(text) {
    if (!text) return [];
    let t = String(text).trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    // 截取第一个 [ 到最后一个 ]（容错分析文本混入）
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    try {
        const arr = JSON.parse(t.slice(start, end + 1));
        return Array.isArray(arr) ? arr : [];
    } catch (_) {
        return [];
    }
}

/** 解析传统命令行："set|path=old→new|(理由)" / "add|path=delta|(理由)" */
export function parseCommandLines(text) {
    if (!text) return [];
    const commands = [];
    for (const rawLine of String(text).split(/\r?\n/)) {
        const line = rawLine.trim();
        const m = line.match(/^(set|add|insert|delete|move|remove)\|(.+)$/i);
        if (!m) continue;
        const op = m[1].toLowerCase();
        const rest = m[2];
        // 按 | 切分：第二段为 path(=old→new) 或 from=old→new,to=...
        const segs = rest.split('|');
        if (op === 'move') {
            const from = segs[0]?.split('=')[0]?.trim();
            const to = segs[1]?.split('=')[0]?.trim();
            if (from && to) commands.push({ op: 'move', from: from.replace(/^from\.?/i, ''), path: to.replace(/^to\.?/i, '') });
            continue;
        }
        const pathExpr = segs[0]?.trim() || '';
        // path=old→new | path=new | path=delta
        const eqIdx = pathExpr.indexOf('=');
        const path = eqIdx >= 0 ? pathExpr.slice(0, eqIdx).trim() : pathExpr;
        const valExpr = eqIdx >= 0 ? pathExpr.slice(eqIdx + 1) : '';
        const arrowIdx = valExpr.lastIndexOf('→');
        const newVal = arrowIdx >= 0 ? valExpr.slice(arrowIdx + 1) : valExpr;
        if (!path) continue;
        commands.push({
            op: op === 'delete' ? 'remove' : op,
            path,
            value: op === 'add' ? coerce(newVal) : coerce(newVal),
        });
    }
    return commands;
}

/** 解析 `_.set('path', value)` 形式命令 */
export function parseUnderscoreSet(text) {
    if (!text) return [];
    const commands = [];
    const re = /_\.set\s*\(\s*(['"])(.*?)\1\s*,\s*([\s\S]*?)\s*\)/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
        const path = m[2];
        const rawVal = m[3].trim();
        let value;
        if ((rawVal.startsWith('"') && rawVal.endsWith('"')) || (rawVal.startsWith("'") && rawVal.endsWith("'"))) {
            value = rawVal.slice(1, -1);
        } else {
            value = coerce(rawVal);
        }
        if (path) commands.push({ op: 'replace', path, value });
    }
    return commands;
}

/** 应用单条命令到快照（返回 { ok, error? }） */
export function applyCommand(snapshot, cmd) {
    if (!cmd || typeof cmd !== 'object') return { ok: false, error: '空命令' };
    const op = (cmd.op || '').toLowerCase();
    const path = cmd.path;
    switch (op) {
        case 'replace':
        case 'set': {
            setByPath(snapshot, path, coerce(cmd.value));
            return { ok: true };
        }
        case 'delta':
        case 'add': {
            const cur = getByPath(snapshot, path);
            const delta = Number(cmd.value);
            if (Number.isFinite(delta) && (typeof cur === 'number' || cur === undefined)) {
                setByPath(snapshot, path, (Number(cur) || 0) + delta);
                return { ok: true };
            }
            // 非数字：字符串拼接（ST addvar 语义）
            setByPath(snapshot, path, String(cur ?? '') + String(cmd.value ?? ''));
            return { ok: true };
        }
        case 'insert': {
            const parts = normalizePath(path);
            if (parts.length === 0) return { ok: false, error: '空路径' };
            const parentPath = parts.slice(0, -1);
            const key = parts[parts.length - 1];
            const parent = getByPath(snapshot, parentPath);
            if (Array.isArray(parent)) {
                const idx = key === '-' ? parent.length : Number(key);
                const insertIdx = key === '-' ? parent.length : (Number.isInteger(idx) && idx >= 0 && idx <= parent.length ? idx : parent.length);
                parent.splice(insertIdx, 0, coerce(cmd.value));
                return { ok: true };
            }
            setByPath(snapshot, path, coerce(cmd.value));
            return { ok: true };
        }
        case 'remove':
        case 'delete': {
            removeByPath(snapshot, path);
            return { ok: true };
        }
        case 'move': {
            const from = cmd.from ?? cmd.fromPath;
            // MVU 变量输出格式用 "to"（RFC 6902 用 "path"），两者都兼容
            const dest = cmd.path ?? cmd.to;
            const value = getByPath(snapshot, from);
            removeByPath(snapshot, from);
            setByPath(snapshot, dest, value);
            return { ok: true };
        }
        default:
            return { ok: false, error: `未知操作 ${op}` };
    }
}

/**
 * 从消息文本提取并解析全部 MVU 差分命令。
 * @param {string} text - 模型输出的原始消息
 * @returns {{ block: string|null, analysis: string, jsonPatch: Array, commandLines: Array, underscoreSet: Array }}
 */
export function parseUpdateBlock(text) {
    const result = { block: null, analysis: '', jsonPatch: [], commandLines: [], underscoreSet: [] };
    if (!text) return result;

    // 提取 <UpdateVariable>...</UpdateVariable> 块
    const blockMatch = String(text).match(/<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/i);
    const inner = blockMatch ? blockMatch[1] : String(text);

    // <Analysis>...</Analysis>
    const analysisMatch = inner.match(/<Analysis>([\s\S]*?)<\/Analysis>/i);
    if (analysisMatch) result.analysis = analysisMatch[1].trim();

    // <JSONPatch>...</JSONPatch>（仅块内；无块时回退全文）
    const patchMatch = inner.match(/<JSONPatch>([\s\S]*?)<\/JSONPatch>/i);
    if (patchMatch) result.jsonPatch = parseJsonPatch(patchMatch[1]);

    result.block = blockMatch ? blockMatch[0] : null;
    // 命令行与 _.set 在全文上扫描：兼容"块内"与"块外（部分旧卡直接裸输出）"两种形态。
    // 每种语法各匹配一次，无需去重（正则自身保证单次命中同一段文本）。
    result.commandLines = parseCommandLines(String(text));
    result.underscoreSet = parseUnderscoreSet(String(text));
    return result;
}

/**
 * 把文本中的 MVU 差分应用到快照，返回新快照。
 * @param {string} text - 模型输出（含 <UpdateVariable> 块等）
 * @param {object} snapshot - 当前 stat_data 快照
 * @returns {{ snapshot: object, changed: boolean, applied: Array, skipped: Array }}
 */
export function applyMvuToText(text, snapshot = {}) {
    const base = clone(snapshot) || {};
    const { jsonPatch, commandLines, underscoreSet } = parseUpdateBlock(text);
    const applied = [];
    const skipped = [];

    const run = (cmds) => {
        for (const c of cmds) {
            const r = applyCommand(base, c);
            if (r.ok) applied.push(c);
            else skipped.push({ cmd: c, error: r.error });
        }
    };
    run(jsonPatch);
    run(commandLines);
    run(underscoreSet);

    return { snapshot: base, changed: applied.length > 0, applied, skipped };
}

/** 把 stat_data 渲染为 YAML 风格文本块（{{format_message_variable::stat_data}} 语义，忽略 $ 前缀键） */
export function formatVariables(obj, indent = '') {
    if (obj === null || obj === undefined) return '';
    if (typeof obj !== 'object') return String(obj);
    if (Array.isArray(obj)) {
        return obj.map((v, i) => `${indent}- ${formatVariables(v, indent + '  ').trimStart()}`).join('\n');
    }
    const lines = [];
    for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith('$')) continue; // MVU 约定：$ 前缀为内部键，不注入提示词
        if (v !== null && typeof v === 'object') {
            lines.push(`${indent}${k}:`);
            const sub = formatVariables(v, indent + '  ');
            if (sub) lines.push(sub);
        } else {
            lines.push(`${indent}${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
        }
    }
    return lines.join('\n');
}

/**
 * 展开消息变量宏（{{get_message_variable::path}} / {{format_message_variable::path}} /
 * {{lastMessageId}} / {{isMobile}}）。
 * @param {string} text
 * @param {object} variables - stat_data 快照
 * @param {object} [ctx] - { historyLength?, isMobile? }
 * @returns {string}
 */
export function expandMessageVariables(text, variables = {}, ctx = {}) {
    if (!text) return text;
    let out = String(text);
    // {{get_message_variable::path}}
    out = out.replace(/\{\{get_message_variable::([^}]+)\}\}/gi, (_, p) => {
        const v = getByPath(variables, p.trim());
        if (v === undefined || v === null) return '';
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
    // {{format_message_variable::path}}
    out = out.replace(/\{\{format_message_variable::([^}]+)\}\}/gi, (_, p) => {
        const v = getByPath(variables, p.trim());
        if (v === undefined || v === null || typeof v !== 'object') return '';
        return formatVariables(v);
    });
    // 兼容别名：{{format_message_variable::stat_data}} 已覆盖；{{get_chat_variable::path}} 同会话级
    out = out.replace(/\{\{get_chat_variable::([^}]+)\}\}/gi, (_, p) => {
        const v = getByPath(variables, p.trim());
        if (v === undefined || v === null) return '';
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
    out = out.replace(/\{\{lastMessageId\}\}/gi, () => String(Math.max(0, (ctx.historyLength || 0) - 1)));
    out = out.replace(/\{\{isMobile\}\}/gi, () => (ctx.isMobile ? 'true' : 'false'));
    return out;
}

/** 从显示文本剥离 MVU 内部块（<UpdateVariable>/<StatusPlaceHolderImpl/>/<Analysis>），保留其余 */
export function stripForDisplay(text) {
    if (!text) return text;
    return String(text)
        .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '')
        .replace(/<StatusPlaceHolderImpl\s*\/?>/gi, '')
        .replace(/<Analysis>[\s\S]*?<\/Analysis>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export default {
    normalizePath, getByPath, setByPath, removeByPath,
    parseJsonPatch, parseCommandLines, parseUnderscoreSet,
    applyCommand, applyMvuToText, parseUpdateBlock,
    formatVariables, expandMessageVariables, stripForDisplay,
};
