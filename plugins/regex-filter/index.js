/**
 * 正则过滤器插件
 * 对出站消息（AI 回复）进行正则提取/移除处理
 * 解决 SillyTavern 输出包含大量元数据标签的问题
 *
 * 功能：
 * - 提取规则：用正则匹配并提取正文（如 <maintext>...</maintext> 之间的内容）
 * - 移除规则：用正则移除不需要的片段
 * - 支持多规则、优先级、平台过滤
 * - 运行时通过命令管理规则
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class RegexFilterPlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'regex',
            alias: ['正则'],
            handler: 'handleRegex',
            description: '正则过滤器管理',
            usage: '/regex <list|add|remove|enable|disable|test|fallback>',
        },
    ];

    static listeners = [];

    constructor(options) {
        super(options);
        this._removeFilter = null; // 保存取消注册函数
    }

    async onLoad() {
        // 注册出站消息过滤器
        const gateway = this._services.gateway;
        if (gateway && gateway.addOutboundFilter) {
            this._removeFilter = gateway.addOutboundFilter(
                (msg) => this.filterOutbound(msg),
                { name: 'regex-filter', priority: 10 }
            );
            this.logger.info('正则过滤器已挂载到出站消息链');
        } else {
            this.logger.warn('网关不支持出站过滤器，插件将无法工作');
        }

        // 初始化默认配置
        this._ensureDefaults();
        this.logger.info(`正则过滤器已加载 (提取规则: ${this._getExtractPatterns().length}, 移除规则: ${this._getRemovePatterns().length})`);
    }

    async onUnload() {
        if (this._removeFilter) {
            this._removeFilter();
            this._removeFilter = null;
        }
        this.logger.info('正则过滤器已卸载');
    }

    // ==================== 核心过滤逻辑 ====================

    /**
     * 出站消息过滤器
     * @param {object} message - OutboundMessage
     * @returns {object|null} 修改后的消息，null 表示丢弃
     */
    filterOutbound(message) {
        if (!message || !message.content) return message;

        // 平台过滤
        const platforms = this.getConfig('applyToPlatforms') || [];
        if (platforms.length > 0 && !platforms.includes(message.platform)) {
            return message;
        }

        let content = message.content;
        const original = content;

        // 第一步：提取规则（命中第一个即停止）
        content = this._applyExtract(content);

        // 第二步：移除规则（全部执行）
        content = this._applyRemove(content);

        // 第三步：去除首尾空白
        if (this.getConfig('trimWhitespace') !== false) {
            content = content.trim();
        }

        // 如果处理后为空
        if (!content) {
            const fallback = this.getConfig('fallbackToOriginal') !== false;
            if (fallback) {
                return message; // 使用原始消息
            }
            this.logger.debug('过滤后内容为空，丢弃消息');
            return null;
        }

        // 内容有变化时更新
        if (content !== original) {
            message.content = content;
            this.logger.debug(`正则过滤: ${original.length} → ${content.length} 字符`);
        }

        return message;
    }

    /**
     * 应用提取规则
     */
    _applyExtract(content) {
        const patterns = this._getExtractPatterns();

        for (const rule of patterns) {
            if (!rule.enabled) continue;

            try {
                const regex = new RegExp(rule.pattern, rule.flags || 's');
                const match = content.match(regex);

                if (match) {
                    const group = rule.group ?? 1;
                    const extracted = match[group] ?? match[0];
                    this.logger.debug(`提取规则 [${rule.name}] 命中，提取第 ${group} 组`);
                    return extracted;
                }
            } catch (error) {
                this.logger.error(`提取规则 [${rule.name}] 正则错误: ${error.message}`);
            }
        }

        // 没有命中任何提取规则
        const fallback = this.getConfig('fallbackToOriginal') !== false;
        if (!fallback && patterns.length > 0) {
            return ''; // 不 fallback 且未命中 → 返回空
        }
        return content;
    }

    /**
     * 应用移除规则
     */
    _applyRemove(content) {
        const patterns = this._getRemovePatterns();

        for (const rule of patterns) {
            if (!rule.enabled) continue;

            try {
                const regex = new RegExp(rule.pattern, rule.flags || 'gs');
                const replacement = rule.replacement ?? '';
                content = content.replace(regex, replacement);
            } catch (error) {
                this.logger.error(`移除规则 [${rule.name}] 正则错误: ${error.message}`);
            }
        }

        return content;
    }

    // ==================== 配置辅助 ====================

    _ensureDefaults() {
        if (!this.getConfig('extractPatterns')) {
            this.setConfig('extractPatterns', [
                {
                    name: 'maintext',
                    enabled: true,
                    pattern: '<maintext>([\\s\\S]*?)</maintext>',
                    group: 1,
                    description: '提取 <maintext> 标签内的正文',
                },
            ]);
        }
        if (!this.getConfig('removePatterns')) {
            this.setConfig('removePatterns', []);
        }
    }

    _getExtractPatterns() {
        return this.getConfig('extractPatterns') || [];
    }

    _getRemovePatterns() {
        return this.getConfig('removePatterns') || [];
    }

    // ==================== 命令处理 ====================

    /**
     * /regex 命令 - 管理正则规则
     */
    async handleRegex(ctx) {
        const sub = (ctx.args[0] || 'list').toLowerCase();

        switch (sub) {
            case 'list':
            case '列表':
                return this._cmdList(ctx);
            case 'add':
            case '添加':
                return this._cmdAdd(ctx);
            case 'remove':
            case '删除':
                return this._cmdRemove(ctx);
            case 'enable':
            case '启用':
                return this._cmdToggle(ctx, true);
            case 'disable':
            case '禁用':
                return this._cmdToggle(ctx, false);
            case 'test':
            case '测试':
                return this._cmdTest(ctx);
            case 'fallback':
                return this._cmdFallback(ctx);
            case 'help':
            case '帮助':
                return this._cmdHelp(ctx);
            default:
                return this._cmdHelp(ctx);
        }
    }

    /**
     * 列出所有规则
     */
    async _cmdList(ctx) {
        const extract = this._getExtractPatterns();
        const remove = this._getRemovePatterns();

        const lines = ['📋 正则过滤器规则:', '', '【提取规则】(命中第一个即停止)'];

        if (extract.length === 0) {
            lines.push('  (无)');
        } else {
            extract.forEach((r, i) => {
                const status = r.enabled ? '✅' : '❌';
                lines.push(`  ${status} ${i + 1}. [${r.name}] ${r.description || r.pattern}`);
                lines.push(`     正则: ${r.pattern}  组: ${r.group ?? 1}`);
            });
        }

        lines.push('', '【移除规则】(全部执行)');
        if (remove.length === 0) {
            lines.push('  (无)');
        } else {
            remove.forEach((r, i) => {
                const status = r.enabled ? '✅' : '❌';
                lines.push(`  ${status} ${i + 1}. [${r.name}] ${r.description || r.pattern}`);
                lines.push(`     正则: ${r.pattern}  替换: "${r.replacement ?? ''}"`);
            });
        }

        lines.push('', `Fallback: ${this.getConfig('fallbackToOriginal') !== false ? '开启' : '关闭'}`);
        const platforms = this.getConfig('applyToPlatforms') || [];
        lines.push(`生效平台: ${platforms.length ? platforms.join(', ') : '全部'}`);

        return ctx.reply(lines.join('\n'));
    }

    /**
     * 添加规则
     * /regex add extract <name> <pattern> [group] [description]
     * /regex add remove <name> <pattern> [replacement] [description]
     */
    async _cmdAdd(ctx) {
        const type = ctx.args[1]; // extract | remove
        const name = ctx.args[2];
        const pattern = ctx.args[3];

        if (!type || !name || !pattern) {
            return ctx.reply(
                '用法:\n' +
                '/regex add extract <名称> <正则> [组号] [描述]\n' +
                '/regex add remove <名称> <正则> [替换文本] [描述]\n\n' +
                '示例:\n' +
                '/regex add extract story <story>([\\s\\S]*?)</story> 1 提取story标签\n' +
                '/regex add remove think <think>[\\s\\S]*?</think> "" 移除思考过程'
            );
        }

        // 验证正则是否有效
        try {
            new RegExp(pattern);
        } catch (error) {
            return ctx.reply(`❌ 无效正则: ${error.message}`);
        }

        if (type === 'extract') {
            const group = parseInt(ctx.args[4]) || 1;
            const description = ctx.args.slice(5).join(' ') || '';
            const patterns = this._getExtractPatterns();
            patterns.push({ name, enabled: true, pattern, group, description });
            this.setConfig('extractPatterns', patterns);
            return ctx.reply(`✅ 提取规则 [${name}] 已添加\n正则: ${pattern}\n提取组: ${group}`);
        } else if (type === 'remove') {
            const replacement = ctx.args[4] ?? '';
            const description = ctx.args.slice(5).join(' ') || '';
            const patterns = this._getRemovePatterns();
            patterns.push({ name, enabled: true, pattern, replacement, description });
            this.setConfig('removePatterns', patterns);
            return ctx.reply(`✅ 移除规则 [${name}] 已添加\n正则: ${pattern}\n替换为: "${replacement}"`);
        } else {
            return ctx.reply('类型必须是 extract 或 remove');
        }
    }

    /**
     * 删除规则
     * /regex remove <extract|remove> <名称或序号>
     */
    async _cmdRemove(ctx) {
        const type = ctx.args[1];
        const target = ctx.args[2];

        if (!type || !target) {
            return ctx.reply('用法: /regex remove <extract|remove> <名称或序号>');
        }

        if (type === 'extract') {
            const patterns = this._getExtractPatterns();
            const idx = this._findIndex(patterns, target);
            if (idx === -1) return ctx.reply(`未找到提取规则: ${target}`);
            const removed = patterns.splice(idx, 1)[0];
            this.setConfig('extractPatterns', patterns);
            return ctx.reply(`✅ 已删除提取规则 [${removed.name}]`);
        } else if (type === 'remove') {
            const patterns = this._getRemovePatterns();
            const idx = this._findIndex(patterns, target);
            if (idx === -1) return ctx.reply(`未找到移除规则: ${target}`);
            const removed = patterns.splice(idx, 1)[0];
            this.setConfig('removePatterns', patterns);
            return ctx.reply(`✅ 已删除移除规则 [${removed.name}]`);
        }

        return ctx.reply('类型必须是 extract 或 remove');
    }

    /**
     * 启用/禁用规则
     * /regex enable <extract|remove> <名称或序号>
     */
    async _cmdToggle(ctx, enable) {
        const type = ctx.args[1];
        const target = ctx.args[2];

        if (!type || !target) {
            return ctx.reply(`用法: /regex ${enable ? 'enable' : 'disable'} <extract|remove> <名称或序号>`);
        }

        const key = type === 'extract' ? 'extractPatterns' : 'removePatterns';
        const patterns = this.getConfig(key) || [];
        const idx = this._findIndex(patterns, target);

        if (idx === -1) return ctx.reply(`未找到规则: ${target}`);

        patterns[idx].enabled = enable;
        this.setConfig(key, patterns);
        return ctx.reply(`${enable ? '✅ 已启用' : '❌ 已禁用'}规则 [${patterns[idx].name}]`);
    }

    /**
     * 测试正则
     * /regex test <pattern> [group]
     * 使用最近一条出站消息内容测试（或固定示例）
     */
    async _cmdTest(ctx) {
        const pattern = ctx.args[1];
        if (!pattern) {
            return ctx.reply('用法: /regex test <正则> [组号]\n将使用示例文本测试匹配结果');
        }

        const group = parseInt(ctx.args[2]) || 1;
        const sampleText = '<maintext>\n这是测试正文内容。\n第二行。\n</maintext>\n<Status_block>状态栏</Status_block>';

        try {
            const regex = new RegExp(pattern, 's');
            const match = sampleText.match(regex);

            if (match) {
                const result = match[group] ?? match[0];
                return ctx.reply(
                    `✅ 匹配成功!\n` +
                    `正则: ${pattern}\n` +
                    `提取组 ${group}: \n---\n${result}\n---`
                );
            } else {
                return ctx.reply(`❌ 未匹配\n正则: ${pattern}\n示例文本中未找到匹配`);
            }
        } catch (error) {
            return ctx.reply(`❌ 正则错误: ${error.message}`);
        }
    }

    /**
     * 切换 fallback 模式
     * /regex fallback [on|off]
     */
    async _cmdFallback(ctx) {
        const value = ctx.args[1];
        if (value === 'on') {
            this.setConfig('fallbackToOriginal', true);
            return ctx.reply('✅ Fallback 已开启（未命中时发送原始消息）');
        } else if (value === 'off') {
            this.setConfig('fallbackToOriginal', false);
            return ctx.reply('✅ Fallback 已关闭（未命中时丢弃消息）');
        }
        const current = this.getConfig('fallbackToOriginal') !== false;
        return ctx.reply(`当前 Fallback: ${current ? '开启' : '关闭'}\n用法: /regex fallback <on|off>`);
    }

    /**
     * 帮助
     */
    async _cmdHelp(ctx) {
        return ctx.reply([
            '🔧 正则过滤器命令:',
            '',
            '/regex list - 查看所有规则',
            '/regex add extract <名称> <正则> [组号] [描述]',
            '/regex add remove <名称> <正则> [替换文本] [描述]',
            '/regex remove <extract|remove> <名称或序号>',
            '/regex enable <extract|remove> <名称或序号>',
            '/regex disable <extract|remove> <名称或序号>',
            '/regex test <正则> [组号] - 测试正则匹配',
            '/regex fallback <on|off> - 未命中时是否发送原文',
            '',
            '💡 提取规则: 按顺序匹配，命中第一个即提取对应组内容',
            '💡 移除规则: 在提取后执行，移除所有匹配内容',
            '💡 正则默认使用 s 标志（. 匹配换行符）',
        ].join('\n'));
    }

    // ==================== 工具方法 ====================

    /**
     * 按名称或序号查找规则索引
     */
    _findIndex(patterns, target) {
        // 先按序号
        const num = parseInt(target);
        if (!isNaN(num) && num >= 1 && num <= patterns.length) {
            return num - 1;
        }
        // 再按名称
        return patterns.findIndex(p => p.name === target);
    }
}
