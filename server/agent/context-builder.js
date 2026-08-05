import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadCharacterCard } from '../runtime/card-loader.js';
import { loadLorebook, activateEntries } from '../runtime/worldbook-engine.js';

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

        // 1. system prompt（变量替换后）
        const systemPrompt = this._replaceVars(definition.systemPrompt || '', session);
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

        // 构建 messages
        const messages = [];
        messages.push({ role: 'system', content: parts.join('\n\n') });

        // 历史消息
        const limit = definition.context?.historyLimit || 20;
        const trimmedHistory = history.slice(-limit * 2); // 每轮2条消息
        for (const msg of trimmedHistory) {
            messages.push(msg);
        }

        // 当前消息
        if (userMessage) {
            messages.push({ role: 'user', content: userMessage });
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
        return parts.length > 0 ? parts.join('\n\n') : '';
    }

    /**
     * 加载角色卡（支持 .json 和 .png，自动归一化 V1/V2/V3 格式）
     * @param {string} name - 角色卡名（可带或不带扩展名）
     * @returns {Object|null} 归一化后的角色卡，或 null
     */
    _loadCharacterCard(name) {
        const charsDir = path.join(this.assetsDir, 'characters');
        const hasExt = name.endsWith('.json') || name.endsWith('.png');
        const candidates = hasExt
            ? [path.join(charsDir, name)]
            : [path.join(charsDir, name + '.json'), path.join(charsDir, name + '.png')];
        for (const filePath of candidates) {
            if (fs.existsSync(filePath)) {
                try {
                    return loadCharacterCard(filePath);
                } catch (e) { /* 忽略解析错误 */ }
            }
        }
        return null;
    }

    /**
     * 加载世界书（归一化为统一条目数组）
     * @param {string} name - 世界书名（可带或不带 .json 扩展名）
     * @returns {Array|null} 归一化后的条目数组，或 null
     */
    _loadWorldbook(name) {
        const wbPath = path.join(this.assetsDir, 'worldbooks', name.endsWith('.json') ? name : name + '.json');
        if (fs.existsSync(wbPath)) {
            try {
                return loadLorebook(wbPath);
            } catch (e) { /* 忽略 */ }
        }
        return null;
    }

    _injectFiles(injectFiles, session) {
        const parts = [];
        for (const filePattern of injectFiles) {
            const filePath = this._replaceVars(filePattern, session);
            const fullPath = path.join(this.dataDir, filePath);
            if (fs.existsSync(fullPath)) {
                try {
                    const content = fs.readFileSync(fullPath, 'utf-8').trim();
                    if (content) parts.push(content);
                } catch (e) { /* 忽略 */ }
            }
        }
        return parts.length > 0 ? parts.join('\n\n---\n\n') : '';
    }
}
