import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { QQOfficialAdapter } from '../server/adapters/qqofficial-adapter.js';
import { DingTalkAdapter } from '../server/adapters/dingtalk-adapter.js';
import { silentLogger } from './helpers.js';

/**
 * 这些 SDK 是 optionalDependencies，CI 里用 --omit=optional 跳过安装。
 * 所以测试分两层：
 *   - 静态断言（永远跑）：适配器自己产出的值必须落在已知合法集合内；
 *   - 契约断言（装了 SDK 才跑）：拿真 SDK 的导出去核对上面那个"已知合法集合"，
 *     确保 fixture 不会随 SDK 升级而悄悄过时。
 */
async function tryImport(name) {
    try { return await import(name); } catch { return null; }
}

// 取自 qq-official-bot 的 Intends 枚举。SDK 对不认识的名字只 warn 后跳过，
// 写错了会连上却收不到任何消息——所以要把合法集合钉死。
const VALID_QQ_INTENTS = new Set([
    'GUILDS', 'GUILD_MEMBERS', 'GUILD_MESSAGES', 'GUILD_MESSAGE_REACTIONS',
    'DIRECT_MESSAGE', 'GROUP_MEMBER', 'GROUP_AND_C2C_EVENT', 'INTERACTION',
    'MESSAGE_AUDIT', 'FORUMS_EVENT', 'AUDIO_ACTION', 'PUBLIC_GUILD_MESSAGES',
]);

describe('QQ 官方机器人适配器', () => {
    const make = (config = {}) => {
        const a = new QQOfficialAdapter({ appId: 'x', secret: 'y', ...config });
        a.logger = silentLogger;
        return a;
    };

    test('默认配置下的 intents 全部是 SDK 认识的名字', () => {
        for (const intent of make()._intents()) {
            assert.ok(VALID_QQ_INTENTS.has(intent), `${intent} 不是合法的 intent 名`);
        }
    });

    test('默认订阅群聊与单聊', () => {
        // 这两者在 SDK 里合并成同一个 intent，不能分开订阅
        assert.ok(make()._intents().includes('GROUP_AND_C2C_EVENT'));
    });

    test('关掉频道后仍保留群/单聊订阅', () => {
        const intents = make({ enableGuild: false })._intents();
        assert.deepEqual(intents, ['GROUP_AND_C2C_EVENT']);
    });

    test('全部关掉时兜底订阅群/单聊，不会得到空 intents', () => {
        const intents = make({ enableGroup: false, enableC2C: false, enableGuild: false })._intents();
        assert.deepEqual(intents, ['GROUP_AND_C2C_EVENT']);
        assert.ok(intents.length > 0);
    });

    describe('时间戳归一化', () => {
        const conv = (v) => make()._toMillis(v);

        test('秒级 epoch 被换算成毫秒', () => {
            // SDK 的 parse 会做 /1000，直接 new Date(秒) 会落到 1970 年
            const seconds = 1735689600; // 2025-01-01T00:00:00Z
            assert.equal(conv(seconds), 1735689600000);
            assert.equal(new Date(conv(seconds)).getUTCFullYear(), 2025);
        });

        test('毫秒级 epoch 原样保留', () => {
            assert.equal(conv(1735689600000), 1735689600000);
        });

        test('ISO 字符串可解析', () => {
            assert.equal(conv('2025-01-01T00:00:00.000Z'), 1735689600000);
        });

        test('缺失或非法值回落到当前时间', () => {
            const before = Date.now();
            for (const bad of [undefined, null, 0, '', 'not-a-date']) {
                const got = conv(bad);
                assert.ok(got >= before, `${JSON.stringify(bad)} 应回落到当前时间，得到 ${got}`);
            }
        });
    });

    test('契约：intents 名字与真实 SDK 的 Intends 枚举一致', async (t) => {
        const sdk = await tryImport('qq-official-bot');
        if (!sdk) return t.skip('qq-official-bot 未安装');
        const real = new Set(Object.keys(sdk.Intends).filter(k => !/^\d+$/.test(k)));
        assert.deepEqual([...VALID_QQ_INTENTS].filter(i => !real.has(i)), [],
            'fixture 里有 SDK 已经不认的 intent，需同步更新');
        for (const intent of make()._intents()) {
            assert.ok(real.has(intent), `${intent} 不在真实 Intends 中`);
        }
    });

    test('契约：Bot 缺少 mode 会直接抛，所以适配器必须传', async (t) => {
        const sdk = await tryImport('qq-official-bot');
        if (!sdk) return t.skip('qq-official-bot 未安装');
        assert.throws(
            () => new sdk.Bot({ appid: 'a', secret: 'b', intents: ['GROUP_AND_C2C_EVENT'], logLevel: 'off' }),
            /receiver mode/i,
            '若 SDK 不再要求 mode，可以简化适配器'
        );
        assert.doesNotThrow(
            () => new sdk.Bot({ mode: 'websocket', appid: 'a', secret: 'b', intents: ['GROUP_AND_C2C_EVENT'], logLevel: 'off' })
        );
    });
});

describe('钉钉适配器', () => {
    const make = () => {
        const a = new DingTalkAdapter({ clientId: 'x', clientSecret: 'y' });
        a.logger = silentLogger;
        return a;
    };

    test('收到推送后回执 messageId，否则钉钉会每 60s 重推同一条', () => {
        const a = make();
        const sent = [];
        a.client = { socketCallBackResponse: (id, body) => sent.push({ id, body }) };
        a._EventAck = { SUCCESS: 'SUCCESS', LATER: 'LATER' };

        a._ack({ headers: { messageId: 'msg-1', topic: '/v1.0/im/bot/messages/get' }, data: '{}' });

        assert.equal(sent.length, 1);
        assert.equal(sent[0].id, 'msg-1');
        assert.equal(sent[0].body.status, 'SUCCESS');
    });

    test('缺 messageId 或未连接时静默跳过，不抛', () => {
        const a = make();
        a.client = { socketCallBackResponse: () => { throw new Error('不该被调用'); } };
        assert.doesNotThrow(() => a._ack({ headers: {} }));
        assert.doesNotThrow(() => a._ack({}));
        assert.doesNotThrow(() => a._ack(undefined));

        a.client = null;
        assert.doesNotThrow(() => a._ack({ headers: { messageId: 'm' } }));
    });

    test('回执失败不会打断消息处理', () => {
        const a = make();
        a.client = { socketCallBackResponse: () => { throw new Error('socket 已关闭'); } };
        assert.doesNotThrow(() => a._ack({ headers: { messageId: 'm' } }));
    });

    test('契约：SDK 忽略回调返回值，必须显式调 socketCallBackResponse', async (t) => {
        const sdk = await tryImport('dingtalk-stream');
        if (!sdk) return t.skip('dingtalk-stream 未安装');
        const client = new sdk.DWClient({ clientId: 'a', clientSecret: 'b' });
        assert.equal(typeof client.socketCallBackResponse, 'function');
        assert.equal(sdk.TOPIC_ROBOT, '/v1.0/im/bot/messages/get');
        assert.equal(sdk.EventAck.SUCCESS, 'SUCCESS');
    });
});
