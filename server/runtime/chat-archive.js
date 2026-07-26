import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('chat-archive');

/**
 * 聊天存档（.jsonl，与 SillyTavern 互通）
 *
 * ST 的聊天记录是 JSONL：每行一个消息对象。首行通常是元数据（user_name/character_name/
 * create_date/chat_metadata），其余每行一条消息 { name, is_user, is_system, mes, send_date, ... }。
 *
 * 网关侧每个会话绑定一个存档文件。切换存档 = 换文件；新建存档 = 建新文件。
 * 这是"自由切换聊天存档"的物理基础，且文件可被 ST 直接打开续聊。
 */
export class ChatArchive {
    /**
     * @param {string} filePath - .jsonl 文件路径
     * @param {object} [meta] - 新建时的元数据 { userName, characterName }
     */
    constructor(filePath, meta = {}) {
        this.filePath = filePath;
        this.messages = [];        // { name, is_user, is_system, mes, send_date }
        this.meta = {
            user_name: meta.userName || 'User',
            character_name: meta.characterName || 'Assistant',
            create_date: meta.createDate || null, // 由调用方传入，避免此处产生副作用
            chat_metadata: {},
        };
        if (fs.existsSync(filePath)) this.load();
    }

    /**
     * 从文件加载（可重复调用）。
     *
     * 必须先清空再读：以前是直接 push，构造函数已经 load 过一次，
     * 外部再调一次就把整份历史又追加一遍（3 条变 6 条、再调变 9 条）。
     * 而"ST 在外部改了存档、网关重新载入"正是这套互通功能的正常用法，
     * 一旦触发就是历史凭空翻倍——喂给模型的上下文全是重复内容。
     */
    load() {
        try {
            const lines = fs.readFileSync(this.filePath, 'utf-8').split('\n').filter(Boolean);
            this.messages = [];
            if (lines.length === 0) return;
            // 首行：元数据（若可解析且含 user_name/character_name）
            let start = 0;
            try {
                const first = JSON.parse(lines[0]);
                if (first.user_name !== undefined || first.character_name !== undefined || first.chat_metadata !== undefined) {
                    this.meta = { ...this.meta, ...first };
                    start = 1;
                }
            } catch (_) { /* 首行非元数据，当作消息 */ }

            for (let i = start; i < lines.length; i++) {
                try {
                    this.messages.push(JSON.parse(lines[i]));
                } catch (e) {
                    logger.warn(`跳过损坏的存档行 ${i}: ${e.message}`);
                }
            }
        } catch (e) {
            logger.error(`加载存档失败 ${this.filePath}: ${e.message}`);
        }
    }

    /**
     * 追加一条消息
     * @param {{name?: string, isUser?: boolean, isSystem?: boolean, mes: string, sendDate?: number}} m
     */
    append(m) {
        const entry = {
            name: m.name || (m.isUser ? this.meta.user_name : this.meta.character_name),
            is_user: !!m.isUser,
            is_system: !!m.isSystem,
            send_date: m.sendDate || 0,
            mes: m.mes || '',
        };
        this.messages.push(entry);
        this._appendLine(entry);
        return entry;
    }

    /** 以 {role, content} 形式返回历史（供 prompt 组装），可限制条数 */
    getHistory(limit = 0) {
        const msgs = this.messages.filter(m => !m.is_system);
        const slice = limit > 0 ? msgs.slice(-limit) : msgs;
        return slice.map(m => ({
            role: m.is_user ? 'user' : 'assistant',
            content: m.mes,
            name: m.name,
        }));
    }

    /** 原子重写整个文件（含元数据首行） */
    save() {
        try {
            const lines = [JSON.stringify(this.meta), ...this.messages.map(m => JSON.stringify(m))];
            const tmp = this.filePath + '.tmp';
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(tmp, lines.join('\n') + '\n');
            fs.renameSync(tmp, this.filePath);
        } catch (e) {
            logger.error(`保存存档失败 ${this.filePath}: ${e.message}`);
        }
    }

    /** 增量追加一行（避免每次全量重写）；文件不存在则先写元数据首行 */
    _appendLine(entry) {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            if (!fs.existsSync(this.filePath)) {
                fs.writeFileSync(this.filePath, JSON.stringify(this.meta) + '\n');
            }
            fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
        } catch (e) {
            logger.error(`追加存档失败 ${this.filePath}: ${e.message}`);
        }
    }

    /** 清空消息（保留元数据），重写文件 */
    clear() {
        this.messages = [];
        this.save();
    }

    get length() { return this.messages.length; }
}

/** 列出目录下的存档文件 */
export function listArchives(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ name: path.basename(f, '.jsonl'), file: path.join(dir, f) }));
}

export default { ChatArchive, listArchives };
