/**
 * Agent 剧场路由决策逻辑（工作项 1：重跑上一轮 / 工作项 2：保存后试运行）
 *
 * 把 /api/agent-theatre/input 的重跑决策与 /api/agent-theatre/validate-run 的
 * 路由处理抽成可注入依赖的纯函数 / 工厂，便于单元测试
 * （参考 server/agent-frontend.js 的 createAgentFrontendValidateHandler 模式，
 * 测试见 test/agent-theatre-routes.test.js）。
 */

/**
 * 解析 /api/agent-theatre/input 请求体的重跑决策。
 *
 * 语义：
 *   - 正常输入 / 选项回调：turnDelta=1（新轮次），actualInput 取 input 或 "[选项回调] <callbackId>"
 *   - rerun=true：复用会话里的 lastInput（重跑同一轮不算新轮次，turnDelta=0）；
 *     会话无 lastInput 时返回 400
 *
 * @param {object} body - 请求体 { input, callbackId, rerun }
 * @param {object|null} sess - 当前会话状态（可为 null），需含 lastInput
 * @returns {{ok:true, actualInput:string, turnDelta:number, rerun:boolean}
 *           | {ok:false, status:number, error:string}}
 */
export function resolveTheatreRerun(body, sess) {
    const { input, callbackId, rerun } = body || {};
    if (!input && !callbackId && !rerun) {
        return { ok: false, status: 400, error: '需要 input 或 callbackId，或设置 rerun 重跑上一轮' };
    }
    if (rerun) {
        const lastInput = (sess && sess.lastInput) || '';
        if (!lastInput) {
            return { ok: false, status: 400, error: '没有可重跑的上一轮输入' };
        }
        return { ok: true, actualInput: lastInput, turnDelta: 0, rerun: true };
    }
    // 选项回调：callbackId 形如 "select:option:1"，转成 "[选项回调] <callbackId>" 作为 input
    const actualInput = input || (callbackId ? `[选项回调] ${callbackId}` : '');
    return { ok: true, actualInput, turnDelta: 1, rerun: false };
}

/**
 * 创建 POST /api/agent-theatre/validate-run 的路由处理函数（工作项 2）。
 *
 * 用指定 Profile 触发一次探测 run，验证 YAML 配置能否跑通（保存后试运行）。
 * 依赖通过 deps 注入，便于测试：
 *   - getAgentService()        -> agentService（含 run 方法）
 *   - getReadyAgentFramework() -> 已就绪插件实例（含 agentLoader.get）
 *   - getLlmService()          -> llmService
 *   - runAgent()               -> 可注入的 run 实现，默认取 agentService.run
 *
 * 返回：
 *   { success:true,  runId, text }        —— 探测 run 成功
 *   { success:false, error }              —— 参数缺失(400) / Profile 不存在(404) /
 *                                            服务不可用(503) / run 异常(200 内 success:false)
 */
export function createTheatreValidateRunHandler(deps = {}) {
    return async (req, res) => {
        try {
            const profileName = (req?.body && req.body.profileName) || '';
            if (!profileName) {
                return res.status(400).json({ success: false, error: '缺少 profileName 参数' });
            }

            const af = typeof deps.getReadyAgentFramework === 'function' ? deps.getReadyAgentFramework() : null;
            const profileDef = af && af.agentLoader && af.agentLoader.get(profileName);
            if (!profileDef) {
                return res.status(404).json({ success: false, error: `Profile 不存在: ${profileName}` });
            }

            const agentService = typeof deps.getAgentService === 'function' ? deps.getAgentService() : null;
            if (!agentService || typeof agentService.run !== 'function') {
                return res.status(503).json({ success: false, error: 'agent-framework 插件未加载' });
            }

            const llm = typeof deps.getLlmService === 'function' ? deps.getLlmService() : null;
            if (!llm) {
                return res.status(503).json({ success: false, error: 'runtime.llm 未配置，无法执行验证 run' });
            }

            const runAgent = typeof deps.runAgent === 'function' ? deps.runAgent : agentService.run.bind(agentService);
            const runResult = await runAgent(
                profileName,
                '（配置验证）请回复：配置验证通过',
                { platform: 'native', chatId: 'theatre-validate', character: '' },
                { llm, history: [], character: '' },
            );

            const text = (runResult && runResult.result && typeof runResult.result.getMainText === 'function')
                ? runResult.result.getMainText()
                : ((runResult && runResult.text) || '');
            res.json({ success: true, runId: runResult && runResult.runId, text });
        } catch (e) {
            res.json({ success: false, error: (e && e.message) || String(e) });
        }
    };
}
