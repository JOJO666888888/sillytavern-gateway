import fs from 'fs';
import path from 'path';

/**
 * 会话状态管理器
 * 提供键值对式状态读写，替代 MVU 的 JSON Patch
 * 状态按 platform:chatId 隔离，持久化到 JSON 文件
 */
export class StateManager {
    constructor(dataDir) {
        this.stateDir = path.join(dataDir, 'states');
        fs.mkdirSync(this.stateDir, { recursive: true });
        this.cache = new Map(); // key: "platform:chatId" -> state object
    }

    _getKey(platform, chatId) {
        return `${platform}:${chatId}`;
    }

    _getFilePath(platform, chatId) {
        const safeName = this._getKey(platform, chatId).replace(/[^a-zA-Z0-9_:-]/g, '_');
        return path.join(this.stateDir, `${safeName}.json`);
    }

    _load(platform, chatId) {
        const key = this._getKey(platform, chatId);
        if (this.cache.has(key)) return this.cache.get(key);

        const filePath = this._getFilePath(platform, chatId);
        let state = {};
        if (fs.existsSync(filePath)) {
            try {
                state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            } catch (e) { /* 忽略 */ }
        }
        this.cache.set(key, state);
        return state;
    }

    _save(platform, chatId) {
        const key = this._getKey(platform, chatId);
        const state = this.cache.get(key) || {};
        const filePath = this._getFilePath(platform, chatId);
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
    }

    /**
     * 读取状态
     */
    read(platform, chatId, key) {
        const state = this._load(platform, chatId);
        if (key) return state[key];
        return state;
    }

    /**
     * 写入状态
     */
    write(platform, chatId, key, value) {
        const state = this._load(platform, chatId);
        state[key] = value;
        this._save(platform, chatId);
        return true;
    }

    /**
     * 列出所有状态键
     */
    list(platform, chatId) {
        const state = this._load(platform, chatId);
        return Object.keys(state);
    }

    /**
     * 删除状态键
     */
    delete(platform, chatId, key) {
        const state = this._load(platform, chatId);
        delete state[key];
        this._save(platform, chatId);
        return true;
    }

    /**
     * 清空状态
     */
    clear(platform, chatId) {
        this.cache.set(this._getKey(platform, chatId), {});
        this._save(platform, chatId);
    }
}
