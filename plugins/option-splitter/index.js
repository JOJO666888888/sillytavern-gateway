/**
 * 选项拆分发送插件 v2.0
 *
 * 将 AI 回复中的结构化内容（选项/卡片/要点）从正文中拆出，
 * 先发送正文（含幕后信息），再逐条补发每个选项。
 *
 * v2.0 改进（依赖网关 R1/R2/R3 改进）：
 *   - 使用 bypassFilters（R1）替代 _optionSplitterPassthrough 标记属性
 *   - 使用 skipDedup（R2）防止内容相同的选项被去重吞掉
 *   - 使用 configUi: "auto"（R3）自动生成配置 UI，无需手改 panel.html
 *   - 支持自定义提取正则、可配置标签名、多种发送策略
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';
import { OutboundMessage } from '../../server/adapters/base-adapter.js';

// 默认选项行匹配：>选项一：... / >选项2：...（支持中文/阿拉伯数字，全角/半角冒号）
const DEFAULT_OPTION_LINE_REGEX = /^>\s*选项\s*([一二三四五六七八九十\d]+)\s*[：:]\s*(.+)$/gm;

export default class OptionSplitterPlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'option',
            alias: ['选项'],
            handler: 'handleOption',
            description: '选项拆分发送插件配置',
            usage: '/option <list|on|off|test|help>',
        },
    ];

    static listeners = [];

    constructor(options) {
        super(options);
        this._removeFilter = null;
    }

    async onLoad() {
        this._ensureDefaults();

        const gateway = this._services.gateway;
        if (gateway && typeof gateway.addOutboundFilter === 'function') {
            this._removeFilter = gateway.addOutboundFilter(
                (msg) => this.filterOutbound(msg),
                { name: 'option-splitter', priority: 5 }
            );
            this.logger.info('选项拆分过滤器已挂载');
        } else {
            this.logger.warn('网关不支持出站过滤器');
        }
    }

    async onUnload() {
        if (this._removeFilter) {
            this._removeFilter();
            this._removeFilter = null;
        }
    }

    // ==================== 默认配置 ====================

    _ensureDefaults() {
        const defaults = {
            enabled: true,
            extractPattern: '',
            optionsTag: 'options',
            stripPrefix: true,
            outputFormat: 'sequential',
            initialDelay: 500,
            optionDelay: 800,
            optionPrefix: '',
            applyToPlatforms: [],
        };
        for (const [key, val] of Object.entries(defaults)) {
            if (this.getConfig(key) === undefined) this.setConfig(key, val);
        }
    }

    // ==================== 核心过滤逻辑 ====================

    /**
     * 出站消息过滤器
     * @param {object} message - OutboundMessage
     * @returns {object|null} 修改后的消息；null 表示丢弃
     */
    filterOutbound(message) {
        if (!message || !message.content) return message;
        if (this.getConfig('enabled') === false) return message;

        // 平台过滤
        const platforms = this.getConfig('applyToPlatforms') || [];
        if (platforms.length > 0 && !platforms.includes(message.platform)) return message;

        // 提取选项
        const { options, mainText } = this._extractFromContent(message.content);

        // 没有选项 -> 原样放行
        if (options.length === 0) return message;

        const outputFormat = this.getConfig('outputFormat') || 'sequential';

        if (outputFormat === 'batch') {
            // batch 模式：正文 + 选项合并为一条消息
            return this._mergeToBatch(message, mainText, options);
        }

        // sequential 模式：正文先发，选项逐条补发
        this._sendOptionsSequential(message, options);

        if (!mainText) {
            this.logger.info(`拆分: 正文为空，仅发送 ${options.length} 条选项`);
            return null;
        }

        message.content = mainText;
        this.logger.info(`拆分: 正文 ${mainText.length} 字符，选项 ${options.length} 条`);
        return message;
    }

    /**
     * 从内容中提取选项和正文
     * @param {string} content
     * @returns {{options: Array<{content: string, raw: string}>, mainText: string}}
     */
    _extractFromContent(content) {
        const customPattern = this.getConfig('extractPattern');
        const optionsTag = this.getConfig('optionsTag') || 'options';
        const stripPrefix = this.getConfig('stripPrefix') !== false;

        let options = [];
        let mainText = content;

        // 构建标签块正则（可配置标签名）
        const blockRegex = new RegExp(`<${optionsTag}>([\\s\\S]*?)</${optionsTag}>`, 'i');
        const blockMatch = content.match(blockRegex);

        if (blockMatch) {
            options = this._extractOptions(blockMatch[1], customPattern, stripPrefix);
            if (options.length > 0) {
                mainText = content.replace(blockMatch[0], '');
            }
        }

        // 无标签块或块内没解析到 -> 退而在整条内容里找
        if (options.length === 0) {
            options = this._extractOptions(content, customPattern, stripPrefix);
            if (options.length > 0) {
                mainText = this._stripOptionLines(content, customPattern);
            }
        }

        mainText = mainText.replace(/\n{3,}/g, '\n\n').trim();
        return { options, mainText };
    }

    /**
     * 从文本中提取选项
     * @param {string} text - 待提取文本
     * @param {string} customPattern - 自定义正则（留空=用默认 >选项X： 格式）
     * @param {boolean} stripPrefix - 是否去掉前缀
     * @returns {Array<{content: string, raw: string}>}
     */
    _extractOptions(text, customPattern, stripPrefix) {
        if (!text) return [];
        const options = [];

        let regex;
        if (customPattern) {
            // 自定义正则：用户提供的模式，取第一个捕获组作为选项内容
            try {
                regex = new RegExp(customPattern, 'gm');
            } catch (e) {
                this.logger.warn(`自定义正则无效: ${e.message}，回退到默认格式`);
                regex = new RegExp(DEFAULT_OPTION_LINE_REGEX.source, 'gm');
            }
        } else {
            regex = new RegExp(DEFAULT_OPTION_LINE_REGEX.source, 'gm');
        }

        let m;
        while ((m = regex.exec(text)) !== null) {
            // 捕获组优先，无捕获组则取整个匹配
            const matched = m[1] || m[0];
            options.push({
                content: matched.trim(),
                raw: m[0].trim(),
            });
        }
        return options;
    }

    /**
     * 从内容中移除选项行，返回剩余文本
     */
    _stripOptionLines(content, customPattern) {
        let regex;
        if (customPattern) {
            try {
                regex = new RegExp(customPattern, 'gm');
            } catch {
                regex = new RegExp(DEFAULT_OPTION_LINE_REGEX.source, 'gm');
            }
        } else {
            regex = new RegExp(DEFAULT_OPTION_LINE_REGEX.source, 'gm');
        }
        return content.replace(regex, '');
    }

    /**
     * batch 模式：正文 + 选项合并为一条消息
     */
    _mergeToBatch(message, mainText, options) {
        const prefix = this.getConfig('optionPrefix') || '';
        const parts = [mainText];
        if (mainText) parts.push(''); // 空行分隔

        options.forEach((o, i) => {
            const text = this.getConfig('stripPrefix') !== false ? o.content : o.raw;
            parts.push(`${prefix}${text}`);
        });

        message.content = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        this.logger.info(`batch 模式: 合并 ${options.length} 条选项到正文`);
        return message;
    }

    /**
     * 逐条补发选项（使用 R1 bypassFilters + R2 skipDedup）
     */
    _sendOptionsSequential(originalMessage, options) {
        const gateway = this._services.gateway;
        if (!gateway || typeof gateway.sendDirect !== 'function') {
            this.logger.warn('网关不支持 sendDirect，选项无法补发');
            return;
        }

        const initialDelay = Number(this.getConfig('initialDelay')) || 500;
        const optionDelay = Number(this.getConfig('optionDelay')) || 800;
        const stripPrefix = this.getConfig('stripPrefix') !== false;
        const prefix = this.getConfig('optionPrefix') || '';

        (async () => {
            for (let i = 0; i < options.length; i++) {
                try {
                    await this._delay(i === 0 ? initialDelay : optionDelay);

                    const text = stripPrefix ? options[i].content : options[i].raw;
                    if (!text) continue;

                    const optMsg = new OutboundMessage({
                        platform: originalMessage.platform,
                        chatId: originalMessage.chatId,
                        chatType: originalMessage.chatType,
                        content: `${prefix}${text}`,
                        replyToId: '',
                    });

                    // R1+R2: 绕过过滤器链 + 跳过去重检查
                    await gateway.sendDirect(optMsg, {
                        bypassFilters: true,
                        skipDedup: true,
                    });
                    this.logger.debug(`已补发选项 ${i + 1}/${options.length}`);
                } catch (err) {
                    this.logger.error(`补发选项 ${i + 1} 失败: ${err.message}`);
                }
            }
        })();
    }

    _delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // ==================== 命令处理 ====================

    async handleOption(ctx) {
        const sub = (ctx.args[0] || 'help').toLowerCase();
        switch (sub) {
            case 'list':
            case '状态':
                return this._cmdList(ctx);
            case 'on':
                this.setConfig('enabled', true);
                return ctx.reply('✅ 选项拆分已开启');
            case 'off':
                this.setConfig('enabled', false);
                return ctx.reply('❌ 选项拆分已关闭');
            case 'test':
            case '测试':
                return this._cmdTest(ctx);
            case 'help':
            case '帮助':
            default:
                return this._cmdHelp(ctx);
        }
    }

    async _cmdList(ctx) {
        const p = this.getConfig('applyToPlatforms') || [];
        return ctx.reply(
            [
                '📋 选项拆分发送 - 当前配置',
                `  启用: ${this.getConfig('enabled') !== false ? '✅' : '❌'}`,
                `  提取正则: ${this.getConfig('extractPattern') || '(默认 >选项X：)'}`,
                `  选项标签: <${this.getConfig('optionsTag') || 'options'}>`,
                `  发送策略: ${this.getConfig('outputFormat') || 'sequential'}`,
                `  首选项延迟: ${this.getConfig('initialDelay') ?? 500} ms`,
                `  选项间间隔: ${this.getConfig('optionDelay') ?? 800} ms`,
                `  去前缀: ${this.getConfig('stripPrefix') !== false ? '是' : '否'}`,
                `  选项前缀: "${this.getConfig('optionPrefix') || ''}"`,
                `  生效平台: ${p.length ? p.join(', ') : '全部'}`,
            ].join('\n')
        );
    }

    async _cmdTest(ctx) {
        const sample = [
            '「唔……徒儿早啊。」',
            '声音里带着一丝慵懒的鼻音，从神念中传来。',
            '',
            '<options>',
            '>选项一：以神念回应：弟子只是习惯了早起，师尊您继续休息。',
            '>选项二：以神念回应：弟子打扰师尊清梦了？',
            '>选项三：以神念回应：想早点跟师尊问安。',
            '>选项四：以神念调笑道：弟子是想看看有没有机会偷袭赖床的师尊。',
            '</options>',
            '',
            '>╒═══════════════',
            '💗师尊内心戏：嘿嘿，其实早就醒了。',
            '>🌎师尊当前所在地点：寒月宫-寝殿-床上 - ☀️',
            '╘═══════════════',
        ].join('\n');

        const { options, mainText } = this._extractFromContent(sample);
        const strip = this.getConfig('stripPrefix') !== false;

        const lines = [
            '🧪 解析测试',
            '',
            '── 正文（将作为第一条消息发送）──',
            mainText || '(空)',
            '',
            `── 选项 ${options.length} 条（将逐条发送）──`,
        ];
        options.forEach((o, i) => lines.push(`  ${i + 1}. ${strip ? o.content : o.raw}`));
        return ctx.reply(lines.join('\n'));
    }

    async _cmdHelp(ctx) {
        return ctx.reply(
            [
                '🔧 选项拆分发送 v2.0 命令:',
                '',
                '/option list - 查看当前配置',
                '/option on | off - 开启 / 关闭拆分',
                '/option test - 用示例文本测试解析效果',
                '',
                '💡 配置可通过面板「插件管理」中的配置按钮修改',
                '💡 支持自定义提取正则、可配置标签名、多种发送策略',
                '💡 提示词需用 <options> 标签包裹选项（>选项一：... 格式）',
                '💡 幕后信息（内心戏、地点等）属于正文，不得放入 <options>',
            ].join('\n')
        );
    }
}
