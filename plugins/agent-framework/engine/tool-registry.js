/**
 * 全局工具注册表
 * 框架内置工具和第三方插件注册的工具都存放在这里
 */
import { RecoverableToolError } from './tool-errors.js';

export class ToolRegistry {
    constructor() {
        this.tools = new Map();
    }

    /**
     * 注册工具
     * @param {Object} tool - { name, description, parameters, handler, validate? }
     */
    register(tool) {
        if (!tool.name) throw new Error('工具必须包含 name');
        if (this.tools.has(tool.name)) {
            // 允许覆盖（更新）
        }
        this.tools.set(tool.name, {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.parameters || { type: 'object', properties: {} },
            handler: tool.handler || (async () => '未实现'),
            validate: typeof tool.validate === 'function' ? tool.validate : undefined,
            source: tool.source || 'unknown',
        });
    }

    /**
     * 批量注册
     */
    registerAll(tools, source = 'unknown') {
        for (const tool of tools) {
            this.register({ ...tool, source });
        }
    }

    /**
     * 获取工具
     */
    get(name) {
        return this.tools.get(name);
    }

    /**
     * 按白名单过滤并返回工具声明（不含 handler）
     * @param {string[]} whitelist - 工具名白名单
     * @returns {Array} 工具声明数组（供 LLM tools 参数用）
     */
    getDeclarations(whitelist) {
        const result = [];
        for (const name of whitelist) {
            const tool = this.tools.get(name);
            if (tool) {
                result.push({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                });
            }
        }
        return result;
    }

    /**
     * 执行工具
     * @param {string} name - 工具名
     * @param {Object} args - 参数
     * @param {Object} context - 执行上下文（含 session/fs/llm 等）
     */
    async execute(name, args, context) {
        const tool = this.tools.get(name);
        if (!tool) {
            return { error: `工具 "${name}" 不存在` };
        }
        try {
            // 领域工具校验钩子：handler 前先 validate，不通过抛 RecoverableToolError
            // （错误信息应具体可读，如列出可用项，供 Agent loop 自我纠正）
            if (typeof tool.validate === 'function') {
                const v = await tool.validate(args, context);
                if (!v || !v.ok) {
                    throw new RecoverableToolError(
                        v?.error || `工具 "${name}" 参数校验失败`,
                        v?.details,
                    );
                }
            }
            const result = await tool.handler(args, context);
            return { result };
        } catch (e) {
            // 可恢复错误：保留 details 一并回传模型（列出可用项等）
            if (e instanceof RecoverableToolError) {
                return { error: e.message, recoverable: true, details: e.details };
            }
            return { error: e.message };
        }
    }

    /**
     * 创建工具执行器（供 ctx.llm.runTools 使用）
     */
    createExecutor(context) {
        return async (name, args) => {
            const ret = await this.execute(name, args, context);
            if (ret.error) {
                const payload = { error: ret.error };
                if (ret.details !== undefined) payload.details = ret.details;
                if (ret.recoverable) payload.recoverable = true;
                return JSON.stringify(payload);
            }
            return typeof ret.result === 'string' ? ret.result : JSON.stringify(ret.result);
        };
    }

    /**
     * 列出所有已注册工具
     */
    list() {
        return Array.from(this.tools.values()).map(t => ({
            name: t.name,
            description: t.description,
            source: t.source,
        }));
    }
}
