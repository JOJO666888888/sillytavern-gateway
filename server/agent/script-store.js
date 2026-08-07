/**
 * ScriptStore — Agent 剧场脚本库存储（对标酒馆助手 Tavern-Helper 脚本库）
 *
 * 数据形态完全兼容酒馆助手：
 *   - 全局脚本库  ← 酒馆助手 `extension_settings.tavern_helper.script.scripts`
 *   - 角色脚本库  ← 角色卡 `character.data.extensions.tavern_helper.scripts`（随角色卡导出）
 *
 * 持久化文件：`<dataDir>/agent-scripts.json`
 * {
 *   version: 1,
 *   global:   { scripts: ScriptTree[], variables: {} },
 *   character:{ "<角色名>": { scripts: ScriptTree[], variables: {} } },
 * }
 *
 * ScriptTree（与酒馆助手 @types/function/script.d.ts 对齐）：
 * {
 *   type: 'script', enabled: boolean, name: string, id: string,
 *   content: string, info: string,
 *   button: { enabled: boolean, buttons: [{ name: string, visible: boolean }] },
 *   data: Record<string, any>,
 *   export_with: { data: boolean, button: boolean },
 * }
 *
 * 本地扩展（非酒馆助手字段，导入导出角色卡时需剥离）：
 *   versions: [{ ts: number, content: string }]  —— 版本历史（最多 MAX_VERSIONS 个）
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

/** 版本历史最大保留数 */
const MAX_VERSIONS = 20;

/** 生成唯一版本时间戳（同毫秒多次保存时递增，保证 restoreVersion 定位准确） */
function nextVersionTs(versions) {
    const used = new Set((versions || []).map((v) => v.ts));
    let ts = Date.now();
    while (used.has(ts)) ts += 1;
    return ts;
}

/** 默认 ScriptTree 结构 */
function defaultScript() {
    return {
        type: 'script',
        enabled: true,
        name: '',
        id: randomUUID(),
        content: '',
        info: '',
        button: { enabled: true, buttons: [] },
        data: {},
        export_with: { data: true, button: true },
    };
}

/** 构建角色卡 / 外部导入的"纯净" ScriptTree（剥离本地扩展字段） */
export function toExportableScript(script) {
    if (!script || typeof script !== 'object') return null;
    const s = { ...script };
    delete s.versions; // 版本历史是本地扩展，导出卡时剥离
    return s;
}

export class ScriptStore {
    /**
     * @param {string} dataDir - data 根目录（agent-scripts.json 所在目录）
     */
    constructor(dataDir) {
        this.filePath = path.join(dataDir, 'agent-scripts.json');
        this.data = { version: 1, global: { scripts: [], variables: {} }, character: {} };
        this._load();
    }

    // ==================== 持久化 ====================

    _load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                if (raw && typeof raw === 'object') {
                    this.data = {
                        version: 1,
                        global: { scripts: Array.isArray(raw.global?.scripts) ? raw.global.scripts : [], variables: raw.global?.variables || {} },
                        character: raw.character || {},
                    };
                }
            }
        } catch (e) {
            // 损坏文件：不覆盖，内存用空库，等待人工处理
            this.data = { version: 1, global: { scripts: [], variables: {} }, character: {} };
        }
    }

    _save() {
        try {
            const tmp = `${this.filePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
            fs.renameSync(tmp, this.filePath);
            return true;
        } catch (e) {
            return false;
        }
    }

    // ==================== 作用域定位 ====================

    /**
     * 取某作用域的 { scripts, variables } 容器（不存在则创建）。
     * @param {'global'|'character'} scope
     * @param {string} character - scope='character' 时必填
     */
    _bucket(scope, character = '') {
        if (scope === 'character') {
            const key = character || '';
            if (!this.data.character[key]) this.data.character[key] = { scripts: [], variables: {} };
            return this.data.character[key];
        }
        return this.data.global;
    }

    // ==================== CRUD ====================

    /** 列脚本（精简版，不含 versions 大字段） */
    listScripts(scope, character = '') {
        const bucket = this._bucket(scope, character);
        return (bucket.scripts || []).map((s) => {
            const { versions, ...rest } = s;
            return rest;
        });
    }

    /** 取单个脚本全文（含 versions） */
    getScript(scope, character = '', id = '') {
        const bucket = this._bucket(scope, character);
        return (bucket.scripts || []).find((s) => s.id === id) || null;
    }

    /** 新建空白脚本 */
    createScript({ scope, character = '', name = '', content = '', info = '', enabled = true }) {
        const bucket = this._bucket(scope, character);
        if (!Array.isArray(bucket.scripts)) bucket.scripts = [];
        const script = { ...defaultScript(), name, content, info, enabled };
        bucket.scripts.push(script);
        this._save();
        return toExportableScript(script);
    }

    /**
     * 更新脚本（保存前自动留版本快照）。
     * patch 支持：name/content/info/enabled/button/data/export_with 任一字段。
     */
    updateScript({ scope, character = '', id = '', patch = {} }) {
        const bucket = this._bucket(scope, character);
        const script = (bucket.scripts || []).find((s) => s.id === id);
        if (!script) return null;
        // 版本快照：content 变化时保留旧版
        if (patch.content !== undefined && patch.content !== script.content) {
            if (!Array.isArray(script.versions)) script.versions = [];
            script.versions.push({ ts: nextVersionTs(script.versions), content: script.content });
            if (script.versions.length > MAX_VERSIONS) script.versions = script.versions.slice(-MAX_VERSIONS);
        }
        if (patch.name !== undefined) script.name = patch.name;
        if (patch.content !== undefined) script.content = patch.content;
        if (patch.info !== undefined) script.info = patch.info;
        if (patch.enabled !== undefined) script.enabled = !!patch.enabled;
        if (patch.button !== undefined) script.button = patch.button;
        if (patch.data !== undefined) script.data = patch.data;
        if (patch.export_with !== undefined) script.export_with = patch.export_with;
        this._save();
        return toExportableScript(script);
    }

    /** 删除脚本 */
    deleteScript({ scope, character = '', id = '' }) {
        const bucket = this._bucket(scope, character);
        const before = (bucket.scripts || []).length;
        bucket.scripts = (bucket.scripts || []).filter((s) => s.id !== id);
        if (bucket.scripts.length !== before) {
            this._save();
            return true;
        }
        return false;
    }

    // ==================== 版本管理 ====================

    getVersions(scope, character = '', id = '') {
        const script = this.getScript(scope, character, id);
        return script ? (script.versions || []).slice().reverse() : [];
    }

    /** 回滚到某版本时间戳对应的快照 */
    restoreVersion(scope, character = '', id = '', ts) {
        const bucket = this._bucket(scope, character);
        const script = (bucket.scripts || []).find((s) => s.id === id);
        if (!script || !Array.isArray(script.versions)) return null;
        const ver = script.versions.find((v) => v.ts === Number(ts));
        if (!ver) return null;
        // 当前内容入版本历史，再回滚
        script.versions.push({ ts: nextVersionTs(script.versions), content: script.content });
        if (script.versions.length > MAX_VERSIONS) script.versions = script.versions.slice(-MAX_VERSIONS);
        script.content = ver.content;
        this._save();
        return toExportableScript(script);
    }

    // ==================== 导入 ====================

    /**
     * 批量导入脚本（角色卡加载自动同步 / 手动导入共用）。
     * 同 id 覆盖更新（保留本地 enabled 选择与版本历史）；新 id 追加。
     * @param {Array} scripts - 酒馆助手 ScriptTree 数组（或 {name,content,...} 简化对象）
     * @param {object} [opts]
     * @param {boolean} [opts.autoDisable] - 首次导入时强制 enabled=false（角色卡自动同步用，
     *   防止"加载卡即自动执行不可信脚本"；用户需在小手机脚本 tab 手动启用）
     * @returns {{ imported: number, updated: number }}
     */
    importScripts(scope, character = '', scripts = [], opts = {}) {
        const bucket = this._bucket(scope, character);
        if (!Array.isArray(bucket.scripts)) bucket.scripts = [];
        const autoDisable = opts.autoDisable === true;
        let imported = 0, updated = 0;
        for (const raw of scripts) {
            if (!raw || typeof raw !== 'object') continue;
            const content = String(raw.content || '');
            if (!content && !raw.name) continue;
            const id = raw.id || randomUUID();
            const existIdx = bucket.scripts.findIndex((s) => s.id === id);
            const clean = {
                type: 'script',
                enabled: autoDisable ? false : (raw.enabled !== false),
                name: String(raw.name || '未命名脚本'),
                id,
                content,
                info: String(raw.info || ''),
                button: raw.button && typeof raw.button === 'object' ? raw.button : { enabled: true, buttons: [] },
                data: raw.data && typeof raw.data === 'object' ? raw.data : {},
                export_with: raw.export_with && typeof raw.export_with === 'object' ? raw.export_with : { data: true, button: true },
            };
            if (existIdx >= 0) {
                // 覆盖时保留本地扩展：用户 enabled 选择、版本历史、本地 button/data 配置（除非新卡明确携带非空值）
                const prev = bucket.scripts[existIdx];
                const button = (raw.button && typeof raw.button === 'object' && Array.isArray(raw.button.buttons))
                    ? raw.button
                    : (prev.button || { enabled: true, buttons: [] });
                const data = (raw.data && typeof raw.data === 'object' && Object.keys(raw.data).length)
                    ? raw.data
                    : (prev.data || {});
                const exportWith = (raw.export_with && typeof raw.export_with === 'object')
                    ? raw.export_with
                    : (prev.export_with || { data: true, button: true });
                bucket.scripts[existIdx] = { ...clean, enabled: prev.enabled, button, data, export_with: exportWith, versions: prev.versions || [] };
                updated += 1;
            } else {
                bucket.scripts.push(clean);
                imported += 1;
            }
        }
        if (imported + updated > 0) this._save();
        return { imported, updated };
    }

    /** 同步角色卡变量（extensions.tavern_helper.variables → 角色库 variables） */
    importVariables(character = '', variables = {}) {
        if (!variables || typeof variables !== 'object') return;
        const bucket = this._bucket('character', character);
        bucket.variables = { ...bucket.variables, ...variables };
        this._save();
    }

    // ==================== 变量 ====================

    getVariables(scope, character = '') {
        const bucket = this._bucket(scope, character);
        return bucket.variables || {};
    }

    setVariables(scope, character = '', variables = {}) {
        const bucket = this._bucket(scope, character);
        bucket.variables = variables;
        this._save();
    }
}
