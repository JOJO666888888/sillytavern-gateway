import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('card-loader');

/**
 * SillyTavern 角色卡加载器
 *
 * 支持：
 *   - PNG 内嵌角色卡（tEXt / zTXt chunk，关键字 `chara`(V2) 或 `ccv3`(V3)，值为 base64 JSON）
 *   - 纯 JSON 角色卡（V1 扁平 / V2 / V3）
 * 归一化为统一结构，供 prompt 组装使用。
 *
 * 规范参考：Character Card V2 / V3（chara_card_v2 / chara_card_v3）
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 从 PNG 缓冲区提取所有 tEXt/zTXt 文本块（keyword -> value）
 * @param {Buffer} buf
 * @returns {Record<string,string>}
 */
export function extractPngTextChunks(buf) {
    if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('不是有效的 PNG 文件');
    }
    const chunks = {};
    let offset = 8;
    while (offset + 8 <= buf.length) {
        const length = buf.readUInt32BE(offset);
        const type = buf.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd > buf.length) break;
        const data = buf.subarray(dataStart, dataEnd);

        if (type === 'tEXt' || type === 'zTXt') {
            const nulIdx = data.indexOf(0x00);
            if (nulIdx > 0) {
                const keyword = data.toString('latin1', 0, nulIdx);
                let value;
                if (type === 'tEXt') {
                    value = data.toString('latin1', nulIdx + 1);
                } else {
                    // zTXt: keyword \0 compressionMethod(1字节) compressedData
                    const compressed = data.subarray(nulIdx + 2);
                    try {
                        value = zlib.inflateSync(compressed).toString('latin1');
                    } catch (e) {
                        logger.warn(`zTXt 解压失败(${keyword}): ${e.message}`);
                        value = '';
                    }
                }
                // 后出现的同名块覆盖先出现的
                if (value) chunks[keyword] = value;
            }
        }

        if (type === 'IEND') break;
        offset = dataEnd + 4; // 跳过 4 字节 CRC
    }
    return chunks;
}

/**
 * 从 PNG 缓冲区解析角色卡 JSON
 * @param {Buffer} buf
 * @returns {object} 原始卡对象（未归一化）
 */
export function parseCharacterCardPng(buf) {
    const chunks = extractPngTextChunks(buf);
    // V3 优先（ccv3），其次 V2（chara）
    const raw = chunks.ccv3 || chunks.chara;
    if (!raw) throw new Error('PNG 中未找到角色卡数据（缺少 chara / ccv3 文本块）');
    let json;
    try {
        // base64 → UTF-8 JSON
        json = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
    } catch (e) {
        throw new Error(`角色卡 JSON 解析失败: ${e.message}`);
    }
    return json;
}

/**
 * 把 V1/V2/V3 角色卡归一化为统一结构
 * @param {object} card - 原始卡对象
 * @returns {object}
 */
export function normalizeCard(card) {
    // V2/V3 数据在 card.data 下；V1 是扁平结构
    const spec = card.spec || '';
    const d = (spec.startsWith('chara_card_') && card.data) ? card.data : card;

    // first_mes（V1/V2/V3 字段）→ 归一化导出 firstMes / firstMessage / first_message 三种别名：
    //  - firstMes：历史遗留命名，现有调用方（如 runtime-assets.test.js）依赖
    //  - firstMessage / first_message：P3 开场白机制的规范命名（V2 规范 first_mes）
    const firstMessage = d.first_mes || d.char_greeting || '';

    return {
        spec: spec || 'chara_card_v1',
        name: d.name || d.char_name || '',
        description: d.description || '',
        personality: d.personality || '',
        scenario: d.scenario || '',
        firstMes: firstMessage,
        firstMessage,
        first_message: firstMessage,
        mesExample: d.mes_example || d.example_dialogue || '',
        systemPrompt: d.system_prompt || '',
        postHistoryInstructions: d.post_history_instructions || '',
        alternateGreetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [],
        // alternate_greetings：与 first_message 一致的规范命名（V2 字段原名）
        alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [],
        // 内嵌世界书（character_book）——归一化交给世界书引擎的 normalizeLorebook
        characterBook: d.character_book || null,
        tags: Array.isArray(d.tags) ? d.tags : [],
        creator: d.creator || '',
        characterVersion: d.character_version || '',
        creatorNotes: d.creator_notes || '',
        extensions: d.extensions || {},
    };
}

/**
 * 从文件加载并归一化角色卡（.png 或 .json）
 * @param {string} filePath
 * @returns {object} 归一化后的角色卡
 */
export function loadCharacterCard(filePath) {
    // 防御：确保传入的是文件而非目录（避免 EISDIR）
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (e) {
        throw new Error(`角色卡文件不存在: ${filePath}`);
    }
    if (!stat.isFile()) {
        throw new Error(`角色卡路径不是文件: ${filePath}`);
    }
    const ext = path.extname(filePath).toLowerCase();
    const buf = fs.readFileSync(filePath);
    let raw;
    if (ext === '.png') {
        raw = parseCharacterCardPng(buf);
    } else if (ext === '.json') {
        raw = JSON.parse(buf.toString('utf-8'));
    } else {
        throw new Error(`不支持的角色卡格式: ${ext}（仅 .png / .json）`);
    }
    const card = normalizeCard(raw);
    card._sourcePath = filePath;
    return card;
}

/**
 * 按名称从目录加载角色卡（修复 EISDIR：正确区分文件与目录）。
 *
 * 加载顺序：
 *   1. 精确匹配：`<dir>/<name>.json` / `<dir>/<name>.png`（name 已带扩展名时直接精确匹配）
 *   2. 目录扫描回退：basename 忽略大小写匹配（覆盖 .PNG/.Json 等大小写差异与特殊字符文件名）
 *   3. 每步均校验 statSync().isFile()，目录不会被误当作文件读取
 *
 * @param {string} dir - 角色卡目录
 * @param {string} name - 角色名（可带或不带 .json/.png 扩展名）
 * @returns {object|null} 归一化角色卡，未找到返回 null
 */
export function loadCharacterCardByName(dir, name) {
    if (!dir || !name || !fs.existsSync(dir)) return null;
    const ext = path.extname(name).toLowerCase();
    const hasExt = ext === '.json' || ext === '.png';
    // 带其他扩展名（如 .txt）直接返回 null：避免去掉扩展名后误匹配同 basename 的角色卡
    if (ext && !hasExt) return null;
    const candidates = hasExt
        ? [path.join(dir, name)]
        : [path.join(dir, name + '.json'), path.join(dir, name + '.png')];
    for (const filePath of candidates) {
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) continue; // 目录/其他类型跳过，不尝试读取
        } catch (e) {
            continue; // 不存在
        }
        try {
            return loadCharacterCard(filePath);
        } catch (e) {
            // 解析失败继续尝试下一个候选
        }
    }
    // 目录扫描回退：大小写不敏感匹配 basename
    const targetExt = path.extname(name).toLowerCase();
    const baseName = targetExt ? name.slice(0, -targetExt.length) : name;
    const baseLower = baseName.toLowerCase();
    const extSet = new Set(['.json', '.png']);
    for (const f of fs.readdirSync(dir)) {
        const fExt = path.extname(f).toLowerCase();
        if (!extSet.has(fExt)) continue;
        const fBase = f.slice(0, -fExt.length);
        if (fBase.toLowerCase() !== baseLower) continue;
        const filePath = path.join(dir, f);
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) continue;
        } catch (e) {
            continue;
        }
        try {
            return loadCharacterCard(filePath);
        } catch (e) {
            // 解析失败尝试下一个
        }
    }
    return null;
}

/**
 * 扫描目录列出角色卡（不解析全部内容，仅取名）
 * @param {string} dir
 * @returns {Array<{name: string, file: string}>}
 */
export function listCharacterCards(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir)) {
        const ext = path.extname(f).toLowerCase();
        if (ext === '.png' || ext === '.json') {
            out.push({ name: path.basename(f, ext), file: path.join(dir, f) });
        }
    }
    return out;
}

export default { loadCharacterCard, loadCharacterCardByName, parseCharacterCardPng, extractPngTextChunks, normalizeCard, listCharacterCards };
