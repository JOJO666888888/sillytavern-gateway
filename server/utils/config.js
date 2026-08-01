import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';
import { applyEnvOverrides, getByPath } from './env-config.js';

const logger = createLogger('config');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'gateway.json');

// 原型污染防护：deepMerge 时禁止合并这些危险键
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 敏感字段匹配：脱敏与"是否泄露"判断共用。
 * 命中的字段在通过 API 返回时会被替换成掩码。
 */
const SENSITIVE_KEY_RE = /token|secret|password|apikey|api_key|accesstoken|access_token/i;

const DEFAULT_CONFIG = {
    server: {
        port: 3210,
        // 默认全网卡监听：服务器/远程部署下，用户从浏览器即可直连网关。
        // 若你只在本机使用、不想暴露到局域网，可改为 '127.0.0.1'。
        // 绑定非回环地址时，请保持 requireAuth=true，否则 Bot Token 与会话数据
        // 会被同网络任意设备读取。
        host: '0.0.0.0',
        // 本地鉴权：所有 /api/* 写操作（及默认全部读操作）需在
        // X-Gateway-Token 头携带此值。首次启动自动生成并写回配置文件。
        // 留空 + requireAuth=true 时会在启动时自动生成。
        authToken: '',
        // 是否强制鉴权。默认开启，堵住"恶意网页 drive-by 调用本地端口"与
        // 同机其它进程未授权访问。可在 SillyTavern 网关面板用「启用鉴权」开关关闭，
        // 仅在你完全信任本机/局域网所有设备时才关闭。
        requireAuth: true,
        // 允许跨域访问的前端 Origin 白名单（SillyTavern 页面地址）。
        // 为空时默认放行 localhost / 127.0.0.1 的任意端口。
        allowedOrigins: [],
    },
    // 命令管理员：platform:senderId 形式（如 "qq:10001"）。
    // 命中 adminOnly 的命令仅这些用户可执行；为空表示"不限制"（向后兼容，
    // 但强烈建议在公开 bot 上填写）。
    admins: [],
    adapters: {
        qq: {
            enabled: false,
            mode: 'websocket',           // 'websocket' (正向) | 'reverse' (反向)
            wsUrl: 'ws://127.0.0.1:8080', // 正向WS: NapCat的WS服务端地址
            reversePort: 8081,            // 反向WS: 本插件监听的端口
            accessToken: '',              // OneBot Access Token
            heartbeatInterval: 30000,     // 心跳间隔 (ms)
            reconnectInterval: 5000,      // 初始重连间隔 (ms)
            maxReconnectInterval: 60000,  // 最大重连间隔 (ms)
            messageDedupWindow: 30000,    // 消息去重窗口 (ms)
            requireMention: true,         // 群组中是否需要@机器人才响应
        },
        telegram: {
            enabled: false,
            botToken: '',
            mode: 'polling',              // 'polling' | 'webhook'
            webhookUrl: '',
            allowedUsers: [],             // 白名单用户ID，空=允许所有
            requireMention: true,         // 群组中是否需要@才响应
        },
        discord: {
            enabled: false,
            botToken: '',
            allowedChannels: [],          // 允许的频道ID，空=允许所有
            allowedUsers: [],             // 白名单用户ID
            requireMention: true,         // 频道中是否需要@才响应
        },
        feishu: {
            enabled: false,
            mode: 'websocket',            // 'websocket'(长连接,免公网IP) —— 目前仅支持长连接
            appId: '',                    // 飞书开放平台 App ID
            appSecret: '',                // 飞书开放平台 App Secret
            domain: 'feishu',             // 'feishu'(国内) | 'lark'(海外)
            encryptKey: '',               // 事件加密 key（可选）
            verificationToken: '',        // 事件校验 token（可选）
            allowedChats: [],             // 会话白名单(chat_id)，空=允许所有
            requireMention: true,         // 群聊中是否需要@机器人才响应
            mediaBaseUrl: '',             // 网关对外可访问基址(如 http://公网:3210)，用于媒体转发
        },
        qqofficial: {
            enabled: false,
            appId: '',                    // QQ 开放平台 AppID
            secret: '',                   // QQ 开放平台 AppSecret
            token: '',                    // 机器人 Token（部分接口需要，可选）
            sandbox: false,               // 是否沙箱环境
            enableGroup: true,            // 订阅群 @ 消息
            enableC2C: true,              // 订阅单聊(C2C)消息
            enableGuild: true,            // 订阅频道消息
            allowedChats: [],             // 会话白名单，空=允许所有
        },
        dingtalk: {
            enabled: false,
            clientId: '',                 // 钉钉应用 AppKey (ClientId)
            clientSecret: '',             // 钉钉应用 AppSecret (ClientSecret)
            allowedChats: [],             // 会话白名单，空=允许所有
        },
    },
    session: {
        maxHistoryLength: 50,             // 每个会话最大历史消息数
        persistEnabled: true,             // 是否持久化会话
        persistFile: 'sessions.json',
    },
    messageQueue: {
        maxRetries: 3,                    // 发送失败最大重试次数
        retryDelay: 2000,                 // 重试间隔 (ms)
        maxLength: 100,                   // 队列最大长度
        sendTimeout: 30000,               // 单条发送超时 (ms)，防止挂起锁死队列
    },
    autoReply: {
        enabled: true,                    // 是否启用自动回复
        responseDelay: 500,               // 回复延迟 (ms)，模拟打字
    },
    // 自建推理管线（P2）：网关自己组装 prompt 并调用 LLM，无需挂 SillyTavern 前端。
    // 默认关闭；开启后入站消息由 native runtime 处理，不再依赖 ST 浏览器页面。
    runtime: {
        enabled: false,
        enableMacros: true,
        charactersDir: 'assets/characters',
        worldbooksDir: 'assets/worldbooks',
        presetsDir: 'assets/presets',
        chatsDir: 'data/chats',
        historyLimit: 30,                 // 注入 prompt 的历史条数（粗筛）
        tokenBudget: 8000,                // 上下文 token 预算(0=不按token截断，仅按条数)
        stream: false,                    // 是否使用流式生成
        maxImages: 4,                     // 单条消息最多送入模型的图片数
        worldScanDepth: 5,                // 世界书扫描最近几条消息
        worldMaxRecursion: 2,             // 世界书递归激活轮数
        llm: {
            provider: 'openai',           // 'openai'(含兼容后端) | 'claude' | 'gemini'
            baseUrl: '',                  // 留空用各 provider 默认；本地后端填如 http://127.0.0.1:11434/v1
            apiKey: '',
            model: '',
            timeout: 120000,
            // 回复 token 预算下限（体验优先）。推理模型(RP 必备)会先消耗思维链再产出正文，
            // 若 max_tokens 过小：思维链吃光预算 -> 空回复，或正文半途截断 finish_reason=length。
            // 该下限会被应用到实际请求与历史截断预留额度上(见 preset-engine.buildPrompt)，
            // 当预设自带更大的 max_tokens 时保留预设值(预设优先)。0 表示不设下限。
            // 2026 年主流模型最大输出：DeepSeek V4 384K / Kimi K2.6 262K / GLM-5.2 131K。
            // 源码默认 131072（128K）：覆盖 GLM-5.2 最大输出，DeepSeek V4 / Kimi K2.6 均支持更大。
            // max_tokens 设大是安全的--模型在内容完成后自然停止，不会因上限大就多生成。
            // 对输出上限更小的模型，API 会自动截断，不会报错。
            maxTokens: 131072,
        },
        defaults: {                       // 新会话的默认 Profile
            character: '',
            preset: '',
            worldbooks: [],
        },
    },
};

class ConfigManager {
    constructor() {
        this.config = structuredClone(DEFAULT_CONFIG);
        this.load();
    }

    /**
     * 从文件加载配置
     */
    load() {
        try {
            if (!fs.existsSync(CONFIG_DIR)) {
                fs.mkdirSync(CONFIG_DIR, { recursive: true });
            }

            if (fs.existsSync(CONFIG_FILE)) {
                const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
                const userConfig = JSON.parse(raw);
                this.config = this.deepMerge(structuredClone(DEFAULT_CONFIG), userConfig);
                logger.info('配置文件加载成功');
            } else {
                // 先落盘一份纯默认配置（此时尚未叠加 env，故不会把环境变量
                // 注入的凭据写进挂载卷），随后再应用 env 覆盖。
                this.save();
                logger.info('已创建默认配置文件');
            }

            // 环境变量覆盖（容器部署主要入口）：优先级高于配置文件。
            // 记录被覆盖的路径，save() 时会还原为文件原值，
            // 确保 env 注入的凭据不会泄漏到 config/gateway.json。
            this._applyEnv();
        } catch (error) {
            // 关键：配置文件损坏时不要静默清空后又覆写回磁盘，
            // 否则会永久丢失用户的 token / 白名单。备份损坏文件、保留内存默认值、
            // 并禁止本次运行自动保存，等待人工修复。
            logger.error(`配置加载失败: ${error.message}`);
            try {
                if (fs.existsSync(CONFIG_FILE)) {
                    const backup = `${CONFIG_FILE}.corrupt.${Date.now()}`;
                    fs.renameSync(CONFIG_FILE, backup);
                    logger.error(`已将损坏的配置文件备份为 ${backup}，请人工修复后重启`);
                }
            } catch (_) { /* ignore backup failure */ }
            this.config = structuredClone(DEFAULT_CONFIG);
            this._readonly = true; // 禁止覆写，避免默认空配置盖掉磁盘上可能可恢复的数据
        }

        // 首次运行/旧配置无 token 时自动生成鉴权 token
        this.ensureAuthToken();
    }

    /**
     * 应用环境变量覆盖，并记录哪些路径来自环境变量。
     * 这些路径在 save() 时会被还原为"文件里原本的值"，从而保证：
     *   - 用 env 注入的 bot token / API key 不会被写进 config/gateway.json
     *     （该目录在容器部署中通常是挂载卷，写进去等于凭据落盘）
     *   - 用户改了 env 后立即生效，不会被文件里的陈旧值干扰
     */
    _applyEnv() {
        // 快照"纯文件+默认值"的状态，供 save() 还原 env 覆盖项
        this._preEnvConfig = structuredClone(this.config);
        const { applied } = applyEnvOverrides(this.config);
        this._envPaths = applied;
    }

    /**
     * 确保存在鉴权 token（requireAuth 开启且 token 为空时自动生成一次）
     */
    ensureAuthToken() {
        if (this._readonly) return;
        // 由环境变量提供 token 时不再自动生成，也不写盘
        if (this._envPaths?.includes('server.authToken')) {
            logger.info('鉴权 token 由环境变量 GATEWAY_AUTH_TOKEN 提供');
            return;
        }
        const requireAuth = this.get('server.requireAuth') !== false;
        const token = this.get('server.authToken');
        if (requireAuth && (!token || typeof token !== 'string')) {
            const generated = crypto.randomBytes(24).toString('hex');
            const persisted = this.set('server.authToken', generated);
            // 这里**不打印 token 本身**：日志管道会把长十六进制串脱敏成
            // <redacted-hex>（防止用户贴日志求助时泄露凭据），打了也看不见。
            // token 随 set() 落盘后，指路让用户自己取。
            logger.warn('已自动生成网关鉴权 token 并写入配置文件，需填进 SillyTavern 网关面板才能连接。');
            logger.warn('取用方式：npm run token（容器内 docker compose exec gateway npm run token）');
            logger.warn('或自行指定：设置环境变量 GATEWAY_AUTH_TOKEN，此时 token 不会落盘。');
            if (!persisted) {
                // 没落盘意味着 npm run token 读不到它，而且下次重启会换一个新的
                // ——用户会陷入"每次重启都要重填 token"的怪圈却不知道为什么。
                logger.error(`但配置写盘失败（${this.lastSaveError}）：npm run token 取不到它，` +
                    '且重启后会重新生成。请修复配置目录写权限，或改用 GATEWAY_AUTH_TOKEN 环境变量。');
            }
        }
    }

    /**
     * 生成"用于落盘"的配置副本：把所有由环境变量覆盖的路径还原成
     * 文件/默认值中的原值，使 env 注入的凭据不会被持久化到磁盘。
     *
     * 例：用户用 GATEWAY_TELEGRAM_BOT_TOKEN 注入 token，运行时
     * get('adapters.telegram.botToken') 返回真实 token，但 gateway.json
     * 里始终保持原来的空字符串。
     */
    _configForPersist() {
        if (!this._envPaths?.length || !this._preEnvConfig) return this.config;

        const clone = structuredClone(this.config);
        for (const dotted of this._envPaths) {
            const original = getByPath(this._preEnvConfig, dotted);
            const keys = dotted.split('.');
            let cur = clone;
            let ok = true;
            for (let i = 0; i < keys.length - 1; i++) {
                cur = cur?.[keys[i]];
                if (cur === null || typeof cur !== 'object') { ok = false; break; }
            }
            if (!ok) continue;
            const leaf = keys[keys.length - 1];
            if (original === undefined) delete cur[leaf];
            else cur[leaf] = original;
        }
        return clone;
    }

    /**
     * 保存配置到文件（原子写：tmp + rename，权限 0600 防止同机他人读取凭据）
     *
     * 返回是否真的写成功，失败原因记在 this.lastSaveError。
     * 调用方**必须**看返回值：以前这里吞掉异常直接返回，于是只读挂载/磁盘满时
     * 面板照样弹"配置已更新"，用户重启后才发现改动没了。
     *
     * @returns {boolean}
     */
    save() {
        if (this._readonly) {
            this.lastSaveError = '配置处于只读保护状态（加载时检测到配置文件损坏）';
            logger.warn(`${this.lastSaveError}，本次保存已跳过`);
            return false;
        }
        try {
            if (!fs.existsSync(CONFIG_DIR)) {
                fs.mkdirSync(CONFIG_DIR, { recursive: true });
            }
            const tmpFile = `${CONFIG_FILE}.tmp`;
            fs.writeFileSync(tmpFile, JSON.stringify(this._configForPersist(), null, 2), { encoding: 'utf-8', mode: 0o600 });
            fs.renameSync(tmpFile, CONFIG_FILE);
            try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) { /* Windows 忽略 */ }
            this.lastSaveError = null;
            return true;
        } catch (error) {
            this.lastSaveError = error.message;
            logger.error(`配置保存失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 获取配置值
     * @param {string} keyPath - 点分隔路径，如 'adapters.qq.wsUrl'
     */
    get(keyPath) {
        const keys = keyPath.split('.');
        let value = this.config;
        for (const key of keys) {
            if (value === undefined || value === null) return undefined;
            value = value[key];
        }
        return value;
    }

    /**
     * 设置配置值
     * @param {string} keyPath - 点分隔路径
     * @param {*} value - 值
     */
    set(keyPath, value) {
        const keys = keyPath.split('.');
        let obj = this.config;
        for (let i = 0; i < keys.length - 1; i++) {
            if (!(keys[i] in obj)) {
                obj[keys[i]] = {};
            }
            obj = obj[keys[i]];
        }
        obj[keys[keys.length - 1]] = value;
        return this.save();
    }

    /**
     * 获取完整配置（深拷贝）
     */
    getAll() {
        return structuredClone(this.config);
    }

    /**
     * 获取脱敏后的完整配置（用于通过 API 返回给前端）。
     * 所有敏感字段（token/secret/password 等）替换为掩码，绝不明文出网。
     * @returns {object}
     */
    getRedacted() {
        return this._redact(structuredClone(this.config));
    }

    /**
     * 递归脱敏：命中敏感键名且值为非空字符串时替换为掩码
     */
    _redact(obj) {
        if (Array.isArray(obj)) return obj.map(v => (v && typeof v === 'object' ? this._redact(v) : v));
        if (obj && typeof obj === 'object') {
            for (const key of Object.keys(obj)) {
                const val = obj[key];
                if (val && typeof val === 'object') {
                    this._redact(val);
                } else if (typeof val === 'string' && val.length > 0 && SENSITIVE_KEY_RE.test(key)) {
                    // 保留末 4 位便于用户核对，其余打码
                    obj[key] = val.length > 4 ? `***${val.slice(-4)}` : '***';
                }
            }
        }
        return obj;
    }

    /**
     * 更新配置（部分合并）
     * @param {object} partial - 部分配置对象
     */
    update(partial) {
        this.config = this.deepMerge(this.config, partial);
        return this.save();
    }

    /**
     * 深度合并对象。
     * 安全加固：
     *   1. 跳过 __proto__ / constructor / prototype，防止原型污染
     *      （req.body 经 JSON.parse 可携带这些自有键）。
     *   2. 敏感字段若收到脱敏掩码值（以 *** 开头），保留原值不覆盖——
     *      前端把 getRedacted() 的结果原样回传时不会误清空真实凭据。
     */
    deepMerge(target, source) {
        for (const key of Object.keys(source)) {
            if (FORBIDDEN_KEYS.has(key)) {
                continue;
            }
            const val = source[key];

            // 保护：脱敏掩码回传时不覆盖真实敏感值
            if (
                typeof val === 'string' &&
                val.startsWith('***') &&
                SENSITIVE_KEY_RE.test(key) &&
                typeof target[key] === 'string' &&
                target[key].length > 0
            ) {
                continue;
            }

            if (
                val &&
                typeof val === 'object' &&
                !Array.isArray(val) &&
                target[key] &&
                typeof target[key] === 'object' &&
                !Array.isArray(target[key])
            ) {
                this.deepMerge(target[key], val);
            } else {
                target[key] = val;
            }
        }
        return target;
    }
}

export const configManager = new ConfigManager();
export default configManager;
