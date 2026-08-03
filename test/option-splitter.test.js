/**
 * option-splitter 图片等待时序（跨插件协作）单元测试
 *
 * 守护的核心不变量：
 *   1. media-wait 纯函数：等待键唯一、是否需要等待的判定矩阵、事件监听（匹配/忽略/超时/清理）
 *   2. 时序闸门：正文被 message-to-image 渲染成图片时，选项补发必须等
 *      "全部图片发送完成"（media-sent 事件）后再进行 —— 图片先、选项后
 *   3. 兜底：超时 / 无图片插件 / 纯选项消息时，不空等，直接走原有补发流程
 *   4. message-to-image 侧：完成渲染后发 count>0 信号；未渲染/失败时发 count:0 信号；
 *      无等待键的消息不发任何事件（零开销）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { sleep } from './helpers.js';

import OptionSplitterPlugin from '../plugins/option-splitter/index.js';
import MessageToImagePlugin from '../plugins/message-to-image/index.js';
import {
    MEDIA_SENT_EVENT,
    MEDIA_WAIT_KEY,
    createMediaWaitKey,
    shouldWaitForMedia,
    waitForMediaSent,
} from '../plugins/option-splitter/media-wait.js';

/** 静默 logger，避免测试输出被日志淹没 */
const silentLogger = {
    info() {}, warn() {}, error() {}, debug() {},
    child() { return silentLogger; },
};

/**
 * 最小网关替身：实现 EventEmitter 子集（on/off/emit）+ sendDirect + 出站过滤链，
 * 用于在测试中精确控制"图片完成信号"的发出时机。
 */
class FakeGateway {
    constructor(filters = []) {
        this.outboundFilters = filters;   // [{ name, priority, filter }]
        this.sent = [];                   // sendDirect 发送记录（按顺序）
        this.emitted = [];                // emit 记录（事件名 + 载荷）
        this._listeners = new Map();
    }

    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(handler);
    }

    off(event, handler) {
        const list = this._listeners.get(event);
        if (!list) return;
        const i = list.indexOf(handler);
        if (i > -1) list.splice(i, 1);
    }

    emit(event, payload) {
        this.emitted.push({ event, payload });
        const list = this._listeners.get(event) || [];
        for (const h of [...list]) h(payload);
        return true;
    }

    listenerCount(event) {
        return (this._listeners.get(event) || []).length;
    }

    async sendDirect(msg, opts = {}) {
        msg.metadata = msg.metadata || {};
        if (opts.bypassFilters) msg.metadata._bypassFilters = true;
        this.sent.push(msg);
        return true;
    }

    /** 复刻网关 applyOutboundFilters：按优先级升序执行，任一返回 null 即丢弃 */
    applyOutboundFilters(message) {
        let msg = message;
        for (const entry of this.outboundFilters) {
            msg = entry.filter(msg);
            if (msg === null) return null;
        }
        return msg;
    }
}

/** 构造 option-splitter 插件实例（注入 FakeGateway） */
function makeSplitter(gw, config = {}) {
    const plugin = new OptionSplitterPlugin({
        name: 'option-splitter',
        pluginConfig: config,
        services: { gateway: gw },
    });
    plugin.logger = silentLogger;
    return plugin;
}

/** 构造 message-to-image 插件实例（注入 FakeGateway） */
function makeM2i(gw, config = {}) {
    const plugin = new MessageToImagePlugin({
        name: 'message-to-image',
        pluginConfig: config,
        services: { gateway: gw },
    });
    plugin.logger = silentLogger;
    return plugin;
}

// ====================================================================
// 1. media-wait.js 纯函数
// ====================================================================

describe('media-wait: createMediaWaitKey / shouldWaitForMedia', () => {
    test('等待键唯一且格式符合前缀约定', () => {
        const a = createMediaWaitKey();
        const b = createMediaWaitKey();
        assert.notStrictEqual(a, b);
        assert.match(a, /^ow-[a-z0-9-]+$/i);
    });

    test('shouldWaitForMedia 判定矩阵', () => {
        // 无正文 → 不等待
        assert.strictEqual(shouldWaitForMedia(new FakeGateway([{ name: 'message-to-image' }]), false), false);
        // 网关不可用 → 不等待
        assert.strictEqual(shouldWaitForMedia(null, true), false);
        // 过滤链为空 / 无 message-to-image → 不等待
        assert.strictEqual(shouldWaitForMedia(new FakeGateway([]), true), false);
        assert.strictEqual(shouldWaitForMedia(new FakeGateway([{ name: 'other-plugin' }]), true), false);
        // 链中存在 message-to-image → 等待
        assert.strictEqual(shouldWaitForMedia(new FakeGateway([{ name: 'message-to-image' }]), true), true);
        // 网关无 outboundFilters 属性（不可探测）→ 按存在处理，等待（由超时兜底）
        assert.strictEqual(shouldWaitForMedia({}, true), true);
    });
});

describe('media-wait: waitForMediaSent', () => {
    test('key 匹配的事件触发完成（resolve true）', async () => {
        const gw = new FakeGateway();
        const key = createMediaWaitKey();
        const p = waitForMediaSent(gw, key, 500);
        gw.emit(MEDIA_SENT_EVENT, { key, count: 3, success: true });
        assert.strictEqual(await p, true);
    });

    test('不匹配的 key 被忽略，匹配后才完成', async () => {
        const gw = new FakeGateway();
        const p = waitForMediaSent(gw, 'k1', 500);
        gw.emit(MEDIA_SENT_EVENT, { key: 'other' });
        assert.strictEqual(gw.listenerCount(MEDIA_SENT_EVENT), 1, '未匹配前监听器仍在');
        gw.emit(MEDIA_SENT_EVENT, { key: 'k1' });
        assert.strictEqual(await p, true);
    });

    test('超时返回 false 并清理监听器', async () => {
        const gw = new FakeGateway();
        const res = await waitForMediaSent(gw, 'k1', 20);
        assert.strictEqual(res, false);
        assert.strictEqual(gw.listenerCount(MEDIA_SENT_EVENT), 0, '超时后监听器应被移除');
    });

    test('完成后监听器被清理（不再泄漏）', async () => {
        const gw = new FakeGateway();
        const key = createMediaWaitKey();
        const p = waitForMediaSent(gw, key, 500);
        gw.emit(MEDIA_SENT_EVENT, { key });
        await p;
        assert.strictEqual(gw.listenerCount(MEDIA_SENT_EVENT), 0);
    });

    test('发射器不可用（无 on/off）时立即返回 false', async () => {
        assert.strictEqual(await waitForMediaSent(null, 'k1', 20), false);
        assert.strictEqual(await waitForMediaSent({}, 'k1', 20), false);
    });
});

// ====================================================================
// 2. option-splitter 时序闸门
// ====================================================================

describe('option-splitter: 等待图片发送完成后再补发选项', () => {
    const body = '酒馆里灯火通明，旅人推门而入。';
    const content = `${body}\n\n>选项一：向酒保打听消息\n>选项二：独自坐在角落观察`;

    function setupSplitterChain(gw, splitter, m2i) {
        // 与真实网关一致的过滤器链：option-splitter(5) → message-to-image(20)
        gw.outboundFilters = [
            { name: 'option-splitter', priority: 5, filter: (m) => splitter.filterOutbound(m) },
            { name: 'message-to-image', priority: 20, filter: (m) => m2i ? m2i.filterOutbound(m) : m },
        ];
    }

    test('端到端顺序：图片全部发送完成前不补发选项；完成后选项按序发送', async () => {
        const gw = new FakeGateway();
        const splitter = makeSplitter(gw, {
            outputFormat: 'sequential', initialDelay: 1, optionDelay: 1, mediaWaitTimeout: 5000,
        });
        const m2i = makeM2i(gw, {
            enabled: true, renderMode: 'always', applyToPlatforms: [],
        });
        // 桩渲染器挂起：图片发送由本测试手动控制，才能精确验证"信号前不补发、信号后补发"
        m2i._renderer = { ready: true, render: () => new Promise(() => {}) };

        setupSplitterChain(gw, splitter, m2i);

        const msg = { platform: 'qq', chatId: 'c1', chatType: 'private', content };
        const result = gw.applyOutboundFilters(msg);

        // 正文被 option-splitter 接管（返回 null，等图片完成后补发选项）
        assert.strictEqual(result, null);
        // 等待键已写入消息 metadata（供 message-to-image 完成后回带）
        assert.ok(msg.metadata[MEDIA_WAIT_KEY], '应写入等待键');

        // 尚未到图片发送完成的时刻 → 选项不得提前发出
        await sleep(30);
        assert.strictEqual(gw.sent.length, 0, '图片未发完前选项不应出现');

        // 模拟 message-to-image 先逐页补发 2 张图片，再发出完成信号
        await gw.sendDirect({ platform: 'qq', chatId: 'c1', chatType: 'private', content: '', mediaUrls: ['file:///a.png'] });
        await gw.sendDirect({ platform: 'qq', chatId: 'c1', chatType: 'private', content: '', mediaUrls: ['file:///b.png'] });
        gw.emit(MEDIA_SENT_EVENT, {
            key: msg.metadata[MEDIA_WAIT_KEY], platform: 'qq', chatId: 'c1', count: 2, success: true,
        });
        await sleep(50);

        // 顺序：2 张图片在前，2 条选项在后
        assert.strictEqual(gw.sent.length, 4, '应发送 2 图片 + 2 选项');
        assert.strictEqual(gw.sent[0].mediaUrls.length, 1, '第 1 条应为图片');
        assert.strictEqual(gw.sent[1].mediaUrls.length, 1, '第 2 条应为图片');
        assert.strictEqual(gw.sent[2].content, '选项一：向酒保打听消息');
        assert.strictEqual(gw.sent[3].content, '选项二：独自坐在角落观察');
    });

    test('真实链式执行：message-to-image 异步渲染完成后自动触发选项补发（无需手动 emit）', async () => {
        const gw = new FakeGateway();
        const splitter = makeSplitter(gw, {
            outputFormat: 'sequential', initialDelay: 1, optionDelay: 1, mediaWaitTimeout: 5000,
        });
        const m2i = makeM2i(gw, {
            enabled: true, renderMode: 'always', applyToPlatforms: [],
        });
        m2i._renderer = { ready: true, render: async () => ['file:///a.png', 'file:///b.png'] };
        m2i._delay = async () => {};
        setupSplitterChain(gw, splitter, m2i);

        const msg = { platform: 'qq', chatId: 'c1', chatType: 'private', content };
        gw.applyOutboundFilters(msg);

        // 等异步链路自然跑完：渲染 → 逐页发送 → emit media-sent → 选项补发
        await sleep(80);

        assert.strictEqual(gw.sent.length, 4, '应发送 2 图片 + 2 选项');
        assert.strictEqual(gw.sent[0].mediaUrls.length, 1);
        assert.strictEqual(gw.sent[1].mediaUrls.length, 1);
        assert.strictEqual(gw.sent[2].content, '选项一：向酒保打听消息');
        assert.strictEqual(gw.sent[3].content, '选项二：独自坐在角落观察');
        // 完成后事件信号已发出（count:2 success:true）
        const doneSignal = gw.emitted.find(e => e.event === MEDIA_SENT_EVENT);
        assert.ok(doneSignal, '应发出 media-sent 完成信号');
        assert.strictEqual(doneSignal.payload.count, 2);
        assert.strictEqual(doneSignal.payload.success, true);
    });

    test('渲染失败：回退原文本先发，选项随后补发（不会丢选项）', async () => {
        const gw = new FakeGateway();
        const splitter = makeSplitter(gw, {
            outputFormat: 'sequential', initialDelay: 1, optionDelay: 1, mediaWaitTimeout: 5000,
        });
        const m2i = makeM2i(gw, {
            enabled: true, renderMode: 'always', applyToPlatforms: [],
        });
        m2i._renderer = { ready: true, render: async () => { throw new Error('渲染崩溃'); } };
        m2i._delay = async () => {};
        setupSplitterChain(gw, splitter, m2i);

        const msg = { platform: 'qq', chatId: 'c1', chatType: 'private', content };
        gw.applyOutboundFilters(msg);

        await sleep(80);

        // 顺序：回退正文（无媒体）在前，选项在后
        assert.strictEqual(gw.sent.length, 3, '应发送 1 回退文本 + 2 选项');
        assert.strictEqual(gw.sent[0].mediaUrls.length, 0, '第 1 条为回退文本（无媒体）');
        assert.strictEqual(gw.sent[0].content, body, '回退文本为正文');
        assert.strictEqual(gw.sent[1].content, '选项一：向酒保打听消息');
        assert.strictEqual(gw.sent[2].content, '选项二：独自坐在角落观察');
        // 失败信号：count:0 success:false
        const failSignal = gw.emitted.find(e => e.event === MEDIA_SENT_EVENT);
        assert.ok(failSignal, '应发出 media-sent 失败信号');
        assert.strictEqual(failSignal.payload.count, 0);
        assert.strictEqual(failSignal.payload.success, false);
    });

    test('超时兜底：图片插件未发信号时，超时后仍补发选项（不空等）', async () => {
        const gw = new FakeGateway();
        const splitter = makeSplitter(gw, {
            outputFormat: 'sequential', initialDelay: 1, optionDelay: 1, mediaWaitTimeout: 30,
        });
        // 链中有 message-to-image 但该桩从不发完成信号（模拟未启用/不渲染场景）
        setupSplitterChain(gw, splitter, null);

        const msg = { platform: 'qq', chatId: 'c1', chatType: 'private', content };
        const result = gw.applyOutboundFilters(msg);

        assert.ok(result, '图片插件不接管时正文正常返回');
        assert.ok(msg.metadata[MEDIA_WAIT_KEY], '等待键仍写入');

        await sleep(80); // > 30ms 超时
        assert.strictEqual(gw.sent.length, 2, '超时后选项应兜底补发');
        assert.strictEqual(gw.sent[0].content, '选项一：向酒保打听消息');
    });

    test('过滤链中无 message-to-image：不等待、不写等待键，直接补发', async () => {
        const gw = new FakeGateway();
        const splitter = makeSplitter(gw, {
            outputFormat: 'sequential', initialDelay: 1, optionDelay: 1,
        });
        gw.outboundFilters = [
            { name: 'option-splitter', priority: 5, filter: (m) => splitter.filterOutbound(m) },
        ];

        const msg = { platform: 'qq', chatId: 'c1', chatType: 'private', content };
        const result = gw.applyOutboundFilters(msg);

        assert.ok(result, '正文正常返回');
        assert.ok(!msg.metadata?.[MEDIA_WAIT_KEY], '不应写入等待键');

        await sleep(50);
        assert.strictEqual(gw.sent.length, 2, '选项直接补发');
    });

    test('纯选项消息（无正文）：返回 null 丢弃原消息，不写等待键', () => {
        const gw = new FakeGateway();
        const splitter = makeSplitter(gw, {
            outputFormat: 'sequential', initialDelay: 1, optionDelay: 1,
        });
        gw.outboundFilters = [
            { name: 'option-splitter', priority: 5, filter: (m) => splitter.filterOutbound(m) },
            { name: 'message-to-image', priority: 20, filter: (m) => m },
        ];

        const msg = { platform: 'qq', chatId: 'c1', chatType: 'private', content: '>选项一：行动\n>选项二：观望' };
        const result = gw.applyOutboundFilters(msg);
        assert.strictEqual(result, null, '无正文 → 丢弃原消息，仅补发选项');
        assert.ok(!msg.metadata?.[MEDIA_WAIT_KEY], '纯选项消息不应等待图片');
    });

    test('batch 模式不受影响：合并发送、不写等待键', () => {
        const gw = new FakeGateway();
        const splitter = makeSplitter(gw, { outputFormat: 'batch' });
        const msg = { platform: 'qq', chatId: 'c1', chatType: 'private', content };
        const result = splitter.filterOutbound(msg);
        assert.ok(result.content.includes('选项一：'), '选项合并进正文');
        assert.ok(!result.metadata?.[MEDIA_WAIT_KEY], 'batch 模式不写等待键');
    });
});

// ====================================================================
// 3. message-to-image 侧信号发出
// ====================================================================

describe('message-to-image: media-sent 信号发出', () => {
    test('有等待键：_notifyMediaSent 发出携带 key/count/success 的事件', () => {
        const gw = new FakeGateway();
        const m2i = makeM2i(gw, {});
        m2i._notifyMediaSent(
            { platform: 'qq', chatId: 'c1', metadata: { _mediaWaitKey: 'k1' } },
            3, true
        );
        assert.strictEqual(gw.emitted.length, 1);
        assert.strictEqual(gw.emitted[0].event, MEDIA_SENT_EVENT);
        assert.deepStrictEqual(gw.emitted[0].payload, {
            key: 'k1', platform: 'qq', chatId: 'c1', count: 3, success: true,
        });
    });

    test('无等待键：不产生任何事件（零开销）', () => {
        const gw = new FakeGateway();
        const m2i = makeM2i(gw, {});
        m2i._notifyMediaSent({ platform: 'qq', chatId: 'c1', metadata: {} }, 3, true);
        assert.strictEqual(gw.emitted.length, 0);
    });

    test('插件未启用：filterOutbound 放行消息并发出 count:0 信号（对方不用空等超时）', () => {
        const gw = new FakeGateway();
        const m2i = makeM2i(gw, { enabled: false });
        const msg = { platform: 'qq', chatId: 'c1', content: '正文', metadata: { _mediaWaitKey: 'k1' } };
        const result = m2i.filterOutbound(msg);
        assert.strictEqual(result, msg, '未启用 → 原样放行');
        assert.strictEqual(gw.emitted.length, 1);
        assert.strictEqual(gw.emitted[0].payload.key, 'k1');
        assert.strictEqual(gw.emitted[0].payload.count, 0);
        assert.strictEqual(gw.emitted[0].payload.success, false);
    });

    test('消息不满足渲染条件：放行并发出 count:0 信号', () => {
        const gw = new FakeGateway();
        const m2i = makeM2i(gw, { enabled: true, renderMode: 'auto', minLength: 1000 });
        const msg = { platform: 'qq', chatId: 'c1', content: '短正文', metadata: { _mediaWaitKey: 'k2' } };
        const result = m2i.filterOutbound(msg);
        assert.strictEqual(result, msg, '内容过短 → 原样放行');
        const signal = gw.emitted.find(e => e.event === MEDIA_SENT_EVENT);
        assert.ok(signal, '应发出信号');
        assert.strictEqual(signal.payload.key, 'k2');
        assert.strictEqual(signal.payload.count, 0);
    });

    test('消息已在渲染（重试守卫）：不发重复信号（由进行中的渲染完成后统一发出）', () => {
        const gw = new FakeGateway();
        const m2i = makeM2i(gw, { enabled: true, renderMode: 'always' });
        m2i._renderer = { ready: true };
        const msg = {
            platform: 'qq', chatId: 'c1', content: '正文',
            metadata: { _mediaWaitKey: 'k3', _msg2imgTriggered: true },
        };
        const result = m2i.filterOutbound(msg);
        assert.strictEqual(result, null, '重试守卫 → 丢弃');
        assert.strictEqual(gw.emitted.length, 0, '不应重复发信号，避免误报完成');
    });
});
