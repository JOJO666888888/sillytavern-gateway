/**
 * SillyTavern 兼容前端桥（ST Compat Shim）
 *
 * 让真实 SillyTavern 前端直连网关：模拟 ST 的 /api/* 契约，复用网关 assets/
 * 资产目录与 Agent 引擎。**不引入 ST 源码**，用户自带前端，网关只做路由 shim
 * + 资产读写。
 *
 * 设计要点（见 spec.md "Scenario: ST 兼容前端桥" 与 PROTOTYPE.md §3.5）：
 *   - 资产读写复用 card-loader / preset-engine / worldbook-engine 的解析能力
 *   - 写操作防路径穿越：所有用户输入的 name/fileId 经 _safeName 校验
 *   - /api/generate 双模式：
 *       * Agent 模式（请求体 agentMode=true 或配置 runtime.agentMode=true）：
 *         调 ctx.agent.run，回传 result.getMainText() 作为 ST 期望的 message
 *       * 非 Agent 模式：透传到现有 nativeRuntime.generate（若启用）
 *
 * 路由处理函数以工厂形式接收依赖（避免直接 import 单例，便于测试 mock）。
 */

import fs from 'fs';
import path from 'path';
import { listCharacterCards, loadCharacterCard, normalizeCard } from '../runtime/card-loader.js';
import { listPresetEntries, loadPreset, normalizePreset, defaultPreset } from '../runtime/preset-engine.js';
import { loadLorebook, normalizeLorebook } from '../runtime/worldbook-engine.js';
import { listArchives } from '../runtime/chat-archive.js';

/**
 * 把用户输入的 name 规整为安全的文件名段，杜绝路径穿越。
 * - 仅允许字母/数字/下划线/连字符/点（不含路径分隔符与 ..）
 * - 长度限制 100，避免过长
 * - 返回空字符串表示输入非法
 * @param {string} name
 * @returns {string}
 */
function _safeName(name) {
    if (name == null) return '';
    const s = String(name).trim();
    if (!s) return '';
    // 拒绝路径穿越尝试
    if (s.includes('..') || s.includes('/') || s.includes('\\')) return '';
    // 允许中文等 Unicode 字母，但拒绝控制字符
    if (/[\x00-\x1f]/.test(s)) return '';
    if (s.length > 100) return '';
    return s;
}

/**
 * 构造 ST 兼容路由处理函数集合。
 *
 * @param {object} deps
 * @param {object} deps.dirs - 资产目录 {characters, worldbooks, presets, chats}
 * @param {object} [deps.nativeRuntime] - 自建推理管线实例（可选；非 Agent 模式 generate 回退用）
 * @param {object} [deps.agentService] - Agent 框架服务（含 run 方法）；Agent 模式 generate 必需
 * @param {object} [deps.llmService] - LLM 服务（含 runTools）；Agent 模式 generate 必需
 * @param {object} [deps.configManager] - 配置管理器（读 runtime.agentMode 全局开关）
 * @param {object} [deps.logger]
 * @returns {Record<string, Function>} Express 风格的路由处理函数
 */
export function createStShim(deps = {}) {
    const {
        dirs = {},
        nativeRuntime = null,
        agentService = null,
        llmService = null,
        configManager = null,
        logger = console,
    } = deps;

    /**
     * 判断 /api/generate 是否走 Agent 模式：
     * 请求体显式带 agentMode 字段优先；否则读 config.runtime.agentMode 全局开关。
     * @param {object} body
     * @returns {boolean}
     */
    function shouldUseAgentMode(body) {
        if (body && typeof body.agentMode === 'boolean') return body.agentMode;
        if (configManager) {
            return configManager.get('runtime.agentMode') === true;
        }
        return false;
    }

    /** 确保资产目录存在（首次访问时建好） */
    function ensureDir(d) {
        if (d && !fs.existsSync(d)) {
            try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
        }
    }
    ensureDir(dirs.characters);
    ensureDir(dirs.worldbooks);
    ensureDir(dirs.presets);
    ensureDir(dirs.chats);

    // ==================== 角色卡 ====================

    /** GET /api/characters - 列出角色卡 */
    function listCharacters(req, res) {
        try {
            const list = listCharacterCards(dirs.characters).map(c => ({
                name: c.name,
                file: path.basename(c.file),
                // ST 期望的字段：avatar + 字段名
                avatar: c.name,
                spec: 'chara_card_v2',
            }));
            res.json(list);
        } catch (e) {
            logger.error?.(`[st-shim] 列出角色卡失败: ${e.message}`);
            res.status(500).json({ error: '列出角色卡失败: ' + e.message });
        }
    }

    /** GET /api/characters/:name - 读取角色卡 JSON（含 data 嵌套，兼容 ST V2/V3） */
    function getCharacter(req, res) {
        const name = _safeName(req.params.name);
        if (!name) return res.status(400).json({ error: '非法的角色名' });
        try {
            // 找到 .png 或 .json 文件
            const candidates = ['.png', '.json']
                .map(ext => path.join(dirs.characters, name + ext))
                .filter(f => fs.existsSync(f));
            if (candidates.length === 0) {
                return res.status(404).json({ error: `角色卡不存在: ${name}` });
            }
            const card = loadCharacterCard(candidates[0]);
            // ST 期望 V2 结构：{ spec, data: {...} }
            const stCard = {
                spec: card.spec || 'chara_card_v2',
                data: {
                    name: card.name,
                    description: card.description,
                    personality: card.personality,
                    scenario: card.scenario,
                    first_mes: card.firstMes,
                    mes_example: card.mesExample,
                    system_prompt: card.systemPrompt,
                    post_history_instructions: card.postHistoryInstructions,
                    alternate_greetings: card.alternateGreetings,
                    character_book: card.characterBook,
                    tags: card.tags,
                    creator: card.creator,
                    character_version: card.characterVersion,
                    creator_notes: card.creatorNotes,
                    extensions: card.extensions,
                },
            };
            res.json(stCard);
        } catch (e) {
            logger.error?.(`[st-shim] 读取角色卡失败 ${name}: ${e.message}`);
            res.status(500).json({ error: '读取角色卡失败: ' + e.message });
        }
    }

    /** POST /api/characters - 创建/更新角色卡（ST 把整张卡 POST 过来） */
    function writeCharacter(req, res) {
        const body = req.body || {};
        const data = body.data || body; // 兼容 V2 嵌套 / V1 扁平
        const name = _safeName(data.name || body.name);
        if (!name) return res.status(400).json({ error: '角色卡缺少 name 字段' });
        try {
            const file = path.join(dirs.characters, name + '.json');
            fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf-8');
            logger.info?.(`[st-shim] 角色卡已保存: ${name}`);
            res.json({ name, file: path.basename(file) });
        } catch (e) {
            logger.error?.(`[st-shim] 保存角色卡失败 ${name}: ${e.message}`);
            res.status(500).json({ error: '保存角色卡失败: ' + e.message });
        }
    }

    // ==================== 聊天存档 ====================

    /** GET /api/chats/:characterName - 列出该角色的聊天存档（.jsonl 文件名，去扩展名） */
    function listChats(req, res) {
        const name = _safeName(req.params.characterName);
        if (!name) return res.status(400).json({ error: '非法的角色名' });
        try {
            // ST 把聊天存档放在 data/chats/<characterName>/*.jsonl，网关沿用同结构
            const chatDir = path.join(dirs.chats, name);
            let files = [];
            if (fs.existsSync(chatDir)) {
                files = fs.readdirSync(chatDir)
                    .filter(f => f.endsWith('.jsonl'))
                    .map(f => path.basename(f, '.jsonl'));
            }
            // 兜底：兼容老结构（chats/<character>_<chatId>.jsonl 平铺）
            if (files.length === 0 && fs.existsSync(dirs.chats)) {
                files = listArchives(dirs.chats)
                    .filter(a => a.name.startsWith(name))
                    .map(a => a.name);
            }
            res.json(files);
        } catch (e) {
            logger.error?.(`[st-shim] 列出聊天失败 ${name}: ${e.message}`);
            res.status(500).json({ error: '列出聊天失败: ' + e.message });
        }
    }

    /** GET /api/chats/:characterName/:fileId - 读取聊天 JSONL，返回行数组 */
    function readChat(req, res) {
        const name = _safeName(req.params.characterName);
        const fileId = _safeName(req.params.fileId);
        if (!name || !fileId) return res.status(400).json({ error: '非法的参数' });
        try {
            // 优先 data/chats/<name>/<fileId>.jsonl
            let file = path.join(dirs.chats, name, fileId + '.jsonl');
            if (!fs.existsSync(file)) {
                // 兜底：平铺结构
                file = path.join(dirs.chats, fileId + '.jsonl');
                if (!fs.existsSync(file)) {
                    return res.status(404).json({ error: '聊天存档不存在' });
                }
            }
            const content = fs.readFileSync(file, 'utf-8');
            // ST 期望一个 JSON 对象：{ file_name, messages: [...] }
            const lines = content.split('\n').filter(Boolean);
            const messages = [];
            for (const line of lines) {
                try { messages.push(JSON.parse(line)); }
                catch { /* 跳过损坏行 */ }
            }
            res.json({ file_name: fileId, messages });
        } catch (e) {
            logger.error?.(`[st-shim] 读取聊天失败 ${name}/${fileId}: ${e.message}`);
            res.status(500).json({ error: '读取聊天失败: ' + e.message });
        }
    }

    /** POST /api/chats/:characterName/:fileId - 写入聊天 JSONL（整体覆盖） */
    function writeChat(req, res) {
        const name = _safeName(req.params.characterName);
        const fileId = _safeName(req.params.fileId);
        if (!name || !fileId) return res.status(400).json({ error: '非法的参数' });
        try {
            const body = req.body || {};
            // body 可能是 { messages: [...] } 或直接是数组
            const messages = Array.isArray(body) ? body : (body.messages || []);
            const chatDir = path.join(dirs.chats, name);
            fs.mkdirSync(chatDir, { recursive: true });
            const file = path.join(chatDir, fileId + '.jsonl');
            const lines = messages.map(m => JSON.stringify(m)).join('\n');
            fs.writeFileSync(file, lines + (lines ? '\n' : ''), 'utf-8');
            res.json({ ok: true, file_name: fileId });
        } catch (e) {
            logger.error?.(`[st-shim] 写入聊天失败 ${name}/${fileId}: ${e.message}`);
            res.status(500).json({ error: '写入聊天失败: ' + e.message });
        }
    }

    // ==================== 预设 ====================

    /** GET /api/presets - 列出预设 */
    function listPresets(req, res) {
        try {
            const list = fs.existsSync(dirs.presets)
                ? fs.readdirSync(dirs.presets)
                    .filter(f => f.endsWith('.json'))
                    .map(f => path.basename(f, '.json'))
                : [];
            res.json(list);
        } catch (e) {
            res.status(500).json({ error: '列出预设失败: ' + e.message });
        }
    }

    /** GET /api/presets/:name - 读取预设原始 JSON */
    function getPreset(req, res) {
        const name = _safeName(req.params.name);
        if (!name) return res.status(400).json({ error: '非法的预设名' });
        try {
            const file = path.join(dirs.presets, name + '.json');
            if (!fs.existsSync(file)) return res.status(404).json({ error: '预设不存在' });
            const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
            res.json(raw);
        } catch (e) {
            res.status(500).json({ error: '读取预设失败: ' + e.message });
        }
    }

    // ==================== 世界书 ====================

    /** GET /api/worldinfo - 列出世界书（ST 用 /api/worldinfo/get 整体拉取，这里同时支持） */
    function listWorldbooks(req, res) {
        try {
            const list = fs.existsSync(dirs.worldbooks)
                ? fs.readdirSync(dirs.worldbooks)
                    .filter(f => f.endsWith('.json'))
                    .map(f => path.basename(f, '.json'))
                : [];
            // ST 早期版本期望 { name: originalName } 结构
            res.json(list);
        } catch (e) {
            res.status(500).json({ error: '列出世界书失败: ' + e.message });
        }
    }

    /** GET /api/worldinfo/:name - 读取世界书原始 JSON */
    function getWorldbook(req, res) {
        const name = _safeName(req.params.name);
        if (!name) return res.status(400).json({ error: '非法的世界书名' });
        try {
            const file = path.join(dirs.worldbooks, name + '.json');
            if (!fs.existsSync(file)) return res.status(404).json({ error: '世界书不存在' });
            const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
            res.json(raw);
        } catch (e) {
            res.status(500).json({ error: '读取世界书失败: ' + e.message });
        }
    }

    // ==================== 生成 ====================

    /**
     * POST /api/generate - 生成回复
     *
     * 请求体（ST 格式，关键字段）：
     *   - character_name: 角色名
     *   - chat: 聊天标识
     *   - messages: ST 格式的历史消息数组 [{role, content}, ...]
     *   - prompt / input: 当前用户输入（不同 ST 版本字段名略不同）
     *   - agentMode: 显式开启/关闭 Agent 模式
     *
     * Agent 模式响应（兼容 ST）：
     *   { message: result.getMainText(), results: [ { message } ], ... }
     * 非 Agent 模式：透传到 nativeRuntime.generate（若启用），返回 { message }
     */
    async function generate(req, res) {
        const body = req.body || {};
        try {
            const useAgent = shouldUseAgentMode(body);
            if (useAgent) {
                if (!agentService || typeof agentService.run !== 'function') {
                    return res.status(503).json({
                        error: 'Agent 模式不可用：agent-framework 插件未加载',
                    });
                }
                if (!llmService) {
                    return res.status(503).json({
                        error: 'Agent 模式不可用：runtime.llm 未配置',
                    });
                }
                // 解析当前输入与历史
                const input = body.prompt || body.input || _extractLastUserMessage(body.messages) || '';
                const history = _extractHistory(body.messages);
                const characterName = _safeName(body.character_name || '');
                const chatId = body.chat || `st:${characterName || 'default'}`;

                // 调用 Agent run
                // profile 优先用请求体 agent 字段，其次用会话绑定的 profile，最后用 'default-rp'
                const profile = body.agent || body.profile || 'default-rp';
                const runResult = await agentService.run(
                    profile,
                    input,
                    {
                        platform: 'st',
                        chatId,
                        character: characterName,
                    },
                    {
                        llm: llmService,
                        history,
                        character: characterName,
                    },
                );
                const text = runResult?.result?.getMainText?.()
                    || runResult?.text
                    || '';
                logger.info?.(`[st-shim] Agent 生成完成 runId=${runResult?.runId}, 字符数=${text.length}`);
                // 兼容 ST 期望：message 字段
                res.json({
                    message: text,
                    results: [{ message: text }],
                    _agentMeta: {
                        runId: runResult?.runId,
                        options: runResult?.result?.options || [],
                        events: (runResult?.result?.events || []).length,
                    },
                });
                return;
            }

            // 非 Agent 模式：透传到 nativeRuntime
            if (!nativeRuntime) {
                return res.status(503).json({
                    error: '非 Agent 模式不可用：runtime.enabled=false 且 agentMode=false',
                });
            }
            // ST 的 platform/chatId 用 st:<character> 占位，对应 nativeRuntime 的会话 Profile
            const platform = 'st';
            const chatId = body.chat || `st:${body.character_name || 'default'}`;
            const input = body.prompt || body.input || _extractLastUserMessage(body.messages) || '';
            const reply = await nativeRuntime.generate(platform, chatId, input, {});
            res.json({ message: reply, results: [{ message: reply }] });
        } catch (e) {
            logger.error?.(`[st-shim] /api/generate 失败: ${e.message}`);
            res.status(500).json({ error: '生成失败: ' + e.message });
        }
    }

    // ==================== 设置 / CSRF ====================

    /**
     * GET /api/settings - 返回 ST 启动所需的基础设置（让前端能加载完不报错）。
     * 关键：ST 启动时会请求 /api/settings，必须返回 200 + 基本结构。
     */
    function getSettings(req, res) {
        // 最小可启动设置：用户名 + 部分默认值。真实配置在 ST 前端 localStorage 维护。
        res.json({
            user_name: 'User',
            persona_description: '',
            preset: 'default',
            temperature: 0.9,
            max_context: 1000000,
            // ST 期望这些字段存在
            api_server: '',
            chat_starting_stage: 0,
            st_extension_settings: {},
            // 标记这是网关 shim
            _gateway: true,
        });
    }

    /**
     * GET /csrf-token - 返回 CSRF token（ST 前端启动会请求）。
     * 网关用 X-Gateway-Token 鉴权（在中间件层已校验），CSRF 桩返回固定值即可。
     */
    function getCsrfToken(req, res) {
        res.json({ token: 'gateway-shim' });
    }

    return {
        listCharacters,
        getCharacter,
        writeCharacter,
        listChats,
        readChat,
        writeChat,
        listPresets,
        getPreset,
        listWorldbooks,
        getWorldbook,
        generate,
        getSettings,
        getCsrfToken,
    };
}

/**
 * 从 ST 的 messages 数组提取历史（去掉最后一条 user 消息，作为 input）。
 * ST messages 形如 [{role:'system',content}, {role:'user',content}, {role:'assistant',content}, ...]
 * @param {Array} messages
 * @returns {Array<{role, content}>}
 */
function _extractHistory(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map(m => ({
        role: m.role || (m.is_user ? 'user' : 'assistant'),
        content: typeof m.content === 'string' ? m.content : (m.mes || m.content || ''),
    }));
}

/**
 * 取 messages 数组中最后一条 user 消息作为 input。
 * @param {Array} messages
 * @returns {string}
 */
function _extractLastUserMessage(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const role = m.role || (m.is_user ? 'user' : 'assistant');
        if (role === 'user') {
            return typeof m.content === 'string' ? m.content : (m.mes || '');
        }
    }
    return '';
}

export default createStShim;
