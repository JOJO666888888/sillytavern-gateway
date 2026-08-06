/**
 * 插件系统回归测试（P1-E）
 *
 * 守护的核心不变量：
 *   1. 禁用插件必须**真正生效**——出站过滤器被回收
 *      （历史 bug：disablePlugin 不调 onUnload 也不摘过滤器，
 *        "禁用正则过滤器"后它仍在过滤每条回复）
 *   2. 启用/禁用幂等，重复操作不叠加注册
 *   3. schema default 在加载期注入，插件无需各自手写 _ensureDefaults
 */
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { applySchemaDefaults } from '../server/plugin-loader.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('schema 默认值注入', () => {
    test('补全缺失项，不覆盖已有值', () => {
        const merged = applySchemaDefaults(
            { a: { type: 'number', default: 5 }, b: { type: 'boolean', default: true } },
            { b: false },
        );
        assert.strictEqual(merged.a, 5, '缺失项应用 schema 默认值补全');
        assert.strictEqual(merged.b, false, '已有值不得被默认值覆盖');
    });

    test('对象/数组默认值做深拷贝，避免实例间共享引用', () => {
        const schema = { list: { type: 'array', default: [] } };
        const c1 = applySchemaDefaults(schema, {});
        const c2 = applySchemaDefaults(schema, {});
        c1.list.push('x');
        assert.strictEqual(c2.list.length, 0, '两个实例的默认值不得共享同一引用');
    });

    test('无 schema 时原样返回配置副本', () => {
        const cfg = { k: 1 };
        const out = applySchemaDefaults(null, cfg);
        assert.deepStrictEqual(out, cfg);
        assert.notStrictEqual(out, cfg, '应返回副本而非原对象');
    });

    test('schema 项无 default 字段时不注入 undefined 键', () => {
        const merged = applySchemaDefaults({ a: { type: 'string' } }, {});
        assert.ok(!('a' in merged), '没有 default 的项不应产生键');
    });
});

// 插件生命周期测试需要真实的 PluginManager + 内置插件，
// 会创建 config/ data/ 目录，测试后清理。
describe('插件生命周期（禁用真正生效）', () => {
    let gatewayCore, pm;

    before(async () => {
        ({ gatewayCore } = await import('../server/gateway-core.js'));
        const { PluginManager } = await import('../server/plugin-manager.js');
        const { sessionManager } = await import('../server/session-manager.js');
        const configManager = (await import('../server/utils/config.js')).default;

        pm = new PluginManager({ gateway: gatewayCore, sessionManager, configManager });
        await pm.init();
    });

    after(async () => {
        try { await pm?.shutdown?.(); } catch (_) { /* ignore */ }
        // 等待插件系统的异步资源（winston 文件流、undici 连接等）收敛后再退出，
        // 否则 --test-force-exit 强杀时可能撞上 Windows libuv 的 UV_HANDLE_CLOSING 断言崩溃
        await new Promise(r => setTimeout(r, 1500));
        // ⚠️ 必须用绝对路径，且不能删 data/（里面可能有聊天存档等真实数据）。
        // 曾经用相对路径递归删除，在部署目录跑一次 npm test 就把
        // config/（全部 bot token）、data/（会话历史、聊天存档）整个删掉。
        for (const name of ['config', 'logs']) {
            const dir = path.join(REPO_ROOT, name);
            const resolved = path.resolve(dir);
            if (!resolved.startsWith(REPO_ROOT + path.sep) || resolved === REPO_ROOT) continue;
            try { fs.rmSync(resolved, { recursive: true, force: true }); } catch (_) { /* ignore */ }
        }
    });

    const filterCount = (plugin) =>
        gatewayCore.outboundFilters.filter(f => f.pluginName === plugin).length;

    test('内置 regex-filter 启用时已注册出站过滤器', () => {
        assert.ok(filterCount('regex-filter') > 0, 'regex-filter 应有出站过滤器');
    });

    test('禁用后出站过滤器被回收（核心回归点）', async () => {
        await pm.disablePlugin('regex-filter');
        assert.strictEqual(
            filterCount('regex-filter'), 0,
            '禁用插件后其出站过滤器必须归零，否则"禁用"名存实亡',
        );
    });

    test('重复禁用幂等，不报错', async () => {
        const r = await pm.disablePlugin('regex-filter');
        assert.ok(r.success);
    });

    test('重新启用后过滤器恢复', async () => {
        await pm.enablePlugin('regex-filter');
        assert.ok(filterCount('regex-filter') > 0, '启用后应重新注册');
    });

    test('重复启用不叠加过滤器', async () => {
        const before = filterCount('regex-filter');
        await pm.enablePlugin('regex-filter');
        assert.strictEqual(filterCount('regex-filter'), before, '重复启用不得叠加注册');
    });

    test('禁用状态持久化到磁盘', async () => {
        await pm.disablePlugin('regex-filter');
        const states = JSON.parse(fs.readFileSync('data/plugins/_states.json', 'utf-8'));
        assert.strictEqual(states['regex-filter'].enabled, false, '状态需持久化，重启后保留用户选择');
        await pm.enablePlugin('regex-filter'); // 复原
    });

    test('操作不存在的插件返回失败而非抛异常', async () => {
        const r = await pm.disablePlugin('不存在的插件');
        assert.strictEqual(r.success, false);
    });
});
