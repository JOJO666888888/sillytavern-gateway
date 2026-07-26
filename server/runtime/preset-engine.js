import fs from 'fs';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('preset');

/**
 * 预设引擎 + Prompt 组装
 *
 * 预设(preset)包含两部分：
 *   1. 采样参数：temperature / top_p / max_tokens / frequency_penalty ...
 *   2. prompt 结构顺序：system / 角色描述 / 世界书 / 示例对话 / 历史 / 用户输入 的排列
 *
 * 本模块把 {角色卡, 人格persona, 世界书激活结果, 历史, 用户输入} 按预设顺序组装成
 * OpenAI 风格的 messages 数组，并给出采样参数。
 *
 * 采用一套内置默认顺序；如提供 ST 预设 JSON(含 prompt_order/prompts)，尽力遵循其顺序。
 */

// 内置默认 prompt 段顺序
const DEFAULT_ORDER = [
    'system',        // 预设的 system_prompt（若有）
    'charDescription',
    'charPersonality',
    'scenario',
    'worldBefore',   // 世界书 before_char
    'mesExample',
    'worldAfter',    // 世界书 after_char
    'history',       // 对话历史
    'postHistory',   // post_history_instructions（jailbreak/收尾指令）
];

const DEFAULT_SAMPLING = {
    temperature: 0.9,
    top_p: 1,
    max_tokens: 1024,
    frequency_penalty: 0,
    presence_penalty: 0,
};

/**
 * 估算文本 token 数（CJK 感知的启发式，无需 tokenizer 依赖）。
 * - CJK/全角字符：约 1 token/字
 * - 其余（拉丁字母、数字、符号）：约 1 token / 4 字符
 * 估算偏保守（略高），用于截断预算足够安全。
 * @param {string|Array} content - 文本或多模态 parts
 * @returns {number}
 */
export function estimateTokens(content) {
    if (!content) return 0;
    // 多模态：文本部分照算，每张图片按固定开销估算
    if (Array.isArray(content)) {
        return content.reduce((sum, p) => {
            if (p.type === 'text') return sum + estimateTokens(p.text);
            if (p.type === 'image') return sum + 800; // 图片粗略开销
            return sum;
        }, 0);
    }
    const text = String(content);
    let cjk = 0;
    for (const ch of text) {
        const c = ch.codePointAt(0);
        // CJK 统一表意文字 / 假名 / 全角标点 / 谚文
        if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
    }
    const rest = [...text].length - cjk;
    return Math.ceil(cjk + rest / 4);
}

/** 估算整个 messages 数组的 token 数（含每条消息的固定开销） */
export function estimateMessagesTokens(messages) {
    return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

/**
 * 按 token 预算截断历史（保留最近的对话）。
 * 相比按条数截断，能避免"少数超长消息撑爆上下文"。
 * @param {Array<{role,content}>} history
 * @param {number} budget - 留给历史的 token 预算
 * @returns {Array} 截断后的历史（保序）
 */
export function truncateHistoryByTokens(history, budget) {
    if (!budget || budget <= 0) return history;
    const kept = [];
    let total = 0;
    // 从最近往前累加，保留尽可能多的近期上下文
    for (let i = history.length - 1; i >= 0; i--) {
        const cost = estimateTokens(history[i].content) + 4;
        if (total + cost > budget) break;
        total += cost;
        kept.unshift(history[i]);
    }
    return kept;
}

/** 从文件加载预设 */
export function loadPreset(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return normalizePreset(raw);
}

/**
 * SillyTavern 预设的 marker identifier → 本引擎内部段键 的映射。
 * ST 用 marker 条目占位表示"此处插入角色描述/世界书/历史…"。
 */
const ST_MARKER_MAP = {
    worldInfoBefore: 'worldBefore',
    worldInfoAfter: 'worldAfter',
    charDescription: 'charDescription',
    charPersonality: 'charPersonality',
    scenario: 'scenario',
    personaDescription: 'persona',
    dialogueExamples: 'mesExample',
    chatHistory: 'history',
};

/**
 * 解析 SillyTavern 预设的 prompts[] + prompt_order[]，还原完整顺序。
 *
 * ST 结构：
 *   prompts:      [{ identifier, role, content, marker, system_prompt, ... }]
 *   prompt_order: [{ character_id, order: [{ identifier, enabled }] }]
 *
 * 还原结果是一个混合数组，元素为：
 *   - string：内部段键（如 'charDescription' / 'history'），由 buildPrompt 填充实际内容
 *   - {type:'literal', role, content}：预设自带的固定文本（main / jailbreak / nsfw / 自定义条目）
 *
 * @param {object} raw - 原始预设 JSON
 * @returns {Array|null} 顺序数组；无法解析时返回 null（调用方回退默认顺序）
 */
export function parseSTPromptOrder(raw) {
    if (!Array.isArray(raw?.prompts) || !Array.isArray(raw?.prompt_order)) return null;

    // 建立 identifier → prompt 定义 的索引
    const byId = new Map();
    for (const p of raw.prompts) {
        if (p && p.identifier) byId.set(p.identifier, p);
    }

    // prompt_order 可能有多个 character_id；取默认档(100001)，否则取最后一个
    const orderEntry = raw.prompt_order.find(o => o.character_id === 100001)
        || raw.prompt_order[raw.prompt_order.length - 1];
    const orderList = orderEntry?.order;
    if (!Array.isArray(orderList)) return null;

    const result = [];
    for (const item of orderList) {
        if (!item || item.enabled === false) continue;   // 尊重 enabled 开关
        const def = byId.get(item.identifier);
        if (!def) continue;

        // marker 条目 → 映射到内部段键
        if (def.marker || ST_MARKER_MAP[item.identifier]) {
            const key = ST_MARKER_MAP[item.identifier];
            if (key) result.push(key);
            continue;
        }
        // 普通条目 → 固定文本，保留其 role
        const content = (def.content || '').trim();
        if (!content) continue;
        result.push({
            type: 'literal',
            role: def.role || (def.system_prompt === false ? 'user' : 'system'),
            content,
            identifier: item.identifier,
        });
    }

    return result.length ? result : null;
}

/** 归一化预设：提取采样参数与顺序 */
export function normalizePreset(raw = {}) {
    const sampling = { ...DEFAULT_SAMPLING };
    for (const k of Object.keys(DEFAULT_SAMPLING)) {
        if (raw[k] !== undefined) sampling[k] = raw[k];
    }
    // ST 预设常见字段名映射
    if (raw.temp !== undefined) sampling.temperature = raw.temp;
    if (raw.openai_max_tokens !== undefined) sampling.max_tokens = raw.openai_max_tokens;
    if (raw.top_p !== undefined) sampling.top_p = raw.top_p;
    if (raw.frequency_penalty !== undefined) sampling.frequency_penalty = raw.frequency_penalty;
    if (raw.presence_penalty !== undefined) sampling.presence_penalty = raw.presence_penalty;

    // 顺序优先级：网关自定义 gateway_order > ST prompt_order 还原 > 内置默认
    let order = DEFAULT_ORDER;
    let source = 'default';
    if (Array.isArray(raw.gateway_order) && raw.gateway_order.length) {
        order = raw.gateway_order;
        source = 'gateway_order';
    } else {
        const stOrder = parseSTPromptOrder(raw);
        if (stOrder) {
            order = stOrder;
            source = 'st_prompt_order';
        }
    }

    return {
        name: raw.name || 'default',
        sampling,
        order,
        orderSource: source,
        systemPrompt: raw.system_prompt || raw.systemPrompt || '',
        // 是否把角色定义合并进单条 system（多数 OpenAI 兼容后端更稳）
        // 注意：还原 ST 顺序时默认不合并，以尊重预设中各条目的 role 与位置
        mergeSystem: raw.mergeSystem !== undefined ? raw.mergeSystem : (source !== 'st_prompt_order'),
    };
}

/** 默认预设 */
export function defaultPreset() {
    return normalizePreset({});
}

/**
 * 组装 prompt
 * @param {object} ctx
 *   @param {object} ctx.card - 归一化角色卡
 *   @param {object} ctx.preset - 归一化预设
 *   @param {object} [ctx.persona] - 用户人格 { name, description }
 *   @param {{beforeChar: string[], afterChar: string[]}} [ctx.world] - 世界书激活结果
 *   @param {Array<{role, content}>} [ctx.history] - 对话历史
 *   @param {string} ctx.userInput - 当前用户输入
 *   @param {string} [ctx.userName] - 用户名（替换 {{user}}）
 * @returns {{ messages: Array<{role, content}>, sampling: object }}
 */
export function buildPrompt(ctx) {
    const {
        card = {}, preset = defaultPreset(), persona, world,
        history = [], userInput = '', userName = 'User', tokenBudget = 0,
    } = ctx;
    const charName = card.name || 'Assistant';

    // 占位符替换
    const sub = (s) => (s || '')
        .replace(/\{\{char\}\}/gi, charName)
        .replace(/\{\{user\}\}/gi, userName);

    // 各段内容
    const segments = {
        system: sub(preset.systemPrompt || card.systemPrompt || ''),
        charDescription: card.description ? `${charName} 的设定：\n${sub(card.description)}` : '',
        charPersonality: card.personality ? `${charName} 的性格：${sub(card.personality)}` : '',
        scenario: card.scenario ? `场景：${sub(card.scenario)}` : '',
        worldBefore: world?.beforeChar?.length ? sub(world.beforeChar.join('\n\n')) : '',
        mesExample: card.mesExample ? `示例对话：\n${sub(card.mesExample)}` : '',
        worldAfter: world?.afterChar?.length ? sub(world.afterChar.join('\n\n')) : '',
        postHistory: sub(card.postHistoryInstructions || ''),
        persona: persona?.description ? `用户(${persona.name || userName})：${sub(persona.description)}` : '',
    };

    const messages = [];
    const systemParts = [];

    // token 预算截断：先算非历史部分的开销，剩余额度留给历史
    let effectiveHistory = history;
    if (tokenBudget > 0) {
        const fixedCost = Object.values(segments).reduce((s, v) => s + estimateTokens(v), 0)
            + estimateTokens(userInput)
            + (preset.sampling?.max_tokens || 0); // 为回复预留
        const historyBudget = tokenBudget - fixedCost;
        effectiveHistory = truncateHistoryByTokens(history, historyBudget);
        if (effectiveHistory.length < history.length) {
            logger.debug(`token 预算截断历史: ${history.length} → ${effectiveHistory.length} 条 (预算 ${historyBudget})`);
        }
    }

    // 记录 persona 是否已由顺序表显式安置（ST 的 personaDescription marker）
    let personaPlaced = false;

    for (const entry of preset.order) {
        // ST 预设还原出的固定文本条目（main / jailbreak / nsfw / 自定义）
        if (entry && typeof entry === 'object' && entry.type === 'literal') {
            const content = sub(entry.content);
            if (!content) continue;
            if (preset.mergeSystem && entry.role === 'system') {
                systemParts.push(content);
            } else {
                messages.push({ role: entry.role || 'system', content });
            }
            continue;
        }

        const key = entry;
        if (key === 'history') {
            // 历史作为独立 messages 注入
            for (const h of effectiveHistory) {
                messages.push({ role: h.role, content: sub(h.content) });
            }
            continue;
        }
        const content = segments[key];
        if (!content) continue;
        if (key === 'persona') personaPlaced = true;
        if (preset.mergeSystem && key !== 'postHistory') {
            systemParts.push(content);
        } else {
            messages.push({ role: 'system', content });
        }
    }

    // persona 未被顺序表显式安置时，兜底并入 system 头部
    if (segments.persona && !personaPlaced) systemParts.unshift(segments.persona);

    // 合并的 system 放到最前
    if (systemParts.length) {
        messages.unshift({ role: 'system', content: systemParts.join('\n\n') });
    }

    // 当前用户输入
    if (userInput) messages.push({ role: 'user', content: userInput });

    return { messages, sampling: preset.sampling };
}

export default { loadPreset, normalizePreset, defaultPreset, buildPrompt, parseSTPromptOrder, estimateTokens, estimateMessagesTokens, truncateHistoryByTokens };
