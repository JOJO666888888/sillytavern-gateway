/**
 * Agent 角色扮演插件 (Phase 2 - IM 界面适配器)
 *
 * 通过 IM 平台直接进行 AI 角色扮演，作为表现层适配器消费 AgentRunResult。
 *
 * 双模式工作流：
 *   A. Agent 引擎模式（agent-framework 已启用 + 本插件声明 agent 权限）：
 *      1. 用户 /rp start 启动会话，选择 Agent Profile
 *      2. 会话激活后，普通消息被监听器拦截
 *      3. 调 ctx.agent.run(profile, input, session, ctx) 触发引擎，产出 AgentRunResult
 *      4. 调 ctx.surface.dispatch(result, ctx, { primarySurfaceType: 'im' }) 渲染
 *      5. IM 适配器（本插件注册）消费 result：
 *         - 正文按段落切分逐条发送（避免超长）
 *         - 选项格式化为 >选项X： 文本（option-splitter 自动转按钮）
 *         - state.visible 渲染为状态卡片图片旁路发送（复用 message-to-image renderer）
 *
 *   B. 兜底模式（agent-framework 未启用 / 无 agent 权限）：
 *      回退到原 chatStream 直调逻辑：自己组装 prompt + ctx.llm.chatStream。
 *
 * 命令：
 *   /rp start [角色卡名|Profile名]    启动 RP 会话
 *   /rp stop                          结束 RP 会话
 *   /rp status                        查看当前 RP 状态
 *   /rp style [文风名]                切换/查看当前文风
 *   /rp mode [actor|director]         切换视角模式
 *   /rp character [名称]              切换角色卡
 *   /rp profile [Profile名]           切换 Agent Profile（引擎模式）
 *   /rp skill [list|load|unload|clear] - 管理 skill
 *   /rp bindbot <botId> <profile>     群聊多 Bot：绑定 botId 到 Profile
 *   /rp unbindbot <botId>             群聊多 Bot：解绑 botId
 *   /rp help                          显示帮助
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GatewayPlugin } from '../../server/plugin-sdk.js';
import { OutboundMessage } from '../../server/adapters/base-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 插件数据目录（与 ctx.fs 的沙箱根目录一致）
const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'plugins', 'agent-rp');

// 选项行匹配正则（复用 option-splitter 的 >选项X： 格式，支持中文/阿拉伯数字、全角/半角冒号）
const OPTION_LINE_REGEX = /^>\s*选项\s*([一二三四五六七八九十\d]+)\s*[：:]\s*(.+)$/gm;

// 视角模式指令
const VIEW_MODE_INSTRUCTIONS = {
    actor: '你正在进行角色扮演。你控制NPC和环境，用户控制主角。用第一人称或限定第三人称叙述。保持角色一致性，包含场景描写、动作、对话和心理活动。',
    director: '你正在进行角色扮演（导演模式）。你控制所有角色包括主角，用第三人称全景叙述。用户只给大方向。包含场景描写、动作、对话和心理活动。',
};

// 默认 system prompt（角色卡为空时使用）
const DEFAULT_SYSTEM_PROMPT = '你是一个善于角色扮演的 AI 助手，能够根据设定的角色和场景进行沉浸式互动叙事。请用生动的文字描述场景、动作和对话。';

// 正文段落切分阈值：单段超过此长度时尝试按单换行二次切分
const PARAGRAPH_MAX_LEN = 800;

export default class AgentRPPlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'rp',
            alias: ['角色扮演'],
            handler: 'handleRp',
            description: 'AI 角色扮演会话（IM 适配器）',
            usage: '/rp <start|stop|status|style|mode|character|profile|skill|bindbot|unbindbot|help>',
        },
    ];

    static listeners = [
        {
            event: 'message',
            filter: {},
            handler: 'onMessage',
            priority: 50, // 高于 llm-chat (150)，确保 RP 模式优先拦截
        },
    ];

    constructor(options) {
        super(options);
        this._removeInbound = null;
        this._removeSurface = null;
        // 状态图渲染器（懒加载，复用 message-to-image 的 ImageRenderer）
        this._stateRenderer = null;
        this._stateRendererInitFailed = false;
        // IM 适配器是否已注册（懒注册：首次 onMessage 时通过 ctx.surface.register 注册）
        this._surfaceAdapterRegistered = false;
    }

    // ==================== 生命周期 ====================

    async onLoad() {
        // 确保 sessions/ 和 styles/ 目录存在
        try {
            fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true });
            fs.mkdirSync(path.join(DATA_DIR, 'styles'), { recursive: true });
            fs.mkdirSync(path.join(DATA_DIR, 'memory'), { recursive: true });
            fs.mkdirSync(path.join(DATA_DIR, 'skills'), { recursive: true });
        } catch (e) {
            this.logger.warn(`初始化目录失败: ${e.message}`);
        }

        // 首次启动引导：从 agent-framework 的 templates/defaults/ 复制默认记忆模板与文风
        // 到 agent-rp 的 memory/ 和 styles/ 目录（仅在目标文件不存在时复制）。
        this._seedDefaultMemoryAndStyle();

        // 注册入站过滤器（priority=50，在命令路由/监听器之前执行）
        const gateway = this._services.gateway;
        if (gateway?.addInboundFilter) {
            this._removeInbound = gateway.addInboundFilter(
                (msg) => this._filterInbound(msg),
                { name: 'agent-rp', priority: 50 },
            );
            this.logger.info('Agent RP 入站过滤器已注册');
        } else {
            this.logger.warn('未获得 addInboundFilter，请确认已授予 gateway.inbound 权限');
        }

        // IM 表现层适配器在首次 onMessage 时懒注册（此时 ctx.surface 才可用）。
        // 也可通过命令路径注册（/rp start 等），见 _ensureSurfaceAdapter。
        this._surfaceAdapterRegistered = false;

        this.logger.info('Agent 角色扮演插件（IM 适配器）已加载');
    }

    async onUnload() {
        if (this._removeInbound) {
            this._removeInbound();
            this._removeInbound = null;
        }
        if (this._removeSurface) {
            this._removeSurface();
            this._removeSurface = null;
        }
        if (this._stateRenderer) {
            try { await this._stateRenderer.dispose(); } catch (_) {}
            this._stateRenderer = null;
        }
    }

    /**
     * 懒注册 IM 表现层适配器（SubTask 2.1）。
     *
     * 在 onLoad 阶段 ctx.surface 不可用（SurfaceManager 通过 PluginManager
     * 按 message 注入），所以推迟到首次有 ctx 时注册。
     *
     * @param {object} ctx - 插件上下文
     * @returns {boolean} 是否注册成功
     * @private
     */
    _ensureSurfaceAdapter(ctx) {
        if (this._surfaceAdapterRegistered) return true;
        try {
            if (!ctx?.surface?.register) return false;
            this._removeSurface = ctx.surface.register({
                name: 'im-default',
                surfaceType: 'im',
                render: (result, renderCtx) => this._renderToIM(result, renderCtx),
            });
            this._surfaceAdapterRegistered = true;
            this.logger.info('IM 表现层适配器 im-default 已注册');
            return true;
        } catch (e) {
            this.logger.warn(`IM 适配器注册失败（将仅支持兜底模式）: ${e.message}`);
            return false;
        }
    }

    // ==================== 入站过滤器 ====================

    /**
     * 入站过滤器：在命令路由/监听器之前检查 RP 模式状态。
     * 仅做标记，不拦截消息（返回 null 会完全丢弃消息，导致监听器也无法执行）。
     * @param {import('../../server/adapters/base-adapter.js').InboundMessage} message
     * @returns {object|null} 消息对象（始终放行）
     */
    _filterInbound(message) {
        if (!message?.content) return message;

        const content = message.content.trim();

        // /rp 命令和其他 / 命令放行给命令路由
        if (content.startsWith('/')) return message;

        // 检查是否在 RP 模式（入站过滤器无 ctx.fs，用原始 fs 读取会话状态）
        if (this._isRpActiveRaw(message.platform, message.chatId)) {
            message.metadata = message.metadata || {};
            message.metadata._rpIntercepted = true;
        }

        return message;
    }

    /**
     * 用原始 fs 模块检查 RP 会话是否激活（供入站过滤器使用，无 ctx.fs）
     */
    _isRpActiveRaw(platform, chatId) {
        try {
            const key = this._getSessionKey(platform, chatId);
            const filePath = path.join(DATA_DIR, 'sessions', `${key}.json`);
            if (!fs.existsSync(filePath)) return false;
            const session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return session.active === true;
        } catch (e) {
            return false;
        }
    }

    // ==================== /rp 命令处理 ====================

    async handleRp(ctx) {
        const sub = (ctx.args[0] || 'help').toLowerCase();
        switch (sub) {
            case 'start':
            case '开始':
                return this._cmdStart(ctx);
            case 'stop':
            case '结束':
                return this._cmdStop(ctx);
            case 'status':
            case '状态':
                return this._cmdStatus(ctx);
            case 'style':
            case '文风':
                return this._cmdStyle(ctx);
            case 'mode':
            case '模式':
                return this._cmdMode(ctx);
            case 'character':
            case '角色':
                return this._cmdCharacter(ctx);
            case 'profile':
            case '档案':
                return this._cmdProfile(ctx);
            case 'skill':
            case '技能':
                return this._cmdSkill(ctx);
            case 'bindbot':
            case '绑定bot':
                return this._cmdBindBot(ctx);
            case 'unbindbot':
            case '解绑bot':
                return this._cmdUnbindBot(ctx);
            case 'help':
            case '帮助':
            default:
                return this._cmdHelp(ctx);
        }
    }

    /** /rp start [角色卡名|Profile名] - 启动 RP 会话 */
    async _cmdStart(ctx) {
        const session = await this._getSession(ctx);

        if (session.active) {
            return ctx.reply(
                `⚠️ RP 会话已在进行中（Profile：${session.profile || '默认'}，角色：${session.character || '无'}，${session.turnCount || 0} 轮）。\n` +
                `请先用 /rp stop 结束当前会话。`,
            );
        }

        // 确定参数：可能是 Profile 名（引擎模式）或角色卡名（兜底模式）
        const arg = ctx.args.slice(1).join(' ').trim();
        const agentAvailable = this._isAgentAvailable(ctx);

        if (agentAvailable) {
            // 引擎模式：参数视为 Profile 名
            // 优先级：用户显式参数 > 配置 defaultProfile > agentLoader 的 isDefault 标记
            let profile = arg || this.getConfig('defaultProfile') || this._detectDefaultProfile(ctx);
            if (!profile) {
                return ctx.reply(
                    '⚠️ 未指定 Agent Profile，且未配置 defaultProfile。\n' +
                    '用法：/rp start <Profile名>\n' +
                    '或：/rp character <角色卡名> 后用 /rp start',
                );
            }

            // 默认方案一键开玩（SubTask 6.5）：若使用的是 default-rp（isDefault），
            // 且用户未显式指定文风，则自动选用 default 文风（去八股写作 skill）。
            const isDefaultProfile = profile === 'default-rp' || this._isDefaultProfile(ctx, profile);
            const style = this.getConfig('defaultStyle')
                || (isDefaultProfile ? 'default' : '');

            // 若用户传了角色卡名作为参数，且 default-rp 之外无显式 profile，
            // 把角色卡名写入 session.character（供 context-builder 注入角色卡资产）
            // 注意：arg 在引擎模式已被当作 profile 名消费；若 arg 不匹配任何 profile，
            // 但匹配某个角色卡，则改走角色卡绑定 + 默认 profile。
            if (arg && profile === (this._detectDefaultProfile(ctx) || 'default-rp')) {
                // 用户可能传的是角色卡名而非 profile 名——尝试识别
                const card = this._tryReadCharacter(ctx, arg);
                if (card) {
                    session.character = arg;
                }
            }

            session.active = true;
            session.profile = profile;
            session.viewMode = this.getConfig('defaultViewMode') || 'actor';
            session.style = style;
            session.turnCount = 0;
            session.startTime = Date.now();
            session.botProfileMap = session.botProfileMap || {};
            await this._saveSession(ctx, session);

            const charLine = session.character ? `\n  角色卡：${session.character}` : '';
            return ctx.reply(
                `🎭 RP 会话已启动（引擎模式）！\n` +
                `  Profile：${profile}\n` +
                `  视角：${session.viewMode === 'director' ? '导演模式' : '扮演模式'}\n` +
                `  文风：${session.style || '默认'}${charLine}\n` +
                `  发送消息即可开始角色扮演，/rp stop 结束。`,
            );
        }

        // 兜底模式：参数视为角色卡名
        const charName = arg || this.getConfig('defaultCharacter') || '';

        if (!charName) {
            const chars = ctx.assets.listCharacters();
            if (chars.length === 0) {
                session.active = true;
                session.character = '';
                session.viewMode = this.getConfig('defaultViewMode') || 'actor';
                session.style = this.getConfig('defaultStyle') || '';
                session.turnCount = 0;
                session.startTime = Date.now();
                session.botProfileMap = session.botProfileMap || {};
                await this._saveSession(ctx, session);
                return ctx.reply('🎭 RP 会话已启动（兜底模式，无角色卡）。\n发送消息即可开始角色扮演，/rp stop 结束。');
            }
            const list = chars.map(c => `  - ${c.replace(/\.(json|png)$/, '')}`).join('\n');
            return ctx.reply(`请指定角色卡：/rp start <角色卡名>\n\n可用角色卡：\n${list}`);
        }

        const card = ctx.assets.readCharacter(charName);
        if (!card) {
            return ctx.reply(`❌ 未找到角色卡「${charName}」。\n用 /rp character 查看可用角色卡。`);
        }

        session.active = true;
        session.character = charName;
        session.viewMode = this.getConfig('defaultViewMode') || 'actor';
        session.style = this.getConfig('defaultStyle') || '';
        session.turnCount = 0;
        session.startTime = Date.now();
        session.botProfileMap = session.botProfileMap || {};
        await this._saveSession(ctx, session);

        const displayName = card.name || charName;
        let reply =
            `🎭 RP 会话已启动（兜底模式）！\n` +
            `  角色：${displayName}\n` +
            `  视角：${session.viewMode === 'director' ? '导演模式' : '扮演模式'}\n` +
            `  文风：${session.style || '默认'}`;

        if (card.first_mes) {
            reply += `\n\n${card.first_mes}`;
        }

        return ctx.reply(reply);
    }

    /** /rp stop - 结束 RP 会话 */
    async _cmdStop(ctx) {
        const session = await this._getSession(ctx);
        if (!session.active) {
            return ctx.reply('当前未在 RP 会话中。用 /rp start 开始。');
        }
        const turns = session.turnCount || 0;
        session.active = false;
        session.turnCount = 0;
        await this._saveSession(ctx, session);
        return ctx.reply(`🛑 RP 会话已结束（共 ${turns} 轮）。`);
    }

    /** /rp status - 查看当前 RP 状态 */
    async _cmdStatus(ctx) {
        const session = await this._getSession(ctx);
        const agentAvailable = this._isAgentAvailable(ctx);
        const lines = [
            '📋 RP 会话状态',
            `  模式：${agentAvailable ? '引擎（agent-framework）' : '兜底（chatStream）'}`,
            `  状态：${session.active ? '✅ 进行中' : '❌ 未启动'}`,
            `  Profile：${session.profile || '（无）'}`,
            `  角色：${session.character || '（无）'}`,
            `  视角：${session.viewMode === 'director' ? '导演模式' : '扮演模式'}`,
            `  文风：${session.style || '（默认）'}`,
            `  轮数：${session.turnCount || 0}`,
        ];
        if (session.active && session.startTime) {
            const elapsed = Math.round((Date.now() - session.startTime) / 60000);
            lines.push(`  时长：${elapsed} 分钟`);
        }
        // 多 Bot 绑定信息
        const botMap = session.botProfileMap || {};
        const botIds = Object.keys(botMap);
        if (botIds.length > 0) {
            lines.push(`  Bot 绑定（${botIds.length}）：`);
            for (const id of botIds) {
                lines.push(`    ${id} -> ${botMap[id]}`);
            }
        }
        return ctx.reply(lines.join('\n'));
    }

    /** /rp style [文风名] - 切换/查看当前文风 */
    async _cmdStyle(ctx) {
        const session = await this._getSession(ctx);
        const styleName = ctx.args.slice(1).join(' ').trim();

        if (!styleName) {
            const styles = this._listStyles(ctx);
            const lines = [
                '📝 文风设置',
                `  当前：${session.style || '（默认）'}`,
                '',
            ];
            if (styles.length > 0) {
                lines.push('可用文风：');
                styles.forEach(s => lines.push(`  - ${s}`));
            } else {
                lines.push('（暂无文风文件，请在 data/plugins/agent-rp/styles/ 目录放置 .md 文件）');
            }
            return ctx.reply(lines.join('\n'));
        }

        const stylePath = `styles/${styleName}.md`;
        if (!ctx.fs.exists(stylePath)) {
            const styles = this._listStyles(ctx);
            return ctx.reply(`❌ 未找到文风文件「${styleName}」。\n可用文风：${styles.length ? styles.join('、') : '无'}`);
        }

        session.style = styleName;
        await this._saveSession(ctx, session);
        return ctx.reply(`✅ 文风已切换为「${styleName}」`);
    }

    /** /rp mode [actor|director] - 切换视角模式 */
    async _cmdMode(ctx) {
        const session = await this._getSession(ctx);
        const mode = (ctx.args[1] || '').toLowerCase();

        if (!mode) {
            return ctx.reply(
                `当前视角模式：${session.viewMode === 'director' ? '导演（director）' : '扮演（actor）'}\n` +
                `切换：/rp mode actor 或 /rp mode director\n\n` +
                `  actor（扮演）：你控制主角，AI 控制 NPC 和环境\n` +
                `  director（导演）：AI 控制所有角色，你给大方向`,
            );
        }

        if (mode !== 'actor' && mode !== 'director') {
            return ctx.reply('❌ 视角模式只能是 actor 或 director。');
        }

        session.viewMode = mode;
        await this._saveSession(ctx, session);
        return ctx.reply(`✅ 视角模式已切换为「${mode === 'director' ? '导演' : '扮演'}」`);
    }

    /** /rp character [名称] - 切换角色卡 */
    async _cmdCharacter(ctx) {
        const session = await this._getSession(ctx);
        const charName = ctx.args.slice(1).join(' ').trim();

        if (!charName) {
            const chars = ctx.assets.listCharacters();
            const lines = [
                '👤 角色卡设置',
                `  当前：${session.character || '（无）'}`,
                '',
            ];
            if (chars.length > 0) {
                lines.push('可用角色卡：');
                chars.forEach(c => lines.push(`  - ${c.replace(/\.(json|png)$/, '')}`));
            } else {
                lines.push('（暂无角色卡，请在 assets/characters/ 目录放置角色卡）');
            }
            return ctx.reply(lines.join('\n'));
        }

        const card = ctx.assets.readCharacter(charName);
        if (!card) {
            return ctx.reply(`❌ 未找到角色卡「${charName}」。`);
        }

        session.character = charName;
        await this._saveSession(ctx, session);
        const displayName = card.name || charName;
        return ctx.reply(`✅ 角色卡已切换为「${displayName}」`);
    }

    /** /rp profile [Profile名] - 切换 Agent Profile（引擎模式） */
    async _cmdProfile(ctx) {
        const session = await this._getSession(ctx);
        const profileName = ctx.args.slice(1).join(' ').trim();

        if (!profileName) {
            return ctx.reply(
                `当前 Agent Profile：${session.profile || '（未设置）'}\n` +
                `切换：/rp profile <Profile名>\n` +
                `（Profile 名对应 data/plugins/agent-framework/agents/*.yaml 文件名）`,
            );
        }

        // 不强制校验 Profile 是否存在（agent-framework 可能未加载，校验留给 run 时）
        session.profile = profileName;
        await this._saveSession(ctx, session);
        return ctx.reply(`✅ Agent Profile 已切换为「${profileName}」\n（下次 /rp start 或发消息时生效）`);
    }

    /** /rp skill [list|load|unload|clear] - 管理 skill（知识/规则文件） */
    async _cmdSkill(ctx) {
        const action = (ctx.args[1] || 'list').toLowerCase();
        const skillName = ctx.args.slice(2).join(' ').trim();

        switch (action) {
            case 'list':
            case '列表': {
                const session = await this._getSession(ctx);
                const allSkills = this._listSkills(ctx);
                const loaded = session.loadedSkills || [];
                const lines = ['📦 Skill 管理', ''];
                if (allSkills.length === 0) {
                    lines.push('（暂无 skill 文件，请在 data/plugins/agent-rp/skills/ 目录放置 .md 文件）');
                } else {
                    lines.push('可用 skill：');
                    for (const s of allSkills) {
                        const mark = loaded.includes(s) ? '✅' : '⬜';
                        lines.push(`  ${mark} ${s}`);
                    }
                }
                if (loaded.length > 0) {
                    lines.push(`\n已加载：${loaded.join('、')}`);
                }
                return ctx.reply(lines.join('\n'));
            }

            case 'load':
            case '加载': {
                if (!skillName) return ctx.reply('用法：/rp skill load <skill名>');
                const skillPath = `skills/${skillName}.md`;
                if (!ctx.fs.exists(skillPath)) {
                    return ctx.reply(`❌ 未找到 skill「${skillName}」`);
                }
                const session = await this._getSession(ctx);
                if (!session.loadedSkills) session.loadedSkills = [];
                if (session.loadedSkills.includes(skillName)) {
                    return ctx.reply(`⚠️ skill「${skillName}」已加载`);
                }
                session.loadedSkills.push(skillName);
                await this._saveSession(ctx, session);
                return ctx.reply(`✅ skill「${skillName}」已加载`);
            }

            case 'unload':
            case '卸载': {
                if (!skillName) return ctx.reply('用法：/rp skill unload <skill名>');
                const session = await this._getSession(ctx);
                if (!session.loadedSkills || !session.loadedSkills.includes(skillName)) {
                    return ctx.reply(`⚠️ skill「${skillName}」未加载`);
                }
                session.loadedSkills = session.loadedSkills.filter(s => s !== skillName);
                await this._saveSession(ctx, session);
                return ctx.reply(`✅ skill「${skillName}」已卸载`);
            }

            case 'clear':
            case '清空': {
                const session = await this._getSession(ctx);
                const count = (session.loadedSkills || []).length;
                session.loadedSkills = [];
                await this._saveSession(ctx, session);
                return ctx.reply(`🧹 已卸载 ${count} 个 skill`);
            }

            default:
                return ctx.reply('用法：/rp skill <list|load|unload|clear> [skill名]');
        }
    }

    /** /rp bindbot <botId> <profile> - 群聊多 Bot 绑定（SubTask 2.5） */
    async _cmdBindBot(ctx) {
        const botId = ctx.args[1];
        const profile = ctx.args.slice(2).join(' ').trim();
        if (!botId || !profile) {
            return ctx.reply('用法：/rp bindbot <botId> <Profile名>\n示例：/rp bindbot 123456 default-rp');
        }

        const session = await this._getSession(ctx);
        if (!session.botProfileMap) session.botProfileMap = {};
        session.botProfileMap[botId] = profile;
        await this._saveSession(ctx, session);

        const count = Object.keys(session.botProfileMap).length;
        return ctx.reply(`✅ 已绑定 Bot ${botId} -> Profile「${profile}」（共 ${count} 个绑定）`);
    }

    /** /rp unbindbot <botId> - 群聊多 Bot 解绑（SubTask 2.5） */
    async _cmdUnbindBot(ctx) {
        const botId = ctx.args[1];
        if (!botId) {
            return ctx.reply('用法：/rp unbindbot <botId>');
        }
        const session = await this._getSession(ctx);
        if (!session.botProfileMap || !(botId in session.botProfileMap)) {
            return ctx.reply(`⚠️ Bot ${botId} 未绑定`);
        }
        delete session.botProfileMap[botId];
        await this._saveSession(ctx, session);
        return ctx.reply(`✅ 已解绑 Bot ${botId}`);
    }

    /** /rp help - 显示帮助 */
    async _cmdHelp(ctx) {
        const agentAvailable = this._isAgentAvailable(ctx);
        const lines = [
            '🎭 Agent 角色扮演（IM 适配器）- 命令帮助',
            '',
            '/rp start [角色卡|Profile]   - 启动 RP 会话',
            '/rp stop                     - 结束 RP 会话',
            '/rp status                   - 查看当前 RP 状态',
            '/rp style [文风名]           - 切换/查看当前文风',
            '/rp mode [actor|director]    - 切换视角模式',
            '/rp character [名称]         - 切换角色卡',
            '/rp profile [Profile名]      - 切换 Agent Profile（引擎模式）',
            '/rp skill [list|load|unload|clear] - 管理 skill',
            '/rp bindbot <botId> <profile> - 群聊多 Bot：绑定 botId 到 Profile',
            '/rp unbindbot <botId>         - 群聊多 Bot：解绑 botId',
            '/rp help                     - 显示本帮助',
            '',
            `💡 当前模式：${agentAvailable ? '引擎（agent-framework）' : '兜底（chatStream）'}`,
            '💡 启动后直接发送消息即可进行角色扮演',
            '💡 actor=扮演视角（你控制主角），director=导演视角（AI 控制全部）',
            '💡 群聊多 Bot：每个 Bot 实例各自 /rp bindbot，共享同一会话状态',
        ];
        return ctx.reply(lines.join('\n'));
    }

    // ==================== 入站消息拦截（监听器） ====================

    /**
     * RP 模式消息拦截：当会话处于 RP 模式时，拦截用户消息。
     *
     * 引擎模式：调 ctx.agent.run -> ctx.surface.dispatch（IM 适配器渲染）
     * 兜底模式：自己组装 prompt + ctx.llm.chatStream（不破坏旧逻辑）
     */
    async onMessage(ctx) {
        const content = (ctx.content || '').trim();
        if (!content) return;

        // / 开头的命令不拦截（交给命令路由处理）
        if (content.startsWith('/')) return;

        // 检查 RP 会话状态
        const session = await this._getSession(ctx);
        if (!session.active) return;

        // RP 模式：拦截消息，阻止后续插件处理
        ctx.stopPropagation();

        try {
            if (this._isAgentAvailable(ctx)) {
                await this._runWithAgent(ctx, session, content);
            } else {
                await this._runWithChatStream(ctx, session, content);
            }

            // 更新会话轮数
            session.turnCount = (session.turnCount || 0) + 1;
            await this._saveSession(ctx, session);
        } catch (e) {
            this.logger.error(`RP 生成失败: ${e.message}`);
            await ctx.reply(`抱歉，RP 生成失败：${e.message}`);
        }
    }

    /**
     * 引擎模式：调 ctx.agent.run -> ctx.surface.dispatch（SubTask 2.1）
     * @private
     */
    async _runWithAgent(ctx, session, input) {
        // 确保 IM 适配器已注册（懒注册，首次调用时通过 ctx.surface 注册）
        this._ensureSurfaceAdapter(ctx);

        // 解析当前应使用的 Profile（群聊多 Bot 协同 SubTask 2.5）
        const profile = this._resolveProfile(ctx, session);
        if (!profile) {
            throw new Error('未指定 Agent Profile，请用 /rp profile <Profile名> 或 /rp start <Profile名> 设置');
        }

        // 构造传给引擎的 session 对象（补全 platform/chatId/id 等）
        const agentSession = {
            id: `${ctx.platform}:${ctx.chatId}`,
            platform: ctx.platform,
            chatId: ctx.chatId,
            character: session.character || '',
            worldbook: '',
            style: session.style || '',
            viewMode: session.viewMode || 'actor',
            turn: session.turnCount || 0,
            turnCount: session.turnCount || 0,
            loadedSkills: session.loadedSkills || [],
            // 多 Bot 共享同一 workspace（通过 session.id 关联）
            botProfileMap: session.botProfileMap || {},
        };

        this.logger.info(`[agent-rp] 触发引擎 run，profile=${profile}, input=${input.length}字`);

        // 调引擎
        const runOutput = await ctx.agent.run(profile, input, agentSession, ctx);
        if (!runOutput?.result) {
            // 引擎异常但未抛错，兜底发文本
            const text = runOutput?.text || '（引擎未返回内容）';
            await this._replyRp(ctx, text);
            return;
        }

        // 写入会话历史（供下一轮 RP 记忆）
        const sm = this._services.sessionManager;
        if (sm?.addMessage) {
            sm.addMessage(ctx.platform, ctx.chatId, { role: 'user', content: input, name: ctx.senderName });
            sm.addMessage(ctx.platform, ctx.chatId, { role: 'assistant', content: runOutput.result.getMainText() });
        }

        // 调表现层分发（SubTask 2.1）
        // primarySurfaceType='im' 必调 IM 适配器；bypassSurfaceTypes 留空（状态图在 IM 适配器内联渲染）
        try {
            await ctx.surface.dispatch(runOutput.result, ctx, { primarySurfaceType: 'im' });
        } catch (e) {
            // surface 不可用时回退到直接发文本
            this.logger.warn(`[agent-rp] surface.dispatch 失败，回退直接发文本: ${e.message}`);
            await this._replyRp(ctx, runOutput.result.getMainText());
        }

        // 自动摘要：每 N 轮生成剧情摘要写入 memory/project.md
        const summaryInterval = this.getConfig('summaryInterval') ?? 10;
        if (summaryInterval > 0 && session.turnCount > 0 && (session.turnCount + 1) % summaryInterval === 0) {
            await this._generateSummary(ctx);
        }
    }

    /**
     * 兜底模式：自己组装 prompt + ctx.llm.chatStream（保留旧逻辑）
     * @private
     */
    async _runWithChatStream(ctx, session, content) {
        const messages = await this._buildPrompt(ctx, session, content);

        const sampling = {
            temperature: this.getConfig('temperature') ?? 0.8,
            max_tokens: this.getConfig('maxTokens') ?? 2048,
        };

        let fullReply = '';
        await ctx.llm.chatStream(messages, sampling, (delta, full) => {
            fullReply = full;
        });

        if (!fullReply) {
            fullReply = '（AI 未返回内容，请重试）';
        }

        // 选项提取协同：从回复中提取 >选项X： 格式的选项
        const stripOptions = this.getConfig('stripOptions') !== false;
        if (stripOptions) {
            const { mainText, options } = this._extractOptions(fullReply);

            if (mainText) {
                await this._replyRp(ctx, mainText);
            }

            for (let i = 0; i < options.length; i++) {
                await this._delay(i === 0 ? 300 : 600);
                await this._replyRp(ctx, `选项${options[i].index}：${options[i].content}`);
            }

            if (!mainText && options.length === 0) {
                await this._replyRp(ctx, fullReply);
            }
        } else {
            await this._replyRp(ctx, fullReply);
        }

        // 写入会话历史
        const sm = this._services.sessionManager;
        if (sm?.addMessage) {
            sm.addMessage(ctx.platform, ctx.chatId, { role: 'user', content, name: ctx.senderName });
            sm.addMessage(ctx.platform, ctx.chatId, { role: 'assistant', content: fullReply });
        }

        // 自动摘要
        const summaryInterval = this.getConfig('summaryInterval') ?? 10;
        if (summaryInterval > 0 && session.turnCount > 0 && (session.turnCount + 1) % summaryInterval === 0) {
            await this._generateSummary(ctx);
        }
    }

    /**
     * 解析群聊多 Bot 场景下当前应使用的 Profile（SubTask 2.5）
     *
     * 优先级：
     *   1. 群聊 + botProfileMap 中有 selfBotId 对应的 Profile
     *   2. 群聊 + botProfileMap 仅一个绑定，使用该绑定
     *   3. session.profile（默认）
     *
     * @private
     */
    _resolveProfile(ctx, session) {
        const botMap = session.botProfileMap || {};
        const botIds = Object.keys(botMap);

        // 群聊且有多 Bot 绑定
        if (ctx.chatType === 'group' && botIds.length > 0) {
            // 优先用配置的 selfBotId
            const selfBotId = this.getConfig('selfBotId') || session.selfBotId || '';
            if (selfBotId && botMap[selfBotId]) {
                return botMap[selfBotId];
            }
            // 仅有唯一绑定时直接用
            if (botIds.length === 1) {
                return botMap[botIds[0]];
            }
            // 多个绑定时，若 session.profile 在 map 中则用它，否则用第一个
            if (session.profile && botMap[botIds.find(id => botMap[id] === session.profile)] === session.profile) {
                return session.profile;
            }
            return botMap[botIds[0]];
        }

        // 非群聊或无绑定：用 session.profile
        return session.profile || '';
    }

    /**
     * 检测 ctx.agent 是否可用（agent-framework 已加载 + 本插件有 agent 权限 + run 方法存在）
     * @private
     */
    _isAgentAvailable(ctx) {
        try {
            // ctx.agent getter 在无 agent 权限时抛错；deniedStub 无 run 方法
            return !!(ctx.agent && typeof ctx.agent.run === 'function');
        } catch (e) {
            return false;
        }
    }

    /**
     * 探测默认 Profile：优先用 agent-framework 的 isDefault 标记。
     * SubTask 6.4/6.5：若 agentLoader 中存在 isDefault: true 的 Agent，自动选用。
     * @private
     */
    _detectDefaultProfile(ctx) {
        try {
            // 通过 ctx.agent.getStatus 拿不到 profile 列表，直接访问 agent-framework 插件实例
            const af = this._getAgentFrameworkPlugin();
            if (af?.agentLoader?.getDefaultName) {
                const name = af.agentLoader.getDefaultName();
                if (name) return name;
            }
            return this.getConfig('defaultProfile') || '';
        } catch (e) {
            return this.getConfig('defaultProfile') || '';
        }
    }

    /**
     * 判断指定 profile 是否为 agent-framework 中标记 isDefault 的 Agent。
     * @private
     */
    _isDefaultProfile(ctx, profileName) {
        try {
            const af = this._getAgentFrameworkPlugin();
            if (!af?.agentLoader) return false;
            const def = af.agentLoader.getDefault();
            return !!def && def.name === profileName;
        } catch (e) {
            return false;
        }
    }

    /**
     * 获取 agent-framework 插件实例（供默认方案探测用）。
     * 通过 ctx._gateway 或 this._services.gateway 反查 pluginManager。
     * @private
     */
    _getAgentFrameworkPlugin() {
        try {
            // 优先从缓存的 this._afPlugin 取
            if (this._afPlugin) return this._afPlugin;
            // 通过 gateway 拿 pluginManager（agent-rp 声明了 gateway.inbound，但 _gateway 实例上有 loader）
            const gateway = this._services?.gateway;
            // 尝试常见路径：pluginManager.loader.getPlugin('agent-framework')._instance 或直接 instance
            const loader = gateway?.loader || this._services?.gateway?.pluginManager?.loader;
            if (loader?.getPlugin) {
                const entry = loader.getPlugin('agent-framework');
                if (entry?.instance) {
                    this._afPlugin = entry.instance;
                    return entry.instance;
                }
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    /**
     * 尝试读取角色卡（不抛错），用于 _cmdStart 识别用户参数是角色卡名还是 profile 名。
     * @private
     */
    _tryReadCharacter(ctx, name) {
        try {
            return ctx.assets?.readCharacter?.(name) || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * 首次启动引导：从 agent-framework 的 templates/defaults/ 复制默认记忆模板与文风
     * 到 agent-rp 的 memory/ 和 styles/ 目录（仅在目标文件不存在时复制）。
     * SubTask 6.2/6.3/6.5：保证 /rp start 无参数时零配置可用。
     * @private
     */
    _seedDefaultMemoryAndStyle() {
        const templatesRoot = path.resolve(__dirname, '..', 'agent-framework', 'templates', 'defaults');
        const memoryDst = path.join(DATA_DIR, 'memory');
        const stylesDst = path.join(DATA_DIR, 'styles');

        // 复制记忆模板（仅缺失项）
        const memoryFiles = ['project.md', 'reference.md', 'feedback.md', 'user.md', 'SUMMARY_RULES.md'];
        for (const fname of memoryFiles) {
            const src = path.join(templatesRoot, 'memory', fname);
            const dst = path.join(memoryDst, fname);
            if (!fs.existsSync(src)) continue;
            if (fs.existsSync(dst)) continue;
            try {
                fs.copyFileSync(src, dst);
                this.logger.info(`[agent-rp] 已播种默认记忆模板: memory/${fname}`);
            } catch (e) {
                this.logger.warn(`[agent-rp] 播种记忆模板 ${fname} 失败: ${e.message}`);
            }
        }

        // 复制默认文风 default.md
        const styleSrc = path.join(templatesRoot, 'styles', 'default.md');
        const styleDst = path.join(stylesDst, 'default.md');
        if (fs.existsSync(styleSrc) && !fs.existsSync(styleDst)) {
            try {
                fs.copyFileSync(styleSrc, styleDst);
                this.logger.info('[agent-rp] 已播种默认文风: styles/default.md');
            } catch (e) {
                this.logger.warn(`[agent-rp] 播种默认文风失败: ${e.message}`);
            }
        }
    }

    // ==================== IM 表现层适配器渲染（SubTask 2.2/2.3/2.4） ====================

    /**
     * IM 适配器渲染入口：消费 AgentRunResult，按 IM 平台特性渲染。
     *
     * 步骤：
     *   1. 正文分段发送（SubTask 2.2）
     *   2. 选项格式化为 >选项X： 文本（SubTask 2.3，option-splitter 自动转按钮）
     *   3. 实时状态图（SubTask 2.4，state.visible 渲染为状态卡片图片旁路发送）
     *
     * @param {import('../../server/agent/run-result.js').AgentRunResult} result
     * @param {object} ctx - 插件上下文
     */
    async _renderToIM(result, ctx) {
        if (!result) return;

        // 1. 正文分段发送（SubTask 2.2）
        const mainText = result.getMainText();
        if (mainText) {
            await this._sendParagraphs(ctx, mainText);
        }

        // 2. 选项格式化（SubTask 2.3）
        const options = result.options || [];
        if (options.length > 0) {
            await this._sendOptions(ctx, options);
        }

        // 3. 实时状态图（SubTask 2.4）
        const visibleState = result.state?.visible;
        const hasVisibleState = visibleState && Object.keys(visibleState).length > 0;
        if (hasVisibleState) {
            await this._sendStateCard(ctx, visibleState, result);
        }

        // 兜底：正文和选项和状态都为空时，发一条提示
        if (!mainText && options.length === 0 && !hasVisibleState) {
            await this._replyRp(ctx, '（本轮无可见输出）');
        }
    }

    /**
     * 正文按段落切分逐条发送（SubTask 2.2）
     *
     * 切分策略：
     *   - 优先按双换行（段落）切分
     *   - 单段超过 PARAGRAPH_MAX_LEN 时尝试按单换行二次切分
     *   - 段间轻微延迟（200ms），避免平台限流
     *
     * @param {object} ctx
     * @param {string} text - 正文全文
     */
    async _sendParagraphs(ctx, text) {
        const paragraphs = this._splitParagraphs(text);
        for (let i = 0; i < paragraphs.length; i++) {
            if (i > 0) await this._delay(200);
            await this._replyRp(ctx, paragraphs[i]);
        }
    }

    /**
     * 段落切分（供测试）
     * @param {string} text
     * @returns {string[]}
     */
    _splitParagraphs(text) {
        if (!text) return [];
        // 先按双换行切段
        let parts = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);

        // 单段过长时按单换行二次切分
        const result = [];
        for (const p of parts) {
            if (p.length <= PARAGRAPH_MAX_LEN) {
                result.push(p);
                continue;
            }
            const subParts = p.split(/\n/).map(s => s.trim()).filter(Boolean);
            let buf = '';
            for (const sp of subParts) {
                if (buf && (buf + '\n' + sp).length > PARAGRAPH_MAX_LEN) {
                    result.push(buf);
                    buf = sp;
                } else {
                    buf = buf ? `${buf}\n${sp}` : sp;
                }
            }
            if (buf) result.push(buf);
        }
        return result.length > 0 ? result : [text];
    }

    /**
     * 选项格式化发送（SubTask 2.3）
     *
     * 复用 option-splitter 的 >选项X： 格式约定（OPTION_LINE_REGEX）。
     * option-splitter 的出站过滤器会自动把 >选项X： 渲染为平台原生按钮/引用/菜单。
     *
     * 选项作为正文最后一条消息发送（在所有段落之后）。
     *
     * @param {object} ctx
     * @param {Array<{label?,text?,callbackId?}>} options
     */
    async _sendOptions(ctx, options) {
        if (!options || options.length === 0) return;

        // 用 option-splitter 约定的 <options> 标签块包裹
        // 这样 option-splitter 的 batch/sequential 模式都能正确识别
        const lines = [];
        for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            // 序号：优先用 label，否则用中文数字
            const idx = opt.label || this._toChineseNum(i + 1);
            const text = opt.text || '';
            lines.push(`>选项${idx}：${text}`);
        }

        await this._delay(300);
        await this._replyRp(ctx, lines.join('\n'));
    }

    /**
     * 数字转中文（一/二/三...十），>10 时用阿拉伯数字
     * @param {number} n
     * @returns {string}
     */
    _toChineseNum(n) {
        const map = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
        if (n >= 1 && n <= 10) return map[n - 1];
        return String(n);
    }

    /**
     * 实时状态图渲染（SubTask 2.4）
     *
     * 从 result.state.visible 渲染状态卡片为图片，旁路发送。
     * 复用 message-to-image 的 ImageRenderer（直接 import renderer.js）。
     *
     * 状态卡片内容：当前时间/地点/在场角色/各角色状态（从 state.visible 提取）
     *
     * 如果 message-to-image 不可用（puppeteer 未装/Chrome 未找到），降级为文本状态卡。
     *
     * @param {object} ctx
     * @param {object} visibleState - result.state.visible
     * @param {import('../../server/agent/run-result.js').AgentRunResult} result
     */
    async _sendStateCard(ctx, visibleState, result) {
        // 构建状态卡片文本（降级用）和 HTML（优先用）
        const stateText = this._formatStateText(visibleState);
        const stateHtml = this._buildStateCardHtml(visibleState, result);

        // 尝试渲染为图片
        let imageUrl = null;
        try {
            imageUrl = await this._renderStateImage(stateHtml);
        } catch (e) {
            this.logger.warn(`[agent-rp] 状态图渲染失败，降级文本: ${e.message}`);
            imageUrl = null;
        }

        if (imageUrl) {
            // 图片旁路发送：通过 ctx.reply 带 mediaUrls
            // 平台适配器会自动把 file:// URI 或本地路径转为平台图片消息
            const mediaRef = this._toMediaRef(imageUrl, ctx.platform);
            await this._delay(300);
            await this._replyRp(ctx, '📊 状态卡', { mediaUrls: [mediaRef] });
        } else {
            // 降级：发文本状态卡
            await this._delay(300);
            await this._replyRp(ctx, `📊 状态卡\n${stateText}`);
        }
    }

    /**
     * 把 visible state 格式化为纯文本（降级用）
     * @param {object} state
     * @returns {string}
     */
    _formatStateText(state) {
        const lines = [];
        if (state.time) lines.push(`⏰ 时间：${state.time}`);
        if (state.location) lines.push(`📍 地点：${state.location}`);
        if (state.scene) lines.push(`🎬 场景：${state.scene}`);

        const characters = state.characters || state.actors || [];
        if (Array.isArray(characters) && characters.length > 0) {
            lines.push('👥 在场角色：');
            for (const c of characters) {
                if (typeof c === 'string') {
                    lines.push(`  - ${c}`);
                } else {
                    const name = c.name || c.id || '未知';
                    const status = c.status || c.state || '';
                    const mood = c.mood || c.emotion || '';
                    const parts = [name];
                    if (status) parts.push(`状态:${status}`);
                    if (mood) parts.push(`心情:${mood}`);
                    lines.push(`  - ${parts.join(' / ')}`);
                }
            }
        }

        // 其它字段（非保留字段的兜底展示）
        const reserved = new Set(['time', 'location', 'scene', 'characters', 'actors']);
        for (const [k, v] of Object.entries(state)) {
            if (reserved.has(k)) continue;
            if (v == null || v === '') continue;
            const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
            lines.push(`  ${k}: ${valStr}`);
        }

        return lines.length > 0 ? lines.join('\n') : '（无可见状态）';
    }

    /**
     * 构建状态卡片 HTML（供 ImageRenderer 渲染）
     * @param {object} state
     * @param {import('../../server/agent/run-result.js').AgentRunResult} result
     * @returns {string}
     */
    _buildStateCardHtml(state, result) {
        const escape = (s) => String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        const sections = [];

        // 头部：场景信息
        const headerParts = [];
        if (state.time) headerParts.push(`⏰ ${escape(state.time)}`);
        if (state.location) headerParts.push(`📍 ${escape(state.location)}`);
        if (state.scene) headerParts.push(`🎬 ${escape(state.scene)}`);
        if (headerParts.length > 0) {
            sections.push(`<div class="state-header">${headerParts.join(' ｜ ')}</div>`);
        }

        // 角色列表
        const characters = state.characters || state.actors || [];
        if (Array.isArray(characters) && characters.length > 0) {
            const items = characters.map(c => {
                if (typeof c === 'string') {
                    return `<div class="char-item"><span class="char-name">${escape(c)}</span></div>`;
                }
                const name = escape(c.name || c.id || '未知');
                const status = c.status || c.state || '';
                const mood = c.mood || c.emotion || '';
                const detailParts = [];
                if (status) detailParts.push(`<span class="char-status">状态:${escape(status)}</span>`);
                if (mood) detailParts.push(`<span class="char-mood">心情:${escape(mood)}</span>`);
                return `<div class="char-item"><span class="char-name">${name}</span>${detailParts.join(' ')}</div>`;
            }).join('');
            sections.push(`<div class="char-list"><div class="section-title">👥 在场角色</div>${items}</div>`);
        }

        // 其它字段
        const reserved = new Set(['time', 'location', 'scene', 'characters', 'actors']);
        const extraLines = [];
        for (const [k, v] of Object.entries(state)) {
            if (reserved.has(k)) continue;
            if (v == null || v === '') continue;
            const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
            extraLines.push(`<div class="extra-item"><span class="extra-key">${escape(k)}</span>: <span class="extra-val">${escape(valStr)}</span></div>`);
        }
        if (extraLines.length > 0) {
            sections.push(`<div class="extra-list">${extraLines.join('')}</div>`);
        }

        // 轮次信息
        const turn = result?.meta?.turn || 0;
        const style = result?.meta?.style || '';

        return `<div class="render-root state-card">
<div class="card-title">📊 状态卡</div>
${sections.join('')}
<div class="card-footer">轮次 ${turn}${style ? ' ｜ 文风:' + escape(style) : ''}</div>
</div>`;
    }

    /**
     * 调用 ImageRenderer 渲染 HTML 为图片，返回 file:// URL。
     *
     * 懒加载渲染器实例（复用 message-to-image/renderer.js 的 ImageRenderer 类）。
     * 初始化失败后标记 _stateRendererInitFailed，避免每次都重试。
     *
     * @param {string} html - 已转义的 HTML 片段（含 .render-root）
     * @returns {Promise<string|null>} file:// URL 或 null（不可用时）
     */
    async _renderStateImage(html) {
        if (this._stateRendererInitFailed) return null;

        const renderer = await this._getStateRenderer();
        if (!renderer) {
            this._stateRendererInitFailed = true;
            return null;
        }

        const css = `
            .state-card {
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.3);
                color: #e0e0e0;
                padding: 20px;
                width: 760px;
            }
            .card-title {
                font-size: 18px;
                font-weight: bold;
                color: #a0c8ff;
                margin-bottom: 16px;
                padding-bottom: 12px;
                border-bottom: 2px solid rgba(100,150,255,0.3);
            }
            .state-header {
                font-size: 15px;
                color: #c0c0c0;
                margin-bottom: 16px;
                padding: 8px 12px;
                background: rgba(255,255,255,0.05);
                border-radius: 8px;
            }
            .section-title {
                font-size: 14px;
                font-weight: bold;
                color: #a0c8ff;
                margin-bottom: 8px;
            }
            .char-list { margin-bottom: 16px; }
            .char-item {
                font-size: 14px;
                padding: 6px 12px;
                margin: 4px 0;
                background: rgba(255,255,255,0.03);
                border-radius: 6px;
                border-left: 3px solid rgba(100,150,255,0.5);
            }
            .char-name { font-weight: bold; color: #f0f0f0; margin-right: 12px; }
            .char-status { color: #88cc88; margin-right: 8px; font-size: 13px; }
            .char-mood { color: #ffaa88; font-size: 13px; }
            .extra-list { margin-bottom: 12px; }
            .extra-item { font-size: 13px; padding: 4px 12px; color: #b0b0b0; }
            .extra-key { color: #88aacc; }
            .extra-val { color: #d0d0d0; }
            .card-footer {
                font-size: 12px;
                color: #888;
                margin-top: 16px;
                padding-top: 12px;
                border-top: 1px solid rgba(255,255,255,0.1);
                text-align: right;
            }
        `;

        const template = { preset: '', html };
        return await renderer.render('', css, template, [], {});
    }

    /**
     * 懒加载状态图渲染器（复用 message-to-image 的 ImageRenderer）
     * @returns {Promise<object|null>}
     */
    async _getStateRenderer() {
        if (this._stateRenderer) return this._stateRenderer;
        if (this._stateRendererInitFailed) return null;

        try {
            const { ImageRenderer } = await import('../message-to-image/renderer.js');
            const cacheDir = path.join(DATA_DIR, 'state-card-cache');
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }
            this._stateRenderer = new ImageRenderer({
                cacheDir,
                maxWidth: 800,
                imageFormat: 'png',
                maxConcurrent: 1,
                pagePoolSize: 1,
                logger: this.logger,
            });
            await this._stateRenderer.init();
            this.logger.info('[agent-rp] 状态图渲染器已就绪');
            return this._stateRenderer;
        } catch (e) {
            this.logger.warn(`[agent-rp] 状态图渲染器不可用（puppeteer/Chrome 缺失或 message-to-image 未安装）: ${e.message}`);
            this._stateRendererInitFailed = true;
            return null;
        }
    }

    /**
     * 把 file:// URI 转成平台适配器能消费的媒体引用。
     * 复用 message-to-image 的 toMediaRef 逻辑：QQ 保留 file://，其它平台转裸路径。
     * @param {string} fileUrl
     * @param {string} platform
     * @returns {string}
     */
    _toMediaRef(fileUrl, platform) {
        if (platform === 'qq') return fileUrl;
        try {
            return fileURLToPath(fileUrl);
        } catch (_) {
            return fileUrl;
        }
    }

    // ==================== 自动摘要 ====================

    /**
     * 自动生成剧情摘要：把最近几轮对话发给 LLM，生成简短的剧情进度摘要
     * 写入 memory/project.md 供下一轮 prompt 注入
     */
    async _generateSummary(ctx) {
        try {
            const history = ctx.getHistory(20);
            if (history.length === 0) return;

            const dialogText = history
                .filter(h => h.role === 'user' || h.role === 'assistant')
                .map(h => `${h.role === 'user' ? '用户' : 'AI'}: ${h.content.slice(0, 500)}`)
                .join('\n');

            const summaryMessages = [
                {
                    role: 'system',
                    content: '你是一个剧情摘要助手。请根据以下对话记录，生成一份简短的剧情进度摘要（不超过300字），包含：当前剧情进展、关键事件、角色关系变化、下一阶段可能的方向。只输出摘要内容，不要加标题或其他说明。',
                },
                { role: 'user', content: dialogText },
            ];

            const summary = await ctx.llm.chat(summaryMessages, {
                temperature: 0.3,
                max_tokens: 512,
            });

            if (summary && summary.trim()) {
                ctx.fs.write('memory/project.md', summary.trim());
                this.logger.info('剧情摘要已自动更新');
            }
        } catch (e) {
            this.logger.warn(`自动摘要失败: ${e.message}`);
        }
    }

    // ==================== Prompt 组装（兜底模式用） ====================

    /**
     * 组装 LLM 消息数组：system prompt + 历史消息 + 当前用户消息
     * 仅在兜底模式（chatStream）下使用。
     * @param {PluginContext} ctx
     * @param {object} session - RP 会话状态
     * @param {string} userMessage - 当前用户消息
     * @returns {Promise<Array<{role: string, content: string}>>}
     */
    async _buildPrompt(ctx, session, userMessage) {
        const parts = [];

        const viewMode = session.viewMode || this.getConfig('defaultViewMode') || 'actor';
        parts.push(VIEW_MODE_INSTRUCTIONS[viewMode] || VIEW_MODE_INSTRUCTIONS.actor);

        let characterCard = null;
        if (session.character) {
            try {
                characterCard = ctx.assets.readCharacter(session.character);
            } catch (e) {
                this.logger.warn(`读取角色卡「${session.character}」失败: ${e.message}`);
            }
        }

        if (characterCard) {
            if (characterCard.description) parts.push(`【角色描述】\n${characterCard.description}`);
            if (characterCard.personality) parts.push(`【角色性格】\n${characterCard.personality}`);
            if (characterCard.scenario) parts.push(`【场景设定】\n${characterCard.scenario}`);
            if (characterCard.mes_example) parts.push(`【对话示例】\n${characterCard.mes_example}`);
        } else {
            parts.push(DEFAULT_SYSTEM_PROMPT);
        }

        const worldbookText = this._extractWorldbook(ctx, characterCard);
        if (worldbookText) {
            parts.push(`【世界设定】\n${worldbookText}`);
        }

        if (session.style) {
            try {
                const styleContent = ctx.fs.read(`styles/${session.style}.md`);
                if (styleContent) parts.push(`【文风要求】\n${styleContent}`);
            } catch (e) {
                this.logger.warn(`读取文风「${session.style}」失败: ${e.message}`);
            }
        }

        const memoryText = this._readMemory(ctx);
        if (memoryText) parts.push(memoryText);

        const skillText = this._readSkills(ctx, session);
        if (skillText) parts.push(skillText);

        const template = this.getConfig('systemPromptTemplate');
        if (template) parts.push(template);

        const messages = [{ role: 'system', content: parts.join('\n\n') }];

        const historyLimit = this.getConfig('historyLimit') ?? 20;
        if (historyLimit > 0) {
            const history = ctx.getHistory(historyLimit * 2);
            for (const h of history) {
                if (h.role === 'user' || h.role === 'assistant') {
                    messages.push({ role: h.role, content: h.content });
                }
            }
        }

        messages.push({ role: 'user', content: userMessage });

        return messages;
    }

    /**
     * 从角色卡内嵌世界书或关联世界书文件中提取条目（简化：全量注入）
     */
    _extractWorldbook(ctx, characterCard) {
        try {
            if (characterCard?.character_book?.entries) {
                const entries = characterCard.character_book.entries;
                const entryList = Array.isArray(entries) ? entries : Object.values(entries);
                const text = entryList
                    .map(e => e.content || e.comment || '')
                    .filter(Boolean)
                    .join('\n');
                if (text) return text;
            }

            const worldName = characterCard?.world || '';
            if (worldName) {
                const wb = ctx.assets.readWorldbook(worldName);
                if (wb?.entries) {
                    const entryList = Array.isArray(wb.entries) ? wb.entries : Object.values(wb.entries);
                    return entryList
                        .map(e => e.content || e.comment || '')
                        .filter(Boolean)
                        .join('\n');
                }
            }
        } catch (e) {
            this.logger.warn(`读取世界书失败: ${e.message}`);
        }
        return '';
    }

    /**
     * 读取四层记忆并组装为 prompt 片段
     */
    _readMemory(ctx) {
        const parts = [];
        try {
            if (ctx.fs.exists('memory/project.md')) {
                const project = ctx.fs.read('memory/project.md').trim();
                if (project) parts.push(`【剧情记忆】\n${project}`);
            }
            if (ctx.fs.exists('memory/reference.md')) {
                const ref = ctx.fs.read('memory/reference.md').trim();
                if (ref) parts.push(`【参考信息】\n${ref}`);
            }
            if (ctx.fs.exists('memory/feedback.md')) {
                const fb = ctx.fs.read('memory/feedback.md').trim();
                if (fb) parts.push(`【用户偏好】\n${fb}`);
            }
            if (ctx.fs.exists('memory/user.md')) {
                const user = ctx.fs.read('memory/user.md').trim();
                if (user) parts.push(`【用户设定】\n${user}`);
            }
        } catch (e) {
            this.logger.warn(`读取记忆文件失败: ${e.message}`);
        }
        return parts.join('\n\n');
    }

    /**
     * 读取已加载的 skill 文件并组装为 prompt 片段
     */
    _readSkills(ctx, session) {
        const loaded = session.loadedSkills || [];
        if (loaded.length === 0) return '';
        const parts = [];
        for (const name of loaded) {
            try {
                const skillPath = `skills/${name}.md`;
                if (ctx.fs.exists(skillPath)) {
                    const content = ctx.fs.read(skillPath).trim();
                    if (content) parts.push(content);
                }
            } catch (e) {
                this.logger.warn(`读取 skill「${name}」失败: ${e.message}`);
            }
        }
        if (parts.length === 0) return '';
        return `【加载的技能】\n${parts.join('\n\n---\n\n')}`;
    }

    // ==================== 选项提取（兜底模式用） ====================

    /**
     * 从 AI 回复中提取 >选项X： 格式的选项，返回正文和选项列表
     * 仅在兜底模式（chatStream）下使用；引擎模式的选项来自 result.options。
     * @param {string} text - AI 回复全文
     * @returns {{mainText: string, options: Array<{index: string, content: string, raw: string}>}}
     */
    _extractOptions(text) {
        if (!text) return { mainText: '', options: [] };

        const options = [];
        const extractRegex = new RegExp(OPTION_LINE_REGEX.source, 'gm');
        let m;
        let idx = 0;
        while ((m = extractRegex.exec(text)) !== null) {
            if (m.index === extractRegex.lastIndex) {
                extractRegex.lastIndex++;
                continue;
            }
            options.push({
                index: m[1] || String(++idx),
                content: m[2].trim(),
                raw: m[0].trim(),
            });
        }

        const stripRegex = new RegExp(OPTION_LINE_REGEX.source, 'gm');
        const mainText = text.replace(stripRegex, '').replace(/\n{3,}/g, '\n\n').trim();

        return { mainText, options };
    }

    // ==================== 会话状态管理 ====================

    /**
     * 生成会话文件名键（文件系统安全）
     */
    _getSessionKey(platform, chatId) {
        return `${platform}_${chatId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    /**
     * 默认会话状态
     */
    _defaultSession() {
        return {
            active: false,
            // 引擎模式
            profile: this.getConfig('defaultProfile') || '',
            // 兜底模式
            character: this.getConfig('defaultCharacter') || '',
            // 共享
            viewMode: this.getConfig('defaultViewMode') || 'actor',
            style: this.getConfig('defaultStyle') || '',
            loadedSkills: [],
            turnCount: 0,
            startTime: 0,
            // 多 Bot 绑定（SubTask 2.5）
            botProfileMap: {},
        };
    }

    /**
     * 读取当前会话的 RP 状态
     */
    async _getSession(ctx) {
        const key = this._getSessionKey(ctx.platform, ctx.chatId);
        const filePath = `sessions/${key}.json`;
        try {
            if (ctx.fs.exists(filePath)) {
                const session = JSON.parse(ctx.fs.read(filePath));
                // 合并默认字段（兼容旧会话文件）
                return { ...this._defaultSession(), ...session };
            }
        } catch (e) {
            this.logger.warn(`读取会话状态失败: ${e.message}`);
        }
        return this._defaultSession();
    }

    /**
     * 保存当前会话的 RP 状态
     */
    async _saveSession(ctx, session) {
        const key = this._getSessionKey(ctx.platform, ctx.chatId);
        const filePath = `sessions/${key}.json`;
        try {
            ctx.fs.write(filePath, JSON.stringify(session, null, 2));
        } catch (e) {
            this.logger.error(`保存会话状态失败: ${e.message}`);
        }
    }

    // ==================== 工具方法 ====================

    _listStyles(ctx) {
        try {
            return ctx.fs.list('styles')
                .filter(f => f.endsWith('.md'))
                .map(f => f.replace(/\.md$/, ''));
        } catch (e) {
            return [];
        }
    }

    _listSkills(ctx) {
        try {
            return ctx.fs.list('skills')
                .filter(f => f.endsWith('.md'))
                .map(f => f.replace(/\.md$/, ''));
        } catch (e) {
            return [];
        }
    }

    /**
     * 发送 RP 回复（在出站消息 metadata 中设置 rpMode: true）
     * 使用 OutboundMessage 直接发送，以便携带 metadata 供 option-splitter 等插件识别。
     * @param {PluginContext} ctx
     * @param {string} text - 回复内容
     * @param {object} [options] - 额外选项 { mediaUrls? }
     */
    async _replyRp(ctx, text, options = {}) {
        const outbound = new OutboundMessage({
            platform: ctx.platform,
            chatId: ctx.chatId,
            chatType: ctx.chatType,
            content: text,
            replyToId: ctx.messageId || '',
            mediaUrls: options.mediaUrls || [],
            metadata: { rpMode: true },
        });
        ctx._gateway.sendMessage(outbound);
        ctx._handled = true;
    }

    /**
     * 延迟工具
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
