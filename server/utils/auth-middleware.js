/**
 * 共享鉴权与 CORS 中间件
 *
 * P0-4 修复：此前主网关（server/index.js）内联实现鉴权与 CORS，
 * 独立 Agent 服务（server/agent-server.js）完全没有鉴权、CORS 全开。
 * 现将逻辑抽为共享模块，主网关与独立服务使用同一套保护策略：
 *   - createCorsMiddleware：Origin 反射白名单（鉴权开启时放行任意 Origin，token 头才是真正的保护）
 *   - createGatewayAuthMiddleware：所有 /api/* 需携带正确的 X-Gateway-Token（恒定时间比较）
 */

import crypto from 'crypto';

/**
 * 恒定时间比较两个 token，避免时序侧信道
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function tokenEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch (_) {
        return false;
    }
}

/**
 * 判断请求 Origin 是否允许跨域（与主网关原逻辑一致）。
 *
 * 放行规则（任一命中即放行）：
 *   1) server.allowedOrigins 白名单里显式列出的 Origin
 *   2) localhost / 127.0.0.1 / [::1] 的任意端口（本机常见部署）
 *   3) 鉴权开启（requireAuth=true）时放行任意 Origin
 *      理由：网关用 X-Gateway-Token 头鉴权（非 Cookie），恶意网页拿不到 token
 *      就调不动任何 /api/* 接口，token 仍是真正的保护层。
 *
 * 鉴权关闭（requireAuth=false）时不走第 3 条，CORS 退回严格白名单，
 * 避免无鉴权的服务被任意网页 drive-by 调用。
 *
 * @param {object} configManager - 配置管理器
 * @returns {(origin: string) => boolean}
 */
export function createOriginCheck(configManager) {
    return function isOriginAllowed(origin) {
        if (!origin) return false;
        const allowed = configManager.get('server.allowedOrigins') || [];
        if (allowed.includes(origin)) return true;
        try {
            const { hostname } = new URL(origin);
            if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
        } catch (_) {
            return false;
        }
        const requireAuth = configManager.get('server.requireAuth') !== false;
        return requireAuth;
    };
}

/**
 * CORS 中间件：Origin 反射白名单（非通配），并声明自定义鉴权头。
 * @param {object} configManager
 * @returns {import('express').RequestHandler}
 */
export function createCorsMiddleware(configManager) {
    const isOriginAllowed = createOriginCheck(configManager);
    return (req, res, next) => {
        const origin = req.headers.origin;
        if (isOriginAllowed(origin)) {
            res.header('Access-Control-Allow-Origin', origin);
            res.header('Vary', 'Origin');
        }
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Gateway-Token');
        if (req.method === 'OPTIONS') {
            return res.sendStatus(204);
        }
        next();
    };
}

/**
 * 鉴权中间件：所有 /api/* 需携带正确的 X-Gateway-Token。
 * 例外：健康检查（前端探活用，先于配置 token）与 OPTIONS 预检。
 * @param {object} configManager
 * @returns {import('express').RequestHandler}
 */
export function createGatewayAuthMiddleware(configManager) {
    return (req, res, next) => {
        if (req.method === 'OPTIONS') return next();
        if (!req.path.startsWith('/api/')) return next();
        if (req.path === '/api/gateway/health') return next();

        const requireAuth = configManager.get('server.requireAuth') !== false;
        if (!requireAuth) return next();

        const expected = configManager.get('server.authToken');
        if (!expected) {
            // requireAuth 开启但无 token（异常状态）→ 拒绝，避免裸奔
            return res.status(503).json({ success: false, error: '网关鉴权未就绪（authToken 缺失）' });
        }

        const provided = req.headers['x-gateway-token'] ||
            (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
            // EventSource(SSE) 无法设置自定义 header，只能通过 query 传递 token。
            // 仅对 GET 请求、且仅在 header 缺 token 时回退，避免 token 常驻 URL。
            (req.method === 'GET' ? (req.query.token || '') : '');
        if (!tokenEquals(String(provided), String(expected))) {
            return res.status(401).json({
                success: false,
                error: '鉴权失败：缺少或错误的 X-Gateway-Token。请在网关面板填入正确的 token（网关启动控制台会明文打印）',
            });
        }
        next();
    };
}
