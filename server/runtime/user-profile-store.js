import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('user-profile');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 默认档案：自定义用户名 + 空人设 */
const DEFAULT_PROFILE = { name: 'user', persona: '' };
/** 用户名长度上限 */
const MAX_NAME_LEN = 32;
/** 人设长度上限 */
const MAX_PERSONA_LEN = 2000;

/**
 * 用户自定义角色档案存储（工厂）
 *
 * 数据形态：{ name: string, persona: string }
 *   - name：自定义用户名（默认 'user'）
 *   - persona：人设描述（默认 ''，空 = 未提供人设）
 *
 * 进程内缓存：get() 不重复读盘；save() 成功后立即更新缓存。
 * 文件损坏：回退默认值并备份为 user-profile.json.corrupt.<ts>，不崩溃。
 *
 * @param {object} [options]
 *   @param {string} [options.filePath] - 存储文件路径（测试用覆盖）
 * @returns {{ get: () => {name: string, persona: string}, save: (partial: object) => {name: string, persona: string} }}
 */
export function createUserProfileStore(options = {}) {
    const filePath = options.filePath || path.resolve(__dirname, '..', '..', 'data', 'user-profile.json');
    /** 内存缓存：null = 尚未加载 */
    let cache = null;

    /** 清洗用户名：去首尾空白、长度 ≤32、空则回退 'user' */
    function normalizeName(name) {
        const s = (typeof name === 'string' ? name : '').trim();
        if (!s) return DEFAULT_PROFILE.name;
        return s.slice(0, MAX_NAME_LEN);
    }

    /** 清洗人设：非字符串则 ''、长度 ≤2000 */
    function normalizePersona(persona) {
        if (typeof persona !== 'string') return '';
        return persona.slice(0, MAX_PERSONA_LEN);
    }

    /**
     * 从磁盘加载并归一化；文件不存在/损坏时回退默认值。
     * 损坏时把原文件备份为 <file>.corrupt.<ts> 并记日志（不崩溃）。
     * @returns {{name: string, persona: string}}
     */
    function load() {
        if (!fs.existsSync(filePath)) return { ...DEFAULT_PROFILE };
        try {
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const profile = { ...DEFAULT_PROFILE };
            if (raw && typeof raw === 'object') {
                profile.name = normalizeName(raw.name);
                profile.persona = normalizePersona(raw.persona);
            }
            return profile;
        } catch (e) {
            try {
                const backup = `${filePath}.corrupt.${Date.now()}`;
                fs.copyFileSync(filePath, backup);
                logger.warn(`用户档案文件损坏，已备份为 ${path.basename(backup)}: ${e.message}`);
            } catch (copyErr) {
                logger.warn(`用户档案文件损坏且备份失败: ${copyErr.message}`);
            }
            return { ...DEFAULT_PROFILE };
        }
    }

    /**
     * 读取当前配置（深拷贝，避免外部篡改内部态；进程内缓存，不重复读盘）。
     * @returns {{name: string, persona: string}}
     */
    function get() {
        if (cache === null) cache = load();
        return { ...cache };
    }

    /**
     * 合并更新配置 { name?, persona? } 并原子写盘（tmp + rename，模式 0600）。
     * 写盘成功后更新内存缓存。
     * @param {object} [partial] - { name?, persona? }
     * @returns {{name: string, persona: string}} 生效后的配置
     */
    function save(partial = {}) {
        const current = cache === null ? load() : cache;
        const next = { ...current };
        if (partial.name !== undefined) next.name = normalizeName(partial.name);
        if (partial.persona !== undefined) next.persona = normalizePersona(partial.persona);
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            const tmp = `${filePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
            fs.renameSync(tmp, filePath);
            cache = next;
        } catch (e) {
            logger.error(`保存用户档案失败: ${e.message}`);
        }
        return { ...(cache || next) };
    }

    return { get, save };
}

/** 默认单例（模块加载即创建，存储 data/user-profile.json） */
export const userProfileStore = createUserProfileStore();

export default { createUserProfileStore, userProfileStore };
