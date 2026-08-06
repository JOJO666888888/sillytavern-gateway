/**
 * STDataManagerPlugin - SillyTavern 数据管理插件
 *
 * 功能：
 *   1. 角色卡管理：上传/删除/列表（支持 V3 内嵌世界书）
 *   2. 世界书管理：上传/删除/列表
 *   3. 场景注入：/scene_load 动态加载预设世界书词条
 *   4. 预设管理：上传预设 JSON
 *   5. 会话-角色绑定：/bind 将群聊绑定到 ST 角色卡，实现多群聊隔离
 *
 * 架构：
 *   插件通过 HTTP API 与 ST 后端交互（STApiClient）
 *   绑定表存储在插件 config，ST 扩展轮询拉取后自动切换角色
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';
import fs from 'fs';
import path from 'path';

// ==================== 内置场景数据 ====================

/** P0-3 安全修复：预设名校验（拒绝路径分隔符/../等，防止文件系统回退路径穿越） */
export function isValidPresetName(name) {
    return typeof name === 'string'
        && name.length > 0
        && name.length <= 64
        && /^[a-zA-Z0-9_\-\u4e00-\u9fa5]+$/.test(name);
}

const BUILTIN_SCENES = {
    '赛博朋克': {
        description: '霓虹灯、义体、黑客、巨型企业统治的未来都市',
        entries: [
            { uid: 0, key: ['城市', '街道', '霓虹'], content: '城市被霓虹灯和全息广告笼罩，雨水映着彩色光芒。高耸的摩天楼属于巨型企业。', priority: 10, position: 'before_char', disable: false },
            { uid: 1, key: ['义体', '改造', '机械'], content: '义体改造是日常，每个人都有不同程度的机械增强。义体技师是热门职业。', priority: 10, position: 'before_char', disable: false },
            { uid: 2, key: ['黑客', '网络', '赛博'], content: '网络空间是另一个战场，黑客被称为"网络潜行者"，使用脑机接口潜入。', priority: 10, position: 'before_char', disable: false },
            { uid: 3, key: ['企业', '公司', '巨型企业'], content: '巨型企业控制着城市的一切，法律在企业领地内形同虚设。', priority: 10, position: 'before_char', disable: false },
        ],
    },
    '中世纪奇幻': {
        description: '魔法、骑士、龙、精灵与地下城',
        entries: [
            { uid: 0, key: ['酒馆', '旅店', '客栈'], content: '酒馆是冒险者聚集之地，弥漫着麦酒和烤肉的香气，吟游诗人在角落弹奏鲁特琴。', priority: 10, position: 'before_char', disable: false },
            { uid: 1, key: ['魔法', '法术', '咒语'], content: '魔法是真实存在的力量，法师需多年研习才能掌握。魔法公会管控着法术的使用。', priority: 10, position: 'before_char', disable: false },
            { uid: 2, key: ['龙', '巨龙', '飞龙'], content: '龙是古老而强大的生物，极少现身于人类领地。龙鳞和龙血是珍贵的炼金材料。', priority: 10, position: 'before_char', disable: false },
            { uid: 3, key: ['骑士', '王国', '城堡'], content: '骑士效忠于领主，遵循骑士准则。王国之间时有纷争，边境城堡驻扎重兵。', priority: 10, position: 'before_char', disable: false },
        ],
    },
    '现代都市': {
        description: '当代城市生活，咖啡馆、地铁、写字楼',
        entries: [
            { uid: 0, key: ['咖啡', '咖啡馆', '咖啡店'], content: '街角咖啡馆是都市人放松的避风港，弥漫着烘焙咖啡豆的香气。', priority: 10, position: 'before_char', disable: false },
            { uid: 1, key: ['地铁', '通勤', '上班'], content: '地铁是城市动脉，早晚高峰拥挤不堪。通勤是都市生活不可分割的一部分。', priority: 10, position: 'before_char', disable: false },
            { uid: 2, key: ['手机', '微信', '社交'], content: '智能手机是生活的延伸，社交软件连接着所有人，信息流永不停歇。', priority: 10, position: 'before_char', disable: false },
        ],
    },
    '末日废土': {
        description: '核战后的荒芜世界，废墟、辐射、幸存者',
        entries: [
            { uid: 0, key: ['废墟', '废土', '荒野'], content: '废土延伸到地平线，残破的建筑如同巨人的尸骨。风带着辐射尘呼啸而过。', priority: 10, position: 'before_char', disable: false },
            { uid: 1, key: ['辐射', '变异', '污染'], content: '辐射区遍布大地，变异生物在暗处潜伏。盖革计数器是幸存者的生命线。', priority: 10, position: 'before_char', disable: false },
            { uid: 2, key: ['避难所', '地下', '掩体'], content: '避难所是幸存者的庇护所，物资匮乏，人与人之间的信任比金子还珍贵。', priority: 10, position: 'before_char', disable: false },
        ],
    },
};

// ==================== ST API Client ====================

/**
 * SillyTavern HTTP API 客户端
 * 使用 Node.js 18+ 内置 fetch，无需外部依赖
 */
class STApiClient {
    /**
     * @param {string} baseUrl - ST 后端地址
     * @param {string} auth - Basic Auth 凭证 (base64(user:pass))，空则无认证
     */
    constructor(baseUrl, auth) {
        this.baseUrl = (baseUrl || 'http://localhost:8000').replace(/\/$/, '');
        this.auth = auth || '';
    }

    /**
     * 构建请求头
     */
    _headers(extra = {}) {
        const h = { ...extra };
        if (this.auth) {
            h['Authorization'] = `Basic ${this.auth}`;
        }
        return h;
    }

    /**
     * 发送 HTTP 请求到 ST 后端
     *
     * 注意：显式发送 `Connection: close` 并带超时 abort，防止 undici
     * keep-alive 空闲连接残留在进程句柄中（曾导致 --test-force-exit
     * 强杀时撞上 UV_HANDLE_CLOSING 断言崩溃）。
     */
    async _request(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        // 5s 超时：ST 不可达时避免 fetch 无限挂起
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        timer.unref?.();
        try {
            const resp = await fetch(url, {
                ...options,
                // 关闭 keep-alive：响应完成后连接立即回收，不进入连接池
                headers: this._headers({ Connection: 'close', ...options.headers }),
                signal: controller.signal,
            });
            if (!resp.ok) {
                const body = await resp.text().catch(() => '');
                throw new Error(`ST API ${resp.status}: ${body.substring(0, 200)}`);
            }
            const ct = resp.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                return await resp.json();
            }
            return await resp.text();
        } catch (error) {
            // 连接被拒绝 -> ST 未启动
            if (error.cause?.code === 'ECONNREFUSED' || error.message.includes('fetch failed')) {
                throw new Error('无法连接到 SillyTavern 后端，请确认 ST 已启动且地址正确');
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 测试连接性
     */
    async ping() {
        try {
            await this._request('/api/characters/all', { method: 'POST' });
            return true;
        } catch {
            return false;
        }
    }

    // ==================== 角色卡 API ====================

    /**
     * 获取所有角色列表
     * @returns {Promise<Array<{name, avatar, create_date, tags}>>}
     */
    async getCharacters() {
        const data = await this._request('/api/characters/all', { method: 'POST' });
        return data.characters || [];
    }

    /**
     * 导入角色卡
     * ST 的 /api/characters/import 接受 multipart/form-data
     * @param {string} jsonString - 角色卡 JSON（V2 或 V3）
     * @returns {Promise<object>}
     */
    async importCharacter(jsonString) {
        let charData;
        try {
            charData = JSON.parse(jsonString);
        } catch {
            throw new Error('角色卡 JSON 格式无效');
        }

        const name = charData.data?.name || charData.name || 'imported';
        const formData = new FormData();
        formData.append('file_name', name);
        // ST import 端点接受 JSON 字符串作为 character_data
        formData.append('character_data', JSON.stringify(charData));

        return this._request('/api/characters/import', {
            method: 'POST',
            body: formData,
        });
    }

    /**
     * 删除角色
     * @param {string} avatarUrl - 角色头像文件名（如 "苏晚.png"）
     * @param {boolean} deleteChats - 是否同时删除聊天记录
     */
    async deleteCharacter(avatarUrl, deleteChats = false) {
        return this._request('/api/characters/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar_url: avatarUrl, delete_chats: deleteChats }),
        });
    }

    // ==================== 世界书 API ====================

    /**
     * 导入世界书
     * @param {string} name - 世界书名称
     * @param {Array<object>} entries - 世界书词条数组
     */
    async importWorldInfo(name, entries) {
        return this._request('/api/worldinfo/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, entries }),
        });
    }

    /**
     * 获取世界书
     * @param {string} name - 世界书名称
     */
    async getWorldInfo(name) {
        return this._request(`/api/worldinfo/get?name=${encodeURIComponent(name)}`);
    }

    /**
     * 删除世界书
     * @param {string} name - 世界书名称
     */
    async deleteWorldInfo(name) {
        return this._request('/api/worldinfo/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
    }

    // ==================== 预设 API ====================

    /**
     * 保存预设
     * 优先尝试 API，失败则写文件系统
     * @param {string} presetName - 预设名称
     * @param {string} presetJson - 预设 JSON 字符串
     * @param {string} dataDir - ST 的 data 目录路径
     */
    async savePreset(presetName, presetJson, dataDir) {
        // P0-3 安全修复：预设名白名单校验，杜绝路径穿越（如 "../gateway.json"）
        if (!isValidPresetName(presetName)) {
            throw new Error('预设名非法：仅允许中文、字母、数字、下划线与短横线（最长64字符）');
        }

        // 尝试 API
        try {
            return await this._request('/api/presets/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: presetName, preset: presetJson }),
            });
        } catch {
            // fallback: 文件系统
            if (dataDir) {
                const presetPath = path.join(dataDir, 'OpenAI Settings', `${presetName}.json`);
                const presetDir = path.dirname(presetPath);
                if (!fs.existsSync(presetDir)) {
                    fs.mkdirSync(presetDir, { recursive: true });
                }
                fs.writeFileSync(presetPath, presetJson, 'utf-8');
                return { result: 'ok', method: 'filesystem', path: presetPath };
            }
            throw new Error('预设 API 不可用且未配置 ST data 目录');
        }
    }
}

// ==================== 插件主类 ====================

export default class STDataManagerPlugin extends GatewayPlugin {
    static commands = [
        // === 角色卡管理 ===
        {
            name: 'char_upload',
            alias: ['上传角色'],
            handler: 'handleCharUpload',
            description: '导入角色卡JSON到ST（V3卡自动含世界书）',
            usage: '/char_upload <角色卡JSON>',
        },
        {
            name: 'char_delete',
            alias: ['删除角色'],
            handler: 'handleCharDelete',
            description: '删除ST角色',
            usage: '/char_delete <角色名>',
            // P0-3 安全修复：删除角色（含聊天记录）属高危操作，仅管理员可用
            adminOnly: true,
        },
        {
            name: 'char_list',
            alias: ['角色列表'],
            handler: 'handleCharList',
            description: '列出所有ST角色',
            usage: '/char_list',
        },

        // === 世界书管理 ===
        {
            name: 'world_upload',
            alias: ['上传世界书'],
            handler: 'handleWorldUpload',
            description: '导入世界书JSON到ST',
            usage: '/world_upload <名称> <json>',
        },
        {
            name: 'world_delete',
            alias: ['删除世界书'],
            handler: 'handleWorldDelete',
            description: '删除世界书',
            usage: '/world_delete <名称>',
            // P0-3 安全修复：删除世界书属高危操作，仅管理员可用
            adminOnly: true,
        },

        // === 场景注入 ===
        {
            name: 'scene_load',
            alias: ['加载场景'],
            handler: 'handleSceneLoad',
            description: '加载预设场景的世界书词条',
            usage: '/scene_load <场景名>',
        },
        {
            name: 'scene_clear',
            alias: ['清除场景'],
            handler: 'handleSceneClear',
            description: '清除已加载的场景词条',
            usage: '/scene_clear',
        },
        {
            name: 'scene_list',
            alias: ['场景列表'],
            handler: 'handleSceneList',
            description: '列出可用场景',
            usage: '/scene_list',
        },

        // === 预设管理 ===
        {
            name: 'preset_upload',
            alias: ['上传预设'],
            handler: 'handlePresetUpload',
            description: '上传预设JSON到ST',
            usage: '/preset_upload <名称> <json>',
            // P0-3 安全修复：预设上传可能触发文件系统写入，仅管理员可用
            adminOnly: true,
        },

        // === 会话-角色绑定 ===
        {
            name: 'bind',
            alias: ['绑定'],
            handler: 'handleBind',
            description: '将当前会话绑定到ST角色',
            usage: '/bind <角色名>',
        },
        {
            name: 'unbind',
            alias: ['解绑'],
            handler: 'handleUnbind',
            description: '解除当前会话的角色绑定',
            usage: '/unbind',
        },
        {
            name: 'bind_list',
            alias: ['绑定列表'],
            handler: 'handleBindList',
            description: '查看所有会话-角色绑定',
            usage: '/bind_list',
        },

        // === ST 连接状态 ===
        {
            name: 'st_status',
            alias: ['ST状态'],
            handler: 'handleStStatus',
            description: '查看与 SillyTavern 后端的连接状态',
            usage: '/st_status',
        },
    ];

    constructor(options) {
        super(options);
        this._apiClient = null;
    }

    // ==================== 生命周期 ====================

    async onLoad() {
        this._ensureDefaults();
        this._refreshApiClient();

        // 验证 ST 连接
        const ok = await this._apiClient.ping();
        if (ok) {
            this.logger.info('ST 后端连接正常');
        } else {
            this.logger.warn('ST 后端不可达，请在插件配置中检查 stUrl');
        }

        this.logger.info('ST数据管理插件已加载');
    }

    async onUnload() {
        this.logger.info('ST数据管理插件已卸载');
    }

    /**
     * 初始化配置默认值
     */
    _ensureDefaults() {
        if (this.getConfig('stUrl') === undefined) {
            this.setConfig('stUrl', 'http://localhost:8000');
        }
        if (this.getConfig('stAuth') === undefined) {
            this.setConfig('stAuth', '');
        }
        if (this.getConfig('stDataDir') === undefined) {
            this.setConfig('stDataDir', '');
        }
        if (this.getConfig('bindings') === undefined) {
            this.setConfig('bindings', {});
        }
    }

    /**
     * 刷新 API 客户端（配置变更后调用）
     */
    _refreshApiClient() {
        this._apiClient = new STApiClient(
            this.getConfig('stUrl'),
            this.getConfig('stAuth')
        );
    }

    /**
     * 获取会话键
     */
    _sessionKey(platform, chatId) {
        return `${platform}:${chatId}`;
    }

    // ==================== 角色卡管理命令 ====================

    /**
     * /char_list - 列出所有角色
     */
    async handleCharList(ctx) {
        try {
            const characters = await this._apiClient.getCharacters();
            if (characters.length === 0) {
                return ctx.reply('📭 ST 中暂无角色卡');
            }

            const lines = [`📋 ST 角色列表 (共 ${characters.length} 个):`, ''];
            characters.forEach((c, i) => {
                lines.push(`${i + 1}. ${c.name}`);
            });
            lines.push('', '使用 /bind <角色名> 绑定到当前会话');
            return ctx.reply(lines.join('\n'));
        } catch (error) {
            return ctx.reply(`❌ ${error.message}`);
        }
    }

    /**
     * /char_upload <json> - 导入角色卡
     */
    async handleCharUpload(ctx) {
        const jsonStr = ctx.args.join(' ');
        if (!jsonStr) {
            return ctx.reply('用法: /char_upload <角色卡JSON>\n支持 V2/V3 规范，V3 卡含 character_book 时自动导入世界书');
        }

        try {
            // 校验 JSON 并提取信息
            const parsed = JSON.parse(jsonStr);
            const isV3 = parsed.spec === 'chara_card_v3';
            const hasBook = !!parsed.data?.character_book;
            const name = parsed.data?.name || parsed.name || '未知';

            // 导入
            await this._apiClient.importCharacter(jsonStr);

            let msg = `✅ 角色卡导入成功: ${name}`;
            if (isV3) {
                msg += '\n📋 规范: V3';
            }
            if (hasBook) {
                msg += '\n📖 检测到内嵌世界书，ST 会自动提取创建';
            }
            msg += `\n使用 /bind ${name} 绑定到当前会话`;

            this.logger.info(`角色卡导入成功: ${name} (V3=${isV3}, book=${hasBook})`);
            return ctx.reply(msg);
        } catch (error) {
            this.logger.error(`角色卡导入失败: ${error.message}`);
            return ctx.reply(`❌ 导入失败: ${error.message}`);
        }
    }

    /**
     * /char_delete <角色名> - 删除角色
     */
    async handleCharDelete(ctx) {
        const characterName = ctx.args[0];
        if (!characterName) {
            return ctx.reply('用法: /char_delete <角色名>');
        }

        try {
            // 查找角色获取 avatar
            const characters = await this._apiClient.getCharacters();
            const char = characters.find(c => c.name === characterName);
            if (!char) {
                return ctx.reply(`❌ 未找到角色 "${characterName}"`);
            }

            // 删除（同时删除聊天记录）
            await this._apiClient.deleteCharacter(char.avatar, true);

            // 清理可能存在的绑定
            const bindings = this.getConfig('bindings') || {};
            let bindingCleared = false;
            for (const [key, val] of Object.entries(bindings)) {
                if (val.characterName === characterName) {
                    delete bindings[key];
                    bindingCleared = true;
                }
            }
            if (bindingCleared) {
                this.setConfig('bindings', bindings);
            }

            this.logger.info(`角色已删除: ${characterName}`);
            return ctx.reply(`✅ 已删除角色: ${characterName}${bindingCleared ? '\n⚠️ 相关会话绑定已清除' : ''}`);
        } catch (error) {
            return ctx.reply(`❌ ${error.message}`);
        }
    }

    // ==================== 世界书管理命令 ====================

    /**
     * /world_upload <名称> <json> - 导入世界书
     */
    async handleWorldUpload(ctx) {
        const name = ctx.args[0];
        const jsonStr = ctx.args.slice(1).join(' ');
        if (!name || !jsonStr) {
            return ctx.reply('用法: /world_upload <世界书名称> <词条JSON数组>');
        }

        try {
            const entries = JSON.parse(jsonStr);
            if (!Array.isArray(entries)) {
                return ctx.reply('❌ 世界书数据必须是词条数组 JSON');
            }
            await this._apiClient.importWorldInfo(name, entries);
            this.logger.info(`世界书导入成功: ${name} (${entries.length} 条)`);
            return ctx.reply(`✅ 世界书导入成功: ${name}\n词条数: ${entries.length}`);
        } catch (error) {
            return ctx.reply(`❌ ${error.message}`);
        }
    }

    /**
     * /world_delete <名称> - 删除世界书
     */
    async handleWorldDelete(ctx) {
        const name = ctx.args[0];
        if (!name) {
            return ctx.reply('用法: /world_delete <世界书名称>');
        }

        try {
            await this._apiClient.deleteWorldInfo(name);
            this.logger.info(`世界书已删除: ${name}`);
            return ctx.reply(`✅ 世界书已删除: ${name}`);
        } catch (error) {
            return ctx.reply(`❌ ${error.message}`);
        }
    }

    // ==================== 场景注入命令 ====================

    /**
     * /scene_list - 列出可用场景
     */
    async handleSceneList(ctx) {
        const names = Object.keys(BUILTIN_SCENES);
        const lines = ['🎭 可用场景:', ''];
        for (const name of names) {
            lines.push(`• ${name} - ${BUILTIN_SCENES[name].description}`);
        }
        lines.push('', '使用 /scene_load <场景名> 加载场景');
        return ctx.reply(lines.join('\n'));
    }

    /**
     * /scene_load <场景名> - 加载预设场景
     */
    async handleSceneLoad(ctx) {
        const sceneName = ctx.args[0];
        if (!sceneName) {
            const names = Object.keys(BUILTIN_SCENES).join(', ');
            return ctx.reply(`用法: /scene_load <场景名>\n可用场景: ${names}`);
        }

        const scene = BUILTIN_SCENES[sceneName];
        if (!scene) {
            return ctx.reply(`❌ 未找到场景 "${sceneName}"\n使用 /scene_list 查看可用场景`);
        }

        try {
            // 导入为 ST 世界书文件
            const worldName = `scene_${sceneName}`;
            await this._apiClient.importWorldInfo(worldName, scene.entries);

            // 记录当前会话激活的场景
            const bindings = this.getConfig('bindings') || {};
            const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);
            if (bindings[sessionKey]) {
                bindings[sessionKey].activeScene = sceneName;
                this.setConfig('bindings', bindings);
            }

            this.logger.info(`场景已加载: ${sceneName} -> ${worldName} (${scene.entries.length} 条词条)`);
            return ctx.reply(
                `✅ 场景已加载: ${sceneName}\n` +
                `📝 ${scene.description}\n` +
                `📖 世界书文件: ${worldName} (${scene.entries.length} 条词条)\n` +
                `💡 请在 ST 中激活该世界书以生效`
            );
        } catch (error) {
            return ctx.reply(`❌ ${error.message}`);
        }
    }

    /**
     * /scene_clear - 清除场景
     */
    async handleSceneClear(ctx) {
        const bindings = this.getConfig('bindings') || {};
        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);
        const binding = bindings[sessionKey];

        if (!binding || !binding.activeScene) {
            return ctx.reply('ℹ️ 当前会话未加载场景');
        }

        const sceneName = binding.activeScene;
        try {
            // 删除场景世界书
            await this._apiClient.deleteWorldInfo(`scene_${sceneName}`);

            // 清除绑定中的场景标记
            delete binding.activeScene;
            this.setConfig('bindings', bindings);

            this.logger.info(`场景已清除: ${sceneName}`);
            return ctx.reply(`✅ 场景已清除: ${sceneName}`);
        } catch (error) {
            // 即使删除失败也清除标记
            delete binding.activeScene;
            this.setConfig('bindings', bindings);
            return ctx.reply(`⚠️ 场景标记已清除，但删除世界书文件失败: ${error.message}`);
        }
    }

    // ==================== 预设管理命令 ====================

    /**
     * /preset_upload <名称> <json> - 上传预设
     */
    async handlePresetUpload(ctx) {
        const name = ctx.args[0];
        const jsonStr = ctx.args.slice(1).join(' ');
        if (!name || !jsonStr) {
            return ctx.reply('用法: /preset_upload <预设名称> <预设JSON>');
        }

        try {
            // 校验 JSON
            JSON.parse(jsonStr);

            const dataDir = this.getConfig('stDataDir') || '';
            const result = await this._apiClient.savePreset(name, jsonStr, dataDir);

            const method = result.method || 'api';
            this.logger.info(`预设上传成功: ${name} (${method})`);
            return ctx.reply(
                `✅ 预设上传成功: ${name}\n` +
                `方式: ${method === 'filesystem' ? '文件系统' : 'API'}\n` +
                `⚠️ 预设热切换可能需要刷新 ST 前端`
            );
        } catch (error) {
            return ctx.reply(`❌ ${error.message}`);
        }
    }

    // ==================== 会话-角色绑定命令 ====================

    /**
     * /bind <角色名> - 绑定当前会话到 ST 角色
     */
    async handleBind(ctx) {
        const characterName = ctx.args[0];
        if (!characterName) {
            return ctx.reply('用法: /bind <角色名>\n使用 /char_list 查看可用角色');
        }

        try {
            // 验证角色存在
            const characters = await this._apiClient.getCharacters();
            const char = characters.find(c => c.name === characterName);
            if (!char) {
                const available = characters.map(c => c.name).slice(0, 10).join(', ');
                return ctx.reply(`❌ 未找到角色 "${characterName}"\n可用角色: ${available}${characters.length > 10 ? '...' : ''}`);
            }

            // 写入绑定表
            const bindings = this.getConfig('bindings') || {};
            const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);

            // 保留已有的场景设置
            const existingScene = bindings[sessionKey]?.activeScene;

            bindings[sessionKey] = {
                characterName: char.name,
                avatar: char.avatar,
                boundAt: Date.now(),
            };
            if (existingScene) {
                bindings[sessionKey].activeScene = existingScene;
            }

            this.setConfig('bindings', bindings);

            this.logger.info(`绑定成功: ${sessionKey} -> ${char.name}`);
            return ctx.reply(
                `✅ 已绑定角色: ${char.name}\n` +
                `本会话消息将路由到该角色的聊天记录\n` +
                `ST 扩展会在下次轮询时自动切换角色（最多 3 秒延迟）`
            );
        } catch (error) {
            return ctx.reply(`❌ ${error.message}`);
        }
    }

    /**
     * /unbind - 解除绑定
     */
    async handleUnbind(ctx) {
        const bindings = this.getConfig('bindings') || {};
        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);

        if (!bindings[sessionKey]) {
            return ctx.reply('ℹ️ 当前会话未绑定角色');
        }

        const charName = bindings[sessionKey].characterName;
        delete bindings[sessionKey];
        this.setConfig('bindings', bindings);

        this.logger.info(`解绑成功: ${sessionKey} (was ${charName})`);
        return ctx.reply(`✅ 已解除绑定 (原角色: ${charName})`);
    }

    /**
     * /bind_list - 查看所有绑定
     */
    async handleBindList(ctx) {
        const bindings = this.getConfig('bindings') || {};
        const entries = Object.entries(bindings);

        if (entries.length === 0) {
            return ctx.reply('📭 暂无会话-角色绑定\n使用 /bind <角色名> 绑定');
        }

        const lines = [`📋 会话-角色绑定列表 (${entries.length}):`, ''];
        for (const [key, val] of entries) {
            const time = new Date(val.boundAt).toLocaleString('zh-CN');
            lines.push(`${key}`);
            lines.push(`  -> ${val.characterName}${val.activeScene ? ` [场景: ${val.activeScene}]` : ''}`);
            lines.push(`  绑定时间: ${time}`);
            lines.push('');
        }
        return ctx.reply(lines.join('\n'));
    }

    // ==================== ST 连接状态 ====================

    /**
     * /st_status - 查看 ST 连接状态
     */
    async handleStStatus(ctx) {
        const stUrl = this.getConfig('stUrl') || 'http://localhost:8000';
        const bindings = this.getConfig('bindings') || {};
        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);
        const currentBinding = bindings[sessionKey];

        try {
            const ok = await this._apiClient.ping();
            const characters = ok ? await this._apiClient.getCharacters() : [];

            const lines = [
                '🔧 ST 数据管理状态',
                '',
                `ST 后端: ${stUrl}`,
                `连接状态: ${ok ? '✅ 正常' : '❌ 不可达'}`,
                `角色总数: ${characters.length}`,
                `当前会话绑定: ${currentBinding ? currentBinding.characterName : '未绑定'}`,
                `当前场景: ${currentBinding?.activeScene || '无'}`,
                `绑定总数: ${Object.keys(bindings).length}`,
            ];
            return ctx.reply(lines.join('\n'));
        } catch (error) {
            return ctx.reply(
                `🔧 ST 数据管理状态\n\n` +
                `ST 后端: ${stUrl}\n` +
                `连接状态: ❌ 不可达\n` +
                `错误: ${error.message}`
            );
        }
    }
}
