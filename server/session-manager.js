import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './utils/logger.js';
import configManager from './utils/config.js';

const logger = createLogger('session-manager');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

/**
 * 会话管理器
 * 维护 platform+chatId → 会话数据 的映射
 * 支持多用户隔离、对话历史缓存、可选持久化
 */
export class SessionManager {
    constructor() {
        this.sessions = new Map();  // sessionKey -> SessionData
        this.maxHistoryLength = configManager.get('session.maxHistoryLength') || 50;
        this.persistEnabled = configManager.get('session.persistEnabled') !== false;
        this.persistFile = path.join(DATA_DIR, configManager.get('session.persistFile') || 'sessions.json');
        this.saveTimer = null;
        this.dirty = false;

        // 加载持久化数据
        if (this.persistEnabled) {
            this.load();
            // 定期保存
            this.saveTimer = setInterval(() => this.saveIfDirty(), 30000);
        }
    }

    /**
     * 生成会话键
     * @param {string} platform
     * @param {string} chatId
     * @returns {string}
     */
    getSessionKey(platform, chatId) {
        return `${platform}:${chatId}`;
    }

    /**
     * 获取或创建会话
     * @param {string} platform
     * @param {string} chatId
     * @param {string} chatType
     * @returns {SessionData}
     */
    getOrCreate(platform, chatId, chatType = 'private') {
        const key = this.getSessionKey(platform, chatId);

        if (!this.sessions.has(key)) {
            const session = new SessionData(key, platform, chatId, chatType);
            this.sessions.set(key, session);
            this.dirty = true;
            logger.info(`创建新会话: ${key}`);
        }

        return this.sessions.get(key);
    }

    /**
     * 获取会话（不创建）
     * @param {string} platform
     * @param {string} chatId
     * @returns {SessionData|null}
     */
    get(platform, chatId) {
        const key = this.getSessionKey(platform, chatId);
        return this.sessions.get(key) || null;
    }

    /**
     * 添加消息到会话历史
     * @param {string} platform
     * @param {string} chatId
     * @param {object} message - { role: 'user'|'assistant', content: string, name?: string }
     */
    addMessage(platform, chatId, message) {
        const session = this.getOrCreate(platform, chatId);
        session.addMessage(message);
        this.dirty = true;
    }

    /**
     * 获取会话历史
     * @param {string} platform
     * @param {string} chatId
     * @param {number} limit - 返回最近N条
     * @returns {Array}
     */
    getHistory(platform, chatId, limit = 0) {
        const session = this.get(platform, chatId);
        if (!session) return [];
        return limit > 0 ? session.history.slice(-limit) : [...session.history];
    }

    /**
     * 清空会话历史
     * @param {string} platform
     * @param {string} chatId
     */
    clearHistory(platform, chatId) {
        const session = this.get(platform, chatId);
        if (session) {
            session.history = [];
            session.lastActiveAt = Date.now();
            this.dirty = true;
            logger.info(`会话历史已清空: ${this.getSessionKey(platform, chatId)}`);
        }
    }

    /**
     * 删除会话
     * @param {string} platform
     * @param {string} chatId
     */
    deleteSession(platform, chatId) {
        const key = this.getSessionKey(platform, chatId);
        if (this.sessions.delete(key)) {
            this.dirty = true;
            logger.info(`会话已删除: ${key}`);
        }
    }

    /**
     * 获取所有会话列表
     * @returns {Array}
     */
    listSessions() {
        const list = [];
        for (const [key, session] of this.sessions) {
            list.push({
                key,
                platform: session.platform,
                chatId: session.chatId,
                chatType: session.chatType,
                messageCount: session.history.length,
                lastActiveAt: session.lastActiveAt,
                metadata: session.metadata,
            });
        }
        return list.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    }

    /**
     * 设置会话元数据（如绑定的 ST 角色）
     * @param {string} platform
     * @param {string} chatId
     * @param {object} metadata
     */
    setMetadata(platform, chatId, metadata) {
        const session = this.getOrCreate(platform, chatId);
        session.metadata = { ...session.metadata, ...metadata };
        this.dirty = true;
    }

    /**
     * 获取会话元数据
     */
    getMetadata(platform, chatId) {
        const session = this.get(platform, chatId);
        return session?.metadata || {};
    }

    /**
     * 从文件加载会话数据
     */
    load() {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }

            if (fs.existsSync(this.persistFile)) {
                const raw = fs.readFileSync(this.persistFile, 'utf-8');
                const data = JSON.parse(raw);

                for (const item of data.sessions || []) {
                    const session = new SessionData(
                        item.key,
                        item.platform,
                        item.chatId,
                        item.chatType
                    );
                    session.history = item.history || [];
                    session.metadata = item.metadata || {};
                    session.createdAt = item.createdAt;
                    session.lastActiveAt = item.lastActiveAt;
                    this.sessions.set(item.key, session);
                }

                logger.info(`已加载 ${this.sessions.size} 个会话`);
            }
        } catch (error) {
            logger.error(`会话加载失败: ${error.message}`);
        }
    }

    /**
     * 保存会话数据到文件
     */
    save() {
        if (!this.persistEnabled) return;

        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }

            const data = {
                version: 1,
                savedAt: Date.now(),
                sessions: Array.from(this.sessions.values()).map(s => s.toJSON()),
            };

            fs.writeFileSync(this.persistFile, JSON.stringify(data, null, 2), 'utf-8');
            this.dirty = false;
            logger.debug('会话数据已保存');
        } catch (error) {
            logger.error(`会话保存失败: ${error.message}`);
        }
    }

    /**
     * 仅在有变更时保存
     */
    saveIfDirty() {
        if (this.dirty) {
            this.save();
        }
    }

    /**
     * 停止会话管理器
     */
    stop() {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }
        this.save();
    }
}

/**
 * 会话数据类
 */
class SessionData {
    constructor(key, platform, chatId, chatType) {
        this.key = key;
        this.platform = platform;
        this.chatId = chatId;
        this.chatType = chatType;
        this.history = [];
        this.metadata = {};
        this.createdAt = Date.now();
        this.lastActiveAt = Date.now();
    }

    /**
     * 添加消息
     * @param {object} message - { role, content, name?, timestamp? }
     */
    addMessage(message) {
        const msg = {
            role: message.role,
            content: message.content,
            name: message.name,
            timestamp: message.timestamp || Date.now(),
        };

        this.history.push(msg);
        this.lastActiveAt = Date.now();

        // 限制历史长度
        const maxLength = configManager.get('session.maxHistoryLength') || 50;
        if (this.history.length > maxLength) {
            this.history = this.history.slice(-maxLength);
        }
    }

    /**
     * 转换为 JSON
     */
    toJSON() {
        return {
            key: this.key,
            platform: this.platform,
            chatId: this.chatId,
            chatType: this.chatType,
            history: this.history,
            metadata: this.metadata,
            createdAt: this.createdAt,
            lastActiveAt: this.lastActiveAt,
        };
    }
}

export const sessionManager = new SessionManager();
export default sessionManager;

