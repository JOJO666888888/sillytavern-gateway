import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('profile');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

/**
 * 会话 Profile 存储
 *
 * ⭐ 这是解决「无法自由切换存档/角色卡/世界书/预设」的核心：
 * 每个 IM 会话(platform:chatId)拥有**自己独立**的运行上下文，
 * 切换任何一项都只影响该会话，天然隔离、无全局副作用
 * （对比 SillyTavern 前端：全局只有一个"当前激活会话"，任何切换都是全局的）。
 *
 * Profile 结构：
 *   { character, persona, preset, worldbooks[], archive, llm }
 */
export class ProfileStore {
    constructor(options = {}) {
        this.file = options.file || path.join(DATA_DIR, 'profiles.json');
        this.profiles = new Map(); // sessionKey -> profile
        this.defaults = options.defaults || {};
        this.load();
    }

    key(platform, chatId) { return `${platform}:${chatId}`; }

    load() {
        try {
            if (fs.existsSync(this.file)) {
                const obj = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
                for (const [k, v] of Object.entries(obj)) this.profiles.set(k, v);
                logger.info(`已加载 ${this.profiles.size} 个会话 Profile`);
            }
        } catch (e) {
            logger.warn(`加载 Profile 失败: ${e.message}`);
        }
    }

    save() {
        try {
            const obj = {};
            for (const [k, v] of this.profiles) obj[k] = v;
            const tmp = this.file + '.tmp';
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
            fs.renameSync(tmp, this.file);
        } catch (e) {
            logger.error(`保存 Profile 失败: ${e.message}`);
        }
    }

    /** 获取会话 Profile（不存在则用默认值创建） */
    get(platform, chatId) {
        const k = this.key(platform, chatId);
        if (!this.profiles.has(k)) {
            this.profiles.set(k, {
                character: this.defaults.character || '',
                persona: this.defaults.persona || null,
                preset: this.defaults.preset || '',
                worldbooks: this.defaults.worldbooks ? [...this.defaults.worldbooks] : [],
                archive: '',   // 存档文件名（不含扩展名），空=自动按会话生成
                llm: null,     // 该会话覆盖的 LLM 配置，null=用全局
            });
            this.save();
        }
        return this.profiles.get(k);
    }

    /** 局部更新会话 Profile */
    update(platform, chatId, patch) {
        const p = this.get(platform, chatId);
        Object.assign(p, patch);
        this.save();
        return p;
    }

    list() {
        return [...this.profiles.entries()].map(([k, v]) => ({ session: k, ...v }));
    }

    delete(platform, chatId) {
        const ok = this.profiles.delete(this.key(platform, chatId));
        if (ok) this.save();
        return ok;
    }
}

export default ProfileStore;
