import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('media-store');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'media-cache');

/**
 * 媒体缓存服务
 *
 * 解决跨平台媒体转发的根本问题：各平台的媒体定位方式不兼容——
 *   - QQ(OneBot)：http URL，但常带时效签名，其它平台拉取时可能已失效；
 *   - Telegram：file_id，不是任何 HTTP 客户端能识别的 URL；
 *   - message-to-image 等本地渲染：file:// 本地路径，Telegram/Discord 无法接受。
 *
 * 本服务把这些统一：把媒体（时效URL/本地文件）落地到本地缓存，并通过
 * 一个稳定的 /media/:id URL 对外提供，任何平台都能拉取。file_id 由各适配器
 * 通过 resolver 先转成 URL 再入库。
 */
export class MediaStore {
    /**
     * @param {object} options
     * @param {string} [options.cacheDir] - 缓存目录
     * @param {number} [options.maxBytes] - 单文件下载上限（字节），默认 20MB
     * @param {number} [options.downloadTimeout] - 下载超时 (ms)，默认 20s
     * @param {number} [options.ttlMs] - 缓存文件保留时长 (ms)，默认 6 小时
     */
    constructor(options = {}) {
        this.cacheDir = options.cacheDir || DEFAULT_CACHE_DIR;
        this.maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
        this.downloadTimeout = options.downloadTimeout ?? 20000;
        this.ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
        // id -> { path, mimeType, createdAt }
        this._entries = new Map();
        this._ensureDir();
        // 定期清理过期缓存
        this._cleanupTimer = setInterval(() => this._cleanup(), Math.max(this.ttlMs / 2, 60000));
        if (typeof this._cleanupTimer?.unref === 'function') this._cleanupTimer.unref();
    }

    _ensureDir() {
        try {
            if (!fs.existsSync(this.cacheDir)) fs.mkdirSync(this.cacheDir, { recursive: true });
        } catch (e) {
            logger.error(`创建媒体缓存目录失败: ${e.message}`);
        }
    }

    /** 注册一个已在本地的文件，返回可对外访问的 id */
    registerLocalFile(filePath, mimeType = '') {
        const id = crypto.randomBytes(12).toString('hex');
        this._entries.set(id, { path: filePath, mimeType, createdAt: Date.now() });
        return id;
    }

    /** 把内存 Buffer 落地到缓存并返回可对外访问的 id */
    registerBuffer(buf, mimeType = 'application/octet-stream') {
        const id = crypto.randomBytes(12).toString('hex');
        const ext = this._extFromMime(mimeType);
        const filePath = path.join(this.cacheDir, `${id}${ext}`);
        try {
            fs.writeFileSync(filePath, buf);
        } catch (e) {
            logger.error(`写入媒体缓存失败: ${e.message}`);
            return null;
        }
        this._entries.set(id, { path: filePath, mimeType, createdAt: Date.now() });
        return id;
    }

    /**
     * 下载远程 URL 到缓存并返回 id（带大小上限与超时）。
     * @param {string} url
     * @returns {Promise<string>} 缓存 id
     */
    async download(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.downloadTimeout);
        try {
            const resp = await fetch(url, { signal: controller.signal });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const contentLength = parseInt(resp.headers.get('content-length') || '0');
            if (contentLength && contentLength > this.maxBytes) {
                throw new Error(`媒体过大 (${contentLength} > ${this.maxBytes})`);
            }
            const mimeType = resp.headers.get('content-type') || 'application/octet-stream';
            const buf = Buffer.from(await resp.arrayBuffer());
            if (buf.length > this.maxBytes) throw new Error(`媒体过大 (${buf.length} > ${this.maxBytes})`);

            const id = crypto.randomBytes(12).toString('hex');
            const ext = this._extFromMime(mimeType);
            const filePath = path.join(this.cacheDir, `${id}${ext}`);
            fs.writeFileSync(filePath, buf);
            this._entries.set(id, { path: filePath, mimeType, createdAt: Date.now() });
            return id;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 把一个 MediaAsset 转成任意平台都能拉取的稳定 URL。
     * - 已有 http(s) url：可选下载缓存（cacheRemote=true 时，用于时效 URL）；否则原样返回。
     * - localPath：注册并返回 /media/:id。
     * @param {import('../adapters/base-adapter.js').MediaAsset} asset
     * @param {string} baseUrl - 网关对外可访问的基址，如 http://host:3210
     * @param {object} [opts] - { cacheRemote?: boolean }
     * @returns {Promise<string|null>}
     */
    async toServableUrl(asset, baseUrl, opts = {}) {
        try {
            if (asset.localPath) {
                const id = this.registerLocalFile(asset.localPath, asset.mimeType);
                return `${baseUrl}/media/${id}`;
            }
            if (asset.url) {
                if (opts.cacheRemote) {
                    const id = await this.download(asset.url);
                    return `${baseUrl}/media/${id}`;
                }
                return asset.url;
            }
            return null;
        } catch (e) {
            logger.warn(`媒体转换失败(${asset.type}): ${e.message}`);
            // 缓存失败时退回原始 URL（至少不比现状差）
            return asset.url || null;
        }
    }

    /** Express 处理器：GET /media/:id */
    handler() {
        return (req, res) => {
            const entry = this._entries.get(req.params.id);
            if (!entry || !fs.existsSync(entry.path)) {
                return res.status(404).send('Not Found');
            }
            if (entry.mimeType) res.setHeader('Content-Type', entry.mimeType);
            res.setHeader('Cache-Control', 'private, max-age=3600');
            fs.createReadStream(entry.path).pipe(res);
        };
    }

    _cleanup() {
        const now = Date.now();
        for (const [id, entry] of this._entries) {
            if (now - entry.createdAt > this.ttlMs) {
                try { if (fs.existsSync(entry.path)) fs.unlinkSync(entry.path); } catch (_) { /* ignore */ }
                this._entries.delete(id);
            }
        }
    }

    _extFromMime(mime) {
        const map = {
            'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
            'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
            'video/mp4': '.mp4', 'application/pdf': '.pdf',
        };
        return map[(mime || '').split(';')[0].trim()] || '';
    }

    stop() {
        if (this._cleanupTimer) { clearInterval(this._cleanupTimer); this._cleanupTimer = null; }
    }
}

// 单例
export const mediaStore = new MediaStore();
export default mediaStore;
