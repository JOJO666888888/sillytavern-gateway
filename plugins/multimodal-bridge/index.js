/**
 * 多模态桥接插件
 *
 * 把收到的图片交给网关配置的多模态 LLM「看图说话」：
 *   - /describe             手动描述本条消息里的图片
 *   - 可选：私聊（或群聊）收到图片时自动描述
 *
 * 依赖 LLM 的多模态能力：把图片作为 { type:'image', url } part 拼进 user 消息，
 * 由 LLMClient 翻译成各 provider 的多模态格式。若配置的模型不支持多模态，
 * 调用会失败并回友好提示。
 *
 * 需要 "llm" 权限（拿不到 API key）。
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class MultimodalBridgePlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'describe',
            alias: ['看图', '描述'],
            handler: 'handleDescribe',
            description: '描述消息中的图片',
            usage: '（在带图消息上）/describe',
        },
    ];

    static listeners = [
        { event: 'message', filter: {}, handler: 'onMessage', priority: 160 },
    ];

    async handleDescribe(ctx) {
        const images = this._extractImages(ctx.message);
        if (!images.length) return ctx.reply('没有检测到图片。请在带图片的消息上使用 /describe');
        return this._describe(ctx, images);
    }

    async onMessage(ctx) {
        if (!this.getConfig('autoDescribe')) return;
        const isGroup = ctx.chatType === 'group' || ctx.chatType === 'channel';
        if (isGroup && !this.getConfig('autoInGroup')) return;

        const images = this._extractImages(ctx.message);
        if (!images.length) return;

        await this._describe(ctx, images);
        ctx.stopPropagation();
    }

    /** 从入站消息里抽取图片 URL（media 带类型；回退到 mediaUrls） */
    _extractImages(message) {
        if (!message) return [];
        const urls = [];
        for (const m of message.media || []) {
            if (m.type === 'image' && (m.url || m.localPath)) {
                urls.push(m.url || `file://${m.localPath}`);
            }
        }
        return urls;
    }

    async _describe(ctx, imageUrls) {
        const prompt = this.getConfig('prompt') || '请描述这张图片。';
        // 多模态 user 消息：文本 + 若干图片 part
        const parts = [
            { type: 'text', text: prompt },
            ...imageUrls.map(url => ({ type: 'image', url })),
        ];

        try {
            const reply = await ctx.llm.chat(
                [{ role: 'user', content: parts }],
                { max_tokens: this.getConfig('maxTokens') ?? 512 },
            );
            return ctx.reply(reply);
        } catch (e) {
            this.logger.error(`图片描述失败: ${e.message}`);
            return ctx.reply(`抱歉，无法描述图片：${e.message}（请确认已配置支持多模态的模型）`);
        }
    }
}
