/**
 * R2 完整前端渲染引擎测试（agent-renderer.js + 服务端正则引擎集成）。
 *
 * 覆盖（对应需求第 5 条验证要求）：
 *   1. 匹配准确性：正则捕获标签替换 → sanitize → 渲染；预设/通用标签；双通道
 *   2. 边界条件：空文本 / 未闭合标签 / 嵌套 / 重复 / 超大输入 / 未知标签
 *   3. 特殊字符：XSS（script / on* / javascript: / data: / style 注入）、中文 / emoji / HTML 实体
 *   4. 性能：大量标签与复杂场景渲染耗时上限
 *   5. 集成：服务端正则（AI_OUTPUT 阶段标签→HTML）→ 前端渲染引擎双通道
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    sanitizeHtml, hasHtmlMarker, renderMessage, renderText, plainText,
    registerTag, registerMacro, registerLine,
    hasStatusPlaceholder, resolveStatusPlaceholder, renderMvuStatusBar,
    escapeHtml, flattenVars,
} from '../public/agent-renderer.js';
import { getRegexedString, parseRegex, validateRegex } from '../server/agent/regex-engine.js';

// ==================== 1. sanitize 白名单 ====================

describe('渲染引擎 sanitize：危险内容清理', () => {
    test('剥离成对与自闭合危险标签（script/style/iframe/object/embed）', () => {
        assert.ok(!sanitizeHtml('<script>alert(1)</script>').includes('script'));
        assert.ok(!sanitizeHtml('<style>.x{}</style>').includes('style'));
        assert.ok(!sanitizeHtml('<iframe src="x"></iframe>').includes('iframe'));
        assert.ok(!sanitizeHtml('<script src="evil.js"/>').includes('script'));
        assert.ok(!sanitizeHtml('<object data="x"></object>').includes('object'));
        assert.ok(!sanitizeHtml('<embed src="x">').includes('embed'));
        // 危险标签内部内容一并删除
        assert.ok(!sanitizeHtml('<script>恶意内容</script>').includes('恶意内容'));
    });

    test('剥离 on* 事件属性', () => {
        const out = sanitizeHtml('<div onclick="alert(1)" onmouseover="x()">ok</div>');
        assert.ok(!out.includes('onclick'));
        assert.ok(!out.includes('onmouseover'));
        assert.ok(out.includes('ok'));
    });

    test('拒绝 javascript:/data:/vbscript: 危险协议', () => {
        const out = sanitizeHtml('<a href="javascript:alert(1)">点我</a><img src="data:text/html;base64,xxx">');
        assert.ok(!/javascript/i.test(out));
        assert.ok(!/data:text/i.test(out));
        // 安全链接保留
        const safe = sanitizeHtml('<a href="https://example.com">ok</a>');
        assert.ok(safe.includes('https://example.com'));
    });

    test('style 白名单：允许常见属性，拒绝 url()/expression 注入', () => {
        assert.ok(sanitizeHtml('<div style="color:red;font-weight:bold">x</div>').includes('color:red'));
        assert.ok(!sanitizeHtml('<div style="background:url(javascript:evil)">x</div>').includes('url('));
        assert.ok(!sanitizeHtml('<div style="width:expression(alert(1))">x</div>').includes('expression'));
        assert.ok(!sanitizeHtml('<div style="behavior:url(x)">x</div>').includes('behavior'));
    });

    test('未知标签转义为文本，白名单标签与安全属性保留', () => {
        const out = sanitizeHtml('<custom-tag>内容</custom-tag><div class="card" data-id="7">ok</div>');
        assert.ok(out.includes('&lt;custom-tag&gt;'), '未知标签转义');
        assert.ok(out.includes('<div class="card" data-id="7">'), '白名单标签+class/data-* 保留');
        // 非白名单属性被剔除
        const out2 = sanitizeHtml('<div foo="bar" title="提示">x</div>');
        assert.ok(!out2.includes('foo='));
        assert.ok(out2.includes('title="提示"'));
    });

    test('异常输入安全返回空串', () => {
        assert.strictEqual(sanitizeHtml(null), '');
        assert.strictEqual(sanitizeHtml(''), '');
        assert.strictEqual(sanitizeHtml(undefined), '');
    });
});

// ==================== 2. 双通道渲染 ====================

describe('渲染引擎：双通道渲染（无缝切换）', () => {
    test('hasHtmlMarker 识别正则 HTML 输出，不误判普通文本', () => {
        assert.ok(hasHtmlMarker('<div>内容</div>'));
        assert.ok(hasHtmlMarker('前缀 <span class="x">后'));
        assert.ok(!hasHtmlMarker('纯文本 1 < 2 且 3 > 2'));
        assert.ok(!hasHtmlMarker(''));
        assert.ok(!hasHtmlMarker('x < y'));
        assert.ok(hasHtmlMarker('<table><tr><td>1</td></tr></table>'));
    });

    test('通道 A：正则 HTML 直通（sanitize 后返回 mode=html）', () => {
        const r = renderMessage('<div class="status-card"><b>HP</b> 100</div>');
        assert.strictEqual(r.mode, 'html');
        assert.ok(r.html.includes('<div class="status-card">'));
        assert.ok(r.html.includes('<b>'));
    });

    test('通道 A 遇 XSS 自动清理', () => {
        const r = renderMessage('<div onclick="evil()">安全</div><script>bad()</script>');
        assert.strictEqual(r.mode, 'html');
        assert.ok(!r.html.includes('onclick'));
        assert.ok(!r.html.includes('script'));
        assert.ok(r.html.includes('安全'));
    });

    test('通道 B：预设标签渲染为真实 HTML（mode=tags）', () => {
        const r = renderMessage('<maintext>正文第一段\n第二段</maintext>');
        assert.strictEqual(r.mode, 'tags');
        assert.ok(r.html.includes('<div class="th-maintext">'));
        assert.ok(r.html.includes('正文第一段'));
        assert.ok(r.html.includes('<br>'), '换行转 <br>');
        assert.ok(!r.html.includes('&lt;div'), '渲染器输出不二次转义');
    });

    test('通道 B：混合内容——普通文本转义 + 标签渲染，不丢原文', () => {
        const r = renderText('开头 <maintext>正文</maintext> 结尾 <未注册>x</未注册>');
        assert.ok(r.html.includes('开头'));
        assert.ok(r.html.includes('<div class="th-maintext">正文</div>'));
        assert.ok(r.html.includes('&lt;未注册&gt;'), '未注册标签转义保留');
        assert.ok(r.html.includes('结尾'));
    });

    test('空输入返回 empty / plain', () => {
        assert.strictEqual(renderMessage('').mode, 'empty');
        assert.strictEqual(renderMessage(null).mode, 'empty');
        assert.strictEqual(renderText('').mode, 'plain');
    });

    test('plainText 仅转义换行（思维链等安全展示）', () => {
        assert.strictEqual(plainText('<b>粗体</b>\n下一行'), '&lt;b&gt;粗体&lt;/b&gt;<br>下一行');
    });
});

// ==================== 3. TagRegistry 通用标签 ====================

describe('渲染引擎：TagRegistry 通用标签注册表（作者自定义标签）', () => {
    test('registerTag：自定义块标签渲染', () => {
        registerTag('skill', (inner) => '<div class="skill">🎴 ' + escapeHtml(inner) + '</div>');
        const r = renderText('学了 <skill>火球术</skill>！');
        assert.ok(r.html.includes('<div class="skill">🎴 火球术</div>'));
        assert.ok(r.html.includes('学了'));
        assert.ok(r.html.includes('！'));
    });

    test('registerMacro：{{name::参数}} 宏渲染', () => {
        registerMacro('getvar', (param) => '<span class="var">' + escapeHtml(param) + '</span>');
        const r = renderText('好感度 {{getvar::好感度}}');
        assert.ok(r.html.includes('<span class="var">好感度</span>'));
    });

    test('registerLine：行级渲染（【状态】行）', () => {
        registerLine(/^【状态】\s*(.+)$/, (m) => '@@consume<div class="line-status">📊 ' + escapeHtml(m[1]) + '</div>');
        const r = renderText('【状态】好感度 80');
        assert.ok(r.html.includes('<div class="line-status">📊 好感度 80</div>'));
        assert.ok(!r.html.includes('【状态】'), '被消费的行从原文移除');
    });

    test('handler 抛错不中断其他内容渲染（优雅降级）', () => {
        registerTag('boom', () => { throw new Error('渲染失败'); });
        const r = renderText('<boom>bad</boom> 之后的内容正常 <maintext>正文</maintext>');
        assert.ok(r.html.includes('之后的内容正常'));
        assert.ok(r.html.includes('<div class="th-maintext">正文</div>'));
    });
});

// ==================== 4. StatusPlaceHolderImpl ====================

describe('渲染引擎：StatusPlaceHolderImpl（MVU 通用占位）', () => {
    test('检测与剥离占位符', () => {
        assert.ok(hasStatusPlaceholder('a<StatusPlaceHolderImpl/>b'));
        assert.ok(hasStatusPlaceholder('<StatusPlaceHolderImpl>'));
        assert.ok(!hasStatusPlaceholder('无占位'));
        const r = resolveStatusPlaceholder('正文<StatusPlaceHolderImpl/>');
        assert.strictEqual(r.present, true);
        assert.strictEqual(r.residual, '正文');
    });

    test('renderMvuStatusBar：有数据渲染键值网格 + 来源标记；无数据占位提示', () => {
        const html = renderMvuStatusBar({ stat_data: { 角色: { 络络: { 好感度: 20 } } }, initSource: '络络', lastUpdate: { via: 'processor', count: 1 } });
        assert.ok(html.includes('gateway-mvu-grid'));
        assert.ok(html.includes('好感度'));
        assert.ok(html.includes('20'));
        assert.ok(html.includes('变量子代理'), 'via=processor 标记');
        const empty = renderMvuStatusBar({ stat_data: {} });
        assert.ok(empty.includes('无 MVU 变量数据'));
    });

    test('flattenVars 扁平化嵌套与数组', () => {
        const rows = flattenVars({ a: { b: 1 }, 列表: ['x', 'y'], s: '中' });
        assert.deepStrictEqual(rows, [
            { key: 'a.b', value: '1' },
            { key: '列表[0]', value: 'x' },
            { key: '列表[1]', value: 'y' },
            { key: 's', value: '中' },
        ]);
    });
});

// ==================== 5. 边界条件 ====================

describe('渲染引擎：边界条件', () => {
    test('未闭合标签不崩溃', () => {
        const r = renderMessage('<div class="x">未闭合内容');
        assert.ok(r.html.includes('未闭合内容'));
        assert.ok(!r.html.includes('&lt;div'), '白名单标签未闭合仍保留');
    });

    test('嵌套标签一层处理，不递归爆栈', () => {
        registerTag('outer', (inner) => '<div class="outer">' + escapeHtml(inner) + '</div>');
        const r = renderText('<outer><outer>深层</outer></outer>');
        assert.ok(r.html.includes('outer'));
        assert.ok(r.html.includes('深层'));
    });

    test('重复标签大量出现', () => {
        let text = '';
        for (let i = 0; i < 100; i++) text += '<maintext>段' + i + '</maintext>\n';
        const r = renderText(text);
        assert.ok(r.html.includes('段0'));
        assert.ok(r.html.includes('段99'));
    });

    test('超大输入（100KB）不崩溃且不超时', () => {
        const big = '普通文本段落，包含中文与 English。\n'.repeat(4000); // ~160KB
        const t0 = Date.now();
        const r = renderMessage(big);
        const cost = Date.now() - t0;
        assert.ok(r.html.length > 0);
        assert.ok(cost < 2000, '100KB 渲染耗时 ' + cost + 'ms 应 < 2000ms');
    });

    test('escapeHtml 全字符转义', () => {
        assert.strictEqual(escapeHtml('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    });
});

// ==================== 6. 特殊字符 ====================

describe('渲染引擎：特殊字符处理', () => {
    test('中文 / emoji / 全角符号原样保留', () => {
        const r = renderText('你好，世界！🚀 好感度：80% 「引号」');
        assert.ok(r.html.includes('你好，世界！🚀'));
        assert.ok(r.html.includes('好感度：80%'));
    });

    test('HTML 实体不双重转义', () => {
        const r = renderText('价格 &lt; 100 且 &amp; 正常');
        // 输入中的 &lt; 是文本实体，escapeHtml 会转 & 为 &amp;lt;（正确行为：纯文本）
        assert.ok(r.html.includes('&amp;lt;'));
    });

    test('标签内特殊字符安全渲染', () => {
        const r = renderText('<maintext>a<b 是文字</maintext>');
        assert.ok(r.html.includes('a&lt;b'));
    });

    test('恶意混合输入（XSS 组合攻击）', () => {
        const evil = '<div><img src="x" onerror="alert(1)"><a href="javascript:void(0)">x</a></div><script>window.x=1</script>';
        const r = renderMessage(evil);
        assert.ok(!r.html.includes('onerror'));
        assert.ok(!r.html.includes('javascript:'));
        assert.ok(!r.html.includes('<script>'));
    });
});

// ==================== 7. 性能 ====================

describe('渲染引擎：性能（大量标签与复杂场景）', () => {
    test('2000 个 HTML 标签 sanitize 耗时上限', () => {
        const t = '<div class="x" data-i="' + 0 + '">' + '内容'.repeat(10) + '</div>'.repeat(2000);
        const t0 = Date.now();
        sanitizeHtml(t);
        const cost = Date.now() - t0;
        assert.ok(cost < 2000, '2000 标签 sanitize ' + cost + 'ms 应 < 2000ms');
    });

    test('1000 个预设标签渲染耗时上限', () => {
        let text = '';
        for (let i = 0; i < 1000; i++) text += '<maintext>第' + i + '段剧情内容</maintext>\n';
        const t0 = Date.now();
        renderText(text);
        const cost = Date.now() - t0;
        assert.ok(cost < 2000, '1000 标签渲染 ' + cost + 'ms 应 < 2000ms');
    });

    test('复杂场景：混合 HTML + 标签 + 长文本', () => {
        let html = '<div class="card"><span>状态</span><table><tr><td>1</td></tr></table></div>';
        for (let i = 0; i < 500; i++) html += '<p>段落' + i + '</p>';
        const t0 = Date.now();
        const r = renderMessage(html);
        const cost = Date.now() - t0;
        assert.strictEqual(r.mode, 'html');
        assert.ok(cost < 2000, '复杂场景 ' + cost + 'ms 应 < 2000ms');
    });
});

// ==================== 8. 集成：服务端正则 → 前端渲染（酒馆助手同机制） ====================

describe('集成：服务端正则（AI_OUTPUT）→ 前端渲染引擎', () => {
    test('getRegexedString 把作者自定义标签替换为 HTML（酒馆助手机制）', () => {
        const scripts = [{
            scriptName: '技能卡',
            findRegex: '<skill>([\\s\\S]*?)</skill>',
            replaceString: '<div class="skill-card">🎴 $1</div>',
            placement: [2], // AI_OUTPUT
            markdownOnly: true,
            disabled: false,
        }];
        const out = getRegexedString('你学会了<skill>火球术</skill>！', 2, { isMarkdown: true, scripts });
        assert.ok(out.includes('<div class="skill-card">🎴 火球术</div>'));
        assert.ok(out.includes('你学会了'));
    });

    test('正则输出 → renderMessage 通道 A 渲染（含 XSS 防御）', () => {
        const scripts = [{
            scriptName: '状态替换',
            findRegex: '<status>([\\s\\S]*?)</status>',
            replaceString: '<div class="status" style="color:red">📊 $1</div>',
            placement: [2],
            markdownOnly: true,
        }];
        const regexed = getRegexedString('「<status>HP 100</status>」', 2, { isMarkdown: true, scripts });
        const r = renderMessage(regexed);
        assert.strictEqual(r.mode, 'html');
        assert.ok(r.html.includes('<div class="status" style="color:red">📊 HP 100</div>'));
    });

    test('正则 replaceString 注入脚本被 sanitize 拦截', () => {
        const scripts = [{
            scriptName: '恶意',
            findRegex: '<evil>([\\s\\S]*?)</evil>',
            replaceString: '<div onmouseover="alert(1)">$1<script>bad()</script></div>',
            placement: [2],
            markdownOnly: true,
        }];
        const regexed = getRegexedString('<evil>内容</evil>', 2, { isMarkdown: true, scripts });
        const r = renderMessage(regexed);
        assert.ok(!r.html.includes('onmouseover'));
        assert.ok(!r.html.includes('<script>'));
        assert.ok(r.html.includes('内容'), '正文内容保留');
    });

    test('正则解析与校验（parseRegex / validateRegex）', () => {
        const re = parseRegex('/<maintext>[\\s\\S]*?<\\/maintext>/gi');
        assert.ok(re instanceof RegExp);
        assert.strictEqual(re.flags, 'gi');
        assert.ok(validateRegex('<b>.*?</b>').valid);
        assert.ok(!validateRegex('(').valid, '非法正则返回 invalid');
        assert.ok(!validateRegex('').valid);
    });
});
