/**
 * ST 兼容 R1 重构：专业子 Agent 处理器（功能任务与主对话解耦）
 *
 * 设计理念：主对话 Agent 专注"任务指派 + 正文输出"；以下两个功能性任务
 * 由独立 LLM 调用（可用第二模型）实时处理，不再依赖角色卡世界书规定
 * AI 输出 <sum>/<UpdateVariable> 标签（触发不稳定）：
 *
 *   1. 变量处理子 Agent（variableProcessor）：每轮从正文推导 stat_data 差分
 *      （输出 JSON Patch 数组），由 mvu-engine 应用到快照。
 *   2. 编年史/小总结子 Agent（chronicle）：每轮独立生成 1-2 句剧情总结，
 *      累积为编年史（服务端权威存储）。
 *
 * 处理器配置见 config.js runtime.agentCompat：
 *   - model/baseUrl/apiKey 留空 = 用主 LLM；填了即"第二 API"分工。
 */

import { LLMClient } from '../runtime/llm-client.js';
import { formatVariables, parseJsonPatch } from './mvu-engine.js';
import yaml from 'js-yaml';

/** 依据主 LLM 配置 + 处理器覆盖项构造处理器客户端；未配 model 返回 null */
function buildProcessorClient(configManager, processorCfg) {
    const llm = configManager.get('runtime.llm') || {};
    const cfg = processorCfg || {};
    const model = cfg.model || llm.model;
    if (!model) return null;
    return new LLMClient({
        provider: llm.provider || 'openai',
        baseUrl: cfg.baseUrl || llm.baseUrl || '',
        apiKey: cfg.apiKey || llm.apiKey || '',
        model,
        timeout: llm.timeout || 120000,
        maxTokens: llm.maxTokens || 131072,
    });
}

/** 通用：单轮 chat 调用，返回文本；失败抛错（调用方 catch 降级） */
async function chatOnce(client, system, user, maxTokens, temperature) {
    const text = await client.generate(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        { max_tokens: maxTokens, temperature: temperature ?? 0.3 },
    );
    return (text || '').trim();
}

/**
 * 变量处理子 Agent：从本轮正文推导 stat_data 差分。
 * @param {object} opts
 * @param {object} opts.configManager
 * @param {string} opts.mainText - 主 Agent 本轮正文
 * @param {object} opts.statData - 当前 stat_data 快照
 * @param {string} [opts.rules] - 变量更新规则（来自角色卡世界书，可空）
 * @param {string} [opts.characterName]
 * @param {Function} [opts.clientFactory] - 客户端工厂（测试注入 mock；默认 buildProcessorClient）
 * @returns {Promise<{patch: Array, raw: string}|null>} 未启用/无模型返回 null
 */
export async function runVariableProcessor({ configManager, mainText, statData, rules = '', characterName = '', clientFactory }) {
    const compat = configManager.get('runtime.agentCompat') || {};
    if (compat.enabled === false || compat.variableProcessor?.enabled === false) return null;
    const cfg = compat.variableProcessor || {};
    const client = (clientFactory || buildProcessorClient)(configManager, cfg);
    if (!client) return null;

    const system = [
        '你是角色扮演游戏的「变量管理子代理」。你的职责是：根据本轮剧情正文，推导并输出变量表的增量更新。',
        '输入给你：当前变量表（stat_data，JSON/YAML 形态）、变量更新规则、本轮正文。',
        '输出要求：只输出一个 JSON Patch（RFC 6902）数组，支持 replace / delta / insert / remove / move。',
        '规则：',
        '- delta 用于数字增减（如好感度 +2）；move 的目标字段用 "to"；',
        '- 键名以 _ 开头的字段只读，不要更新；',
        '- 未发生变化的变量不要出现在输出中；',
        '- 不要输出解释、不要输出 Markdown 代码块以外的内容；若没有需要更新的变量，输出 []。',
    ].join('\n');

    const user = [
        `角色：${characterName || '（未知）'}`,
        '',
        '当前变量表（stat_data）：',
        '```json',
        JSON.stringify(statData || {}, null, 2),
        '```',
        '',
        '变量更新规则：',
        rules || '（无）',
        '',
        '本轮正文：',
        '```',
        mainText || '（空）',
        '```',
        '',
        '请输出 JSON Patch 数组：',
    ].join('\n');

    const raw = await chatOnce(client, system, user, cfg.maxTokens || 2048, 0.2);
    return { patch: parseJsonPatch(raw), raw };
}

/**
 * 编年史/小总结子 Agent：每轮独立生成 1-2 句剧情总结。
 * @param {object} opts
 * @param {object} opts.configManager
 * @param {string} opts.mainText
 * @param {string} [opts.previousSummary]
 * @param {string} [opts.characterName]
 * @param {Function} [opts.clientFactory] - 客户端工厂（测试注入 mock；默认 buildProcessorClient）
 * @returns {Promise<string|null>} 未启用/无模型返回 null
 */
export async function runChronicleProcessor({ configManager, mainText, previousSummary = '', characterName = '', clientFactory }) {
    const compat = configManager.get('runtime.agentCompat') || {};
    if (compat.enabled === false || compat.chronicle?.enabled === false) return null;
    const cfg = compat.chronicle || {};
    const client = (clientFactory || buildProcessorClient)(configManager, cfg);
    if (!client) return null;

    const system = [
        '你是角色扮演游戏的「编年史记录员」。你的职责是：把每轮剧情正文压缩为 1-2 句编年史条目。',
        '要求：从时间、空间、地点、人物、行为/事件上精准概括；只保留关键信息；语言精炼无废话。',
        '只输出总结内容本身，不要标题、不要解释。',
    ].join('\n');

    const user = [
        `角色：${characterName || '（未知）'}`,
        '',
        '上一段编年史（用于衔接，可忽略或继承）：',
        previousSummary || '（无）',
        '',
        '本轮正文：',
        '```',
        mainText || '（空）',
        '```',
        '',
        '请输出本轮编年史条目（1-2 句话）：',
    ].join('\n');

    const text = await chatOnce(client, system, user, cfg.maxTokens || 1024, 0.3);
    return text || null;
}

/**
 * 从角色卡内嵌世界书提取 `[initvar]` 初始变量表。
 * @param {object|null} card - 归一化角色卡（含 characterBook）
 * @returns {object|null} 解析出的初始 stat_data；无 initvar 或解析失败返回 null
 */
export function extractInitVariables(card) {
    try {
        const book = card?.characterBook;
        const entries = Array.isArray(book?.entries) ? book.entries : [];
        const entry = entries.find(e => /initvar/i.test(String(e.name || '')));
        if (!entry || !entry.content) return null;
        const content = String(entry.content).trim()
            .replace(/^```(?:yaml|yml|json)?/i, '').replace(/```$/, '').trim();
        // 优先 JSON
        try {
            const j = JSON.parse(content);
            if (j && typeof j === 'object') return j;
        } catch (_) { /* 继续尝试 YAML */ }
        // YAML（依赖 js-yaml）
        try {
            const y = yaml.load(content);
            if (y && typeof y === 'object') return y;
        } catch (_) { /* 解析失败 */ }
        // 极简兜底：按 "key: value" 行解析
        const out = {};
        let ok = false;
        for (const line of content.split('\n')) {
            const m = line.match(/^([^:#\s][^:]{0,40})\s*:\s*(.+)$/);
            if (m) { out[m[1].trim()] = coerceScalar(m[2].trim()); ok = true; }
        }
        return ok ? out : null;
    } catch (_) {
        return null;
    }
}

/** 从角色卡内嵌世界书提取「变量更新规则」条目内容（供变量处理子 Agent） */
export function extractUpdateRules(card) {
    try {
        const book = card?.characterBook;
        const entries = Array.isArray(book?.entries) ? book.entries : [];
        const entry = entries.find(e => /变量更新规则/.test(String(e.name || '')));
        return entry && entry.content ? String(entry.content).trim() : '';
    } catch (_) {
        return '';
    }
}

function coerceScalar(v) {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^[-+]?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
}

/** 供 agent-api 便捷引用 */
export { formatVariables };
