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

/** 从文件加载预设 */
export function loadPreset(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return normalizePreset(raw);
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

    // 顺序：ST 预设的 prompt_order 结构较复杂，这里仅在其明确给出简单顺序时采用，否则用默认
    let order = DEFAULT_ORDER;
    if (Array.isArray(raw.gateway_order) && raw.gateway_order.length) {
        order = raw.gateway_order; // 允许网关自定义预设直接给顺序
    }

    return {
        name: raw.name || 'default',
        sampling,
        order,
        systemPrompt: raw.system_prompt || raw.systemPrompt || '',
        // 是否把角色定义合并进单条 system（多数 OpenAI 兼容后端更稳）
        mergeSystem: raw.mergeSystem !== false,
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
    const { card = {}, preset = defaultPreset(), persona, world, history = [], userInput = '', userName = 'User' } = ctx;
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

    for (const key of preset.order) {
        if (key === 'history') {
            // 历史作为独立 messages 注入
            for (const h of history) {
                messages.push({ role: h.role, content: sub(h.content) });
            }
            continue;
        }
        const content = segments[key];
        if (!content) continue;
        if (preset.mergeSystem && key !== 'postHistory') {
            systemParts.push(content);
        } else {
            messages.push({ role: 'system', content });
        }
    }

    // persona 并入 system 头部
    if (segments.persona) systemParts.unshift(segments.persona);

    // 合并的 system 放到最前
    if (systemParts.length) {
        messages.unshift({ role: 'system', content: systemParts.join('\n\n') });
    }

    // 当前用户输入
    if (userInput) messages.push({ role: 'user', content: userInput });

    return { messages, sampling: preset.sampling };
}

export default { loadPreset, normalizePreset, defaultPreset, buildPrompt };
