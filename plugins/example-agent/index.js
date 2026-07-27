/**
 * 工具调用 Agent 示例插件
 *
 * 演示 ctx.llm.runTools：声明一组工具交给模型，模型自主决定调用哪些、
 * 用什么参数，网关执行后把结果回灌，循环直到模型给出最终答复。
 *
 * 这是移植 AstrBot agent 型 / 联网搜索类插件的参考样板：把 AstrBot 里
 * 用 @llm_tool 装饰的函数，改写成这里 tools 数组 + executor 分支即可。
 *
 * 需要 "llm" 权限（拿不到 API key，消耗网关配置的额度）。
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class AgentExamplePlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'ask',
            alias: ['问'],
            handler: 'handleAsk',
            description: '向 Agent 提问，它会自主调用工具后作答',
            usage: '/ask <问题>',
        },
    ];

    // 工具声明：name/description/parameters(JSON Schema)。三 provider 通用。
    get tools() {
        return [
            {
                name: 'get_weather',
                description: '查询某城市的当前天气',
                parameters: {
                    type: 'object',
                    properties: { city: { type: 'string', description: '城市名' } },
                    required: ['city'],
                },
            },
            {
                name: 'calculate',
                description: '计算一个数学表达式',
                parameters: {
                    type: 'object',
                    properties: { expr: { type: 'string', description: '如 (3+4)*2' } },
                    required: ['expr'],
                },
            },
        ];
    }

    /**
     * 工具执行器：模型请求调用某工具时，网关回调这里。
     * 返回值（对象/字符串）会被序列化回灌给模型。
     */
    async executeTool(name, args) {
        this.logger.info(`模型调用工具 ${name}(${JSON.stringify(args)})`);
        switch (name) {
            case 'get_weather':
                // 真实插件在此调用天气 API；示例返回假数据
                return { city: args.city, weather: '晴', temperature: '30℃' };
            case 'calculate':
                return { expr: args.expr, result: this._safeCalc(args.expr) };
            default:
                return { error: `未知工具: ${name}` };
        }
    }

    async handleAsk(ctx) {
        const question = ctx.args.join(' ').trim();
        if (!question) return ctx.reply('用法: /ask <问题>');

        try {
            const { text, steps } = await ctx.llm.runTools(
                [
                    { role: 'system', content: '你是助手，可用工具查天气或计算。用中文简洁作答。' },
                    { role: 'user', content: question },
                ],
                this.tools,
                (name, args) => this.executeTool(name, args),
                { maxSteps: this.getConfig('maxSteps') || 5 },
            );
            this.logger.info(`Agent 用了 ${steps} 轮工具`);
            return ctx.reply(text);
        } catch (e) {
            this.logger.error(`Agent 调用失败: ${e.message}`);
            return ctx.reply(`抱歉，处理失败：${e.message}`);
        }
    }

    /** 仅允许数字与 + - * / ( ) . 的极简安全计算，杜绝任意代码执行 */
    _safeCalc(expr) {
        if (!/^[\d+\-*/().\s]+$/.test(String(expr))) return '表达式含非法字符';
        try {
            // eslint-disable-next-line no-new-func
            const val = Function(`"use strict"; return (${expr});`)();
            return Number.isFinite(val) ? val : '无法计算';
        } catch (_) {
            return '表达式错误';
        }
    }
}
