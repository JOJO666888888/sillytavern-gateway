import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

const logger = createLogger('config');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'gateway.json');

const DEFAULT_CONFIG = {
    server: {
        port: 3210,
        host: '127.0.0.1',
    },
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
            logger.error(`配置加载失败，使用默认配置: ${error.message}`);
            this.config = structuredClone(DEFAULT_CONFIG);
        }
    }

    /**
     * 保存配置到文件
     */
    save() {
        try {
            if (!fs.existsSync(CONFIG_DIR)) {
                fs.mkdirSync(CONFIG_DIR, { recursive: true });
            }
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8');
            logger.info('配置已保存');
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
     * 更新配置（部分合并）
     * @param {object} partial - 部分配置对象
     */
    update(partial) {
        this.config = this.deepMerge(this.config, partial);
        this.save();
    }

    /**
     * 深度合并对象
     */
    deepMerge(target, source) {
        for (const key of Object.keys(source)) {
            if (
                source[key] &&
                typeof source[key] === 'object' &&
                !Array.isArray(source[key]) &&
                target[key] &&
                typeof target[key] === 'object'
            ) {
                this.deepMerge(target[key], source[key]);
            } else {
                target[key] = source[key];
            }
        }
        return target;
    }
}

export const configManager = new ConfigManager();
export default configManager;
