/**
 * message-to-image 长图分页逻辑单元测试
 *
 * 测试对象：plugins/message-to-image/pagination.js（纯函数、零依赖，可在无
 * puppeteer/无 Chrome 的 CI 环境直接运行）。
 *
 * 守护的核心不变量：
 *   1. 分页方案计算正确（边界：恰好一页 / 多一像素即分页 / 极端输入防护）
 *   2. 多页时每页图片尺寸恒定（pageHeight 固定），单页保持内容自然高度
 *   3. 分页缓存键：单页与多页、不同页数互不串用
 *   4. 分页页面结构：平移偏移正确、裁剪区高度正确、页脚独立不遮挡正文、可关闭页脚
 *   5. 原始文档的样式与模板内容被完整保留（格式化完整性）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { computePagePlan, buildPageHtml, pageCacheKey, PAGE_FOOTER_HEIGHT } from '../plugins/message-to-image/pagination.js';

/** 构造一份与 renderer._buildHtml 结构一致的完整文档 */
function makeFullHtml(bodyContent = '<div class="render-root"><p>你好</p></div>') {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: serif; }
.render-root { width: 800px; padding: 24px; background: #fff; color: #333; }
</style>
</head>
<body>
${bodyContent}
</body>
</html>`;
}

describe('computePagePlan 分页方案计算', () => {
    test('短内容：单页，保持内容自然高度，不产生分页', () => {
        const plan = computePagePlan(500, 1600);
        assert.strictEqual(plan.paginated, false);
        assert.strictEqual(plan.pageCount, 1);
        assert.strictEqual(plan.pageHeight, 500, '单页高度 = 内容自然高度');
        assert.strictEqual(plan.viewportHeight, 1600 - PAGE_FOOTER_HEIGHT);
    });

    test('边界：总高度恰好等于可视区（maxPageHeight - 页脚）时仍为单页', () => {
        const viewport = 1600 - PAGE_FOOTER_HEIGHT; // 1560
        const plan = computePagePlan(viewport, 1600);
        assert.strictEqual(plan.pageCount, 1);
        assert.strictEqual(plan.paginated, false);
    });

    test('边界：总高度比可视区多 1px 即分页为 2 页', () => {
        const viewport = 1600 - PAGE_FOOTER_HEIGHT;
        const plan = computePagePlan(viewport + 1, 1600);
        assert.strictEqual(plan.pageCount, 2);
        assert.strictEqual(plan.paginated, true);
        assert.strictEqual(plan.pageHeight, 1600, '多页时每页高度固定为 maxPageHeight，尺寸一致');
        assert.strictEqual(plan.viewportHeight, viewport);
    });

    test('长内容：pageCount = ceil(总高 / 可视区)，页高恒定', () => {
        const viewport = 1600 - PAGE_FOOTER_HEIGHT;
        // 3 整页 + 半页
        const plan = computePagePlan(viewport * 3 + viewport / 2, 1600);
        assert.strictEqual(plan.pageCount, 4);
        assert.strictEqual(plan.pageHeight, 1600);
        assert.strictEqual(plan.paginated, true);
    });

    test('恰好 2 整页：pageCount = 2 而非 3', () => {
        const viewport = 1600 - PAGE_FOOTER_HEIGHT;
        const plan = computePagePlan(viewport * 2, 1600);
        assert.strictEqual(plan.pageCount, 2);
    });

    test('极端输入防护：总高度 0 / 负数 / NaN 时至少 1 页且不崩溃', () => {
        assert.strictEqual(computePagePlan(0, 1600).pageCount, 1);
        assert.strictEqual(computePagePlan(-100, 1600).pageCount, 1);
        assert.strictEqual(computePagePlan(NaN, 1600).pageCount, 1);
        assert.strictEqual(computePagePlan(undefined, 1600).pageCount, 1);
    });

    test('极端输入防护：maxPageHeight 配置过小（≤页脚高）时仍保证可视区 ≥1px 且不崩溃', () => {
        const plan = computePagePlan(1000, PAGE_FOOTER_HEIGHT);
        assert.ok(plan.viewportHeight >= 1, '可视区至少 1px');
        assert.ok(Number.isInteger(plan.pageCount) && plan.pageCount >= 1, '页数为正整数');
    });

    test('小数高度向上取整，避免最后一页被裁掉半个像素行', () => {
        // 1559.4 向上取整为 1560 = 可视区，仍单页，页高取整后的自然高度
        const plan = computePagePlan(1559.4, 1600);
        assert.strictEqual(plan.pageCount, 1);
        assert.strictEqual(plan.pageHeight, 1560);
        // 1560.1 向上取整为 1561 > 可视区(1560)，触发分页
        const plan2 = computePagePlan(1560.1, 1600);
        assert.strictEqual(plan2.pageCount, 2);
    });
});

describe('pageCacheKey 分页缓存键', () => {
    test('单页与多页使用不同缓存键，杜绝串用', () => {
        const single = pageCacheKey('abc', { paginated: false });
        const multi = pageCacheKey('abc', { paginated: true, pageCount: 3, pageHeight: 1600 });
        assert.notStrictEqual(single, multi);
    });

    test('不同页数/页高产生不同键', () => {
        const p2 = pageCacheKey('abc', { paginated: true, pageCount: 2, pageHeight: 1600 });
        const p3 = pageCacheKey('abc', { paginated: true, pageCount: 3, pageHeight: 1600 });
        const h800 = pageCacheKey('abc', { paginated: true, pageCount: 2, pageHeight: 800 });
        assert.notStrictEqual(p2, p3);
        assert.notStrictEqual(p2, h800);
    });

    test('相同方案产生确定性键', () => {
        const a = pageCacheKey('abc', { paginated: true, pageCount: 2, pageHeight: 1600 });
        const b = pageCacheKey('abc', { paginated: true, pageCount: 2, pageHeight: 1600 });
        assert.strictEqual(a, b);
    });

    test('不同内容（baseKey 不同）不共用键', () => {
        assert.notStrictEqual(pageCacheKey('aaa', { paginated: false }), pageCacheKey('bbb', { paginated: false }));
    });
});

describe('buildPageHtml 分页页面构建', () => {
    const fullHtml = makeFullHtml();
    const viewport = 1560;
    const pageHeight = 1600;

    test('第 1 页：平移 0，页码 1/N，裁剪区高度正确', () => {
        const html = buildPageHtml(fullHtml, 0, 3, pageHeight, viewport);
        assert.ok(html.includes('class="render-page"'), '包含页面容器');
        assert.ok(html.includes('class="render-clip"'), '包含裁剪视窗');
        assert.ok(html.includes('class="render-root"'), '保留模板 .render-root');
        assert.ok(html.includes('transform: translateY(-0px)'), '第 1 页不平移');
        assert.ok(html.includes(`height: ${viewport}px`), '裁剪区高度 = 可视区高度');
        assert.ok(html.includes(`height: ${pageHeight}px`), '页面容器高度 = 页高');
        assert.ok(html.includes('第 1/3 页'), '页脚页码正确');
        assert.ok(html.includes('render-page-footer'), '页脚存在');
    });

    test('第 2 页：平移 -viewport，页码 2/N', () => {
        const html = buildPageHtml(fullHtml, 1, 3, pageHeight, viewport);
        assert.ok(html.includes(`translateY(-${viewport}px)`), '第 2 页向上平移一个可视区');
        assert.ok(html.includes('第 2/3 页'));
    });

    test('页脚关闭时不输出页码元素与样式', () => {
        const html = buildPageHtml(fullHtml, 0, 2, pageHeight, viewport, PAGE_FOOTER_HEIGHT, false);
        assert.ok(!html.includes('render-page-footer'), '无页脚元素');
        assert.ok(!html.includes('第 1/2 页'), '无页码文本');
        assert.ok(html.includes('class="render-root"'), '正文结构不受影响');
    });

    test('原始样式与模板内容完整保留（格式化完整性）', () => {
        const customBody = '<div class="render-root novel-card"><div class="card-header">师尊</div><div class="card-body">长文内容</div></div>';
        const html = buildPageHtml(makeFullHtml(customBody), 0, 2, pageHeight, viewport);
        assert.ok(html.includes('.render-root { width: 800px;'), '原始 CSS 保留');
        assert.ok(html.includes('class="render-root novel-card"'), '自定义模板保留');
        assert.ok(html.includes('card-header'), '模板内部结构保留');
        assert.ok(html.includes('card-body'), '模板内部结构保留');
    });

    test('多行文本的 <pre> 空白与换行被保留（不拆分文本）', () => {
        const text = '第一行\n第二行\n  缩进的内容\n\n空行分隔';
        const body = `<div class="render-root" style="white-space: pre-wrap;">${text}</div>`;
        const html = buildPageHtml(makeFullHtml(body), 0, 1, pageHeight, viewport);
        assert.ok(html.includes('第一行\n第二行'), '换行保留');
        assert.ok(html.includes('  缩进的内容'), '缩进保留');
    });

    test('自定义页脚高度生效', () => {
        const html = buildPageHtml(fullHtml, 0, 2, 800, 700, 50);
        assert.ok(html.includes('height: 50px'), '页脚高度 50px');
        assert.ok(html.includes('height: 700px'), '裁剪区 = 800 - 50');
    });

    test('页脚与裁剪区分离：页脚在 .render-clip 之外，不遮挡正文', () => {
        const html = buildPageHtml(fullHtml, 0, 2, pageHeight, viewport);
        // buildPageHtml 的模板结构：`</div>${footerHtml}` —— 裁剪区闭合紧跟页脚，
        // 页脚是 .render-clip 的兄弟节点（在页面容器内、裁剪区外），不会覆盖正文。
        assert.ok(
            html.includes('</div>\n<div class="render-page-footer">'),
            '页脚紧随裁剪区闭合标签之后（独立区域）'
        );
    });
});

describe('集成：测量 → 分页方案 → 逐页构建 全链路', () => {
    test('一页放得下的内容：1 页、无页码页脚、自然高度', () => {
        const total = 800;
        const plan = computePagePlan(total, 1600);
        assert.strictEqual(plan.paginated, false);
        const html = buildPageHtml(makeFullHtml(), 0, plan.pageCount, plan.pageHeight, plan.viewportHeight, PAGE_FOOTER_HEIGHT, true);
        assert.ok(!html.includes('render-page-footer'), '单页不显示页码');
    });

    test('超长内容：多页且每页均有页码，最后一页也固定页高（尺寸一致）', () => {
        const viewport = 1600 - PAGE_FOOTER_HEIGHT;
        const plan = computePagePlan(viewport * 2 + 100, 1600);
        assert.strictEqual(plan.pageCount, 3);
        assert.ok(plan.paginated);
        for (let i = 0; i < plan.pageCount; i++) {
            const html = buildPageHtml(makeFullHtml(), i, plan.pageCount, plan.pageHeight, plan.viewportHeight);
            assert.ok(html.includes(`第 ${i + 1}/${plan.pageCount} 页`), `第 ${i + 1} 页页码正确`);
            assert.ok(html.includes(`height: ${plan.pageHeight}px`), `第 ${i + 1} 页高度恒定`);
        }
    });
});
