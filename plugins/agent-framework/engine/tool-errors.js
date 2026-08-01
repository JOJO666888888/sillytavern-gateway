/**
 * 工具错误分级（参考 TauriTavern）
 *
 * Agent 工具循环中可能产生三类错误，语义不同：
 *   - RecoverableToolError：模型可读、run 继续，Agent loop 可自我纠正
 *       （如"钱包 id wallet-x 不存在，当前可用: wallet-a, wallet-b"）
 *   - PolicyDeniedError：按 policy 决定 fail-fast 终止 run，或把 denied 结果返回模型继续
 *   - SystemFailure：runtime 失败（如 fs 错误、子进程崩溃），run 视为失败
 *
 * 与 spec.md "工具报错具体可读（列出可用项 / 当前场景目标），Agent loop 自我纠正" 对齐。
 */

/**
 * 可恢复工具错误。
 * 错误信息应具体可读，供模型在下一轮纠正。
 */
export class RecoverableToolError extends Error {
    /**
     * @param {string} message - 面向模型的可读错误信息
     * @param {object} [details] - 附加细节（如可用项列表），会一并回传给模型
     */
    constructor(message, details) {
        super(message);
        this.name = 'RecoverableToolError';
        this.details = details;
    }
}

/**
 * 策略拒绝错误。
 * 由上层 policy 决定是 fail-fast 终止 run，还是把 denied tool result 返回给模型继续。
 */
export class PolicyDeniedError extends Error {
    /**
     * @param {string} message - 拒绝原因
     * @param {string} [policy] - 触发的策略名（便于审计 / 日志）
     */
    constructor(message, policy) {
        super(message);
        this.name = 'PolicyDeniedError';
        this.policy = policy;
    }
}

/**
 * 系统级失败。
 * runtime 失败（fs 错误、子进程崩溃等），run 视为失败，不回传模型。
 */
export class SystemFailure extends Error {
    /**
     * @param {string} message - 失败原因
     * @param {*} [cause] - 原始错误 / 上下文
     */
    constructor(message, cause) {
        super(message);
        this.name = 'SystemFailure';
        this.cause = cause;
    }
}

export default { RecoverableToolError, PolicyDeniedError, SystemFailure };
