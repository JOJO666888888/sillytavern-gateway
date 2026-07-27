/**
 * 定时任务示例插件
 *
 * 展示如何用 `static schedules` 声明定时任务，以及在任务里：
 *   - 主动向指定会话推送消息（ctx.send）
 *   - 调用网关配置的 LLM 生成内容（ctx.llm，需 "llm" 权限）
 *
 * cron 为 5 段：分 时 日 月 周。调度器每分钟轮询一次，按分钟触发。
 * 这是移植 AstrBot「定时任务」类插件的参考样板。
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class SchedulerExamplePlugin extends GatewayPlugin {
    // 定时任务注册
    static schedules = [
        {
            cron: '0 9 * * *',           // 每天 09:00
            handler: 'morningReport',
            description: '每日早报',
        },
        {
            cron: '*/30 * * * *',        // 每 30 分钟
            handler: 'heartbeat',
            description: '心跳日志',
        },
    ];

    /**
     * 每日早报：调用 LLM 生成一句问候，推送到配置的目标会话。
     * 定时任务的 ctx 没有入站消息，用 ctx.send(platform, chatId, text) 主动推送。
     */
    async morningReport(ctx) {
        const platform = this.getConfig('targetPlatform');
        const chatId = this.getConfig('targetChatId');
        if (!platform || !chatId) {
            this.logger.info('[早报] 未配置推送目标，跳过推送');
            return;
        }

        let text = '早上好！新的一天开始了 ☀️';
        try {
            // 需要 "llm" 权限；未授予时 ctx.llm.chat 会抛错，被调度器捕获隔离
            text = await ctx.llm.chat([
                { role: 'user', content: '用一句温暖的话向群友道早安，20 字以内。' },
            ]);
        } catch (e) {
            this.logger.warn(`[早报] LLM 调用失败，用默认文案: ${e.message}`);
        }

        await ctx.send(platform, chatId, text, { chatType: 'group' });
        this.logger.info(`[早报] 已推送到 ${platform}/${chatId}`);
    }

    /**
     * 心跳：仅记录日志，演示无需推送/LLM 的轻量定时任务。
     */
    async heartbeat() {
        this.logger.debug('[心跳] 调度器正常运行');
    }
}
