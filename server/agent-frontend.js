/**
 * Agent 前端 URL 校验逻辑（模块 B：Agent 专用前端）
 *
 * 供 POST /api/agent-frontend/validate 路由使用；逻辑抽为纯函数，
 * 便于单元测试（见 test/agent-frontend.test.js）。
 *
 * 统一返回结构（需求 4 约定）：
 *   { ok: true,  status? }    —— 可达：2xx/3xx 正常可达；4xx 视为"页面存在即可访问"，用 status 标记实际状态码
 *   { ok: false, error }      —— 格式非法 / 网络错误 / 超时 / 5xx 服务异常，error 为可读中文提示
 *   非本机地址额外附带 warning 字段（提醒确认目标服务可信），不影响 ok/status/error 契约
 *
 * 校验分两步：
 *   1. 格式校验（纯函数，不产生网络请求）：
 *      - 必须以 http:// 或 https:// 开头
 *      - host 非空、无空格/控制字符
 *      - 可选端口需在 1-65535 之间
 *      - 拒绝 javascript:/file:/data: 等非 http(s) 协议（协议头校验天然拦截）
 *   2. 可访问性检测（需要网络，fetch 超时 5000ms）：
 *      - 2xx/3xx → 可达；4xx → 可达但标记 status；5xx → 不可达并提示
 *      - 网络错误（ECONNREFUSED / ENOTFOUND 等）与超时 → 不可达，返回可读中文提示，不暴露详细栈
 */

/** 校验 Agent 前端 URL 的格式，返回 { valid, error?, url?, protocol?, hostname?, port? } */
export function validateAgentFrontendUrl(url) {
    if (typeof url !== 'string' || !url.trim()) {
        return { valid: false, error: 'URL 不能为空，请填写 Agent 前端地址' };
    }
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
        return { valid: false, error: 'URL 需以 http:// 或 https:// 开头（例如 http://127.0.0.1:3210/agent）' };
    }

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (_) {
        return { valid: false, error: 'URL 格式无效，请检查是否包含非法字符或主机名不完整' };
    }

    if (!parsed.hostname) {
        return { valid: false, error: 'URL 缺少主机名（host），例如 http://127.0.0.1:3210/agent' };
    }
    // 主机名/主机不能含空格或控制字符（\u0000-\u001f）
    if (/[\s\u0000-\u001f]/.test(parsed.hostname) || /[\s\u0000-\u001f]/.test(parsed.host)) {
        return { valid: false, error: 'URL 主机名不能包含空格或控制字符' };
    }
    if (parsed.port) {
        const port = Number(parsed.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return { valid: false, error: `端口 ${parsed.port} 非法，端口需在 1-65535 之间` };
        }
    }

    return {
        valid: true,
        url: trimmed,
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || null,
    };
}

/** 判断 host 是否为本机地址（localhost / 127.0.0.1 / ::1 / *.localhost） */
export function isLocalhostHost(hostname) {
    return hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '::1'
        || hostname.endsWith('.localhost');
}

/**
 * 检测 Agent 前端 URL 的可访问性。
 *
 * @param {string} url - 待检测 URL
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl=globalThis.fetch] - 可注入的 fetch 实现（测试用）
 * @param {number} [opts.timeoutMs=5000] - 超时毫秒数
 * @returns {Promise<object>} 统一结构 { ok, status?, error? }（见文件头注释）
 */
export async function checkAgentFrontendReachable(url, opts = {}) {
    const { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = opts;
    const fmt = validateAgentFrontendUrl(url);
    if (!fmt.valid) return { ok: false, error: fmt.error };

    if (fmt.protocol !== 'http:' && fmt.protocol !== 'https:') {
        return { ok: false, error: '仅支持 http:// 或 https:// 协议' };
    }

    const warning = isLocalhostHost(fmt.hostname)
        ? undefined
        : '目标地址不是本机 localhost，请确认目标服务可信';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetchImpl(fmt.url, { method: 'GET', redirect: 'follow', signal: controller.signal });
        if (resp.status >= 200 && resp.status <= 399) {
            // 2xx/3xx：正常可达
            return { ok: true, status: resp.status, ...(warning ? { warning } : {}) };
        }
        if (resp.status >= 400 && resp.status <= 499) {
            // 4xx：页面存在即可访问（如 404 占位页），标记 status 视为可达
            return { ok: true, status: resp.status, ...(warning ? { warning } : {}) };
        }
        // 5xx：目标服务异常
        return {
            ok: false,
            status: resp.status,
            error: `无法访问：目标服务异常（HTTP ${resp.status}）`,
            ...(warning ? { warning } : {}),
        };
    } catch (e) {
        const aborted = e && e.name === 'AbortError';
        const code = e && e.code;
        let error;
        if (aborted) {
            error = `无法访问：连接超时（${timeoutMs}ms 内无响应）`;
        } else if (code === 'ECONNREFUSED') {
            error = '无法访问：目标拒绝连接（服务未启动或端口未监听）';
        } else if (code === 'ENOTFOUND') {
            error = '无法访问：域名无法解析（DNS 解析失败）';
        } else {
            error = `无法访问：${(e && e.message) || '网络错误'}`;
        }
        return { ok: false, error, ...(warning ? { warning } : {}) };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 创建 POST /api/agent-frontend/validate 的路由处理函数。
 * 依赖通过 opts 注入（fetchImpl / timeoutMs），便于测试。
 */
export function createAgentFrontendValidateHandler(opts = {}) {
    return async (req, res) => {
        try {
            const url = req?.body?.url;
            const result = await checkAgentFrontendReachable(url, opts);
            res.json(result);
        } catch (e) {
            res.status(500).json({ ok: false, error: `校验失败: ${e.message}` });
        }
    };
}
