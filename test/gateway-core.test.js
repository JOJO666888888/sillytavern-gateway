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
import { InboundMessage, OutboundMessage, MediaAsset, MediaType } from '../server/adapters/base-adapter.js';

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
