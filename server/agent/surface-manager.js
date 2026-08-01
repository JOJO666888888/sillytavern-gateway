/**
 * 表现层调度器（Presentation Surface Manager）
 *
 * 把 AgentRunResult 分发给已注册的适配器渲染，解耦"引擎产出"与"界面渲染"。
 *
 * 适配器接口（最小契约）：
 *   {
 *     name: string,                 // 适配器唯一名（如 'im-default'）
 *     surfaceType: string,          // 适配器类型（'im' | 'st' | 'native' | 自定义）
 *     render: async (agentRunResult, ctx) => any
 *   }
 *
 * 调度规则（见 spec.md "Scenario: 表现层适配器注册"）：
 *   - 主适配器必调：通过 primarySurfaceType 指定，或会话已绑定主适配器
 *   - 旁路适配器可选：通过 bypassSurfaceTypes 列出，逐个调用但不影响主流程
 *   - 同一引擎驱动多界面：主 + 旁路可同时消费同一 AgentRunResult 流
 */

/**
 * 表现层调度器
 */
export class SurfaceManager {
    /**
     * @param {object} [options]
     * @param {object} [options.logger]
     */
    constructor(options = {}) {
        /** @type {Map<string, object>} name -> adapter */
        this.adapters = new Map();
        /** 会话 -> 主适配器名（key: `${platform}:${chatId}`） */
        this.sessionPrimary = new Map();
        this.logger = options.logger || console;
    }

    /**
     * 注册表现层适配器。
     * @param {{name:string, surfaceType:string, render:Function}} adapter
     * @returns {() => void} 注销函数
     */
    register(adapter) {
        if (!adapter || typeof adapter !== 'object') {
            throw new Error('Surface 适配器必须为对象');
        }
        if (!adapter.name) {
            throw new Error('Surface 适配器必须有 name');
        }
        if (!adapter.surfaceType) {
            throw new Error(`Surface 适配器 "${adapter.name}" 必须声明 surfaceType`);
        }
        if (typeof adapter.render !== 'function') {
            throw new Error(`Surface 适配器 "${adapter.name}" 必须实现 render(agentRunResult, ctx)`);
        }
        this.adapters.set(adapter.name, adapter);
        this.logger.info?.(`[surface] 适配器已注册: ${adapter.name} (type=${adapter.surfaceType})`);
        // 返回注销函数，便于插件 onUnload 回收
        return () => {
            this.adapters.delete(adapter.name);
            // 同时清理会话绑定
            for (const [k, v] of this.sessionPrimary.entries()) {
                if (v === adapter.name) this.sessionPrimary.delete(k);
            }
        };
    }

    /**
     * 列出所有已注册适配器（只读快照）。
     * @returns {object[]}
     */
    getAdapters() {
        return [...this.adapters.values()].map(a => ({
            name: a.name,
            surfaceType: a.surfaceType,
        }));
    }

    /**
     * 为会话绑定主适配器（后续 dispatch 不传 primarySurfaceType 时使用）。
     * @param {string} sessionKey - 形如 "platform:chatId"
     * @param {string} adapterName
     */
    bindPrimary(sessionKey, adapterName) {
        if (!this.adapters.has(adapterName)) {
            throw new Error(`Surface 适配器不存在: ${adapterName}`);
        }
        this.sessionPrimary.set(sessionKey, adapterName);
    }

    /**
     * 解析会话 key。
     * @param {object} [ctx]
     * @returns {string|null}
     * @private
     */
    _sessionKey(ctx) {
        if (!ctx) return null;
        const platform = ctx.platform || ctx.message?.platform;
        const chatId = ctx.chatId || ctx.message?.chatId;
        if (!platform || !chatId) return null;
        return `${platform}:${chatId}`;
    }

    /**
     * 按 surfaceType 找首个适配器。
     * @param {string} type
     * @returns {object|null}
     * @private
     */
    _findBySurfaceType(type) {
        for (const a of this.adapters.values()) {
            if (a.surfaceType === type) return a;
        }
        return null;
    }

    /**
     * 按 surfaceType 找全部适配器。
     * @param {string} type
     * @returns {object[]}
     * @private
     */
    _findAllBySurfaceType(type) {
        const list = [];
        for (const a of this.adapters.values()) {
            if (a.surfaceType === type) list.push(a);
        }
        return list;
    }

    /**
     * 分发 AgentRunResult 到适配器渲染。
     *
     * @param {import('./run-result.js').AgentRunResult} agentRunResult
     * @param {object} [ctx] - 插件上下文（用于解析会话 key 与渲染）
     * @param {object} [options]
     * @param {string} [options.primarySurfaceType] - 主适配器类型（必调）
     * @param {string[]} [options.bypassSurfaceTypes] - 旁路适配器类型（可选，逐个调用）
     * @returns {Promise<Array<{adapter:string, kind:'primary'|'bypass', result?:any, error?:string}>>}
     */
    async dispatch(agentRunResult, ctx, options = {}) {
        const { primarySurfaceType, bypassSurfaceTypes = [] } = options;
        const results = [];

        // 解析主适配器：优先用 primarySurfaceType，否则查会话绑定
        let primary = null;
        if (primarySurfaceType) {
            primary = this._findBySurfaceType(primarySurfaceType);
            if (!primary) {
                this.logger.warn?.(`[surface] 未找到 surfaceType=${primarySurfaceType} 的主适配器，跳过主渲染`);
            }
        } else {
            const sessionKey = this._sessionKey(ctx);
            const boundName = sessionKey ? this.sessionPrimary.get(sessionKey) : null;
            if (boundName) primary = this.adapters.get(boundName) || null;
        }

        // 主适配器必调（即便失败也继续旁路）
        if (primary) {
            try {
                const r = await primary.render(agentRunResult, ctx);
                results.push({ adapter: primary.name, kind: 'primary', result: r });
            } catch (e) {
                this.logger.error?.(`[surface] 主适配器 "${primary.name}" 渲染失败: ${e.message}`);
                results.push({ adapter: primary.name, kind: 'primary', error: e.message });
            }
        }

        // 旁路适配器可选：逐个调用，互不影响
        for (const st of bypassSurfaceTypes) {
            const adapters = this._findAllBySurfaceType(st);
            for (const a of adapters) {
                if (a === primary) continue; // 避免重复调用
                try {
                    const r = await a.render(agentRunResult, ctx);
                    results.push({ adapter: a.name, kind: 'bypass', result: r });
                } catch (e) {
                    this.logger.warn?.(`[surface] 旁路适配器 "${a.name}" 渲染失败: ${e.message}`);
                    results.push({ adapter: a.name, kind: 'bypass', error: e.message });
                }
            }
        }

        return results;
    }
}

export default SurfaceManager;
