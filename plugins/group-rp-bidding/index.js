/**
 * GroupRPBiddingPlugin - 趣味群聊抢答 RP 插件
 *
 * 游戏循环：
 *   A. AI 叙述剧情 -> 出站过滤器检测结束标记
 *   B. 检测到标记 -> 开启抢答窗口（限时）
 *   C. 群成员抢答 -> 第一个有效抢答者胜出
 *   D. 胜者内容自动转发给 SillyTavern -> AI 生成下一轮剧情
 *
 * 状态机（每个群独立）：
 *   idle    -> 等待 AI 叙述 / 抢答未开启
 *   bidding -> 抢答窗口已开启，等待玩家输入
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';
import { InboundMessage, OutboundMessage } from '../../server/adapters/base-adapter.js';

export default class GroupRPBiddingPlugin extends GatewayPlugin {
    // ==================== 静态注册表 ====================

    /** 命令注册：/bid /skip /status /reset 及中文别名 */
    static commands = [
        {
            name: 'bid',
            alias: ['抢答'],
            handler: 'handleBid',
            description: '抢答：提交你的行动内容来推进剧情',
            usage: '/bid <你的行动内容>  或  /抢答 <内容>',
        },
        {
            name: 'skip',
            alias: ['跳过'],
            handler: 'handleSkip',
            description: '跳过当前抢答轮次（通常在超时后使用）',
            usage: '/skip  或  /跳过',
        },
        {
            name: 'bstatus',
            alias: ['抢答状态'],
            handler: 'handleStatus',
            description: '查看当前群的抢答状态',
            usage: '/bstatus  或  /抢答状态',
        },
        {
            name: 'breset',
            alias: ['抢答重置'],
            handler: 'handleReset',
            description: '强制重置当前群的抢答状态（用于卡死恢复）',
            usage: '/breset  或  /抢答重置',
        },
    ];

    /** 监听器：仅监听群聊消息，priority=10 确保在抢答阶段优先拦截 */
    static listeners = [
        {
            event: 'message',
            filter: { chatType: 'group' },
            handler: 'onGroupMessage',
            priority: 10,
        },
    ];

    // ==================== 构造函数 ====================

    constructor(options) {
        super(options);
        this._removeFilter = null;     // 出站过滤器注销函数
        this._states = new Map();      // 运行时状态: Map<platform:chatId, StateObject>
    }

    // ==================== 生命周期 ====================

    async onLoad() {
        this._ensureDefaults();

        // 注册出站过滤器（priority=8，在其他过滤器之前检测结束标记）
        const gateway = this._services.gateway;
        if (gateway && gateway.addOutboundFilter) {
            this._removeFilter = gateway.addOutboundFilter(
                (msg) => this.filterOutbound(msg),
                { name: 'group-rp-bidding', priority: 8 }
            );
            this.logger.info('出站过滤器已注册');
        } else {
            this.logger.warn('网关不支持出站过滤器，插件无法正常工作');
        }

        this.logger.info('趣味群聊抢答RP插件已加载');
    }

    async onUnload() {
        // 注销出站过滤器
        if (this._removeFilter) {
            this._removeFilter();
            this._removeFilter = null;
        }

        // 清理所有群的定时器，防止内存泄漏
        for (const [key, state] of this._states) {
            if (state.timer) {
                clearTimeout(state.timer);
                state.timer = null;
            }
        }
        this._states.clear();

        this.logger.info('趣味群聊抢答RP插件已卸载');
    }

    /**
     * 初始化配置默认值
     * boolean 类型用 === undefined 判断，避免覆盖用户显式设置的 false
     */
    _ensureDefaults() {
        if (this.getConfig('endMarker') === undefined) {
            this.setConfig('endMarker', '【本轮结束】');
        }
        if (this.getConfig('bidTimeout') === undefined) {
            this.setConfig('bidTimeout', 30);
        }
        if (this.getConfig('implicitBid') === undefined) {
            this.setConfig('implicitBid', true);
        }
    }

    // ==================== 出站过滤器：检测结束标记 + 开启抢答 ====================

    /**
     * 出站消息过滤器
     *
     * 职责：
     *   1. 检测 AI 回复中是否包含结束标记
     *   2. 若包含且为群聊消息：剥离标记、追加抢答公告、开启抢答窗口
     *   3. 若为私聊：仅剥离标记（不开启抢答）
     *
     * ⚠️ 严禁在此方法中调用 ctx.send / ctx.reply，否则触发无限循环
     *    仅做内容修改和状态标记，消息发送交给正常出站流程
     *
     * @param {OutboundMessage} message
     * @returns {OutboundMessage|null}
     */
    filterOutbound(message) {
        if (!message || !message.content) return message;

        const marker = this.getConfig('endMarker') || '【本轮结束】';

        // 不含结束标记，原样放行
        if (!message.content.includes(marker)) {
            return message;
        }

        // 剥离结束标记（全局替换，防止 AI 输出多个）
        let content = message.content.split(marker).join('').trim();

        // 仅群聊开启抢答
        if (message.chatType === 'group') {
            const sessionKey = this._sessionKey(message.platform, message.chatId);

            // 开启抢答窗口（原子操作：同步设置状态 + 启动定时器）
            this._openBidding(sessionKey, message.platform, message.chatId);

            const timeout = this.getConfig('bidTimeout') || 30;
            const implicitHint = this.getConfig('implicitBid') !== false
                ? '直接发送你的行动，或使用 /bid <内容> 抢答'
                : '使用 /bid <内容> 抢答';

            // 追加抢答公告到消息末尾（不单独发消息，避免循环风险）
            content += `\n\n🎮 ━━ 抢答开始 ━━\n⏱️ ${timeout}秒内 ${implicitHint}\n最快抢答的玩家将推进剧情！`;

            this.logger.info(`[${sessionKey}] 抢答窗口已开启 (${timeout}s)`);
        }

        message.content = content;
        return message;
    }

    /**
     * 开启抢答窗口（同步操作，确保原子性）
     */
    _openBidding(sessionKey, platform, chatId) {
        // 若已有旧状态，先清理其定时器
        const oldState = this._states.get(sessionKey);
        if (oldState && oldState.timer) {
            clearTimeout(oldState.timer);
        }

        const timeout = (this.getConfig('bidTimeout') || 30) * 1000;

        const state = {
            phase: 'bidding',
            deadline: Date.now() + timeout,
            winner: null,
            timer: null,
            platform: platform,   // 存储平台信息供超时回调使用
            chatId: chatId,
        };

        // 启动超时定时器
        state.timer = setTimeout(() => {
            this._onBidTimeout(sessionKey);
        }, timeout);

        this._states.set(sessionKey, state);
    }

    /**
     * 抢答超时处理（由定时器触发）
     */
    _onBidTimeout(sessionKey) {
        const state = this._states.get(sessionKey);
        if (!state || state.phase !== 'bidding') return;

        // 重置状态
        state.phase = 'idle';
        state.winner = null;
        state.timer = null;

        this.logger.info(`[${sessionKey}] 抢答超时，无人应答`);

        // 向群内发送超时提示（通过正常出站流程，不经过过滤器循环）
        // 使用 sendMessage 进入消息队列，安全发送
        try {
            const msg = new OutboundMessage({
                platform: state.platform,
                chatId: state.chatId,
                chatType: 'group',
                content: '⏰ 抢答超时，无人应答。\n使用 /skip 跳过本轮，或等待下一次剧情触发。',
            });
            this._services.gateway.sendMessage(msg);
        } catch (error) {
            this.logger.error(`超时通知发送失败: ${error.message}`);
        }
    }

    // ==================== 入站监听器：处理隐式抢答 ====================

    /**
     * 群消息监听器
     *
     * 职责：
     *   - 抢答阶段（bidding）且 implicitBid=true 时，将非命令的群消息视为隐式抢答
     *   - 调用 stopPropagation 阻止消息流入 SillyTavern（胜者内容由插件主动转发）
     *   - 非抢答阶段不干预，消息正常流转
     *
     * @param {PluginContext} ctx
     */
    async onGroupMessage(ctx) {
        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);
        const state = this._states.get(sessionKey);

        // 非抢答阶段：放行，不影响正常对话
        if (!state || state.phase !== 'bidding') {
            return;
        }

        // 已有胜者（理论上不会走到这里，因为状态会立即切回idle，但做防御性检查）
        if (state.winner) {
            return;
        }

        // 命令消息（以/开头）交给命令系统处理，不视为隐式抢答
        if (ctx.content && ctx.content.startsWith('/')) {
            return;
        }

        // implicitBid=false 时，不处理隐式抢答，让消息正常流转
        if (this.getConfig('implicitBid') === false) {
            return;
        }

        // 内容为空（纯图片等），不作为有效抢答
        const bidContent = (ctx.content || '').trim();
        if (!bidContent) {
            return;
        }

        // === 隐式抢答 ===
        // stopPropagation 必须在 _processBid 之前调用，
        // 确保即使 _processBid 内部异步操作出错，消息也不会泄漏到 ST
        ctx.stopPropagation();

        await this._processBid(ctx, bidContent);
    }

    // ==================== 命令处理器 ====================

    /**
     * /bid <内容> - 显式抢答
     */
    async handleBid(ctx) {
        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);
        const state = this._states.get(sessionKey);

        // 状态校验
        if (!state || state.phase !== 'bidding') {
            return ctx.reply('❌ 当前不在抢答阶段，请等待 AI 叙述结束。');
        }

        if (state.winner) {
            return ctx.reply(`❌ 本轮已被 ${state.winner.senderName} 抢答，等待下一轮。`);
        }

        // 提取抢答内容（支持带空格的内容）
        const content = (ctx.args.join(' ') || '').trim();
        if (!content) {
            return ctx.reply('用法: /bid <你的行动内容>\n例如: /bid 我走上前去打了个招呼');
        }

        await this._processBid(ctx, content);
    }

    /**
     * /skip - 跳过当前抢答轮次
     * 通常在超时后使用，会向 ST 发送跳过指令以推进剧情
     */
    async handleSkip(ctx) {
        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);
        const state = this._states.get(sessionKey);

        if (!state || state.phase !== 'bidding') {
            return ctx.reply('ℹ️ 当前不在抢答阶段，无需跳过。');
        }

        // 重置状态
        this._resetState(sessionKey);

        await ctx.reply('⏭️ 已跳过本轮抢答，正在推进剧情...');

        // 向 ST 转发跳过指令，让 AI 以 NPC 行动推进剧情
        this._forwardToST(ctx.platform, ctx.chatId, 'system', 'System', '（系统：无人抢答，跳过本轮，请以NPC或环境推进剧情）');

        this.logger.info(`[${sessionKey}] 用户 ${ctx.senderName} 跳过了抢答轮次`);
    }

    /**
     * /bstatus - 查看抢答状态
     */
    async handleStatus(ctx) {
        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);
        const state = this._states.get(sessionKey);

        if (!state || state.phase !== 'bidding') {
            return ctx.reply(
                '📋 抢答状态: 空闲\n' +
                '当前等待 AI 叙述剧情，抢答窗口未开启。'
            );
        }

        const remaining = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
        const timeout = this.getConfig('bidTimeout') || 30;
        const marker = this.getConfig('endMarker') || '【本轮结束】';
        const implicit = this.getConfig('implicitBid') !== false;

        return ctx.reply(
            '📋 抢答状态: 进行中\n' +
            `⏱️ 剩余时间: ${remaining}s / ${timeout}s\n` +
            `🏷️ 结束标记: ${marker}\n` +
            `💬 抢答方式: ${implicit ? '直接发消息 或 /bid' : '仅 /bid <内容>'}\n` +
            (state.winner ? `🏆 胜者: ${state.winner.senderName}` : '🏆 暂无胜者')
        );
    }

    /**
     * /breset - 强制重置状态（卡死恢复）
     */
    async handleReset(ctx) {
        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);
        this._resetState(sessionKey);
        return ctx.reply('✅ 抢答状态已强制重置。');
    }

    // ==================== 核心逻辑：处理抢答 ====================

    /**
     * 处理抢答（隐式或显式统一入口）
     *
     * 并发安全设计：
     *   1. 状态检查 -> 设置胜者 -> 切换 phase 全部在同步块中完成
     *   2. Node.js 单线程模型保证同步块内不会被其他消息处理中断
     *   3. 异步操作（广播、转发ST）在状态锁定之后执行
     *
     * @param {PluginContext} ctx - 上下文
     * @param {string} content - 抢答内容
     */
    async _processBid(ctx, content) {
        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);
        const state = this._states.get(sessionKey);

        // 双重检查（命令处理器已检查过，但隐式抢答路径需要再检查）
        if (!state || state.phase !== 'bidding') {
            return ctx.reply('❌ 当前不在抢答阶段。');
        }
        if (state.winner) {
            return ctx.reply(`❌ 手慢了！本轮已被 ${state.winner.senderName} 抢答。`);
        }

        // ============ 原子操作：锁定胜者 ============
        // 以下三行同步执行，无 await，确保不会被并发消息打断
        state.winner = {
            senderId: ctx.senderId,
            senderName: ctx.senderName || '匿名玩家',
            content: content,
            timestamp: Date.now(),
        };
        state.phase = 'idle';  // 立即关闭抢答窗口

        // 清除超时定时器
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        // ============ 原子操作结束 ============

        this.logger.info(
            `[${sessionKey}] 抢答胜者: ${state.winner.senderName} -> "${content.substring(0, 50)}"`
        );

        // 广播胜者公告到群
        try {
            await ctx.reply(
                `🏆 抢答胜出: ${state.winner.senderName}\n` +
                `📝 行动内容: ${content}\n` +
                `━━ 剧情推进中 ━━`
            );
        } catch (error) {
            this.logger.error(`胜者公告发送失败: ${error.message}`);
        }

        // 将胜者内容转发给 SillyTavern 作为下一条 user 消息
        this._forwardToST(
            ctx.platform,
            ctx.chatId,
            ctx.senderId,
            state.winner.senderName,
            content
        );
    }

    // ==================== ST 转发 ====================

    /**
     * 将内容转发给 SillyTavern 作为 user 消息
     *
     * 流程：
     *   1. 记录到会话历史（role: user）
     *   2. 构造 InboundMessage 并 emit('externalMessage')
     *   3. ST 扩展监听 externalMessage 事件，拉取并处理
     *
     * @param {string} platform - 平台
     * @param {string} chatId - 群号
     * @param {string} senderId - 发送者ID
     * @param {string} senderName - 发送者名称
     * @param {string} content - 消息内容
     */
    _forwardToST(platform, chatId, senderId, senderName, content) {
        try {
            const sessionManager = this._services.sessionManager;
            const gateway = this._services.gateway;

            // 1. 记录到会话历史
            if (sessionManager) {
                sessionManager.addMessage(platform, chatId, {
                    role: 'user',
                    content: content,
                    name: senderName,
                });
            }

            // 2. 构造入站消息对象
            const craftedMsg = new InboundMessage({
                platform: platform,
                chatId: chatId,
                chatType: 'group',
                senderId: senderId,
                senderName: senderName,
                content: content,
                timestamp: Date.now(),
            });

            // 3. 触发外部处理事件 -> ST 扩展接收
            if (gateway) {
                gateway.emit('externalMessage', craftedMsg);
                this.logger.info(`[${platform}:${chatId}] 已转发抢答内容到 SillyTavern`);
            } else {
                this.logger.error('网关实例不可用，无法转发到 ST');
            }
        } catch (error) {
            this.logger.error(`转发到 ST 失败: ${error.message}`, error);
        }
    }

    // ==================== 状态管理工具 ====================

    /**
     * 重置指定群的状态（清理定时器）
     */
    _resetState(sessionKey) {
        const state = this._states.get(sessionKey);
        if (state) {
            if (state.timer) {
                clearTimeout(state.timer);
            }
            state.phase = 'idle';
            state.winner = null;
            state.timer = null;
        }
    }

    /**
     * 生成会话键
     */
    _sessionKey(platform, chatId) {
        return `${platform}:${chatId}`;
    }
}
