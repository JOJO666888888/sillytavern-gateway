/**
 * RP记忆管理插件
 *
 * 功能：
 * 1. 出站过滤器：从 AI 回复中提取 <summary> 标签内容，存储为长期记忆
 * 2. 出站过滤器：剥离 <think>/<thinking> 和 <summary> 标签后再转发给用户
 * 3. 入站监听器：在用户消息前注入历史摘要，作为 LLM 上下文
 * 4. 跨平台记忆：通过 /memory link + /memory join 共享记忆组
 *
 * 配合「露水情缘」预设使用：预设底部指令要求 AI 在正文后输出 <summary>，
 * 本插件负责提取、存储、并在后续对话中注入。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GatewayPlugin } from '../../server/plugin-sdk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'plugins', 'rp-memory-data.json');

// 标签提取正则
const SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/g;
const THINK_RE = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g;

export default class RPMemoryPlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'memory',
            alias: ['记忆'],
            handler: 'handleMemory',
            description: 'RP记忆管理',
            usage: '/memory <status|list|clear|limit|link|join>',
        },
    ];

    static listeners = [
        {
            event: 'message',
            filter: {},
            handler: 'onInboundMessage',
            priority: 50,
        },
    ];

    constructor(options) {
        super(options);
        this._removeFilter = null;
        this._store = { groups: {}, sessionGroups: {} };
        this._saveTimer = null;
        this._dirty = false;
    }

    // ==================== 生命周期 ====================

    async onLoad() {
        this._ensureDefaults();
        this._loadStore();

        // 定期保存
        this._saveTimer = setInterval(() => this._saveIfDirty(), 10000);

        // 注册出站过滤器（priority 5，在 regex-filter 之前执行）
        const gateway = this._services.gateway;
        if (gateway && gateway.addOutboundFilter) {
            this._removeFilter = gateway.addOutboundFilter(
                (msg) => this.filterOutbound(msg),
                { name: 'rp-memory', priority: 5 }
            );
            this.logger.info('RP记忆过滤器已挂载到出站消息链');
        } else {
            this.logger.warn('网关不支持出站过滤器，插件无法工作');
        }

        this.logger.info('RP记忆管理插件已加载');
    }

    async onUnload() {
        if (this._removeFilter) {
            this._removeFilter();
            this._removeFilter = null;
        }
        if (this._saveTimer) {
            clearInterval(this._saveTimer);
            this._saveTimer = null;
        }
        this._save(); // 卸载时保存
        this.logger.info('RP记忆管理插件已卸载');
    }

    _ensureDefaults() {
        if (this.getConfig('contextSummaries') === undefined) {
            this.setConfig('contextSummaries', 10);
        }
        if (this.getConfig('stripThinkTags') === undefined) {
            this.setConfig('stripThinkTags', false);
        }
        if (this.getConfig('formatThinkTags') === undefined) {
            this.setConfig('formatThinkTags', true);
        }
        if (this.getConfig('stripSummaryTags') === undefined) {
            this.setConfig('stripSummaryTags', true);
        }
        if (this.getConfig('injectContext') === undefined) {
            this.setConfig('injectContext', true);
        }
        if (this.getConfig('maxSummaries') === undefined) {
            this.setConfig('maxSummaries', 100);
        }
    }

    // ==================== 出站过滤：提取 + 剥离 ====================

    /**
     * 出站消息过滤器
     * 1. 提取 <summary> 并存储
     * 2. 剥离 <think> 和 <summary> 标签
     * @param {object} message - OutboundMessage
     * @returns {object|null}
     */
    filterOutbound(message) {
        if (!message || !message.content) return message;

        let content = message.content;
        const sessionKey = this._sessionKey(message.platform, message.chatId);

        // 第一步：提取 summary（在剥离之前）
        const summaries = this._extractSummaries(content);
        if (summaries.length > 0) {
            for (const text of summaries) {
                this._addSummary(sessionKey, text.trim());
            }
            this._dirty = true;
            this.logger.debug(`[${sessionKey}] 提取到 ${summaries.length} 条摘要`);
        }

        // 第二步：剥离 <summary> 标签
        if (this.getConfig('stripSummaryTags') !== false) {
            content = content.replace(SUMMARY_RE, '').trim();
        }

        // 第三步：处理 <think>/<thinking> 标签
        if (this.getConfig('stripThinkTags') === true) {
            // 直接剥离
            content = content.replace(THINK_RE, '').trim();
        } else if (this.getConfig('formatThinkTags') !== false) {
            // 格式化为「内心独白」保留在消息中
            content = this._formatThinkContent(content);
        }

        // 处理后为空：返回原文（避免丢消息）
        if (!content) {
            this.logger.warn(`[${sessionKey}] 过滤后内容为空，使用原始消息`);
            return message;
        }

        message.content = content;
        return message;
    }

    /**
     * 从内容中提取所有 <summary> 标签的文本
     */
    _extractSummaries(content) {
        const results = [];
        let match;
        const re = new RegExp(SUMMARY_RE);
        while ((match = re.exec(content)) !== null) {
            if (match[1] && match[1].trim()) {
                results.push(match[1].trim());
            }
        }
        return results;
    }

    /**
     * 将 <think>/<thinking> 标签内容格式化为「内心独白」
     * 替换标签为可读的引用块，保留在消息中转发给用户
     *
     * 格式示例：
     *   💭 内心独白：
     *   原始 think 内容...
     *
     *   正文内容...
     */
    _formatThinkContent(content) {
        // 提取所有 think 块的内容
        const thinkBlocks = [];
        let match;
        const re = new RegExp(THINK_RE);
        while ((match = re.exec(content)) !== null) {
            const text = match[0].replace(/<\/?think(?:ing)?>/g, '').trim();
            if (text) {
                thinkBlocks.push(text);
            }
        }

        if (thinkBlocks.length === 0) return content;

        // 移除所有 think 标签块
        let cleaned = content.replace(THINK_RE, '').trim();

        // 拼接内心独白块 + 正文
        const thinkSection = thinkBlocks.map(t => `💭 内心独白：\n${t}`).join('\n\n');

        return thinkSection + (cleaned ? '\n\n' + cleaned : '');
    }

    // ==================== 入站监听：上下文注入 ====================

    /**
     * 入站消息监听器
     * 在用户消息前注入历史摘要，供 SillyTavern 作为 LLM 上下文使用
     * 注意：不调用 ctx.reply() 或 ctx.stopPropagation()，让消息继续流转到 ST
     */
    async onInboundMessage(ctx) {
        if (this.getConfig('injectContext') === false) return;

        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);
        const summaries = this._getSummaries(sessionKey);

        if (summaries.length === 0) return;

        const limit = this.getConfig('contextSummaries') || 10;
        const recent = summaries.slice(-limit);

        // 构造记忆块前缀
        const memoryBlock = this._buildMemoryBlock(recent);
        if (!memoryBlock) return;

        // 在消息内容前注入记忆块
        // 修改 ctx.message.content 会影响后续 emit('externalMessage') 的内容
        const original = ctx.message.content;
        ctx.message.content = `${memoryBlock}\n${original}`;

        this.logger.debug(`[${sessionKey}] 注入 ${recent.length} 条历史摘要作为上下文`);
    }

    /**
     * 构造记忆块
     */
    _buildMemoryBlock(summaries) {
        if (!summaries || summaries.length === 0) return '';

        const lines = ['<memory>', '# 以下是之前互动的记忆摘要，作为上下文参考：'];
        summaries.forEach((s, i) => {
            lines.push(`[${i + 1}] ${s.text}`);
        });
        lines.push('</memory>');

        return lines.join('\n');
    }

    // ==================== 记忆存储 ====================

    /**
     * 获取会话所属的记忆组 key
     * 如果会话未加入任何组，则使用会话 key 本身作为组
     */
    _getGroupKey(sessionKey) {
        return this._store.sessionGroups[sessionKey] || sessionKey;
    }

    /**
     * 获取会话的所有摘要
     */
    _getSummaries(sessionKey) {
        const groupKey = this._getGroupKey(sessionKey);
        const group = this._store.groups[groupKey];
        if (!group) return [];
        return group.summaries || [];
    }

    /**
     * 添加摘要到记忆组
     */
    _addSummary(sessionKey, text) {
        const groupKey = this._getGroupKey(sessionKey);

        if (!this._store.groups[groupKey]) {
            this._store.groups[groupKey] = {
                summaries: [],
                members: [groupKey],
            };
        }

        const group = this._store.groups[groupKey];
        group.summaries.push({
            text,
            ts: Date.now(),
            session: sessionKey,
        });

        // 限制摘要数量
        const max = this.getConfig('maxSummaries') || 100;
        if (group.summaries.length > max) {
            group.summaries = group.summaries.slice(-max);
        }
    }

    /**
     * 清空记忆组
     */
    _clearSummaries(sessionKey) {
        const groupKey = this._getGroupKey(sessionKey);
        if (this._store.groups[groupKey]) {
            this._store.groups[groupKey].summaries = [];
        }
    }

    // ==================== 持久化 ====================

    _loadStore() {
        try {
            const dir = path.dirname(DATA_FILE);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            if (fs.existsSync(DATA_FILE)) {
                const raw = fs.readFileSync(DATA_FILE, 'utf-8');
                this._store = JSON.parse(raw);
                if (!this._store.groups) this._store.groups = {};
                if (!this._store.sessionGroups) this._store.sessionGroups = {};
            }
            this.logger.info(`已加载记忆数据 (${Object.keys(this._store.groups).length} 个记忆组)`);
        } catch (error) {
            this.logger.error(`记忆数据加载失败: ${error.message}`);
            this._store = { groups: {}, sessionGroups: {} };
        }
    }

    _save() {
        try {
            const dir = path.dirname(DATA_FILE);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(DATA_FILE, JSON.stringify(this._store, null, 2), 'utf-8');
            this._dirty = false;
        } catch (error) {
            this.logger.error(`记忆数据保存失败: ${error.message}`);
        }
    }

    _saveIfDirty() {
        if (this._dirty) {
            this._save();
        }
    }

    // ==================== 命令处理 ====================

    async handleMemory(ctx) {
        const sub = (ctx.args[0] || 'status').toLowerCase();

        switch (sub) {
            case 'status':
            case '状态':
                return this._cmdStatus(ctx);
            case 'list':
            case '列表':
                return this._cmdList(ctx);
            case 'clear':
            case '清空':
                return this._cmdClear(ctx);
            case 'limit':
            case '数量':
                return this._cmdLimit(ctx);
            case 'link':
            case '链接':
                return this._cmdLink(ctx);
            case 'join':
            case '加入':
                return this._cmdJoin(ctx);
            case 'help':
            case '帮助':
            default:
                return this._cmdHelp(ctx);
        }
    }

    async _cmdStatus(ctx) {
        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);
        const groupKey = this._getGroupKey(sessionKey);
        const summaries = this._getSummaries(sessionKey);
        const limit = this.getConfig('contextSummaries') || 10;
        const inject = this.getConfig('injectContext') !== false;
        const isLinked = groupKey !== sessionKey;

        const lines = [
            '📋 RP记忆状态',
            '',
            `会话: ${sessionKey}`,
            `记忆组: ${groupKey}${isLinked ? ' (已跨平台链接)' : ''}`,
            `摘要总数: ${summaries.length}`,
            `上下文注入: ${inject ? `开启 (最近 ${Math.min(limit, summaries.length)} 条)` : '关闭'}`,
            `剥离 think 标签: ${this.getConfig('stripThinkTags') === true ? '是' : '否'}`,
            `格式化内心独白: ${this.getConfig('formatThinkTags') !== false ? '是' : '否'}`,
            `剥离 summary 标签: ${this.getConfig('stripSummaryTags') !== false ? '是' : '否'}`,
        ];

        if (isLinked) {
            const group = this._store.groups[groupKey];
            if (group) {
                lines.push(`链接成员: ${group.members.join(', ')}`);
            }
        }

        return ctx.reply(lines.join('\n'));
    }

    async _cmdList(ctx) {
        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);
        const summaries = this._getSummaries(sessionKey);

        if (summaries.length === 0) {
            return ctx.reply('📭 暂无记忆摘要');
        }

        const lines = ['📝 记忆摘要列表:', ''];
        summaries.forEach((s, i) => {
            const time = new Date(s.ts).toLocaleString('zh-CN');
            lines.push(`[${i + 1}] ${time}`);
            lines.push(`    ${s.text}`);
            lines.push('');
        });

        return ctx.reply(lines.join('\n'));
    }

    async _cmdClear(ctx) {
        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);
        const count = this._getSummaries(sessionKey).length;
        this._clearSummaries(sessionKey);
        this._dirty = true;
        this._save();
        return ctx.reply(`✅ 已清空 ${count} 条记忆摘要`);
    }

    async _cmdLimit(ctx) {
        const val = ctx.args[1];
        if (!val) {
            const current = this.getConfig('contextSummaries') || 10;
            return ctx.reply(`当前上下文注入数量: ${current}\n用法: /memory limit <数字>`);
        }
        const n = parseInt(val);
        if (isNaN(n) || n < 0 || n > 100) {
            return ctx.reply('❌ 数量必须是 0~100 之间的数字\n设置为 0 则关闭上下文注入');
        }
        this.setConfig('contextSummaries', n);
        return ctx.reply(`✅ 上下文注入数量已设为 ${n}${n === 0 ? ' (已关闭注入)' : ''}`);
    }

    async _cmdLink(ctx) {
        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);

        // 生成 6 位链接码
        const code = this._generateCode();
        const groupKey = `RP${code}`;

        // 创建记忆组，迁移当前会话的摘要
        const existingSummaries = this._getSummaries(sessionKey);
        this._store.groups[groupKey] = {
            summaries: existingSummaries,
            members: [sessionKey],
        };
        this._store.sessionGroups[sessionKey] = groupKey;

        // 删除旧的独立组（如果存在）
        if (sessionKey !== groupKey && this._store.groups[sessionKey]) {
            delete this._store.groups[sessionKey];
        }

        this._dirty = true;
        this._save();

        return ctx.reply(
            [
                '🔗 跨平台记忆链接已创建',
                '',
                `链接码: ${code}`,
                `记忆组: ${groupKey}`,
                `已迁移 ${existingSummaries.length} 条摘要`,
                '',
                '在另一个平台发送以下命令加入此记忆组:',
                `/memory join ${code}`,
                '',
                '加入后，两个平台将共享记忆摘要',
            ].join('\n')
        );
    }

    async _cmdJoin(ctx) {
        const code = ctx.args[1];
        if (!code) {
            return ctx.reply('用法: /memory join <链接码>');
        }

        const groupKey = `RP${code.toUpperCase()}`;
        if (!this._store.groups[groupKey]) {
            return ctx.reply(`❌ 找不到链接码 ${code} 对应的记忆组\n请确认链接码是否正确`);
        }

        const sessionKey = this._sessionKey(ctx.platform, ctx.chatId);
        const group = this._store.groups[groupKey];

        // 如果当前会话已有独立摘要，迁移过来
        const existingSummaries = this._getSummaries(sessionKey);
        if (existingSummaries.length > 0 && sessionKey !== groupKey) {
            for (const s of existingSummaries) {
                group.summaries.push(s);
            }
            // 删除旧的独立组
            if (this._store.groups[sessionKey]) {
                delete this._store.groups[sessionKey];
            }
        }

        // 加入组
        if (!group.members.includes(sessionKey)) {
            group.members.push(sessionKey);
        }
        this._store.sessionGroups[sessionKey] = groupKey;

        this._dirty = true;
        this._save();

        return ctx.reply(
            [
                `✅ 已加入记忆组 ${groupKey}`,
                `当前摘要总数: ${group.summaries.length}`,
                `链接成员: ${group.members.join(', ')}`,
            ].join('\n')
        );
    }

    async _cmdHelp(ctx) {
        return ctx.reply(
            [
                '🔧 RP记忆管理命令:',
                '',
                '/memory - 查看记忆状态',
                '/memory list - 列出所有摘要',
                '/memory clear - 清空当前会话的记忆',
                '/memory limit <n> - 设置上下文注入的摘要数量 (0=关闭)',
                '/memory link - 创建跨平台记忆链接码',
                '/memory join <码> - 加入已有记忆组（跨平台共享）',
                '',
                '💡 插件会自动从 AI 回复中提取 <summary> 标签作为记忆',
                '💡 新消息会自动注入历史摘要作为上下文',
                '💡 跨平台：在一个平台 /memory link，在另一个平台 /memory join <码>',
            ].join('\n')
        );
    }

    // ==================== 工具方法 ====================

    _sessionKey(platform, chatId) {
        return `${platform}:${chatId}`;
    }

    _generateCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        // 确保不重复
        if (this._store.groups[`RP${code}`]) {
            return this._generateCode();
        }
        return code;
    }
}
