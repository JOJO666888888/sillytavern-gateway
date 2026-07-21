import { Client, GatewayIntentBits, Partials, Events, ChannelType } from 'discord.js';
import { PlatformAdapter, ConnectionState, InboundMessage, OutboundMessage } from './base-adapter.js';

/**
 * Discord Bot 适配器
 * 使用 discord.js v14，支持频道消息和 DM 私聊
 */
export class DiscordAdapter extends PlatformAdapter {
    constructor(config = {}) {
        super('discord', config);
        this.client = null;
        this.ready = false;
    }

    /**
     * 建立连接
     */
    async connect() {
        if (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.CONNECTING) {
            return;
        }

        if (!this.config.botToken) {
            throw new Error('Discord Bot Token 未配置');
        }

        this.setState(ConnectionState.CONNECTING);
        this.logger.info('正在连接 Discord Gateway...');

        try {
            this.client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.MessageContent,
                    GatewayIntentBits.DirectMessages,
                    GatewayIntentBits.GuildMessageReactions,
                ],
                partials: [
                    Partials.Channel,
                    Partials.Message,
                    Partials.Reaction,
                ],
            });

            // 注册事件处理器
            this.setupEventHandlers();

            // 登录
            await this.client.login(this.config.botToken);
        } catch (error) {
            this.logger.error(`Discord 连接失败: ${error.message}`);
            this.setState(ConnectionState.ERROR);
            throw error;
        }
    }

    /**
     * 设置事件处理器
     */
    setupEventHandlers() {
        // 客户端就绪
        this.client.once(Events.ClientReady, (client) => {
            this.ready = true;
            this.logger.info(`Discord Bot 已上线: ${client.user.tag}`);
            this.setState(ConnectionState.CONNECTED);
            this.emit('connected');
        });

        // 消息创建
        this.client.on(Events.MessageCreate, async (message) => {
            await this.handleDiscordMessage(message);
        });

        // 消息更新
        this.client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
            this.logger.debug(`消息已编辑: ${newMessage.id}`);
        });

        // 断开连接
        this.client.on(Events.ShardDisconnect, (event) => {
            this.logger.warn(`Discord Shard 断开: ${event.code}`);
            this.ready = false;
            this.handleDisconnect(`Shard 断开 (${event.code})`);
        });

        // 重连
        this.client.on(Events.ShardReconnecting, (id) => {
            this.logger.info(`Discord Shard ${id} 正在重连...`);
            this.setState(ConnectionState.RECONNECTING);
        });

        // 错误
        this.client.on(Events.Error, (error) => {
            this.logger.error(`Discord 客户端错误: ${error.message}`);
            this.emit('error', error);
        });

        // 调试信息
        this.client.on(Events.Debug, (info) => {
            this.logger.debug(`Discord Debug: ${info}`);
        });

        // 速率限制
        this.client.on(Events.Warn, (warning) => {
            this.logger.warn(`Discord 警告: ${warning}`);
        });
    }

    /**
     * 处理 Discord 消息
     * @param {Message} message - Discord.js 消息对象
     */
    async handleDiscordMessage(message) {
        // 忽略 bot 自己的消息
        if (message.author.bot) return;

        // 忽略系统消息
        if (message.system) return;

        const isDM = message.channel.type === ChannelType.DM;
        const guildId = message.guild?.id;
        const channelId = message.channel.id;

        // 频道白名单检查
        if (!isDM && this.config.allowedChannels?.length > 0) {
            if (!this.config.allowedChannels.includes(channelId)) {
                return;
            }
        }

        // 用户白名单检查
        if (this.config.allowedUsers?.length > 0) {
            if (!this.config.allowedUsers.includes(message.author.id)) {
                this.logger.debug(`用户 ${message.author.id} 不在白名单中`);
                return;
            }
        }

        // 检查是否需要 @
        let mentioned = false;
        let content = message.content || '';

        if (!isDM && this.config.requireMention) {
            // 检查是否 @了 bot
            mentioned = message.mentions.users.has(this.client.user.id);

            // 也检查是否回复了 bot 的消息
            if (message.reference) {
                try {
                    const referencedMsg = await message.channel.messages.fetch(message.reference.messageId);
                    if (referencedMsg.author.id === this.client.user.id) {
                        mentioned = true;
                    }
                } catch (e) {
                    // 引用的消息可能已删除
                }
            }

            if (!mentioned) {
                return; // 频道中未 @ bot，忽略
            }

            // 移除 @mention
            content = content.replace(new RegExp(`<@!?${this.client.user.id}>`, 'g'), '').trim();
        } else {
            mentioned = true; // DM 中默认视为提及
        }

        // 提取附件
        const mediaUrls = [];
        for (const [, attachment] of message.attachments) {
            if (attachment.contentType?.startsWith('image/')) {
                mediaUrls.push(attachment.url);
            }
        }

        // 处理嵌入中的图片
        for (const embed of message.embeds) {
            if (embed.image?.url) {
                mediaUrls.push(embed.image.url);
            }
            if (embed.thumbnail?.url) {
                mediaUrls.push(embed.thumbnail.url);
            }
        }

        // 处理空消息
        if (!content && mediaUrls.length === 0) {
            if (message.stickers.size > 0) content = '[贴纸]';
            else return;
        }

        // 转换为标准入站消息
        const inboundMsg = new InboundMessage({
            platform: 'discord',
            messageId: message.id,
            chatId: isDM ? message.author.id : channelId,
            chatType: isDM ? 'private' : 'channel',
            senderId: message.author.id,
            senderName: message.member?.nickname || message.author.username,
            content: content.trim(),
            mediaUrls,
            timestamp: message.createdTimestamp,
            mentioned,
            replyToId: message.reference?.messageId || '',
            raw: {
                guildId,
                channelId,
                channelName: message.channel.name,
            },
        });

        this.emit('message', inboundMsg);
    }

    /**
     * 发送消息
     * @param {OutboundMessage} message
     * @returns {Promise<boolean>}
     */
    async send(message) {
        if (!this.client || !this.ready) {
            throw new Error('Discord 客户端未就绪');
        }

        try {
            let channel;

            if (message.chatType === 'private') {
                // DM: chatId 是用户ID
                const user = await this.client.users.fetch(message.chatId);
                channel = await user.createDM();
            } else {
                // 频道: chatId 是频道ID
                channel = await this.client.channels.fetch(message.chatId);
            }

            if (!channel) {
                throw new Error(`无法找到频道/用户: ${message.chatId}`);
            }

            // 构建消息选项
            const messageOptions = {};

            if (message.content) {
                // Discord 消息限制 2000 字符
                const segments = this.splitMessage(message.content, 2000);
                messageOptions.content = segments[0];

                // 发送第一条消息
                const sentMessage = await channel.send(messageOptions);

                // 发送剩余分段
                for (let i = 1; i < segments.length; i++) {
                    await this.delay(500);
                    await channel.send({ content: segments[i] });
                }

                // 发送图片附件
                if (message.mediaUrls.length > 0) {
                    await channel.send({
                        files: message.mediaUrls.map(url => ({ attachment: url })),
                    });
                }

                return true;
            }

            // 只有媒体
            if (message.mediaUrls.length > 0) {
                await channel.send({
                    files: message.mediaUrls.map(url => ({ attachment: url })),
                });
                return true;
            }

            return false;
        } catch (error) {
            this.logger.error(`Discord 消息发送失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 断开连接
     */
    async disconnect() {
        if (this.client) {
            this.client.removeAllListeners();
            await this.client.destroy();
            this.client = null;
        }
        this.ready = false;
        this.setState(ConnectionState.DISCONNECTED);
    }

    /**
     * 验证连接：
     *   - 已连接：直接返回 bot 信息
     *   - 未连接：调用 Discord REST API /users/@me 校验 Token（无需完整登录 Gateway）
     */
    async verify() {
        if (this.isConnected() && this.client?.user) {
            return {
                ok: true,
                state: this.state,
                message: `已连接: ${this.client.user.tag}`,
                detail: { tag: this.client.user.tag },
            };
        }

        if (!this.config.botToken) {
            return { ok: false, state: this.state, message: 'Bot Token 未配置' };
        }

        try {
            const resp = await fetch('https://discord.com/api/v10/users/@me', {
                headers: { Authorization: `Bot ${this.config.botToken}` },
            });
            if (!resp.ok) {
                return { ok: false, state: this.state, message: `Token 无效 (HTTP ${resp.status})` };
            }
            const user = await resp.json();
            const tag = user.discriminator && user.discriminator !== '0'
                ? `${user.username}#${user.discriminator}`
                : `@${user.username}`;
            return {
                ok: true,
                state: this.state,
                message: `Token 有效: ${tag}`,
                detail: { username: user.username, id: user.id },
            };
        } catch (error) {
            return { ok: false, state: this.state, message: `验证失败: ${error.message}` };
        }
    }

    /**
     * 延迟工具
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default DiscordAdapter;
