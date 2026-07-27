/**
 * AstrBot 移植示范插件
 *
 * 展示一个典型 AstrBot 插件移植到本网关后的样子。用 server/compat 兼容层，
 * 把 AstrBot 的 Python 写法逐行翻译成 JS：
 *
 *   AstrBot (Python)                          本插件 (JS)
 *   ─────────────────────────────────────────────────────────────
 *   class Weather(Star):                      class WeatherSkill extends Star
 *   async def initialize(self):               async initialize()
 *   @filter.command("hello")                  static commands = [defineCommand('hello', ...)]
 *   async def hello(self, event):             async *hello(event)
 *       yield event.plain_result(...)             yield event.plain_result(...)
 *   @filter.llm_tool("查天气")                 static get llm_tools() { return [defineLLMTool(...)] }
 *   import ...message_components as Comp       import { Plain, Image, At } from compat
 *   event.chain_result([Comp.Plain(...), ...])  event.chain_result([new Plain(...), ...])
 *
 * 需要 "llm" 权限（agent 部分调用 LLM，拿不到 API key）。
 * 迁移完整对照见 docs/PLUGIN_DEVELOPMENT_GUIDE.md 第 16 节。
 */

import {
    Star, defineCommand, defineLLMTool,
    Plain, Image, At,
} from '../../server/compat/index.js';

export default class WeatherSkill extends Star {
    // === 命令声明（等价 AstrBot 的 @filter.command） ===
    static commands = [
        defineCommand('greet', {
            alias: ['打招呼'],
            handler: 'greet',
            description: '用配置的问候语打招呼（演示生成器 + 组件链）',
            usage: '/greet',
        }),
        defineCommand('weather', {
            alias: ['天气'],
            handler: 'weatherCmd',
            description: '让 Agent 查天气后作答（演示 llm_tool + runTools）',
            usage: '/weather <城市>',
        }),
    ];

    // === LLM 工具声明（等价 AstrBot 的 @filter.llm_tool） ===
    static get llm_tools() {
        return [
            defineLLMTool(
                'get_weather',
                '查询某城市的当前天气',
                {
                    type: 'object',
                    properties: { city: { type: 'string', description: '城市名' } },
                    required: ['city'],
                },
                'getWeather', // 执行器方法名
            ),
        ];
    }

    // === 生命周期（等价 AstrBot 的 async initialize / terminate） ===
    async initialize() {
        this.logger.info('WeatherSkill 已加载（AstrBot 移植示范）');
    }

    async terminate() {
        this.logger.info('WeatherSkill 已卸载');
    }

    // === 生成器命令 handler（等价 AstrBot 的 async def + yield） ===
    // 兼容层自动 drain 这个生成器，把每次 yield 出的 result 依次发送。
    async *greet(event) {
        const greeting = this.getConfig('greeting') || '你好';
        // 直接文本结果
        yield event.plain_result(`${greeting}, ${event.get_sender_name()}!`);
        // 组件链结果：@ 用户 + 文本
        yield event.chain_result([
            new At(event.get_sender_id()),
            new Plain(' 这是一条用消息组件链发出的消息 👋'),
        ]);
    }

    // === 工具执行器（等价 AstrBot 中被 @llm_tool 装饰的函数体） ===
    // executeTool 默认会按 llm_tools 声明的 _handler 路由到这里。
    async getWeather({ city }) {
        this.logger.info(`查询天气: ${city}`);
        // 真实插件在此调用天气 API；示范返回假数据
        return { city, weather: '晴', temperature: '30℃', humidity: '45%' };
    }

    // === 使用 runTools 的 agent 命令（普通 handler，非生成器） ===
    async weatherCmd(ctx) {
        const city = ctx.args.join(' ').trim();
        if (!city) return ctx.reply('用法: /weather <城市>');

        try {
            const { text } = await ctx.llm.runTools(
                [
                    { role: 'system', content: '你是天气助手，可用 get_weather 工具查天气，用中文简洁作答。' },
                    { role: 'user', content: `${city}的天气怎么样？` },
                ],
                this.tools, // 由 static llm_tools 自动构建
                (name, args) => this.executeTool(name, args),
                { maxSteps: this.getConfig('maxSteps') || 5 },
            );
            return ctx.reply(text);
        } catch (e) {
            this.logger.error(`天气查询失败: ${e.message}`);
            return ctx.reply(`抱歉，查询失败：${e.message}`);
        }
    }
}
