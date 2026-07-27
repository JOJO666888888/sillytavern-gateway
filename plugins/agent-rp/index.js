/**
 * Agent 角色扮演插件 (Phase 1 MVP)
 *
 * 通过 IM 平台直接进行 AI 角色扮演，不依赖 SillyTavern 前端。
 * 利用网关已有的 ctx.llm（LLM 调用）、ctx.fs（文件读写）、ctx.assets（ST 资产读取）能力。
 *
 * 命令：
 *   /rp start [角色卡名]          启动 RP 会话
 *   /rp stop                      结束 RP 会话
 *   /rp status                    查看当前 RP 状态
 *   /rp style [文风名]            切换/查看当前文风
 *   /rp mode [actor|director]     切换视角模式
 *   /rp character [名称]          切换角色卡
 *   /rp help                      显示帮助
 *
 * 工作流程：
 *   1. 用户 /rp start 启动会话，选择角色卡
 *   2. 会话激活后，用户发送的普通消息被监听器拦截
 *   3. 组装 prompt（视角指令 + 角色卡 + 世界书 + 文风 + 历史消息）
 *   4. 调用 ctx.llm.chatStream() 生成回复
 *   5. 提取选项（如有），先发正文再逐个发选项
 *   6. 写入会话历史，更新轮数
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

export default class AgentRPPlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'rp',
            alias: ['角色扮演'],
            handler: 'handleRp',
            description: 'AI 角色扮演会话',
            usage: '/rp <start|stop|status|style|mode|character|help>',
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
    }

    // ==================== 生命周期 ====================

    async onLoad() {
        // 确保 sessions/ 和 styles/ 目录存在
        // 注意：onLoad 中没有 ctx.fs，用原始 fs 模块创建目录
        try {
            fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true });
            fs.mkdirSync(path.join(DATA_DIR, 'styles'), { recursive: true });
            fs.mkdirSync(path.join(DATA_DIR, 'memory'), { recursive: true });
            fs.mkdirSync(path.join(DATA_DIR, 'skills'), { recursive: true });
        } catch (e) {
            this.logger.warn(`初始化目录失败: ${e.message}`);
        }

        // 注册入站过滤器（priority=50，在命令路由/监听器之前执行）
        // 入站过滤器没有 ctx，仅做轻量级 RP 状态检查和标记；
        // 实际拦截逻辑在 onMessage 监听器中处理（需要 ctx 访问 LLM/fs/assets）
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

        this.logger.info('Agent 角色扮演插件已加载');
    }

    async onUnload() {
        if (this._removeInbound) {
            this._removeInbound();
            this._removeInbound = null;
        }
    }

    // ==================== 入站过滤器 ====================

    /**
     * 入站过滤器：在命令路由/监听器之前检查 RP 模式状态。
     * 仅做标记，不拦截消息（返回 null 会完全丢弃消息，导致监听器也无法执行）。
     * 实际拦截逻辑在 onMessage 监听器中处理。
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
            // 标记消息，供监听器快速判断（监听器仍会独立验证会话状态）
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

    /**
     * /rp 命令路由
     */
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
            case 'skill':
            case '技能':
                return this._cmdSkill(ctx);
            case 'help':
            case '帮助':
            default:
                return this._cmdHelp(ctx);
        }
    }

    /** /rp start [角色卡名] - 启动 RP 会话 */
    async _cmdStart(ctx) {
        const session = await this._getSession(ctx);

        // 已激活则提示
        if (session.active) {
            return ctx.reply(
                `⚠️ RP 会话已在进行中（角色：${session.character || '无'}，${session.turnCount || 0} 轮）。\n` +
                `请先用 /rp stop 结束当前会话。`,
            );
        }

        // 确定角色卡名：命令参数 > 默认配置
        const charName = ctx.args.slice(1).join(' ').trim() || this.getConfig('defaultCharacter') || '';

        if (!charName) {
            // 未指定角色卡，列出可用角色卡
            const chars = ctx.assets.listCharacters();
            if (chars.length === 0) {
                // 无角色卡也可启动，使用默认 system prompt
                session.active = true;
                session.character = '';
                session.viewMode = this.getConfig('defaultViewMode') || 'actor';
                session.style = this.getConfig('defaultStyle') || '';
                session.turnCount = 0;
                session.startTime = Date.now();
                await this._saveSession(ctx, session);
                return ctx.reply('🎭 RP 会话已启动（无角色卡，使用默认模式）。\n发送消息即可开始角色扮演，/rp stop 结束。');
            }
            const list = chars.map(c => `  - ${c.replace(/\.(json|png)$/, '')}`).join('\n');
            return ctx.reply(`请指定角色卡：/rp start <角色卡名>\n\n可用角色卡：\n${list}`);
        }

        // 验证角色卡存在
        const card = ctx.assets.readCharacter(charName);
        if (!card) {
            return ctx.reply(`❌ 未找到角色卡「${charName}」。\n用 /rp character 查看可用角色卡。`);
        }

        // 启动会话
        session.active = true;
        session.character = charName;
        session.viewMode = this.getConfig('defaultViewMode') || 'actor';
        session.style = this.getConfig('defaultStyle') || '';
        session.turnCount = 0;
        session.startTime = Date.now();
        await this._saveSession(ctx, session);

        const displayName = card.name || charName;
        let reply =
            `🎭 RP 会话已启动！\n` +
            `  角色：${displayName}\n` +
            `  视角：${session.viewMode === 'director' ? '导演模式' : '扮演模式'}\n` +
            `  文风：${session.style || '默认'}`;

        // 如果角色卡有开场白，附加到回复
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
        const lines = [
            '📋 RP 会话状态',
            `  状态：${session.active ? '✅ 进行中' : '❌ 未启动'}`,
            `  角色：${session.character || '（无）'}`,
            `  视角：${session.viewMode === 'director' ? '导演模式' : '扮演模式'}`,
            `  文风：${session.style || '（默认）'}`,
            `  轮数：${session.turnCount || 0}`,
        ];
        if (session.active && session.startTime) {
            const elapsed = Math.round((Date.now() - session.startTime) / 60000);
            lines.push(`  时长：${elapsed} 分钟`);
        }
        return ctx.reply(lines.join('\n'));
    }

    /** /rp style [文风名] - 切换/查看当前文风 */
    async _cmdStyle(ctx) {
        const session = await this._getSession(ctx);
        const styleName = ctx.args.slice(1).join(' ').trim();

        if (!styleName) {
            // 查看当前文风和可用文风
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

        // 验证文风文件存在
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
            // 查看当前角色和可用角色
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

        // 验证角色卡存在
        const card = ctx.assets.readCharacter(charName);
        if (!card) {
            return ctx.reply(`❌ 未找到角色卡「${charName}」。`);
        }

        session.character = charName;
        await this._saveSession(ctx, session);
        const displayName = card.name || charName;
        return ctx.reply(`✅ 角色卡已切换为「${displayName}」`);
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

    /** /rp help - 显示帮助 */
    async _cmdHelp(ctx) {
        return ctx.reply(
            [
                '🎭 Agent 角色扮演 - 命令帮助',
                '',
                '/rp start [角色卡名]       - 启动 RP 会话（可指定角色卡）',
                '/rp stop                   - 结束 RP 会话',
                '/rp status                 - 查看当前 RP 状态',
                '/rp style [文风名]         - 切换/查看当前文风',
                '/rp mode [actor|director]  - 切换视角模式',
                '/rp character [名称]       - 切换角色卡',
                '/rp skill [list|load|unload|clear] - 管理 skill（知识/规则文件）',
                '/rp help                   - 显示本帮助',
                '',
                '💡 启动后直接发送消息即可进行角色扮演',
                '💡 actor=扮演视角（你控制主角），director=导演视角（AI 控制全部）',
            ].join('\n'),
        );
    }

    // ==================== 入站消息拦截（监听器） ====================

    /**
     * RP 模式消息拦截：当会话处于 RP 模式时，拦截用户消息，调用 LLM 生成回复。
     * 非命令消息且 RP 会话激活时触发。
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
            // 组装 LLM 消息
            const messages = await this._buildPrompt(ctx, session, content);

            const sampling = {
                temperature: this.getConfig('temperature') ?? 0.8,
                max_tokens: this.getConfig('maxTokens') ?? 2048,
            };

            // 流式调用 LLM（IM 平台不支持流式显示，收集完整回复后一次性发送）
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

                // 先发正文
                if (mainText) {
                    await this._replyRp(ctx, mainText);
                }

                // 再逐个发选项
                for (let i = 0; i < options.length; i++) {
                    await this._delay(i === 0 ? 300 : 600);
                    await this._replyRp(ctx, `选项${options[i].index}：${options[i].content}`);
                }

                // 正文和选项都为空时，发送原始回复（兜底）
                if (!mainText && options.length === 0) {
                    await this._replyRp(ctx, fullReply);
                }
            } else {
                // 不提取选项，直接发送完整回复（由 option-splitter 等插件处理）
                await this._replyRp(ctx, fullReply);
            }

            // 写入会话历史（供下一轮 RP 记忆）
            const sm = this._services.sessionManager;
            if (sm?.addMessage) {
                sm.addMessage(ctx.platform, ctx.chatId, { role: 'user', content, name: ctx.senderName });
                sm.addMessage(ctx.platform, ctx.chatId, { role: 'assistant', content: fullReply });
            }

            // 自动摘要：每 N 轮生成剧情摘要写入 memory/project.md
            const summaryInterval = this.getConfig('summaryInterval') ?? 10;
            if (summaryInterval > 0 && session.turnCount > 0 && (session.turnCount + 1) % summaryInterval === 0) {
                await this._generateSummary(ctx);
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
     * 自动生成剧情摘要：把最近几轮对话发给 LLM，生成简短的剧情进度摘要
     * 写入 memory/project.md 供下一轮 prompt 注入
     */
    async _generateSummary(ctx) {
        try {
            const history = ctx.getHistory(20); // 最近 20 条消息
            if (history.length === 0) return;

            // 构建摘要对话文本
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

    // ==================== Prompt 组装 ====================

    /**
     * 组装 LLM 消息数组：system prompt + 历史消息 + 当前用户消息
     * @param {PluginContext} ctx
     * @param {object} session - RP 会话状态
     * @param {string} userMessage - 当前用户消息
     * @returns {Promise<Array<{role: string, content: string}>>}
     */
    async _buildPrompt(ctx, session, userMessage) {
        const parts = [];

        // 1. 视角模式指令
        const viewMode = session.viewMode || this.getConfig('defaultViewMode') || 'actor';
        parts.push(VIEW_MODE_INSTRUCTIONS[viewMode] || VIEW_MODE_INSTRUCTIONS.actor);

        // 2. 角色卡：description / personality / scenario / mes_example
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
            // 角色卡为空或读取失败，使用通用 system prompt
            parts.push(DEFAULT_SYSTEM_PROMPT);
        }

        // 3. 世界书（简化处理：全量注入，不做关键词激活）
        const worldbookText = this._extractWorldbook(ctx, characterCard);
        if (worldbookText) {
            parts.push(`【世界设定】\n${worldbookText}`);
        }

        // 4. 文风（如有）
        if (session.style) {
            try {
                const styleContent = ctx.fs.read(`styles/${session.style}.md`);
                if (styleContent) parts.push(`【文风要求】\n${styleContent}`);
            } catch (e) {
                this.logger.warn(`读取文风「${session.style}」失败: ${e.message}`);
            }
        }

        // 5. 记忆系统注入
        const memoryText = this._readMemory(ctx);
        if (memoryText) parts.push(memoryText);

        // 6. 已加载的 skill
        const skillText = this._readSkills(ctx, session);
        if (skillText) parts.push(skillText);

        // 7. 自定义 system prompt 模板（如有）
        const template = this.getConfig('systemPromptTemplate');
        if (template) parts.push(template);

        // 组装消息数组
        const messages = [{ role: 'system', content: parts.join('\n\n') }];

        // 历史消息（带入最近 historyLimit 轮对话）
        const historyLimit = this.getConfig('historyLimit') ?? 20;
        if (historyLimit > 0) {
            const history = ctx.getHistory(historyLimit * 2); // 一轮 = 用户 + 助手两条
            for (const h of history) {
                if (h.role === 'user' || h.role === 'assistant') {
                    messages.push({ role: h.role, content: h.content });
                }
            }
        }

        // 当前用户消息
        messages.push({ role: 'user', content: userMessage });

        return messages;
    }

    /**
     * 从角色卡内嵌世界书或关联世界书文件中提取条目（简化：全量注入）
     * @param {PluginContext} ctx
     * @param {object|null} characterCard
     * @returns {string}
     */
    _extractWorldbook(ctx, characterCard) {
        try {
            // 优先：角色卡内嵌世界书（character_book 字段）
            if (characterCard?.character_book?.entries) {
                const entries = characterCard.character_book.entries;
                const entryList = Array.isArray(entries) ? entries : Object.values(entries);
                const text = entryList
                    .map(e => e.content || e.comment || '')
                    .filter(Boolean)
                    .join('\n');
                if (text) return text;
            }

            // 其次：角色卡 world 字段引用的外部世界书
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
            // project.md: 剧情进度（每轮注入）
            if (ctx.fs.exists('memory/project.md')) {
                const project = ctx.fs.read('memory/project.md').trim();
                if (project) parts.push(`【剧情记忆】\n${project}`);
            }
            // reference.md: 参考信息（按需注入）
            if (ctx.fs.exists('memory/reference.md')) {
                const ref = ctx.fs.read('memory/reference.md').trim();
                if (ref) parts.push(`【参考信息】\n${ref}`);
            }
            // feedback.md: 用户偏好（按需注入）
            if (ctx.fs.exists('memory/feedback.md')) {
                const fb = ctx.fs.read('memory/feedback.md').trim();
                if (fb) parts.push(`【用户偏好】\n${fb}`);
            }
            // user.md: 用户设定（按需注入）
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

    // ==================== 选项提取 ====================

    /**
     * 从 AI 回复中提取 >选项X： 格式的选项，返回正文和选项列表
     * @param {string} text - AI 回复全文
     * @returns {{mainText: string, options: Array<{index: string, content: string, raw: string}>}}
     */
    _extractOptions(text) {
        if (!text) return { mainText: '', options: [] };

        const options = [];
        // 用新正则实例提取（避免 lastIndex 互相干扰）
        const extractRegex = new RegExp(OPTION_LINE_REGEX.source, 'gm');
        let m;
        let idx = 0;
        while ((m = extractRegex.exec(text)) !== null) {
            // 防御零长匹配死循环
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

        // 从正文中移除选项行（用新正则实例）
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
            character: this.getConfig('defaultCharacter') || '',
            viewMode: this.getConfig('defaultViewMode') || 'actor',
            style: this.getConfig('defaultStyle') || '',
            loadedSkills: [],
            turnCount: 0,
            startTime: 0,
        };
    }

    /**
     * 读取当前会话的 RP 状态
     * @param {PluginContext} ctx
     * @returns {Promise<object>}
     */
    async _getSession(ctx) {
        const key = this._getSessionKey(ctx.platform, ctx.chatId);
        const filePath = `sessions/${key}.json`;
        try {
            if (ctx.fs.exists(filePath)) {
                return JSON.parse(ctx.fs.read(filePath));
            }
        } catch (e) {
            this.logger.warn(`读取会话状态失败: ${e.message}`);
        }
        return this._defaultSession();
    }

    /**
     * 保存当前会话的 RP 状态
     * @param {PluginContext} ctx
     * @param {object} session
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

    /**
     * 列出可用文风文件名（不含 .md 后缀）
     */
    _listStyles(ctx) {
        try {
            return ctx.fs.list('styles')
                .filter(f => f.endsWith('.md'))
                .map(f => f.replace(/\.md$/, ''));
        } catch (e) {
            return [];
        }
    }

    /**
     * 列出可用 skill 文件名（不含 .md 后缀）
     */
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
     */
    async _replyRp(ctx, text) {
        const outbound = new OutboundMessage({
            platform: ctx.platform,
            chatId: ctx.chatId,
            chatType: ctx.chatType,
            content: text,
            replyToId: ctx.messageId || '',
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
