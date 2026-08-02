import winston from 'winston';
import Transport from 'winston-transport';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');

// 确保日志目录存在（否则 File transport 首启会静默失败）
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) { /* ignore */ }

const { combine, timestamp, printf, colorize, errors } = winston.format;

/**
 * 日志脱敏：对常见凭据形态打码，避免 Bot Token / 鉴权 token 明文落盘。
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
    if (typeof text !== 'string') return text;
    return text
        // Telegram Bot Token（含出现在 api.telegram.org/bot<token>/ 的形式）
        .replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/gi, 'bot<redacted>')
        .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '<redacted-token>')
        // Discord Bot Token（三段式）
        .replace(/\b[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g, '<redacted-token>')
        // 网关 authToken / 通用长十六进制串（≥32 位）
        .replace(/\b[a-f0-9]{32,64}\b/gi, '<redacted-hex>')
        // OpenAI 风格 API Key（sk- 开头），避免经日志接口泄露给前端
        .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '<redacted-key>');
}

// ---- 内存环缓冲：供 /api/gateway/logs 拉取最近日志（前端日志页 + 错误弹窗） ----
const RING_MAX = 500;
let ringSeq = 0;
const ringBuffer = [];

class RingBufferTransport extends Transport {
    log(info, callback) {
        try {
            ringSeq++;
            ringBuffer.push({
                seq: ringSeq,
                timestamp: info.timestamp || '',
                level: info.level,
                module: info.module || 'gateway',
                message: redactSecrets(String(info.message ?? info.stack ?? '')),
            });
            if (ringBuffer.length > RING_MAX) ringBuffer.shift();
        } catch (_) { /* 环缓冲不得影响主日志流 */ }
        callback();
    }
}

/**
 * 读取最近日志（供 /api/gateway/logs）。
 * @param {{since?:number, limit?:number, level?:string}} [opts]
 * @returns {{logs:Array, latestSeq:number}}
 */
export function getRecentLogs({ since = 0, limit = 200, level } = {}) {
    let entries = ringBuffer;
    if (since > 0) entries = entries.filter(e => e.seq > since);
    if (level) entries = entries.filter(e => e.level === level);
    const latestSeq = ringBuffer.length ? ringBuffer[ringBuffer.length - 1].seq : 0;
    if (limit && entries.length > limit) entries = entries.slice(-limit);
    return { logs: entries, latestSeq };
}

const logFormat = printf(({ level, message, timestamp, module, stack }) => {
    const mod = module ? `[${module}]` : '';
    const content = redactSecrets(stack || String(message ?? ''));
    return `${timestamp} ${level} ${mod} ${content}`;
});

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: combine(
        errors({ stack: true }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
    ),
    defaultMeta: { module: 'gateway' },
    transports: [
        new winston.transports.Console({
            format: combine(
                colorize(),
                errors({ stack: true }),
                timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                logFormat
            ),
        }),
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'error.log'),
            level: 'error',
            maxsize: 5 * 1024 * 1024,
            maxFiles: 5,
        }),
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'combined.log'),
            maxsize: 10 * 1024 * 1024,
            maxFiles: 5,
        }),
        // 内存环缓冲（供 /api/gateway/logs 实时拉取，脱敏后留存）
        new RingBufferTransport(),
    ],
});

/**
 * 创建带模块名的子日志器
 * @param {string} moduleName - 模块名称
 */
export function createLogger(moduleName) {
    return logger.child({ module: moduleName });
}

export default logger;
