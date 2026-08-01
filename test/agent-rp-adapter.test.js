/**
 * agent-rp IM 适配器集成测试（Task 2.6）
 *
 * 覆盖：
 *   - _renderToIM 正文分段发送（SubTask 2.2）
 *   - 选项格式化（SubTask 2.3）
 *   - 状态图触发逻辑（SubTask 2.4，mock message-to-image renderer）
 *   - 多 Bot 绑定/解绑（SubTask 2.5）
 *   - 引擎模式 vs 兜底模式切换
 *   - Profile 解析（群聊多 Bot 场景）
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import AgentRPPlugin from '../plugins/agent-rp/index.js';
import { AgentRunResult } from '../server/agent/run-result.js';
import { OutboundMessage } from '../server/adapters/base-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'plugins', 'agent-rp');

/**
 * 构造 mock 插件上下文。
 * - ctx.reply / ctx._gateway.sendMessage 收集到 sentMessages
 * - ctx.agent 可控（模拟引擎可用/不可用）
 * - ctx.surface 提供 register/dispatch（直接调用适配器 render）
 */
function makeMockCtx(overrides = {}) {
    const sentMessages = [];
    const sentDirectMessages = [];

    const gateway = {
        sendMessage: (msg) => { sentMessages.push(msg); },
        sendDirect: async (msg, opts) => { sentDirectMessages.push({ msg, opts }); },
        addInboundFilter: () => () => {},
        addOutboundFilter: () => () => {},
    };

    const ctx = {
        platform: 'qq',
        chatId: 'test-chat-1',
        chatType: 'private',
        senderId: 'user-1',
        senderName: 'Tester',
        content: '',
        messageId: 'msg-1',
        args: [],
        _gateway: gateway,
        _handled: false,
        _propagationStopped: false,
        stopPropagation() { this._propagationStopped = true; this._handled = true; },
        get handled() { return this._handled; },
        set handled(v) { this._handled = v; },
        reply: async function (text, options = {}) {
            const outbound = new OutboundMessage({
                platform: this.platform,
                chatId: this.chatId,
                chatType: this.chatType,
                content: text,
                replyToId: this.messageId,
                mediaUrls: options.mediaUrls || [],
            });
            gateway.sendMessage(outbound);
            this._handled = true;
            return outbound;
        },
        getHistory: (limit = 0) => [],
        getConfig: (key) => undefined,
        ...overrides,
    };

    return { ctx, sentMessages, sentDirectMessages, gateway };
}

/**
 * 构造一个最小可用的 AgentRPPlugin 实例（不触发 onLoad 副作用）。
 */
function makePlugin(opts = {}) {
    const plugin = new AgentRPPlugin({
        name: 'agent-rp',
        pluginConfig: opts.config || {},
        services: {
            gateway: { addInboundFilter: () => () => {} },
        },
    });
    // 覆盖 logger（测试环境 createLogger 可能不可用）
    plugin.logger = {
        info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
        child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    };
    return plugin;
}

describe('SubTask 2.2: 正文分段发送', () => {
    test('双换行切分多段', () => {
        const plugin = makePlugin();
        const text = '第一段。\n\n第二段。\n\n第三段。';
        const parts = plugin._splitParagraphs(text);
        assert.strictEqual(parts.length, 3);
        assert.strictEqual(parts[0], '第一段。');
        assert.strictEqual(parts[1], '第二段。');
        assert.strictEqual(parts[2], '第三段。');
    });

    test('超长段落按单换行二次切分', () => {
        const plugin = makePlugin();
        // 构造一段超过 PARAGRAPH_MAX_LEN(800) 的文本，含单换行
        const line = '这是一行比较长的内容用于测试切分逻辑。';
        const longText = Array(50).fill(line).join('\n'); // ~50*20 = 1000 chars > 800
        const parts = plugin._splitParagraphs(longText);
        assert.ok(parts.length > 1, '超长段落应被切分');
        // 每段不超过阈值（允许少量超出因合并逻辑）
        for (const p of parts) {
            assert.ok(p.length <= 1000, `段长 ${p.length} 应在合理范围`);
        }
    });

    test('空文本返回空数组', () => {
        const plugin = makePlugin();
        assert.deepStrictEqual(plugin._splitParagraphs(''), []);
        assert.deepStrictEqual(plugin._splitParagraphs(null), []);
    });

    test('单段短文本不切分', () => {
        const plugin = makePlugin();
        const parts = plugin._splitParagraphs('短文本');
        assert.strictEqual(parts.length, 1);
        assert.strictEqual(parts[0], '短文本');
    });

    test('_sendParagraphs 逐条发送', async () => {
        const plugin = makePlugin();
        const { ctx, sentMessages } = makeMockCtx();
        await plugin._sendParagraphs(ctx, '段A\n\n段B\n\n段C');
        assert.strictEqual(sentMessages.length, 3);
        assert.strictEqual(sentMessages[0].content, '段A');
        assert.strictEqual(sentMessages[1].content, '段B');
        assert.strictEqual(sentMessages[2].content, '段C');
        // 每条都带 rpMode metadata
        for (const m of sentMessages) {
            assert.strictEqual(m.metadata.rpMode, true);
        }
    });
});

describe('SubTask 2.3: 选项格式化', () => {
    test('选项格式化为 >选项X： 文本', async () => {
        const plugin = makePlugin();
        const { ctx, sentMessages } = makeMockCtx();
        const options = [
            { label: '1', text: '攻击' },
            { label: '2', text: '防御' },
            { label: '3', text: '逃跑' },
        ];
        await plugin._sendOptions(ctx, options);
        assert.strictEqual(sentMessages.length, 1);
        const content = sentMessages[0].content;
        assert.ok(content.includes('>选项1：攻击'), `应包含 >选项1：攻击，实际: ${content}`);
        assert.ok(content.includes('>选项2：防御'), `应包含 >选项2：防御，实际: ${content}`);
        assert.ok(content.includes('>选项3：逃跑'), `应包含 >选项3：逃跑，实际: ${content}`);
    });

    test('无 label 时用中文数字序号', async () => {
        const plugin = makePlugin();
        const { ctx, sentMessages } = makeMockCtx();
        const options = [
            { text: '前进' },
            { text: '后退' },
        ];
        await plugin._sendOptions(ctx, options);
        const content = sentMessages[0].content;
        assert.ok(content.includes('>选项一：前进'), `应包含中文数字序号，实际: ${content}`);
        assert.ok(content.includes('>选项二：后退'), `应包含中文数字序号，实际: ${content}`);
    });

    test('空选项数组不发送', async () => {
        const plugin = makePlugin();
        const { ctx, sentMessages } = makeMockCtx();
        await plugin._sendOptions(ctx, []);
        assert.strictEqual(sentMessages.length, 0);
    });

    test('_toChineseNum 1-10 用中文，>10 用阿拉伯数字', () => {
        const plugin = makePlugin();
        assert.strictEqual(plugin._toChineseNum(1), '一');
        assert.strictEqual(plugin._toChineseNum(5), '五');
        assert.strictEqual(plugin._toChineseNum(10), '十');
        assert.strictEqual(plugin._toChineseNum(11), '11');
        assert.strictEqual(plugin._toChineseNum(20), '20');
    });
});

describe('SubTask 2.4: 实时状态图触发逻辑', () => {
    test('state.visible 非空时触发渲染', async () => {
        const plugin = makePlugin();
        const { ctx, sentMessages } = makeMockCtx();

        // mock 渲染器返回 file:// URL
        let renderCalled = false;
        let renderCalledWith = null;
        plugin._getStateRenderer = async () => ({
            render: async (content, css, template, rules, vars) => {
                renderCalled = true;
                renderCalledWith = { content, css, template };
                return 'file:///tmp/state-card.png';
            },
        });
        // 标记为已初始化（跳过真实 puppeteer）
        plugin._stateRendererInitFailed = false;

        const visibleState = {
            time: '傍晚',
            location: '寒月宫',
            characters: [{ name: '师尊', status: '慵懒', mood: '愉悦' }],
        };
        const result = new AgentRunResult({
            runId: 'r1',
            state: { visible: visibleState },
        });
        result.addArtifact({ type: 'main', text: '正文内容' });

        await plugin._renderToIM(result, ctx);

        // 应触发渲染
        assert.ok(renderCalled, '应调用状态图渲染器');
        // state HTML 在 template.html 中（_renderStateImage 把 HTML 放到 template.html）
        assert.ok(renderCalledWith.template.html.includes('state-card'), `HTML 应包含 state-card 类，实际: ${renderCalledWith.template.html}`);

        // 应发送：正文 + 状态卡（带 mediaUrls）
        const stateMsg = sentMessages.find(m => m.mediaUrls && m.mediaUrls.length > 0);
        assert.ok(stateMsg, '应有一条带图片的消息');
        assert.ok(stateMsg.mediaUrls[0].includes('state-card.png'), `图片 URL 应含 state-card.png，实际: ${stateMsg.mediaUrls[0]}`);
    });

    test('state.visible 为空时跳过状态图', async () => {
        const plugin = makePlugin();
        const { ctx, sentMessages } = makeMockCtx();

        let renderCalled = false;
        plugin._getStateRenderer = async () => ({
            render: async () => { renderCalled = true; return 'file:///x.png'; },
        });

        const result = new AgentRunResult({ runId: 'r2' });
        result.addArtifact({ type: 'main', text: '仅正文' });

        await plugin._renderToIM(result, ctx);

        assert.ok(!renderCalled, 'state.visible 为空时不应触发渲染');
        // 只发正文
        assert.strictEqual(sentMessages.length, 1);
        assert.strictEqual(sentMessages[0].content, '仅正文');
    });

    test('渲染器不可用时降级为文本状态卡', async () => {
        const plugin = makePlugin();
        const { ctx, sentMessages } = makeMockCtx();

        // mock 渲染器不可用
        plugin._getStateRenderer = async () => null;
        plugin._stateRendererInitFailed = false;

        const visibleState = {
            time: '夜晚',
            location: '山顶',
            characters: ['路人甲', '路人乙'],
        };
        const result = new AgentRunResult({
            runId: 'r3',
            state: { visible: visibleState },
        });

        await plugin._renderToIM(result, ctx);

        // 应有降级文本状态卡
        const stateMsg = sentMessages.find(m => m.content.includes('状态卡'));
        assert.ok(stateMsg, '应有降级文本状态卡');
        assert.ok(stateMsg.content.includes('时间：夜晚'), `应含时间，实际: ${stateMsg.content}`);
        assert.ok(stateMsg.content.includes('地点：山顶'), `应含地点，实际: ${stateMsg.content}`);
        assert.ok(stateMsg.content.includes('路人甲'), `应含角色，实际: ${stateMsg.content}`);
    });

    test('_formatStateText 处理字符串数组和对象数组', () => {
        const plugin = makePlugin();
        // 字符串数组
        const text1 = plugin._formatStateText({
            time: '早上',
            characters: ['Alice', 'Bob'],
        });
        assert.ok(text1.includes('时间：早上'));
        assert.ok(text1.includes('Alice'));
        assert.ok(text1.includes('Bob'));

        // 对象数组
        const text2 = plugin._formatStateText({
            location: '广场',
            characters: [
                { name: '甲', status: '站立', mood: '平静' },
                { name: '乙', status: '奔跑' },
            ],
        });
        assert.ok(text2.includes('地点：广场'));
        assert.ok(text2.includes('甲'));
        assert.ok(text2.includes('状态:站立'));
        assert.ok(text2.includes('心情:平静'));
    });

    test('_buildStateCardHtml 包含场景和角色信息', () => {
        const plugin = makePlugin();
        const result = new AgentRunResult({ runId: 'r', meta: { turn: 5, style: '武侠' } });
        const html = plugin._buildStateCardHtml({
            time: '黄昏',
            location: '客栈',
            characters: [{ name: '侠客', status: '饮酒' }],
        }, result);
        assert.ok(html.includes('state-card'));
        assert.ok(html.includes('黄昏'));
        assert.ok(html.includes('客栈'));
        assert.ok(html.includes('侠客'));
        assert.ok(html.includes('饮酒'));
        assert.ok(html.includes('轮次 5'));
        assert.ok(html.includes('武侠'));
    });
});

describe('SubTask 2.5: 多 Bot 绑定/解绑', () => {
    test('/rp bindbot 绑定 botId 到 profile', async () => {
        const plugin = makePlugin();
        const { ctx, sentMessages } = makeMockCtx();

        // mock session 文件系统
        let savedSession = null;
        const session = plugin._defaultSession();
        ctx.fs = {
            exists: () => true,
            read: () => JSON.stringify(session),
            write: (path, content) => { savedSession = JSON.parse(content); },
            list: () => [],
        };

        ctx.args = ['bindbot', 'bot123', 'gm-profile'];

        await plugin._cmdBindBot(ctx);

        assert.ok(savedSession, '应保存会话');
        assert.strictEqual(savedSession.botProfileMap.bot123, 'gm-profile');
        assert.ok(sentMessages[0].content.includes('已绑定'));
        assert.ok(sentMessages[0].content.includes('bot123'));
        assert.ok(sentMessages[0].content.includes('gm-profile'));
    });

    test('/rp unbindbot 解绑', async () => {
        const plugin = makePlugin();
        const { ctx, sentMessages } = makeMockCtx();

        const session = plugin._defaultSession();
        session.botProfileMap = { bot123: 'gm-profile', bot456: 'npc-profile' };
        let savedSession = null;
        ctx.fs = {
            exists: () => true,
            read: () => JSON.stringify(session),
            write: (path, content) => { savedSession = JSON.parse(content); },
            list: () => [],
        };

        ctx.args = ['unbindbot', 'bot123'];
        await plugin._cmdUnbindBot(ctx);

        assert.ok(savedSession, '应保存会话');
        assert.ok(!('bot123' in savedSession.botProfileMap), 'bot123 应被解绑');
        assert.strictEqual(savedSession.botProfileMap.bot456, 'npc-profile', 'bot456 应保留');
    });

    test('unbindbot 未绑定的 botId 提示', async () => {
        const plugin = makePlugin();
        const { ctx, sentMessages } = makeMockCtx();

        const session = plugin._defaultSession();
        session.botProfileMap = {};
        ctx.fs = {
            exists: () => true,
            read: () => JSON.stringify(session),
            write: () => {},
            list: () => [],
        };

        ctx.args = ['unbindbot', 'unknown'];
        await plugin._cmdUnbindBot(ctx);

        assert.ok(sentMessages[0].content.includes('未绑定'));
    });

    test('_resolveProfile 群聊单绑定用该绑定', () => {
        const plugin = makePlugin();
        const { ctx } = makeMockCtx({ chatType: 'group' });
        const session = plugin._defaultSession();
        session.botProfileMap = { botA: 'gm-profile' };

        const profile = plugin._resolveProfile(ctx, session);
        assert.strictEqual(profile, 'gm-profile');
    });

    test('_resolveProfile 群聊多绑定用 selfBotId', () => {
        const plugin = makePlugin({ config: { selfBotId: 'botB' } });
        const { ctx } = makeMockCtx({ chatType: 'group' });
        const session = plugin._defaultSession();
        session.botProfileMap = { botA: 'gm-profile', botB: 'npc-profile' };

        const profile = plugin._resolveProfile(ctx, session);
        assert.strictEqual(profile, 'npc-profile');
    });

    test('_resolveProfile 非群聊用 session.profile', () => {
        const plugin = makePlugin();
        const { ctx } = makeMockCtx({ chatType: 'private' });
        const session = plugin._defaultSession();
        session.profile = 'default-rp';
        session.botProfileMap = { botA: 'gm-profile' };

        const profile = plugin._resolveProfile(ctx, session);
        assert.strictEqual(profile, 'default-rp');
    });

    test('_resolveProfile 无任何 profile 返回空串', () => {
        const plugin = makePlugin();
        const { ctx } = makeMockCtx({ chatType: 'private' });
        const session = plugin._defaultSession();

        const profile = plugin._resolveProfile(ctx, session);
        assert.strictEqual(profile, '');
    });
});

describe('引擎模式 vs 兜底模式切换', () => {
    test('_isAgentAvailable 在 ctx.agent.run 存在时返回 true', () => {
        const plugin = makePlugin();
        const { ctx } = makeMockCtx({
            agent: { run: () => {}, getStatus: () => {} },
        });
        assert.strictEqual(plugin._isAgentAvailable(ctx), true);
    });

    test('_isAgentAvailable 在 ctx.agent 无 run 方法时返回 false', () => {
        const plugin = makePlugin();
        const { ctx } = makeMockCtx({
            agent: { getStatus: () => {} }, // 缺 run
        });
        assert.strictEqual(plugin._isAgentAvailable(ctx), false);
    });

    test('_isAgentAvailable 在 ctx.agent 抛错时返回 false', () => {
        const plugin = makePlugin();
        const { ctx } = makeMockCtx();
        // ctx.agent getter 抛错（无 agent 权限）
        Object.defineProperty(ctx, 'agent', {
            get() { throw new Error('需要 agent 权限'); },
        });
        assert.strictEqual(plugin._isAgentAvailable(ctx), false);
    });

    test('_isAgentAvailable 在 ctx.agent 为 undefined 时返回 false', () => {
        const plugin = makePlugin();
        const { ctx } = makeMockCtx();
        assert.strictEqual(plugin._isAgentAvailable(ctx), false);
    });
});

describe('SubTask 2.1: _renderToIM 完整流程', () => {
    test('正文 + 选项 + 状态图 全流程', async () => {
        const plugin = makePlugin();
        const { ctx, sentMessages } = makeMockCtx();

        // mock 状态图渲染器
        plugin._getStateRenderer = async () => ({
            render: async () => 'file:///tmp/state.png',
        });
        plugin._stateRendererInitFailed = false;

        const result = new AgentRunResult({
            runId: 'r-full',
            state: {
                visible: {
                    time: '清晨',
                    location: '书房',
                    characters: [{ name: '先生', status: '授课' }],
                },
            },
            meta: { turn: 3, style: '古典' },
        });
        result.addArtifact({ type: 'main', text: '第一段正文。\n\n第二段正文。' });
        result.addOption({ label: '1', text: '认真听讲' });
        result.addOption({ label: '2', text: '走神' });

        await plugin._renderToIM(result, ctx);

        // 应发送：正文段1 + 正文段2 + 选项 + 状态卡 = 4 条
        assert.strictEqual(sentMessages.length, 4, `应发送 4 条消息，实际 ${sentMessages.length}: ${sentMessages.map(m => m.content).join('|')}`);

        // 正文两段
        assert.strictEqual(sentMessages[0].content, '第一段正文。');
        assert.strictEqual(sentMessages[1].content, '第二段正文。');

        // 选项
        const optMsg = sentMessages[2];
        assert.ok(optMsg.content.includes('>选项1：认真听讲'));
        assert.ok(optMsg.content.includes('>选项2：走神'));

        // 状态卡（带图）
        const stateMsg = sentMessages[3];
        assert.ok(stateMsg.mediaUrls.length > 0, '状态卡应带图片');
    });

    test('仅正文无选项无状态', async () => {
        const plugin = makePlugin();
        const { ctx, sentMessages } = makeMockCtx();

        const result = new AgentRunResult({ runId: 'r-text-only' });
        result.addArtifact({ type: 'main', text: '只有正文。' });

        await plugin._renderToIM(result, ctx);

        assert.strictEqual(sentMessages.length, 1);
        assert.strictEqual(sentMessages[0].content, '只有正文。');
    });

    test('全空时发兜底提示', async () => {
        const plugin = makePlugin();
        const { ctx, sentMessages } = makeMockCtx();

        const result = new AgentRunResult({ runId: 'r-empty' });

        await plugin._renderToIM(result, ctx);

        assert.strictEqual(sentMessages.length, 1);
        assert.ok(sentMessages[0].content.includes('无可见输出'));
    });

    test('result 为 null 不抛错', async () => {
        const plugin = makePlugin();
        const { ctx, sentMessages } = makeMockCtx();

        await plugin._renderToIM(null, ctx);
        assert.strictEqual(sentMessages.length, 0);
    });
});

describe('懒注册 IM 适配器', () => {
    test('_ensureSurfaceAdapter 首次调用注册', () => {
        const plugin = makePlugin();
        let registered = null;
        const { ctx } = makeMockCtx({
            surface: {
                register: (adapter) => {
                    registered = adapter;
                    return () => {};
                },
            },
        });

        const ok = plugin._ensureSurfaceAdapter(ctx);
        assert.strictEqual(ok, true);
        assert.strictEqual(registered.name, 'im-default');
        assert.strictEqual(registered.surfaceType, 'im');
        assert.strictEqual(typeof registered.render, 'function');
        assert.strictEqual(plugin._surfaceAdapterRegistered, true);
    });

    test('_ensureSurfaceAdapter 二次调用不重复注册', () => {
        const plugin = makePlugin();
        let count = 0;
        const { ctx } = makeMockCtx({
            surface: {
                register: () => { count++; return () => {}; },
            },
        });

        plugin._ensureSurfaceAdapter(ctx);
        plugin._ensureSurfaceAdapter(ctx);
        assert.strictEqual(count, 1);
    });

    test('_ensureSurfaceAdapter 无 surface 时返回 false', () => {
        const plugin = makePlugin();
        const { ctx } = makeMockCtx(); // 无 surface

        const ok = plugin._ensureSurfaceAdapter(ctx);
        assert.strictEqual(ok, false);
        assert.strictEqual(plugin._surfaceAdapterRegistered, false);
    });
});

describe('会话状态管理', () => {
    test('_defaultSession 包含 botProfileMap', () => {
        const plugin = makePlugin();
        const s = plugin._defaultSession();
        assert.ok(s.botProfileMap);
        assert.deepStrictEqual(s.botProfileMap, {});
        assert.strictEqual(s.profile, '');
        assert.strictEqual(s.character, '');
        assert.strictEqual(s.active, false);
    });

    test('_getSession 合并默认字段（兼容旧会话文件）', async () => {
        const plugin = makePlugin();
        const { ctx } = makeMockCtx();
        // 旧会话文件无 botProfileMap
        ctx.fs = {
            exists: () => true,
            read: () => JSON.stringify({ active: true, character: '旧角色', turnCount: 5 }),
            write: () => {},
            list: () => [],
        };

        const session = await plugin._getSession(ctx);
        assert.strictEqual(session.active, true);
        assert.strictEqual(session.character, '旧角色');
        assert.strictEqual(session.turnCount, 5);
        assert.ok(session.botProfileMap, '应补全 botProfileMap');
        assert.deepStrictEqual(session.botProfileMap, {});
    });
});
