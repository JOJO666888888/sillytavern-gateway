/**
 * 环境变量配置层
 *
 * 容器化部署的地基：用户不可能进容器改 config/gateway.json，必须能用
 * 环境变量（或 .env / docker secrets）注入配置。
 *
 * 三条设计原则：
 *
 * 1. **优先级 env > 配置文件 > 默认值**
 *    环境变量是"部署时决定"的，应当压过文件里的历史值。
 *
 * 2. **环境变量注入的值绝不回写配置文件**（尤其敏感项）
 *    config/ 通常是挂载卷。若把 GATEWAY_TELEGRAM_BOT_TOKEN 写进
 *    gateway.json，凭据就从"只存在于环境"泄漏成"落在磁盘上"，
 *    与用 env 注入的初衷相悖，也会在用户改 env 后产生"改了不生效"的困惑
 *    （因为文件里还留着旧值，而文件值又会被下次 env 覆盖……）。
 *    实现见 ConfigManager.save() 中对 _envPaths 的回退处理。
 *
 * 3. **非法值不静默吞掉**
 *    端口写错成 "abc" 时保持默认并**大声报错**，而不是让用户对着一个
 *    监听在意外端口上的服务排查半天。
 */

import { createLogger } from './logger.js';

const logger = createLogger('env-config');

/**
 * 环境变量 → 配置路径 映射表
 *
 * type:   转换目标类型
 * secret: 是否敏感（决定日志脱敏与是否禁止回写；实际上所有 env 项都不回写，
 *         此标记用于日志展示与文档生成）
 */
export const ENV_MAP = [
    // ── 服务本身 ────────────────────────────────────────────────
    { env: 'GATEWAY_PORT', path: 'server.port', type: 'number' },
    { env: 'GATEWAY_HOST', path: 'server.host', type: 'string' },
    { env: 'GATEWAY_AUTH_TOKEN', path: 'server.authToken', type: 'string', secret: true },
    { env: 'GATEWAY_REQUIRE_AUTH', path: 'server.requireAuth', type: 'boolean' },
    { env: 'GATEWAY_ALLOWED_ORIGINS', path: 'server.allowedOrigins', type: 'array' },
    { env: 'GATEWAY_ADMINS', path: 'admins', type: 'array' },

    // ── QQ (OneBot) ─────────────────────────────────────────────
    { env: 'GATEWAY_QQ_ENABLED', path: 'adapters.qq.enabled', type: 'boolean' },
    { env: 'GATEWAY_QQ_MODE', path: 'adapters.qq.mode', type: 'string' },
    { env: 'GATEWAY_QQ_WS_URL', path: 'adapters.qq.wsUrl', type: 'string' },
    { env: 'GATEWAY_QQ_REVERSE_PORT', path: 'adapters.qq.reversePort', type: 'number' },
    { env: 'GATEWAY_QQ_ACCESS_TOKEN', path: 'adapters.qq.accessToken', type: 'string', secret: true },
    { env: 'GATEWAY_QQ_REQUIRE_MENTION', path: 'adapters.qq.requireMention', type: 'boolean' },

    // ── Telegram ────────────────────────────────────────────────
    { env: 'GATEWAY_TELEGRAM_ENABLED', path: 'adapters.telegram.enabled', type: 'boolean' },
    { env: 'GATEWAY_TELEGRAM_BOT_TOKEN', path: 'adapters.telegram.botToken', type: 'string', secret: true },
    { env: 'GATEWAY_TELEGRAM_MODE', path: 'adapters.telegram.mode', type: 'string' },
    { env: 'GATEWAY_TELEGRAM_ALLOWED_USERS', path: 'adapters.telegram.allowedUsers', type: 'array' },
    { env: 'GATEWAY_TELEGRAM_REQUIRE_MENTION', path: 'adapters.telegram.requireMention', type: 'boolean' },

    // ── Discord ─────────────────────────────────────────────────
    { env: 'GATEWAY_DISCORD_ENABLED', path: 'adapters.discord.enabled', type: 'boolean' },
    { env: 'GATEWAY_DISCORD_BOT_TOKEN', path: 'adapters.discord.botToken', type: 'string', secret: true },
    { env: 'GATEWAY_DISCORD_ALLOWED_CHANNELS', path: 'adapters.discord.allowedChannels', type: 'array' },
    { env: 'GATEWAY_DISCORD_ALLOWED_USERS', path: 'adapters.discord.allowedUsers', type: 'array' },
    { env: 'GATEWAY_DISCORD_REQUIRE_MENTION', path: 'adapters.discord.requireMention', type: 'boolean' },

    // ── 飞书 / Lark ─────────────────────────────────────────────
    { env: 'GATEWAY_FEISHU_ENABLED', path: 'adapters.feishu.enabled', type: 'boolean' },
    { env: 'GATEWAY_FEISHU_APP_ID', path: 'adapters.feishu.appId', type: 'string' },
    { env: 'GATEWAY_FEISHU_APP_SECRET', path: 'adapters.feishu.appSecret', type: 'string', secret: true },
    { env: 'GATEWAY_FEISHU_DOMAIN', path: 'adapters.feishu.domain', type: 'string' },
    { env: 'GATEWAY_FEISHU_REQUIRE_MENTION', path: 'adapters.feishu.requireMention', type: 'boolean' },
    { env: 'GATEWAY_FEISHU_MEDIA_BASE_URL', path: 'adapters.feishu.mediaBaseUrl', type: 'string' },

    // ── QQ 官方机器人 ───────────────────────────────────────────
    { env: 'GATEWAY_QQOFFICIAL_ENABLED', path: 'adapters.qqofficial.enabled', type: 'boolean' },
    { env: 'GATEWAY_QQOFFICIAL_APP_ID', path: 'adapters.qqofficial.appId', type: 'string' },
    { env: 'GATEWAY_QQOFFICIAL_SECRET', path: 'adapters.qqofficial.secret', type: 'string', secret: true },
    { env: 'GATEWAY_QQOFFICIAL_TOKEN', path: 'adapters.qqofficial.token', type: 'string', secret: true },
    { env: 'GATEWAY_QQOFFICIAL_SANDBOX', path: 'adapters.qqofficial.sandbox', type: 'boolean' },

    // ── 钉钉 ────────────────────────────────────────────────────
    { env: 'GATEWAY_DINGTALK_ENABLED', path: 'adapters.dingtalk.enabled', type: 'boolean' },
    { env: 'GATEWAY_DINGTALK_CLIENT_ID', path: 'adapters.dingtalk.clientId', type: 'string' },
    { env: 'GATEWAY_DINGTALK_CLIENT_SECRET', path: 'adapters.dingtalk.clientSecret', type: 'string', secret: true },

    // ── 自建推理管线 ────────────────────────────────────────────
    { env: 'GATEWAY_RUNTIME_ENABLED', path: 'runtime.enabled', type: 'boolean' },
    { env: 'GATEWAY_RUNTIME_TOKEN_BUDGET', path: 'runtime.tokenBudget', type: 'number' },
    { env: 'GATEWAY_RUNTIME_STREAM', path: 'runtime.stream', type: 'boolean' },
    { env: 'GATEWAY_RUNTIME_HISTORY_LIMIT', path: 'runtime.historyLimit', type: 'number' },
    { env: 'GATEWAY_LLM_PROVIDER', path: 'runtime.llm.provider', type: 'string' },
    { env: 'GATEWAY_LLM_BASE_URL', path: 'runtime.llm.baseUrl', type: 'string' },
    { env: 'GATEWAY_LLM_API_KEY', path: 'runtime.llm.apiKey', type: 'string', secret: true },
    { env: 'GATEWAY_LLM_MODEL', path: 'runtime.llm.model', type: 'string' },

    // ── 会话与队列 ──────────────────────────────────────────────
    { env: 'GATEWAY_SESSION_MAX_HISTORY', path: 'session.maxHistoryLength', type: 'number' },
    { env: 'GATEWAY_QUEUE_MAX_RETRIES', path: 'messageQueue.maxRetries', type: 'number' },
    { env: 'GATEWAY_QUEUE_SEND_TIMEOUT', path: 'messageQueue.sendTimeout', type: 'number' },
];

/** 布尔值的宽松解析：接受 true/1/yes/on（大小写不敏感） */
function parseBoolean(raw, envName) {
    const v = String(raw).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off', ''].includes(v)) return false;
    throw new Error(`${envName}="${raw}" 不是合法布尔值（可用 true/false/1/0/yes/no/on/off）`);
}

/** 数组解析：逗号或空白分隔，自动去空项 */
function parseArray(raw) {
    return String(raw).split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
}

/** 按类型转换环境变量字符串 */
function coerce(raw, type, envName) {
    switch (type) {
        case 'number': {
            const n = Number(raw);
            if (!Number.isFinite(n)) {
                throw new Error(`${envName}="${raw}" 不是合法数字`);
            }
            return n;
        }
        case 'boolean':
            return parseBoolean(raw, envName);
        case 'array':
            return parseArray(raw);
        case 'string':
        default:
            return String(raw);
    }
}

/** 按点分路径写入嵌套对象（沿途缺失的层级自动补 {}） */
function setByPath(obj, dottedPath, value) {
    const keys = dottedPath.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (cur[k] === null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) {
            cur[k] = {};
        }
        cur = cur[k];
    }
    cur[keys[keys.length - 1]] = value;
}

/** 按点分路径读取 */
export function getByPath(obj, dottedPath) {
    return dottedPath.split('.').reduce(
        (o, k) => (o === null || o === undefined ? undefined : o[k]),
        obj,
    );
}

/**
 * 把环境变量覆盖应用到配置对象上（原地修改）。
 *
 * @param {object} config - 已合并了默认值与文件配置的配置对象
 * @param {object} [env] - 环境变量来源，默认 process.env（便于测试注入）
 * @returns {{applied: string[], errors: string[]}}
 *   applied: 被环境变量覆盖的配置路径列表（供 save() 排除回写）
 */
export function applyEnvOverrides(config, env = process.env) {
    const applied = [];
    const errors = [];

    for (const entry of ENV_MAP) {
        const raw = env[entry.env];
        // 未设置则跳过；空字符串视为"显式设为空"，允许（如清空 baseUrl）
        if (raw === undefined) continue;

        try {
            const value = coerce(raw, entry.type, entry.env);
            setByPath(config, entry.path, value);
            applied.push(entry.path);
            const shown = entry.secret
                ? (String(raw).length > 4 ? `***${String(raw).slice(-4)}` : '***')
                : JSON.stringify(value);
            logger.info(`环境变量覆盖: ${entry.path} = ${shown} (来自 ${entry.env})`);
        } catch (e) {
            // 不静默：配置写错时大声报错，但不中止启动
            // （中止会让容器陷入 CrashLoop，反而更难排查）
            errors.push(e.message);
            logger.error(`环境变量无效，已忽略并沿用原值: ${e.message}`);
        }
    }

    if (applied.length) {
        logger.info(`共应用 ${applied.length} 项环境变量覆盖`);
    }
    return { applied, errors };
}

/** 该配置路径是否属于敏感项（供 save() 与日志判断） */
export function isSecretPath(dottedPath) {
    const entry = ENV_MAP.find(e => e.path === dottedPath);
    return !!entry?.secret;
}

/** 生成环境变量文档表格（供 .env.example / 部署文档生成，避免文档与代码脱节） */
export function describeEnvVars() {
    return ENV_MAP.map(e => ({
        env: e.env,
        path: e.path,
        type: e.type,
        secret: !!e.secret,
    }));
}

export default { ENV_MAP, applyEnvOverrides, isSecretPath, describeEnvVars, getByPath };
