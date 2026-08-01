/**
 * AI 辅助修改 Agent Profile 的处理逻辑（Task: AI 辅助页面修改系统）
 *
 * 设计目标：
 *   - 让无编程经验的用户用自然语言修改 Agent Profile YAML
 *   - 后端不直接信任 LLM 输出：解析 + 校验 + 快照回滚
 *   - 处理函数以工厂形式创建，依赖通过 deps 注入，便于单元测试
 *     （mock llmService.chat / 文件读写 / 历史栈），无需启动真实 HTTP 服务
 *
 * 暴露：
 *   - extractJsonFromLlmOutput(text)  从 LLM 输出中提取 JSON（兼容 ```json 包裹）
 *   - validateNewYaml(newYaml, currentYaml)  校验修改后的 YAML 合法性与安全性
 *   - buildPlanMessages(request, currentYaml)  构造 LLM 消息序列
 *   - createAiModifierHandlers(deps)  返回 4 个 Express 风格处理函数
 *   - MAX_HISTORY / MAX_MAX_TOKENS / MAX_MAX_STEPS  常量
 */

import path from 'path';
import fs from 'fs';

/** 每个_profile 最多保留的快照数 */
export const MAX_HISTORY = 10;
/** maxTokens 安全上限 */
export const MAX_MAX_TOKENS = 393216;
/** maxSteps 安全上限 */
export const MAX_MAX_STEPS = 50;

/**
 * 从 LLM 输出文本中提取 JSON 对象。
 *
 * LLM 经常把 JSON 用 ```json ... ``` 包裹，或在前后加解释性文字。
 * 本函数依次尝试：
 *   1) 去除首尾 ```json / ``` 围栏
 *   2) 直接 JSON.parse
 *   3) 贪心匹配第一个 { 到最后一个 } 的子串再 parse
 *
 * @param {string} text - LLM 原始输出
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function extractJsonFromLlmOutput(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, error: 'LLM 输出为空' };
    }
    let s = text.trim();

    // 1) 去除 ```json ... ``` 或 ``` ... ``` 围栏
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
    if (fence) {
        s = fence[1].trim();
    } else {
        // 即便没有结尾围栏，也可能有开头围栏
        const openFence = /^```(?:json)?\s*/i.exec(s);
        if (openFence) {
            s = s.slice(openFence[0].length).replace(/\s*```\s*$/, '').trim();
        }
    }

    // 2) 直接解析
    try {
        return { ok: true, value: JSON.parse(s) };
    } catch (_) { /* 继续下一步 */ }

    // 3) 贪心截取第一个 { 到最后一个 }
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
        const sub = s.slice(first, last + 1);
        try {
            return { ok: true, value: JSON.parse(sub) };
        } catch (e) {
            return { ok: false, error: `JSON 解析失败: ${e.message}` };
        }
    }
    return { ok: false, error: 'LLM 输出中未找到可解析的 JSON 对象' };
}

/**
 * 校验修改后的 YAML 文本合法性与安全性。
 *
 * 规则（任一不满足即拒绝）：
 *   - newYaml 非空
 *   - newYaml 不能比 currentYaml 短太多（< 50% 视为 LLM 砍内容）
 *   - tools 数组非空（不允许 tools: []）
 *   - systemPrompt 非空
 *   - maxTokens（若存在）<= 393216
 *   - maxSteps（若存在）<= 50
 *
 * @param {string} newYaml - 修改后的 YAML 全文
 * @param {string} [currentYaml] - 修改前的 YAML 全文（用于长度对比）
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateNewYaml(newYaml, currentYaml) {
    if (typeof newYaml !== 'string' || !newYaml.trim()) {
        return { ok: false, error: '修改后的 YAML 为空' };
    }

    // 长度对比：防止 LLM 砍掉大段内容
    if (currentYaml && currentYaml.trim()) {
        const oldLen = currentYaml.trim().length;
        const newLen = newYaml.trim().length;
        if (newLen < oldLen * 0.5) {
            return { ok: false, error: `修改后的 YAML 长度仅为原文的 ${Math.round((newLen / oldLen) * 100)}%，疑似内容丢失，已拒绝` };
        }
    }

    // tools 数组非空：匹配 `tools:` 行（仅同行水平空白），其后不能是 [] 或空
    // 注意：用 [ \t]* 而非 \s*，避免 \s 跨换行把下一行键名吞进捕获组
    const toolsLine = /^tools:[ \t]*(.*)$/m.exec(newYaml);
    if (toolsLine) {
        const inline = toolsLine[1].trim();
        if (inline === '[]') {
            return { ok: false, error: 'tools 数组不能为空' };
        }
        // 若 tools: 后同行无值，则下方必须至少有一个 `- xxx` 条目
        if (inline === '') {
            const afterTools = newYaml.slice(toolsLine.index + toolsLine[0].length);
            // 截取到下一个顶层键（行首非空格的 key:）
            const nextTop = /\n[a-zA-Z_]/.exec(afterTools);
            const block = nextTop ? afterTools.slice(0, nextTop.index) : afterTools;
            if (!/^[ \t]*-[ \t]+\S/m.test(block)) {
                return { ok: false, error: 'tools 数组不能为空（未找到任何工具条目）' };
            }
        }
    }

    // systemPrompt 非空：匹配 `systemPrompt:` 行（仅同行水平空白）
    const spLine = /^systemPrompt:[ \t]*(.*)$/m.exec(newYaml);
    if (spLine) {
        const inline = spLine[1].trim();
        // 若同行为 | 或 >（块标量），需后续有内容；同行直接为空则非法
        if (inline === '') {
            return { ok: false, error: 'systemPrompt 不能为空' };
        }
        // 块标量场景：检查块内是否有非空内容
        if (inline === '|' || inline === '>' || inline === '|-' || inline === '>-') {
            const afterSp = newYaml.slice(spLine.index + spLine[0].length);
            const nextTop = /\n[a-zA-Z_]/.exec(afterSp);
            const block = nextTop ? afterSp.slice(0, nextTop.index) : afterSp;
            if (!block.trim()) {
                return { ok: false, error: 'systemPrompt 不能为空' };
            }
        }
    }

    // maxTokens 上限（顶层，行首无缩进）
    const mt = /^maxTokens:[ \t]*(\d+)[ \t]*$/m.exec(newYaml);
    if (mt) {
        const v = parseInt(mt[1], 10);
        if (v > MAX_MAX_TOKENS) {
            return { ok: false, error: `maxTokens ${v} 超过安全上限 ${MAX_MAX_TOKENS}` };
        }
    }
    // 嵌套 model.maxTokens（行首有缩进）
    const mmt = /^[ \t]+maxTokens:[ \t]*(\d+)[ \t]*$/m.exec(newYaml);
    if (mmt) {
        const v = parseInt(mmt[1], 10);
        if (v > MAX_MAX_TOKENS) {
            return { ok: false, error: `model.maxTokens ${v} 超过安全上限 ${MAX_MAX_TOKENS}` };
        }
    }

    // maxSteps 上限
    const ms = /^maxSteps:[ \t]*(\d+)[ \t]*$/m.exec(newYaml);
    if (ms) {
        const v = parseInt(ms[1], 10);
        if (v > MAX_MAX_STEPS) {
            return { ok: false, error: `maxSteps ${v} 超过安全上限 ${MAX_MAX_STEPS}` };
        }
    }

    return { ok: true };
}

/**
 * 构造发给 LLM 的系统提示与用户消息。
 *
 * @param {string} request - 用户的自然语言修改需求
 * @param {string} currentYaml - 当前 Profile YAML 全文
 * @returns {Array<{role: string, content: string}>}
 */
export function buildPlanMessages(request, currentYaml) {
    const systemPrompt = `你是一位 Agent RP 配置助手，帮助无编程经验的用户把自然语言需求转成 Agent Profile YAML 修改。

【可修改字段（仅限这些）】
- displayName：显示名称
- description：方案描述
- systemPrompt：系统提示词（叙事 GM 的核心指令）
- tools：工具白名单数组（如 state.read / memory.recall / narrative.generate）
- context.historyLimit：历史轮数上限
- context.injectFiles：注入文件列表
- model.temperature：采样温度
- model.maxTokens：单轮最大 token
- maxSteps：Agent 最大步数
- subAgents：子代理配置

【禁止的危险操作】
- 不能删除整个 profile
- 不能清空 systemPrompt
- 不能把 tools 设为空数组
- 不能把 maxTokens 设为超过 ${MAX_MAX_TOKENS}
- 不能把 maxSteps 设为超过 ${MAX_MAX_STEPS}
- 不能修改 name 字段

【输出要求】
必须输出**严格的 JSON**（不要 markdown 代码块、不要前后解释文字），格式如下：
{
  "understanding": "用通俗中文复述你对用户需求的理解",
  "summary": "用要点列出将做的修改（1. ... 2. ...）",
  "riskLevel": "low|medium|high",
  "riskNote": "风险说明，low 则为空字符串",
  "changes": [{"field":"model.temperature","from":"0.8","to":"0.95","reason":"提高创造性以增加文风多样性"}],
  "newYaml": "完整的修改后的 YAML 全文（保留原有结构，只改必要部分）"
}

风险分级参考：
- low：仅微调参数或润色文字
- medium：改动工具列表、子代理、maxSteps 等会影响行为的配置
- high：大改 systemPrompt、删除大量内容、可能影响稳定性

newYaml 必须是完整可用的 YAML，不能省略原有多数内容，只对必要部分做修改。`;

    const userPrompt = `【用户需求】
${request}

【当前 Profile YAML】
\`\`\`yaml
${currentYaml}
\`\`\`

请按指定 JSON 格式输出修改方案。`;

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];
}

/**
 * 创建 AI 辅助修改的 Express 处理函数集合。
 *
 * @param {object} deps
 * @param {() => object|null} deps.getLlmService - 返回当前 llmService（含 chat 方法），未就绪时返回 null
 * @param {(profileName: string) => string} deps.readCurrentYaml - 读取某 profile 当前 YAML 全文（不存在返回空串）
 * @param {(profileName: string, yaml: string) => void} deps.writeYaml - 保存 profile YAML（写入磁盘 + 更新内存）
 * @param {Map<string, string[]>} deps.history - 快照历史栈（profileName -> [yamlSnapshot, ...]）
 * @param {object} [deps.logger] - 日志器
 * @returns {{plan: Function, apply: Function, undo: Function, history: Function}}
 */
export function createAiModifierHandlers(deps) {
    const logger = deps.logger || console;

    /**
     * 推入快照到历史栈，超过 MAX_HISTORY 则丢弃最旧的。
     * @param {string} profileName
     * @param {string} yaml
     */
    function pushSnapshot(profileName, yaml) {
        if (!deps.history.has(profileName)) deps.history.set(profileName, []);
        const stack = deps.history.get(profileName);
        stack.push(yaml);
        while (stack.length > MAX_HISTORY) stack.shift();
    }

    /**
     * POST /api/agent-theatre/ai-modify/plan
     * 生成修改方案（不实际应用）。
     */
    async function plan(req, res) {
        const { request, profileName, currentYaml } = req.body || {};
        if (!request || typeof request !== 'string' || !request.trim()) {
            return res.status(400).json({ success: false, error: '缺少 request 字段（自然语言需求）' });
        }
        if (!profileName || typeof profileName !== 'string') {
            return res.status(400).json({ success: false, error: '缺少 profileName 字段' });
        }
        const yamlText = typeof currentYaml === 'string' ? currentYaml : '';
        if (!yamlText.trim()) {
            return res.status(400).json({ success: false, error: '缺少 currentYaml 字段（当前 Profile 内容）' });
        }

        const llm = deps.getLlmService ? deps.getLlmService() : null;
        if (!llm || typeof llm.chat !== 'function') {
            return res.status(503).json({ success: false, error: 'runtime.llm 未配置，无法调用 AI' });
        }

        try {
            const messages = buildPlanMessages(request, yamlText);
            // temperature: 0.3 让输出稳定；max_tokens 给足容纳完整 YAML
            const raw = await llm.chat(messages, { temperature: 0.3, max_tokens: 8192 });
            const parsed = extractJsonFromLlmOutput(raw);
            if (!parsed.ok) {
                logger.error?.(`[ai-modify/plan] LLM 输出解析失败: ${parsed.error}`);
                return res.status(502).json({ success: false, error: `AI 输出解析失败: ${parsed.error}` });
            }
            const planObj = parsed.value;
            // 结构完整性校验
            const required = ['understanding', 'summary', 'riskLevel', 'riskNote', 'changes', 'newYaml'];
            for (const k of required) {
                if (!(k in planObj)) {
                    return res.status(502).json({ success: false, error: `AI 输出缺少字段: ${k}` });
                }
            }
            // 校验 newYaml
            const v = validateNewYaml(planObj.newYaml, yamlText);
            if (!v.ok) {
                return res.status(422).json({ success: false, error: `修改方案校验失败: ${v.error}` });
            }
            // 规范化 riskLevel
            const riskLevel = String(planObj.riskLevel).toLowerCase();
            if (!['low', 'medium', 'high'].includes(riskLevel)) {
                planObj.riskLevel = 'medium';
            } else {
                planObj.riskLevel = riskLevel;
            }

            return res.json({ success: true, plan: planObj });
        } catch (e) {
            logger.error?.(`[ai-modify/plan] 调用失败: ${e.message}`);
            return res.status(500).json({ success: false, error: `AI 调用失败: ${e.message}` });
        }
    }

    /**
     * POST /api/agent-theatre/ai-modify/apply
     * 应用修改：先快照当前 YAML，再写入新 YAML。
     */
    async function apply(req, res) {
        const { profileName, newYaml } = req.body || {};
        if (!profileName || typeof profileName !== 'string') {
            return res.status(400).json({ success: false, error: '缺少 profileName 字段' });
        }
        if (typeof newYaml !== 'string' || !newYaml.trim()) {
            return res.status(400).json({ success: false, error: '缺少 newYaml 字段' });
        }

        try {
            // 保存当前 YAML 快照（应用前的状态，用于撤销）
            const current = deps.readCurrentYaml(profileName);
            if (current) {
                pushSnapshot(profileName, current);
            }
            // 写入新 YAML
            deps.writeYaml(profileName, newYaml);
            const stack = deps.history.get(profileName) || [];
            logger.info?.(`[ai-modify/apply] 已应用 ${profileName}，历史栈 ${stack.length} 步`);
            return res.json({ success: true, snapshotSaved: !!current, remaining: stack.length });
        } catch (e) {
            logger.error?.(`[ai-modify/apply] 保存失败: ${e.message}`);
            return res.status(500).json({ success: false, error: `保存失败: ${e.message}` });
        }
    }

    /**
     * POST /api/agent-theatre/ai-modify/undo
     * 撤销上次修改：从历史栈弹出快照并覆盖当前 profile。
     */
    async function undo(req, res) {
        const { profileName } = req.body || {};
        if (!profileName || typeof profileName !== 'string') {
            return res.status(400).json({ success: false, error: '缺少 profileName 字段' });
        }
        const stack = deps.history.get(profileName) || [];
        if (stack.length === 0) {
            return res.status(409).json({ success: false, error: '没有可撤销的修改' });
        }
        const snapshot = stack.pop();
        try {
            deps.writeYaml(profileName, snapshot);
            logger.info?.(`[ai-modify/undo] 已撤销 ${profileName}，剩余 ${stack.length} 步`);
            return res.json({
                success: true,
                restoredYaml: snapshot,
                remaining: stack.length,
            });
        } catch (e) {
            // 写失败，把快照放回去，避免丢失撤销机会
            stack.push(snapshot);
            logger.error?.(`[ai-modify/undo] 恢复失败: ${e.message}`);
            return res.status(500).json({ success: false, error: `恢复失败: ${e.message}` });
        }
    }

    /**
     * GET /api/agent-theatre/ai-modify/history?profileName=xxx
     * 查询撤销历史计数。
     */
    function history(req, res) {
        const profileName = (req.query && req.query.profileName) || (req.body && req.body.profileName);
        if (!profileName || typeof profileName !== 'string') {
            return res.status(400).json({ success: false, error: '缺少 profileName 参数' });
        }
        const stack = deps.history.get(profileName) || [];
        return res.json({ success: true, count: stack.length, canUndo: stack.length > 0 });
    }

    return { plan, apply, undo, history };
}

/**
 * 构造生产环境依赖：从 agent-framework 插件读取/写入 Profile YAML。
 *
 * @param {object} opts
 * @param {() => object|null} opts.getAgentFramework - 返回 agent-framework 插件实例（含 agentLoader）
 * @returns {{readCurrentYaml: Function, writeYaml: Function}}
 */
export function createProfileStore({ getAgentFramework }) {
    return {
        /**
         * 读取某 profile 当前 YAML 全文（从 agentLoader 的 agents 目录直接读文件）。
         * 不存在时返回空串。
         */
        readCurrentYaml(profileName) {
            const af = getAgentFramework();
            if (!af || !af.agentLoader || !af.agentLoader.agentsDir) return '';
            const file = path.join(af.agentLoader.agentsDir, `${profileName}.yaml`);
            try {
                if (!fs.existsSync(file)) return '';
                return fs.readFileSync(file, 'utf-8');
            } catch (_) {
                return '';
            }
        },
        /**
         * 保存 profile YAML：复用 agentLoader.save（写文件 + 更新内存 Map + 热重载生效）。
         */
        writeYaml(profileName, yaml) {
            const af = getAgentFramework();
            if (!af || !af.agentLoader) {
                throw new Error('Agent 框架未启用，无法保存 Profile');
            }
            af.agentLoader.save(profileName, yaml);
        },
    };
}

export default {
    MAX_HISTORY,
    MAX_MAX_TOKENS,
    MAX_MAX_STEPS,
    extractJsonFromLlmOutput,
    validateNewYaml,
    buildPlanMessages,
    createAiModifierHandlers,
    createProfileStore,
};
