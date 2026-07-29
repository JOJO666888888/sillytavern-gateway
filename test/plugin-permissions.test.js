/**
 * 插件权限与能力收窄回归测试（P3-2）
 *
 * 守护的核心不变量：
 *   1. 插件**永远**拿不到 bot token / 网关鉴权 token
 *      （历史漏洞：services.configManager 原样传出，一行代码窃取全部凭据）
 *   2. 危险能力需显式声明；未声明时调用抛出清晰错误而非静默成功
 *   3. 安装前静态扫描能识别高危模式
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import {
    PERMISSIONS, normalizePermissions, highestRisk,
    buildScopedServices, scanPluginRisk, formatInstallDisclosure,
} from '../server/plugin-permissions.js';
import { tmpDir } from './helpers.js';

/** 伪造一个 configManager，含敏感与非敏感字段 */
function fakeConfig() {
    const data = {
        server: { port: 3210, authToken: 'AUTH-TOKEN-SECRET-1234' },
        adapters: { telegram: { botToken: 'TG-TOKEN-SECRET-9999', requireMention: true } },
    };
    return {
        get(key) {
            return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
        },
        _redact(obj) {
            const re = /token|secret|apikey/i;
            const walk = (o) => {
                for (const k of Object.keys(o)) {
                    if (o[k] && typeof o[k] === 'object') walk(o[k]);
                    else if (typeof o[k] === 'string' && re.test(k)) {
                        o[k] = o[k].length > 4 ? `***${o[k].slice(-4)}` : '***';
                    }
                }
                return o;
            };
            return walk(obj);
        },
    };
}

const tmps = [];
after(() => { for (const t of tmps) t.cleanup(); });
function makeTmp() { const t = tmpDir(); tmps.push(t); return t.dir; }

describe('权限声明归一化', () => {
    test('未声明时授予默认安全集合', () => {
        const { granted } = normalizePermissions(undefined, 'p');
        assert.ok(granted.has('config'));
        assert.ok(granted.has('gateway.filter'));
        assert.ok(granted.has('gateway.send'));
        assert.ok(!granted.has('gateway.config'), '高危权限不得默认授予');
        assert.ok(!granted.has('sessions'), '会话读取不得默认授予');
    });

    test('显式声明的高危权限被授予', () => {
        const { granted } = normalizePermissions(['sessions', 'gateway.config'], 'p');
        assert.ok(granted.has('sessions'));
        assert.ok(granted.has('gateway.config'));
    });

    test('未知权限被忽略并记录', () => {
        const { granted, unknown } = normalizePermissions(['不存在的权限'], 'p');
        assert.deepStrictEqual(unknown, ['不存在的权限']);
        assert.ok(!granted.has('不存在的权限'));
    });

    test('兼容历史写法 permissions:["config"]', () => {
        const { granted } = normalizePermissions(['config'], 'p');
        assert.ok(granted.has('config'));
        assert.ok(!granted.has('gateway.config'), '"config" 不应被误解为网关全局配置权限');
    });

    test('风险等级取最高', () => {
        assert.strictEqual(highestRisk(['config']), 'low');
        assert.strictEqual(highestRisk(['config', 'sessions']), 'medium');
        assert.strictEqual(highestRisk(['config', 'gateway.config']), 'high');
    });
});

describe('凭据不再暴露（核心修复）', () => {
    test('services 中不再包含原始 configManager', () => {
        const { granted } = normalizePermissions([], 'p');
        const svc = buildScopedServices('p', granted, {
            gateway: {}, sessionManager: {}, configManager: fakeConfig(),
        });
        assert.strictEqual(svc.configManager, undefined, '原始 configManager 不得传给插件');
        assert.ok(svc.gatewayConfig, '应改为受控视图');
    });

    test('无权限时读取任何网关配置都返回 undefined', () => {
        const { granted } = normalizePermissions([], 'p');
        const svc = buildScopedServices('p', granted, { configManager: fakeConfig() });

        assert.strictEqual(svc.gatewayConfig.get('adapters.telegram.botToken'), undefined);
        assert.strictEqual(svc.gatewayConfig.get('server.authToken'), undefined);
        assert.strictEqual(svc.gatewayConfig.get('server.port'), undefined);
    });

    test('即使授予 gateway.config，凭据仍被脱敏', () => {
        const { granted } = normalizePermissions(['gateway.config'], 'p');
        const svc = buildScopedServices('p', granted, { configManager: fakeConfig() });

        const tok = svc.gatewayConfig.get('adapters.telegram.botToken');
        assert.ok(!String(tok).includes('SECRET'), `凭据必须脱敏，实际拿到: ${tok}`);
        assert.match(String(tok), /^\*\*\*/);

        const auth = svc.gatewayConfig.get('server.authToken');
        assert.ok(!String(auth).includes('SECRET'), '网关鉴权 token 必须脱敏');
    });

    test('授予 gateway.config 后非敏感字段可正常读取', () => {
        const { granted } = normalizePermissions(['gateway.config'], 'p');
        const svc = buildScopedServices('p', granted, { configManager: fakeConfig() });
        assert.strictEqual(svc.gatewayConfig.get('server.port'), 3210);
    });

    test('读取整个配置子树时，其中的凭据也被脱敏', () => {
        const { granted } = normalizePermissions(['gateway.config'], 'p');
        const svc = buildScopedServices('p', granted, { configManager: fakeConfig() });

        const sub = svc.gatewayConfig.get('adapters.telegram');
        assert.ok(!JSON.stringify(sub).includes('SECRET'), '子树中的 token 必须脱敏');
        assert.strictEqual(sub.requireMention, true, '非敏感字段保留');
    });
});

describe('能力收窄', () => {
    function svcWith(perms) {
        const gateway = {
            addOutboundFilter: () => () => {},
            addInboundFilter: () => () => {},
            sendMessage: () => 'sent',
            sendDirect: () => 'sent',
            getStatus: () => ({ ok: true }),
            registerAdapter: () => 'registered',
        };
        const { granted } = normalizePermissions(perms, 'p');
        return buildScopedServices('p', granted, { gateway, sessionManager: { getHistory: () => ['h'] }, configManager: fakeConfig() });
    }

    test('默认可注册出站过滤器并自动标注归属', () => {
        const managed = [];
        const gateway = {
            addOutboundFilter: (fn, opts) => { gateway._lastOpts = opts; return () => {}; },
        };
        const { granted } = normalizePermissions([], 'myplugin');
        const svc = buildScopedServices('myplugin', granted, { gateway, configManager: fakeConfig() }, managed);

        svc.gateway.addOutboundFilter(m => m, { name: 'f' });
        assert.strictEqual(gateway._lastOpts.pluginName, 'myplugin', '应自动标注归属插件');
        assert.strictEqual(managed.length, 1, '注销函数应被框架记录以便回收');
    });

    test('默认可发送消息', () => {
        assert.strictEqual(svcWith([]).gateway.sendMessage({}), 'sent');
    });

    test('未声明 sessions 时读会话历史抛出清晰错误', () => {
        const svc = svcWith([]);
        assert.throws(() => svc.sessionManager.getHistory(), /需要 "sessions" 权限/);
    });

    test('声明 sessions 后可读会话历史', () => {
        const svc = svcWith(['sessions']);
        assert.deepStrictEqual(svc.sessionManager.getHistory(), ['h']);
    });

    test('未声明 gateway.admin 时管理适配器被拒绝', () => {
        const svc = svcWith([]);
        assert.throws(() => svc.gateway.registerAdapter(), /需要 "gateway.admin" 权限/);
    });

    test('未声明 gateway.inbound 时注册入站过滤器被拒绝', () => {
        const svc = svcWith([]);
        assert.throws(() => svc.gateway.addInboundFilter(m => m, { name: 'x' }), /需要 "gateway.inbound" 权限/);
    });

    test('gateway.inbound 非默认授予', () => {
        const { granted } = normalizePermissions([], 'p');
        assert.ok(!granted.has('gateway.inbound'), 'inbound 过滤能看到全部消息，不应默认授予');
    });

    test('声明 gateway.inbound 后可注册入站过滤器并自动标注归属', () => {
        const managed = [];
        const gateway = {
            addInboundFilter: (fn, opts) => { gateway._lastOpts = opts; return () => {}; },
        };
        const { granted } = normalizePermissions(['gateway.inbound'], 'myplugin');
        const svc = buildScopedServices('myplugin', granted, { gateway, configManager: fakeConfig() }, managed);

        svc.gateway.addInboundFilter(m => m, { name: 'f' });
        assert.strictEqual(gateway._lastOpts.pluginName, 'myplugin', '应自动标注归属插件');
        assert.strictEqual(managed.length, 1, '注销函数应被框架记录以便回收');
    });

    test('gateway.inbound 是 medium 风险', () => {
        assert.strictEqual(PERMISSIONS['gateway.inbound'].risk, 'medium');
    });

    test('无害方法（getStatus）不受限制', () => {
        assert.deepStrictEqual(svcWith([]).gateway.getStatus(), { ok: true });
    });
});

describe('LLM 调用权限', () => {
    const fakeLLM = {
        chat: async () => 'reply',
        chatStream: async (_m, _s, onDelta) => { onDelta?.('r', 'r'); return 'r'; },
        chatWithTools: async () => ({ text: 't', toolCalls: [] }),
        runTools: async () => ({ text: 'final', steps: 1 }),
        verify: async () => ({ ok: true, message: 'ok' }),
    };

    test('llm 权限默认不授予', () => {
        const { granted } = normalizePermissions(undefined, 'p');
        assert.ok(!granted.has('llm'), 'llm 不得默认授予（调用要花钱）');
    });

    test('未声明 llm 时调用抛出清晰错误', () => {
        const { granted } = normalizePermissions([], 'p');
        const svc = buildScopedServices('p', granted, { configManager: fakeConfig(), llmService: fakeLLM });
        assert.throws(() => svc.llm.chat([]), /需要 "llm" 权限/);
        assert.throws(() => svc.llm.chatStream([]), /需要 "llm" 权限/);
        assert.throws(() => svc.llm.chatWithTools([], []), /需要 "llm" 权限/);
        assert.throws(() => svc.llm.runTools([], [], () => {}), /需要 "llm" 权限/);
        assert.throws(() => svc.llm.verify(), /需要 "llm" 权限/);
    });

    test('声明 llm 后可调用真实服务', async () => {
        const { granted } = normalizePermissions(['llm'], 'p');
        const svc = buildScopedServices('p', granted, { configManager: fakeConfig(), llmService: fakeLLM });
        assert.strictEqual(await svc.llm.chat([{ role: 'user', content: 'hi' }]), 'reply');
    });

    test('声明 llm 后可用工具调用（chatWithTools / runTools）', async () => {
        const { granted } = normalizePermissions(['llm'], 'p');
        const svc = buildScopedServices('p', granted, { configManager: fakeConfig(), llmService: fakeLLM });
        assert.deepStrictEqual(await svc.llm.chatWithTools([], []), { text: 't', toolCalls: [] });
        assert.deepStrictEqual(await svc.llm.runTools([], [], () => {}), { text: 'final', steps: 1 });
    });

    test('声明 llm 但服务缺失时仍为拒绝桩（不静默 undefined）', () => {
        const { granted } = normalizePermissions(['llm'], 'p');
        const svc = buildScopedServices('p', granted, { configManager: fakeConfig() });
        assert.throws(() => svc.llm.chat([]), /需要 "llm" 权限/);
    });

    test('llm 属于 medium 风险', () => {
        assert.strictEqual(highestRisk(['config', 'llm']), 'medium');
    });
});

describe('安装前静态风险扫描', () => {
    function writePlugin(files) {
        const dir = makeTmp();
        for (const [name, content] of Object.entries(files)) {
            fs.writeFileSync(path.join(dir, name), content);
        }
        return dir;
    }

    test('识别执行系统命令（critical）', () => {
        const dir = writePlugin({ 'index.js': "import { execSync } from 'child_process';\nexecSync('ls');" });
        const r = scanPluginRisk(dir, { fs, path });
        assert.strictEqual(r.maxLevel, 'critical');
        assert.ok(r.findings.some(f => f.label.includes('执行系统命令')));
    });

    test('识别疑似访问网关凭据（critical）', () => {
        const dir = writePlugin({ 'index.js': "const t = cfg.get('adapters.telegram.botToken');" });
        const r = scanPluginRisk(dir, { fs, path });
        assert.strictEqual(r.maxLevel, 'critical');
    });

    test('识别 eval / new Function（high）', () => {
        const dir = writePlugin({ 'index.js': 'const f = new Function("return 1");' });
        const r = scanPluginRisk(dir, { fs, path });
        assert.ok(r.findings.some(f => f.label.includes('动态执行代码')));
    });

    test('干净插件无高危发现', () => {
        const dir = writePlugin({ 'index.js': 'export default class P { async onLoad() {} }' });
        const r = scanPluginRisk(dir, { fs, path });
        assert.strictEqual(r.maxLevel, 'low');
        assert.strictEqual(r.findings.length, 0);
    });

    test('报告文件名与行号便于自查', () => {
        const dir = writePlugin({ 'index.js': '// line1\n// line2\neval("x");' });
        const r = scanPluginRisk(dir, { fs, path });
        const f = r.findings.find(x => x.label.includes('动态执行'));
        assert.strictEqual(f.file, 'index.js');
        assert.strictEqual(f.line, 3);
    });

    test('跳过 node_modules，只扫插件自身代码', () => {
        const dir = makeTmp();
        fs.mkdirSync(path.join(dir, 'node_modules'));
        fs.writeFileSync(path.join(dir, 'node_modules', 'evil.js'), "require('child_process')");
        fs.writeFileSync(path.join(dir, 'index.js'), 'export default class P {}');

        const r = scanPluginRisk(dir, { fs, path });
        assert.strictEqual(r.findings.length, 0, 'node_modules 不应参与扫描');
    });

    test('披露文本包含能力、扫描结果与同进程警告', () => {
        const dir = writePlugin({ 'index.js': "import cp from 'child_process';" });
        const risk = scanPluginRisk(dir, { fs, path });
        const text = formatInstallDisclosure(
            { name: 'p', displayName: '测试插件', version: '1.0', author: 'x', permissions: ['sessions'] },
            risk,
        );

        assert.match(text, /测试插件/);
        assert.match(text, /sessions/);
        assert.match(text, /执行系统命令/);
        assert.match(text, /同进程运行/, '必须明确告知用户插件拥有完整 Node 权限');
    });
});

describe('权限注册表自洽', () => {
    test('每项都有 risk / desc / default', () => {
        for (const [name, def] of Object.entries(PERMISSIONS)) {
            assert.ok(['low', 'medium', 'high'].includes(def.risk), `${name} 的 risk 非法`);
            assert.ok(def.desc, `${name} 缺少描述`);
            assert.strictEqual(typeof def.default, 'boolean', `${name} 缺少 default`);
        }
    });

    test('所有高危权限都不默认授予', () => {
        for (const [name, def] of Object.entries(PERMISSIONS)) {
            if (def.risk === 'high') {
                assert.strictEqual(def.default, false, `高危权限 ${name} 不得默认授予`);
            }
        }
    });
});

/**
 * ESM require() 崩溃回归（真机事故 2026-07-29）
 *
 * 现象：每条 IM 消息都使网关进程退出（ReferenceError: require is not defined），
 * 根因是 plugin-permissions.js 在 ESM 模块内部用 CJS 的 require('path'/'fs')。
 * 修复：改用顶部 import 的 fs/path。此 describe 守护该回归不再复发。
 */
describe('ESM require() 崩溃回归', () => {
    test('授予 fs 权限时 createFsService 不再 require 崩溃（getFsFor 路径）', () => {
        // 事故链：event-pipeline -> getFsFor -> createFsService -> require('path')
        const { granted } = normalizePermissions(['fs'], 'p');
        const svc = buildScopedServices('p', granted, { configManager: fakeConfig() }, [], { fs: true });
        assert.ok(typeof svc.fs.read === 'function', 'fs 服务应可用而非抛 require 错误');
        assert.ok(typeof svc.fs.write === 'function');
        assert.ok(typeof svc.fs.list === 'function');
    });

    test('授予 assets 权限时 createAssetsService 不再 require 崩溃', () => {
        const { granted } = normalizePermissions(['assets'], 'p');
        const svc = buildScopedServices('p', granted, { configManager: fakeConfig() }, [], { assets: true });
        assert.ok(typeof svc.assets.listCharacters === 'function', 'assets 服务应可用而非抛 require 错误');
    });

    test('scanPluginRisk 用注入 deps 时不再触发 require fallback', () => {
        // scanPluginRisk 的 fallback 原为 `deps?.fs || require('fs')`，ESM 下 require 崩溃。
        // 不传 deps 时应回退到模块顶层 import 的 fs/path（同样不得崩溃）。
        const dir = tmpDir().dir;
        fs.writeFileSync(path.join(dir, 'evil.js'), "require('child_process').exec('rm -rf /')");
        const r1 = scanPluginRisk(dir, { fs, path });
        assert.ok(r1.findings.length > 0, '注入 deps 时应正常扫描');

        // 不传 deps：走 import 的 fs/path，不得抛 require 错误
        const r2 = scanPluginRisk(dir);
        assert.ok(r2.findings.length > 0, '无 deps 时回退到顶层 import 也能正常扫描');
    });

    test('plugin-permissions.js 源码不含 CJS require() 调用', () => {
        // 静态守护：模块内不得再出现 require('...')，ESM 下必崩
        const src = fs.readFileSync(path.resolve('server/plugin-permissions.js'), 'utf-8');
        // 排除注释里的说明文字（如本测试的注释），只看实际 require( 调用
        const codeLines = src.split('\n').filter(l => !l.trim().startsWith('//'));
        assert.ok(!codeLines.some(l => /\brequire\s*\(/.test(l)),
            'plugin-permissions.js 不得含 require() 调用（ESM 模块）');
    });
});
