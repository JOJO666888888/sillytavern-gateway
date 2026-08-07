/**
 * Agent 独立 API 路由注册（Agent 服务独立化部署）
 *
 * 把 Agent 相关 REST/SSE 路由抽成可复用模块，主网关（server/index.js）与
 * 独立 Agent 服务（server/agent-server.js）共用同一实现，保证行为一致。
 *
 * 包含路由：
 *   - GET/POST/DELETE /api/agents*        Agent 框架管理（列表/工具/日志/增删/运行提示/模板复制）
 *   - GET  /api/agent-theatre/stream      SSE 订阅 AgentRunResult 流
 *   - POST /api/agent-theatre/input       Agent 剧场输入（触发 ctx.agent.run，含 P0 rerun + P2 run_state 广播）
 *   - POST /api/agent-theatre/abort       P2 中止当前 run
 *   - POST /api/agent-theatre/validate-run   保存 Profile 并验证可运行性
 *   - GET  /api/agent-theatre/events/:runId  查询历史事件（workspaceManager.getEvents）
 *   - GET  /api/agent-theatre/state       当前会话状态回显
 *   - GET/POST /api/agent-theatre/chats*  聊天记录存储（列表/读取/保存/加载/删除/迁移/清空会话）
 *   - POST/GET /api/agent-theatre/ai-modify/*   AI 辅助修改 Profile（plan/apply/undo/history）
 *   - POST /api/agent-frontend/validate   Agent 前端 URL 校验
 *   - express.static + GET /agent         Agent 自定义前端静态页面（public/）
 *
 * 依赖注入（deps）：
 *   - getPluginManager()   -> () => pluginManager 或 null（运行时动态取值）
 *   - getLlmService()      -> () => llmService 或 null（运行时动态取值）
 *   - theatreBroadcaster   -> TheatreBroadcaster 实例（SSE 广播）
 *   - configManager        -> 配置管理器
 *   - logger               -> 日志器
 *   - repoRoot             -> 仓库根目录绝对路径
 *   - staticDir            -> public 静态目录绝对路径
 *
 * 本模块内部维护（ESM 单例，主服务与独立服务各自是独立进程，互不共享）：
 *   - theatreSessions：Agent 剧场会话状态 Map（面板级临时状态，进程重启后丢失）
 *   - aiModifyHistory：AI 辅助修改的快照历史 Map
 *   - getReadyAgentFramework / getAgentService / _theatreSessionKey 辅助函数
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createAiModifierHandlers, createProfileStore } from './ai-modifier.js';
import { createAgentFrontendValidateHandler } from './agent-frontend.js';
import { LLMClient } from './runtime/llm-client.js';
import {
    initRegexStore,
    getRegexStore,
    getRegexedString,
    importRegexFromCard,
    validateRegex,
    REGEX_PLACEMENT,
} from './agent/regex-engine.js';
import {
    DEFAULT_DATA_ROOT,
    saveChat,
    listChats,
    readChat,
    deleteChats,
    migrateLegacy,
    createArchive,
    updateArchiveMeta,
} from './runtime/chat-store.js';
import { applyMvuToText, stripForDisplay, applyCommands } from './agent/mvu-engine.js';
import {
    runVariableProcessor,
    runChronicleProcessor,
    extractInitVariables,
    extractUpdateRules,
} from './agent/st-processors.js';
import { ScriptStore, toExportableScript } from './agent/script-store.js';
import { ScriptEngine, SCRIPT_EVENTS, extractCardScripts } from './agent/script-engine.js';
import { userProfileStore } from './runtime/user-profile-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 聊天记录自动保存默认间隔（ms）：5 分钟，可通过 runtime.agentChatAutoSaveInterval 配置 */
const DEFAULT_AUTO_SAVE_INTERVAL = 300000;

/** 当前会话存档数据根目录（registerAgentApi 时初始化，供 /input 切换保存与定时自动保存使用） */
let activeChatDataRoot = DEFAULT_DATA_ROOT;
/** 当前 SSE 广播器实例（定时自动保存成功后广播 save_state 用） */
let activeTheatreBroadcaster = null;
/** 定时自动保存计时器（模块级句柄，便于测试启动/停止并清理） */
let chatAutoSaveTimer = null;
/** 当前自动保存间隔（ms，模块级存储便于测试读取） */
let chatAutoSaveIntervalMs = DEFAULT_AUTO_SAVE_INTERVAL;

/**
 * 启动聊天记录定时自动保存（幂等：已启动则先停再启）。
 * 每轮遍历 theatreSessions，对 dirty 会话执行覆盖式 saveChat，
 * 成功则清除 dirty 并广播 save_state=saved，失败广播 save_state=save_failed。
 * interval 通过 unref() 不阻止进程退出（node --test 不会挂住）。
 * @param {number} [intervalMs] - 轮询间隔（ms）
 * @returns {NodeJS.Timeout}
 */
export function startChatAutoSave(intervalMs = DEFAULT_AUTO_SAVE_INTERVAL) {
    stopChatAutoSave();
    chatAutoSaveIntervalMs = intervalMs;
    chatAutoSaveTimer = setInterval(() => {
        for (const [sessionKey, sess] of theatreSessions) {
            if (!sess) continue;
            // P4-1: 自动保存按"当前角色卡槽"保存（每张卡独立归档）
            const cs = charState(sess, sess.character || '');
            if (!cs.dirty) continue;
            const result = saveChat(activeChatDataRoot, {
                character: sess.character || '',
                messages: cs.history || [],
                userName: sess.userName || 'User',
                prevFile: cs.chatFile || undefined,
            });
            if (result.ok) {
                cs.dirty = false;
                cs.savedAt = result.savedAt;
                cs.lastSavedAt = Date.now();
                cs.chatFile = result.file;
                if (activeTheatreBroadcaster && typeof activeTheatreBroadcaster.broadcastSaveState === 'function') {
                    activeTheatreBroadcaster.broadcastSaveState(sessionKey, { state: 'saved', savedAt: result.savedAt });
                }
            } else if (activeTheatreBroadcaster && typeof activeTheatreBroadcaster.broadcastSaveState === 'function') {
                activeTheatreBroadcaster.broadcastSaveState(sessionKey, { state: 'save_failed', savedAt: null, error: result.error || '保存失败' });
            }
        }
    }, intervalMs);
    if (chatAutoSaveTimer.unref) chatAutoSaveTimer.unref();
    return chatAutoSaveTimer;
}

/** 停止定时自动保存（测试进程退出前清理） */
export function stopChatAutoSave() {
    if (chatAutoSaveTimer) {
        clearInterval(chatAutoSaveTimer);
        chatAutoSaveTimer = null;
    }
}

/** 读取当前自动保存间隔（ms），供测试断言配置生效 */
export function getChatAutoSaveInterval() {
    return chatAutoSaveIntervalMs;
}

/** AI 辅助修改的快照历史：profileName -> [yamlSnapshot, ...]（最多保留 MAX_HISTORY 步） */
const aiModifyHistory = new Map();

/**
 * Agent 剧场会话状态（按 sessionKey 维护），用于 /state 端点回显当前会话状态。
 * 注意：这是面板级临时状态，进程重启后丢失；权威状态在 workspace 与 sessions 目录。
 * @type {Map<string, {profile:string, chars?:Object<string,object>, lastRunId?:string, lastResult?:object, turn:number}>}
 */
const theatreSessions = new Map();

/**
 * 生成消息稳定 ID（编辑/删除定位用）。
 * 格式: <prefix>_<时间戳36进制>_<随机4字符>，同一进程内唯一即可。
 * 历史消息可能来自存档（无 id），读取时补发；运行中消息由 /input 分配。
 */
export function makeMsgId(prefix = 'm') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 确保消息对象带稳定 id；无 id（旧存档/旧代码 push）时补发。 */
function ensureMsgId(msg, role) {
    if (!msg || typeof msg !== 'object') return msg;
    if (!msg.id) msg.id = makeMsgId(role === 'user' ? 'u' : role === 'assistant' ? 'a' : 'm');
    return msg;
}

/** 按 messageId 或 messageIndex 定位消息，返回 { index, msg }；找不到返回 null。 */
function locateMessage(cs, messageId, messageIndex) {
    if (typeof messageId === 'string' && messageId.length > 0) {
        const i = cs.history.findIndex(m => m && m.id === messageId);
        if (i >= 0) return { index: i, msg: cs.history[i] };
        return null;
    }
    const idx = Number(messageIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cs.history.length) return null;
    return { index: idx, msg: cs.history[idx] };
}

/**
 * 会话内按角色卡隔离的运行时状态（P4-1 修复：角色卡切换上下文隔离）。
 *
 * 背景：此前 sess.history 是会话级共享的，切换角色卡只改 sess.character、
 * 不清空也不隔离 history，导致新角色卡首轮把旧卡的历史 AI 回复/用户输入全部
 * 注入 LLM 上下文，且旧卡开场白因"history 非空"被抑制——上下文严重污染。
 *
 * 本函数在同一个 sessionKey（面板会话）下为每张角色卡维护独立的子状态：
 *   { history, turn, lastInput, lastRunId, lastResult, greetingIndex,
 *     dirty, chatFile, savedAt, lastSavedAt }
 * 切换角色 = 读写不同卡槽，天然隔离；切回旧卡时其历史/回合/选项回调可恢复。
 *
 * 兼容：对升级前的旧会话（sess.history 在会话级），首次调用时迁移到旧角色卡槽，
 * 避免历史丢失。
 *
 * @param {object} sess - 会话对象
 * @param {string} character - 角色卡名（'' = 未绑定角色卡）
 * @returns {object} 该角色卡的子状态对象（不存在则创建）
 */
export function charState(sess, character) {
    const key = character || '';
    if (!sess.chars) {
        // 旧版会话迁移：把会话级 history 归入旧角色槽
        sess.chars = {};
        if (Array.isArray(sess.history) && sess.history.length > 0) {
            const legacy = sess.character || '';
            sess.chars[legacy] = {
                history: sess.history,
                turn: sess.turn || 0,
                lastInput: sess.lastInput || '',
                lastRunId: sess.lastRunId || null,
                lastResult: sess.lastResult || null,
                greetingIndex: sess.greetingIndex || 0,
                dirty: !!sess.dirty,
                chatFile: sess.chatFile || null,
                savedAt: sess.savedAt || null,
                lastSavedAt: sess.lastSavedAt || null,
                // ST 兼容（P0）：MVU stat_data 快照（该角色卡的变量状态）
                mvu: sess.mvu || { stat_data: {} },
            };
        }
    }
    if (!sess.chars[key]) {
        sess.chars[key] = {
            history: [], turn: 0, lastInput: '', lastRunId: null, lastResult: null,
            greetingIndex: 0, dirty: false, chatFile: null, savedAt: null, lastSavedAt: null,
            mvu: { stat_data: {} },
        };
    }
    return sess.chars[key];
}

/**
 * 注册 Agent 相关 API 到 Express app（主网关与独立 Agent 服务共用）。
 *
 * @param {import('express').Express} app
 * @param {object} deps - 依赖注入（见文件头注释）
 */
export function registerAgentApi(app, deps) {
    const {
        getPluginManager,
        getLlmService,
        theatreBroadcaster,
        configManager,
        logger,
        repoRoot,
        staticDir,
        // R1: 处理器客户端工厂（测试注入 mock；生产不传则用默认 buildProcessorClient）
        processorClientFactory,
    } = deps;

    // 初始化聊天存档数据根目录与广播器（供 /input 切换保存、定时自动保存使用）
    activeChatDataRoot = deps.chatDataRoot || DEFAULT_DATA_ROOT;
    if (theatreBroadcaster) activeTheatreBroadcaster = theatreBroadcaster;
    // 用户自定义档案存储：测试可注入隔离实例，默认用共享单例（data/user-profile.json）
    const userProfile = deps.userProfileStore || userProfileStore;

    // ==================== 脚本库（对标酒馆助手 Tavern-Helper） ====================
    // 存储 data/agent-scripts.json（全局/角色脚本库）+ Node vm 沙箱执行 + 事件总线。
    const scriptStore = deps.scriptStore || new ScriptStore(activeChatDataRoot);
    const scriptEngine = deps.scriptEngine || new ScriptEngine({
        store: scriptStore,
        getHistory: (sk, character) => {
            const s = theatreSessions.get(sk);
            return s ? (charState(s, character || s.character || '').history || []) : [];
        },
        getStatData: (sk, character) => {
            const s = theatreSessions.get(sk);
            return s ? (charState(s, character || s.character || '').mvu?.stat_data || {}) : {};
        },
        setStatData: (sk, character, data) => {
            const s = theatreSessions.get(sk);
            if (s) charState(s, character || s.character || '').mvu.stat_data = data;
        },
        getCharName: (_sk, character) => character || '',
        getUserName: (sk) => (theatreSessions.get(sk)?.userName) || 'User',
        makeLlmClient: (customCfg) => {
            const llm = configManager.get('runtime.llm') || {};
            const cfg = customCfg || {};
            const model = cfg.model || llm.model;
            if (!model) return null;
            return new LLMClient({
                provider: llm.provider || 'openai',
                baseUrl: cfg.baseUrl || llm.baseUrl || '',
                // 安全：脚本自定义 API（custom_api）只能自带 apiKey，不得借用主 LLM 的 key，
                // 防止脚本将 baseUrl 指向任意地址时服务端携带主 key 外发（SSRF + 凭据泄露）。
                apiKey: cfg.apiKey || '',
                model,
                timeout: llm.timeout || 120000,
                maxTokens: llm.maxTokens || 131072,
            });
        },
        logger,
        timeoutMs: Number(configManager.get('runtime.agentScriptTimeout')) || 15000,
    });

    /**
     * 存档操作日志（多存档管理：问题追溯与数据恢复）。
     * 追加写入 <dataRoot>/archive-ops.log（JSONL），同时输出到网关日志。
     * @param {string} op - 'create' | 'delete' | 'meta' | 'load'
     * @param {string[]} files - 涉及的存档相对路径
     * @param {object} [extra] - 额外信息（结果等）
     */
    const _logArchiveOp = (op, files, extra = {}) => {
        try {
            const entry = {
                ts: Date.now(),
                op,
                files: Array.isArray(files) ? files : [],
                ...extra,
            };
            if (logger && typeof logger.info === 'function') {
                logger.info(`[archive-op] ${op}: ${(entry.files || []).join(',') || '(none)'}`);
            }
            const logPath = path.join(activeChatDataRoot, 'archive-ops.log');
            fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
        } catch { /* 日志失败不阻断主流程 */ }
    };

    // 初始化正则引擎存储（data/regex-scripts.json）
    initRegexStore(activeChatDataRoot);
    // 启动定时自动保存：间隔可从 runtime.agentChatAutoSaveInterval 配置（默认 5 分钟），
    // interval 已 unref，不会阻止进程退出；重复注册时 startChatAutoSave 内部先停再启（幂等）
    const configuredInterval = (typeof configManager.get === 'function')
        ? Number(configManager.get('runtime.agentChatAutoSaveInterval'))
        : NaN;
    startChatAutoSave(Number.isFinite(configuredInterval) && configuredInterval > 0
        ? configuredInterval
        : DEFAULT_AUTO_SAVE_INTERVAL);

    /**
     * 获取"已就绪"的 agent-framework 插件实例。
     *
     * 注意：插件被禁用时 loader.getPlugin() 仍会返回实例（onLoad 未执行，
     * _loaded=false），其 agentLoader/toolRegistry/agentRunner 均为 undefined。
     * 面板端点若直接访问 af.agentLoader.list() 会抛 TypeError -> HTTP 500。
     * 这里统一判空返回 null，让端点走现有的 !af 分支返回可读的 JSON 错误。
     *
     * @returns {object|null} 已就绪的插件实例，未启用/未就绪返回 null
     */
    function getReadyAgentFramework() {
        const af = getPluginManager()?.loader?.getPlugin('agent-framework');
        if (!af || !af._loaded || !af.agentLoader) return null;
        return af;
    }

    /**
     * 取 agent-framework 插件暴露的 agent 服务（含 run 方法）。
     * agent-framework 已 onLoad 时返回 _agentService，否则返回 null。
     * @returns {object|null}
     */
    function getAgentService() {
        const af = getPluginManager()?.loader?.getPlugin('agent-framework');
        return af?._agentService || null;
    }

    /**
     * 解析 theatre 请求的 sessionKey：优先用 query.session，否则用 body.session，
     * 默认 'native:default'。
     * @param {object} req
     * @returns {string}
     */
    function _theatreSessionKey(req) {
        return (req.query && req.query.session)
            || (req.body && req.body.session)
            || 'native:default';
    }

    // ==================== Agent 框架 API ====================

    app.get('/api/agents', (req, res) => {
        const af = getReadyAgentFramework();
        if (!af) return res.json({ agents: [], error: 'Agent框架未启用' });
        res.json({ agents: af.agentLoader.list() });
    });

    app.get('/api/agents/tools', (req, res) => {
        const af = getReadyAgentFramework();
        if (!af) return res.json({ tools: [] });
        res.json({ tools: af.toolRegistry.list() });
    });

    app.get('/api/agents/logs', (req, res) => {
        const af = getPluginManager()?.loader.getPlugin('agent-framework');
        if (!af) return res.json({ logs: [] });
        res.json({ logs: af.agentRunner.getLogs(50) });
    });

    app.get('/api/agents/:name', (req, res) => {
        const af = getReadyAgentFramework();
        if (!af) return res.status(404).json({ error: 'Agent框架未启用' });
        const def = af.agentLoader.get(req.params.name);
        if (!def) return res.status(404).json({ error: 'Agent不存在' });
        res.json(def);
    });

    app.post('/api/agents', async (req, res) => {
        const af = getReadyAgentFramework();
        if (!af) return res.status(503).json({ error: 'Agent框架未启用' });
        try {
            const { yaml } = req.body;
            if (!yaml) return res.status(400).json({ error: '缺少yaml字段' });
            const def = af.agentLoader.save(req.body.name || '', yaml);
            res.json({ success: true, agent: def });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.delete('/api/agents/:name', (req, res) => {
        const af = getReadyAgentFramework();
        if (!af) return res.status(503).json({ error: 'Agent框架未启用' });
        af.agentLoader.delete(req.params.name);
        res.json({ success: true });
    });

    app.post('/api/agents/:name/run', async (req, res) => {
        const af = getReadyAgentFramework();
        if (!af) return res.status(503).json({ error: 'Agent框架未启用' });
        // 这里只返回提示，实际执行通过 IM 命令 /agent run
        res.json({ success: true, message: `请在IM中发送 /agent run ${req.params.name} 来启动Agent` });
    });

    /**
     * POST /api/agents/from-default - 从默认方案创建副本（SubTask 6.6）
     *
     * 复制 default-rp.yaml 为新 Profile，自动改名并去除 isDefault 标记。
     * 同时把默认记忆模板与文风复制到 agent-rp 数据目录（若不存在），
     * 保证新副本开箱即用。
     *
     * 请求体：{ name: string, displayName?: string }
     * 响应：{ success: true, agent: def }
     */
    app.post('/api/agents/from-default', async (req, res) => {
        const af = getReadyAgentFramework();
        if (!af) return res.status(503).json({ error: 'Agent框架未启用' });

        try {
            const newName = (req.body?.name || '').trim();
            if (!newName) return res.status(400).json({ error: '缺少 name 字段' });
            // 校验 name 合法性（避免路径穿越）
            if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(newName)) {
                return res.status(400).json({ error: 'name 仅允许字母数字及 . _ -，且以字母数字开头' });
            }
            // 不允许覆盖默认方案
            if (newName === 'default-rp') {
                return res.status(400).json({ error: '不能覆盖默认方案，请使用其他名称' });
            }

            // 定位 default-rp.yaml 模板源（与主网关同仓库：<repoRoot>/plugins/agent-framework/templates）
            const templatesDir = path.join(repoRoot, 'plugins', 'agent-framework', 'templates');
            const srcPath = path.join(templatesDir, 'default-rp.yaml');
            if (!fs.existsSync(srcPath)) {
                return res.status(404).json({ error: '默认方案模板 default-rp.yaml 不存在' });
            }

            let yamlText = fs.readFileSync(srcPath, 'utf-8');

            // 替换 name 字段（首行 name: default-rp）
            yamlText = yamlText.replace(/^name:\s*default-rp\s*$/m, `name: ${newName}`);

            // 移除 isDefault: true 标记（副本不应是默认方案）
            yamlText = yamlText.replace(/^isDefault:\s*true\s*$/m, '# isDefault: true  # 副本不作为默认方案');

            // 可选：替换 displayName
            const displayName = (req.body?.displayName || '').trim();
            if (displayName) {
                if (/^displayName:\s*.+$/m.test(yamlText)) {
                    yamlText = yamlText.replace(/^displayName:\s*.+$/m, `displayName: ${displayName}`);
                } else {
                    yamlText = yamlText.replace(/^(name:\s*.+)$/m, `$1\ndisplayName: ${displayName}`);
                }
            }

            // 通过 agentLoader.save 保存（会写入 agents 目录并更新内存）
            const def = af.agentLoader.save(newName, yamlText);
            logger.info(`[api] 从默认方案创建副本: ${newName}`);

            res.json({ success: true, agent: def });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // ==================== Agent 剧场 API（Task 4） ====================
    //
    // SSE 端点 + 输入端点 + 事件查询，供面板内置的 "Agent 剧场" 页面消费。
    // 推送 AgentRunResult 流，不走轮询。

    /** GET /api/agent-theatre/stream - SSE 订阅 AgentRunResult 流 */
    app.get('/api/agent-theatre/stream', (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        theatreBroadcaster.addClient(res, sessionKey);
    });

    /** POST /api/agent-theatre/input - 接收用户输入，触发 ctx.agent.run */
    app.post('/api/agent-theatre/input', async (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        const body = req.body || {};
        const { input, profile, callbackId, character, worldbook, style, rerun, greetingIndex, userMsgId } = body;

        if (!input && !callbackId && !rerun) {
            return res.status(400).json({ success: false, error: '需要 input 或 callbackId' });
        }

        const agentService = getAgentService();
        if (!agentService || typeof agentService.run !== 'function') {
            return res.status(503).json({ success: false, error: 'agent-framework 插件未加载' });
        }
        if (!getLlmService()) {
            return res.status(503).json({ success: false, error: 'runtime.llm 未配置，无法触发 Agent run' });
        }

        // 维护会话状态（P4-1：会话内按角色卡隔离运行时状态）
        const sess = theatreSessions.get(sessionKey) || { profile: profile || 'default-rp' };
        if (profile) sess.profile = profile;

        // 角色卡切换：先把旧卡的 history 自动归档保存到旧卡文件，再切换到新卡。
        // 旧卡槽状态保留在 sess.chars[oldChar]（切回时自动恢复）；新卡从自己的卡槽开始（历史为空），
        // 从根源上杜绝"旧卡历史/开场白/用户输入注入新卡上下文"。
        const oldChar = sess.character || '';
        if (character && character !== oldChar && oldChar !== '') {
            const oldCs = charState(sess, oldChar);
            if (Array.isArray(oldCs.history) && oldCs.history.length > 0) {
                const saveResult = saveChat(activeChatDataRoot, {
                    character: oldChar,
                    messages: oldCs.history,
                    userName: sess.userName || 'User',
                    prevFile: oldCs.chatFile || undefined,
                });
                if (saveResult.ok) {
                    oldCs.dirty = false;
                    oldCs.savedAt = saveResult.savedAt;
                    oldCs.lastSavedAt = Date.now();
                    oldCs.chatFile = saveResult.file;
                    logger.info(`[theatre] 角色卡切换 ${oldChar} -> ${character}，旧会话已自动保存: ${saveResult.file}`);
                } else {
                    // P1-5 修复：旧会话保存失败时阻止切换并返回错误，
                    // 否则旧卡 chatFile 状态异常，后续保存可能写错文件（串档）。
                    logger.warn(`[theatre] 角色卡切换前旧会话保存失败: ${saveResult.error || '未知原因'}`);
                    return res.status(500).json({
                        success: false,
                        error: `切换角色卡失败：旧会话保存失败（${saveResult.error || '未知原因'}）。请检查磁盘权限后重试。`,
                    });
                }
            }
        }
        if (character) sess.character = character;
        if (worldbook) sess.worldbook = worldbook;
        if (style) sess.style = style;

        // 当前角色卡的隔离状态（历史/回合/选项回调/开场白序号等均按角色隔离）
        const cs = charState(sess, character || sess.character || '');
        if (greetingIndex != null) cs.greetingIndex = greetingIndex;

        // 正则引擎：角色卡切换时自动导入内嵌 regex_scripts
        if (character && character !== sess._lastRegexChar) {
            try {
                const { loadCharacterCardByName } = await import('./runtime/card-loader.js');
                const runtimeCfg = configManager.get('runtime') || {};
                const charDir = path.resolve(repoRoot, runtimeCfg.charactersDir || 'assets/characters');
                const card = loadCharacterCardByName(charDir, character);
                if (card) {
                    const added = importRegexFromCard(card, character);
                    if (added > 0) {
                        logger.info(`[regex] 角色卡 "${character}" 自动导入 ${added} 个正则脚本`);
                    }
                }
                sess._lastRegexChar = character;
            } catch (e) {
                // 角色卡正则导入失败不阻塞主流程
                logger.warn(`[regex] 角色卡 "${character}" 正则导入失败: ${e.message}`);
            }
        }

        // 脚本库（对标酒馆助手角色脚本库）：角色卡加载时自动同步导入
        // extensions.tavern_helper.scripts / variables（同 id 覆盖更新，新增追加）
        if (character && character !== sess._lastScriptChar) {
            try {
                const { loadCharacterCardByName } = await import('./runtime/card-loader.js');
                const runtimeCfg = configManager.get('runtime') || {};
                const charDir = path.resolve(repoRoot, runtimeCfg.charactersDir || 'assets/characters');
                const card = loadCharacterCardByName(charDir, character);
                if (card) {
                    const { scripts, variables } = extractCardScripts(card);
                    if (scripts.length) {
                        // autoDisable：首次导入强制禁用（防止加载角色卡即自动执行不可信脚本），
                        // 用户需在小手机脚本 tab 手动启用后才参与事件执行
                        const r = scriptStore.importScripts('character', character, scripts, { autoDisable: true });
                        logger.info(`[script] 角色卡 "${character}" 自动同步脚本库：${r.imported} 新增 / ${r.updated} 更新（默认禁用，需手动启用）`);
                    }
                    if (variables && Object.keys(variables).length) {
                        scriptStore.importVariables(character, variables);
                    }
                }
                sess._lastScriptChar = character;
            } catch (e) {
                // 脚本同步失败不阻塞主流程
                logger.warn(`[script] 角色卡 "${character}" 脚本同步失败: ${e.message}`);
            }
            // 角色加载事件：通知启用脚本（异步执行，不阻塞）
            scriptEngine.emitToSession({ sessionKey, character, eventType: SCRIPT_EVENTS.CHARACTER_LOADED, args: { character } })
                .catch((e) => logger.warn(`[script] CHARACTER_LOADED 事件触发失败: ${e.message}`));
        }

        // 重跑：复用当前角色卡槽的上一轮输入，并移除该槽历史末尾的 user+assistant 消息对
        // （避免重复注入 LLM 提示词）。P4-1：重跑只作用于当前角色卡槽，不触碰其它卡。
        if (rerun) {
            if (!cs.lastInput) {
                return res.status(400).json({ success: false, error: '没有上一轮输入可重跑' });
            }
            if (Array.isArray(cs.history) && cs.history.length > 0) {
                if (cs.history[cs.history.length - 1].role === 'assistant') {
                    cs.history.pop();
                }
                if (cs.history.length > 0 && cs.history[cs.history.length - 1].role === 'user') {
                    cs.history.pop();
                }
            }
        }

        cs.turn += 1;
        // 非 rerun 时才更新 lastInput（按角色卡槽记录）
        if (!rerun) {
            cs.lastInput = input || callbackId;
        }
        theatreSessions.set(sessionKey, sess);

        // 选项回调：callbackId 形如 "select:option:1"。
        // P1-1 修复：优先映射为上一轮结果中的选项文本（更利于 LLM 理解用户的选择），
        // 找不到匹配时退化为 "[选项回调] <callbackId>"。
        // P4-1：选项回调只解析当前角色卡槽的 lastResult，杜绝旧卡选项跨角色命中。
        const resolveOptionCallback = (cb) => {
            const text = String(cb || '');
            const match = cs.lastResult?.options?.find(o => o.callbackId === text);
            return match?.text ? `[选项回调] ${match.text}` : `[选项回调] ${text}`;
        };

        let actualInput = '';
        if (rerun) {
            // 重跑时复用上一轮的 actualInput 推导
            const lastInput = cs.lastInput;
            // 判断 lastInput 是 callbackId 还是普通 input（callbackId 通常以 select: 开头）
            if (typeof lastInput === 'string' && lastInput.startsWith('select:')) {
                actualInput = resolveOptionCallback(lastInput);
            } else {
                actualInput = lastInput || '';
            }
        } else {
            actualInput = input || '';
            if (!actualInput && callbackId) {
                actualInput = resolveOptionCallback(callbackId);
            }
        }

        // 解析 sessionKey -> platform:chatId
        // P1-6 修复：按首个冒号切分（原 split(':') 只取前两段，含冒号的 chatId 如 "group:123" 会被截断）
        const colonIdx = sessionKey.indexOf(':');
        const platform = colonIdx >= 0 ? sessionKey.slice(0, colonIdx) : sessionKey;
        const chatId = colonIdx >= 0 ? sessionKey.slice(colonIdx + 1) : 'theatre';

        // P2: run 执行前标记 running（供 /abort 端点判断是否有进行中的 run）并广播 run_state
        sess.running = true;
        cs.lastRunId = null;
        theatreSessions.set(sessionKey, sess);
        theatreBroadcaster.broadcastRunState(sessionKey, null, 'running');

        try {
            // 正则引擎：按当前角色隔离取生效脚本（global + 角色专属），
            // 切换角色后前一角色的脚本立即停用，不参与正则应用
            const regexStore = getRegexStore();
            const regexScripts = regexStore ? regexStore.getActiveScripts(sess.character || '') : [];
            const regexedInput = regexScripts.length > 0
                ? getRegexedString(actualInput, REGEX_PLACEMENT.USER_INPUT, { isPrompt: true, scripts: regexScripts })
                : actualInput;

            // 触发 Agent run
            // P1/P3 修复：角色卡/世界书/文风此前只放进 ctx（agentService.run 并不读取 ctx 里的
            // character/worldbook/style），导致剧场流注入全部落空。现在放入 session 参数，
            // 由 run 组装 agentSession 时生效；同时把面板维护的 history/turn/greetingIndex 透传。
            // P4-1：history 只取当前角色卡槽 cs.history——新卡首轮为空（开场白可正常注入），
            // 旧卡历史/用户输入绝不会进入新卡上下文。传快照副本，避免下游原地改动污染卡槽。
            const historySnapshot = Array.isArray(cs.history) ? cs.history.slice() : [];
            const runResult = await agentService.run(
                sess.profile,
                regexedInput,
                {
                    platform: platform || 'native',
                    chatId: chatId || 'theatre',
                    character: character || sess.character || '',
                    worldbook: worldbook || sess.worldbook || '',
                    style: style || sess.style || '',
                    history: historySnapshot,
                    turn: cs.turn,
                    greetingIndex: greetingIndex != null ? greetingIndex : cs.greetingIndex,
                    // ST 兼容（P0）：MVU stat_data 快照 → context-builder 展开
                    // {{get_message_variable::path}} / {{format_message_variable::stat_data}}
                    variables: (cs.mvu && cs.mvu.stat_data) || {},
                },
                {
                    llm: getLlmService(),
                    history: historySnapshot,
                    character: character || sess.character,
                    worldbook: worldbook || sess.worldbook,
                    style: style || sess.style,
                },
            );

            // P2: run 结束，清理 running 标记并广播终态（runner 被中止时返回 aborted:true）
            sess.running = false;
            theatreBroadcaster.broadcastRunState(sessionKey, runResult.runId, runResult.aborted ? 'aborted' : 'completed');

            cs.lastRunId = runResult.runId;
            cs.lastResult = runResult.result?.toJSON?.() || null;
            // 把本轮结果文本作为 assistant 消息加入当前角色卡槽历史，便于下一轮续写
            const mainText = runResult.result?.getMainText?.() || runResult.text || '';

            // ==================== R1 重构：专业子 Agent 处理器（功能任务与主对话解耦） ====================
            // 主 Agent 专注正文；变量解析与编年史总结由独立 LLM 调用完成（可用第二模型）。
            // 未启用 / 无模型 / 调用失败时降级"标签解析"兼容路径（旧卡仍可玩）。
            cs.mvu = cs.mvu || { stat_data: {} };
            if (!cs.mvu.stat_data || typeof cs.mvu.stat_data !== 'object') cs.mvu.stat_data = {};
            const compatCfg = configManager.get('runtime.agentCompat') || {};
            const compatOn = compatCfg.enabled !== false;
            const activeChar = character || sess.character || '';

            // 加载角色卡（用于初始变量表 + 变量更新规则提取；加载失败不阻塞）
            let card = null;
            if (activeChar) {
                try {
                    const { loadCharacterCardByName } = await import('./runtime/card-loader.js');
                    const runtimeCfg = configManager.get('runtime') || {};
                    const charDir = path.resolve(repoRoot, runtimeCfg.charactersDir || 'assets/characters');
                    card = loadCharacterCardByName(charDir, activeChar);
                } catch (_) { card = null; }
            }

            // 1) 角色卡初始变量：仅当该角色卡槽 stat_data 为空时，自动从卡内 [initvar] 初始 解析初始化。
            //    切换角色卡 → 新卡槽 stat_data 为空 → 重新初始化，杜绝"沿用上一张卡的初始变量"。
            if (Object.keys(cs.mvu.stat_data).length === 0 && card) {
                const init = extractInitVariables(card);
                if (init && Object.keys(init).length > 0) {
                    cs.mvu.stat_data = init;
                    cs.mvu.initSource = activeChar;
                    cs.mvu.initAt = Date.now();
                    logger.info(`[theatre] 角色「${activeChar}」初始变量已从卡内 [initvar] 自动初始化（${Object.keys(init).length} 顶层键）`);
                }
            }

            // 2) 变量处理子 Agent（优先）；降级标签解析
            let mvuApplied = { changed: false, applied: [], skipped: [] };
            let mvuViaProcessor = false;
            if (compatOn && compatCfg.variableProcessor?.enabled !== false) {
                try {
                    const rules = extractUpdateRules(card);
                    const proc = await runVariableProcessor({
                        configManager,
                        mainText,
                        statData: cs.mvu.stat_data,
                        rules,
                        characterName: activeChar,
                        clientFactory: processorClientFactory,
                    });
                    if (proc && Array.isArray(proc.patch) && proc.patch.length > 0) {
                        mvuApplied = applyCommands(cs.mvu.stat_data, proc.patch);
                        mvuViaProcessor = true;
                    }
                } catch (e) {
                    logger.warn(`[theatre] 变量处理子 Agent 失败，降级标签解析: ${e.message}`);
                }
            }
            if (!mvuViaProcessor) {
                // 兼容路径：解析主文本中的 <UpdateVariable>（JSON Patch / set|old→new|() / _.set）
                mvuApplied = applyMvuToText(mainText, cs.mvu.stat_data);
            }
            cs.mvu.stat_data = mvuApplied.snapshot;
            cs.mvu.changed = mvuApplied.changed;
            cs.mvu.lastUpdate = mvuApplied.applied.length > 0
                ? { at: Date.now(), count: mvuApplied.applied.length, via: mvuViaProcessor ? 'processor' : 'tags' }
                : null;
            if (mvuApplied.changed) {
                // 变量变更历史（可视化：变量查看器/状态面板展示每轮应用了什么命令）
                cs.mvu.history = cs.mvu.history || [];
                cs.mvu.history.push({
                    turn: cs.turn,
                    ts: Date.now(),
                    via: mvuViaProcessor ? 'processor' : 'tags',
                    commands: mvuApplied.applied,
                });
                if (cs.mvu.history.length > 50) cs.mvu.history = cs.mvu.history.slice(-50);
            }

            // 3) 编年史/小总结子 Agent（优先）；降级解析主文本 <sum>
            let summary = null;
            if (compatOn && compatCfg.chronicle?.enabled !== false) {
                try {
                    const prev = (cs.chronicle && cs.chronicle.length)
                        ? cs.chronicle[cs.chronicle.length - 1].content : '';
                    summary = await runChronicleProcessor({
                        configManager,
                        mainText,
                        previousSummary: prev,
                        characterName: activeChar,
                        clientFactory: processorClientFactory,
                    });
                } catch (e) {
                    logger.warn(`[theatre] 编年史子 Agent 失败，降级 <sum> 解析: ${e.message}`);
                }
            }
            if (!summary) {
                const m = mainText.match(/<sum>([\s\S]*?)<\/sum>/i);
                if (m) summary = m[1].trim();
            }
            if (summary) {
                cs.chronicle = cs.chronicle || [];
                cs.chronicle.push({ entryNum: cs.chronicle.length + 1, content: summary, ts: Date.now() });
            }

            // 正则引擎：对 AI 输出应用 markdownOnly + 非短暂性脚本（placement: AI_OUTPUT）
            const regexedOutput = regexScripts.length > 0
                ? getRegexedString(mainText, REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true, scripts: regexScripts })
                : mainText;
            // ST 兼容（P0）：显示文本剥离 MVU 内部块（<UpdateVariable>/<StatusPlaceHolderImpl/>/<Analysis>），
            // 历史仍存原始文本（下一轮上下文可见，与 ST 行为一致）；前端据此渲染状态栏卡。
            const displayText = stripForDisplay(regexedOutput);
            cs.history = cs.history || [];
            const newMessages = [];
            // 消息稳定 ID：用户消息优先采用前端生成的 userMsgId（前后端对齐定位），
            // assistant 消息由服务端分配并随 agent_result 广播，前端据此记录楼层页码 id。
            const userMsgIdFinal = (typeof userMsgId === 'string' && userMsgId.length > 0) ? userMsgId : makeMsgId('u');
            if (actualInput) newMessages.push({ role: 'user', content: actualInput, id: userMsgIdFinal });
            let assistantId = null;
            if (mainText) {
                const am = { role: 'assistant', content: mainText, id: makeMsgId('a') };
                newMessages.push(am);
                assistantId = am.id;
            }
            if (newMessages.length > 0) {
                cs.history.push(...newMessages);
                cs.dirty = true; // 有新的 user/assistant 消息 -> 标记待自动保存
            }
            // 限制历史长度，避免内存膨胀
            // P1-6 修复：按 Profile 的 context.historyLimit 动态计算（2×轮数），
            // 替代硬编码 40——否则用户把 historyLimit 调到 21+ 时历史会被 40 条提前截断。
            const agentServiceNow = getAgentService();
            const histLimit = (typeof agentServiceNow?.getHistoryLimit === 'function')
                ? (agentServiceNow.getHistoryLimit(sess.profile) || 20)
                : 20;
            const maxHistory = Math.max(40, histLimit * 2);
            if (cs.history.length > maxHistory) cs.history = cs.history.slice(-maxHistory);

            // 广播完整结果 + 状态 + MVU 变量 + 编年史给所有订阅者（正则处理后的文本用于显示）
            theatreBroadcaster.broadcastResult(sessionKey, {
                runId: runResult.runId,
                result: cs.lastResult,
                text: displayText,
                assistantId, // 本轮 assistant 消息稳定 ID（前端楼层页码定位用；失败时为 null）
                userMsgId: userMsgIdFinal,
                variables: {
                    stat_data: cs.mvu.stat_data,
                    changed: cs.mvu.changed,
                    initSource: cs.mvu.initSource || '',
                    lastUpdate: cs.mvu.lastUpdate || null,
                },
                chronicle: cs.chronicle || [],
                mvuHistory: (cs.mvu.history || []).slice(-10),
            });
            theatreBroadcaster.broadcastState(sessionKey, cs.lastResult?.state || {});

            // 脚本库（对标酒馆助手）：每轮对话后触发事件钩子——GENERATION_ENDED / MESSAGE_RECEIVED。
            // 异步执行不阻塞响应；脚本对 stat_data 的修改直接写回 cs.mvu.stat_data（下一轮广播生效）。
            const activeCharForEvent = character || sess.character || '';
            scriptEngine.emitToSession({ sessionKey, character: activeCharForEvent, eventType: SCRIPT_EVENTS.GENERATION_ENDED, args: { runId: runResult.runId } })
                .then(() => scriptEngine.emitToSession({ sessionKey, character: activeCharForEvent, eventType: SCRIPT_EVENTS.MESSAGE_RECEIVED, args: { message_id: Math.max(-1, (cs.history || []).length - 1) } }))
                .catch((e) => logger.warn(`[script] 每轮事件触发失败: ${e.message}`));

            res.json({
                success: true,
                runId: runResult.runId,
                text: displayText,
                result: cs.lastResult,
                assistantId,
                userMsgId: userMsgIdFinal,
                variables: {
                    stat_data: cs.mvu.stat_data,
                    changed: cs.mvu.changed,
                    initSource: cs.mvu.initSource || '',
                    lastUpdate: cs.mvu.lastUpdate || null,
                },
                chronicle: cs.chronicle || [],
                mvuHistory: (cs.mvu.history || []).slice(-10),
            });
        } catch (e) {
            // P2: 异常兜底：清理 running 标记并广播 error 终态
            sess.running = false;
            theatreBroadcaster.broadcastRunState(sessionKey, null, 'error');
            logger.error(`[theatre] Agent run 失败: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /**
     * POST /api/agent-theatre/abort - 停止当前正在执行的 run（P2）。
     *
     * run 执行中（LLM 工具循环）调用 agentService.abortRun(runId) 触发 AbortController，
     * runner 返回 aborted:true 结果，/input 路由随后广播 run_state=aborted。
     */
    app.post('/api/agent-theatre/abort', async (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        const sess = theatreSessions.get(sessionKey);
        if (!sess || !sess.running) {
            return res.json({ success: false, error: '当前没有正在执行的 run' });
        }
        const agentService = getAgentService();
        if (!agentService || typeof agentService.abortRun !== 'function') {
            return res.status(503).json({ success: false, error: 'agent-framework 插件未加载或不支持 abort' });
        }
        // 定位当前 run：优先当前角色卡槽的 lastRunId（run 完成后回传）；执行中 runId 尚未回传时，
        // 从 activeRuns 取该会话正在运行的 run（单会话单 run 架构下安全）
        const cs = charState(sess, sess.character || '');
        let runId = cs.lastRunId;
        if (!runId) {
            const status = (typeof agentService.getStatus === 'function') ? agentService.getStatus() : null;
            const active = status?.activeAgents || [];
            if (active.length > 0) runId = active[active.length - 1].runId;
        }
        if (!runId) {
            return res.json({ success: false, error: '当前没有正在执行的 run' });
        }
        const ok = agentService.abortRun(runId);
        if (!ok) {
            return res.json({ success: false, error: 'run 不存在或已结束' });
        }
        theatreBroadcaster.broadcastRunState(sessionKey, runId, 'aborting');
        res.json({ success: true, runId, state: 'aborting' });
    });

    /**
     * GET /api/agent-theatre/prompt - 查询最近一次注入的完整提示词（P2）。
     *
     * 供前端"提示词查看器"使用：agentRunner.run 在构建上下文后把 messages 存入
     * lastPromptMap（Map<sessionKey, {messages, builtAt, runId}>），本端点按会话读取。
     * messages 为 [{role, content}] 数组，system 的 content 可能含多个段落
     * （以 \n\n 分隔），前端可直接分段展示。
     *
     * 响应：
     *   - 有记录：{ success: true, prompt: { messages, builtAt, runId } }
     *   - 无记录：{ success: true, prompt: null }
     */
    app.get('/api/agent-theatre/prompt', (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        const agentService = getAgentService();
        if (!agentService || typeof agentService.getLastPrompt !== 'function') {
            return res.status(503).json({ success: false, error: 'agent-framework 插件未加载或不支持提示词查询' });
        }
        // P4 修复：按角色卡精确查询（缓存按 会话+角色卡 隔离），切卡后不命中旧卡记录
        const sess = theatreSessions.get(sessionKey);
        const character = (req.query && req.query.character) || sess?.character || '';
        const prompt = agentService.getLastPrompt(sessionKey, character);
        if (!prompt) {
            return res.json({ success: true, prompt: null });
        }
        // 只回传前端需要的字段，避免泄漏 card 等内部对象
        res.json({
            success: true,
            prompt: {
                messages: Array.isArray(prompt.messages)
                    ? prompt.messages.map(m => ({ role: m.role || 'user', content: m.content || '' }))
                    : [],
                builtAt: prompt.builtAt || null,
                runId: prompt.runId || null,
            },
        });
    });

    /**
     * POST /api/agent-theatre/prompt-preview - 无 run 构建当前角色卡上下文（P2/P4/P5）。
     *
     * 用途：提示词查看器在"未执行 run"时也能显示"下一轮将注入的上下文"——
     * 用当前会话的角色卡槽状态（character/worldbook/style/history/greetingIndex）+ 可选输入，
     * 调用与 run 完全相同的组装路径（agentService.buildContext → ContextBuilder.buildFull），
     * 保证预览显示与实际注入逐字节一致。
     *
     * body: { session?, profile?, character?, worldbook?, style?, greetingIndex?, input? }
     * 响应：{ success:true, preview:true, prompt:{ messages, builtAt, runId:null }, greetingInjected }
     * 失败（Profile 不存在 / 插件未加载等）：{ success:false, error }，前端降级到 lastPromptMap。
     */
    app.post('/api/agent-theatre/prompt-preview', async (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        const body = req.body || {};
        const agentService = getAgentService();
        if (!agentService || typeof agentService.buildContext !== 'function') {
            return res.status(503).json({ success: false, error: 'agent-framework 插件未加载或不支持上下文预览' });
        }
        const sess = theatreSessions.get(sessionKey);
        const character = body.character || sess?.character || '';
        const cs = sess ? charState(sess, character || sess.character || '') : null;
        const colonIdx = sessionKey.indexOf(':');
        const platform = colonIdx >= 0 ? sessionKey.slice(0, colonIdx) : sessionKey;
        const chatId = colonIdx >= 0 ? sessionKey.slice(colonIdx + 1) : 'theatre';
        try {
            const previewSession = {
                platform,
                chatId,
                character,
                worldbook: body.worldbook || sess?.worldbook || '',
                style: body.style || sess?.style || '',
                turn: (cs?.turn || 0) + 1,
                greetingIndex: body.greetingIndex != null ? body.greetingIndex : (cs?.greetingIndex || 0),
            };
            const history = cs?.history || [];
            const input = body.input || '';
            const { messages, greetingInjected } = await agentService.buildContext(
                body.profile || sess?.profile || 'default-rp',
                previewSession,
                history,
                input,
            );
            res.json({
                success: true,
                preview: true,
                character,
                greetingInjected,
                prompt: {
                    messages: Array.isArray(messages)
                        ? messages.map(m => ({ role: m.role || 'user', content: m.content || '' }))
                        : [],
                    builtAt: Date.now(),
                    runId: null,
                },
            });
        } catch (e) {
            // 预览失败（如 Profile 不存在）不阻断：前端可降级到已 run 的记录
            res.json({ success: false, error: e.message });
        }
    });

    /**
     * GET /api/agent-theatre/greetings - 查询当前角色卡的开场白列表（P3）。
     *
     * 供前端展示开场白切换箭头：返回 first_message + alternate_greetings 数组。
     * 角色卡来源优先级：query.character > body.character > 会话已绑定角色卡（sess.character）。
     *
     * 响应：{ success: true, character, firstMessage, alternateGreetings, greetings }
     * 未绑定角色卡 / 无开场白时 greetings 为空数组（仍 success:true）。
     */
    app.get('/api/agent-theatre/greetings', (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        const sess = theatreSessions.get(sessionKey);
        const character = (req.query && req.query.character)
            || (req.body && req.body.character)
            || sess?.character
            || '';
        if (!character) {
            return res.json({ success: true, character: '', firstMessage: '', alternateGreetings: [], greetings: [] });
        }
        const agentService = getAgentService();
        if (!agentService || typeof agentService.getGreetings !== 'function') {
            return res.status(503).json({ success: false, error: 'agent-framework 插件未加载或不支持开场白查询' });
        }
        const list = agentService.getGreetings(character);
        if (!list) {
            return res.json({ success: true, character, firstMessage: '', alternateGreetings: [], greetings: [] });
        }
        res.json({
            success: true,
            character: list.character || character,
            firstMessage: list.firstMessage || '',
            alternateGreetings: list.alternateGreetings || [],
            greetings: list.greetings || [],
            builtinCount: list.builtinCount || 0,
        });
    });

    /**
     * 开场白管理端点（P3）：编辑 / 新建 / 删除开场白。
     *
     * 存储与角色卡文件分离（data/plugins/agent-framework/greetings/<card>.json），
     * 编辑/删除绝不修改原始角色卡（PNG/JSON 均安全）。新开场白保存后自动进入
     * greetings 列表末尾，供开场白切换机制（首楼按钮）选择。
     *
     * 角色卡名解析与 GET /api/agent-theatre/greetings 一致：body.character > 会话已绑定。
     *
     * 响应：成功 { success:true, greetings: string[] }（操作后的完整开场白列表）；
     *        校验/服务错误 { success:false, error }。
     */
    const handleGreetingEdit = (req, res, operation) => {
        const body = req.body || {};
        const sessionKey = _theatreSessionKey(req);
        const sess = theatreSessions.get(sessionKey);
        const character = (body.character || '').trim() || sess?.character || '';
        if (!character) {
            return res.status(400).json({ success: false, error: '未指定角色卡（character）' });
        }
        const agentService = getAgentService();
        if (!agentService || typeof agentService[operation] !== 'function') {
            return res.status(503).json({ success: false, error: 'agent-framework 插件未加载或不支持开场白操作' });
        }
        // add 只传 (character, text)；save/delete 传 (character, index, text)。
        // 若统一传 3 参，body.index(undefined) 会占据 add 的 text 参数位导致文本丢失。
        const result = operation === 'addGreeting'
            ? agentService[operation](character, body.text)
            : agentService[operation](character, body.index, body.text);
        if (!result || result.ok !== true) {
            return res.status(400).json({ success: false, error: (result && result.error) || '开场白操作失败' });
        }
        res.json({ success: true, character, greetings: result.greetings || [] });
    };

    /** POST /api/agent-theatre/greetings/save - 编辑已有开场白（body: {character, index, text}） */
    app.post('/api/agent-theatre/greetings/save', (req, res) => {
        handleGreetingEdit(req, res, 'saveGreeting');
    });

    /** POST /api/agent-theatre/greetings/add - 新建开场白模板（body: {character, text}） */
    app.post('/api/agent-theatre/greetings/add', (req, res) => {
        handleGreetingEdit(req, res, 'addGreeting');
    });

    /** POST /api/agent-theatre/greetings/delete - 删除开场白（body: {character, index}） */
    app.post('/api/agent-theatre/greetings/delete', (req, res) => {
        handleGreetingEdit(req, res, 'deleteGreeting');
    });

    /** POST /api/agent-theatre/validate-run - 保存 Profile 并验证可运行性 */
    app.post('/api/agent-theatre/validate-run', async (req, res) => {
        const body = req.body || {};
        const { name, yaml, probeInput } = body;

        if (!name || !yaml) {
            return res.status(400).json({ success: false, error: '需要 name 和 yaml' });
        }

        const af = getReadyAgentFramework();
        if (!af) {
            return res.status(503).json({ success: false, error: 'Agent框架未启用' });
        }
        const agentService = getAgentService();
        if (!agentService || typeof agentService.run !== 'function') {
            return res.status(503).json({ success: false, error: 'agent-framework 插件未加载' });
        }
        if (!getLlmService()) {
            return res.status(503).json({ success: false, error: 'runtime.llm 未配置' });
        }

        try {
            // 步骤 1：保存（解析校验 + 热重载）
            const def = af.agentLoader.save(name, yaml);

            // 步骤 2：用探测输入跑一次
            const input = probeInput || '你好';
            const sessionKey = _theatreSessionKey(req);
            // P4 修复：与 /input 一致的首冒号切分（原 split(':') 只取前两段，多冒号 chatId 被截断）
            const colonIdx = sessionKey.indexOf(':');
            const platform = colonIdx >= 0 ? sessionKey.slice(0, colonIdx) : sessionKey;
            const chatId = colonIdx >= 0 ? sessionKey.slice(colonIdx + 1) : 'validate';
            const runResult = await agentService.run(
                name,
                input,
                {
                    platform: platform || 'native',
                    chatId: chatId || 'validate',
                },
                {
                    llm: getLlmService(),
                    history: [],
                },
            );

            const mainText = runResult.result?.getMainText?.() || runResult.text || '';
            res.json({
                success: true,
                saved: true,
                runId: runResult.runId,
                text: mainText,
                result: runResult.result?.toJSON?.() || null,
            });
        } catch (e) {
            logger.error(`[theatre] validate-run 失败: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /** GET /api/agent-theatre/events/:runId - 查询历史事件（调 workspace-manager.getEvents） */
    app.get('/api/agent-theatre/events/:runId', (req, res) => {
        const { runId } = req.params;
        const afterSeq = parseInt(req.query.afterSeq) || 0;
        const limit = parseInt(req.query.limit) || 100;
        const af = getReadyAgentFramework();
        const wm = af?.workspaceManager;
        if (!wm || typeof wm.getEvents !== 'function') {
            return res.status(503).json({ success: false, error: 'workspace-manager 不可用' });
        }
        try {
            const events = wm.getEvents(runId, { afterSeq, limit });
            res.json({ success: true, runId, events });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    /**
     * GET /api/agent-theatre/assets - 轻量资产列表（角色卡 / 世界书 / 预设）
     *
     * 独立于 NativeRuntime：不要求 runtime.enabled，直接扫描 assets 目录返回名称列表，
     * 供 Agent 前端（角色卡/世界书选择器）在主网关与独立 Agent 服务两种模式下都能用。
     * 目录路径与 NativeRuntime 一致（config.runtime.*Dir，默认 assets/...）。
     */
    app.get('/api/agent-theatre/assets', (req, res) => {
        const runtimeCfg = configManager.get('runtime') || {};
        const dirs = {
            characters: path.resolve(repoRoot, runtimeCfg.charactersDir || 'assets/characters'),
            worldbooks: path.resolve(repoRoot, runtimeCfg.worldbooksDir || 'assets/worldbooks'),
            presets: path.resolve(repoRoot, runtimeCfg.presetsDir || 'assets/presets'),
        };
        const listJson = (dir) => {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir)
                .filter((f) => f.endsWith('.json'))
                .map((f) => path.basename(f, '.json'));
        };
        const listCards = (dir) => {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir)
                .filter((f) => f.endsWith('.json') || f.endsWith('.png'))
                .map((f) => path.basename(f, path.extname(f)));
        };
        res.json({
            success: true,
            assets: {
                characters: listCards(dirs.characters),
                worldbooks: listJson(dirs.worldbooks),
                presets: listJson(dirs.presets),
            },
            dirs,
        });
    });

    /**
     * GET /api/agent-theatre/character-image - 返回角色卡头像图片（仅 PNG）
     *
     * P6: 前端根据所选角色卡自动切换聊天头像。语义：
     *   - 角色卡为 PNG 图片 → 返回 image/png（带 1h 缓存，切换流畅）
     *   - 角色卡为 JSON / 不存在 / 加载失败 → 404，前端据此优雅降级为默认头像
     * 安全：仅接受 basename，禁止路径穿越；大小写/特殊字符文件名做目录扫描容错。
     */
    app.get('/api/agent-theatre/character-image', (req, res) => {
        try {
            const name = String(req.query.name || '').trim();
            if (!name) return res.status(400).json({ success: false, error: '缺少 name 参数' });
            // 防路径穿越：只允许文件名，不含路径分隔符
            if (name.includes('/') || name.includes('\\') || name.includes('..')) {
                return res.status(400).json({ success: false, error: '非法角色卡名' });
            }
            const runtimeCfg = configManager.get('runtime') || {};
            const charDir = path.resolve(repoRoot, runtimeCfg.charactersDir || 'assets/characters');
            const base = name.toLowerCase().endsWith('.png') || name.toLowerCase().endsWith('.json')
                ? name.slice(0, -path.extname(name).length)
                : name;

            // 精确候选 + 目录扫描（大小写不敏感，覆盖 .PNG / 特殊字符文件名）
            let target = null;
            if (fs.existsSync(charDir)) {
                for (const f of fs.readdirSync(charDir)) {
                    if (f.toLowerCase() === `${base}.png`.toLowerCase()) {
                        target = path.join(charDir, f);
                        break;
                    }
                }
            }
            if (!target) {
                return res.status(404).json({ success: false, error: '角色卡图片不存在（角色卡为 JSON 或未找到 PNG）' });
            }
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.sendFile(target);
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /**
     * GET /api/agent-theatre/llm-config - 读取脱敏的 runtime.llm 配置。
     * 供 Agent 前端（独立服务无 panel.html）配置 LLM 用，主网关与独立服务共用。
     */
    app.get('/api/agent-theatre/llm-config', (req, res) => {
        const redacted = configManager.getRedacted() || {};
        const llm = (redacted.runtime && redacted.runtime.llm) || {};
        res.json({ success: true, llm });
    });

    /**
     * POST /api/agent-theatre/llm-config - 保存 runtime.llm 配置。
     * apiKey 掩码回传保护：收到 *** 开头/纯星号时保留已保存真值。
     * 保存成功后通过 deps.resetLlmService 失效 LLM 服务缓存（独立服务立即生效，无需重启）。
     */
    app.post('/api/agent-theatre/llm-config', (req, res) => {
        try {
            const body = req.body || {};
            const provider = body.provider || 'openai';
            const baseUrl = (body.baseUrl || '').trim();
            let apiKey = (body.apiKey || '').trim();
            const model = (body.model || '').trim();
            const timeout = body.timeout != null ? Number(body.timeout) : 120000;
            const maxTokens = body.maxTokens != null ? Number(body.maxTokens) : 131072;

            if (!['openai', 'claude', 'gemini'].includes(provider)) {
                return res.status(400).json({ success: false, error: 'provider 必须是 openai / claude / gemini' });
            }
            if (!model) {
                return res.status(400).json({ success: false, error: '模型名（model）不能为空' });
            }
            // 掩码回传保护：前端回传脱敏串时保留已保存真 key
            const saved = configManager.get('runtime.llm') || {};
            if (!apiKey || apiKey.includes('***') || /^\*+$/.test(apiKey)) {
                apiKey = saved.apiKey || '';
            }

            const persisted = configManager.update({
                runtime: { llm: { provider, baseUrl, apiKey, model, timeout, maxTokens } },
            });
            if (!persisted) {
                return res.status(500).json({
                    success: false,
                    error: `配置已在内存中生效，但写入磁盘失败：${configManager.lastSaveError || '未知原因'}。重启后改动会丢失。`,
                });
            }
            // 失效 LLM 服务缓存，下次惰性重建（独立服务无需重启即生效）
            if (typeof deps.resetLlmService === 'function') deps.resetLlmService();
            logger.info(`runtime.llm 配置已保存 (provider=${provider}, model=${model})`);
            res.json({ success: true, message: 'LLM 配置已保存并生效' });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    /**
     * POST /api/agent-theatre/llm-models - 拉取 LLM 可用模型列表。
     * 用请求体里的 provider/baseUrl/apiKey；apiKey 为掩码或空时回退已保存真 key。
     */
    app.post('/api/agent-theatre/llm-models', async (req, res) => {
        const body = req.body || {};
        const saved = configManager.get('runtime.llm') || {};
        const provider = body.provider || saved.provider || 'openai';
        const baseUrl = body.baseUrl || saved.baseUrl || '';
        let apiKey = body.apiKey || '';
        if (!apiKey || apiKey.includes('***') || /^\*+$/.test(apiKey)) apiKey = saved.apiKey || '';
        try {
            const models = await new LLMClient({ provider, baseUrl, apiKey, timeout: 20000 }).listModels();
            logger.info(`拉取模型列表成功 (${provider}): ${models.length} 个`);
            res.json({ success: true, models });
        } catch (error) {
            logger.warn(`拉取模型列表失败 (${provider}): ${error.message}`);
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // ==================== 正则表达式 API（Regex Engine） ====================

    /** GET /api/agent-theatre/regex - 列出正则脚本；带 ?character=X 时仅返回全局 + 该角色专属脚本 */
    app.get('/api/agent-theatre/regex', (req, res) => {
        const store = getRegexStore();
        if (!store) return res.status(503).json({ success: false, error: '正则引擎未初始化' });
        const character = (req.query && req.query.character || '').trim();
        if (character) {
            const scripts = store.getActiveScripts(character);
            res.json({ success: true, scripts, active: true, character });
        } else {
            res.json({ success: true, scripts: store.list(), active: false });
        }
    });

    /** POST /api/agent-theatre/regex - 创建正则脚本 */
    app.post('/api/agent-theatre/regex', (req, res) => {
        const store = getRegexStore();
        if (!store) return res.status(503).json({ success: false, error: '正则引擎未初始化' });
        const body = req.body || {};
        if (!body.scriptName || !body.findRegex) {
            return res.status(400).json({ success: false, error: '缺少 scriptName 或 findRegex' });
        }
        const v = validateRegex(body.findRegex);
        if (!v.valid) {
            return res.status(400).json({ success: false, error: '正则语法错误: ' + v.error });
        }
        try {
            const created = store.create(body);
            logger.info(`[regex] 创建脚本: ${created.scriptName} (${created.id})`);
            res.json({ success: true, script: created });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    /** PUT /api/agent-theatre/regex/:id - 更新正则脚本 */
    app.put('/api/agent-theatre/regex/:id', (req, res) => {
        const store = getRegexStore();
        if (!store) return res.status(503).json({ success: false, error: '正则引擎未初始化' });
        const body = req.body || {};
        if (body.findRegex) {
            const v = validateRegex(body.findRegex);
            if (!v.valid) {
                return res.status(400).json({ success: false, error: '正则语法错误: ' + v.error });
            }
        }
        const updated = store.update(req.params.id, body);
        if (!updated) return res.status(404).json({ success: false, error: '脚本不存在' });
        logger.info(`[regex] 更新脚本: ${updated.scriptName} (${updated.id})`);
        res.json({ success: true, script: updated });
    });

    /** DELETE /api/agent-theatre/regex/:id - 删除正则脚本 */
    app.delete('/api/agent-theatre/regex/:id', (req, res) => {
        const store = getRegexStore();
        if (!store) return res.status(503).json({ success: false, error: '正则引擎未初始化' });
        const ok = store.delete(req.params.id);
        if (!ok) return res.status(404).json({ success: false, error: '脚本不存在' });
        logger.info(`[regex] 删除脚本: ${req.params.id}`);
        res.json({ success: true });
    });

    /** POST /api/agent-theatre/regex/test - 测试正则表达式 */
    app.post('/api/agent-theatre/regex/test', (req, res) => {
        const body = req.body || {};
        const { findRegex, replaceString, testText } = body;
        const v = validateRegex(findRegex);
        if (!v.valid) {
            return res.json({ success: false, error: '正则语法错误: ' + v.error });
        }
        try {
            const result = getRegexedString(testText || '', REGEX_PLACEMENT.USER_INPUT, {
                scripts: [{
                    id: 'test',
                    scriptName: 'test',
                    findRegex,
                    replaceString: replaceString || '',
                    trimStrings: [],
                    placement: [REGEX_PLACEMENT.USER_INPUT, REGEX_PLACEMENT.AI_OUTPUT],
                    disabled: false,
                    markdownOnly: false,
                    promptOnly: false,
                    runOnEdit: true,
                    substituteRegex: 0,
                    minDepth: null,
                    maxDepth: null,
                }],
            });
            res.json({ success: true, result });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    /** POST /api/agent-theatre/regex/import-card - 从角色卡导入内嵌正则 */
    app.post('/api/agent-theatre/regex/import-card', async (req, res) => {
        const store = getRegexStore();
        if (!store) return res.status(503).json({ success: false, error: '正则引擎未初始化' });
        const { character } = req.body || {};
        if (!character) return res.status(400).json({ success: false, error: '缺少 character' });
        try {
            const { loadCharacterCardByName } = await import('./runtime/card-loader.js');
            const runtimeCfg = configManager.get('runtime') || {};
            const charDir = path.resolve(repoRoot, runtimeCfg.charactersDir || 'assets/characters');
            const card = loadCharacterCardByName(charDir, character);
            if (!card) return res.status(404).json({ success: false, error: '角色卡未找到' });
            const added = importRegexFromCard(card, character);
            logger.info(`[regex] 从角色卡 "${character}" 导入 ${added} 个正则脚本`);
            res.json({ success: true, added, total: store.list().length });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    /** POST /api/agent-theatre/regex/import-all - 一键导入全部角色卡内嵌正则 */
    app.post('/api/agent-theatre/regex/import-all', async (req, res) => {
        const store = getRegexStore();
        if (!store) return res.status(503).json({ success: false, error: '正则引擎未初始化' });
        try {
            const { loadCharacterCardByName } = await import('./runtime/card-loader.js');
            const runtimeCfg = configManager.get('runtime') || {};
            const charDir = path.resolve(repoRoot, runtimeCfg.charactersDir || 'assets/characters');
            if (!fs.existsSync(charDir) || !fs.statSync(charDir).isDirectory()) {
                return res.status(404).json({ success: false, error: `角色卡目录不存在: ${charDir}` });
            }
            const files = fs.readdirSync(charDir);
            const entries = [];
            let checked = 0;
            let imported = 0;
            for (const f of files) {
                const ext = path.extname(f).toLowerCase();
                // 仅处理角色卡文件（.png / .json）；目录与无关文件跳过
                if (ext !== '.png' && ext !== '.json') continue;
                checked++;
                const charName = path.basename(f, path.extname(f));
                const card = loadCharacterCardByName(charDir, f);
                if (!card) continue;
                const added = importRegexFromCard(card, charName);
                if (added > 0) {
                    imported += added;
                    entries.push({ character: charName, added });
                }
            }
            logger.info(`[regex] 一键导入完成: 检查 ${checked} 张角色卡，新增 ${imported} 个正则脚本`);
            res.json({ success: true, checked, added: imported, total: store.list().length, characters: entries });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    /** GET /api/agent-theatre/state - 当前会话状态（P4-1：返回当前角色卡槽状态） */
    app.get('/api/agent-theatre/state', (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        const sess = theatreSessions.get(sessionKey);
        if (!sess) {
            return res.json({
                success: true,
                session: sessionKey,
                active: false,
                message: '会话尚未开始',
            });
        }
        const cs = charState(sess, sess.character || '');
        res.json({
            success: true,
            session: sessionKey,
            active: true,
            profile: sess.profile,
            character: sess.character || '',
            turn: cs.turn,
            lastRunId: cs.lastRunId,
            lastResult: cs.lastResult,
            // 历史快照（含稳定 id）：前端编辑/删除失败后按此重新对齐楼层模型，
            // 避免楼层与服务端历史因截断/并发产生索引漂移后持续报"索引越界"。
            history: (cs.history || []).slice(-100).map(m => ({
                id: m.id || ensureMsgId(m, m.role).id,
                role: m.role,
                content: m.content,
            })),
            // ST 兼容（P0）：MVU 变量快照 + 变更历史 + 编年史（前端变量查看器 / 状态栏 / 编年史恢复用）
            variables: {
                stat_data: (cs.mvu && cs.mvu.stat_data) || {},
                changed: !!(cs.mvu && cs.mvu.changed),
                initSource: (cs.mvu && cs.mvu.initSource) || '',
                lastUpdate: (cs.mvu && cs.mvu.lastUpdate) || null,
            },
            mvuHistory: ((cs.mvu && cs.mvu.history) || []).slice(-10),
            chronicle: cs.chronicle || [],
        });
    });

    /**
     * GET /api/user-profile - 读取用户自定义角色配置（自定义用户名 + 人设）。
     * 供 Agent 前端配置页使用；受现有 X-Gateway-Token 全局鉴权保护。
     */
    app.get('/api/user-profile', (req, res) => {
        res.json({ success: true, profile: userProfile.get() });
    });

    /**
     * POST /api/user-profile - 保存用户自定义角色配置。
     * body: { name?, persona? }；清洗规则见 user-profile-store（name ≤32 空则回退 'user'、
     * persona ≤2000 非字符串则 ''）。
     */
    app.post('/api/user-profile', (req, res) => {
        try {
            const body = req.body || {};
            const profile = userProfile.save({
                name: body.name,
                persona: body.persona,
            });
            res.json({ success: true, profile });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    /**
     * POST /api/agent-theatre/history-sync - 前端本地历史同步（P1-5 + P4-1 角色隔离）。
     *
     * 背景：theatreSessions 为进程级内存态，服务重启后清空；前端 localStorage 仍保留楼层。
     * 刷新页面后若不回填，下一轮 /input 时 LLM 只剩当前消息，上下文断裂。
     *
     * 规则：仅当服务端"该角色卡槽"历史为空（重启场景）时，才采纳客户端历史（上限 100 条）；
     * 服务端已有历史（用户在刷新后继续聊过）则以服务端为准，避免覆盖更新数据。
     * P4-1：history 按 body.character 归入对应角色卡槽——不同角色的本地历史互不串扰。
     *
     * body: { session?, character?, history: Array<{role, content}> }
     */
    app.post('/api/agent-theatre/history-sync', (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        const body = req.body || {};
        const character = body.character || '';
        const clientHistory = Array.isArray(body.history) ? body.history : [];
        const valid = clientHistory.filter(m =>
            m && typeof m.content === 'string'
            && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'));
        if (valid.length === 0) {
            return res.json({ success: true, merged: 0 });
        }

        let sess = theatreSessions.get(sessionKey);
        if (!sess) {
            sess = { profile: 'default-rp' };
            theatreSessions.set(sessionKey, sess);
        }
        if (character) sess.character = character;
        const cs = charState(sess, character || sess.character || '');
        let merged = 0;
        if (cs.history.length === 0) {
            cs.history = valid.slice(-100).map(m => ensureMsgId(m, m.role));
            merged = cs.history.length;
            logger.info(`[theatre] history-sync: 角色「${character || '(无角色)'}」服务端为空，采纳客户端 ${merged} 条历史（${sessionKey}）`);
        }
        res.json({ success: true, merged, serverLength: cs.history.length });
    });

    /**
     * POST /api/agent-theatre/variables-set - 初始化 / 覆盖 MVU stat_data 快照（ST 兼容）。
     *
     * 背景：ST 中 MVU 由 `[initvar]初始` 世界书条目 + zod schema 自动初始化；
     * agent 剧场没有该通道，改为由前端"初始化变量"弹窗提供初始变量表 JSON。
     *
     * body: { session?, character?, variables: object }（stat_data 整体替换）
     */
    app.post('/api/agent-theatre/variables-set', (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        const body = req.body || {};
        const character = body.character || '';
        let sess = theatreSessions.get(sessionKey);
        if (!sess) {
            sess = { profile: 'default-rp' };
            theatreSessions.set(sessionKey, sess);
        }
        if (character) sess.character = character;
        const cs = charState(sess, character || sess.character || '');
        const vars = body.variables && typeof body.variables === 'object' ? body.variables : {};
        cs.mvu = cs.mvu || {};
        cs.mvu.stat_data = structuredClone(vars);
        cs.mvu.changed = true;
        cs.mvu.lastUpdate = { at: Date.now(), count: 1, via: 'manual' };
        cs.mvu.initSource = character || '';
        cs.mvu.history = cs.mvu.history || [];
        cs.mvu.history.push({ turn: cs.turn || 0, ts: Date.now(), via: 'manual', commands: [{ op: 'replace', path: '/', value: vars }] });
        if (cs.mvu.history.length > 50) cs.mvu.history = cs.mvu.history.slice(-50);
        theatreBroadcaster.broadcastResult(sessionKey, {
            runId: '',
            result: null,
            text: '',
            variables: { stat_data: cs.mvu.stat_data, changed: true, initSource: character || '' },
            chronicle: cs.chronicle || [],
            mvuHistory: (cs.mvu.history || []).slice(-10),
        });
        logger.info(`[theatre] variables-set: 角色「${character || '(无角色)'}」stat_data 已更新（${Object.keys(vars).length} 顶层键）`);
        res.json({
            success: true,
            variables: { stat_data: cs.mvu.stat_data, changed: true, initSource: character || '' },
            chronicle: cs.chronicle || [],
            mvuHistory: (cs.mvu.history || []).slice(-10),
        });
    });

    /**
     * POST /api/agent-theatre/variables-reset - 重置该角色卡槽的变量快照与编年史（切换/清档用）。
     * body: { session?, character? }
     */
    app.post('/api/agent-theatre/variables-reset', (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        const body = req.body || {};
        const character = body.character || '';
        const sess = theatreSessions.get(sessionKey);
        if (!sess) {
            return res.json({ success: true, cleared: 0 });
        }
        const cs = charState(sess, character || sess.character || '');
        cs.mvu = { stat_data: {}, changed: false, history: [], lastUpdate: null, initSource: '' };
        cs.chronicle = [];
        logger.info(`[theatre] variables-reset: 角色「${character || '(无角色)'}」变量与编年史已重置（${sessionKey}）`);
        res.json({ success: true, cleared: 1 });
    });

    // ==================== 脚本库 API（对标酒馆助手 Tavern-Helper 脚本库） ====================

    /** 解析脚本作用域：scope（global/character）+ character */
    function scriptCtx(req) {
        const body = req.body || {};
        const scope = ((req.query.scope || body.scope || 'global') === 'character') ? 'character' : 'global';
        const character = req.query.character || body.character || '';
        return { scope, character };
    }

    /** 列表（脚本 + 该作用域变量） */
    app.get('/api/agent-theatre/scripts', (req, res) => {
        const { scope, character } = scriptCtx(req);
        res.json({
            success: true, scope, character,
            scripts: scriptStore.listScripts(scope, character),
            variables: scriptStore.getVariables(scope, character),
        });
    });

    /** 取单个脚本全文（含内容，前端编辑器加载用） */
    app.get('/api/agent-theatre/scripts/:id', (req, res) => {
        const { scope, character } = scriptCtx(req);
        const script = scriptStore.getScript(scope, character, req.params.id);
        if (!script) return res.status(404).json({ success: false, error: '脚本不存在' });
        res.json({ success: true, script: toExportableScript(script) });
    });

    /** 新建空白脚本 */
    app.post('/api/agent-theatre/scripts', (req, res) => {
        const { scope, character } = scriptCtx(req);
        const body = req.body || {};
        const script = scriptStore.createScript({
            scope, character,
            name: body.name || '', content: body.content || '', info: body.info || '',
        });
        res.json({ success: true, script });
    });

    /** 更新脚本（保存自动留版本快照） */
    app.put('/api/agent-theatre/scripts/:id', (req, res) => {
        const { scope, character } = scriptCtx(req);
        const script = scriptStore.updateScript({ scope, character, id: req.params.id, patch: req.body || {} });
        if (!script) return res.status(404).json({ success: false, error: '脚本不存在' });
        res.json({ success: true, script });
    });

    /** 删除脚本 */
    app.delete('/api/agent-theatre/scripts/:id', (req, res) => {
        const { scope, character } = scriptCtx(req);
        const ok = scriptStore.deleteScript({ scope, character, id: req.params.id });
        res.json({ success: ok });
    });

    /** 运行脚本（手动执行 / 按钮触发）：body: { buttonName?, eventType?, args? } */
    app.post('/api/agent-theatre/scripts/:id/run', async (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        const { scope, character } = scriptCtx(req);
        const body = req.body || {};
        const script = scriptStore.getScript(scope, character, req.params.id);
        if (!script) return res.status(404).json({ success: false, error: '脚本不存在' });
        try {
            const r = await scriptEngine.runScript({
                sessionKey,
                scope,
                character: character || theatreSessions.get(sessionKey)?.character || '',
                script,
                buttonName: body.buttonName,
                eventType: body.eventType,
                args: body.args || {},
            });
            res.json({ success: r.ok, ...r });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message, logs: [] });
        }
    });

    /** 版本列表 */
    app.get('/api/agent-theatre/scripts/:id/versions', (req, res) => {
        const { scope, character } = scriptCtx(req);
        res.json({ success: true, versions: scriptStore.getVersions(scope, character, req.params.id) });
    });

    /** 回滚到某版本：body: { ts } */
    app.post('/api/agent-theatre/scripts/:id/restore', (req, res) => {
        const { scope, character } = scriptCtx(req);
        const body = req.body || {};
        const script = scriptStore.restoreVersion(scope, character, req.params.id, body.ts);
        if (!script) return res.status(404).json({ success: false, error: '版本不存在' });
        res.json({ success: true, script });
    });

    /** 手动导入：body: { scope?, character?, scripts: ScriptTree[] } 或 { name, content } */
    app.post('/api/agent-theatre/scripts/import', (req, res) => {
        const { scope, character } = scriptCtx(req);
        const body = req.body || {};
        let list = [];
        if (Array.isArray(body.scripts)) list = body.scripts;
        else if (body.name !== undefined && body.content !== undefined) {
            list = [{ name: body.name, content: body.content, info: body.info || '' }];
        }
        const r = scriptStore.importScripts(scope, character, list);
        res.json({ success: true, ...r });
    });

    /** 从角色卡同步导入 tavern_helper 脚本与变量（角色加载时前端可手动触发） */
    app.post('/api/agent-theatre/scripts/sync', async (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        const name = req.body?.character || theatreSessions.get(sessionKey)?.character || '';
        if (!name) return res.json({ success: false, error: '未指定角色卡' });
        try {
            const { loadCharacterCardByName } = await import('./runtime/card-loader.js');
            const runtimeCfg = configManager.get('runtime') || {};
            const charDir = path.resolve(repoRoot, runtimeCfg.charactersDir || 'assets/characters');
            const card = loadCharacterCardByName(charDir, name);
            if (!card) return res.json({ success: false, error: `角色卡「${name}」未找到` });
            const { scripts } = extractCardScripts(card);
            if (scripts.length) scriptStore.importScripts('character', name, scripts, { autoDisable: true });
            const { variables } = extractCardScripts(card);
            if (variables && Object.keys(variables).length) scriptStore.importVariables(name, variables);
            res.json({ success: true, imported: scripts.length, variablesImported: !!Object.keys(variables).length });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    /**
     * POST /api/agent-theatre/history-truncate - 读档截断（ST 兼容）。
     *
     * 背景：ST 读档 = `/branch-create <楼层>` 从该楼层创建分支；agent 剧场以会话历史为上下文，
     * 等价实现为"截断到指定消息条数"（前端配合把楼层裁到该轮）。
     *
     * body: { session?, character?, keepMessages: number }（保留前 N 条消息）
     */
    app.post('/api/agent-theatre/history-truncate', (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        const body = req.body || {};
        const character = body.character || '';
        const keep = Math.max(0, Math.floor(Number(body.keepMessages) || 0));
        const sess = theatreSessions.get(sessionKey);
        if (!sess) {
            return res.json({ success: true, keepMessages: 0 });
        }
        const cs = charState(sess, character || sess.character || '');
        if (!Array.isArray(cs.history)) cs.history = [];
        const before = cs.history.length;
        if (keep < before) {
            cs.history = cs.history.slice(0, keep);
            // 截断后该槽的"最后结果/输入"一并失效，防止选项回调误触旧轮
            cs.lastResult = null;
            cs.lastInput = '';
            cs.dirty = true;
            logger.info(`[theatre] history-truncate: 角色「${character || '(无角色)'}」${before} → ${keep} 条（${sessionKey}）`);
        }
        res.json({ success: true, keepMessages: cs.history.length, truncated: before - cs.history.length });
    });

    // ==================== 聊天记录存储 API（Agent 剧场聊天存档） ====================
    //
    // 后端聊天记录存储机制：数据落在 <dataRoot>/chats/<角色>/<角色>_<时间戳>.jsonl，
    // 与 SillyTavern 互通（复用 ChatArchive JSONL 格式），存储逻辑见 server/runtime/chat-store.js。
    // 所有文件操作均做路径安全校验，防目录穿越。

    /**
     * GET /api/agent-theatre/chats - 聊天记录列表（分页/过滤/排序）。
     * query: character / keyword / from / to / page / pageSize / sort
     * 响应附带当前会话状态 session: { chatFile, dirty, lastSavedAt, savedAt }。
     */
    app.get('/api/agent-theatre/chats', (req, res) => {
        try {
            const q = req.query || {};
            const result = listChats(activeChatDataRoot, {
                character: q.character,
                keyword: q.keyword,
                from: q.from != null ? Number(q.from) : undefined,
                to: q.to != null ? Number(q.to) : undefined,
                page: q.page != null ? Number(q.page) : undefined,
                pageSize: q.pageSize != null ? Number(q.pageSize) : undefined,
                sort: q.sort || 'updated',
            });
            const sessionKey = _theatreSessionKey(req);
            const sess = theatreSessions.get(sessionKey);
            const cs = sess ? charState(sess, sess.character || '') : null;
            res.json({
                success: true,
                ...result,
                session: cs ? {
                    character: sess.character || '',
                    chatFile: cs.chatFile || null,
                    dirty: !!cs.dirty,
                    lastSavedAt: cs.lastSavedAt || null,
                    savedAt: cs.savedAt || null,
                } : null,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /** GET /api/agent-theatre/chats/read - 读取一条聊天记录（query.file） */
    app.get('/api/agent-theatre/chats/read', (req, res) => {
        try {
            const file = req.query && req.query.file;
            if (!file) return res.status(400).json({ success: false, error: '缺少 file 参数' });
            const chat = readChat(activeChatDataRoot, file);
            if (!chat) return res.status(404).json({ success: false, error: '聊天记录不存在或路径非法' });
            // 补发消息稳定 ID（旧存档无 id），供前端楼层 userId/pageIds 对齐
            if (Array.isArray(chat.messages)) {
                chat.messages = chat.messages.map(m => ensureMsgId(m, m.role));
            }
            res.json({ success: true, chat });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /**
     * POST /api/agent-theatre/chats/save - 保存聊天记录。
     * body: { character, messages:[{role,content}], userName, prevFile? }
     * 未带 messages 时保存当前剧场会话的"当前角色卡槽"历史（找不到会话返回 404）。
     * P4-1：保存后更新该角色卡槽的 chatFile/dirty 等状态。
     */
    app.post('/api/agent-theatre/chats/save', (req, res) => {
        try {
            const body = req.body || {};
            const sessionKey = _theatreSessionKey(req);
            const sess = theatreSessions.get(sessionKey);
            let messages = body.messages;
            let character = body.character;
            let cs = null;
            if (!Array.isArray(messages)) {
                if (!sess) {
                    return res.status(404).json({ success: false, error: '未找到可保存的会话历史，请先提供 messages 或创建会话' });
                }
                cs = charState(sess, character || sess.character || '');
                if (cs.history.length === 0) {
                    return res.status(404).json({ success: false, error: '未找到可保存的会话历史，请先提供 messages 或创建会话' });
                }
                messages = cs.history;
                character = character || sess.character || '';
            } else if (sess) {
                cs = charState(sess, character || sess.character || '');
            }
            const result = saveChat(activeChatDataRoot, {
                character: character || '',
                messages,
                userName: body.userName || sess?.userName || 'User',
                prevFile: (cs?.chatFile) || body.prevFile || undefined,
                name: typeof body.name === 'string' ? body.name : undefined,
                description: typeof body.description === 'string' ? body.description : undefined,
            });
            if (result.ok && cs) {
                cs.chatFile = result.file;
                cs.dirty = false;
                cs.savedAt = result.savedAt;
                cs.lastSavedAt = Date.now();
            }
            res.json({ success: result.ok, ...result });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /**
     * POST /api/agent-theatre/chats/load - 加载聊天记录到当前会话。
     * body: { file } -> 写入"载入档角色卡槽"的 history（角色卡名同步 sess.character）、
     * 更新该卡槽 chatFile、广播 chat_loaded 事件。
     * P4-1：载入档只写入该角色自己的卡槽——若用户随后切到其它角色，历史互不串扰。
     */
    app.post('/api/agent-theatre/chats/load', (req, res) => {
        try {
            const file = req.body && req.body.file;
            if (!file) return res.status(400).json({ success: false, error: '缺少 file 参数' });
            const chat = readChat(activeChatDataRoot, file);
            if (!chat) return res.status(404).json({ success: false, error: '聊天记录不存在或路径非法' });

            const sessionKey = _theatreSessionKey(req);
            const sess = theatreSessions.get(sessionKey) || { profile: 'default-rp' };
            const loadedChar = chat.character || sess.character || '';
            const cs = charState(sess, loadedChar);
            cs.history = chat.messages
                .filter((m) => m.role !== 'system')
                .map((m) => ensureMsgId({ role: m.role, content: m.content }, m.role));
            cs.turn = Math.floor(cs.history.length / 2);
            if (chat.character) sess.character = chat.character; // 角色卡名同步
            cs.chatFile = file;
            cs.dirty = false;
            theatreSessions.set(sessionKey, sess);

            // 广播 chat_loaded 事件给该会话的所有订阅者
            if (typeof theatreBroadcaster.broadcast === 'function') {
                theatreBroadcaster.broadcast(sessionKey, 'chat_loaded', {
                    file,
                    character: chat.character || '',
                    messageCount: cs.history.length,
                });
            }

            res.json({ success: true, character: chat.character || '', messages: cs.history });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /** POST /api/agent-theatre/chats/delete - 批量删除聊天记录（body.files 数组） */
    app.post('/api/agent-theatre/chats/delete', (req, res) => {
        try {
            const files = Array.isArray(req.body && req.body.files) ? req.body.files : [];
            if (files.length === 0) return res.status(400).json({ success: false, error: '缺少 files 数组' });
            const result = deleteChats(activeChatDataRoot, files);
            // 存档操作日志（支持问题追溯与数据恢复）
            _logArchiveOp('delete', files, result);
            res.json({ success: true, ...result });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /**
     * POST /api/agent-theatre/chats/archive-create - 为指定角色卡新建空存档（多存档管理）。
     * body: { character, name?, description? }
     * 只创建 <dataRoot>/chats/<角色>/ 下的存档文件，与角色卡基础数据完全隔离。
     */
    app.post('/api/agent-theatre/chats/archive-create', (req, res) => {
        try {
            const body = req.body || {};
            const character = String(body.character || '').trim();
            const result = createArchive(activeChatDataRoot, {
                character,
                name: typeof body.name === 'string' ? body.name : '',
                description: typeof body.description === 'string' ? body.description : '',
            });
            if (!result.ok) return res.status(500).json({ success: false, error: result.error || '创建存档失败' });
            _logArchiveOp('create', [result.file], { ok: true });
            res.json({ success: true, ...result });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /** POST /api/agent-theatre/chats/archive-meta - 更新存档元数据（名称/描述） */
    app.post('/api/agent-theatre/chats/archive-meta', (req, res) => {
        try {
            const body = req.body || {};
            const file = body.file;
            if (!file || typeof file !== 'string') {
                return res.status(400).json({ success: false, error: '缺少 file 参数' });
            }
            const result = updateArchiveMeta(activeChatDataRoot, file, {
                name: typeof body.name === 'string' ? body.name : undefined,
                description: typeof body.description === 'string' ? body.description : undefined,
            });
            if (!result.ok) return res.status(500).json({ success: false, error: result.error || '更新存档元数据失败' });
            _logArchiveOp('meta', [file], { ok: true });
            res.json({ success: true, ...result });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /**
     * POST /api/agent-theatre/chats/migrate - 迁移旧版聊天存档到新层级结构。
     * 旧目录取 runtime.chatsDir（默认 <网关仓库>/data/chats，可指向 SillyTavern 的 chats 目录），
     * 支持平铺与「角色卡/xxx.jsonl」子目录结构；复制而非移动，幂等。
     * 响应附带 legacyDir 供前端提示用户旧档目录位置。
     */
    app.post('/api/agent-theatre/chats/migrate', (req, res) => {
        try {
            const runtimeCfg = (typeof configManager.get === 'function' ? configManager.get('runtime') : null) || {};
            const legacyChatsDir = path.resolve(repoRoot, runtimeCfg.chatsDir || 'data/chats');
            const result = migrateLegacy(activeChatDataRoot, legacyChatsDir);
            res.json({ success: true, legacyDir: legacyChatsDir, ...result });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /** POST /api/agent-theatre/chats/clear-session - 清空当前会话并删除关联文件（P4-1：只清当前角色卡槽） */
    app.post('/api/agent-theatre/chats/clear-session', (req, res) => {
        try {
            const sessionKey = _theatreSessionKey(req);
            const sess = theatreSessions.get(sessionKey);
            if (!sess) return res.json({ success: true, cleared: false, message: '会话不存在' });
            const cs = charState(sess, sess.character || '');
            let deleted = 0;
            if (cs.chatFile) {
                const r = deleteChats(activeChatDataRoot, [cs.chatFile]);
                deleted = r.deleted;
            }
            cs.history = [];
            cs.chatFile = null;
            cs.dirty = false;
            cs.lastSavedAt = null;
            cs.savedAt = null;
            cs.lastInput = '';
            cs.lastResult = null;
            res.json({ success: true, cleared: true, deleted });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /**
     * POST /api/agent-theatre/messages/edit - 编辑单条消息内容。
     * body: { session?, character?, messageIndex, newContent }
     * - messageIndex: cs.history 数组中的索引
     * - newContent: 新的消息文本
     * 编辑后自动标记 dirty 触发自动保存；记录编辑历史（原始内容 + 时间戳）。
     */
    app.post('/api/agent-theatre/messages/edit', (req, res) => {
        try {
            const sessionKey = _theatreSessionKey(req);
            const sess = theatreSessions.get(sessionKey);
            if (!sess) return res.status(404).json({ success: false, error: '会话不存在' });
            const character = req.body.character || sess.character || '';
            const cs = charState(sess, character);
            const { messageId, messageIndex } = req.body;
            const newContent = req.body.newContent;
            const located = locateMessage(cs, messageId, messageIndex);
            if (!located) {
                // messageId 定位失败 = 目标已被截断/移除；索引越界附带当前长度便于前端诊断
                const hint = (typeof messageId === 'string' && messageId.length > 0)
                    ? '消息不存在或已被移除（历史截断/清空）'
                    : `消息索引越界（history=${cs.history.length}）`;
                return res.status(messageId ? 404 : 400).json({ success: false, error: hint });
            }
            if (typeof newContent !== 'string' || newContent.length === 0)
                return res.status(400).json({ success: false, error: '新内容不能为空' });

            const msg = located.msg;
            const originalContent = msg.content;
            // 记录编辑历史
            if (!msg.editHistory) msg.editHistory = [];
            msg.editHistory.push({
                originalContent,
                editedAt: Date.now(),
            });
            msg.content = newContent;
            msg.editedAt = Date.now();
            cs.dirty = true;
            theatreSessions.set(sessionKey, sess);

            res.json({
                success: true,
                message: { id: msg.id, role: msg.role, content: msg.content, editedAt: msg.editedAt },
                editCount: msg.editHistory.length,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /**
     * POST /api/agent-theatre/messages/delete - 删除单条消息。
     * body: { session?, character?, messageIndex 或 messageId }
     * 从 cs.history 中移除指定消息，标记 dirty 触发自动保存。
     * messageId 优先：抗历史截断/并发导致的索引漂移（越界报错的根因修复）。
     */
    app.post('/api/agent-theatre/messages/delete', (req, res) => {
        try {
            const sessionKey = _theatreSessionKey(req);
            const sess = theatreSessions.get(sessionKey);
            if (!sess) return res.status(404).json({ success: false, error: '会话不存在' });
            const character = req.body.character || sess.character || '';
            const cs = charState(sess, character);
            const { messageId, messageIndex } = req.body;
            const located = locateMessage(cs, messageId, messageIndex);
            if (!located) {
                const hint = (typeof messageId === 'string' && messageId.length > 0)
                    ? '消息不存在或已被移除（历史截断/清空）'
                    : `消息索引越界（history=${cs.history.length}）`;
                return res.status(messageId ? 404 : 400).json({ success: false, error: hint });
            }

            const deleted = cs.history.splice(located.index, 1)[0];
            cs.dirty = true;
            theatreSessions.set(sessionKey, sess);

            res.json({
                success: true,
                deleted: { id: deleted.id, role: deleted.role },
                remainingCount: cs.history.length,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /**
     * GET /api/agent-theatre/messages/edit-history - 查询消息编辑历史。
     * query: ?session=&character=&messageIndex= 或 ?messageId=
     */
    app.get('/api/agent-theatre/messages/edit-history', (req, res) => {
        try {
            const sessionKey = _theatreSessionKey(req);
            const sess = theatreSessions.get(sessionKey);
            if (!sess) return res.json({ success: true, editHistory: [] });
            const character = (req.query.character || sess.character || '');
            const cs = charState(sess, character);
            const located = locateMessage(cs, req.query.messageId, req.query.messageIndex);
            if (!located) return res.json({ success: true, editHistory: [], notFound: true });

            const msg = located.msg;
            res.json({
                success: true,
                editHistory: msg.editHistory || [],
                editedAt: msg.editedAt || null,
                currentContent: msg.content,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ==================== AI 辅助修改 Profile（自然语言改配置） ====================
    //
    // 让无编程经验的用户用大白话修改 Agent Profile YAML。流程：
    //   1. /plan   调 LLM 生成结构化修改方案（不落盘），前端预览
    //   2. /apply  用户确认后写入，写入前先把当前 YAML 快照入栈（可撤销）
    //   3. /undo   从快照栈弹出最近一份覆盖回去
    //   4. /history 查询可撤销步数
    //
    // 处理逻辑封装在 server/ai-modifier.js，依赖通过工厂注入，便于单元测试。

    const aiModifierStore = createProfileStore({
        getAgentFramework: () => getPluginManager()?.loader?.getPlugin('agent-framework'),
    });
    const aiModifierHandlers = createAiModifierHandlers({
        getLlmService: () => getLlmService(),
        readCurrentYaml: aiModifierStore.readCurrentYaml,
        writeYaml: aiModifierStore.writeYaml,
        history: aiModifyHistory,
        logger,
    });

    /** POST /api/agent-theatre/ai-modify/plan - 生成修改方案（不实际应用） */
    app.post('/api/agent-theatre/ai-modify/plan', aiModifierHandlers.plan);

    /** POST /api/agent-theatre/ai-modify/apply - 应用修改（先快照当前 YAML） */
    app.post('/api/agent-theatre/ai-modify/apply', aiModifierHandlers.apply);

    /** POST /api/agent-theatre/ai-modify/undo - 撤销上次修改 */
    app.post('/api/agent-theatre/ai-modify/undo', aiModifierHandlers.undo);

    /** GET /api/agent-theatre/ai-modify/history - 查询撤销历史计数 */
    app.get('/api/agent-theatre/ai-modify/history', aiModifierHandlers.history);

    // ==================== Agent 前端 URL 校验 API ====================
    //
    // 供独立 Agent 前端页面（public/agent.html）"验证"按钮调用。
    // 注册在 /api/* 全局鉴权中间件之后，自动受 X-Gateway-Token 保护。
    // 逻辑抽在 server/agent-frontend.js（纯函数 + 可注入 fetch），
    // 见 test/agent-frontend.test.js。
    app.post('/api/agent-frontend/validate', createAgentFrontendValidateHandler({}));

    // ==================== Agent 前端静态页面（公开，无需鉴权） ====================
    //
    // public/agent.{html,css,js} 是独立 Agent 前端（Agent 设置 + Agent 剧场），
    // 通过 /agent 访问。页面本身不需要鉴权（公开静态页，不含敏感数据）；
    // 页面内所有 API 请求由前端自行携带 X-Gateway-Token。
    app.use(express.static(staticDir));
    app.get('/agent', (req, res) => {
        const file = path.join(staticDir, 'agent.html');
        if (!fs.existsSync(file)) {
            return res.status(404).send('agent.html not found');
        }
        res.sendFile(file);
    });

    logger.info('Agent API 已注册（agents / agent-theatre / agent-frontend / /agent 静态页）');
}

export default { registerAgentApi };
