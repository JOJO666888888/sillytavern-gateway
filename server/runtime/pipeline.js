import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';
import { loadCharacterCard, listCharacterCards } from './card-loader.js';
import { normalizeLorebook, loadLorebook, activateEntries } from './worldbook-engine.js';
import { ChatArchive, listArchives } from './chat-archive.js';
import { loadPreset, defaultPreset, buildPrompt } from './preset-engine.js';
import { LLMClient } from './llm-client.js';
import { ProfileStore } from './profile-store.js';

const logger = createLogger('runtime');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

/**
 * 自建推理管线（Native Runtime）
 *
 * ⭐ 这是「第二 SillyTavern 生态」的核心：网关自己完成 prompt 组装与 LLM 调用，
 * **不再需要挂着浏览器里的 SillyTavern 前端**。ST 退位为"资产编辑器"
 * （你仍用它做卡/世界书/预设），网关成为"运行时"。
 *
 * 资产目录（默认在仓库根，可配置）：
 *   assets/characters/  角色卡 (.png / .json)
 *   assets/worldbooks/  世界书 (.json)
 *   assets/presets/     预设 (.json)
 *   data/chats/         聊天存档 (.jsonl，与 ST 互通)
 */
export class NativeRuntime {
    /**
     * @param {object} options
     *   @param {object} options.config - runtime 配置（见 config.js runtime 段）
     */
    constructor(options = {}) {
        const cfg = options.config || {};
        this.config = cfg;
        this.dirs = {
            characters: path.resolve(ROOT, cfg.charactersDir || 'assets/characters'),
            worldbooks: path.resolve(ROOT, cfg.worldbooksDir || 'assets/worldbooks'),
            presets: path.resolve(ROOT, cfg.presetsDir || 'assets/presets'),
            chats: path.resolve(ROOT, cfg.chatsDir || 'data/chats'),
        };
        this.profiles = new ProfileStore({ defaults: cfg.defaults || {} });
        this._cardCache = new Map();
        this._bookCache = new Map();
        this._presetCache = new Map();
    }

    /** 资产列表（供命令/API 展示） */
    listAssets() {
        return {
            characters: listCharacterCards(this.dirs.characters).map(c => c.name),
            worldbooks: fs.existsSync(this.dirs.worldbooks)
                ? fs.readdirSync(this.dirs.worldbooks).filter(f => f.endsWith('.json')).map(f => path.basename(f, '.json'))
                : [],
            presets: fs.existsSync(this.dirs.presets)
                ? fs.readdirSync(this.dirs.presets).filter(f => f.endsWith('.json')).map(f => path.basename(f, '.json'))
                : [],
            archives: listArchives(this.dirs.chats).map(a => a.name),
        };
    }

    /** 按名字加载角色卡（带缓存） */
    getCard(name) {
        if (!name) return null;
        if (this._cardCache.has(name)) return this._cardCache.get(name);
        const found = listCharacterCards(this.dirs.characters).find(c => c.name === name);
        if (!found) return null;
        const card = loadCharacterCard(found.file);
        this._cardCache.set(name, card);
        return card;
    }

    /** 按名字加载世界书（带缓存） */
    getWorldbook(name) {
        if (this._bookCache.has(name)) return this._bookCache.get(name);
        const file = path.join(this.dirs.worldbooks, `${name}.json`);
        if (!fs.existsSync(file)) return null;
        const book = loadLorebook(file);
        this._bookCache.set(name, book);
        return book;
    }

    /** 按名字加载预设（带缓存），无则默认 */
    getPreset(name) {
        if (!name) return defaultPreset();
        if (this._presetCache.has(name)) return this._presetCache.get(name);
        const file = path.join(this.dirs.presets, `${name}.json`);
        if (!fs.existsSync(file)) return defaultPreset();
        const p = loadPreset(file);
        this._presetCache.set(name, p);
        return p;
    }

    /** 清空资产缓存（资产文件变更后调用） */
    clearCache() {
        this._cardCache.clear();
        this._bookCache.clear();
        this._presetCache.clear();
    }

    /** 取会话的存档对象 */
    getArchive(platform, chatId, profile, card) {
        const nameBase = profile.archive || `${platform}_${chatId}`;
        const file = path.join(this.dirs.chats, `${nameBase}.jsonl`);
        return new ChatArchive(file, {
            userName: profile.persona?.name || 'User',
            characterName: card?.name || 'Assistant',
        });
    }

    /**
     * 组装某会话对某条输入的 prompt（不调用 LLM）——便于测试与 /preview
     * @returns {{messages, sampling, card, archive}}
     */
    prepare(platform, chatId, userInput) {
        const profile = this.profiles.get(platform, chatId);
        const card = this.getCard(profile.character);
        if (!card) throw new Error(`会话未绑定角色卡或角色卡不存在: "${profile.character || '(未设置)'}"`);

        const archive = this.getArchive(platform, chatId, profile, card);
        const history = archive.getHistory(this.config.historyLimit ?? 30);

        // 世界书：会话绑定的 + 角色卡内嵌的
        const entries = [];
        for (const bookName of (profile.worldbooks || [])) {
            const b = this.getWorldbook(bookName);
            if (b) entries.push(...b);
        }
        if (card.characterBook) entries.push(...normalizeLorebook(card.characterBook));

        // 扫描文本：最近若干条历史 + 当前输入
        const scanDepth = this.config.worldScanDepth ?? 5;
        const scanText = [...history.slice(-scanDepth).map(h => h.content), userInput].join('\n');
        const world = activateEntries(entries, scanText, {
            maxRecursion: this.config.worldMaxRecursion ?? 2,
        });

        const preset = this.getPreset(profile.preset);
        const { messages, sampling } = buildPrompt({
            card,
            preset,
            persona: profile.persona,
            world,
            history,
            userInput,
            userName: profile.persona?.name || 'User',
        });

        return { messages, sampling, card, archive, profile, world };
    }

    /**
     * 完整推理：组装 prompt → 调用 LLM → 写入存档 → 返回回复
     * @returns {Promise<string>} AI 回复
     */
    async generate(platform, chatId, userInput, options = {}) {
        const { messages, sampling, card, archive, profile } = this.prepare(platform, chatId, userInput);

        // LLM 配置：会话覆盖 > 全局
        const llmCfg = { ...(this.config.llm || {}), ...(profile.llm || {}) };
        const client = options.client || new LLMClient(llmCfg);

        // 先落用户消息（即便生成失败，用户输入也不丢）
        archive.append({ isUser: true, mes: userInput, name: profile.persona?.name || 'User', sendDate: options.now || 0 });

        const reply = await client.generate(messages, sampling);

        archive.append({ isUser: false, mes: reply, name: card.name, sendDate: options.now || 0 });
        return reply;
    }

    /** 取会话的开场白（首次对话用） */
    getGreeting(platform, chatId) {
        const profile = this.profiles.get(platform, chatId);
        const card = this.getCard(profile.character);
        if (!card) return null;
        const userName = profile.persona?.name || 'User';
        return (card.firstMes || '')
            .replace(/\{\{char\}\}/gi, card.name)
            .replace(/\{\{user\}\}/gi, userName) || null;
    }
}

export default NativeRuntime;
