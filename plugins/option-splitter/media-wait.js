/**
 * 图片发送完成等待模块（纯函数，零外部依赖，可独立单元测试）
 *
 * 解决的跨插件时序问题：
 *   选项拆分插件拆出 "选项X" 后立即按固定延迟补发，但正文可能正被
 *   message-to-image 插件渲染成多张图片（渲染 + 逐页发送耗时数秒）——
 *   导致"选项先于正文图片出现"的乱序。
 *
 * 协作约定（软契约，不硬依赖对方插件）：
 *   1. option-splitter 在出站消息 metadata 上写入 _mediaWaitKey（本次唯一的键）
 *   2. message-to-image 完成全部图片发送后（或确定不会渲染/渲染失败时），
 *      在网关 EventEmitter 上 emit('media-sent', { key, platform, chatId, count, success })
 *   3. option-splitter 监听该事件，key 匹配即视为"图片已发完"，再开始补发选项；
 *      超时未收到信号则兜底直接补发（message-to-image 未启用/未安装等场景）
 */

/** 网关事件总线上用于通知"媒体发送流程已结束"的事件名 */
export const MEDIA_SENT_EVENT = 'media-sent';
/** 出站消息 metadata 上承载等待键的字段名 */
export const MEDIA_WAIT_KEY = '_mediaWaitKey';
/** message-to-image 出站过滤器的注册名（软探测：过滤链中存在即认为会产生图片） */
export const IMAGE_PLUGIN_FILTER_NAME = 'message-to-image';

/**
 * 生成一次唯一的等待键。
 * 与消息一一对应：message-to-image 完成后会原样带回该键，
 * 选项拆分插件凭它区分"哪条消息的图片发完了"。
 * @returns {string}
 */
export function createMediaWaitKey() {
    return `ow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 判断本次消息是否需要等待图片发送完成。
 *
 * 仅在"正文非空（正文会被渲染成图片）"且"过滤链中存在 message-to-image"时等待；
 * 其余情况（纯选项消息 / 过滤链中无图片插件 / 网关不可用）直接走原有补发流程，
 * 避免无谓的空等（没有图片可等时不能白白拖住选项）。
 *
 * @param {object} gateway - 网关实例（读取 outboundFilters 探测过滤链）
 * @param {boolean} hasMainText - 是否有正文（正文才可能被渲染成图片）
 * @returns {boolean}
 */
export function shouldWaitForMedia(gateway, hasMainText) {
    if (!hasMainText) return false;
    if (!gateway) return false;
    // 能探测过滤链且其中没有 message-to-image → 正文不会被渲染成图片，无需等待
    if (Array.isArray(gateway.outboundFilters) &&
        !gateway.outboundFilters.some(f => f && f.name === IMAGE_PLUGIN_FILTER_NAME)) {
        return false;
    }
    // 链中存在 message-to-image（或网关不可探测，按存在处理，由超时兜底）→ 等待
    return true;
}

/**
 * 监听 media-sent 事件，直到 key 匹配或超时。
 *
 * @param {object} emitter - 事件发射器（需实现 on/off），通常为网关实例
 * @param {string} key - 本次等待键（消息 metadata 上的 _mediaWaitKey）
 * @param {number} timeoutMs - 超时毫秒数，超时视为"图片不会来了"，返回 false
 * @param {string} eventName - 事件名，默认 MEDIA_SENT_EVENT
 * @returns {Promise<boolean>} true=已收到匹配的完成信号；false=超时或发射器不可用
 */
export function waitForMediaSent(emitter, key, timeoutMs, eventName = MEDIA_SENT_EVENT) {
    if (!emitter || typeof emitter.on !== 'function' || typeof emitter.off !== 'function') {
        return Promise.resolve(false);
    }
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            emitter.off(eventName, handler);
            resolve(ok);
        };
        // 监听器同步注册，保证不丢事件（调用方在 await 之前就已挂上）
        const handler = (payload) => {
            if (payload && payload.key === key) finish(true);
        };
        const timer = setTimeout(() => finish(false), Math.max(0, Number(timeoutMs) || 0));
        emitter.on(eventName, handler);
    });
}
