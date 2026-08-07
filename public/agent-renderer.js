/**
 * agent-renderer.js —— Agent 剧场 完整前端渲染引擎（R2）
 *
 * 参照 SillyTavern 酒馆助手（JS-Slash-Runner）的渲染机制：
 *   「正则捕获标签 → 替换为 HTML/CSS 前端代码 → sanitize → 注入消息气泡」。
 *
 * 设计要点：
 *   1. 双通道渲染（无缝切换）：
 *      - 通道 A「正则 HTML 直通」：服务端 getRegexedString 已在 AI_OUTPUT 阶段把角色卡/
 *        全局正则（作者自定义标签）替换为 HTML 标记，此处白名单 sanitize 后直接注入，
 *        与酒馆助手一致（历史保留原始文本，仅显示层被替换）。
 *      - 通道 B「标签渲染」：预设标签（<maintext>/<option>/<sum>/<stu>/<mission>/<Analysis>）
 *        与通用标签注册表（作者自定义 <foo>...</foo> / {{foo::...}} / 【foo】...）。
 *   2. TagRegistry 通用标签注册表：不依赖一套标准预设标签，作者自定义标签可通过
 *      注册回调渲染，预设功能保持可用。
 *   3. 安全：白名单 sanitize（危险标签 / 事件属性 / javascript: 等一律清除），
 *      渲染失败自动降级为纯文本，绝不中断主流程。
 *   4. `<StatusPlaceHolderImpl/>` 作为 MVU 通用占位：正文层剥离、状态面板渲染
 *      stat_data（见 resolveStatusPlaceholder / renderMvuStatusBar）。
 *
 * 模块形态：ESM（package.json "type": "module"）——测试直接 import；
 *           浏览器以 <script type="module"> 引入，模块加载时挂载 window.AgentRenderer
 *           （module 脚本按 defer 语义在 DOMContentLoaded 前执行，渲染调用均为运行时触发）。
 */

// ==================== 工具 ====================

export function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function unquote(v) {
    if (!v) return '';
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'")) return v.slice(1, -1);
    return v;
}

// ==================== 白名单 sanitize（无 DOM 依赖，正则实现） ====================

/** 允许保留的标签（酒馆助手类前端卡常用结构） */
const ALLOWED_TAGS = {
    div: 1, span: 1, br: 1, hr: 1, p: 1, b: 1, strong: 1, i: 1, em: 1,
    u: 1, s: 1, del: 1, code: 1, pre: 1, blockquote: 1, small: 1, mark: 1,
    h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1,
    ul: 1, ol: 1, li: 1, table: 1, thead: 1, tbody: 1, tfoot: 1, tr: 1, td: 1, th: 1,
    img: 1, a: 1, button: 1,
};

/** 危险标签：整体删除（成对与自闭合两种形态） */
const BLOCKED_TAGS = /script|style|iframe|frame|frameset|object|embed|link|meta|form|input|textarea|select|option|svg|math|base|template|noscript|applet|marquee|video|audio|source|track/;

/** 允许的标签属性（按标签收敛，class/style/data-* 通用放开） */
function isAllowedAttr(name, tag) {
    if (name === 'class' || name === 'title' || name === 'alt' || name === 'id') return true;
    if (name.indexOf('data-') === 0) return true;
    if (name === 'style') return true; // styleAllowed 另行校验值
    if (name === 'width' || name === 'height') return true;
    switch (tag) {
        case 'a': return name === 'href' || name === 'target' || name === 'rel';
        case 'img': return name === 'src';
        case 'td': case 'th': return name === 'colspan' || name === 'rowspan';
        case 'ol': return name === 'start' || name === 'type';
        case 'li': return name === 'value';
        default: return false;
    }
}

/** style 值白名单：拒绝 url()/expression/@import/behavior/-moz-binding 等注入 */
const STYLE_BLOCK_RE = /(url\s*\(|expression\s*\(|@import|@charset|behavior\s*:|-moz-binding|javascript\s*:)/i;
const STYLE_ALLOWED_PROP = /^(display|position|left|top|right|bottom|width|height|min-|max-|margin|padding|border|border-radius|background|color|font|line-height|letter-spacing|text-align|text-decoration|text-transform|white-space|word-break|word-wrap|overflow|gap|flex|grid|justify|align|transform|opacity|box-shadow|transition|animation|cursor|vertical-align|float|clear|z-index)/i;

function styleAllowed(v) {
    if (!v) return false;
    const s = String(v).trim();
    if (!s || s.length > 400) return false;
    if (STYLE_BLOCK_RE.test(s)) return false;
    const props = s.split(';');
    for (let i = 0; i < props.length; i++) {
        const p = props[i].trim();
        if (!p) continue;
        const name = p.split(':')[0].trim();
        if (!STYLE_ALLOWED_PROP.test(name)) return false;
    }
    return true;
}

/** 标签属性清理：剔除事件属性 / 危险 URL / 非白名单属性 */
function cleanAttrs(attrStr, tag) {
    let out = '';
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/g;
    let m;
    while ((m = re.exec(attrStr)) !== null) {
        const name = m[1].toLowerCase();
        const rawVal = m[2];
        const value = unquote(rawVal).trim();
        if (name.indexOf('on') === 0) continue;                        // 事件属性
        if (!value) continue;
        if (name === 'style') {
            if (!styleAllowed(value)) continue;
        } else if (name === 'href' || name === 'src' || name === 'action' || name === 'background') {
            if (/^(javascript|vbscript|data)\s*:/i.test(value)) continue; // 危险协议
            if (name === 'href' && !/^(https?:|mailto:|tel:|#|\/)/i.test(value)) continue;
        } else if (!isAllowedAttr(name, tag)) {
            continue;
        }
        out += ' ' + name + '=' + rawVal;
    }
    return out;
}

/**
 * 白名单 sanitize：未知/危险标签转为纯文本，白名单标签清理属性。
 * 失败（异常输入）时返回 ''，由调用方降级为纯文本。
 * @param {string} html
 * @returns {string}
 */
export function sanitizeHtml(html) {
    if (html == null) return '';
    let str = String(html);
    if (!str) return '';
    try {
        // 1) 成对危险标签整体删除（含内部内容）
        str = str.replace(new RegExp(
            '<\\s*(' + BLOCKED_TAGS.source + ')[^>]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>', 'gi'
        ), '');
        // 2) 自闭合 / 未闭合危险标签删除
        str = str.replace(new RegExp(
            '<\\s*(' + BLOCKED_TAGS.source + ')(?:\\s+[^<>]*)?\\s*/?>', 'gi'
        ), '');
        // 3) 清理白名单标签：保留标签与安全属性；未知标签（含连字符名）→ 转义为文本
        str = str.replace(/(<\/?)([a-zA-Z][a-zA-Z0-9_-]*)((?:\s+[^<>]*)?)(\s*\/?)>/g, function (full, open, tagName, attrPart, selfClose) {
            const tag = tagName.toLowerCase();
            if (!ALLOWED_TAGS[tag]) return escapeHtml(full); // 未知标签降级为文本
            const attrs = cleanAttrs(attrPart, tag);
            const isClosing = open === '</';
            // 闭合标签 / 开放标签；自闭合斜杠只对开放标签生效
            const close = isClosing ? '' : (selfClose && selfClose.indexOf('/') !== -1 ? '/' : '');
            return (isClosing ? '</' : '<') + tag + attrs + close + '>';
        });
        return str;
    } catch (e) {
        return '';
    }
}

/**
 * 是否含"正则 HTML 输出"标记（通道 A 判据）。
 * 只识别白名单 HTML 结构，避免把普通文本中的 `< x < y` 误判。
 */
const HTML_MARKER_RE = /<(\/?)(div|span|table|p|b|strong|i|em|u|s|del|code|pre|blockquote|ul|ol|li|h[1-6]|img|a|br|hr|button|small|mark)[\s>\/]/i;

export function hasHtmlMarker(text) {
    if (!text) return false;
    let str = String(text);
    if (str.length > 200000) str = str.slice(0, 200000); // 超长输入截断检测，防灾难性回溯
    return HTML_MARKER_RE.test(str);
}

// ==================== TagRegistry 通用标签注册表 ====================

const blockHandlers = {};   // <name>内容</name> → handler(inner, ctx, full)
const macroHandlers = {};   // {{name::参数}} → handler(param, ctx, full)
const lineHandlers = [];    // { pattern: RegExp, handler(lines, ctx) } 行级渲染

/** 安全区哨兵：渲染器输出的"可信 HTML"夹在哨兵之间，最终拼接时不转义 */
const SAFE_OPEN = '\u0001TH_SAFE\u0002';
const SAFE_CLOSE = '\u0003TH_END\u0004';

function wrapSafe(html) { return SAFE_OPEN + html + SAFE_CLOSE; }

/** 拼接：哨兵内为可信 HTML（直通），哨兵外为普通文本（转义 + 换行转 <br>） */
function assembleHtml(s) {
    const parts = String(s).split(SAFE_OPEN);
    let html = '';
    for (let i = 0; i < parts.length; i++) {
        const chunk = parts[i];
        const closeIdx = chunk.indexOf(SAFE_CLOSE);
        if (closeIdx !== -1) {
            html += chunk.slice(0, closeIdx); // 安全 HTML 直通
            html += escapeHtml(chunk.slice(closeIdx + SAFE_CLOSE.length)).replace(/\r?\n/g, '<br>');
        } else {
            html += escapeHtml(chunk).replace(/\r?\n/g, '<br>');
        }
    }
    return html;
}

/**
 * 注册块标签渲染器：<name>内容</name>。
 * handler(inner, ctx, full) → string（可为 HTML）
 */
export function registerTag(name, handler) {
    if (!name || typeof handler !== 'function') return;
    blockHandlers[name.toLowerCase()] = handler;
}

/**
 * 注册宏渲染器：{{name::参数}}（参数可含 ::）。
 * handler(param, ctx, full) → string
 */
export function registerMacro(name, handler) {
    if (!name || typeof handler !== 'function') return;
    macroHandlers[name.toLowerCase()] = handler;
}

/**
 * 注册行级渲染器：按行正则匹配（如 【状态】...、[LOVE_DATA]...）。
 * handler(match, line, ctx, lines) → string | null（null 表示不消费该行）
 * 返回字符串时若以 '@@consume' 开头表示该行被消费（不再走默认转义）。
 */
export function registerLine(pattern, handler) {
    if (!(pattern instanceof RegExp) || typeof handler !== 'function') return;
    lineHandlers.push({ pattern, handler });
}

/** 渲染全部已注册块标签：<name>...</name>（未注册标签原样保留） */
function renderBlockTags(text, ctx) {
    if (!text || Object.keys(blockHandlers).length === 0) return text;
    let result = String(text);
    const re = new RegExp('<([a-zA-Z][a-zA-Z0-9_-]*)\\s*>([\\s\\S]*?)<\\/\\1\\s*>', 'g');
    for (let round = 0; round < 20; round++) { // 从内向外迭代，最多 20 轮防死循环
        let changed = false;
        result = result.replace(re, function (full, name, inner) {
            const handler = blockHandlers[name.toLowerCase()];
            if (!handler) return full;
            changed = true;
            try {
                const out = handler(inner, ctx, full);
                return out == null ? full : wrapSafe(String(out)); // 渲染器输出视为可信 HTML
            } catch (e) {
                return full; // 单个标签渲染失败不影响其他内容
            }
        });
        if (!changed) break;
    }
    return result;
}

/** 渲染全部已注册宏：{{name::参数}} */
function renderMacros(text, ctx) {
    if (!text || Object.keys(macroHandlers).length === 0) return text;
    return String(text).replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*::\s*([\s\S]*?)\s*\}\}/g, function (full, name, param) {
        const handler = macroHandlers[name.toLowerCase()];
        if (!handler) return full;
        try {
            const out = handler(param, ctx, full);
            return out == null ? full : wrapSafe(String(out)); // 宏输出视为可信 HTML
        } catch (e) {
            return full;
        }
    });
}

/** 行级渲染：逐行应用注册的行渲染器 */
function renderLines(text, ctx) {
    if (!text || lineHandlers.length === 0) return String(text || '');
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        for (let j = 0; j < lineHandlers.length; j++) {
            const h = lineHandlers[j];
            const m = h.pattern.exec(trimmed);
            if (!m) continue;
            let out;
            try {
                out = h.handler(m, trimmed, ctx, lines);
            } catch (e) {
                out = null;
            }
            if (typeof out === 'string') {
                const safe = wrapSafe(out.indexOf('@@consume') === 0 ? out.slice('@@consume'.length) : out);
                lines[i] = safe; // 行渲染输出视为可信 HTML
                break;
            }
        }
    }
    return lines.join('\n');
}

/**
 * 通用标签渲染入口：块标签 → 宏 → 行渲染 → 拼接（哨兵内 HTML 直通，其余转义）。
 * 未被任何注册器消费的内容按纯文本转义保留（永不丢弃原文）。
 * @returns {{ html: string, mode: string }}
 */
export function renderText(text, ctx) {
    const raw = String(text == null ? '' : text);
    if (!raw) return { html: '', mode: 'plain' };
    ctx = ctx || {};
    try {
        let s = renderBlockTags(raw, ctx);
        s = renderMacros(s, ctx);
        s = renderLines(s, ctx);
        return { html: assembleHtml(s), mode: 'tags' };
    } catch (e) {
        // 任何异常 → 纯文本保底
        return { html: escapeHtml(raw).replace(/\r?\n/g, '<br>'), mode: 'plain' };
    }
}

// ==================== 双通道消息渲染 ====================

/**
 * 消息渲染主入口（消息气泡用）。
 * @param {string} text - 服务端返回的显示文本（可能已含服务端正则替换的 HTML）
 * @param {object} [ctx] - { floorIndex, session, character, variables }
 * @returns {{ html: string, mode: 'html'|'tags'|'plain'|'empty' }}
 */
export function renderMessage(text, ctx) {
    const raw = String(text == null ? '' : text);
    if (!raw) return { html: '', mode: 'empty' };

    // 通道 A：正则 HTML 直通（服务端正则在 AI_OUTPUT 阶段已完成标签→HTML 替换）
    if (hasHtmlMarker(raw)) {
        try {
            const safe = sanitizeHtml(raw);
            // sanitize 失败（返回 ''）或完全被清空 → 降级通道 B
            if (safe) return { html: safe, mode: 'html' };
        } catch (e) { /* 降级 */ }
    }

    // 通道 B：标签渲染（预设 + 通用注册表）
    return renderText(raw, ctx);
}

/**
 * 纯文本→可显示文本（无标签渲染，仅转义换行；用于思维链/查看器等安全展示）。
 */
export function plainText(text) {
    return escapeHtml(text == null ? '' : String(text)).replace(/\r?\n/g, '<br>');
}

// ==================== StatusPlaceHolderImpl（MVU 通用占位） ====================

const STATUS_PLACEHOLDER_RE = /<StatusPlaceHolderImpl\s*\/?>/i;

/** 检测文本是否含 MVU 状态占位符（角色卡正则可将其替换为任意前端代码） */
export function hasStatusPlaceholder(text) {
    return !!text && STATUS_PLACEHOLDER_RE.test(String(text));
}

/**
 * 解析占位符：返回 { present: boolean, residual: string }。
 * present=true 表示正文含状态占位（应由状态面板消费 stat_data 渲染）；
 * residual 为剥离占位后的剩余文本（供正文显示）。
 */
export function resolveStatusPlaceholder(text) {
    if (!text) return { present: false, residual: '' };
    const str = String(text);
    const present = STATUS_PLACEHOLDER_RE.test(str);
    return { present, residual: present ? str.replace(STATUS_PLACEHOLDER_RE, '') : str };
}

/**
 * 生成 MVU 状态栏 HTML（状态面板渲染）。
 * 键值网格 + 来源/更新方式标记；无数据返回占位提示。
 * @param {object} variables - { stat_data, initSource, lastUpdate }
 * @returns {string}
 */
export function renderMvuStatusBar(variables) {
    const stat = (variables && variables.stat_data) || {};
    const keys = Object.keys(stat || {});
    if (keys.length === 0) {
        return '<div class="gateway-empty-hint">（无 MVU 变量数据，首次 run 后自动从角色卡初始化）</div>';
    }
    let html = '<div class="gateway-mvu-grid">';
    const rows = flattenVars(stat);
    for (let i = 0; i < rows.length; i++) {
        html += '<div class="gateway-mvu-row"><span class="gateway-mvu-key">' + escapeHtml(rows[i].key) + '</span>' +
            '<span class="gateway-mvu-val">' + escapeHtml(rows[i].value) + '</span></div>';
    }
    html += '</div>';
    if (variables && variables.initSource) {
        html += '<div class="gateway-mvu-meta">🎴 初始变量：' + escapeHtml(variables.initSource) + '</div>';
    }
    if (variables && variables.lastUpdate) {
        const via = variables.lastUpdate.via === 'processor'
            ? '🤖 变量子代理'
            : '🏷 标签解析（兼容路径）';
        html += '<div class="gateway-mvu-meta">' + via + ' · 更新 ' + escapeHtml(variables.lastUpdate.count) + ' 项</div>';
    }
    return html;
}

/** 扁平化嵌套变量（供状态栏/查看器共用） */
export function flattenVars(obj, prefix, out) {
    out = out || [];
    if (obj === null || typeof obj !== 'object') {
        out.push({ key: prefix || '(值)', value: String(obj) });
        return out;
    }
    if (Array.isArray(obj)) {
        obj.forEach(function (v, i) { flattenVars(v, (prefix || '') + '[' + i + ']', out); });
        return out;
    }
    Object.keys(obj).forEach(function (k) {
        const v = obj[k];
        if (v !== null && typeof v === 'object') {
            flattenVars(v, prefix ? prefix + '.' + k : k, out);
        } else {
            out.push({ key: prefix ? prefix + '.' + k : k, value: typeof v === 'string' ? v : JSON.stringify(v) });
        }
    });
    return out;
}

// ==================== 预设标签注册（默认启用，行为与既有兼容层一致） ====================

// <maintext> 正文卡
registerTag('maintext', function (inner) {
    return '<div class="th-maintext">' + escapeHtml(inner).replace(/\r?\n/g, '<br>') + '</div>';
});

// <mission> 任务卡
registerTag('mission', function (inner) {
    return '<div class="th-mission">🎯 任务：' + escapeHtml(inner.trim()) + '</div>';
});

// <sum> 小总结 chip
registerTag('sum', function (inner) {
    return '<div class="th-sum">📌 小总结：' + escapeHtml(inner.trim()) + '</div>';
});

// ==================== 浏览器挂载 ====================

if (typeof window !== 'undefined' && !window.AgentRenderer) {
    window.AgentRenderer = {
        sanitizeHtml, hasHtmlMarker,
        registerTag, registerMacro, registerLine, renderText,
        renderMessage, plainText,
        hasStatusPlaceholder, resolveStatusPlaceholder, renderMvuStatusBar,
        escapeHtml, flattenVars,
    };
}
