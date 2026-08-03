/**
 * Telegram 适配器 buttons 测试（P1 契约面扩展）
 *
 * 守护的不变量：
 *   1. send() 带 buttons 时生成正确的 reply_markup.inline_keyboard
 *   2. send() 无 buttons 时不附加 reply_markup（向后兼容）
 *   3. send() 无正文但有 buttons 时发送占位消息
 *   4. 长文本分段时仅最后一段附加 inline_keyboard
 *   5. handleCallbackQuery 生成正确的 InboundMessage 并 emit
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { TelegramAdapter } from '../server/adapters/telegram-adapter.js';
import { InboundMessage } from '../server/adapters/base-adapter.js';
import { silentLogger } from './helpers.js';

/** 模拟 TelegramBot 实例，记录所有 sendMessage/sendPhoto/answerCallbackQuery 调用 */
function makeMockBot() {
    const calls = { sendMessage: [], sendPhoto: [], answerCallbackQuery: [] };
    return {
        calls,
        sendMessage: async (chatId, text, options) => {
            calls.sendMessage.push({ chatId, text, options });
            return { message_id: calls.sendMessage.length };
        },
        sendPhoto: async (chatId, url) => {
            calls.sendPhoto.push({ chatId, url });
            return { message_id: calls.sendPhoto.length };
        },
        answerCallbackQuery: async (id) => {
            calls.answerCallbackQuery.push(id);
        },
    };
}

function makeAdapter(config = {}) {
    const a = new TelegramAdapter({ botToken: 'fake', ...config });
    a.logger = silentLogger;
    a.bot = makeMockBot();
    return a;
}

describe('Telegram send() buttons 渲染', () => {
    test('带 buttons 时生成正确的 reply_markup.inline_keyboard', async () => {
        const a = makeAdapter();
        const buttons = [
            { text: '选项A', callbackId: 'select:option:1' },
            { text: '选项B', callbackId: 'select:option:2' },
        ];

        await a.send({
            platform: 'telegram',
            chatId: 'c1',
            chatType: 'private',
            content: '正文',
            buttons,
            mediaUrls: [],
        });

        assert.strictEqual(a.bot.calls.sendMessage.length, 1);
        const call = a.bot.calls.sendMessage[0];
        assert.strictEqual(call.text, '正文');
        assert.ok(call.options.reply_markup, '应有 reply_markup');
        assert.ok(call.options.reply_markup.inline_keyboard, '应有 inline_keyboard');
        assert.strictEqual(call.options.reply_markup.inline_keyboard.length, 2);
        assert.strictEqual(call.options.reply_markup.inline_keyboard[0][0].text, '选项A');
        assert.strictEqual(call.options.reply_markup.inline_keyboard[0][0].callback_data, 'select:option:1');
        assert.strictEqual(call.options.reply_markup.inline_keyboard[1][0].text, '选项B');
        assert.strictEqual(call.options.reply_markup.inline_keyboard[1][0].callback_data, 'select:option:2');
    });

    test('无 buttons 时不附加 reply_markup（向后兼容）', async () => {
        const a = makeAdapter();

        await a.send({
            platform: 'telegram',
            chatId: 'c1',
            chatType: 'private',
            content: '正文',
            buttons: null,
            mediaUrls: [],
        });

        assert.strictEqual(a.bot.calls.sendMessage.length, 1);
        const call = a.bot.calls.sendMessage[0];
        assert.strictEqual(call.text, '正文');
        assert.strictEqual(call.options.reply_markup, undefined, '不应有 reply_markup');
    });

    test('无正文但有 buttons 时发送占位消息 + inline_keyboard', async () => {
        const a = makeAdapter();
        const buttons = [{ text: '选择', callbackId: 'select:option:1' }];

        await a.send({
            platform: 'telegram',
            chatId: 'c1',
            chatType: 'private',
            content: '',
            buttons,
            mediaUrls: [],
        });

        assert.strictEqual(a.bot.calls.sendMessage.length, 1);
        const call = a.bot.calls.sendMessage[0];
        assert.strictEqual(call.text, '请选择：');
        assert.ok(call.options.reply_markup, '应有 reply_markup');
        assert.strictEqual(call.options.reply_markup.inline_keyboard[0][0].text, '选择');
    });

    test('长文本分段时仅最后一段附加 inline_keyboard', async () => {
        const a = makeAdapter();
        // 构造超过 4096 字符的长文本
        const longText = 'A'.repeat(5000);
        const buttons = [{ text: '继续', callbackId: 'select:option:1' }];

        await a.send({
            platform: 'telegram',
            chatId: 'c1',
            chatType: 'private',
            content: longText,
            buttons,
            mediaUrls: [],
        });

        // 应分段发送
        assert.ok(a.bot.calls.sendMessage.length > 1, '应分段发送');
        // 非最后一段不应有 reply_markup
        for (let i = 0; i < a.bot.calls.sendMessage.length - 1; i++) {
            assert.strictEqual(
                a.bot.calls.sendMessage[i].options.reply_markup,
                undefined,
                `第 ${i + 1} 段不应有 reply_markup`
            );
        }
        // 最后一段应有 reply_markup
        const lastCall = a.bot.calls.sendMessage[a.bot.calls.sendMessage.length - 1];
        assert.ok(lastCall.options.reply_markup, '最后一段应有 reply_markup');
    });

    test('buttons 不影响图片发送', async () => {
        const a = makeAdapter();

        await a.send({
            platform: 'telegram',
            chatId: 'c1',
            chatType: 'private',
            content: '正文',
            buttons: [{ text: 'A', callbackId: 'cb-1' }],
            mediaUrls: ['http://example.com/img.png'],
        });

        assert.strictEqual(a.bot.calls.sendPhoto.length, 1);
        assert.strictEqual(a.bot.calls.sendPhoto[0].url, 'http://example.com/img.png');
    });
});

describe('Telegram handleCallbackQuery 转 InboundMessage', () => {
    test('按钮点击生成正确的 InboundMessage 并 emit', () => {
        const a = makeAdapter();
        const emitted = [];
        a.on('message', (msg) => emitted.push(msg));

        const query = {
            id: 'cq-1',
            data: 'select:option:1',
            from: { id: 123456, first_name: 'Alice', last_name: 'Smith' },
            message: {
                message_id: 42,
                chat: { id: -100123, type: 'private' },
            },
        };

        a.handleCallbackQuery(query);

        // answerCallbackQuery 被调用
        assert.strictEqual(a.bot.calls.answerCallbackQuery.length, 1);
        assert.strictEqual(a.bot.calls.answerCallbackQuery[0], 'cq-1');

        // emit 了一条 message
        assert.strictEqual(emitted.length, 1);
        const msg = emitted[0];
        assert.ok(msg instanceof InboundMessage);
        assert.strictEqual(msg.platform, 'telegram');
        assert.strictEqual(msg.messageId, '42');
        assert.strictEqual(msg.chatId, '-100123');
        assert.strictEqual(msg.chatType, 'private');
        assert.strictEqual(msg.senderId, '123456');
        assert.strictEqual(msg.senderName, 'Alice Smith');
        assert.strictEqual(msg.content, 'select:option:1');
        assert.strictEqual(msg.mentioned, true);
        assert.strictEqual(msg.replyToId, '42');
        assert.strictEqual(msg.raw, query);
    });

    test('群聊中按钮点击 chatType 为 group', () => {
        const a = makeAdapter();
        const emitted = [];
        a.on('message', (msg) => emitted.push(msg));

        const query = {
            id: 'cq-2',
            data: 'select:option:2',
            from: { id: 789, first_name: 'Bob' },
            message: {
                message_id: 99,
                chat: { id: -100999, type: 'supergroup' },
            },
        };

        a.handleCallbackQuery(query);

        assert.strictEqual(emitted.length, 1);
        assert.strictEqual(emitted[0].chatType, 'group');
    });

    test('无 message 或无 data 时不 emit', () => {
        const a = makeAdapter();
        const emitted = [];
        a.on('message', (msg) => emitted.push(msg));

        // 无 message
        a.handleCallbackQuery({ id: 'cq-3', data: 'x', from: { id: 1, first_name: 'X' } });
        // 无 data
        a.handleCallbackQuery({
            id: 'cq-4', from: { id: 1, first_name: 'X' },
            message: { message_id: 1, chat: { id: 1, type: 'private' } },
        });

        assert.strictEqual(emitted.length, 0);
        // answerCallbackQuery 仍被调用（消除 loading）
        assert.strictEqual(a.bot.calls.answerCallbackQuery.length, 2);
    });

    test('白名单外的用户不 emit', () => {
        const a = makeAdapter({ allowedUsers: ['111'] });
        const emitted = [];
        a.on('message', (msg) => emitted.push(msg));

        const query = {
            id: 'cq-5',
            data: 'select:option:1',
            from: { id: 222, first_name: 'Stranger' },
            message: { message_id: 1, chat: { id: 1, type: 'private' } },
        };

        a.handleCallbackQuery(query);

        assert.strictEqual(emitted.length, 0, '白名单外用户不应 emit');
        assert.strictEqual(a.bot.calls.answerCallbackQuery.length, 1, '仍应 answer callback');
    });

    test('无 last_name 时 senderName 正确', () => {
        const a = makeAdapter();
        const emitted = [];
        a.on('message', (msg) => emitted.push(msg));

        const query = {
            id: 'cq-6',
            data: 'cb',
            from: { id: 1, first_name: 'OnlyFirst' },
            message: { message_id: 1, chat: { id: 1, type: 'private' } },
        };

        a.handleCallbackQuery(query);

        assert.strictEqual(emitted[0].senderName, 'OnlyFirst');
    });
});
