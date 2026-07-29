/**
 * Plugin Context - 插件上下文 API
 * 每个插件处理器被调用时收到的 ctx 对象
 */

import { OutboundMessage } from './adapters/base-adapter.js';

/**
 * 插件上下文 - 封装消息信息和操作方法
 */
export class PluginContext {
    /**
     * @param {object} options
     * @param {import('./adapters/base-adapter.js').InboundMessage} options.message - 原始入站消息
     * @param {import('./gateway-core.js').GatewayCore} options.gateway - 网关核心实例
     * @param {import('./session-manager.js').SessionManager} options.sessionManager - 会话管理器
     * @param {import('./utils/config.js').default} options.configManager - 配置管理器
     * @param {string} options.pluginName - 当前插件名称
     * @param {object} options.commandArgs - 命令参数（如果是命令触发）
     * @param {object} options.gatewayConfig - 按权限收窄的网关配置视图
     * @param {object} options.llm - 按权限收窄的 LLM 调用服务
     */
    constructor(options = {}) {
        const {
            message, gateway, sessionManager, configManager, pluginName, commandArgs,
            gatewayConfig, llm, fs, assets, agent,
        } = options;

        // 消息信息
        this.message = message || null;
        this.platform = message?.platform || '';
        this.chatId = message?.chatId || '';
        this.chatType = message?.chatType || 'private';
        this.senderId = message?.senderId || '';
        this.senderName = message?.senderName || '';
        this.content = message?.content || '';
        this.messageId = message?.messageId || '';

        // 命令相关
        this.args = commandArgs || [];
        this.commandName = '';

        // 控制流
        this._propagationStopped = false;
        this._handled = false;

        // 内部服务引用
        this._gateway = gateway;
        this._sessionManager = sessionManager;
        this._configManager = configManager;
        // 按插件权限收窄的网关配置视图（凭据脱敏）。由 PluginManager 注入；
        // 缺失时 getConfig() 一律拒绝，避免"注入缺失=意外放行"。
        this._gatewayConfig = gatewayConfig || null;
        // 按插件权限收窄的 LLM 调用服务。由 PluginManager 注入；
        // 未声明 "llm" 权限时为拒绝桩，调用即抛错。缺失时 ctx.llm 抛提示。
        this._llm = llm || null;
        // 按插件权限收窄的文件系统服务。由 PluginManager 注入；
        // 未声明 "fs" 权限时为拒绝桩，调用即抛错。缺失时 ctx.fs 抛提示。
        this._fs = fs || null;
        // 按插件权限收窄的 ST 资产只读服务。由 PluginManager 注入；
        // 未声明 "assets" 权限时为拒绝桩，调用即抛错。缺失时 ctx.assets 抛提示。
        this._assets = assets || null;
        // 按插件权限收窄的 Agent 框架服务。由 PluginManager 注入；
        // 未声明 "agent" 权限时为拒绝桩，调用即抛错。缺失时 ctx.agent 抛提示。
        this._agent = agent || null;
        this._pluginName = pluginName || '';
    }

    /**
     * 消息是否已被处理
     */
    get handled() {
        return this._handled;
    }

    set handled(value) {
        this._handled = value;
    }

    /**
     * 传播是否被阻止
     */
    get propagationStopped() {
        return this._propagationStopped;
    }

    // ==================== 回复方法 ====================

    /**
     * 回复到当前会话
     * @param {string} text - 回复内容
     * @param {object} options - 选项 { replyToId?, mediaUrls? }
     */
    async reply(text, options = {}) {
        if (!this._gateway || !this.message) {
            throw new Error('无法回复：缺少网关或消息上下文');
        }

        const outbound = new OutboundMessage({
            platform: this.platform,
            chatId: this.chatId,
            chatType: this.chatType,
            content: text,
            replyToId: options.replyToId || this.messageId,
            mediaUrls: options.mediaUrls || [],
        });

        this._gateway.sendMessage(outbound);
        this._handled = true;
        return outbound;
    }

    /**
     * 私聊回复指定用户
     * @param {string} userId - 用户 ID
     * @param {string} text - 回复内容
     */
    async replyPrivate(userId, text) {
        if (!this._gateway) {
            throw new Error('无法回复：缺少网关上下文');
        }

        const outbound = new OutboundMessage({
            platform: this.platform,
            chatId: userId,
            chatType: 'private',
            content: text,
        });

        this._gateway.sendMessage(outbound);
        this._handled = true;
        return outbound;
    }

    /**
     * 发送消息到任意目标
     * @param {string} platform - 目标平台
     * @param {string} chatId - 目标会话 ID
     * @param {string} text - 消息内容
     * @param {object} options - 选项
     */
    async send(platform, chatId, text, options = {}) {
        if (!this._gateway) {
            throw new Error('无法发送：缺少网关上下文');
        }

        const outbound = new OutboundMessage({
            platform,
            chatId,
            chatType: options.chatType || 'private',
            content: text,
            replyToId: options.replyToId || '',
            mediaUrls: options.mediaUrls || [],
        });

        this._gateway.sendMessage(outbound);
        return outbound;
    }

    // ==================== 会话操作 ====================

    /**
     * 获取当前会话历史
     * @param {number} limit - 最大条数（0 = 全部）
     */
    getHistory(limit = 0) {
        if (!this._sessionManager) return [];
        return this._sessionManager.getHistory(this.platform, this.chatId, limit);
    }

    /**
     * 清空当前会话历史
     */
    clearHistory() {
        if (!this._sessionManager) return;
        this._sessionManager.clearHistory(this.platform, this.chatId);
    }

    // ==================== 配置操作 ====================

    /**
     * 读取网关全局配置（受权限约束 + 凭据脱敏）
     *
     * 安全修复：此前此方法直接透传 configManager.get()，任何插件
     * `ctx.getConfig('adapters.telegram.botToken')` 即可窃取全部平台凭据
     * 与网关鉴权 token。现在改走受控视图：
     *   - 未声明 gateway.config 权限 → 返回 undefined
     *   - 已声明 → 值仍经脱敏，凭据不会明文流入插件
     *
     * 插件自己的密钥请存放在**插件配置**（getPluginConfig）中。
     *
     * @param {string} key - 配置路径（如 'adapters.qq.enabled'）
     */
    getConfig(key) {
        // 优先用收窄后的视图；无视图时（如单元测试直接构造 ctx）一律拒绝，
        // 避免因注入缺失而"意外放行"。
        if (this._gatewayConfig) return this._gatewayConfig.get(key);
        return undefined;
    }

    /**
     * 读取本插件配置（由 PluginManager 注入）
     * 实际实现由插件基类的 getConfig 提供
     */
    getPluginConfig() {
        // 由外部注入
        return this._pluginConfig || {};
    }

    /**
     * 保存本插件配置
     */
    setPluginConfig(data) {
        this._pluginConfig = data;
        if (this._savePluginConfig) {
            this._savePluginConfig(this._pluginName, data);
        }
    }

    // ==================== 网关服务 ====================

    /**
     * 调用网关配置的 LLM（受 "llm" 权限约束；拿不到 API key）。
     *
     * 用法：
     *   const reply = await ctx.llm.chat([{ role: 'user', content: ctx.content }]);
     *   // 流式：
     *   await ctx.llm.chatStream(msgs, {}, (delta, full) => { ... });
     *
     * 未声明 "llm" 权限时，调用 chat/chatStream/chatWithTools/runTools/verify 会抛出清晰错误。
     * @returns {{chat: Function, chatStream: Function, chatWithTools: Function, runTools: Function, verify: Function}}
     */
    get llm() {
        if (!this._llm) {
            throw new Error(
                `插件 ${this._pluginName || '?'} 使用 ctx.llm 需要 "llm" 权限，请在 plugin.json 的 permissions 中声明`,
            );
        }
        return this._llm;
    }

    /**
     * 文件系统服务（受 "fs" 权限约束）。
     *
     * 用法：
     *   const text = ctx.fs.read('data.json');
     *   ctx.fs.write('output.txt', 'hello');
     *   const files = ctx.fs.list('subdir');
     *   if (ctx.fs.exists('config.json')) { ... }
     *
     * 仅可读写 data/plugins/<插件名>/ 目录下的文件。
     * 未声明 "fs" 权限时，调用任何方法会抛出清晰错误。
     */
    get fs() {
        if (!this._fs) {
            throw new Error(
                `插件 ${this._pluginName || '?'} 使用 ctx.fs 需要 "fs" 权限，请在 plugin.json 的 permissions 中声明`,
            );
        }
        return this._fs;
    }

    /**
     * ST 资产只读服务（受 "assets" 权限约束）。
     *
     * 用法：
     *   const chars = ctx.assets.listCharacters();
     *   const card = ctx.assets.readCharacter('Alice');
     *   const books = ctx.assets.listWorldbooks();
     *   const wb = ctx.assets.readWorldbook('lore');
     *   const presets = ctx.assets.listPresets();
     *   const preset = ctx.assets.readPreset('default');
     *
     * 未声明 "assets" 权限时，调用任何方法会抛出清晰错误。
     */
    get assets() {
        if (!this._assets) {
            throw new Error(
                `插件 ${this._pluginName || '?'} 使用 ctx.assets 需要 "assets" 权限，请在 plugin.json 的 permissions 中声明`,
            );
        }
        return this._assets;
    }

    /**
     * Agent 框架服务（受 "agent" 权限约束）。
     *
     * 用法：
     *   ctx.agent.registerTool({ name, description, handler });
     *   const result = await ctx.agent.dispatch('researcher', '调查 X 的最新进展');
     *   ctx.agent.registerAgent({ name, systemPrompt, tools });
     *   const status = ctx.agent.getStatus();
     *
     * 未声明 "agent" 权限时，调用任何方法会抛出清晰错误。
     */
    get agent() {
        if (!this._agent) {
            throw new Error(
                `插件 ${this._pluginName || '?'} 使用 ctx.agent 需要 "agent" 权限，请在 plugin.json 的 permissions 中声明`,
            );
        }
        return this._agent;
    }

    /**
     * 获取所有适配器状态
     */
    getAdapters() {
        if (!this._gateway) return {};
        return this._gateway.getStatus().adapters;
    }

    /**
     * 获取所有会话列表
     */
    getSessions() {
        if (!this._sessionManager) return [];
        return this._sessionManager.listSessions();
    }

    // ==================== 控制流 ====================

    /**
     * 阻止消息继续传递给后续插件
     */
    stopPropagation() {
        this._propagationStopped = true;
        this._handled = true;
    }
}

export default PluginContext;
