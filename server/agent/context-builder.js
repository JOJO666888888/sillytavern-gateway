import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class ContextBuilder {
    constructor(options = {}) {
        this.assetsDir = options.assetsDir || path.resolve(__dirname, '..', '..', 'assets');
        this.dataDir = options.dataDir || path.resolve(__dirname, '..', '..', 'data', 'plugins', 'agent-framework');
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
            const assetText = this._injectAssets(definition.context.injectAssets, session);
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

    _injectAssets(injectAssets, session) {
        const parts = [];
        // 角色卡
        if (injectAssets.character) {
            const name = this._replaceVars(injectAssets.character, session);
            const charPath = path.join(this.assetsDir, 'characters', name.endsWith('.json') ? name : name + '.json');
            if (fs.existsSync(charPath)) {
                try {
                    const card = JSON.parse(fs.readFileSync(charPath, 'utf-8'));
                    const charParts = [];
                    if (card.description) charParts.push(`【角色描述】\n${card.description}`);
                    if (card.personality) charParts.push(`【性格】\n${card.personality}`);
                    if (card.scenario) charParts.push(`【场景】\n${card.scenario}`);
                    if (card.mes_example) charParts.push(`【对话示例】\n${card.mes_example}`);
                    if (charParts.length > 0) parts.push(charParts.join('\n\n'));
                } catch (e) { /* 忽略解析错误 */ }
            }
        }
        // 世界书
        if (injectAssets.worldbook) {
            const name = this._replaceVars(injectAssets.worldbook, session);
            const wbPath = path.join(this.assetsDir, 'worldbooks', name.endsWith('.json') ? name : name + '.json');
            if (fs.existsSync(wbPath)) {
                try {
                    const wb = JSON.parse(fs.readFileSync(wbPath, 'utf-8'));
                    const entries = wb.entries || {};
                    const entryTexts = Object.values(entries)
                        .filter(e => e.content && e.key)
                        .map(e => e.content);
                    if (entryTexts.length > 0) {
                        parts.push(`【世界书】\n${entryTexts.join('\n---\n')}`);
                    }
                } catch (e) { /* 忽略 */ }
            }
        }
        return parts.length > 0 ? parts.join('\n\n') : '';
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
