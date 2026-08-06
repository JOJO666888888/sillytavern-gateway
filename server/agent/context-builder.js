import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadCharacterCard } from '../runtime/card-loader.js';
import { loadLorebook, normalizeLorebook, activateEntries } from '../runtime/worldbook-engine.js';
import { MacroEngine } from '../runtime/macro-engine.js';
import { userProfileStore } from '../runtime/user-profile-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 从 Agent 定义的 context.injectAssets 中提取声明变量。
 *
 * 语义：injectAssets 中形如 `"${style}"` 的值表示"该资产由会话运行时变量 style 注入"，
 * 提取结果为变量名本身（'style'）；普通字符串值原样返回；未声明返回 ''。
 *
 * 供 meta.style 语义统一使用（session.style > injectAssets 变量名 > 顶层 definition.style），
 * 也供其它需要提取定义变量的调用方复用。
 * @param {Object} definition - Agent 定义
 * @param {string} varName - 变量名（如 'style' / 'character' / 'worldbook'）
 * @returns {string}
 */
export function extractDefinitionVar(definition, varName) {
    const inject = definition?.context?.injectAssets || {};
    const val = inject[varName];
    if (val && val.startsWith('${') && val.endsWith('}')) {
        return val.slice(2, -1); // 返回变量名本身
    }
    return val || '';
}

export class ContextBuilder {
    constructor(options = {}) {
        this.assetsDir = options.assetsDir || path.resolve(__dirname, '..', '..', 'assets');
        this.dataDir = options.dataDir || path.resolve(__dirname, '..', '..', 'data', 'plugins', 'agent-framework');
        this.scanDepth = options.scanDepth || 5;
        this.worldMaxRecursion = options.worldMaxRecursion || 2;
        // ST 宏开关：默认开启；关闭时仅替换 {{char}}/{{user}}（向后兼容，与 preset-engine 一致）
        this.enableMacros = options.enableMacros !== undefined ? options.enableMacros : true;
        // 会话级宏变量持久化：Map<sessionKey, Map<变量名(小写), 值>>
        // ContextBuilder 为全局单例、被多会话共享，因此按 sessionKey 隔离，
        // setvar 声明的变量在同一会话内跨 build 轮次累积、getvar 可读（内存级，不落盘）。
        this._sessionVariables = new Map();
        // P2-1: 角色卡/世界书解析缓存（按文件 mtime 失效，外部修改即时生效）。
        // 此前每次 build 都重新读盘+解析 PNG（含 inflateSync），高频对话下 CPU 浪费明显。
        this._assetCache = new Map(); // filePath -> { mtimeMs, value }
        // 用户自定义档案（自定义用户名 + 人设）：默认用共享单例，测试可注入隔离实例
        this._userProfile = options.userProfileStore || userProfileStore;
    }

    /**
     * P2-1: 带 mtime 失效的资产加载缓存。
     * 命中缓存直接返回解析结果；文件 mtime 变化（外部修改）时自动重新解析。
     * @param {string} filePath - 资产文件绝对路径
     * @param {(filePath: string) => any} loader - 解析函数（loadCharacterCard / loadLorebook）
     * @returns {any|null} 解析结果，文件缺失/解析失败返回 null
     * @private
     */
    _cachedLoad(filePath, loader) {
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (_) {
            return null;
        }
        if (!stat.isFile()) return null;
        const hit = this._assetCache.get(filePath);
        if (hit && hit.mtimeMs === stat.mtimeMs) return hit.value;
        try {
            const value = loader(filePath);
            this._assetCache.set(filePath, { mtimeMs: stat.mtimeMs, value });
            return value;
        } catch (e) {
            return null;
        }
    }

    /**
     * 构建 Agent 执行上下文
     * @param {Object} definition - Agent YAML 定义
     * @param {Object} session - 会话状态 {character, worldbook, style, platform, chatId}
     * @param {Array} history - 历史消息 [{role, content}]
     * @param {string} userMessage - 当前用户消息
     * @returns {Array} messages 数组
     */
    build(definition, session, history, userMessage) {
        const parts = [];

        // 1. system prompt（变量替换后再过宏：保证 systemPrompt 头部的 {{setvar}} 先执行、
        //    后续 assets/files/history/userMessage 中的 {{getvar}} 可读）
        const systemPrompt = this._applyMacros(this._replaceVars(definition.systemPrompt || '', session), session);
        parts.push(systemPrompt);

        // 2. 注入资产
        if (definition.context?.injectAssets) {
            const assetText = this._injectAssets(definition.context.injectAssets, session, history, userMessage);
            if (assetText) parts.push(assetText);
        }

        // 3. 注入文件
        if (definition.context?.injectFiles) {
            const fileText = this._injectFiles(definition.context.injectFiles, session);
            if (fileText) parts.push(fileText);
        }

        // 4. 用户自定义人设注入（RP 主路径）：用户提供了人设时，把自定义用户名与人设拼进 system
        const up = this._userProfile?.get();
        if (up && up.persona) {
            parts.push(`【用户人设】\n${up.persona}`);
        }

        // 构建 messages
        const messages = [];
        messages.push({ role: 'system', content: parts.join('\n\n') });

        // 历史消息
        const limit = definition.context?.historyLimit || 20;
        const trimmedHistory = history.slice(-limit * 2); // 每轮2条消息
        for (const msg of trimmedHistory) {
            // 复制消息对象且 content 过宏，避免就地修改调用方 history 数组
            messages.push({ ...msg, content: this._applyMacros(msg.content, session) });
        }

        // 当前消息
        if (userMessage) {
            messages.push({ role: 'user', content: this._applyMacros(userMessage, session) });
        }

        return messages;
    }

    _replaceVars(text, session) {
        return text
            .replace(/\$\{character\}/g, session.character || '')
            .replace(/\$\{worldbook\}/g, session.worldbook || '')
            .replace(/\$\{style\}/g, session.style || '')
            .replace(/\$\{platform\}/g, session.platform || '')
            .replace(/\$\{chatId\}/g, session.chatId || '');
    }

    /**
     * 会话级宏变量表（Map<sessionKey, Map>）：setvar 声明的变量在同一会话内跨 build 轮次持久。
     * sessionKey = `${session.platform}:${session.chatId}`，两者缺失时统一用 'unknown' 兜底，
     * 防止无 key 会话的变量互相串台。
     * @param {Object} session - 会话状态
     * @returns {Map<string, string>} 该会话的变量 Map（不存在则创建）
     */
    _getMacroVariables(session) {
        const platform = session.platform || '';
        const chatId = session.chatId || '';
        const key = (platform && chatId) ? `${platform}:${chatId}` : 'unknown';
        let vars = this._sessionVariables.get(key);
        if (!vars) {
            vars = new Map();
            this._sessionVariables.set(key, vars);
        }
        return vars;
    }

    /**
     * 解析宏引擎 charName：优先 session.charName；否则若 session.character 有值则尝试
     * 加载角色卡取真实 card.name；再否则 'Assistant'。
     * @param {Object} session - 会话状态
     * @returns {string}
     */
    _getCharName(session) {
        if (session.charName) return session.charName;
        if (session.character) {
            const card = this._loadCharacterCard(session.character);
            if (card && card.name) return card.name;
        }
        return 'Assistant';
    }

    /**
     * 展开文本宏（统一 sub 模式，与 preset-engine.buildPrompt 一致）：
     *   - 启用宏时用 MacroEngine 完整展开（setvar/getvar/roll/random/注释/{{char}}/{{user}}）；
     *   - 关闭时仅替换 {{char}}/{{user}}（向后兼容）。
     * 注意：仅内容文本过宏；路径/变量名替换（_replaceVars）调用点不过宏。
     * @param {string} text - 原始文本
     * @param {Object} session - 会话状态
     * @returns {string}
     */
    _applyMacros(text, session) {
        if (!text) return '';
        const charName = this._getCharName(session);
        // userName 优先级：会话级显式覆盖 > 用户自定义配置 > 默认 'user'
        const userName = session.userName || this._userProfile?.get()?.name || 'user';
        if (this.enableMacros) {
            // MacroEngine 实例轻量，每次新建即可；变量表（Map 引用）持久是关键
            return new MacroEngine({ charName, userName, variables: this._getMacroVariables(session) }).process(text);
        }
        return text
            .replace(/\{\{char\}\}/gi, charName)
            .replace(/\{\{user\}\}/gi, userName);
    }

    /**
     * 注入资产（角色卡 + 世界书）
     *
     * P0 改造：复用 NativeRuntime 的归一化加载器与世界书激活引擎，
     * 替代原先的直接文件读取 + 全量注入。
     *
     * @param {Object} injectAssets - definition.context.injectAssets
     * @param {Object} session - 会话状态
     * @param {Array} history - 历史消息 [{role, content}]（供世界书关键词扫描）
     * @param {string} userMessage - 当前用户消息（供世界书关键词扫描）
     * @returns {string} 拼接后的资产文本
     */
    _injectAssets(injectAssets, session, history = [], userMessage = '') {
        const parts = [];
        // 角色卡：使用 loadCharacterCard 归一化加载（支持 PNG 内嵌 + V1/V2/V3）
        if (injectAssets.character) {
            const name = this._replaceVars(injectAssets.character, session);
            const card = this._loadCharacterCard(name);
            if (card) {
                const charParts = [];
                if (card.description) charParts.push(`【角色描述】\n${card.description}`);
                if (card.personality) charParts.push(`【性格】\n${card.personality}`);
                if (card.scenario) charParts.push(`【场景】\n${card.scenario}`);
                if (card.mesExample) charParts.push(`【对话示例】\n${card.mesExample}`);
                // P1 修复：真实 V3 角色卡（社区常见）的 description/personality 往往为空，
                // 人物设定全部存在内嵌 character_book 里。与独立世界书同规则做关键词激活后注入，
                // 否则此类角色卡对 system 零贡献（此前验证发现 3 张真实卡均缺描述字段）。
                if (card.characterBook) {
                    const bookEntries = normalizeLorebook(card.characterBook);
                    if (bookEntries.length > 0) {
                        const scanText = [...history.slice(-this.scanDepth).map(h => h.content || ''), userMessage].join('\n');
                        const activated = activateEntries(bookEntries, scanText, {
                            maxRecursion: this.worldMaxRecursion,
                        });
                        const allEntries = [...(activated.beforeChar || []), ...(activated.afterChar || [])];
                        if (allEntries.length > 0) {
                            charParts.push(`【角色内嵌世界书】\n${allEntries.join('\n---\n')}`);
                        }
                    }
                }
                if (charParts.length > 0) parts.push(charParts.join('\n\n'));
            }
        }
        // 世界书：使用 loadLorebook 归一化 + activateEntries 关键词激活
        if (injectAssets.worldbook) {
            const name = this._replaceVars(injectAssets.worldbook, session);
            const entries = this._loadWorldbook(name);
            if (entries && entries.length > 0) {
                // 构建扫描文本：最近 N 条历史消息 + 当前输入
                const scanText = [...history.slice(-this.scanDepth).map(h => h.content || ''), userMessage].join('\n');
                const activated = activateEntries(entries, scanText, {
                    maxRecursion: this.worldMaxRecursion,
                });
                const allEntries = [...(activated.beforeChar || []), ...(activated.afterChar || [])];
                if (allEntries.length > 0) {
                    parts.push(`【世界书】\n${allEntries.join('\n---\n')}`);
                }
            }
        }
        // 拼接后的完整资产文本（角色卡 + 内嵌世界书 + 世界书激活条目）统一过宏
        return parts.length > 0 ? this._applyMacros(parts.join('\n\n'), session) : '';
    }

    /**
     * 加载角色卡（支持 .json 和 .png，自动归一化 V1/V2/V3 格式）
     *
     * P1 修复：真实资产文件名常含中文/括号/连字符/全角符号等特殊字符，
     * 且扩展名可能大写（如 .PNG）。此前仅精确拼接扩展名匹配，遇到
     * 大小写不一致或特殊字符文件名会加载失败。现在：
     *   1. 扩展名判定改为大小写不敏感（path.extname().toLowerCase()）
     *   2. 精确路径未命中时，回退到目录扫描：按 basename 大小写不敏感匹配
     *      （.json 优先于 .png，与历史行为一致）
     * @param {string} name - 角色卡名（可带或不带扩展名）
     * @returns {Object|null} 归一化后的角色卡，或 null
     */
    _loadCharacterCard(name) {
        const charsDir = path.join(this.assetsDir, 'characters');
        const ext = path.extname(name).toLowerCase();
        const hasExt = ext === '.json' || ext === '.png';
        const candidates = hasExt
            ? [path.join(charsDir, name)]
            : [path.join(charsDir, name + '.json'), path.join(charsDir, name + '.png')];
        for (const filePath of candidates) {
            if (fs.existsSync(filePath)) {
                // P2-1: 走 mtime 缓存，避免每轮重复解析 PNG/JSON
                const card = this._cachedLoad(filePath, loadCharacterCard);
                if (card) return card;
            }
        }
        // 目录扫描回退：处理大小写扩展名（.PNG）、特殊字符文件名、名称大小写差异
        const found = this._findAssetFile(charsDir, name, ['.json', '.png']);
        if (found) {
            const card = this._cachedLoad(found, loadCharacterCard);
            if (card) return card;
        }
        return null;
    }

    /**
     * 加载世界书（归一化为统一条目数组）
     *
     * P1 修复：与 _loadCharacterCard 相同的容错策略——大小写不敏感扩展名
     * + 目录扫描回退（真实世界书文件名含大量连字符/全角符号，精确拼接易失败）。
     * @param {string} name - 世界书名（可带或不带 .json 扩展名）
     * @returns {Array|null} 归一化后的条目数组，或 null
     */
    _loadWorldbook(name) {
        const wbDir = path.join(this.assetsDir, 'worldbooks');
        const ext = path.extname(name).toLowerCase();
        const candidates = ext === '.json'
            ? [path.join(wbDir, name)]
            : [path.join(wbDir, name + '.json')];
        for (const filePath of candidates) {
            if (fs.existsSync(filePath)) {
                // P2-1: 走 mtime 缓存
                const entries = this._cachedLoad(filePath, loadLorebook);
                if (entries) return entries;
            }
        }
        // 目录扫描回退
        const found = this._findAssetFile(wbDir, name, ['.json']);
        if (found) {
            const entries = this._cachedLoad(found, loadLorebook);
            if (entries) return entries;
        }
        return null;
    }

    /**
     * 在资产目录中按名称大小写不敏感地查找文件（P1 容错加载回退）。
     *
     * 匹配规则：
     *   - 仅匹配给定扩展名（大小写不敏感，覆盖 .PNG/.Json 等）
     *   - basename（去扩展名）与 name（去扩展名）忽略大小写比较
     *   - 命中多个时返回第一个（目录顺序），保证确定性
     * @param {string} dir - 资产目录
     * @param {string} name - 查找名称（可带扩展名）
     * @param {string[]} exts - 允许的扩展名列表（如 ['.json', '.png']）
     * @returns {string|null} 文件绝对路径，未命中返回 null
     */
    _findAssetFile(dir, name, exts) {
        if (!fs.existsSync(dir)) return null;
        const targetExt = path.extname(name).toLowerCase();
        const baseName = targetExt ? name.slice(0, -targetExt.length) : name;
        const baseLower = baseName.toLowerCase();
        const extSet = new Set(exts.map(e => e.toLowerCase()));
        for (const f of fs.readdirSync(dir)) {
            const fExt = path.extname(f).toLowerCase();
            if (!extSet.has(fExt)) continue;
            const fBase = f.slice(0, -fExt.length);
            if (fBase.toLowerCase() === baseLower) {
                return path.join(dir, f);
            }
        }
        return null;
    }

    /**
     * 加载角色卡（公开方法，供开场白机制 / greetings 端点复用）。
     * @param {string} name - 角色卡名
     * @returns {Object|null} 归一化角色卡（含 first_message / alternateGreetings），或 null
     */
    loadCard(name) {
        return this._loadCharacterCard(name);
    }

    /**
     * 获取角色卡开场白列表（P3）：
     * 返回 { character, firstMessage, alternateGreetings, greetings }，
     * 其中 greetings = [firstMessage, ...alternateGreetings]（过滤空串），
     * 供开场白注入与 GET /api/agent-theatre/greetings 端点使用。
     * @param {string} name - 角色卡名
     * @returns {Object|null} 无卡或无开场白返回 null
     */
    getGreetingList(name) {
        const card = this._loadCharacterCard(name);
        if (!card) return null;
        const first = card.first_message || card.firstMes || '';
        const alternates = Array.isArray(card.alternateGreetings) ? card.alternateGreetings.filter(Boolean) : [];
        const greetings = [first, ...alternates].filter(Boolean);
        if (greetings.length === 0) {
            return { character: card.name || name, firstMessage: '', alternateGreetings: [], greetings, card };
        }
        return {
            character: card.name || name,
            firstMessage: first,
            alternateGreetings: alternates,
            greetings,
            card,
        };
    }

    /**
     * 按序号选择开场白（P3）：从 [first_message, ...alternate_greetings] 中取
     * 第 greetingIndex 个（取模循环，越界安全）。无开场白返回 ''。
     * @param {string} name - 角色卡名
     * @param {number} [greetingIndex=0] - 开场白序号（默认 0 = first_message）
     * @returns {string}
     */
    selectGreeting(name, greetingIndex = 0) {
        const list = this.getGreetingList(name);
        if (!list || list.greetings.length === 0) return '';
        const idx = Number.isInteger(Number(greetingIndex)) ? Math.max(0, Number(greetingIndex)) : 0;
        return list.greetings[idx % list.greetings.length] || '';
    }

    _injectFiles(injectFiles, session) {
        const parts = [];
        for (const filePattern of injectFiles) {
            const filePath = this._replaceVars(filePattern, session);
            const fullPath = path.join(this.dataDir, filePath);
            if (fs.existsSync(fullPath)) {
                try {
                    // 读取到的文件内容过宏（路径替换本身不过宏）
                    const content = this._applyMacros(fs.readFileSync(fullPath, 'utf-8').trim(), session);
                    if (content) parts.push(content);
                } catch (e) { /* 忽略 */ }
            }
        }
        return parts.length > 0 ? parts.join('\n\n---\n\n') : '';
    }
}
