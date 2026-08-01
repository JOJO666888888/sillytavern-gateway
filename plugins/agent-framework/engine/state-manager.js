import fs from 'fs';
import path from 'path';

/**
 * 会话状态管理器
 * 提供键值对式状态读写，替代 MVU 的 JSON Patch
 * 状态按 platform:chatId 隔离，持久化到 JSON 文件
 *
 * SubTask 6.8 独立角色模式：支持 namespace 隔离。
 * - 全局状态（namespace=''）：states/<platform>_<chatId>.json（世界状态，所有角色共享）
 * - 角色私有状态（namespace='char:alice'）：states/char/alice/<platform>_<chatId>.json
 * 这样每个角色子代理可以有自己的私有状态，同时共享世界状态。
 */
export class StateManager {
    constructor(dataDir) {
        this.stateDir = path.join(dataDir, 'states');
        fs.mkdirSync(this.stateDir, { recursive: true });
        this.cache = new Map(); // key: "[namespace:]platform:chatId" -> state object
    }

    /**
     * 将 namespace 转换为安全的子目录路径段。
     * 'char:alice' -> 'char/alice'，'' -> ''（全局）
     * @param {string} namespace
     * @returns {string}
     * @private
     */
    _namespaceToPath(namespace) {
        if (!namespace) return '';
        return String(namespace)
            .replace(/:/g, path.sep)
            .replace(/[^a-zA-Z0-9_\-\\/]/g, '_');
    }

    _getKey(platform, chatId, namespace = '') {
        return namespace ? `${namespace}:${platform}:${chatId}` : `${platform}:${chatId}`;
    }

    _getFilePath(platform, chatId, namespace = '') {
        const safeName = `${platform}_${chatId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        const sub = this._namespaceToPath(namespace);
        if (!sub) {
            return path.join(this.stateDir, `${safeName}.json`);
        }
        const nsDir = path.join(this.stateDir, sub);
        if (!fs.existsSync(nsDir)) {
            fs.mkdirSync(nsDir, { recursive: true });
        }
        return path.join(nsDir, `${safeName}.json`);
    }

    _load(platform, chatId, namespace = '') {
        const key = this._getKey(platform, chatId, namespace);
        if (this.cache.has(key)) return this.cache.get(key);

        const filePath = this._getFilePath(platform, chatId, namespace);
        let state = {};
        if (fs.existsSync(filePath)) {
            try {
                state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            } catch (e) { /* 忽略 */ }
        }
        this.cache.set(key, state);
        return state;
    }

    _save(platform, chatId, namespace = '') {
        const key = this._getKey(platform, chatId, namespace);
        const state = this.cache.get(key) || {};
        const filePath = this._getFilePath(platform, chatId, namespace);
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
    }

    /**
     * 读取状态
     * @param {string} platform
     * @param {string} chatId
     * @param {string} [key] - 状态键；未传则返回整个状态对象
     * @param {string} [namespace] - 命名空间（独立角色模式用）
     */
    read(platform, chatId, key, namespace = '') {
        const state = this._load(platform, chatId, namespace);
        if (key) return state[key];
        return state;
    }

    /**
     * 写入状态
     * @param {string} platform
     * @param {string} chatId
     * @param {string} key - 状态键
     * @param {*} value - 状态值
     * @param {string} [namespace] - 命名空间
     */
    write(platform, chatId, key, value, namespace = '') {
        const state = this._load(platform, chatId, namespace);
        state[key] = value;
        this._save(platform, chatId, namespace);
        return true;
    }

    /**
     * 列出所有状态键
     * @param {string} platform
     * @param {string} chatId
     * @param {string} [namespace] - 命名空间
     */
    list(platform, chatId, namespace = '') {
        const state = this._load(platform, chatId, namespace);
        return Object.keys(state);
    }

    /**
     * 删除状态键
     * @param {string} platform
     * @param {string} chatId
     * @param {string} key
     * @param {string} [namespace] - 命名空间
     */
    delete(platform, chatId, key, namespace = '') {
        const state = this._load(platform, chatId, namespace);
        delete state[key];
        this._save(platform, chatId, namespace);
        return true;
    }

    /**
     * 清空状态
     * @param {string} platform
     * @param {string} chatId
     * @param {string} [namespace] - 命名空间
     */
    clear(platform, chatId, namespace = '') {
        this.cache.set(this._getKey(platform, chatId, namespace), {});
        this._save(platform, chatId, namespace);
    }

    /**
     * 列出所有已创建的 namespace 目录（供调试/管理用）。
     * @returns {string[]}
     */
    listNamespaces() {
        const result = [];
        const walk = (dir, prefix) => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                const hasJson = fs.readdirSync(path.join(dir, entry.name)).some(f => f.endsWith('.json'));
                if (hasJson) result.push(rel);
                walk(path.join(dir, entry.name), rel);
            }
        };
        walk(this.stateDir, '');
        return result;
    }
}
