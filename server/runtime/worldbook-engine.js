import fs from 'fs';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('worldbook');

/**
 * 世界书 / Lorebook 引擎
 *
 * 支持 ST 世界书与角色卡内嵌 character_book 两种来源，实现：
 *   - constant 常驻条目（始终注入）
 *   - keyword 关键词触发（在扫描文本中命中 key）
 *   - selective + secondary_keys（需同时命中辅助关键词）
 *   - 按 insertion_order / order 排序
 *   - 按 position 分桶（角色定义之前 / 之后）
 *   - 基础递归扫描（已激活内容可再触发新条目，带深度上限）
 *
 * 归一化后条目结构：
 *   { keys[], secondaryKeys[], content, constant, selective, order, position, caseSensitive, enabled }
 */

/**
 * 把不同来源的世界书归一化为统一条目数组
 * @param {object} book - ST 世界书对象 { entries: {...}|[...] } 或角色卡 character_book
 * @returns {Array<object>}
 */
export function normalizeLorebook(book) {
    if (!book) return [];
    // ST 格式 entries 可能是对象（key 为 uid）或数组；character_book.entries 是数组
    const rawEntries = book.entries
        ? (Array.isArray(book.entries) ? book.entries : Object.values(book.entries))
        : (Array.isArray(book) ? book : []);

    return rawEntries.map((e) => {
        // 兼容 ST(key/keysecondary/order/disable) 与 V2(keys/secondary_keys/insertion_order/enabled)
        const keys = e.keys || e.key || [];
        const secondaryKeys = e.secondary_keys || e.keysecondary || [];
        const enabled = e.enabled !== undefined ? e.enabled : (e.disable !== undefined ? !e.disable : true);
        const order = e.insertion_order ?? e.order ?? 100;
        // position: V2 用 'before_char'/'after_char'；ST 用数字(0=before,1=after)
        let position = 'after_char';
        if (e.position === 'before_char' || e.position === 0) position = 'before_char';
        else if (e.position === 'after_char' || e.position === 1) position = 'after_char';

        return {
            keys: Array.isArray(keys) ? keys : [keys].filter(Boolean),
            secondaryKeys: Array.isArray(secondaryKeys) ? secondaryKeys : [secondaryKeys].filter(Boolean),
            content: e.content || '',
            constant: !!e.constant,
            selective: !!e.selective,
            order,
            position,
            caseSensitive: !!(e.case_sensitive ?? e.caseSensitive),
            enabled,
            comment: e.comment || e.name || '',
        };
    }).filter(e => e.content); // 空内容条目丢弃
}

/** 从文件加载世界书 */
export function loadLorebook(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return normalizeLorebook(raw);
}

/** 判断一个 key 是否在文本中命中 */
function keyHit(key, text, caseSensitive) {
    if (!key) return false;
    if (caseSensitive) return text.includes(key);
    return text.toLowerCase().includes(key.toLowerCase());
}

/**
 * 激活世界书条目
 * @param {Array<object>} entries - 归一化条目
 * @param {string} scanText - 扫描文本（通常是最近若干条消息 + 当前输入）
 * @param {object} options - { maxRecursion?: number, maxEntries?: number }
 * @returns {{ beforeChar: string[], afterChar: string[], activated: object[] }}
 */
export function activateEntries(entries, scanText, options = {}) {
    const maxRecursion = options.maxRecursion ?? 2;
    const maxEntries = options.maxEntries ?? 50;

    const activated = new Set();
    let text = scanText || '';

    // constant 条目直接激活
    for (const e of entries) {
        if (e.enabled && e.constant) activated.add(e);
    }

    // 关键词触发 + 递归
    for (let round = 0; round < maxRecursion; round++) {
        let newlyActivated = false;
        for (const e of entries) {
            if (!e.enabled || activated.has(e)) continue;
            const primaryHit = e.keys.some(k => keyHit(k, text, e.caseSensitive));
            if (!primaryHit) continue;
            // selective：需要辅助关键词也命中
            if (e.selective && e.secondaryKeys.length > 0) {
                const secHit = e.secondaryKeys.some(k => keyHit(k, text, e.caseSensitive));
                if (!secHit) continue;
            }
            activated.add(e);
            newlyActivated = true;
            // 递归：把激活内容并入扫描文本，可能触发更多条目
            text += '\n' + e.content;
            if (activated.size >= maxEntries) break;
        }
        if (!newlyActivated || activated.size >= maxEntries) break;
    }

    // 排序并分桶
    const sorted = [...activated].sort((a, b) => a.order - b.order);
    const beforeChar = [];
    const afterChar = [];
    for (const e of sorted) {
        (e.position === 'before_char' ? beforeChar : afterChar).push(e.content);
    }

    if (sorted.length > 0) {
        logger.debug(`世界书激活 ${sorted.length} 条 (before=${beforeChar.length}, after=${afterChar.length})`);
    }
    return { beforeChar, afterChar, activated: sorted };
}

export default { normalizeLorebook, loadLorebook, activateEntries };
