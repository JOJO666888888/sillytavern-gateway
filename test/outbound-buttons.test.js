/**
 * OutboundMessage buttons 字段契约测试（P1 契约面扩展）
 *
 * 守护的不变量：
 *   1. 不传 buttons 时默认为 null（向后兼容）
 *   2. 传入非空 buttons 数组时正确赋值
 *   3. 传入空数组时等同于 null
 *   4. buttons 结构正确（text + callbackId）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { OutboundMessage } from '../server/adapters/base-adapter.js';

describe('OutboundMessage buttons 字段', () => {
    test('不传 buttons 时默认为 null（向后兼容）', () => {
        const msg = new OutboundMessage({ platform: 'telegram', chatId: 'c1', content: 'hello' });
        assert.strictEqual(msg.buttons, null);
    });

    test('传入空对象时默认为 null', () => {
        const msg = new OutboundMessage({});
        assert.strictEqual(msg.buttons, null);
    });

    test('传入非空 buttons 数组时正确赋值', () => {
        const buttons = [
            { text: '选项A', callbackId: 'select:option:1' },
            { text: '选项B', callbackId: 'select:option:2' },
        ];
        const msg = new OutboundMessage({ platform: 'telegram', chatId: 'c1', content: '正文', buttons });
        assert.deepStrictEqual(msg.buttons, buttons);
        assert.strictEqual(msg.buttons.length, 2);
    });

    test('传入空数组时等同于 null', () => {
        const msg = new OutboundMessage({ platform: 'telegram', chatId: 'c1', content: '正文', buttons: [] });
        assert.strictEqual(msg.buttons, null);
    });

    test('传入非数组类型时为 null', () => {
        const msg = new OutboundMessage({ platform: 'telegram', chatId: 'c1', content: '正文', buttons: 'not-array' });
        assert.strictEqual(msg.buttons, null);
    });

    test('buttons 结构正确（text + callbackId）', () => {
        const msg = new OutboundMessage({
            platform: 'telegram',
            chatId: 'c1',
            content: '正文',
            buttons: [{ text: '攻击', callbackId: 'select:option:1', data: 'extra' }],
        });
        assert.strictEqual(msg.buttons[0].text, '攻击');
        assert.strictEqual(msg.buttons[0].callbackId, 'select:option:1');
        assert.strictEqual(msg.buttons[0].data, 'extra');
    });

    test('buttons 不影响其他字段', () => {
        const msg = new OutboundMessage({
            platform: 'telegram',
            chatId: 'c1',
            chatType: 'group',
            content: '正文',
            replyToId: '123',
            metadata: { foo: 'bar' },
            buttons: [{ text: 'A', callbackId: 'cb-1' }],
        });
        assert.strictEqual(msg.platform, 'telegram');
        assert.strictEqual(msg.chatId, 'c1');
        assert.strictEqual(msg.chatType, 'group');
        assert.strictEqual(msg.content, '正文');
        assert.strictEqual(msg.replyToId, '123');
        assert.deepStrictEqual(msg.metadata, { foo: 'bar' });
        assert.strictEqual(msg.buttons.length, 1);
    });
});
