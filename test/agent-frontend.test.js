/**
 * Agent 前端 URL 校验测试（模块 B）
 *
 * 覆盖：
 *   - validateAgentFrontendUrl 格式校验（纯函数）
 *       · 无协议头 / 空串 / 非法协议（javascript:/file:/data:/ftp）/ 非法端口 / 端口越界 /
 *         主机名含空格 / 缺协议 → 无效
 *       · 合法 URL（http/https + 可选端口）→ 有效
 *   - checkAgentFrontendReachable 可访问性检测（mock fetch）
 *       · 2xx/3xx → ok:true + status；4xx → ok:true（页面存在即可访问）+ status
 *       · 5xx → ok:false + error 提示；fetch 抛错 → ok:false（ECONNREFUSED/超时给可读提示）
 *       · 非 localhost 地址带 warning 字段
 *   - createAgentFrontendValidateHandler 路由处理函数（mock req/res，直接调用）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    validateAgentFrontendUrl,
    checkAgentFrontendReachable,
    createAgentFrontendValidateHandler,
} from '../server/agent-frontend.js';

// ==================== 格式校验 ====================

describe('validateAgentFrontendUrl - 格式校验', () => {
    test('空串 / 纯空白 / undefined / null → 无效', () => {
        assert.strictEqual(validateAgentFrontendUrl('').valid, false);
        assert.strictEqual(validateAgentFrontendUrl('   ').valid, false);
        assert.strictEqual(validateAgentFrontendUrl(undefined).valid, false);
        assert.strictEqual(validateAgentFrontendUrl(null).valid, false);
    });

    test('无协议头 → 无效，错误提示含 http://', () => {
        const r = validateAgentFrontendUrl('127.0.0.1:3210/agent');
        assert.strictEqual(r.valid, false);
        assert.match(r.error, /http:\/\//);
    });

    test('非法协议：javascript: → 无效', () => {
        assert.strictEqual(validateAgentFrontendUrl('javascript:alert(1)').valid, false);
    });

    test('非法协议：file: → 无效', () => {
        assert.strictEqual(validateAgentFrontendUrl('file:///etc/passwd').valid, false);
    });

    test('非法协议：data: → 无效', () => {
        assert.strictEqual(validateAgentFrontendUrl('data:text/html,<h1>x</h1>').valid, false);
    });

    test('非法协议（ftp）→ 无效', () => {
        assert.strictEqual(validateAgentFrontendUrl('ftp://example.com').valid, false);
    });

    test('仅协议无主机 → 无效', () => {
        assert.strictEqual(validateAgentFrontendUrl('http://').valid, false);
        assert.strictEqual(validateAgentFrontendUrl('https://').valid, false);
    });

    test('主机名含空格（host 非法）→ 无效', () => {
        const r = validateAgentFrontendUrl('http://exa mple.com/agent');
        assert.strictEqual(r.valid, false);
    });

    test('端口越界 99999 → 无效', () => {
        const r = validateAgentFrontendUrl('http://example.com:99999');
        assert.strictEqual(r.valid, false);
    });

    test('端口 0 → 无效（端口需 ≥1）', () => {
        const r = validateAgentFrontendUrl('http://example.com:0');
        assert.strictEqual(r.valid, false);
    });

    test('合法：http + 端口 → 有效，解析出 hostname/port', () => {
        const r = validateAgentFrontendUrl('http://127.0.0.1:3210/agent');
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.hostname, '127.0.0.1');
        assert.strictEqual(r.port, '3210');
    });

    test('合法：https 无端口 → 有效，port 为 null', () => {
        const r = validateAgentFrontendUrl('https://example.com/agent');
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.hostname, 'example.com');
        assert.strictEqual(r.port, null);
    });

    test('合法：端口边界 1 与 65535', () => {
        assert.strictEqual(validateAgentFrontendUrl('http://localhost:1').valid, true);
        assert.strictEqual(validateAgentFrontendUrl('http://localhost:65535').valid, true);
    });

    test('首尾空白自动 trim 后仍有效', () => {
        const r = validateAgentFrontendUrl('  http://127.0.0.1:3210/agent  ');
        assert.strictEqual(r.valid, true);
        assert.strictEqual(r.url, 'http://127.0.0.1:3210/agent');
    });
});

// ==================== 可访问性检测（mock fetch） ====================

describe('checkAgentFrontendReachable - 可访问性检测', () => {
    function okFetch(status) {
        return async () => new Response(null, { status });
    }

    test('mock fetch 200 → ok:true, status:200', async () => {
        const r = await checkAgentFrontendReachable('http://127.0.0.1:3210/agent', { fetchImpl: okFetch(200) });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.error, undefined, '可达时不应有 error');
        assert.strictEqual(r.warning, undefined, '本机地址不应带 warning');
    });

    test('mock fetch 204 → ok:true', async () => {
        const r = await checkAgentFrontendReachable('http://localhost/agent', { fetchImpl: okFetch(204) });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.status, 204);
    });

    test('mock fetch 302（3xx 重定向）→ ok:true, status:302', async () => {
        const r = await checkAgentFrontendReachable('http://127.0.0.1:3210/agent', { fetchImpl: okFetch(302) });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.status, 302);
    });

    test('mock fetch 404（4xx）→ ok:true（页面存在即可访问），status 标记 404', async () => {
        const r = await checkAgentFrontendReachable('http://127.0.0.1:3210/agent', { fetchImpl: okFetch(404) });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.status, 404);
        assert.strictEqual(r.error, undefined);
    });

    test('mock fetch 500（5xx）→ ok:false，error 含"无法访问"与状态码', async () => {
        const r = await checkAgentFrontendReachable('http://127.0.0.1:3210/agent', { fetchImpl: okFetch(500) });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.status, 500);
        assert.match(r.error, /无法访问/);
        assert.match(r.error, /500/);
    });

    test('fetch 抛网络错误 → ok:false，error 含"无法访问"', async () => {
        const r = await checkAgentFrontendReachable('http://127.0.0.1:1/agent', {
            fetchImpl: async () => { throw new TypeError('fetch failed'); },
        });
        assert.strictEqual(r.ok, false);
        assert.match(r.error, /无法访问/);
    });

    test('ECONNREFUSED（拒绝连接）→ ok:false，error 含"拒绝连接"', async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:1');
        err.code = 'ECONNREFUSED';
        const r = await checkAgentFrontendReachable('http://127.0.0.1:1/agent', {
            fetchImpl: async () => { throw err; },
        });
        assert.strictEqual(r.ok, false);
        assert.match(r.error, /拒绝连接/);
    });

    test('超时（signal abort）→ ok:false，error 含"连接超时"', async () => {
        // mock fetch 只监听 signal 的 abort 并拒绝，永不 resolve
        const neverResolveFetch = (url, opts) => new Promise((_, reject) => {
            if (opts && opts.signal) {
                opts.signal.addEventListener('abort', () => {
                    const err = new Error('The operation was aborted.');
                    err.name = 'AbortError';
                    reject(err);
                });
            }
        });
        const r = await checkAgentFrontendReachable('http://127.0.0.1:3210/agent', {
            fetchImpl: neverResolveFetch,
            timeoutMs: 20,
        });
        assert.strictEqual(r.ok, false);
        assert.match(r.error, /连接超时/);
    });

    test('非 localhost 地址 → 带 warning 字段', async () => {
        const r = await checkAgentFrontendReachable('http://192.168.1.50:8080/agent', { fetchImpl: okFetch(200) });
        assert.strictEqual(r.ok, true);
        assert.match(r.warning, /localhost/);
    });

    test('格式不合法时直接返回无效，不触发 fetch', async () => {
        let called = false;
        const r = await checkAgentFrontendReachable('not-a-url', {
            fetchImpl: async () => { called = true; return new Response(null, { status: 200 }); },
        });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(called, false);
    });
});

// ==================== 路由处理函数（直接调用 + mock req/res） ====================

describe('createAgentFrontendValidateHandler - 路由处理', () => {
    function mockRes() {
        const res = { body: null, statusCodeSet: null };
        res.json = (obj) => { res.body = obj; return res; };
        res.status = (code) => { res.statusCodeSet = code; return res; };
        return res;
    }

    test('合法且可达 → res.json({ ok:true, status })', async () => {
        const handler = createAgentFrontendValidateHandler({
            fetchImpl: async () => new Response(null, { status: 200 }),
        });
        const res = mockRes();
        await handler({ body: { url: 'http://127.0.0.1:3210/agent' } }, res);
        assert.strictEqual(res.body.ok, true);
        assert.strictEqual(res.body.status, 200);
        assert.strictEqual(res.statusCodeSet, null, '成功路径不应调用 res.status');
    });

    test('body 缺少 url → res.json({ ok:false, error })', async () => {
        const handler = createAgentFrontendValidateHandler({});
        const res = mockRes();
        await handler({ body: {} }, res);
        assert.strictEqual(res.body.ok, false);
        assert.match(res.body.error, /不能为空/);
    });

    test('格式非法（无协议头）→ res.json({ ok:false, error })', async () => {
        const handler = createAgentFrontendValidateHandler({});
        const res = mockRes();
        await handler({ body: { url: '127.0.0.1:3210' } }, res);
        assert.strictEqual(res.body.ok, false);
        assert.match(res.body.error, /http:\/\//);
    });

    test('可达性失败（网络错误）→ res.json({ ok:false, error })', async () => {
        const handler = createAgentFrontendValidateHandler({
            fetchImpl: async () => { throw new TypeError('fetch failed'); },
        });
        const res = mockRes();
        await handler({ body: { url: 'http://127.0.0.1:9/agent' } }, res);
        assert.strictEqual(res.body.ok, false);
        assert.match(res.body.error, /无法访问/);
    });
});
