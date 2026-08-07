/**
 * ScriptEngine — 酒馆助手脚本执行引擎（服务端 Node vm 沙箱）
 *
 * 对标酒馆助手（Tavern-Helper / JS-Slash-Runner）的 iframe 脚本沙箱：
 *   - 脚本为原生 JavaScript，可调用全局 API（getChatMessages / triggerSlash / eventOn /
 *     getVariables / generateRaw / Mvu.* 等）与内置库 `_`（lodash）、`$`（最小 jQuery 桩）。
 *   - 执行环境为 Node vm 隔离沙箱：无 process/require/Buffer，API 白名单注入。
 *
 * 执行模型（服务端无状态，事件驱动）：
 *   每次执行 = ① 创建沙箱 → ② 运行脚本顶层代码（顶层 eventOn(...) 注册监听器）
 *   → ③ 若指定 eventType/buttonName，按注册顺序调用匹配的监听器。
 *   事件钩子由 agent-api 每轮对话后触发（MESSAGE_RECEIVED / GENERATION_ENDED /
 *   CHARACTER_LOADED 等），脚本以"每次事件重跑顶层+分发"的方式运行——对事件驱动型
 *   酒馆助手脚本（全自动总结等）行为等价，且无常驻沙箱、无内存泄漏。
 *
 * 依赖注入（deps）：
 *   - store:          ScriptStore 实例
 *   - getHistory(sk, char) → [{role, content}]
 *   - getStatData(sk, char) → object（MVU stat_data）
 *   - setStatData(sk, char, data) → void
 *   - getCharName(sk, char) → string
 *   - makeLlmClient(customCfg) → { generate(messages, opts) }
 *   - logger
 */

import vm from 'vm';
import { applyMvuToText } from './mvu-engine.js';

/** 单次执行超时（ms）：脚本死循环保护 */
const DEFAULT_TIMEOUT = 15000;

/**
 * 沙箱内置工具 `_`（对标酒馆助手脚本可用的 lodash）。
 * 自实现最小安全子集：get/set/unset 的路径键过滤 __proto__/constructor/prototype，
 * 防止脚本通过 _.set('constructor.prototype.x') 污染宿主原型。
 */
function buildSafeLodash() {
    const SAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    const isObj = (v) => v !== null && typeof v === 'object';
    const seg = (k) => (Array.isArray(k) ? k : String(k).split(/[.\[\]]/).filter(Boolean));
    const cleanKeys = (keys) => {
        const out = [];
        for (const k of keys) {
            if (SAFE_KEYS.has(String(k))) return null;
            out.push(String(k));
        }
        return out;
    };
    const clone = (v) => (isObj(v) ? JSON.parse(JSON.stringify(v)) : v);
    return {
        get: (o, path, def) => {
            const keys = cleanKeys(seg(path));
            if (!keys) return def;
            let cur = o;
            for (const k of keys) {
                if (!isObj(cur)) return def;
                cur = cur[k];
            }
            return cur === undefined ? def : cur;
        },
        set: (o, path, value) => {
            const keys = cleanKeys(seg(path));
            if (!keys || !isObj(o)) return o;
            let cur = o;
            for (let i = 0; i < keys.length - 1; i++) {
                const k = keys[i];
                if (!isObj(cur[k])) cur[k] = {};
                cur = cur[k];
            }
            cur[keys[keys.length - 1]] = value;
            return o;
        },
        unset: (o, path) => {
            const keys = cleanKeys(seg(path));
            if (!keys || !isObj(o)) return o;
            let cur = o;
            for (let i = 0; i < keys.length - 1; i++) {
                cur = cur[keys[i]];
                if (!isObj(cur)) return o;
            }
            delete cur[keys[keys.length - 1]];
            return o;
        },
        assign: (target, ...src) => Object.assign(target, ...src),
        cloneDeep: clone,
        clone,
        isEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
        forEach: (o, fn) => { if (Array.isArray(o)) o.forEach(fn); else if (isObj(o)) Object.keys(o).forEach((k) => fn(o[k], k)); },
        map: (o, fn) => (Array.isArray(o) ? o.map(fn) : Object.keys(o).map((k) => fn(o[k], k))),
        keys: (o) => (isObj(o) ? Object.keys(o) : []),
        merge: (target, src) => {
            if (!isObj(target) || !isObj(src)) return target;
            for (const k of Object.keys(src)) {
                if (SAFE_KEYS.has(k)) continue;
                if (isObj(src[k]) && isObj(target[k])) target[k] = buildSafeLodash().merge(target[k], src[k]);
                else target[k] = src[k];
            }
            return target;
        },
    };
}

/** 事件名常量（对标酒馆助手 tavern_events） */
export const SCRIPT_EVENTS = {
    GENERATION_STARTED: 'GENERATION_STARTED',
    STREAM_TOKEN_RECEIVED_FULLY: 'STREAM_TOKEN_RECEIVED_FULLY',
    STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'STREAM_TOKEN_RECEIVED_INCREMENTALLY',
    GENERATION_ENDED: 'GENERATION_ENDED',
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
    MESSAGE_UPDATED: 'MESSAGE_UPDATED',
    CHAT_CHANGED: 'CHAT_CHANGED',
    CHARACTER_LOADED: 'CHARACTER_LOADED',
    CHARACTER_EDITED: 'CHARACTER_EDITED',
    WORLD_INFO_ACTIVATED: 'WORLD_INFO_ACTIVATED',
};

/** 从角色卡提取酒馆助手脚本库（extensions.tavern_helper.scripts / variables，兼容旧字段） */
export function extractCardScripts(card) {
    const ext = card && card.extensions ? card.extensions : {};
    const th = ext.tavern_helper || {};
    const legacyScripts = ext.TavernHelper_scripts;
    const legacyVars = ext.TavernHelper_characterScriptVariables;
    const scripts = Array.isArray(th.scripts) ? th.scripts
        : (Array.isArray(legacyScripts) ? legacyScripts : []);
    const variables = (th.variables && typeof th.variables === 'object') ? th.variables
        : (legacyVars && typeof legacyVars === 'object' ? legacyVars : {});
    return { scripts, variables };
}

export class ScriptEngine {
    /**
     * @param {object} deps - 依赖注入（见文件头注释）
     */
    constructor(deps) {
        this.store = deps.store;
        this.deps = deps;
        // 全局共享对象（initializeGlobal / waitGlobalInitialized）
        this.globals = new Map();
    }

    // ==================== 启用脚本收集 ====================

    /**
     * 收集某会话当前生效的启用脚本（全局 + 当前角色），供事件分发。
     * @returns {Array<{scope:'global'|'character', character:string, script:object}>}
     */
    getEnabledScripts(sessionKey, character = '') {
        const out = [];
        for (const s of this.store.listScripts('global')) {
            if (s.enabled !== false) out.push({ scope: 'global', character: '', script: s });
        }
        if (character) {
            for (const s of this.store.listScripts('character', character)) {
                if (s.enabled !== false) out.push({ scope: 'character', character, script: s });
            }
        }
        return out;
    }

    /**
     * 角色卡加载/切换时调用：从卡内 tavern_helper 自动同步导入脚本与变量，
     * 并触发 CHARACTER_LOADED 事件。
     */
    syncFromCard({ sessionKey, character, card }) {
        if (!card || !character) return { imported: 0, updated: 0 };
        const { scripts, variables } = extractCardScripts(card);
        if (scripts.length) {
            this.store.importScripts('character', character, scripts);
        }
        if (variables && Object.keys(variables).length) {
            this.store.importVariables(character, variables);
        }
        // 触发角色加载事件（异步执行脚本，不阻塞）
        this.emitToSession({ sessionKey, character, eventType: SCRIPT_EVENTS.CHARACTER_LOADED, args: { character } });
        return { imported: scripts.length };
    }

    // ==================== 事件分发 ====================

    /**
     * 向会话所有启用脚本分发事件（每脚本独立沙箱执行）。
     */
    async emitToSession({ sessionKey, character = '', eventType, args = {} }) {
        const enabled = this.getEnabledScripts(sessionKey, character);
        const results = [];
        for (const item of enabled) {
            try {
                const r = await this.runScript({
                    sessionKey,
                    scope: item.scope,
                    character: item.character || character,
                    script: item.script,
                    eventType,
                    args,
                });
                results.push({ scriptId: item.script.id, name: item.script.name, ...r });
            } catch (e) {
                results.push({ scriptId: item.script.id, name: item.script.name, error: String(e && e.message || e) });
            }
        }
        return results;
    }

    // ==================== 核心执行 ====================

    /**
     * 执行单个脚本：顶层代码 + 事件分发。
     * @param {object} opts
     * @param {string} opts.sessionKey
     * @param {'global'|'character'} opts.scope
     * @param {string} [opts.character]
     * @param {object} opts.script - 脚本对象（含 content/name/id/data）
     * @param {string} [opts.eventType] - 分发的事件类型（如 MESSAGE_RECEIVED）
     * @param {string} [opts.buttonName] - 按钮触发（等价 eventType='th_button:<name>'）
     * @param {object} [opts.args] - 事件参数
     * @returns {Promise<{ok:boolean, result:any, logs:string[], error:string|null, eventsFired:string[]}>}
     */
    async runScript({ sessionKey, scope = 'global', character = '', script, eventType, buttonName, args = {} }) {
        const ctx = this._buildContext({ sessionKey, scope, character, script, args });
        const target = buttonName ? `th_button:${buttonName}` : eventType;
        const logs = [];
        let error = null;
        let result = null;

        try {
            // ① 顶层代码（双保险超时）：包成 async IIFE 支持脚本顶层 await；
            //    vm timeout 拦截同步死循环（如 while(true)），_withTimeout 兜底异步挂起。
            await this._withTimeout(async () => {
                const runner = vm.runInContext(
                    `(async () => {\n${script.content || ''}\n})()`,
                    ctx.vm,
                    {
                        filename: `th-script--${script.name || 'anonymous'}--${script.id || ''}.js`,
                        timeout: this.deps.timeoutMs || DEFAULT_TIMEOUT,
                    },
                );
                if (runner && typeof runner.then === 'function') await runner;
            }, '脚本顶层执行超时');
            logs.push(...ctx.logs);
            // ② 事件分发
            const eventsFired = [];
            if (target) {
                const listeners = (ctx.events.get(target) || []).slice();
                const listenerArgs = Array.isArray(args) ? args : [args];
                for (const ln of listeners) {
                    try {
                        await this._withTimeout(async () => { await ln(...listenerArgs); }, `监听器 ${target} 执行超时`);
                        eventsFired.push(target);
                    } catch (e) {
                        logs.push(`[listener:${target}] ${e && e.message || e}`);
                    }
                }
            }
            result = ctx.pipe;
            return { ok: true, result, logs, error: null, eventsFired };
        } catch (e) {
            error = String(e && e.message || e);
            // 失败/超时也保留脚本已产生的 console 输出（便于调试）
            if (ctx && ctx.logs) logs.push(...ctx.logs);
            logs.push(`[error] ${error}`);
            return { ok: false, result, logs, error, eventsFired: [] };
        } finally {
            // 清理脚本注册的受控定时器（防 interval 常驻 DoS / 句柄泄漏）；
            // 脚本为"每事件重跑"模型，跨事件定时任务无意义。
            if (ctx && ctx.timers) {
                for (const t of ctx.timers) { try { clearTimeout(t); } catch (_) { /* 忽略 */ } }
                ctx.timers.clear();
            }
        }
    }

    _withTimeout(fn, msg) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(msg)), this.deps.timeoutMs || DEFAULT_TIMEOUT);
            Promise.resolve().then(fn).then(
                (v) => { clearTimeout(timer); resolve(v); },
                (e) => { clearTimeout(timer); reject(e); },
            );
        });
    }

    /**
     * 构建沙箱上下文（注入酒馆助手兼容 API）。
     * @private
     */
    _buildContext({ sessionKey, scope, character = '', script, args }) {
        const deps = this.deps;
        const store = this.store;
        const events = new Map(); // eventType -> listener[]
        const logs = [];
        const log = (level, ...msg) => logs.push(`[${level}] ${msg.join(' ')}`);
        const self = this;

        // 会话数据访问器（读当前真实数据）
        const history = () => deps.getHistory(sessionKey, character) || [];
        const statData = () => deps.getStatData(sessionKey, character) || {};
        const setStat = (data) => { try { deps.setStatData(sessionKey, character, data); } catch (e) { log('warn', `setStatData 失败: ${e.message}`); } };
        const charName = () => deps.getCharName ? deps.getCharName(sessionKey, character) : (character || '');
        const userName = () => (deps.getUserName ? deps.getUserName(sessionKey) : 'User') || 'User';

        // 受控定时器：记录句柄，脚本执行结束（finally）统一清理，防 interval 常驻 DoS / 句柄泄漏
        const timers = new Set();
        const safeSetTimeout = (fn, ms) => { const t = setTimeout(fn, Math.max(0, Number(ms) || 0)); timers.add(t); return t; };
        const safeSetInterval = (fn, ms) => { const t = setInterval(fn, Math.max(0, Number(ms) || 0)); timers.add(t); return t; };
        const safeClearTimeout = (t) => { timers.delete(t); clearTimeout(t); };
        const safeClearInterval = (t) => { timers.delete(t); clearInterval(t); };

        // ---------- 消息（楼层）API ----------
        function toStMessage(item, idx) {
            const role = item.role || 'assistant';
            return {
                message_id: idx,
                role: role === 'user' ? 'user' : role === 'system' ? 'system' : 'char',
                name: role === 'user' ? userName() : (role === 'system' ? 'System' : charName()),
                is_user: role === 'user',
                is_system: role === 'system',
                message: item.content || '',
                data: {},
                extra: {},
            };
        }

        function resolveRange(range, maxIdx) {
            if (typeof range === 'number') {
                // 酒馆助手语义：正负整数均表示"最近 |range| 条"（-1 = 最新 1 条）
                const n = Math.max(0, Math.min(maxIdx + 1, Math.abs(range)));
                return { from: maxIdx + 1 - n, to: maxIdx };
            }
            if (typeof range === 'string') {
                const r = String(range).replace(/{{lastMessageId}}/g, String(maxIdx));
                const m = r.match(/^(-?\d+)-(\d+)$/);
                if (m) return { from: Math.max(0, Number(m[1])), to: Number(m[2]) };
                // 开放区间：'N-' = 从第 N 条到末尾（STscript 语义）
                const open = r.match(/^(\d+)-$/);
                if (open) return { from: Math.max(0, Number(open[1])), to: maxIdx };
                const neg = r.match(/^-(\d+)$/);
                if (neg) { const n = Math.min(maxIdx + 1, Number(neg[1])); return { from: maxIdx + 1 - n, to: maxIdx }; }
                const single = r.match(/^(\d+)$/);
                if (single) { const i = Number(single[1]); return { from: i, to: i }; }
            }
            return { from: 0, to: maxIdx };
        }

        function getChatMessages(range = -1, option) {
            const h = history();
            const maxIdx = h.length - 1;
            if (maxIdx < 0) return [];
            const { from, to } = resolveRange(range, maxIdx);
            const out = [];
            for (let i = from; i <= to && i < h.length; i++) out.push(toStMessage(h[i], i));
            return out;
        }

        function getLastMessageId() {
            return Math.max(-1, history().length - 1);
        }

        function setChatMessages(updates = [], opt) {
            // 对标酒馆助手：按 message_id 修改楼层字段（message/name/data/extra）
            const h = history();
            for (const u of updates) {
                const idx = Number(u && u.message_id);
                if (!Number.isInteger(idx) || idx < 0 || idx >= h.length) continue;
                const item = h[idx];
                if (u.message !== undefined) item.content = String(u.message);
                if (u.name !== undefined) item.name = String(u.name);
                if (u.data !== undefined) item.data = u.data;
            }
            setStat(statData()); // 触发写回（历史已在引用上修改，deps 侧读取同一数组引用）
            return Promise.resolve();
        }

        function deleteChatMessages(ids = [], opt) {
            const h = history();
            const idSet = new Set(ids.map(Number));
            const kept = h.filter((_, i) => !idSet.has(i));
            kept.splice(0, h.length, ...kept); // 原地修改
            return Promise.resolve();
        }

        // ---------- 变量 API（对标酒馆助手 getVariables 等） ----------
        function varBucket(type) {
            switch (type) {
                case 'character': return { get: () => store.getVariables('character', character), set: (v) => store.setVariables('character', character, v) };
                case 'chat': return { get: statData, set: setStat };
                case 'script': return { get: () => (script.data || {}), set: (v) => { script.data = v; } };
                case 'global':
                case 'extension':
                default: return { get: () => store.getVariables('global'), set: (v) => store.setVariables('global', '', v) };
            }
        }

        function getVariables({ type = 'chat' } = {}) {
            // 返回深拷贝：防止脚本直接改动共享引用绕过 replaceVariables（MVU 变更追踪/广播会失步）
            try {
                return JSON.parse(JSON.stringify(varBucket(type).get() || {}));
            } catch (e) {
                return {};
            }
        }

        function replaceVariables(vars, { type = 'chat' } = {}) {
            const b = varBucket(type);
            b.set(vars && typeof vars === 'object' ? { ...vars } : {});
        }

        function updateVariablesWith(updater, { type = 'chat' } = {}) {
            const b = varBucket(type);
            const cur = b.get();
            const next = typeof updater === 'function' ? updater(cur) : updater;
            if (next && typeof next === 'object') b.set(next);
        }

        function insertOrAssignVariables(vars, { type = 'chat' } = {}) {
            const b = varBucket(type);
            const cur = b.get() || {};
            for (const [k, v] of Object.entries(vars || {})) _.set(cur, k, v);
            b.set(cur);
        }

        function insertVariables(vars, { type = 'chat' } = {}) {
            const b = varBucket(type);
            const cur = b.get() || {};
            for (const [k, v] of Object.entries(vars || {})) {
                if (_.get(cur, k) === undefined) _.set(cur, k, v);
            }
            b.set(cur);
        }

        function deleteVariable(path, { type = 'chat' } = {}) {
            const b = varBucket(type);
            const cur = b.get() || {};
            const keys = Array.isArray(path) ? path : String(path).split(/[.，、/]/).filter(Boolean);
            const before = _.get(cur, keys);
            _.unset(cur, keys);
            b.set(cur);
            return { variables: cur, delete_occurred: before !== undefined };
        }

        // ---------- Mvu（外部 MVU 框架桥） ----------
        const Mvu = {
            getMvuData({ type = 'chat', message_id } = {}) {
                if (type === 'character') return { initialized_lorebooks: [], stat_data: store.getVariables('character', character) };
                if (type === 'global') return { initialized_lorebooks: [], stat_data: store.getVariables('global') };
                return { initialized_lorebooks: [], stat_data: statData() };
            },
            replaceMvuData(data, { type = 'chat' } = {}) {
                const stat = data && typeof data.stat_data === 'object' ? data.stat_data : (data || {});
                if (type === 'character') store.setVariables('character', character, stat);
                else if (type === 'global') store.setVariables('global', '', stat);
                else setStat(stat);
                return Promise.resolve();
            },
            parseMessage(text, old_data) {
                const base = old_data && typeof old_data.stat_data === 'object' ? old_data.stat_data : (old_data || {});
                const r = applyMvuToText(text || '', base);
                return { initialized_lorebooks: [], stat_data: r.snapshot };
            },
            isDuringExtraAnalysis: () => false,
            events: {
                VARIABLE_INITIALIZED: 'Mvu.VARIABLE_INITIALIZED',
                VARIABLE_UPDATE_STARTED: 'Mvu.VARIABLE_UPDATE_STARTED',
                COMMAND_PARSED: 'Mvu.COMMAND_PARSED',
                VARIABLE_UPDATE_ENDED: 'Mvu.VARIABLE_UPDATE_ENDED',
                BEFORE_MESSAGE_UPDATE: 'Mvu.BEFORE_MESSAGE_UPDATE',
            },
        };

        // ---------- 事件 API（对标酒馆助手 eventOn 等） ----------
        function eventOn(type, listener) {
            if (typeof listener !== 'function') return { stop: () => {} };
            if (!events.has(type)) events.set(type, []);
            const list = events.get(type);
            list.push(listener);
            return { stop: () => { const i = list.indexOf(listener); if (i >= 0) list.splice(i, 1); } };
        }
        function eventOnce(type, listener) {
            const wrapped = (...a) => { stop(); return listener(...a); };
            const { stop } = eventOn(type, wrapped);
            return { stop };
        }
        async function eventEmit(type, ...data) {
            const list = events.get(type) || [];
            for (const ln of list.slice()) await ln(...data);
        }
        function eventRemoveListener(type, listener) {
            const list = events.get(type);
            if (list) { const i = list.indexOf(listener); if (i >= 0) list.splice(i, 1); }
        }
        function eventClearAll() { events.clear(); }

        // ---------- 脚本自管 API ----------
        function getScriptTrees({ type } = {}) {
            const scope = type === 'character' ? 'character' : 'global';
            const sc = type === 'character' ? character : '';
            return store.listScripts(scope, sc);
        }
        function getScriptName() { return script.name || ''; }
        function getScriptInfo() { return script.info || ''; }
        function replaceScriptInfo(info) { script.info = String(info || ''); }
        function getScriptButtons() {
            const b = script.button && script.button.buttons ? script.button.buttons : [];
            return b;
        }
        function replaceScriptButtons(buttons = []) {
            script.button = { enabled: true, buttons: buttons.map((x) => ({ name: String(x && x.name || ''), visible: x && x.visible !== false })) };
        }
        function appendInexistentScriptButtons(buttons = []) {
            const exist = new Set(getScriptButtons().map((b) => b.name));
            for (const x of buttons) {
                const n = String(x && x.name || '');
                if (n && !exist.has(n)) { exist.add(n); script.button.buttons.push({ name: n, visible: true }); }
            }
        }
        function getButtonEvent(name) { return `th_button:${String(name || '')}`; }
        function getAllEnabledScriptButtons() {
            const out = {};
            for (const item of self.getEnabledScripts(sessionKey, character)) {
                const s = item.script;
                if (s.enabled !== false && s.button && Array.isArray(s.button.buttons)) {
                    out[s.id] = s.button.buttons.filter((b) => b.visible !== false).map((b) => ({ button_id: b.name, button_name: b.name }));
                }
            }
            return out;
        }

        // ---------- AI 生成 API ----------
        async function _generateInner(messages, cfg) {
            const client = deps.makeLlmClient ? deps.makeLlmClient(cfg && cfg.custom_api) : null;
            if (!client || typeof client.generate !== 'function') {
                throw new Error('LLM 客户端不可用（generateRaw 需要 llm 服务）');
            }
            return client.generate(messages, {
                max_tokens: (cfg && cfg.max_tokens) || 2048,
                temperature: (cfg && cfg.temperature) || 0.7,
            });
        }
        async function generate(config = {}) {
            const messages = [];
            const sys = config.overrides && config.overrides.character_name ? `你是${config.overrides.character_name}。` : '你是角色扮演助手。';
            messages.push({ role: 'system', content: sys });
            if (config.user_input) messages.push({ role: 'user', content: String(config.user_input) });
            return _generateInner(messages, config);
        }
        async function generateRaw(config = {}) {
            const prompts = Array.isArray(config.ordered_prompts) ? config.ordered_prompts : [];
            const messages = prompts.map((p) => {
                const role = p.role === 'user' || p.role === 'assistant' ? p.role : 'user';
                return { role, content: p.content || '' };
            });
            if (!messages.length && config.user_input) messages.push({ role: 'user', content: String(config.user_input) });
            return _generateInner(messages, config);
        }
        function stopGenerationById() { return Promise.resolve(); }
        function stopAllGeneration() { return Promise.resolve(); }
        function getModelList() { return []; }
        function getProxyPresetNames() { return []; }

        // ---------- Slash 命令（最小实现） ----------
        async function triggerSlash(command) {
            const parts = String(command || '').split('|').map((s) => s.trim()).filter(Boolean);
            let pipe = '';
            for (const part of parts) {
                const m = part.match(/^\/(\w+)\s*([\s\S]*)$/);
                if (!m) { pipe = part; continue; }
                const cmd = m[1].toLowerCase();
                let arg = (m[2] || '').replace(/{{pipe}}/g, pipe);
                switch (cmd) {
                    case 'pass': pipe = arg; break;
                    case 'echo': {
                        if (arg) pipe = arg; // 无参数时保留 pipe（酒馆助手语义）
                        log('script', `[echo] ${arg || pipe}`);
                        break;
                    }
                    case 'wait': { const ms = Number(arg) || 0; await new Promise((r) => setTimeout(r, ms)); break; }
                    case 'getvar': {
                        const p = arg.trim();
                        const b = varBucket('chat');
                        pipe = p ? String(_.get(b.get(), p, '') ?? '') : '';
                        break;
                    }
                    case 'setvar': {
                        const eq = arg.match(/^([^=]+?)\s*=\s*([\s\S]*)$/);
                        if (eq) { const b = varBucket('chat'); const cur = b.get() || {}; _.set(cur, eq[1].trim(), eq[2]); b.set(cur); }
                        break;
                    }
                    default:
                        throw new Error(`slash 命令 /${cmd} 在 Agent 剧场沙箱中未实现`);
                }
            }
            return pipe;
        }

        // ---------- 工具 API ----------
        function errorCatched(fn) {
            try { return fn(); } catch (e) { log('error', `errorCatched: ${e && e.message || e}`); return undefined; }
        }
        function substitudeMacros(text) {
            return String(text || '')
                .replace(/{{char}}/g, charName())
                .replace(/{{user}}/g, userName())
                .replace(/{{lastMessageId}}/g, String(getLastMessageId()))
                .replace(/{{time}}/g, new Date().toLocaleTimeString())
                .replace(/{{date}}/g, new Date().toLocaleDateString());
        }
        function reloadIframe() { /* no-op */ }
        function getIframeName() { return `TH-script--${script.name || ''}--${script.id || ''}`; }
        function getScriptId() { return script.id || ''; }
        function getCurrentMessageId() { return Math.max(-1, history().length - 1); }
        function getMessageId(iframeName) { return -1; }

        // ---------- 全局共享 ----------
        function initializeGlobal(name, value) { self.globals.set(name, value); }
        function waitGlobalInitialized(name) {
            const v = self.globals.get(name);
            if (v !== undefined) return Promise.resolve(v);
            return new Promise((resolve, reject) => {
                const iv = safeSetInterval(() => {
                    const cur = self.globals.get(name);
                    if (cur !== undefined) { safeClearInterval(iv); safeClearTimeout(to); resolve(cur); }
                }, 50);
                const to = safeSetTimeout(() => { safeClearInterval(iv); reject(new Error(`等待全局 ${name} 超时`)); }, 10000);
            });
        }

        // ---------- jQuery 最小桩 ----------
        function jqStub(sel) {
            if (typeof sel === 'function') { try { sel(); } catch (e) { log('warn', `$(() => …) 回调异常: ${e.message}`); } return jqStub; }
            if (typeof sel === 'object' && sel && sel.on && typeof sel.on === 'function') return jqStub;
            return jqStub;
        }
        jqStub.on = (ev, fn) => { if (ev === 'pagehide') { /* 服务端无页面卸载钩子 */ } return jqStub; };
        jqStub.off = () => jqStub;
        jqStub.ready = (fn) => { try { fn(); } catch (e) { log('warn', `$(document).ready 回调异常: ${e.message}`); } return jqStub; };
        jqStub.ajax = () => Promise.reject(new Error('$.ajax 在服务端沙箱不可用'));
        jqStub.getJSON = () => Promise.reject(new Error('$.getJSON 在服务端沙箱不可用'));

        // ---------- 沙箱对象 ----------
        // 安全设计（对标"可信脚本"模型，与酒馆助手 iframe 同源执行一致）：
        //   - 不注入宿主构造器（Object/Array/.../JSON/Promise 等由 vm context 自建 vm realm 内建，
        //     降低 vm 逃逸面；不设置 self/window/top 指向宿主 sandbox）
        //   - `_` 用自实现安全子集（路径过滤危险键，防原型污染）
        //   - 定时器用受控版本（finally 统一清理）
        //   - window/globalThis 指向"安全全局桩"（Object.create(null)，无构造器链、无敏感 API）
        const safeGlobal = Object.create(null);
        const sandbox = {
            console: {
                log: (...a) => log('script', a.join(' ')),
                info: (...a) => log('script', a.join(' ')),
                warn: (...a) => log('warn', a.join(' ')),
                error: (...a) => log('error', a.join(' ')),
            },
            _: buildSafeLodash(),
            $: jqStub,
            jQuery: jqStub,
            setTimeout: safeSetTimeout,
            clearTimeout: safeClearTimeout,
            setInterval: safeSetInterval,
            clearInterval: safeClearInterval,
            window: safeGlobal,
            globalThis: safeGlobal,
            self: safeGlobal,
            top: safeGlobal,
            // 酒馆助手脚本 API
            getChatMessages, getLastMessageId, setChatMessages, deleteChatMessages, getCurrentMessageId, getMessageId,
            getVariables, replaceVariables, updateVariablesWith, insertOrAssignVariables, insertVariables, deleteVariable,
            Mvu,
            eventOn, eventOnce, eventEmit, eventRemoveListener, eventClearAll,
            getScriptTrees, getScriptName, getScriptInfo, replaceScriptInfo,
            getScriptButtons, replaceScriptButtons, appendInexistentScriptButtons, getButtonEvent, getAllEnabledScriptButtons,
            generate, generateRaw, stopGenerationById, stopAllGeneration, getModelList, getProxyPresetNames,
            triggerSlash,
            errorCatched, substitudeMacros, reloadIframe, getIframeName, getScriptId,
            initializeGlobal, waitGlobalInitialized,
            tavern_events: SCRIPT_EVENTS,
            // 内部（引擎分发用，脚本不应依赖）
            __pipe: '',
        };
        safeGlobal.on = () => safeGlobal;
        safeGlobal.off = () => safeGlobal;
        safeGlobal.addEventListener = () => safeGlobal;
        safeGlobal.removeEventListener = () => safeGlobal;

        const vmCtx = vm.createContext(sandbox);
        // 记录 pipe 引用（result 返回值）
        Object.defineProperty(sandbox, '__setPipe', {
            value: (v) => { sandbox.__pipe = v; },
            enumerable: false,
        });

        return {
            vm: vmCtx,
            events,
            logs,
            timers,
            get pipe() { return sandbox.__pipe; },
        };
    }
}
