/**
 * 选项工具（共享）
 *
 * P1-1 修复：AgentRunResult.options 此前恒为空（runner 从不填充），
 * 导致面板选项区恒空、IM 选项依赖 option-splitter 从正文正则解析兜底。
 * 此模块把"从正文提取 >选项X： 选项"的逻辑抽为共享实现，供：
 *   - AgentRunner 在 run 产出阶段填充 result.options（引擎契约）
 *   - agent-rp 兜底模式的 _extractOptions（复用）
 *
 * 格式契约：与 option-splitter 的 DEFAULT_OPTION_LINE_REGEX 一致（plugin-coordination.test.js 守护）。
 * 注意：agent-rp/index.js 中保留字面量 OPTION_LINE_REGEX 用于静态契约比对，此处为同一模式的第三份副本，
 * 修改时务必三处同步（agent-rp / option-splitter / 本文件）。
 */

export const OPTION_LINE_REGEX = /^>\s*选项\s*([一二三四五六七八九十\d]+)\s*[：:]\s*(.+)$/gm;

/** 1-10 中文数字，>10 阿拉伯数字（与 option-splitter 正则字符类对齐） */
export function toChineseNum(n) {
    const cn = '一二三四五六七八九十';
    if (n >= 1 && n <= 10) return cn[n - 1];
    return String(n);
}

/**
 * 从 AI 回复中提取 >选项X： 格式的选项，返回正文和选项列表。
 * @param {string} text - AI 回复全文
 * @returns {{mainText: string, options: Array<{index: string, content: string, raw: string}>}}
 */
export function extractOptions(text) {
    if (!text) return { mainText: '', options: [] };

    const options = [];
    const extractRegex = new RegExp(OPTION_LINE_REGEX.source, 'gm');
    let m;
    let idx = 0;
    while ((m = extractRegex.exec(text)) !== null) {
        if (m.index === extractRegex.lastIndex) {
            extractRegex.lastIndex++;
            continue;
        }
        options.push({
            index: m[1] || String(++idx),
            content: m[2].trim(),
            raw: m[0].trim(),
        });
    }

    const stripRegex = new RegExp(OPTION_LINE_REGEX.source, 'gm');
    const mainText = text.replace(stripRegex, '').replace(/\n{3,}/g, '\n\n').trim();

    return { mainText, options };
}
