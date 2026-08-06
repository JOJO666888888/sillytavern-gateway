import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';
import { loadCharacterCard, listCharacterCards } from './card-loader.js';
import { normalizeLorebook, loadLorebook, activateEntries } from './worldbook-engine.js';
import { ChatArchive, listArchives } from './chat-archive.js';
import { loadPreset, defaultPreset, buildPrompt, listPresetEntries } from './preset-engine.js';
import { LLMClient } from './llm-client.js';
import { ProfileStore } from './profile-store.js';
import { userProfileStore } from './user-profile-store.js';

const logger = createLogger('runtime');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

/** 需要 base64 内联图片的 provider（不接受任意外链 URL） */
const NEEDS_BASE64 = new Set(['claude', 'gemini']);

/**
 * 把入站媒体（MediaAsset）转成统一的多模态 parts。
 * 仅处理图片；语音/文件暂以文本占位符体现（STT 为后续项）。
 *
 * @param {string} text - 用户文本
 * @param {Array} media - MediaAsset[]
 * @param {string} provider
 * @param {object} opts - { maxImages, maxBytes }
 * @returns {Promise<string|Array>} 纯文本 或 多模态 parts 数组
 */
export async function buildUserContent(text, media = [], provider = 'openai', opts = {}) {
    const images = (media || []).filter(m => m && m.type === 'image' && (m.url || m.localPath));
    if (images.length === 0) return text;

    const maxImages = opts.maxImages ?? 4;
    const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    const needBase64 = NEEDS_BASE64.has((provider || 'openai').toLowerCase());

    const parts = [];
    if (text) parts.push({ type: 'text', text });

    for (const img of images.slice(0, maxImages)) {
        try {
            if (!needBase64 && img.url && /^https?:/i.test(img.url)) {
                // OpenAI 兼容后端可直接吃 http URL
                parts.push({ type: 'image', url: img.url, mimeType: img.mimeType });
                continue;
            }
            // 需要内联：下载/读盘 → base64
            let buf, mime = img.mimeType || '';
            if (img.localPath && fs.existsSync(img.localPath)) {
                buf = fs.readFileSync(img.localPath);
            } else if (img.url) {
                const resp = await fetch(img.url, { signal: AbortSignal.timeout(20000) });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                mime = mime || resp.headers.get('content-type') || 'image/jpeg';
                buf = Buffer.from(await resp.arrayBuffer());
            }
            if (!buf) continue;
            if (buf.length > maxBytes) {
                logger.warn(`图片过大(${buf.length})，跳过多模态注入`);
                continue;
            }
            parts.push({ type: 'image', base64: buf.toString('base64'), mimeType: (mime || 'image/jpeg').split(';')[0] });
        } catch (e) {
            logger.warn(`多模态图片处理失败: ${e.message}`);
        }
    }

    // 只有文本部分（图片全失败）→ 退回纯文本，避免构造无意义的 parts
    if (parts.filter(p => p.type === 'image').length === 0) return text;
    return parts;
}

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
        // 自动创建资产目录（首次启用时用户不再需要手动建文件夹）
        for (const dir of Object.values(this.dirs)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.profiles = new ProfileStore({ defaults: cfg.defaults || {} });
        this._cardCache = new Map();
        this._bookCache = new Map();
        this._presetCache = new Map();
        // P2-2: 聊天存档实例缓存（filePath -> ChatArchive），
        // 按 ChatArchive._mtimeMs 与磁盘 mtime 比对判断外部改动，避免每轮生成全量读盘+JSON.parse。
        this._archiveCache = new Map();
        // 条目级启停覆盖（资产级，sidecar 文件，非破坏式：不改原资产文件）
        this._overridesFile = path.resolve(ROOT, cfg.overridesFile || 'data/asset-overrides.json');
        this._overrides = this._loadOverrides();
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

    /** 按名字加载世界书（带缓存）；应用资产级条目覆盖（禁用的条目置 enabled=false） */
    getWorldbook(name) {
        if (this._bookCache.has(name)) return this._bookCache.get(name);
        const file = path.join(this.dirs.worldbooks, `${name}.json`);
        if (!fs.existsSync(file)) return null;
        const disabled = this.getDisabledEntries('worldbooks', name);
        const book = loadLorebook(file).map(e => disabled.has(e.id) ? { ...e, enabled: false } : e);
        this._bookCache.set(name, book);
        return book;
    }

    /** 按名字加载预设（带缓存），无则默认；应用资产级条目覆盖 */
    getPreset(name) {
        if (!name) return defaultPreset();
        if (this._presetCache.has(name)) return this._presetCache.get(name);
        const file = path.join(this.dirs.presets, `${name}.json`);
        if (!fs.existsSync(file)) return defaultPreset();
        const p = loadPreset(file, this.getDisabledEntries('presets', name));
        this._presetCache.set(name, p);
        return p;
    }

    /** 清空资产缓存（资产文件变更后调用） */
    clearCache() {
        this._cardCache.clear();
        this._bookCache.clear();
        this._presetCache.clear();
        this._archiveCache.clear(); // P2-2
    }

    // ==================== 资产管理：删除 + 条目级启停覆盖 ====================

    /** 加载条目覆盖（资产级 sidecar，非破坏式） */
    _loadOverrides() {
        try {
            if (fs.existsSync(this._overridesFile)) {
                const data = JSON.parse(fs.readFileSync(this._overridesFile, 'utf-8'));
                return { worldbooks: data.worldbooks || {}, presets: data.presets || {} };
            }
        } catch (e) {
            logger.warn(`条目覆盖文件读取失败，使用空覆盖: ${e.message}`);
        }
        return { worldbooks: {}, presets: {} };
    }

    _saveOverrides() {
        try {
            fs.mkdirSync(path.dirname(this._overridesFile), { recursive: true });
            fs.writeFileSync(this._overridesFile, JSON.stringify(this._overrides, null, 2));
        } catch (e) {
            logger.error(`条目覆盖文件写入失败: ${e.message}`);
        }
    }

    /** 取某资产的禁用条目 id 集合 */
    getDisabledEntries(type, name) {
        return new Set((this._overrides[type] || {})[name] || []);
    }

    /**
     * 设置某资产的禁用条目 id（整体替换），落盘并清缓存。
     * @param {string} type - worldbooks | presets
     * @param {string} name
     * @param {string[]} disabledIds
     */
    setDisabledEntries(type, name, disabledIds) {
        if (!this._overrides[type]) this._overrides[type] = {};
        this._overrides[type][name] = Array.from(new Set(disabledIds || []));
        this._saveOverrides();
        this.clearCache();
    }

    /**
     * 删除一个资产文件（按去扩展名的基础名），并清理其条目覆盖。
     * name 必须在 listAssets 中存在（防路径遍历）。
     */
    deleteAsset(type, name) {
        const dir = this.dirs[type];
        if (!dir) throw new Error(`未知资产类型: ${type}`);
        // listAssets 的键名：存档在返回里叫 archives（dirs 里叫 chats）
        const assetKey = type === 'chats' ? 'archives' : type;
        if (!this.listAssets()[assetKey].includes(name)) throw new Error(`未找到资产: ${type}/${name}`);
        const validExts = type === 'characters' ? ['.png', '.json'] : type === 'chats' ? ['.jsonl'] : ['.json'];
        for (const ext of validExts) {
            const file = path.join(dir, name + ext);
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }
        if (this._overrides[type]) {
            delete this._overrides[type][name];
            this._saveOverrides();
        }
        this.clearCache();
    }

    /**
     * 列出某资产的可切换条目（含当前启用状态 = 文件默认 && 未被覆盖禁用）。
     * 仅 worldbooks / presets 有条目概念；返回 [] 表示无可切换条目。
     * @returns {Array<{id: string, label: string, enabled: boolean, isMarker?: boolean}>}
     */
    listEntries(type, name) {
        if (type !== 'worldbooks' && type !== 'presets') return [];
        const dir = this.dirs[type];
        if (!dir || !this.listAssets()[type].includes(name)) {
            throw new Error(`未找到资产: ${type}/${name}`);
        }
        const disabled = this.getDisabledEntries(type, name);
        const file = path.join(dir, `${name}.json`);
        if (type === 'worldbooks') {
            const entries = normalizeLorebook(JSON.parse(fs.readFileSync(file, 'utf-8')));
            return entries.map(e => ({
                id: e.id,
                label: e.comment || (e.keys.length ? e.keys.join(' / ') : e.content.slice(0, 40)),
                enabled: e.enabled && !disabled.has(e.id),
            }));
        }
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return listPresetEntries(raw).map(e => ({
            id: e.id,
            label: e.label,
            enabled: e.enabled && !disabled.has(e.id),
            isMarker: e.isMarker,
        }));
    }

    /**
     * 导入资产文件（写入磁盘 + 清缓存）
     * @param {string} type - characters | worldbooks | presets | chats
     * @param {string} filename - 原始文件名
     * @param {Buffer} buffer - 文件内容
     * @returns {{name: string, path: string}}
     */
    importAsset(type, filename, buffer) {
        const dir = this.dirs[type];
        if (!dir) throw new Error(`未知资产类型: ${type}`);
        // multer/busboy 默认按 latin1 解析 multipart 文件名参数，浏览器发的 UTF-8 中文
        // 会变成 mojibake（出现 U+0080–U+00FF 高位字符）。带守卫转换：仅当检测到这类
        // 高位字符时才按 latin1->UTF-8 还原，避免对已正确解码的名字二次破坏。
        if (filename && /[\u0080-\u00FF]/.test(filename)) {
            filename = Buffer.from(filename, 'latin1').toString('utf-8');
        }
        // 安全文件名：去掉路径分隔符
        const safeName = filename.replace(/[\\/]/g, '_');
        // 存档必须是 .jsonl（listArchives 只认该扩展名，落错扩展名会"导入成功但列表里看不到"）
        if (type === 'chats' && path.extname(safeName).toLowerCase() !== '.jsonl') {
            throw new Error('存档文件必须是 .jsonl 格式（SillyTavern 聊天记录）');
        }
        const filePath = path.join(dir, safeName);
        fs.writeFileSync(filePath, buffer);
        this.clearCache();
        return { name: path.basename(safeName, path.extname(safeName)), path: filePath };
    }

    /**
     * 从 SillyTavern 目录批量同步资产
     * @param {string} stRoot - SillyTavern 安装根目录
     * @returns {{characters: number, worldbooks: number, presets: number, chats: number, missing: string[]}}
     */
    syncFromSillyTavern(stRoot) {
        const result = { characters: 0, worldbooks: 0, presets: 0, chats: 0, missing: [] };
        // 确保目标目录存在（构造时创建过，但可能被外部删除）
        for (const dir of Object.values(this.dirs)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        // ST 默认用户数据目录
        const userData = path.join(stRoot, 'data', 'default-user');
        // 角色卡: data/default-user/characters/*.png + *.json
        const charDir = path.join(userData, 'characters');
        if (fs.existsSync(charDir)) {
            for (const f of fs.readdirSync(charDir)) {
                const ext = path.extname(f).toLowerCase();
                if (ext === '.png' || ext === '.json') {
                    fs.copyFileSync(path.join(charDir, f), path.join(this.dirs.characters, f));
                    result.characters++;
                }
            }
        } else {
            result.missing.push('characters');
        }
        // 世界书: data/default-user/worlds/*.json
        const worldDir = path.join(userData, 'worlds');
        if (fs.existsSync(worldDir)) {
            for (const f of fs.readdirSync(worldDir)) {
                if (path.extname(f).toLowerCase() === '.json') {
                    fs.copyFileSync(path.join(worldDir, f), path.join(this.dirs.worldbooks, f));
                    result.worldbooks++;
                }
            }
        } else {
            result.missing.push('worlds');
        }
        // 预设: data/default-user/OpenAI Settings/*.json
        const presetDir = path.join(userData, 'OpenAI Settings');
        if (fs.existsSync(presetDir)) {
            for (const f of fs.readdirSync(presetDir)) {
                if (path.extname(f).toLowerCase() === '.json') {
                    fs.copyFileSync(path.join(presetDir, f), path.join(this.dirs.presets, f));
                    result.presets++;
                }
            }
        } else {
            result.missing.push('OpenAI Settings');
        }
        // 存档: data/default-user/chats/<角色>/*.jsonl（ST 按角色分子目录）
        // 保留原名（含角色与时间戳），listArchives 去 .jsonl 后缀即为可 /load 的存档名
        const chatRoot = path.join(userData, 'chats');
        if (fs.existsSync(chatRoot)) {
            for (const sub of fs.readdirSync(chatRoot)) {
                const subDir = path.join(chatRoot, sub);
                if (!fs.statSync(subDir).isDirectory()) continue;
                for (const f of fs.readdirSync(subDir)) {
                    if (path.extname(f).toLowerCase() !== '.jsonl') continue;
                    fs.copyFileSync(path.join(subDir, f), path.join(this.dirs.chats, f));
                    result.chats++;
                }
            }
        } else {
            result.missing.push('chats');
        }
        this.clearCache();
        return result;
    }

    /** 取会话的存档对象（P2-2：进程内缓存复用，外部改档按 mtime 重载） */
    getArchive(platform, chatId, profile, card) {
        const nameBase = profile.archive || `${platform}_${chatId}`;
        const file = path.join(this.dirs.chats, `${nameBase}.jsonl`);

        // 复用已加载实例：仅当磁盘 mtime 与本实例最后一次加载/写入时一致（无外部改动）
        const cached = this._archiveCache.get(file);
        if (cached) {
            try {
                const diskMtime = fs.statSync(file).mtimeMs;
                if (cached._mtimeMs === diskMtime) return cached;
            } catch (_) {
                // 文件被删除：按新文件处理
            }
        }

        const archive = new ChatArchive(file, {
            // 存档首行 user_name：会话 profile persona 优先，其次用户自定义配置名，兜底 'User'
            userName: profile.persona?.name || userProfileStore.get().name || 'User',
            characterName: card?.name || 'Assistant',
        });
        this._archiveCache.set(file, archive);
        return archive;
    }

    /**
     * 组装某会话对某条输入的 prompt（不调用 LLM）——便于测试与 /preview
     * @param {string} platform
     * @param {string} chatId
     * @param {string} userInput
     * @param {object} [opts] - { media: MediaAsset[] } 入站媒体，用于多模态
     * @returns {Promise<{messages, sampling, card, archive}>}
     */
    async prepare(platform, chatId, userInput, opts = {}) {
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

        // 多模态：把入站图片并入用户消息（provider 决定用 URL 还是 base64 内联）
        const llmCfg = { ...(this.config.llm || {}), ...(profile.llm || {}) };
        const userContent = await buildUserContent(
            userInput,
            opts.media || [],
            llmCfg.provider,
            { maxImages: this.config.maxImages ?? 4 },
        );

        // 用户自定义档案：用户提供人设 → 自定义用户名 + 完整人设生效（会话 profile persona 兜底）；
        // 未提供人设 → 仅自定义用户名（宏 {{user}} 用配置名），persona 维持会话 profile 的
        const up = userProfileStore.get();
        const userName = up.name || profile.persona?.name || 'User';
        const persona = up.persona ? { name: up.name, description: up.persona } : profile.persona;

        const { messages, sampling } = buildPrompt({
            card,
            preset,
            persona,
            world,
            history,
            userInput: userContent,
            userName,
            tokenBudget: this.config.tokenBudget ?? 0,
            enableMacros: this.config.enableMacros !== false,
            // 体验优先：回复预算下限，防止推理模型思维链吃光 max_tokens 或正文截断
            minMaxTokens: this.config.llm?.maxTokens ?? 0,
        });

        return { messages, sampling, card, archive, profile, world };
    }

    /**
     * 完整推理：组装 prompt → 调用 LLM → 写入存档 → 返回回复
     * @returns {Promise<string>} AI 回复
     */
    async generate(platform, chatId, userInput, options = {}) {
        const { messages, sampling, card, archive, profile } = await this.prepare(
            platform, chatId, userInput, { media: options.media },
        );

        // LLM 配置：会话覆盖 > 全局
        const llmCfg = { ...(this.config.llm || {}), ...(profile.llm || {}) };
        const client = options.client || new LLMClient(llmCfg);

        // 先落用户消息（即便生成失败，用户输入也不丢）；媒体在存档里记为占位符
        const archivedInput = (options.media?.length)
            ? `${userInput}${userInput ? ' ' : ''}${options.media.map(m => m.placeholder?.() || '[媒体]').join(' ')}`
            : userInput;
        archive.append({ isUser: true, mes: archivedInput, name: profile.persona?.name || 'User', sendDate: options.now || 0 });

        // 流式（config.runtime.stream 或调用方指定）：边收边回调，便于渐进发送
        const useStream = options.stream ?? this.config.stream ?? false;
        const reply = (useStream && typeof client.generateStream === 'function')
            ? await client.generateStream(messages, sampling, options.onDelta)
            : await client.generate(messages, sampling);

        archive.append({ isUser: false, mes: reply, name: card.name, sendDate: options.now || 0 });
        return reply;
    }

    /** 取会话的开场白（首次对话用） */
    getGreeting(platform, chatId) {
        const profile = this.profiles.get(platform, chatId);
        const card = this.getCard(profile.character);
        if (!card) return null;
        const userName = profile.persona?.name || 'User';
        const enableMacros = this.config.enableMacros !== false;
        const text = card.firstMes || '';
        if (!text) return null;
        if (enableMacros) {
            const engine = new MacroEngine({ charName: card.name, userName });
            return engine.process(text) || null;
        }
        return text
            .replace(/\{\{char\}\}/gi, card.name)
            .replace(/\{\{user\}\}/gi, userName) || null;
    }
}

export default NativeRuntime;
