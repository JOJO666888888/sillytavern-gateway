/**
 * 长图分页模块（纯函数，零外部依赖，可独立单元测试）
 *
 * 解决的问题：超长文本渲染成一张"无限高"的长图，用户查看体验差。
 * 方案：不拆分/重排文本（那样会破坏段落、行内格式），而是对**完整布局**按固定页高
 * 做 translateY 平移 + 视窗裁剪 —— 每页内容与原始排版完全一致，只是截取不同纵向区间，
 * 且每页图片尺寸恒定（maxWidth × pageHeight），宽高比一致。
 */

/** 页脚（页码条）固定高度，单位 px */
export const PAGE_FOOTER_HEIGHT = 40;

/**
 * 计算分页方案
 * @param {number} totalHeight - 内容渲染总高度（px，由 puppeteer 测量）
 * @param {number} maxPageHeight - 单页最大高度配置（px，含页脚；超过则分页）
 * @param {number} footerHeight - 页脚高度（px），默认 PAGE_FOOTER_HEIGHT
 * @returns {{ pageCount: number, pageHeight: number, viewportHeight: number, paginated: boolean }}
 *   - pageCount: 总页数（至少 1）
 *   - pageHeight: 每张图片的实际高度。单页=内容自然高度；多页=固定 maxPageHeight（保证各页一致）
 *   - viewportHeight: 每页用于展示内容的裁剪区高度（= pageHeight - footerHeight）
 *   - paginated: 是否发生分页（pageCount > 1）
 */
export function computePagePlan(totalHeight, maxPageHeight, footerHeight = PAGE_FOOTER_HEIGHT) {
    const safeTotal = Math.max(0, Math.ceil(Number(totalHeight) || 0));
    // 保证视窗区至少 1px（极端情况下 maxPageHeight 配置过小）
    const safeMax = Math.max(footerHeight + 1, Math.ceil(Number(maxPageHeight) || 0));
    const viewport = safeMax - footerHeight;
    const pageCount = Math.max(1, Math.ceil(safeTotal / viewport));

    if (pageCount === 1) {
        return {
            pageCount: 1,
            pageHeight: safeTotal || viewport, // 单页保持内容自然高度
            viewportHeight: viewport,
            paginated: false,
        };
    }
    return {
        pageCount,
        pageHeight: safeMax,   // 多页时所有页尺寸完全一致
        viewportHeight: viewport,
        paginated: true,
    };
}

/**
 * 分页缓存键：同一内容在不同分页方案下不能复用同一缓存文件。
 * 单页与多页、不同页数/页高都产生不同的键，杜绝错配。
 * @param {string} baseKey - 内容哈希键（renderer 对完整 HTML 做 sha256）
 * @param {{paginated: boolean, pageCount: number, pageHeight: number}} plan - computePagePlan 的返回值
 * @returns {string}
 */
export function pageCacheKey(baseKey, plan) {
    return plan.paginated
        ? `${baseKey}|p${plan.pageCount}|h${plan.pageHeight}`
        : `${baseKey}|p1`;
}

/**
 * 构建某一页的完整 HTML 文档。
 *
 * 从测量用的完整文档（_buildHtml 产物）中取出 <style> 与 <body> 内容，重新组装为：
 *   .render-page（固定 W×H，overflow:hidden）
 *     ├─ .render-clip（H-footerH，overflow:hidden，定位视窗）
 *     │    └─ .render-root（原始模板，translateY(-pageIndex×viewportHeight)）
 *     └─ .render-page-footer（页码条：第 i/N 页）
 *
 * 平移在 `.render-clip .render-root` 上生效，不改动模板本身的 class/style；
 * 页脚独立于裁剪区之外，绝不会遮挡正文。
 *
 * @param {string} fullHtml - 测量用的完整文档（renderer._buildHtml 的产物）
 * @param {number} pageIndex - 当前页下标（从 0 开始）
 * @param {number} pageCount - 总页数
 * @param {number} pageHeight - 每页图片高度
 * @param {number} viewportHeight - 每页内容裁剪区高度
 * @param {number} footerHeight - 页脚高度
 * @param {boolean} footerEnabled - 是否显示页码页脚
 * @returns {string} 分页页面的完整 HTML
 */
export function buildPageHtml(
    fullHtml,
    pageIndex,
    pageCount,
    pageHeight,
    viewportHeight,
    footerHeight = PAGE_FOOTER_HEIGHT,
    footerEnabled = true
) {
    const styleMatch = fullHtml.match(/<style>([\s\S]*?)<\/style>/);
    const bodyMatch = fullHtml.match(/<body>([\s\S]*?)<\/body>/i);
    const docStyle = styleMatch ? styleMatch[1] : '';
    const bodyContent = bodyMatch ? bodyMatch[1] : fullHtml;

    const offset = Math.round(pageIndex * viewportHeight);

    // 只有一页时不显示页码（"第 1/1 页" 是噪音）
    const showFooter = footerEnabled && pageCount > 1;

    const pageStyle = `
        .render-page { width: 100%; height: ${pageHeight}px; position: relative; overflow: hidden; }
        .render-clip { height: ${viewportHeight}px; overflow: hidden; position: relative; }
        .render-clip .render-root { transform: translateY(-${offset}px); }
    `;

    const footerHtml = showFooter
        ? `\n<div class="render-page-footer">第 ${pageIndex + 1}/${pageCount} 页</div>`
        : '';

    const footerStyle = showFooter ? `
        .render-page-footer {
            position: absolute; left: 0; right: 0; bottom: 0; height: ${footerHeight}px;
            display: flex; align-items: center; justify-content: center;
            font-size: 12px; color: #999;
        }
    ` : '';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
${pageStyle}
${footerStyle}
${docStyle}
</style>
</head>
<body>
<div class="render-page">
<div class="render-clip">
${bodyContent}
</div>${footerHtml}
</div>
</body>
</html>`;
}
