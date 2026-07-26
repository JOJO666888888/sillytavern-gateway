import winston from 'winston';
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
        .replace(/\b[a-f0-9]{32,64}\b/gi, '<redacted-hex>');
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
