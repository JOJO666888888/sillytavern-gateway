/**
 * 环境变量配置层回归测试（P3-3，Docker 部署地基）
 *
 * 守护的核心不变量：
 *   1. env > 文件 > 默认值
 *   2. **env 注入的值绝不回写配置文件** —— config/ 在容器里通常是挂载卷，
 *      把 bot token 写进去等于凭据落盘，与"用 env 注入"的初衷相悖
 *   3. 类型转换正确（"true"→boolean、"1,2"→array、数字）
 *   4. 非法值不静默吞掉
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { applyEnvOverrides, ENV_MAP, isSecretPath, describeEnvVars, getByPath } from '../server/utils/env-config.js';

/** 构造一个最小的配置骨架（host 默认 0.0.0.0，与 DEFAULT_CONFIG 对齐） */
const baseConfig = () => ({
    server: { port: 3210, host: '0.0.0.0', authToken: '', requireAuth: true, allowedOrigins: [] },
    admins: [],
    adapters: {
        telegram: { enabled: false, botToken: '', allowedUsers: [] },
        qq: { enabled: false, wsUrl: 'ws://127.0.0.1:8080', reversePort: 8081 },
    },
    runtime: { enabled: false, tokenBudget: 8000, llm: { provider: 'openai', apiKey: '' } },
});

describe('类型转换', () => {
    test('number', () => {
        const c = baseConfig();
        applyEnvOverrides(c, { GATEWAY_PORT: '9999' });
        assert.strictEqual(c.server.port, 9999);
        assert.strictEqual(typeof c.server.port, 'number');
    });

    test('boolean 接受多种写法', () => {
        for (const truthy of ['true', 'TRUE', '1', 'yes', 'on']) {
            const c = baseConfig();
            applyEnvOverrides(c, { GATEWAY_TELEGRAM_ENABLED: truthy });
            assert.strictEqual(c.adapters.telegram.enabled, true, `"${truthy}" 应为 true`);
        }
        for (const falsy of ['false', '0', 'no', 'off']) {
            const c = baseConfig();
            c.adapters.telegram.enabled = true;
            applyEnvOverrides(c, { GATEWAY_TELEGRAM_ENABLED: falsy });
            assert.strictEqual(c.adapters.telegram.enabled, false, `"${falsy}" 应为 false`);
        }
    });

    test('array 支持逗号/空白分隔并去空项', () => {
        const c = baseConfig();
        applyEnvOverrides(c, { GATEWAY_ADMINS: 'qq:100, qq:200,,  qq:300 ' });
        assert.deepStrictEqual(c.admins, ['qq:100', 'qq:200', 'qq:300']);
    });

    test('string 原样写入', () => {
        const c = baseConfig();
        applyEnvOverrides(c, { GATEWAY_HOST: '0.0.0.0' });
        assert.strictEqual(c.server.host, '0.0.0.0');
    });

    test('空字符串是"显式设为空"，不被忽略', () => {
        const c = baseConfig();
        c.runtime.llm.baseUrl = 'http://old';
        applyEnvOverrides(c, { GATEWAY_LLM_BASE_URL: '' });
        assert.strictEqual(c.runtime.llm.baseUrl, '');
    });

    test('未设置的环境变量不影响原值', () => {
        const c = baseConfig();
        applyEnvOverrides(c, {});
        assert.strictEqual(c.server.port, 3210);
        assert.strictEqual(c.server.host, '0.0.0.0');
    });
});

describe('非法值处理', () => {
    test('非法数字被拒绝并报错，保持原值', () => {
        const c = baseConfig();
        const { errors, applied } = applyEnvOverrides(c, { GATEWAY_PORT: 'abc' });
        assert.strictEqual(c.server.port, 3210, '非法值不得写入');
        assert.strictEqual(errors.length, 1, '必须报错而非静默吞掉');
        assert.match(errors[0], /GATEWAY_PORT/);
        assert.ok(!applied.includes('server.port'));
    });

    test('非法布尔值被拒绝', () => {
        const c = baseConfig();
        const { errors } = applyEnvOverrides(c, { GATEWAY_TELEGRAM_ENABLED: '也许' });
        assert.strictEqual(c.adapters.telegram.enabled, false);
        assert.strictEqual(errors.length, 1);
    });

    test('一项非法不影响其它项生效', () => {
        const c = baseConfig();
        applyEnvOverrides(c, { GATEWAY_PORT: 'bad', GATEWAY_HOST: '0.0.0.0' });
        assert.strictEqual(c.server.host, '0.0.0.0', '合法项应照常应用');
    });
});

describe('applied 路径记录（save 时据此还原，防止凭据落盘）', () => {
    test('记录所有被覆盖的配置路径', () => {
        const c = baseConfig();
        const { applied } = applyEnvOverrides(c, {
            GATEWAY_HOST: '0.0.0.0',
            GATEWAY_TELEGRAM_BOT_TOKEN: 'secret',
        });
        assert.ok(applied.includes('server.host'));
        assert.ok(applied.includes('adapters.telegram.botToken'));
    });

    test('未设置的项不出现在 applied 中', () => {
        const c = baseConfig();
        const { applied } = applyEnvOverrides(c, { GATEWAY_HOST: '0.0.0.0' });
        assert.ok(!applied.includes('adapters.telegram.botToken'));
    });
});

describe('嵌套路径写入', () => {
    test('深层路径正确写入', () => {
        const c = baseConfig();
        applyEnvOverrides(c, { GATEWAY_LLM_API_KEY: 'sk-test' });
        assert.strictEqual(c.runtime.llm.apiKey, 'sk-test');
    });

    test('沿途缺失的层级自动创建', () => {
        const c = { server: {} };
        applyEnvOverrides(c, { GATEWAY_DINGTALK_CLIENT_ID: 'cid' });
        assert.strictEqual(c.adapters.dingtalk.clientId, 'cid');
    });

    test('getByPath 读取嵌套值', () => {
        const c = baseConfig();
        assert.strictEqual(getByPath(c, 'adapters.telegram.botToken'), '');
        assert.strictEqual(getByPath(c, '不存在.的.路径'), undefined);
    });
});

describe('映射表自洽性', () => {
    test('环境变量名唯一', () => {
        const names = ENV_MAP.map(e => e.env);
        assert.strictEqual(new Set(names).size, names.length, '环境变量名不得重复');
    });

    test('配置路径唯一', () => {
        const paths = ENV_MAP.map(e => e.path);
        assert.strictEqual(new Set(paths).size, paths.length, '配置路径不得重复映射');
    });

    test('全部使用 GATEWAY_ 前缀，命名规范一致', () => {
        for (const e of ENV_MAP) {
            assert.match(e.env, /^GATEWAY_[A-Z0-9_]+$/, `${e.env} 命名不规范`);
        }
    });

    test('类型合法', () => {
        for (const e of ENV_MAP) {
            assert.ok(['string', 'number', 'boolean', 'array'].includes(e.type), `${e.env} 类型非法`);
        }
    });

    test('所有凭据类配置都被标记为 secret', () => {
        // 判据用"叶子名以凭据词结尾"而非"路径含 token"——
        // 后者会把 runtime.tokenBudget（token 数量预算，不是凭据）误判为敏感项。
        const isCredential = (p) => /(token|secret|apikey|api_key|password)$/i.test(p.split('.').pop());
        const credentialish = ENV_MAP.filter(e => isCredential(e.path));

        assert.ok(credentialish.length >= 6, `应识别出多个凭据项，实际 ${credentialish.length}`);
        for (const e of credentialish) {
            assert.strictEqual(e.secret, true, `${e.env} (${e.path}) 是凭据，必须标记 secret:true`);
        }
    });

    test('非凭据项不被误标为 secret', () => {
        const budget = ENV_MAP.find(e => e.path === 'runtime.tokenBudget');
        assert.ok(budget, 'tokenBudget 应可通过环境变量配置');
        assert.notStrictEqual(budget.secret, true, 'tokenBudget 是数量预算，不是凭据');
    });

    test('覆盖了 Docker 部署必需的配置项', () => {
        const names = ENV_MAP.map(e => e.env);
        // 容器里没有这几项就没法用
        for (const required of ['GATEWAY_HOST', 'GATEWAY_PORT', 'GATEWAY_AUTH_TOKEN']) {
            assert.ok(names.includes(required), `缺少 Docker 必需的 ${required}`);
        }
    });

    test('六个平台的开关与凭据均可通过环境变量注入', () => {
        const names = ENV_MAP.map(e => e.env).join(' ');
        for (const p of ['QQ', 'TELEGRAM', 'DISCORD', 'FEISHU', 'QQOFFICIAL', 'DINGTALK']) {
            assert.ok(names.includes(`GATEWAY_${p}_ENABLED`), `${p} 缺少启用开关`);
        }
    });

    test('isSecretPath 正确识别', () => {
        assert.strictEqual(isSecretPath('adapters.telegram.botToken'), true);
        assert.strictEqual(isSecretPath('server.host'), false);
    });

    test('describeEnvVars 供文档生成，字段完整', () => {
        const list = describeEnvVars();
        assert.strictEqual(list.length, ENV_MAP.length);
        for (const d of list) {
            assert.ok(d.env && d.path && d.type);
            assert.strictEqual(typeof d.secret, 'boolean');
        }
    });
});
