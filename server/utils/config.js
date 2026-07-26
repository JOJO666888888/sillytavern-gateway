import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

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
        host: '127.0.0.1',
        // 本地鉴权：所有 /api/* 写操作（及默认全部读操作）需在
        // X-Gateway-Token 头携带此值。首次启动自动生成并写回配置文件。
        // 留空 + requireAuth=true 时会在启动时自动生成。
        authToken: '',
        // 是否强制鉴权。默认开启，堵住"恶意网页 drive-by 调用本地端口"与
        // 同机其它进程未授权访问。仅在你完全信任本机所有进程时才关闭。
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
    },
    autoReply: {
        enabled: true,                    // 是否启用自动回复
        responseDelay: 500,               // 回复延迟 (ms)，模拟打字
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
                this.save();
                logger.info('已创建默认配置文件');
            }
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
     * 确保存在鉴权 token（requireAuth 开启且 token 为空时自动生成一次）
     */
    ensureAuthToken() {
        if (this._readonly) return;
        const requireAuth = this.get('server.requireAuth') !== false;
        const token = this.get('server.authToken');
        if (requireAuth && (!token || typeof token !== 'string')) {
            const generated = crypto.randomBytes(24).toString('hex');
            this.set('server.authToken', generated);
            logger.warn('已自动生成网关鉴权 token（server.authToken）。请在 SillyTavern 网关面板中填入该 token 才能连接。');
            logger.warn(`当前鉴权 token: ${generated}`);
        }
    }

    /**
     * 保存配置到文件（原子写：tmp + rename，权限 0600 防止同机他人读取凭据）
     */
    save() {
        if (this._readonly) {
            logger.warn('配置处于只读保护状态（加载时检测到损坏），本次保存已跳过');
            return;
        }
        try {
            if (!fs.existsSync(CONFIG_DIR)) {
                fs.mkdirSync(CONFIG_DIR, { recursive: true });
            }
            const tmpFile = `${CONFIG_FILE}.tmp`;
            fs.writeFileSync(tmpFile, JSON.stringify(this.config, null, 2), { encoding: 'utf-8', mode: 0o600 });
            fs.renameSync(tmpFile, CONFIG_FILE);
            try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) { /* Windows 忽略 */ }
        } catch (error) {
            logger.error(`配置保存失败: ${error.message}`);
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
        this.save();
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
        this.save();
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
