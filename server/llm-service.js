/**
 * 插件 LLM 调用服务
 *
 * 让声明了 "llm" 权限的插件能调用网关配置的 LLM（runtime.llm），
 * 但**拿不到 API key**——与 gatewayConfig 脱敏视图同一原则：
 *   - LLMClient 在本服务内部构造，apiKey 只用于拼 HTTP 请求头，
 *     不出现在插件可见的任何对象或返回值里
 *   - 插件消耗的是网关配置的 API 额度，但无法窃取凭据
 *
 * 每次调用都现读配置（而非缓存 client），这样用户在面板改了
 * provider/model/key 后，插件下一次调用即生效，无需重启。
 */

import { LLMClient } from './runtime/llm-client.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('plugin-llm');

/** runtime.llm 未配置时的统一报错文案 */
const NOT_CONFIGURED =
    'LLM 未配置：请在 config/gateway.json 的 runtime.llm 中设置 provider/apiKey/model';

/**
 * 构造插件专用的 LLM 调用服务。
 *
 * @param {object} configManager - 网关配置管理器（读 runtime.llm）
 * @returns {{chat: Function, chatStream: Function, verify: Function}}
 */
export function createLLMService(configManager) {
    /** 现读配置并构造 client；缺 model 时抛出清晰错误 */
    const makeClient = () => {
        const llmCfg = configManager.get('runtime.llm');
        if (!llmCfg?.model) throw new Error(NOT_CONFIGURED);
        // 浅拷贝：避免插件（若拿到 sampling 里回传的对象）间接改到全局配置
        return new LLMClient({ ...llmCfg });
    };

    return {
        /**
         * 调用 LLM 生成回复（非流式）。
         * @param {Array<{role: string, content: string|Array}>} messages
         * @param {object} [sampling] - { temperature, max_tokens, top_p, ... }
         * @returns {Promise<string>} 完整回复文本
         */
        async chat(messages, sampling = {}) {
            return makeClient().generate(messages, sampling);
        },

        /**
         * 流式调用 LLM：边收边回调增量，返回完整文本。
         * @param {Array<{role: string, content: string|Array}>} messages
         * @param {object} [sampling]
         * @param {(delta: string, full: string) => void} [onDelta] - 增量回调
         * @returns {Promise<string>} 完整回复文本
         */
        async chatStream(messages, sampling = {}, onDelta) {
            return makeClient().generateStream(messages, sampling, onDelta);
        },

        /**
         * 单轮工具调用：把工具声明交给模型，返回它的文本 + 想调用的工具。
         * 不自动执行——由插件决定如何执行。适合插件想自己掌控执行流程时。
         * @param {Array} messages - 统一消息
         * @param {Array} tools - 工具声明 [{ name, description, parameters(JSON Schema) }]
         * @param {object} [sampling]
         * @returns {Promise<{text: string, toolCalls: Array<{id,name,arguments}>}>}
         */
        async chatWithTools(messages, tools = [], sampling = {}) {
            const { text, toolCalls } = await makeClient().generateWithTools(messages, tools, sampling);
            return { text, toolCalls };  // 不透传 raw：避免 provider 原始响应细节泄漏给插件
        },

        /**
         * 工具调用 agent 循环：模型请求工具 → 执行 executor → 回灌结果 → 再问，
         * 直到模型给出最终文本或达到 maxSteps。解锁 AstrBot agent 型 / 联网搜索类插件。
         * @param {Array} messages - 初始统一消息（通常 system + user）
         * @param {Array} tools - 工具声明
         * @param {(name: string, args: object) => Promise<any>|any} executor - 由插件提供的工具执行器
         * @param {object} [options] - { maxSteps?: number(默认5), sampling?: object }
         * @returns {Promise<{text: string, steps: number}>}
         */
        async runTools(messages, tools, executor, options = {}) {
            const { text, steps } = await makeClient().runTools(messages, tools, executor, options);
            return { text, steps };  // 不透传完整 messages：内部实现细节，插件只需最终文本 + 轮数
        },

        /**
         * 连通性校验（发一次极短请求）。
         * @returns {Promise<{ok: boolean, message: string}>}
         */
        async verify() {
            let client;
            try {
                client = makeClient();
            } catch (e) {
                logger.debug(`verify 前置检查失败: ${e.message}`);
                return { ok: false, message: e.message };
            }
            return client.verify();
        },
    };
}

export default { createLLMService };
