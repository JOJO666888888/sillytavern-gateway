/**
 * Agent 运行结果数据契约（表现层抽象）
 *
 * Agent 引擎一次 run 完成后产出 AgentRunResult，不再直接 ctx.reply(text)。
 * 表现层适配器（IM / ST / Native）消费此对象决定如何渲染。
 *
 * 字段对照（见 spec.md "Requirement: 表现层抽象"）：
 *   - artifacts: 正文 / 大纲 / 草稿等产物（markdown 文本 + 类型标签）
 *   - options:   可选的玩家行动选项（标签 + 文本 + 回调标识）
 *   - state:     本轮状态快照（visible 私有层 / private 私有层，按角色过滤）
 *   - events:    本轮事件流（工具调用 / 子代理 / 状态变更，用于时间线）
 *   - meta:      视角模式 / 当前文风 / 轮次 / 引用记忆
 */

/**
 * Agent 事件类型枚举。
 * 与 spec.md "AgentRunResult.events" 字段对齐：
 *   tool_call / subagent / state_change / checkpoint / draft / commit
 * @enum {string}
 */
export const AgentEventType = {
    TOOL_CALL: 'tool_call',
    SUBAGENT: 'subagent',
    STATE_CHANGE: 'state_change',
    CHECKPOINT: 'checkpoint',
    DRAFT: 'draft',
    COMMIT: 'commit',
};

/** 合法事件类型集合（用于校验） */
const VALID_EVENT_TYPES = new Set(Object.values(AgentEventType));

/**
 * 单个 Agent 事件（不可变值对象）。
 * 用于时间线重建与"幽灵事实"定位。
 */
export class AgentEvent {
    /**
     * @param {object} opts
     * @param {string} opts.type - 事件类型，见 AgentEventType
     * @param {object} [opts.payload] - 事件载荷
     * @param {number} [opts.seq] - 序号（由 AgentRunResult 维护递增）
     * @param {number} [opts.timestamp] - 时间戳（ms）
     */
    constructor({ type, payload, seq, timestamp } = {}) {
        if (!VALID_EVENT_TYPES.has(type)) {
            throw new Error(`非法 AgentEvent 类型: ${type}（合法值: ${[...VALID_EVENT_TYPES].join(', ')}）`);
        }
        this.type = type;
        this.payload = payload || {};
        this.seq = typeof seq === 'number' ? seq : 0;
        this.timestamp = typeof timestamp === 'number' ? timestamp : Date.now();
    }

    /** 工厂方法：构造一个事件（seq 由调用方维护） */
    static create(type, payload = {}, seq = 0) {
        return new AgentEvent({ type, payload, seq });
    }

    toJSON() {
        return {
            type: this.type,
            payload: this.payload,
            seq: this.seq,
            timestamp: this.timestamp,
        };
    }
}

/**
 * Agent 一次 run 的结构化输出契约。
 *
 * 不直接耦合 LLM 返回值：runner.run() 把 LLM 文本作为主 artifact 注入，
 * 工具循环过程中追加 events / state / options，最终交给 SurfaceManager 分发。
 */
export class AgentRunResult {
    /**
     * @param {object} [options]
     * @param {string} [options.runId]
     * @param {Array<{id?,type?,text}>} [options.artifacts]
     * @param {Array<{label,text,callbackId?}>} [options.options]
     * @param {{visible?:object, private?:object}} [options.state]
     * @param {Array<AgentEvent|object>} [options.events]
     * @param {{viewMode?,style?,turn?,referencedMemory?}} [options.meta]
     */
    constructor(options = {}) {
        this.runId = options.runId || '';
        this.artifacts = [];
        this.options = [];
        this.state = {
            visible: { ...(options.state?.visible || {}) },
            private: { ...(options.state?.private || {}) },
        };
        this.events = [];
        this.meta = {
            viewMode: options.meta?.viewMode || 'first',
            style: options.meta?.style || '',
            turn: options.meta?.turn || 0,
            referencedMemory: options.meta?.referencedMemory || '',
        };
        // 内部序号计数器，每次 addEvent 自增
        this._seq = 0;
        // 预置 artifacts / options / events
        for (const a of options.artifacts || []) this.addArtifact(a);
        for (const o of options.options || []) this.addOption(o);
        for (const e of options.events || []) this._importEvent(e);
    }

    /**
     * 从 runner.run() 原始文本结果构造 AgentRunResult。
     * 主文本作为 type='main' 的 artifact。
     * @param {string} text - 主输出文本
     * @param {number} [steps] - 工具步数（保留参数，便于日志）
     * @param {string} [runId]
     * @param {object} [meta]
     * @returns {AgentRunResult}
     */
    static fromRunResult(text, steps = 0, runId = '', meta = {}) {
        const result = new AgentRunResult({ runId, meta: { ...meta } });
        if (text) {
            result.addArtifact({ type: 'main', text });
        }
        return result;
    }

    /**
     * 追加产物。
     * @param {{id?,type?,text}} artifact
     * @returns {AgentRunResult}
     */
    addArtifact(artifact) {
        if (!artifact || typeof artifact !== 'object') return this;
        this.artifacts.push({
            id: artifact.id || `art-${this.artifacts.length + 1}`,
            type: artifact.type || 'main',
            text: typeof artifact.text === 'string' ? artifact.text : String(artifact.text ?? ''),
        });
        return this;
    }

    /**
     * 追加玩家行动选项。
     * @param {{label?,text?,callbackId?}} option
     * @returns {AgentRunResult}
     */
    addOption(option) {
        if (!option || typeof option !== 'object') return this;
        this.options.push({
            label: option.label || '',
            text: option.text || '',
            callbackId: option.callbackId || `cb-${this.options.length + 1}`,
        });
        return this;
    }

    /**
     * 追加事件（自动维护 seq 递增）。
     * @param {string} type - 见 AgentEventType
     * @param {object} [payload]
     * @returns {AgentEvent}
     */
    addEvent(type, payload = {}) {
        const seq = ++this._seq;
        const event = AgentEvent.create(type, payload, seq);
        this.events.push(event);
        return event;
    }

    /**
     * 状态快照更新（合并到 visible 或 private 层）。
     * @param {object} patch
     * @param {'visible'|'private'} [visibility]
     * @returns {AgentRunResult}
     */
    updateState(patch, visibility = 'visible') {
        if (visibility !== 'visible' && visibility !== 'private') return this;
        this.state[visibility] = { ...this.state[visibility], ...patch };
        return this;
    }

    /**
     * 设置 meta 字段（合并）。
     * @param {object} metaPatch
     * @returns {AgentRunResult}
     */
    updateMeta(metaPatch) {
        this.meta = { ...this.meta, ...metaPatch };
        return this;
    }

    /**
     * 获取主 artifact 文本（用于兼容旧 text 返回值）。
     * 优先返回 type='main' 的 artifact，否则取首个。
     * @returns {string}
     */
    getMainText() {
        const main = this.artifacts.find(a => a.type === 'main') || this.artifacts[0];
        return main?.text || '';
    }

    /**
     * 覆盖主 artifact 文本（P1-1：选项提取后正文需剔除选项行）。
     * 无 main artifact 时追加一个。
     * @param {string} text
     * @returns {AgentRunResult}
     */
    setMainText(text) {
        const main = this.artifacts.find(a => a.type === 'main');
        if (main) {
            main.text = typeof text === 'string' ? text : String(text ?? '');
        } else if (text) {
            this.addArtifact({ type: 'main', text });
        }
        return this;
    }

    /**
     * 内部：导入已有事件对象（保持 seq 自增）。
     * @param {AgentEvent|object} e
     * @private
     */
    _importEvent(e) {
        if (!e) return;
        // 允许传入 AgentEvent 实例或纯对象
        const type = e.type;
        if (!VALID_EVENT_TYPES.has(type)) return; // 静默丢弃非法事件
        const seq = ++this._seq;
        const ev = e instanceof AgentEvent
            ? new AgentEvent({ type: e.type, payload: e.payload, seq, timestamp: e.timestamp })
            : new AgentEvent({ type, payload: e.payload || {}, seq, timestamp: e.timestamp });
        this.events.push(ev);
    }

    toJSON() {
        return {
            runId: this.runId,
            artifacts: this.artifacts,
            options: this.options,
            state: this.state,
            events: this.events.map(e => e.toJSON()),
            meta: this.meta,
        };
    }
}

export default AgentRunResult;
