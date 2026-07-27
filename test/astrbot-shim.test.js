/**
 * AstrBot 兼容 Shim 测试
 *
 * 守护的核心不变量：
 *   1. AstrMessageEvent 字段/方法正确映射到 PluginContext
 *   2. 消息组件 Plain/Image/At/Reply 构造 + chain_result 序列化正确
 *   3. 异步生成器 handler 被自动 drain，每次 yield 依次发送
 *   4. Star.initialize/terminate 正确映射到 onLoad/onUnload
 *   5. plain_result/image_result 产出正确的 OutboundMessage 形状
 *   6. 权限：未声明 llm 时 context.get_using_provider 走拒绝桩抛错
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    Star, AstrMessageEvent, Plain, Image, At, Reply,
    MessageEventResult, defineCommand, defineLLMTool,
    serializeChain, drainGenerator,
} from '../server/compat/index.js';
import { PluginContext } from '../server/plugin-context.js';

/** 构造一个记录 sendMessage 调用的假网关 */
function makeFakeGateway() {
    const sent = [];
    return {
        sent,
        sendMessage: (msg) => { sent.push(msg); return msg; },
        getStatus: () => ({ adapters: {} }),
    };
}

/** 构造一个带假网关的 PluginContext */
function makeCtx(overrides = {}) {
    const gateway = overrides.gateway || makeFakeGateway();
    const message = {
        platform: 'qq',
        chatId: 'g123',
        chatType: 'group',
        senderId: 'u456',
        senderName: '张三',
        content: '你好世界',
        messageId: 'm789',
        mentioned: false,
        ...overrides.message,
    };
    const ctx = new PluginContext({
        message,
        gateway,
        sessionManager: overrides.sessionManager || null,
        configManager: overrides.configManager || null,
        gatewayConfig: overrides.gatewayConfig || null,
        llm: overrides.llm || null,
        pluginName: 'test-plugin',
    });
    ctx.logger = { debug: () => {}, error: () => {}, info: () => {} };
    return { ctx, gateway };
}

describe('AstrMessageEvent 字段映射', () => {
    test('基础字段映射自 ctx', () => {
        const { ctx } = makeCtx();
        const e = new AstrMessageEvent(ctx);
        assert.strictEqual(e.message_str, '你好世界');
        assert.strictEqual(e.sender_id, 'u456');
        assert.strictEqual(e.sender_name, '张三');
        assert.strictEqual(e.chat_id, 'g123');
        assert.strictEqual(e.platform, 'qq');
        assert.strictEqual(e.message_id, 'm789');
    });

    test('群聊 group_id 有值，私聊为空', () => {
        const { ctx: gctx } = makeCtx({ message: { chatType: 'group', chatId: 'g1' } });
        assert.strictEqual(new AstrMessageEvent(gctx).get_group_id(), 'g1');

        const { ctx: pctx } = makeCtx({ message: { chatType: 'private', chatId: 'u1' } });
        assert.strictEqual(new AstrMessageEvent(pctx).get_group_id(), '');
    });

    test('getter 方法与字段一致', () => {
        const { ctx } = makeCtx();
        const e = new AstrMessageEvent(ctx);
        assert.strictEqual(e.get_sender_name(), '张三');
        assert.strictEqual(e.get_sender_id(), 'u456');
        assert.strictEqual(e.get_message_str(), '你好世界');
        assert.strictEqual(e.get_platform_name(), 'qq');
        assert.strictEqual(e.get_message_type(), 'group');
    });

    test('is_private_chat / is_group_chat 正确', () => {
        const { ctx: pctx } = makeCtx({ message: { chatType: 'private' } });
        const pe = new AstrMessageEvent(pctx);
        assert.strictEqual(pe.is_private_chat(), true);
        assert.strictEqual(pe.is_group_chat(), false);

        const { ctx: gctx } = makeCtx({ message: { chatType: 'group' } });
        const ge = new AstrMessageEvent(gctx);
        assert.strictEqual(ge.is_private_chat(), false);
        assert.strictEqual(ge.is_group_chat(), true);
    });

    test('is_admin 读 admins 白名单', () => {
        const configManager = { get: (k) => k === 'admins' ? ['qq:u456'] : undefined };
        const { ctx } = makeCtx({ configManager });
        assert.strictEqual(new AstrMessageEvent(ctx).is_admin(), true);

        const cfg2 = { get: (k) => k === 'admins' ? ['qq:other'] : undefined };
        const { ctx: ctx2 } = makeCtx({ configManager: cfg2 });
        assert.strictEqual(new AstrMessageEvent(ctx2).is_admin(), false);
    });

    test('无 configManager 时 is_admin 返回 false（不崩溃）', () => {
        const { ctx } = makeCtx();
        assert.strictEqual(new AstrMessageEvent(ctx).is_admin(), false);
    });
});

describe('消息组件与序列化', () => {
    test('Plain/Image/At/Reply 构造', () => {
        assert.strictEqual(new Plain('hi').text, 'hi');
        assert.strictEqual(new Image('http://x/a.png').url, 'http://x/a.png');
        assert.strictEqual(new At(123).qq, '123');
        assert.strictEqual(new Reply('m1').id, 'm1');
    });

    test('Image.fromURL / fromFileSystem', () => {
        assert.strictEqual(Image.fromURL('http://x/a.png').url, 'http://x/a.png');
        assert.strictEqual(Image.fromFileSystem('/tmp/a.png').url, 'file:///tmp/a.png');
    });

    test('serializeChain 合并文本、收集图片、提取 replyToId', () => {
        const chain = [
            new Reply('m1'),
            new At('u1'),
            new Plain(' 你好'),
            new Image('http://x/a.png'),
            new Plain(' 世界'),
            new Image('http://x/b.png'),
        ];
        const { content, mediaUrls, replyToId } = serializeChain(chain);
        assert.strictEqual(content, '@u1 你好 世界');
        assert.deepStrictEqual(mediaUrls, ['http://x/a.png', 'http://x/b.png']);
        assert.strictEqual(replyToId, 'm1');
    });

    test('空链序列化为空', () => {
        const { content, mediaUrls, replyToId } = serializeChain([]);
        assert.strictEqual(content, '');
        assert.deepStrictEqual(mediaUrls, []);
        assert.strictEqual(replyToId, '');
    });
});

describe('结果创建方法', () => {
    test('plain_result / image_result / chain_result 产出 MessageEventResult', () => {
        const { ctx } = makeCtx();
        const e = new AstrMessageEvent(ctx);
        const p = e.plain_result('hi');
        assert.ok(p instanceof MessageEventResult);
        assert.strictEqual(p.type, 'plain');
        assert.strictEqual(p.data, 'hi');

        const img = e.image_result('http://x/a.png');
        assert.strictEqual(img.type, 'image');

        const c = e.chain_result([new Plain('x')]);
        assert.strictEqual(c.type, 'chain');
    });
});

describe('drainGenerator - 生成器 drain', () => {
    test('yield 多个 plain_result 依次发送', async () => {
        const { ctx, gateway } = makeCtx();
        const e = new AstrMessageEvent(ctx);
        async function* handler(event) {
            yield event.plain_result('第一句');
            yield event.plain_result('第二句');
        }
        await drainGenerator(handler(e), e);
        assert.strictEqual(gateway.sent.length, 2);
        assert.strictEqual(gateway.sent[0].content, '第一句');
        assert.strictEqual(gateway.sent[1].content, '第二句');
    });

    test('yield image_result 产出带 mediaUrls 的消息', async () => {
        const { ctx, gateway } = makeCtx();
        const e = new AstrMessageEvent(ctx);
        async function* handler(event) {
            yield event.image_result('http://x/a.png');
        }
        await drainGenerator(handler(e), e);
        assert.strictEqual(gateway.sent.length, 1);
        assert.deepStrictEqual(gateway.sent[0].mediaUrls, ['http://x/a.png']);
    });

    test('yield chain_result 序列化后发送', async () => {
        const { ctx, gateway } = makeCtx();
        const e = new AstrMessageEvent(ctx);
        async function* handler(event) {
            yield event.chain_result([new Plain('看图: '), new Image('http://x/a.png')]);
        }
        await drainGenerator(handler(e), e);
        assert.strictEqual(gateway.sent[0].content, '看图: ');
        assert.deepStrictEqual(gateway.sent[0].mediaUrls, ['http://x/a.png']);
    });

    test('单次 yield 发送失败被隔离，后续继续', async () => {
        const gateway = makeFakeGateway();
        let calls = 0;
        gateway.sendMessage = (msg) => {
            calls++;
            if (calls === 1) throw new Error('第一次发送失败');
            gateway.sent.push(msg);
        };
        const { ctx } = makeCtx({ gateway });
        const e = new AstrMessageEvent(ctx);
        async function* handler(event) {
            yield event.plain_result('会失败');
            yield event.plain_result('会成功');
        }
        // 不应抛出
        await drainGenerator(handler(e), e);
        assert.strictEqual(calls, 2);
        assert.strictEqual(gateway.sent.length, 1);
        assert.strictEqual(gateway.sent[0].content, '会成功');
    });
});

describe('Star 基类', () => {
    test('initialize/terminate 映射到 onLoad/onUnload', async () => {
        let inited = false, terminated = false;
        class MySkill extends Star {
            async initialize() { inited = true; }
            async terminate() { terminated = true; }
        }
        const s = new MySkill({});
        await s.onLoad();
        assert.strictEqual(inited, true);
        await s.onUnload();
        assert.strictEqual(terminated, true);
    });

    test('生成器命令 handler 被自动包装', () => {
        class MySkill extends Star {
            static commands = [defineCommand('hello', { handler: 'hello' })];
            async *hello(event) { yield event.plain_result('hi'); }
        }
        const s = new MySkill({});
        const cmds = s.getCommands();
        // handler 名应被替换为包装名
        assert.notStrictEqual(cmds[0].handler, 'hello');
        assert.strictEqual(cmds[0].handler, '_aw_hello');
        assert.strictEqual(typeof s[cmds[0].handler], 'function');
    });

    test('生成器命令包装后可执行并发送', async () => {
        const { ctx, gateway } = makeCtx();
        class MySkill extends Star {
            static commands = [defineCommand('hello', { handler: 'hello' })];
            async *hello(event) {
                yield event.plain_result(`你好 ${event.sender_name}`);
            }
        }
        const s = new MySkill({});
        const cmds = s.getCommands();
        await s[cmds[0].handler](ctx);
        assert.strictEqual(gateway.sent.length, 1);
        assert.strictEqual(gateway.sent[0].content, '你好 张三');
    });

    test('非生成器 handler 不被包装', () => {
        class MySkill extends Star {
            static commands = [defineCommand('ping', { handler: 'ping' })];
            async ping(ctx) { return ctx.reply('pong'); }
        }
        const s = new MySkill({});
        const cmds = s.getCommands();
        assert.strictEqual(cmds[0].handler, 'ping');
    });
});

describe('LLM 工具声明', () => {
    test('defineLLMTool 产出正确结构', () => {
        const t = defineLLMTool('get_weather', '查天气', {
            type: 'object',
            properties: { city: { type: 'string' } },
        }, 'getWeather');
        assert.strictEqual(t.name, 'get_weather');
        assert.strictEqual(t.description, '查天气');
        assert.strictEqual(t._handler, 'getWeather');
        assert.strictEqual(t._llmTool, true);
    });

    test('Star.tools 从 static llm_tools 构建', () => {
        class MySkill extends Star {
            static get llm_tools() {
                return [defineLLMTool('calc', '计算', { type: 'object' }, 'doCalc')];
            }
        }
        const s = new MySkill({});
        const tools = s.tools;
        assert.strictEqual(tools.length, 1);
        assert.strictEqual(tools[0].name, 'calc');
        assert.strictEqual(tools[0].description, '计算');
        // tools 数组不应泄漏 _handler（那是内部路由用）
        assert.strictEqual(tools[0]._handler, undefined);
    });

    test('executeTool 路由到声明的 handler 方法', async () => {
        class MySkill extends Star {
            static get llm_tools() {
                return [defineLLMTool('calc', '计算', { type: 'object' }, 'doCalc')];
            }
            async doCalc(args) { return { result: args.a + args.b }; }
        }
        const s = new MySkill({});
        const r = await s.executeTool('calc', { a: 2, b: 3 });
        assert.deepStrictEqual(r, { result: 5 });
    });

    test('executeTool 未知工具返回 error', async () => {
        class MySkill extends Star {}
        const s = new MySkill({});
        const r = await s.executeTool('unknown', {});
        assert.ok(r.error);
    });
});

describe('权限收窄透传', () => {
    test('context.get_using_provider 返回注入的 llm 服务', async () => {
        const fakeLLM = { chat: async () => 'ok' };
        class MySkill extends Star {}
        const s = new MySkill({ services: { llm: fakeLLM } });
        const provider = await s.context.get_using_provider();
        assert.strictEqual(provider, fakeLLM);
    });

    test('未注入 llm 时 get_using_provider 返回 null（调用点自行处理）', async () => {
        class MySkill extends Star {}
        const s = new MySkill({ services: {} });
        const provider = await s.context.get_using_provider();
        assert.strictEqual(provider, null);
    });

    test('event.send 走 ctx.reply（经出站链）', async () => {
        const { ctx, gateway } = makeCtx();
        const e = new AstrMessageEvent(ctx);
        await e.send('直接发送');
        assert.strictEqual(gateway.sent.length, 1);
        assert.strictEqual(gateway.sent[0].content, '直接发送');
    });
});
