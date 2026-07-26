/**
 * 测试辅助工具
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

/** 创建临时目录，返回路径；调用返回的 cleanup() 删除 */
export function tmpDir(prefix = 'stgw-test-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return {
        dir,
        cleanup() {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
        },
    };
}

/** 静默 logger，避免测试输出被日志淹没 */
export const silentLogger = {
    info() {}, warn() {}, error() {}, debug() {},
    child() { return silentLogger; },
};

// ==================== PNG 角色卡构造 ====================

function crc32(buf) {
    let c;
    const table = [];
    for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([len, typeAndData, crc]);
}

/**
 * 构造一个内嵌角色卡的最小合法 PNG
 * @param {object} card - 角色卡对象（会被 JSON+base64 写入 tEXt/zTXt）
 * @param {object} opts - { keyword: 'chara'|'ccv3', compressed: boolean }
 * @returns {Buffer}
 */
export function buildCharacterPng(card, opts = {}) {
    const keyword = opts.keyword || 'chara';
    const payload = Buffer.from(JSON.stringify(card), 'utf-8').toString('base64');

    let chunk;
    if (opts.compressed) {
        // zTXt: keyword \0 compressionMethod(0) zlib压缩数据
        const compressed = zlib.deflateSync(Buffer.from(payload, 'latin1'));
        chunk = pngChunk('zTXt', Buffer.concat([
            Buffer.from(`${keyword}\0`, 'latin1'),
            Buffer.from([0]),
            compressed,
        ]));
    } else {
        chunk = pngChunk('tEXt', Buffer.concat([
            Buffer.from(`${keyword}\0`, 'latin1'),
            Buffer.from(payload, 'latin1'),
        ]));
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 签名
        pngChunk('IHDR', Buffer.alloc(13)),
        chunk,
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

/** 等待若干毫秒 */
export function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
