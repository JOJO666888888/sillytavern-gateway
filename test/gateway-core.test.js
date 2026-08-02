/**
 * 网关核心回归测试（P1-C / P1-D / P1-E）
 *
 * 守护的核心不变量：
 *   1. 入站队列保存**完整**消息内容（历史 bug：走 messageLog 被截断到 100 字符）
 *   2. ack 语义正确，未 ack 的消息不丢失
 *   3. 出站过滤器可按插件归属强制回收（禁用插件真正生效的基础）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { GatewayCore } from '../server/gateway-core.js';
import PlatformAdapter, { InboundMessage, OutboundMessage, MediaAsset, MediaType, ConnectionState } from '../server/adapters/base-adapter.js';

describe('GatewayCore 入站队列', () => {
    test('保存完整消息内容，不截断（对比 messageLog 的 100 字符截断）', () => {
        const gc = new GatewayCore();
        const long = 'x'.repeat(500);
        gc.enqueueInbound({ platform: 'qq', chatId: 'g1', content: long, timestamp: Date.now() });

        const pending = gc.getPendingInbound();
        assert.strictEqual(pending.length, 1);
        assert.strictEqual(pending[0].content.length, 500, '入站队列必须保存完整内容');

        // 同一条消息进 messageLog 时确实是被截断的——证明两条通道已分离
        gc.addMessageLog('inbound', { platform: 'qq', chatId: 'g1', content: long });
        const logged = gc.messageLog[gc.messageLog.length - 1];
        assert.strictEqual(logged.content.length, 100, 'messageLog 仍截断（它只用于观测）');
    });

    test('保留 senderName，群聊可区分发言人', () => {
        const gc = new GatewayCore();
        gc.enqueueInbound({ platform: 'qq', chatId: 'g1', senderName: '张三', content: 'hi' });
        assert.strictEqual(gc.getPendingInbound()[0].senderName, '张三');
    });

    test('ack 精确移除已处理消息，其余保留', () => {
        const gc = new GatewayCore();
        const id1 = gc.enqueueInbound({ platform: 'qq', chatId: 'a', content: '1' });
        const id2 = gc.enqueueInbound({ platform: 'qq', chatId: 'b', content: '2' });

        const removed = gc.ackInbound([id1]);
        assert.strictEqual(removed, 1);
        const rest = gc.getPendingInbound();
        assert.strictEqual(rest.length, 1);
        assert.strictEqual(rest[0].id, id2, '未 ack 的消息必须保留');
    });

    test('ack 空数组/未知 id 不误删', () => {
        const gc = new GatewayCore();
        gc.enqueueInbound({ platform: 'qq', chatId: 'a', content: '1' });
        assert.strictEqual(gc.ackInbound([]), 0);
        assert.strictEqual(gc.ackInbound(['nonexistent']), 0);
        assert.strictEqual(gc.getPendingInbound().length, 1);
    });

    test('队列上限生效且丢弃最旧（不静默）', () => {
        const gc = new GatewayCore();
        gc.maxInboundQueue = 5;
        for (let i = 0; i < 8; i++) {
            gc.enqueueInbound({ platform: 'qq', chatId: 'c', content: `m${i}` });
        }
        const pending = gc.getPendingInbound();
        assert.strictEqual(pending.length, 5);
        assert.strictEqual(pending[0].content, 'm3', '应丢弃最旧的，保留最近 5 条');
    });

    test('limit 参数限制返回条数', () => {
        const gc = new GatewayCore();
        for (let i = 0; i < 5; i++) gc.enqueueInbound({ platform: 'qq', chatId: 'c', content: `${i}` });
        assert.strictEqual(gc.getPendingInbound(2).length, 2);
        assert.strictEqual(gc.getPendingInbound().length, 5, 'getPending 不移除消息');
    });
});

describe('GatewayCore 出站过滤器', () => {
    test('按插件归属强制回收（禁用插件真正生效的基础）', () => {
        const gc = new GatewayCore();
        gc.addOutboundFilter(m => m, { name: 'f1', pluginName: 'plugin-a' });
        gc.addOutboundFilter(m => m, { name: 'f2', pluginName: 'plugin-a' });
        gc.addOutboundFilter(m => m, { name: 'f3', pluginName: 'plugin-b' });

        const removed = gc.removeOutboundFiltersByPlugin('plugin-a');
        assert.strictEqual(removed, 2);
        assert.strictEqual(gc.outboundFilters.length, 1);
        assert.strictEqual(gc.outboundFilters[0].pluginName, 'plugin-b', '其它插件的过滤器不受影响');
    });

    test('按 priority 升序执行', () => {
        const gc = new GatewayCore();
        const order = [];
        gc.addOutboundFilter(m => { order.push('late'); return m; }, { name: 'late', priority: 50 });
        gc.addOutboundFilter(m => { order.push('early'); return m; }, { name: 'early', priority: 5 });

        gc.applyOutboundFilters(new OutboundMessage({ platform: 'qq', chatId: '1', content: 'x' }));
        assert.deepStrictEqual(order, ['early', 'late']);
    });

    test('过滤器返回 null 丢弃消息', () => {
        const gc = new GatewayCore();
        gc.addOutboundFilter(() => null, { name: 'drop' });
        const result = gc.applyOutboundFilters(new OutboundMessage({ platform: 'qq', chatId: '1', content: 'x' }));
        assert.strictEqual(result, null);
    });

    test('单个过滤器抛异常不中断整条链', () => {
        const gc = new GatewayCore();
        let reached = false;
        gc.addOutboundFilter(() => { throw new Error('boom'); }, { name: 'bad', priority: 1 });
        gc.addOutboundFilter(m => { reached = true; return m; }, { name: 'good', priority: 2 });

        const msg = new OutboundMessage({ platform: 'qq', chatId: '1', content: 'x' });
        const result = gc.applyOutboundFilters(msg);
        assert.ok(reached, '后续过滤器仍应执行');
        assert.ok(result, '消息不应因异常而丢失');
    });
});

describe('GatewayCore 出站分发（纯媒体消息回归）', () => {
    // 回归：content 为空的纯媒体消息（如 message-to-image 把回复渲染成图片后、
    // 只带 mediaUrls 的消息）必须真正调用 adapter.send()。历史 bug：splitMessage('')
    // 返回 []，分段循环 0 次，sendPhoto 从未执行，却在循环后误报"消息已发送"，
    // 导致用户收不到任何图片。
    function makeMockAdapter() {
        const ad = new (class extends PlatformAdapter {
            constructor() { super('telegram', {}); }
        })();
        ad.state = ConnectionState.CONNECTED;
        const calls = [];
        ad.send = async (msg) => { calls.push(msg); return true; };
        return { ad, calls };
    }

    test('纯媒体消息（content 空 + mediaUrls）会调用 adapter.send', async () => {
        const gc = new GatewayCore();
        const { ad, calls } = makeMockAdapter();
        gc.registerAdapter('telegram', ad);
        const imgMsg = new OutboundMessage({ platform: 'telegram', chatId: 'c1', content: '', mediaUrls: ['/x/y.png'] });
        const ok = await gc.dispatchOutbound(imgMsg);
        assert.strictEqual(ok, true);
        assert.strictEqual(calls.length, 1, '纯媒体消息必须触发一次 adapter.send（否则图片发不出去）');
        assert.ok(calls[0].mediaUrls.includes('/x/y.png'), '媒体应随消息送达适配器');
    });

    test('纯文本消息仍正常发送且内容不空', async () => {
        const gc = new GatewayCore();
        const { ad, calls } = makeMockAdapter();
        gc.registerAdapter('telegram', ad);
        await gc.dispatchOutbound(new OutboundMessage({ platform: 'telegram', chatId: 'c1', content: 'hi' }));
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].content, 'hi');
    });

    test('空内容且无媒体时不调用 adapter.send（不发空消息）', async () => {
        const gc = new GatewayCore();
        const { ad, calls } = makeMockAdapter();
        gc.registerAdapter('telegram', ad);
        await gc.dispatchOutbound(new OutboundMessage({ platform: 'telegram', chatId: 'c1', content: '' }));
        assert.strictEqual(calls.length, 0, '无内容无媒体不应发送空消息');
    });
});

describe('GatewayCore 入站过滤器', () => {
    const makeMsg = () => new InboundMessage({ platform: 'qq', chatId: 'g1', senderId: 'u1', senderName: '张三', content: 'hello' });

    test('按 priority 从小到大依次执行', () => {
        const gc = new GatewayCore();
        const order = [];
        gc.addInboundFilter(m => { order.push('late'); return m; }, { name: 'late', priority: 50 });
        gc.addInboundFilter(m => { order.push('early'); return m; }, { name: 'early', priority: 5 });

        gc.applyInboundFilters(makeMsg());
        assert.deepStrictEqual(order, ['early', 'late']);
    });

    test('过滤器可改写消息内容', () => {
        const gc = new GatewayCore();
        gc.addInboundFilter(m => { m.content = m.content.toUpperCase(); return m; }, { name: 'upper' });
        const result = gc.applyInboundFilters(makeMsg());
        assert.strictEqual(result.content, 'HELLO');
    });

    test('返回 null 拦截消息', () => {
        const gc = new GatewayCore();
        gc.addInboundFilter(() => null, { name: 'block' });
        const result = gc.applyInboundFilters(makeMsg());
        assert.strictEqual(result, null);
    });

    test('单个过滤器抛错被隔离，消息不丢失（fail-open）', () => {
        const gc = new GatewayCore();
        let reached = false;
        gc.addInboundFilter(() => { throw new Error('boom'); }, { name: 'bad', priority: 1 });
        gc.addInboundFilter(m => { reached = true; return m; }, { name: 'good', priority: 2 });

        const result = gc.applyInboundFilters(makeMsg());
        assert.ok(reached, '后续过滤器仍应执行');
        assert.ok(result, '消息不应因异常而丢失');
    });

    test('removeInboundFiltersByPlugin 精确回收指定插件的过滤器', () => {
        const gc = new GatewayCore();
        gc.addInboundFilter(m => m, { name: 'f1', pluginName: 'plugin-a' });
        gc.addInboundFilter(m => m, { name: 'f2', pluginName: 'plugin-a' });
        gc.addInboundFilter(m => m, { name: 'f3', pluginName: 'plugin-b' });

        const removed = gc.removeInboundFiltersByPlugin('plugin-a');
        assert.strictEqual(removed, 2);
        assert.strictEqual(gc.inboundFilters.length, 1);
        assert.strictEqual(gc.inboundFilters[0].name, 'f3');
    });

    test('addInboundFilter 返回的注销函数可移除自身', () => {
        const gc = new GatewayCore();
        const off = gc.addInboundFilter(m => m, { name: 'x' });
        assert.strictEqual(gc.inboundFilters.length, 1);
        off();
        assert.strictEqual(gc.inboundFilters.length, 0);
    });

    test('handleInbound 中被拦截的消息不进入队列、不触发处理器', () => {
        const gc = new GatewayCore();
        let handlerCalled = false;
        gc.onMessage(() => { handlerCalled = true; });
        gc.addInboundFilter(() => null, { name: 'block-all' });

        const before = gc.inboundQueue.length;
        gc.handleInbound('qq', makeMsg());

        assert.strictEqual(handlerCalled, false, '被拦截消息不应触发处理器');
        assert.strictEqual(gc.inboundQueue.length, before, '被拦截消息不应进入入站队列');
    });

    test('handleInbound 中过滤器改写在处理器可见', () => {
        const gc = new GatewayCore();
        let seen = null;
        gc.onMessage((m) => { seen = m.content; });
        gc.addInboundFilter(m => { m.content = '[已脱敏]'; return m; }, { name: 'redact' });

        gc.handleInbound('qq', makeMsg());
        assert.strictEqual(seen, '[已脱敏]');
    });
});

describe('消息模型（媒体抽象层 P1-D）', () => {
    test('MediaAsset 保留类型，mediaUrls 向后兼容派生', () => {
        const msg = new InboundMessage({
            platform: 'qq',
            media: [MediaAsset.voice('http://x/a.amr', { duration: 3 })],
        });
        assert.strictEqual(msg.media[0].type, MediaType.VOICE);
        assert.strictEqual(msg.media[0].duration, 3);
        assert.strictEqual(msg.mediaUrls[0], 'http://x/a.amr', 'mediaUrls 应从 media 派生');
    });

    test('旧格式 mediaUrls 自动规整为 image 类型', () => {
        const msg = new InboundMessage({ mediaUrls: ['http://y/b.jpg'] });
        assert.strictEqual(msg.media[0].type, MediaType.IMAGE);
        assert.strictEqual(msg.media[0].url, 'http://y/b.jpg');
    });

    test('placeholder 按类型给出可读占位符', () => {
        assert.strictEqual(MediaAsset.image('u').placeholder(), '[图片]');
        assert.strictEqual(MediaAsset.voice('u').placeholder(), '[语音]');
        assert.strictEqual(new MediaAsset({ type: MediaType.FILE, url: 'u', name: 'a.pdf' }).placeholder(), '[文件:a.pdf]');
    });
});
