/**
 * 配置安全回归测试（P0）
 *
 * 守护的核心不变量：
 *   1. deepMerge 不得被 __proto__ / constructor / prototype 污染
 *      （历史漏洞：POST /api/gateway/config 无鉴权 + 此处可污染全局原型）
 *   2. 敏感字段（token/secret/apiKey）经 API 返回时必须脱敏
 *   3. 脱敏掩码回传时不得覆盖真实凭据（否则前端一保存就清空 token）
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import configManager from '../server/utils/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 导入 configManager 会在仓库根创建 config/ 目录，测试后清理。
 *
 * ⚠️ 这里必须用**绝对路径**并且只删仓库自己的，绝不能用相对路径。
 * 曾经写成 `fs.rmSync('config', {recursive:true})`，那是相对 CWD 的——
 * 谁在自己的部署目录里跑一次 `npm test`，config/（全部 bot token）、
 * data/（会话历史、聊天存档、插件配置与数据）就被整个删掉，
 * 而且测试还是全绿的，没有任何提示。真机上踩过一次。
 *
 * 只删本次测试确实由 configManager 创建出来的那份，且路径必须落在仓库内。
 */
after(() => {
    for (const name of ['config', 'logs']) {
        const dir = path.join(REPO_ROOT, name);
        // 双保险：解析后必须仍在仓库根之下，且不能就是仓库根本身
        const resolved = path.resolve(dir);
        if (!resolved.startsWith(REPO_ROOT + path.sep) || resolved === REPO_ROOT) continue;
        try { fs.rmSync(resolved, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
    // data/ 不删：里面可能有聊天存档等真实数据，而这些测试也并不往里写东西
});

describe('deepMerge 原型污染防护', () => {
    test('__proto__ 键被跳过，不污染 Object.prototype', () => {
        const target = {};
        // JSON.parse 产生的 __proto__ 是自有属性，能被 Object.keys 枚举到——
        // 这正是攻击载荷的形态
        const malicious = JSON.parse('{"__proto__": {"polluted": "yes"}}');

        configManager.deepMerge(target, malicious);

        assert.strictEqual({}.polluted, undefined, 'Object.prototype 不得被污染');
        assert.strictEqual(({}).polluted, undefined);
    });

    test('constructor / prototype 键同样被跳过', () => {
        const target = {};
        configManager.deepMerge(target, JSON.parse('{"constructor": {"x": 1}, "prototype": {"y": 2}}'));

        assert.strictEqual(typeof {}.constructor, 'function', 'constructor 不应被替换为普通对象');
        assert.strictEqual({}.y, undefined);
    });

    test('正常嵌套合并仍然工作', () => {
        const target = { a: { b: 1, c: 2 } };
        configManager.deepMerge(target, { a: { c: 99, d: 3 } });

        assert.deepStrictEqual(target.a, { b: 1, c: 99, d: 3 });
    });

    test('数组整体替换而非合并', () => {
        const target = { list: [1, 2, 3] };
        configManager.deepMerge(target, { list: [9] });
        assert.deepStrictEqual(target.list, [9]);
    });
});

describe('敏感字段脱敏', () => {
    test('token / secret / apiKey 被打码，仅保留末 4 位', () => {
        const obj = {
            adapters: {
                telegram: { botToken: '1234567890:ABCdefGHI' },
                qq: { accessToken: 'secret-abcd' },
            },
            runtime: { llm: { apiKey: 'sk-live-xyz9' } },
        };
        const redacted = configManager._redact(structuredClone(obj));

        assert.ok(redacted.adapters.telegram.botToken.startsWith('***'), 'botToken 应被打码');
        assert.ok(!redacted.adapters.telegram.botToken.includes('ABCdefGHI'), '原值不得泄露');
        assert.strictEqual(redacted.adapters.qq.accessToken, '***abcd', '保留末4位便于核对');
        assert.strictEqual(redacted.runtime.llm.apiKey, '***xyz9');
    });

    test('非敏感字段不受影响', () => {
        const redacted = configManager._redact({ server: { port: 3210, host: '127.0.0.1' } });
        assert.strictEqual(redacted.server.port, 3210);
        assert.strictEqual(redacted.server.host, '127.0.0.1');
    });

    test('空字符串不打码（避免把"未配置"显示成***）', () => {
        const redacted = configManager._redact({ adapters: { discord: { botToken: '' } } });
        assert.strictEqual(redacted.adapters.discord.botToken, '');
    });
});

describe('掩码回传保护', () => {
    test('回传 *** 掩码时保留真实凭据，不被覆盖', () => {
        const target = { adapters: { telegram: { botToken: 'REAL-TOKEN-1234' } } };
        // 模拟前端把 getRedacted() 的结果原样 POST 回来
        configManager.deepMerge(target, { adapters: { telegram: { botToken: '***1234' } } });

        assert.strictEqual(
            target.adapters.telegram.botToken,
            'REAL-TOKEN-1234',
            '掩码不得覆盖真实 token，否则用户一保存配置就丢凭据',
        );
    });

    test('真实新值可以正常覆盖', () => {
        const target = { adapters: { telegram: { botToken: 'OLD' } } };
        configManager.deepMerge(target, { adapters: { telegram: { botToken: 'NEW-REAL-TOKEN' } } });
        assert.strictEqual(target.adapters.telegram.botToken, 'NEW-REAL-TOKEN');
    });

    test('原值为空时，掩码保护不阻止写入', () => {
        const target = { adapters: { telegram: { botToken: '' } } };
        configManager.deepMerge(target, { adapters: { telegram: { botToken: '***abcd' } } });
        // 原值为空 → 不触发保护（这是边界行为，记录下来防止回归时行为漂移）
        assert.strictEqual(target.adapters.telegram.botToken, '***abcd');
    });
});

describe('默认配置完整性', () => {
    test('关键安全默认值正确', () => {
        assert.strictEqual(configManager.get('server.host'), '127.0.0.1', '默认只绑本地');
        assert.notStrictEqual(configManager.get('server.requireAuth'), false, '默认强制鉴权');
    });

    test('首次启动自动生成鉴权 token', () => {
        const token = configManager.get('server.authToken');
        assert.ok(typeof token === 'string' && token.length >= 32, '应自动生成足够长的 token');
    });

    test('点分路径读取生效', () => {
        assert.strictEqual(typeof configManager.get('messageQueue.maxRetries'), 'number');
        assert.strictEqual(configManager.get('不存在.的.路径'), undefined);
    });
});

describe('配置写盘失败必须能被上层感知', () => {
    /**
     * 这条防的是"静默降级"：save() 以前吞掉异常直接返回，
     * 于是只读挂载 / 磁盘满时面板照样弹"配置已更新"，
     * 用户重启后才发现改动没了，而且完全不知道发生过什么。
     */
    test('save() 返回布尔，成功时为 true 且清空 lastSaveError', () => {
        const ok = configManager.save();
        assert.strictEqual(ok, true);
        assert.strictEqual(configManager.lastSaveError, null);
    });

    test('写盘抛异常时 save() 返回 false 并记录原因', (t) => {
        t.mock.method(fs, 'writeFileSync', () => {
            const e = new Error('EROFS: read-only file system');
            e.code = 'EROFS';
            throw e;
        });
        assert.strictEqual(configManager.save(), false);
        assert.match(configManager.lastSaveError, /read-only/);
    });

    test('只读保护状态下 save() 返回 false 而非静默跳过', () => {
        const prev = configManager._readonly;
        configManager._readonly = true;
        try {
            assert.strictEqual(configManager.save(), false);
            assert.match(configManager.lastSaveError, /只读/);
        } finally {
            configManager._readonly = prev;
        }
    });

    test('update() / set() 把写盘结果透传给调用方', (t) => {
        assert.strictEqual(configManager.update({ autoReply: { responseDelay: 501 } }), true);
        assert.strictEqual(configManager.set('autoReply.responseDelay', 502), true);

        t.mock.method(fs, 'writeFileSync', () => { throw new Error('ENOSPC: no space left on device'); });
        assert.strictEqual(configManager.update({ autoReply: { responseDelay: 503 } }), false);
        assert.strictEqual(configManager.set('autoReply.responseDelay', 504), false);

        // 内存里仍然改掉了——这正是"报成功"最误导人的地方：读回来是新值，
        // 磁盘上还是旧值。所以必须靠返回值区分，不能靠再 get 一次。
        assert.strictEqual(configManager.get('autoReply.responseDelay'), 504);
    });
});
