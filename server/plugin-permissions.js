/**
 * 插件权限模型与能力收窄
 *
 * ⚠️ 关于"沙箱"的诚实说明（务必先读）
 * ────────────────────────────────────────────────────────────────
 * 本模块实现的是**能力收窄（capability narrowing）**，不是安全沙箱。
 *
 * 它能做到：
 *   ✅ 插件不再能通过 services / ctx 拿到网关全局配置里的 bot token、
 *      API key、网关鉴权 token（此前任何插件一行代码就能全部读走）
 *   ✅ 危险能力（读会话历史、管理适配器）改为显式声明才授予
 *   ✅ 安装前静态扫描并展示插件申请的权限与可疑代码
 *
 * 它**做不到**（因为插件与网关同进程、共享 Node 权限）：
 *   ❌ 阻止插件 `import('fs')` 直接读磁盘上的 config/gateway.json
 *   ❌ 阻止插件 `import('child_process')` 执行任意命令
 *   ❌ 防御刻意为恶的插件
 *
 * 真正的隔离需要把插件跑在独立进程 + Node 权限模型（--permission
 * --allow-fs-read=<插件目录>）里，通过 IPC 通信。那会把插件 API 变成
 * 全异步消息式，破坏现有全部插件（尤其同步的 filterOutbound）。
 * 路线见 docs/PLUGIN_SECURITY.md。
 *
 * 所以：**第三方插件仍应视为"你信任其作者才安装"的代码**。本模块把
 * "装了就等于交出所有凭据"降级为"装了等于让它在你的网关里跑代码"——
 * 后者仍需谨慎，但前者是可以且已经被消除的确定性损失。
 */

import { createLogger } from './utils/logger.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const logger = createLogger('plugin-perm');
// ESM 模块没有 __dirname，手动构造供 createFsService/createAssetsService 使用
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 权限注册表
 * risk: low=行为可见且可逆 / medium=可影响数据或对外发消息 / high=触及凭据或全局控制
 */
export const PERMISSIONS = {
    'config': {
        risk: 'low',
        desc: '读写插件自身的配置',
        default: true,
    },
    'gateway.filter': {
        risk: 'low',
        desc: '注册出站过滤器（可修改或拦截发出的消息）',
        default: true,
    },
    'gateway.inbound': {
        risk: 'medium',
        // 比出站过滤更强：能看到**每一条**用户消息（在命令路由/会话历史/LLM 之前），
        // 且能静默拦截。因此与 sessions 同级，非默认授予、需显式声明。
        desc: '注册入站过滤器（可读取、改写或拦截所有收到的消息）',
        default: false,
    },
    'gateway.send': {
        risk: 'medium',
        desc: '主动向任意平台/会话发送消息',
        default: true,
    },
    'sessions': {
        risk: 'medium',
        desc: '读写会话历史记录（能看到用户的聊天内容）',
        default: false,
    },
    'llm': {
        risk: 'medium',
        // 非默认授予：调用要花钱，且插件能把任意内容送给模型。
        // 但只给"调用"能力，拿不到 apiKey——与 gatewayConfig 脱敏视图同一原则。
        desc: '调用网关配置的 LLM（消耗你的 API 额度，但拿不到 API key）',
        default: false,
    },
    'gateway.config': {
        risk: 'high',
        desc: '读取网关全局配置（凭据字段仍会脱敏）',
        default: false,
    },
    'gateway.admin': {
        risk: 'high',
        desc: '管理适配器与其它插件（启停、改配置）',
        default: false,
    },
    'fs': {
        risk: 'medium',
        desc: '读写插件数据目录下的文件（data/plugins/<插件名>/）',
        default: false,
    },
    'assets': {
        risk: 'low',
        desc: '只读访问 ST 资产（角色卡/世界书/预设）',
        default: false,
    },
    'agent': {
        risk: 'medium',
        desc: '使用 Agent 框架（注册工具/调度子代理）',
        default: false,
    },
    'surface': {
        risk: 'medium',
        desc: '注册表现层适配器（消费 AgentRunResult 渲染到界面）',
        default: false,
    },
    'workspace': {
        risk: 'low',
        desc: '跨插件共享 workspace（多 Bot 协同场景）',
        default: false,
    },
};

/** 默认授予的权限集合（向后兼容：老插件不声明也能正常工作） */
const DEFAULT_GRANTED = Object.entries(PERMISSIONS)
    .filter(([, v]) => v.default)
    .map(([k]) => k);

/**
 * 归一化插件声明的权限。
 *
 * 兼容历史写法：早期插件写 `permissions: ["config"]`，其含义模糊且从未被
 * 读取过。这里把未知/缺失的声明视为"只要默认集合"，并对危险权限要求精确声明。
 *
 * @param {string[]|undefined} declared - plugin.json 的 permissions 字段
 * @param {string} pluginName
 * @returns {{granted: Set<string>, declared: string[], unknown: string[]}}
 */
export function normalizePermissions(declared, pluginName = '?') {
    const list = Array.isArray(declared) ? declared.map(String) : [];
    const known = [];
    const unknown = [];

    for (const p of list) {
        if (PERMISSIONS[p]) known.push(p);
        else unknown.push(p);
    }
    if (unknown.length) {
        logger.warn(`插件 ${pluginName} 声明了未知权限: ${unknown.join(', ')}（已忽略）`);
    }

    // 默认集合 + 显式声明的（含高危项）
    const granted = new Set([...DEFAULT_GRANTED, ...known]);
    return { granted, declared: list, unknown };
}

/** 判断权限集合中的最高风险等级 */
export function highestRisk(perms) {
    let level = 'low';
    for (const p of perms) {
        const r = PERMISSIONS[p]?.risk;
        if (r === 'high') return 'high';
        if (r === 'medium') level = 'medium';
    }
    return level;
}

/**
 * 网关全局配置的只读安全视图。
 *
 * 关键修复：此前插件直接拿到 configManager 实例，
 * `configManager.get('adapters.telegram.botToken')` 即可窃取全部平台凭据
 * 与网关鉴权 token。现在：
 *   - 无 gateway.config 权限 → 一律拒绝
 *   - 有权限 → 也只返回脱敏后的值（凭据永不明文出网关核心）
 *
 * 插件若确实需要自己的 API key，应放在**插件自身配置**里，而不是读网关配置。
 */
function makeGatewayConfigView(configManager, granted, pluginName) {
    const allowed = granted.has('gateway.config');
    return {
        /**
         * @param {string} key - 点分路径
         * @returns {*} 脱敏后的值；无权限时 undefined
         */
        get(key) {
            if (!allowed) {
                logger.warn(`插件 ${pluginName} 尝试读取网关配置 "${key}" 但未声明 gateway.config 权限，已拒绝`);
                return undefined;
            }
            const val = configManager.get(key);
            // 即便有权限也脱敏：凭据不应流入插件
            return redactValue(key, val, configManager);
        },
        has(key) {
            return allowed && configManager.get(key) !== undefined;
        },
    };
}

const SENSITIVE_KEY_RE = /token|secret|password|apikey|api_key|accesstoken|access_token/i;

/** 对取出的配置值做脱敏（字符串直接判键名；对象递归复用 configManager 的脱敏） */
function redactValue(key, val, configManager) {
    const leaf = String(key).split('.').pop();
    if (typeof val === 'string' && SENSITIVE_KEY_RE.test(leaf)) {
        return val.length > 4 ? `***${val.slice(-4)}` : '***';
    }
    if (val && typeof val === 'object') {
        try {
            return configManager._redact(structuredClone(val));
        } catch (_) {
            return undefined;
        }
    }
    return val;
}

/** 生成一个被拒绝时抛出清晰错误的桩对象 */
function deniedStub(pluginName, permission, methods) {
    const stub = {};
    for (const m of methods) {
        stub[m] = () => {
            throw new Error(
                `插件 ${pluginName} 调用 ${m}() 需要 "${permission}" 权限，请在 plugin.json 的 permissions 中声明`,
            );
        };
    }
    return stub;
}

/** 需要 gateway.send 权限的网关方法 */
const SEND_METHODS = new Set(['sendMessage', 'sendDirect', 'broadcast']);
/** 需要 gateway.admin 权限的网关方法 */
const ADMIN_METHODS = new Set([
    'registerAdapter', 'unregisterAdapter', 'start', 'stop',
    'setCommandRouter', 'syncAllCommands', 'removeOutboundFiltersByPlugin', 'removeInboundFiltersByPlugin',
]);
/** LLM 服务方法（未授予 llm 权限时，调用这些方法会抛出清晰错误） */
const LLM_METHODS = ['chat', 'chatStream', 'chatWithTools', 'runTools', 'verify'];

/**
 * 构造某插件专属的、按权限收窄的 services。
 *
 * @param {string} pluginName
 * @param {Set<string>} granted - 已授予的权限
 * @param {object} raw - 原始服务 { gateway, sessionManager, configManager, savePluginConfig, llmService }
 * @param {Function[]} managedUnregister - 收集出站过滤器注销函数（框架代管回收）
 * @param {object} extra - 额外选项 { fs?: boolean, assets?: boolean, agentService?: object, pluginName?: string }
 * @returns {object} 收窄后的 services
 */
export function buildScopedServices(pluginName, granted, raw, managedUnregister = [], extra = {}) {
    const gateway = raw.gateway ? new Proxy(raw.gateway, {
        get(target, prop, receiver) {
            // 出站过滤器：自动标注归属 + 记录注销函数（供禁用插件时强制回收）
            if (prop === 'addOutboundFilter') {
                if (!granted.has('gateway.filter')) {
                    return () => {
                        throw new Error(`插件 ${pluginName} 注册出站过滤器需要 "gateway.filter" 权限`);
                    };
                }
                return (filter, opts = {}) => {
                    const unregister = target.addOutboundFilter(filter, { ...opts, pluginName });
                    if (typeof unregister === 'function') managedUnregister.push(unregister);
                    return unregister;
                };
            }

            // 入站过滤器：与出站对称，但权限更严（gateway.inbound 非默认授予）
            if (prop === 'addInboundFilter') {
                if (!granted.has('gateway.inbound')) {
                    return () => {
                        throw new Error(`插件 ${pluginName} 注册入站过滤器需要 "gateway.inbound" 权限`);
                    };
                }
                return (filter, opts = {}) => {
                    const unregister = target.addInboundFilter(filter, { ...opts, pluginName });
                    if (typeof unregister === 'function') managedUnregister.push(unregister);
                    return unregister;
                };
            }

            if (SEND_METHODS.has(prop) && !granted.has('gateway.send')) {
                return () => {
                    throw new Error(`插件 ${pluginName} 调用 ${String(prop)}() 需要 "gateway.send" 权限`);
                };
            }

            if (ADMIN_METHODS.has(prop) && !granted.has('gateway.admin')) {
                return () => {
                    throw new Error(`插件 ${pluginName} 调用 ${String(prop)}() 需要 "gateway.admin" 权限`);
                };
            }

            const val = Reflect.get(target, prop, receiver);
            return typeof val === 'function' ? val.bind(target) : val;
        },
    }) : raw.gateway;

    const sessionManager = granted.has('sessions')
        ? raw.sessionManager
        : deniedStub(pluginName, 'sessions', [
            'getHistory', 'addMessage', 'clearHistory', 'listSessions',
            'getOrCreate', 'deleteSession', 'setMetadata',
        ]);

    const llm = (granted.has('llm') && raw.llmService)
        ? raw.llmService
        : deniedStub(pluginName, 'llm', LLM_METHODS);

    return {
        gateway,
        sessionManager,
        // 调用网关配置的 LLM。未授予 llm 权限（或服务缺失）时为拒绝桩，
        // 调用即抛出清晰错误。授予时也只给"调用"能力——apiKey 在服务内部
        // 用于拼 HTTP 请求，绝不流入插件（与 gatewayConfig 脱敏同一原则）。
        llm,
        // 关键：不再传出原始 configManager。插件只能通过受控视图读取，
        // 且凭据字段恒被脱敏。
        gatewayConfig: makeGatewayConfigView(raw.configManager, granted, pluginName),
        savePluginConfig: raw.savePluginConfig,
        // 文件系统服务：读写插件数据目录下的文件。未授予 fs 权限（或未请求）时为拒绝桩。
        fs: (granted.has('fs') && extra.fs) ? createFsService(pluginName) : deniedStub(pluginName, 'fs', ['read', 'write', 'list', 'exists']),
        // ST 资产只读服务：角色卡/世界书/预设。未授予 assets 权限（或未请求）时为拒绝桩。
        assets: (granted.has('assets') && extra.assets) ? createAssetsService() : deniedStub(pluginName, 'assets', ['listCharacters', 'readCharacter', 'listWorldbooks', 'readWorldbook', 'listPresets', 'readPreset']),
        // Agent 框架服务：注册工具/调度子代理。未授予 agent 权限或 agent-framework 未加载时为拒绝桩。
        // 注意方法清单须与 createAgentService 暴露的保持一致，否则未授权调用会得到
        // "x is not a function" 的 TypeError 而非清晰的权限错误（SubTask 7.3 回归守护）。
        agent: (granted.has('agent') && extra.agentService) ? createAgentService(extra.agentService, pluginName) : deniedStub(pluginName, 'agent', ['registerTool', 'dispatch', 'registerAgent', 'getStatus', 'run']),
        // 表现层服务：注册/调度表现层适配器。未授予 surface 权限（或 SurfaceManager 未注入）时为拒绝桩。
        surface: (granted.has('surface') && extra.surfaceService) ? createSurfaceService(extra.surfaceService, pluginName) : deniedStub(pluginName, 'surface', ['register', 'getAdapters', 'bindPrimary', 'dispatch']),
        // Agent 剧场广播器（SSE）：把 AgentRunResult 推送给面板前端。
        // 不需要单独权限声明（只读广播，无副作用），未注入时为 null。
        theatreBroadcaster: extra.theatreBroadcaster || null,
        // 供插件系统内部使用（不供插件业务逻辑访问凭据）
        _permissions: granted,
        _pluginName: pluginName,
    };
}

/**
 * 创建插件专属的文件系统服务。
 * 仅允许读写 data/plugins/<插件名>/ 目录下的文件，路径穿越被拒绝。
 * @param {string} pluginName
 */
function createFsService(pluginName) {
    const dataDir = path.resolve(__dirname, '..', 'data', 'plugins', pluginName);

    // 安全解析：确保解析后的路径仍在 dataDir 之下，防止 ../ 穿越
    const safeResolve = (relativePath) => {
        const resolved = path.resolve(dataDir, relativePath);
        if (!resolved.startsWith(dataDir + path.sep) && resolved !== dataDir) {
            throw new Error(`路径越界: ${relativePath}`);
        }
        return resolved;
    };

    return {
        // 读文件，返回字符串
        read(relativePath) {
            const full = safeResolve(relativePath);
            return fs.readFileSync(full, 'utf-8');
        },
        // 写文件（自动创建父目录）
        write(relativePath, content) {
            const full = safeResolve(relativePath);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content, 'utf-8');
        },
        // 列目录，返回文件名数组
        list(relativePath) {
            const full = safeResolve(relativePath);
            return fs.readdirSync(full);
        },
        // 判断是否存在
        exists(relativePath) {
            const full = safeResolve(relativePath);
            return fs.existsSync(full);
        },
    };
}

/**
 * 创建 ST 资产只读服务。
 * 读取 assets/ 目录下的角色卡、世界书、预设。
 */
function createAssetsService() {
    const assetsDir = path.resolve(__dirname, '..', 'assets');

    return {
        // 列出 assets/characters/ 下的 .json 和 .png 文件名
        listCharacters() {
            const dir = path.join(assetsDir, 'characters');
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir).filter(f => f.endsWith('.json') || f.endsWith('.png'));
        },
        // 读取角色卡 JSON（png 暂不支持提取，返回 null）
        readCharacter(name) {
            const jsonPath = path.join(assetsDir, 'characters', name.endsWith('.json') ? name : name + '.json');
            if (fs.existsSync(jsonPath)) {
                return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            }
            // png 提取暂不支持，返回 null
            return null;
        },
        // 列出 assets/worldbooks/ 下的 .json 文件名
        listWorldbooks() {
            const dir = path.join(assetsDir, 'worldbooks');
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        },
        // 读取世界书 JSON
        readWorldbook(name) {
            const full = path.join(assetsDir, 'worldbooks', name.endsWith('.json') ? name : name + '.json');
            if (!fs.existsSync(full)) return null;
            return JSON.parse(fs.readFileSync(full, 'utf-8'));
        },
        // 列出 assets/presets/ 下的 .json 文件名
        listPresets() {
            const dir = path.join(assetsDir, 'presets');
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        },
        // 读取预设 JSON
        readPreset(name) {
            const full = path.join(assetsDir, 'presets', name.endsWith('.json') ? name : name + '.json');
            if (!fs.existsSync(full)) return null;
            return JSON.parse(fs.readFileSync(full, 'utf-8'));
        },
    };
}

/**
 * 创建插件专属的 Agent 框架服务。
 * 委托给全局 agent-framework 插件提供的 agentService，自动标注工具来源插件。
 * @param {object} agentService - agent-framework 插件暴露的 agent 服务实例
 * @param {string} pluginName - 当前插件名（用于标注工具来源）
 */
function createAgentService(agentService, pluginName) {
    return {
        registerTool: (toolDef) => agentService.registerTool({ ...toolDef, source: pluginName }),
        dispatch: (agentName, task, options) => agentService.dispatch(agentName, task, options),
        registerAgent: (agentDef) => agentService.registerAgent(agentDef),
        getStatus: () => agentService.getStatus(),
        // 触发 Agent run，返回 { runId, result: AgentRunResult, text, steps, ... }
        // 供表现层适配器（如 agent-rp）通过 ctx.agent.run(profile, input, session, ctx) 调用
        run: (profile, input, session, ctx) => agentService.run(profile, input, session, ctx),
    };
}

/**
 * 创建插件专属的表现层服务。
 * 委托给全局 SurfaceManager，自动标注适配器来源插件。
 * @param {import('./agent/surface-manager.js').SurfaceManager} surfaceService - 全局 SurfaceManager 实例
 * @param {string} pluginName - 当前插件名（用于标注来源）
 */
function createSurfaceService(surfaceService, pluginName) {
    return {
        register: (adapter) => surfaceService.register({ ...adapter, source: pluginName }),
        getAdapters: () => surfaceService.getAdapters(),
        bindPrimary: (sessionKey, adapterName) => surfaceService.bindPrimary(sessionKey, adapterName),
        dispatch: (result, ctx, options) => surfaceService.dispatch(result, ctx, options),
    };
}

// ==================== 安装前静态风险扫描 ====================

/**
 * 可疑代码模式。命中不代表恶意（很多正当插件也会用 fs），
 * 目的是让用户在安装前**看见**插件要做什么。
 */
const RISK_PATTERNS = [
    { re: /\bchild_process\b|\bexecSync\b|\bspawnSync\b|\bexec\s*\(/, level: 'critical', label: '执行系统命令' },
    { re: /\beval\s*\(|new\s+Function\s*\(/, level: 'high', label: '动态执行代码 (eval/Function)' },
    { re: /\bfs\.(writeFile|unlink|rm|rmdir|appendFile)|\bfs\/promises\b/, level: 'high', label: '写入/删除文件' },
    { re: /require\s*\(\s*['"]fs['"]|from\s+['"]fs['"]|import\s*\(\s*['"]fs['"]/, level: 'medium', label: '读取文件系统' },
    { re: /\bprocess\.env\b/, level: 'medium', label: '读取环境变量' },
    { re: /\bfetch\s*\(|\baxios\b|require\s*\(\s*['"]https?['"]/, level: 'low', label: '发起网络请求' },
    { re: /gateway\.json|authToken|botToken|accessToken/, level: 'critical', label: '疑似访问网关凭据' },
];

/**
 * 扫描插件源码，产出风险报告（供安装前展示给用户）。
 * @param {string} pluginDir
 * @param {object} deps - { fs, path }（便于测试注入）
 * @returns {{findings: Array, maxLevel: string, filesScanned: number}}
 */
export function scanPluginRisk(pluginDir, deps) {
    const _fs = deps?.fs || fs;
    const _path = deps?.path || path;

    const findings = [];
    let filesScanned = 0;

    const walk = (dir, depth = 0) => {
        if (depth > 3) return;
        let entries;
        try { entries = _fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const full = _path.join(dir, e.name);
            if (e.isDirectory()) { walk(full, depth + 1); continue; }
            if (!/\.(js|mjs|cjs)$/.test(e.name)) continue;

            filesScanned++;
            let src;
            try { src = _fs.readFileSync(full, 'utf-8'); } catch (_) { continue; }

            for (const { re, level, label } of RISK_PATTERNS) {
                const m = src.match(re);
                if (m) {
                    // 定位行号便于用户自查
                    const line = src.slice(0, m.index).split('\n').length;
                    findings.push({ file: _path.relative(pluginDir, full), line, level, label });
                }
            }
        }
    };
    walk(pluginDir);

    const order = { low: 0, medium: 1, high: 2, critical: 3 };
    const maxLevel = findings.reduce(
        (acc, f) => (order[f.level] > order[acc] ? f.level : acc),
        'low',
    );

    return { findings, maxLevel, filesScanned };
}

/**
 * 生成人类可读的安装前告知文本
 * @param {object} meta - plugin.json
 * @param {object} risk - scanPluginRisk 结果
 */
export function formatInstallDisclosure(meta, risk) {
    const { granted } = normalizePermissions(meta.permissions, meta.name);
    const permLines = [...granted].map(p => {
        const d = PERMISSIONS[p];
        const mark = d.risk === 'high' ? '⚠️ ' : d.risk === 'medium' ? '· ' : '· ';
        return `  ${mark}${p} — ${d.desc}`;
    });

    const riskLines = risk.findings.length
        ? risk.findings.map(f => `  [${f.level}] ${f.label} (${f.file}:${f.line})`)
        : ['  （未发现可疑模式）'];

    return [
        `插件: ${meta.displayName || meta.name} v${meta.version || '?'}`,
        `作者: ${meta.author || '未知'}`,
        '',
        '将获得的能力:',
        ...permLines,
        '',
        `代码扫描 (${risk.filesScanned} 个文件, 最高风险: ${risk.maxLevel}):`,
        ...riskLines,
        '',
        '⚠️ 插件与网关同进程运行，拥有完整 Node 权限。',
        '   上述扫描仅供参考，无法阻止刻意为恶的代码。请只安装你信任的作者的插件。',
    ].join('\n');
}

export default {
    PERMISSIONS, normalizePermissions, highestRisk,
    buildScopedServices, scanPluginRisk, formatInstallDisclosure,
};
