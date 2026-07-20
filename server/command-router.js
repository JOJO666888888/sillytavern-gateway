/**
 * Command Router - 命令路由器
 * 解析 /command 格式消息，分发到对应插件处理器
 */

import { createLogger } from './utils/logger.js';
import { PluginContext } from './plugin-context.js';

const logger = createLogger('command-router');

/**
 * 命令路由器
 */
export class CommandRouter {
    constructor() {
        // commandName -> handler 映射
        this.commands = new Map();
        // alias -> commandName 映射
        this.aliases = new Map();

        // 注册内置命令
        this.registerBuiltinCommands();
    }

    /**
     * 注册命令
     * @param {object} cmd
     * @param {string} cmd.name - 命令名（不含 /）
     * @param {string[]} cmd.alias - 别名列表
     * @param {string} cmd.description - 描述
     * @param {string} cmd.usage - 用法说明
     * @param {string} cmd.pluginName - 所属插件名
     * @param {Function} cmd.handler - 处理函数 (ctx) => void
     */
    register(cmd) {
        const entry = {
            name: cmd.name.toLowerCase(),
            alias: (cmd.alias || []).map(a => a.toLowerCase()),
            description: cmd.description || '',
            usage: cmd.usage || '',
            pluginName: cmd.pluginName || 'system',
            handler: cmd.handler,
        };

        this.commands.set(entry.name, entry);

        // 注册别名
        for (const alias of entry.alias) {
            this.aliases.set(alias, entry.name);
        }

        logger.debug(`命令已注册: /${entry.name}${entry.alias.length ? ` (别名: ${entry.alias.join(', ')})` : ''}`);
    }

    /**
     * 注销指定插件的所有命令
     * @param {string} pluginName
     */
    unregisterByPlugin(pluginName) {
        for (const [name, cmd] of this.commands) {
            if (cmd.pluginName === pluginName) {
                // 移除别名
                for (const alias of cmd.alias) {
                    this.aliases.delete(alias);
                }
                this.commands.delete(name);
                logger.debug(`命令已注销: /${name}`);
            }
        }
    }

    /**
     * 处理命令消息
     * @param {import('./adapters/base-adapter.js').InboundMessage} message
     * @param {object} services - 服务引用
     * @returns {Promise<boolean>} 是否成功处理
     */
    async handle(message, services = {}) {
        const content = message.content.trim();
        if (!content.startsWith('/')) return false;

        // 解析命令名和参数
        const parts = content.slice(1).split(/\s+/);
        const commandName = parts[0].toLowerCase();
        const args = parts.slice(1);

        // 查找命令（先查命令名，再查别名）
        let cmd = this.commands.get(commandName);
        if (!cmd) {
            const realName = this.aliases.get(commandName);
            if (realName) {
                cmd = this.commands.get(realName);
            }
        }

        if (!cmd) {
            // 未知命令 - 不处理，让消息继续流转
            return false;
        }

        // 构建上下文
        const ctx = new PluginContext({
            message,
            gateway: services.gateway,
            sessionManager: services.sessionManager,
            configManager: services.configManager,
            pluginName: cmd.pluginName,
            commandArgs: args,
        });
        ctx.commandName = cmd.name;
        ctx.args = args;

        try {
            await cmd.handler(ctx);
            logger.info(`命令执行: /${cmd.name} ${args.join(' ')} [by ${message.senderName}]`);
            return true;
        } catch (error) {
            logger.error(`命令 /${cmd.name} 执行失败: ${error.message}`);
            // 回复错误信息
            try {
                await ctx.reply(`命令执行出错: ${error.message}`);
            } catch (_) { /* ignore */ }
            return true;
        }
    }

    /**
     * 获取所有已注册命令列表
     */
    listCommands() {
        const list = [];
        for (const [name, cmd] of this.commands) {
            list.push({
                name: `/${name}`,
                alias: cmd.alias.map(a => `/${a}`),
                description: cmd.description,
                usage: cmd.usage,
                plugin: cmd.pluginName,
            });
        }
        return list;
    }

    /**
     * 注册内置命令
     */
    registerBuiltinCommands() {
        // /help 命令
        this.register({
            name: 'help',
            alias: ['帮助'],
            description: '显示所有可用命令',
            usage: '/help [命令名]',
            pluginName: 'system',
            handler: async (ctx) => {
                if (ctx.args.length > 0) {
                    // 显示特定命令帮助
                    const target = ctx.args[0].toLowerCase().replace(/^\//, '');
                    const cmd = this.commands.get(target) ||
                        this.commands.get(this.aliases.get(target));
                    if (cmd) {
                        const lines = [
                            `/${cmd.name} - ${cmd.description}`,
                            cmd.usage ? `用法: ${cmd.usage}` : '',
                            cmd.alias.length ? `别名: ${cmd.alias.map(a => '/' + a).join(', ')}` : '',
                            `来源: ${cmd.pluginName}`,
                        ].filter(Boolean);
                        return ctx.reply(lines.join('\n'));
                    }
                    return ctx.reply(`未找到命令: /${target}`);
                }

                // 列出所有命令
                const lines = ['📋 可用命令:', ''];
                for (const [name, cmd] of this.commands) {
                    lines.push(`/${name} - ${cmd.description || '无描述'}`);
                }
                lines.push('', '使用 /help <命令名> 查看详情');
                return ctx.reply(lines.join('\n'));
            },
        });

        // /status 命令
        this.register({
            name: 'status',
            alias: ['状态'],
            description: '查看网关状态',
            pluginName: 'system',
            handler: async (ctx) => {
                if (!ctx._gateway) return ctx.reply('网关未就绪');
                const status = ctx._gateway.getStatus();
                const lines = ['🔌 网关状态:', ''];
                for (const [name, s] of Object.entries(status.adapters)) {
                    lines.push(`  ${name}: ${s.state || 'unknown'}`);
                }
                lines.push('', `队列: ${status.queue?.pending || 0} 待发送`);
                return ctx.reply(lines.join('\n'));
            },
        });

        // /clear 命令
        this.register({
            name: 'clear',
            alias: ['清空'],
            description: '清空当前会话历史',
            pluginName: 'system',
            handler: async (ctx) => {
                ctx.clearHistory();
                return ctx.reply('✅ 会话历史已清空');
            },
        });
    }
}

export default CommandRouter;
