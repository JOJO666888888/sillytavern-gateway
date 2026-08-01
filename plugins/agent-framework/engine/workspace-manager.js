import fs from 'fs';
import path from 'path';

/**
 * Workspace + Journal 管理器（借鉴 TauriTavern 的 Workspace-as-Truth 轻量 JS 版）
 *
 * 目录结构：
 *   <dataRoot>/runs/<run-id>/
 *     ├── manifest.json       run 元信息
 *     ├── events.jsonl        append-only 事件流（Journal）
 *     ├── output/             run 级产物（commit 时 promote 到会话层）
 *     ├── scratch/            run 级临时文件
 *     └── checkpoints/<cp-id>/ 关键节点快照（含 output/ + manifest + events）
 *
 *   <dataRoot>/sessions/<session-id>/persist/  会话级稳定层（commit 合并目标）
 *
 * 设计目标（见 spec.md "可审计可回滚的 Workspace"）：
 *   - 所有变更先写 run 级 workspace，失败/取消不污染稳定层
 *   - 每次变更追加事件到 events.jsonl，seq 单调递增（从 1 起）
 *   - 关键节点自动 checkpoint，支持 rollback
 *   - 路径穿越防护：所有 relPath 经 _safeResolve 校验
 *
 * 性能优化（SubTask 7.2）：
 *   - appendEvent 不每次重读文件计数：维护内存级 seq 计数器（_seqCache）
 *   - appendEvent 不每次 fs.appendFileSync：按 run 聚合到写入缓冲 _writeBuffer，
 *     每 100ms 或读取/检查点/提交前 flush
 *   - 100 次 appendEvent 耗时从 ~250ms 降到 ~3ms（基准测试守护，见 test/performance.test.js）
 */
export class WorkspaceManager {
    /**
     * @param {object} [options]
     * @param {string} [options.dataRoot] - 数据根目录，默认 data/plugins/agent-framework
     * @param {object} [options.logger]
     * @param {number} [options.flushIntervalMs=100] - 写入缓冲 flush 间隔（毫秒）
     */
    constructor({ dataRoot, logger, flushIntervalMs = 100 } = {}) {
        this.dataRoot = dataRoot || 'data/plugins/agent-framework';
        this.runsDir = path.resolve(this.dataRoot, 'runs');
        this.sessionsDir = path.resolve(this.dataRoot, 'sessions');
        fs.mkdirSync(this.runsDir, { recursive: true });
        fs.mkdirSync(this.sessionsDir, { recursive: true });
        this.logger = logger || console;
        /** @type {Map<string, number>} runId -> 已知最大 seq（避免每次 appendEvent 重读文件） */
        this._seqCache = new Map();
        /** @type {Map<string, Array<{line:string, seq:number}>>} runId -> 待 flush 的事件缓冲 */
        this._writeBuffer = new Map();
        this._flushIntervalMs = flushIntervalMs;
        /** @type {Map<string, NodeJS.Timeout>} runId -> 定时 flush 句柄 */
        this._flushTimers = new Map();
    }

    /**
     * 销毁时清理所有定时器与未 flush 缓冲。
     * 进程退出前应调用，或由调用方在 run 结束时调 flushRun。
     */
    dispose() {
        for (const runId of this._writeBuffer.keys()) {
            this._flushRunNow(runId);
        }
        for (const t of this._flushTimers.values()) clearTimeout(t);
        this._flushTimers.clear();
    }

    // ------------------------------------------------------------------
    // 路径与 id 安全
    // ------------------------------------------------------------------

    /**
     * 安全解析 relPath 相对 baseDir 的绝对路径，防穿越。
     * - 绝对路径或逃逸 baseDir（含 ..）一律抛错
     * @param {string} baseDir
     * @param {string} relPath
     * @returns {string} 解析后的绝对路径
     * @private
     */
    _safeResolve(baseDir, relPath) {
        if (relPath == null || relPath === '') return baseDir;
        if (typeof relPath !== 'string') {
            throw new Error(`路径必须为字符串: ${String(relPath)}`);
        }
        if (path.isAbsolute(relPath)) {
            throw new Error(`路径穿越被拒绝（绝对路径）: ${relPath}`);
        }
        const resolved = path.resolve(baseDir, relPath);
        const rel = path.relative(baseDir, resolved);
        if (rel === '') return resolved;
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`路径穿越被拒绝: ${relPath}`);
        }
        return resolved;
    }

    /**
     * 把任意 id 规整为安全的路径段（剔除分隔符 / 冒号 / 斜杠，杜绝穿越）。
     * @param {string} id
     * @returns {string}
     * @private
     */
    _safeId(id) {
        return String(id).replace(/[^a-zA-Z0-9_\-.]/g, '_');
    }

    /**
     * run 目录。runId 为内部生成的 id，不得含路径分隔符 / `..`，否则抛错。
     * @param {string} runId
     * @returns {string}
     */
    getRunDir(runId) {
        return this._safeResolve(this.runsDir, runId);
    }

    /**
     * 会话目录（稳定层根）。sessionId 可能来自外部（如 platform:chatId），
     * 先规整为安全路径段再解析。
     * @param {string} sessionId
     * @returns {string}
     */
    getSessionDir(sessionId) {
        return this._safeResolve(this.sessionsDir, this._safeId(sessionId));
    }

    // ------------------------------------------------------------------
    // run 初始化
    // ------------------------------------------------------------------

    /**
     * 初始化 run 级 workspace：创建目录结构、写 manifest、append init checkpoint 事件。
     * @param {string} runId
     * @param {object} [options]
     * @param {string} [options.sessionId]
     * @param {object} [options.manifest]
     */
    initRun(runId, { sessionId, manifest } = {}) {
        const runDir = this.getRunDir(runId);
        fs.mkdirSync(path.join(runDir, 'output'), { recursive: true });
        fs.mkdirSync(path.join(runDir, 'scratch'), { recursive: true });
        fs.mkdirSync(path.join(runDir, 'checkpoints'), { recursive: true });

        const manifestObj = {
            runId,
            sessionId: sessionId || null,
            manifest: manifest || {},
            createdAt: new Date().toISOString(),
        };
        fs.writeFileSync(
            path.join(runDir, 'manifest.json'),
            JSON.stringify(manifestObj, null, 2),
            'utf-8',
        );

        // 空 events.jsonl（若不存在则创建）
        const eventsFile = path.join(runDir, 'events.jsonl');
        if (!fs.existsSync(eventsFile)) {
            fs.writeFileSync(eventsFile, '', 'utf-8');
        }

        this.appendEvent(runId, 'checkpoint', { label: 'init' });
        // init checkpoint 立即落盘（审计事件不应停留在缓冲）
        this._flushRunNow(runId);
    }

    // ------------------------------------------------------------------
    // 文件读写
    // ------------------------------------------------------------------

    /**
     * 写文本文件（relPath 相对 run 目录，自动建父目录）。
     * @param {string} runId
     * @param {string} relPath
     * @param {string} text
     * @returns {string} 写入的绝对路径
     */
    writeText(runId, relPath, text) {
        const runDir = this.getRunDir(runId);
        const abs = this._safeResolve(runDir, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text ?? '', 'utf-8');
        return abs;
    }

    /**
     * 读文本文件。
     * @param {string} runId
     * @param {string} relPath
     * @returns {string|null} 文件不存在返回 null
     */
    readText(runId, relPath) {
        const runDir = this.getRunDir(runId);
        const abs = this._safeResolve(runDir, relPath);
        if (!fs.existsSync(abs)) return null;
        return fs.readFileSync(abs, 'utf-8');
    }

    /**
     * 列出 run 目录下文件（相对路径 + 类型）。
     * @param {string} runId
     * @param {string} [relPath=''] 列出的子目录（相对 run 目录）
     * @param {object} [options]
     * @param {number} [options.depth=1] 递归深度
     * @param {number} [options.maxEntries=200] 最大返回条数
     * @returns {Array<{path:string, type:'file'|'dir'}>}
     */
    listFiles(runId, relPath = '', { depth = 1, maxEntries = 200 } = {}) {
        const runDir = this.getRunDir(runId);
        const abs = this._safeResolve(runDir, relPath);
        if (!fs.existsSync(abs)) return [];

        const entries = [];
        const walk = (dir, curDepth) => {
            if (entries.length >= maxEntries) return;
            let items;
            try { items = fs.readdirSync(dir, { withFileTypes: true }); }
            catch { return; }
            for (const it of items) {
                if (entries.length >= maxEntries) return;
                const full = path.join(dir, it.name);
                const rel = path.relative(runDir, full).split(path.sep).join('/');
                entries.push({ path: rel, type: it.isDirectory() ? 'dir' : 'file' });
                if (it.isDirectory() && curDepth < depth) {
                    walk(full, curDepth + 1);
                }
            }
        };
        walk(abs, 1);
        return entries;
    }

    // ------------------------------------------------------------------
    // Journal（events.jsonl）
    // ------------------------------------------------------------------

    /**
     * 统计 events.jsonl 现有行数（用于初始化 seq 计数器）。
     * @param {string} runDir
     * @returns {number}
     * @private
     */
    _countEvents(runDir) {
        const eventsFile = path.join(runDir, 'events.jsonl');
        if (!fs.existsSync(eventsFile)) return 0;
        const content = fs.readFileSync(eventsFile, 'utf-8');
        if (!content) return 0;
        return content.replace(/\n$/, '').split('\n').filter(Boolean).length;
    }

    /**
     * 获取（或初始化）runId 的内存级 seq 计数器。
     * 首次访问时从磁盘计数一次，后续直接内存自增，避免每次 appendEvent 都重读文件。
     * @param {string} runId
     * @returns {number} 当前最大 seq（0 表示尚无事件）
     * @private
     */
    _getSeq(runId) {
        if (this._seqCache.has(runId)) return this._seqCache.get(runId);
        // 同时考虑磁盘已有事件 + 未 flush 的缓冲（rollback/重启场景）
        const runDir = this.getRunDir(runId);
        let seq = this._countEvents(runDir);
        const pending = this._writeBuffer.get(runId);
        if (pending) seq += pending.length;
        this._seqCache.set(runId, seq);
        return seq;
    }

    /**
     * 把 run 的待 flush 缓冲立即写入磁盘。
     * 调用幂等：缓冲为空时直接返回。
     * @param {string} runId
     */
    flushRun(runId) {
        this._flushRunNow(runId);
    }

    /**
     * 内部 flush 实现：把缓冲合并为一次 fs.appendFileSync。
     * @param {string} runId
     * @private
     */
    _flushRunNow(runId) {
        const buf = this._writeBuffer.get(runId);
        if (!buf || buf.length === 0) {
            // 仍要清掉定时器，避免无谓唤醒
            const t = this._flushTimers.get(runId);
            if (t) { clearTimeout(t); this._flushTimers.delete(runId); }
            return;
        }
        this._writeBuffer.delete(runId);
        const t = this._flushTimers.get(runId);
        if (t) { clearTimeout(t); this._flushTimers.delete(runId); }

        const runDir = this.getRunDir(runId);
        const eventsFile = path.join(runDir, 'events.jsonl');
        fs.mkdirSync(runDir, { recursive: true });
        // 一次性追加所有缓冲行（批量 IO）
        fs.appendFileSync(eventsFile, buf.map(e => e.line).join(''), 'utf-8');
    }

    /**
     * 安排 run 的延迟 flush（节流：100ms 内多次 appendEvent 只 flush 一次）。
     * @param {string} runId
     * @private
     */
    _scheduleFlush(runId) {
        if (this._flushTimers.has(runId)) return;
        const timer = setTimeout(() => {
            this._flushTimers.delete(runId);
            this._flushRunNow(runId);
        }, this._flushIntervalMs);
        // 不阻止进程退出
        if (timer.unref) timer.unref();
        this._flushTimers.set(runId, timer);
    }

    /**
     * 追加一行 JSON 事件到 events.jsonl。
     * seq 从 1 起、按 run 内单调递增（首次从磁盘计数初始化，之后内存自增）。
     *
     * 性能：事件先入内存缓冲，由 _scheduleFlush 延迟 100ms 批量写入；
     * 调用方在关键节点（getEvents / createCheckpoint / commit / rollback）会强制 flush。
     *
     * @param {string} runId
     * @param {string} type - 事件类型（tool_call / state_change / subagent / checkpoint / commit / draft 等）
     * @param {object} [payload={}]
     * @returns {number} 本次事件的 seq
     */
    appendEvent(runId, type, payload = {}) {
        const seq = this._getSeq(runId) + 1;
        this._seqCache.set(runId, seq);
        const line = JSON.stringify({
            seq,
            type,
            payload,
            timestamp: Date.now(),
        }) + '\n';

        if (!this._writeBuffer.has(runId)) this._writeBuffer.set(runId, []);
        this._writeBuffer.get(runId).push({ line, seq });
        this._scheduleFlush(runId);
        return seq;
    }

    /**
     * 读取事件（供时间线 UI 重建）。
     * 先 flush 待写缓冲，再从磁盘读，保证读到最新数据。
     * @param {string} runId
     * @param {object} [options]
     * @param {number} [options.afterSeq=0] 只返回 seq > afterSeq 的事件
     * @param {number} [options.limit=100]
     * @returns {Array<object>}
     */
    getEvents(runId, { afterSeq = 0, limit = 100 } = {}) {
        this._flushRunNow(runId);
        const runDir = this.getRunDir(runId);
        const eventsFile = path.join(runDir, 'events.jsonl');
        if (!fs.existsSync(eventsFile)) return [];
        const content = fs.readFileSync(eventsFile, 'utf-8');
        if (!content.trim()) return [];

        const out = [];
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
            let ev;
            try { ev = JSON.parse(line); } catch { continue; }
            if (ev.seq > afterSeq) {
                out.push(ev);
                if (out.length >= limit) break;
            }
        }
        return out;
    }

    // ------------------------------------------------------------------
    // Checkpoint / Commit / Rollback
    // ------------------------------------------------------------------

    /**
     * 递归复制目录树。
     * @param {string} src
     * @param {string} dst
     * @private
     */
    _copyTree(src, dst) {
        if (!fs.existsSync(src)) return;
        fs.mkdirSync(dst, { recursive: true });
        for (const it of fs.readdirSync(src, { withFileTypes: true })) {
            const s = path.join(src, it.name);
            const d = path.join(dst, it.name);
            if (it.isDirectory()) this._copyTree(s, d);
            else fs.copyFileSync(s, d);
        }
    }

    /**
     * 合并复制（src 覆盖 dst 中同名文件），记录被 promote 的相对路径。
     * @param {string} src
     * @param {string} dst
     * @param {string[]} promoted
     * @param {string} relBase
     * @private
     */
    _mergeTree(src, dst, promoted, relBase = '') {
        if (!fs.existsSync(src)) return;
        fs.mkdirSync(dst, { recursive: true });
        for (const it of fs.readdirSync(src, { withFileTypes: true })) {
            const s = path.join(src, it.name);
            const d = path.join(dst, it.name);
            const rel = relBase ? `${relBase}/${it.name}` : it.name;
            if (it.isDirectory()) {
                this._mergeTree(s, d, promoted, rel);
            } else {
                fs.copyFileSync(s, d);
                promoted.push(rel);
            }
        }
    }

    /**
     * 递归删除目录（自底向上：先删文件再删空目录）。
     * 说明：Windows 下 fs.rmSync({recursive:true,force:true}) 有时会静默失败（force 吞错），
     * 这里用 unlinkSync + rmdirSync 手动递归，保证可删除。
     * @param {string} target
     * @private
     */
    _removeDirRecursive(target) {
        if (!fs.existsSync(target)) return;
        try {
            for (const it of fs.readdirSync(target, { withFileTypes: true })) {
                const full = path.join(target, it.name);
                if (it.isDirectory()) this._removeDirRecursive(full);
                else fs.unlinkSync(full);
            }
            fs.rmdirSync(target);
        } catch (e) {
            // 兜底：尝试 rmSync（force 吞错），失败则忽略（调用方按需重建目录）
            fs.rmSync(target, { recursive: true, force: true });
        }
    }

    /**
     * 创建 checkpoint：复制 output/ + manifest + events 到 checkpoints/<cp-id>/。
     * @param {string} runId
     * @param {string} label - checkpoint 标签（after-draft / before-commit / rollback 等）
     * @returns {string} checkpoint id
     */
    createCheckpoint(runId, label) {
        const runDir = this.getRunDir(runId);
        const cpId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const cpDir = this._safeResolve(path.join(runDir, 'checkpoints'), cpId);
        fs.mkdirSync(cpDir, { recursive: true });

        // flush 待写缓冲，确保快照包含最新事件（SubTask 7.2）
        this._flushRunNow(runId);

        this._copyTree(path.join(runDir, 'output'), path.join(cpDir, 'output'));
        for (const f of ['manifest.json', 'events.jsonl']) {
            const src = path.join(runDir, f);
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(cpDir, f));
        }

        this.appendEvent(runId, 'checkpoint', { label, checkpointId: cpId });
        // 上面 appendEvent 入缓冲，checkpoint 事件应立即落盘以便审计
        this._flushRunNow(runId);
        return cpId;
    }

    /**
     * commit：把 output/ promote 到会话级 persist/（合并覆盖），append commit 事件。
     * @param {string} runId
     * @returns {string[]} 被 promote 的相对路径清单
     */
    commit(runId) {
        const runDir = this.getRunDir(runId);

        // flush 待写缓冲，确保 events.jsonl 是最新（commit 事件随后追加）
        this._flushRunNow(runId);

        // 从 manifest 取 sessionId
        let sessionId = null;
        const manifestPath = path.join(runDir, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
            try {
                sessionId = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).sessionId;
            } catch { /* ignore */ }
        }

        const promoted = [];
        const outputDir = path.join(runDir, 'output');
        if (sessionId && fs.existsSync(outputDir)) {
            const persistDir = path.join(this.getSessionDir(sessionId), 'persist');
            fs.mkdirSync(persistDir, { recursive: true });
            this._mergeTree(outputDir, persistDir, promoted);
        }

        this.appendEvent(runId, 'commit', { promoted, sessionId });
        // commit 事件立即落盘
        this._flushRunNow(runId);
        return promoted;
    }

    /**
     * rollback：从 checkpoint 恢复 run workspace（output/），journal 保持 append-only。
     * @param {string} runId
     * @param {string} checkpointId
     * @returns {boolean}
     */
    rollback(runId, checkpointId) {
        const runDir = this.getRunDir(runId);
        const cpDir = this._safeResolve(path.join(runDir, 'checkpoints'), checkpointId);
        if (!fs.existsSync(cpDir)) {
            throw new Error(`checkpoint 不存在: ${checkpointId}`);
        }

        // flush 待写缓冲，避免 rollback 后丢失审计事件
        this._flushRunNow(runId);

        // 恢复 output/（先清空现有再复制）
        const outDst = path.join(runDir, 'output');
        this._removeDirRecursive(outDst);
        const outSrc = path.join(cpDir, 'output');
        if (fs.existsSync(outSrc)) this._copyTree(outSrc, outDst);

        // manifest 一并恢复（events.jsonl 不动，保持 append-only 审计链）
        const mSrc = path.join(cpDir, 'manifest.json');
        if (fs.existsSync(mSrc)) fs.copyFileSync(mSrc, path.join(runDir, 'manifest.json'));

        // rollback 后磁盘 seq 计数器可能已变（若有外部修改），重置以重新从磁盘计数
        this._seqCache.delete(runId);

        this.appendEvent(runId, 'checkpoint', { label: 'rollback', checkpointId });
        this._flushRunNow(runId);
        return true;
    }
}

export default WorkspaceManager;
