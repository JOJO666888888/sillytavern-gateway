/**
 * Hello World 示例插件
 * 展示命令注册、消息监听、配置使用
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class HelloPlugin extends GatewayPlugin {
    // 命令注册
    static commands = [
        {
            name: 'hello',
            alias: ['你好', '嗨'],
            handler: 'handleHello',
            description: '打个招呼',
            usage: '/hello [名字]',
        },
        {
            name: 'ping',
            alias: [],
            handler: 'handlePing',
            description: '测试插件是否在线',
            usage: '/ping',
        },
    ];

    // 消息监听器注册
    static listeners = [
        {
            event: 'message',
            filter: {},  // 监听所有消息
            handler: 'onAnyMessage',
            priority: 200,  // 低优先级，不干扰其他插件
        },
    ];

    async onLoad() {
        this.logger.info('Hello World 插件已加载！');
    }

    async onUnload() {
        this.logger.info('Hello World 插件已卸载');
    }

    /**
     * /hello 命令处理
     */
    async handleHello(ctx) {
        const name = ctx.args[0] || ctx.senderName || '世界';
        const greeting = this.getConfig('greeting') || '你好';
        return ctx.reply(`${greeting}, ${name}! 👋`);
    }

    /**
     * /ping 命令处理
     */
    async handlePing(ctx) {
        const start = Date.now();
        await ctx.reply('🏓 Pong!');
        this.logger.info(`Ping 响应耗时: ${Date.now() - start}ms`);
    }

    /**
     * 监听所有消息（仅记录日志，不处理）
     */
    async onAnyMessage(ctx) {
        // 仅做日志记录，不标记 handled，让消息继续流转
        this.logger.debug(`[监听] ${ctx.platform}/${ctx.chatId}: ${ctx.senderName}: ${ctx.content.substring(0, 30)}`);
    }
}
