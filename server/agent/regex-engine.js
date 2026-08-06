/**
 * Regex Engine — 正则表达式引擎
 *
 * 参考 SillyTavern 的 regex 扩展实现，提供：
 * 1. 正则脚本持久化存储（data/regex-scripts.json）
 * 2. CRUD 操作（list / create / update / delete）
 * 3. 正则应用（getRegexedString）
 * 4. 角色卡 / 世界书内嵌正则自动导入
 *
 * 正则脚本数据结构（兼容 SillyTavern RegexScriptData）：
 * {
 *   id:           string  — UUID
 *   scriptName:   string  — 脚本名称
 *   findRegex:    string  — 查找正则（支持 /pattern/flags 格式）
 *   replaceString:string  — 替换字符串（支持 $1/$<name>/{{match}}）
 *   trimStrings:  string[]— 修剪字符串
 *   placement:    number[]— 应用位置（1=用户输入, 2=AI输出, 5=世界信息）
 *   disabled:     boolean — 是否禁用
 *   markdownOnly: boolean — 仅影响显示
 *   promptOnly:   boolean — 仅影响提示词
 *   runOnEdit:    boolean — 编辑时运行
 *   substituteRegex: number — 宏替换模式（0=不替换）
 *   minDepth:     number|null
 *   maxDepth:     number|null
 *   source:       string  — 来源（"global" | "character:名称" | "worldbook:名称"）
 * }
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==================== 常量 ====================

/** 应用位置枚举（与 SillyTavern 一致） */
export const REGEX_PLACEMENT = {
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    WORLD_INFO: 5,
    REASONING: 6,
};

/** 默认脚本结构 */
function defaultScript() {
    return {
        id: '',
        scriptName: '',
        findRegex: '',
        replaceString: '',
        trimStrings: [],
        placement: [REGEX_PLACEMENT.USER_INPUT, REGEX_PLACEMENT.AI_OUTPUT],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
        source: 'global',
    };
}

// ==================== RegexStore — 持久化存储 ====================

class RegexStore {
    constructor(dataDir) {
        this.filePath = path.join(dataDir, 'regex-scripts.json');
        this.scripts = [];
        this._load();
    }

    _load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    this.scripts = parsed.map(s => ({ ...defaultScript(), ...s }));
                }
            }
        } catch (e) {
            console.warn('[regex-engine] 加载正则脚本失败，使用空列表:', e.message);
            this.scripts = [];
        }
    }

    _save() {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(this.scripts, null, 2), 'utf-8');
        } catch (e) {
            console.error('[regex-engine] 保存正则脚本失败:', e.message);
        }
    }

    list() {
        return this.scripts.map(s => ({ ...s }));
    }

    /**
     * 按角色过滤脚本（数据隔离核心）。
     * 返回「全局脚本 + 当前角色专属脚本」，保证：
     *   - 切换角色时前一角色的脚本立即停用（不参与正则应用）
     *   - 同一角色来回切换时脚本不丢失（存储层完整保留）
     * @param {string} characterName - 当前角色名（空字符串/undefined 时仅返回全局脚本）
     * @returns {Array} 当前会话生效的脚本列表
     */
    getActiveScripts(characterName) {
        const charSource = characterName ? `character:${characterName}` : null;
        return this.scripts.filter(s =>
            s.source === 'global' || (charSource && s.source === charSource)
        ).map(s => ({ ...s }));
    }

    /**
     * 按来源前缀过滤脚本（供前端列表按角色展示）。
     * @param {string} sourcePrefix - 来源前缀，如 'character:' 或完整 'character:名称'
     * @returns {Array}
     */
    listBySource(sourcePrefix) {
        if (!sourcePrefix) return this.list();
        return this.scripts.filter(s =>
            s.source === sourcePrefix || (sourcePrefix.endsWith(':') && s.source.startsWith(sourcePrefix))
        ).map(s => ({ ...s }));
    }

    get(id) {
        return this.scripts.find(s => s.id === id) || null;
    }

    create(data) {
        const script = { ...defaultScript(), ...data, id: randomUUID() };
        this.scripts.push(script);
        this._save();
        return { ...script };
    }

    update(id, data) {
        const idx = this.scripts.findIndex(s => s.id === id);
        if (idx === -1) return null;
        this.scripts[idx] = { ...this.scripts[idx], ...data, id };
        this._save();
        return { ...this.scripts[idx] };
    }

    delete(id) {
        const idx = this.scripts.findIndex(s => s.id === id);
        if (idx === -1) return false;
        this.scripts.splice(idx, 1);
        this._save();
        return true;
    }

    /**
     * 批量导入（来自角色卡/世界书）。
     * 去重键 = source + scriptName + findRegex：
     *   - 同一角色的重复导入不重复添加
     *   - 不同角色即使脚本内容相同也各自独立（保证每角色专属，互不串扰）
     * @param {Array} scripts - 待导入脚本数组
     * @param {string} source - 来源标识（如 'character:名称'）
     * @returns {number} 实际新增数量
     */
    importBatch(scripts, source) {
        let added = 0;
        const src = source || 'global';
        for (const s of scripts) {
            const exists = this.scripts.some(x =>
                x.source === src
                && x.scriptName === s.scriptName
                && x.findRegex === s.findRegex
            );
            if (!exists) {
                this.scripts.push({
                    ...defaultScript(),
                    ...s,
                    id: randomUUID(),
                    source: src,
                });
                added++;
            }
        }
        if (added > 0) this._save();
        return added;
    }
}

// ==================== RegexEngine — 正则应用逻辑 ====================

/**
 * 解析 /pattern/flags 格式的正则字符串，返回 RegExp 对象。
 * 不带斜杠包裹时默认 flags = 'g'。
 */
export function parseRegex(regexStr) {
    if (!regexStr) return null;
    const str = String(regexStr).trim();
    // /pattern/flags 格式
    const match = str.match(/^\/(.+)\/([gimsuy]*)$/s);
    if (match) {
        return new RegExp(match[1], match[2]);
    }
    // 裸 pattern，默认全局匹配
    return new RegExp(str, 'g');
}

/**
 * 验证正则表达式语法，返回 { valid: boolean, error?: string }
 */
export function validateRegex(regexStr) {
    if (!regexStr || !String(regexStr).trim()) {
        return { valid: false, error: '正则表达式不能为空' };
    }
    try {
        parseRegex(regexStr);
        return { valid: true };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

/**
 * 应用单个正则脚本到文本。
 * @param {object} script — 正则脚本
 * @param {string} rawString — 原始文本
 * @returns {string} 处理后的文本
 */
function runScript(script, rawString) {
    if (!rawString || script.disabled || !script.findRegex) return rawString;

    let regex;
    try {
        regex = parseRegex(script.findRegex);
    } catch (e) {
        console.warn(`[regex-engine] 脚本 "${script.scriptName}" 正则编译失败:`, e.message);
        return rawString;
    }

    const replaceStr = (script.replaceString || '')
        .replace(/\{\{match\}\}/gi, '$$0'); // {{match}} -> $0

    // trimStrings: 替换前从匹配文本中移除
    const trims = Array.isArray(script.trimStrings) ? script.trimStrings.filter(Boolean) : [];

    try {
        return rawString.replace(regex, (match, ...args) => {
            let filtered = match;
            for (const t of trims) {
                filtered = filtered.split(t).join('');
            }
            // 替换 $0 为过滤后的完整匹配
            return replaceStr.replace(/\$0\b/g, () => filtered)
                .replace(/\$(\d+)/g, (_, n) => {
                    const idx = parseInt(n, 10);
                    return args[idx - 1] != null ? args[idx - 1] : '';
                });
        });
    } catch (e) {
        console.warn(`[regex-engine] 脚本 "${script.scriptName}" 执行失败:`, e.message);
        return rawString;
    }
}

/**
 * 对文本应用所有匹配的正则脚本。
 * 参考 SillyTavern getRegexedString 的短暂性 (ephemerality) 机制。
 *
 * @param {string} rawString — 原始文本
 * @param {number} placement — 应用位置（REGEX_PLACEMENT 枚举）
 * @param {object} options
 * @param {boolean} options.isPrompt — 是否为提示词场景（promptOnly 脚本生效）
 * @param {boolean} options.isMarkdown — 是否为显示场景（markdownOnly 脚本生效）
 * @param {Array}  options.scripts — 可选，指定脚本列表（默认用 store 全量）
 * @returns {string} 处理后的文本
 */
export function getRegexedString(rawString, placement, options = {}) {
    if (!rawString || placement == null) return rawString;

    const { isPrompt = false, isMarkdown = false, scripts = null } = options;
    const allScripts = scripts || [];
    let result = rawString;

    for (const script of allScripts) {
        if (!script || script.disabled) continue;

        // 短暂性检查
        const isEphemeral = script.markdownOnly || script.promptOnly;
        if (isEphemeral) {
            if (script.markdownOnly && isMarkdown) {
                // 仅显示场景
            } else if (script.promptOnly && isPrompt) {
                // 仅提示词场景
            } else if (script.markdownOnly && script.promptOnly && (isMarkdown || isPrompt)) {
                // 同时影响显示和提示词
            } else {
                continue;
            }
        }
        // 非短暂性脚本（两者都 false）：所有场景都生效

        // 位置检查
        if (Array.isArray(script.placement) && !script.placement.includes(placement)) continue;

        result = runScript(script, result);
    }

    return result;
}

// ==================== 单例导出 ====================

let _store = null;

/**
 * 初始化 RegexStore（由 server 在启动时调用）。
 * @param {string} dataDir — 数据目录路径
 */
export function initRegexStore(dataDir) {
    if (!_store) {
        _store = new RegexStore(dataDir);
    }
    return _store;
}

/**
 * 获取 RegexStore 实例（需先 initRegexStore）。
 */
export function getRegexStore() {
    return _store;
}

/**
 * 从角色卡数据中提取内嵌的 regex_scripts 并自动导入。
 * @param {object} card — 角色卡数据（V2/V3）
 * @param {string} characterName — 角色名（用于 source 标记）
 * @returns {number} 导入数量
 */
export function importRegexFromCard(card, characterName) {
    if (!_store) return 0;
    const scripts = card?.data?.extensions?.regex_scripts
        || card?.extensions?.regex_scripts
        || null;
    if (!Array.isArray(scripts) || scripts.length === 0) return 0;

    return _store.importBatch(scripts, `character:${characterName || card?.data?.name || 'unknown'}`);
}
