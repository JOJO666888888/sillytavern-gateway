import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 简易 YAML 解析器
 * 支持基本格式：键值对、多行字符串(|)、列表(-)、嵌套缩进
 * 不支持复杂 YAML 特性（锚点、引用、流式语法等）
 */
function parseYAML(text) {
    // 使用 node 内置能力，如果没有 js-yaml 就用简单解析
    try {
        // 尝试动态导入 js-yaml（如果安装了的话）
        const yaml = globalThis._jsYaml;
        if (yaml) return yaml.load(text);
    } catch (e) { /* fall through */ }
    
    // 简易解析
    return simpleYAMLParse(text);
}

function simpleYAMLParse(text) {
    const lines = text.split('\n');
    const result = {};
    let i = 0;

    function parseValue(val) {
        val = val.trim();
        if (val === 'true') return true;
        if (val === 'false') return false;
        if (val === 'null' || val === '~') return null;
        if (val === '[]') return [];
        if (val === '{}') return {};
        if (/^-?\d+$/.test(val)) return parseInt(val);
        if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
        // 去除引号
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            return val.slice(1, -1);
        }
        return val;
    }

    /**
     * 解析一个缩进块。
     * 返回值可能被重新赋值为数组（当块内容是列表时），
     * 因此调用方必须使用返回值而非依赖传入的 parent 引用。
     * @param {number} startIndent
     * @param {object|Array} parent
     * @returns {object|Array} 解析后的 parent（可能是数组）
     */
    function parseBlock(startIndent, parent) {
        while (i < lines.length) {
            const line = lines[i];
            // 跳过空行和注释
            if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }

            const indent = line.length - line.trimStart().length;
            if (indent < startIndent) break;

            const trimmed = line.trim();

            // 列表项
            if (trimmed.startsWith('- ')) {
                if (!Array.isArray(parent)) parent = [];
                const val = trimmed.slice(2).trim();
                if (val.includes(': ')) {
                    // 对象列表项：- key: value 后续行可能是同一对象的更多属性
                    const obj = {};
                    const [k, ...v] = val.split(': ');
                    const valPart = v.join(': ').trim();
                    if (valPart === '|' || valPart === '>') {
                        // 多行字符串值
                        i++;
                        const blockLines = [];
                        const blockIndent = indent + 4; // - 后内容缩进 + 2
                        while (i < lines.length) {
                            const bl = lines[i];
                            if (!bl.trim()) { blockLines.push(''); i++; continue; }
                            const bi = bl.length - bl.trimStart().length;
                            if (bi < blockIndent) break;
                            blockLines.push(bl.slice(blockIndent));
                            i++;
                        }
                        obj[k.trim()] = valPart === '|' ? blockLines.join('\n') : blockLines.join('\n').trim();
                    } else if (valPart === '') {
                        // 值为空，可能是嵌套对象
                        i++;
                        const child = {};
                        const maybeArray = parseBlock(indent + 4, child);
                        obj[k.trim()] = maybeArray;
                    } else {
                        obj[k.trim()] = parseValue(valPart);
                        // 普通值：推进到下一行（| 和空值分支已在内部推进）
                        i++;
                    }
                    // 解析同缩进级别的更多属性（如 trigger: after_draft）
                    // 这些属性在 `- ` 之后的行中，缩进 >= indent + 2
                    const moreProps = parseBlock(indent + 2, obj);
                    parent.push(moreProps);
                    continue;
                } else if (val === '') {
                    // 多行列表项，看下一行
                    i++;
                    const subVal = {};
                    const maybeArray = parseBlock(indent + 2, subVal);
                    parent.push(maybeArray);
                    continue;
                } else {
                    parent.push(parseValue(val));
                }
                i++;
                continue;
            }

            // 键值对
            const colonIdx = trimmed.indexOf(':');
            if (colonIdx > 0) {
                const key = trimmed.slice(0, colonIdx).trim();
                let val = trimmed.slice(colonIdx + 1).trim();

                if (val === '|' || val === '>') {
                    // 多行字符串
                    i++;
                    const blockLines = [];
                    const blockIndent = indent + 2;
                    while (i < lines.length) {
                        const bl = lines[i];
                        if (!bl.trim()) { blockLines.push(''); i++; continue; }
                        const bi = bl.length - bl.trimStart().length;
                        if (bi < blockIndent) break;
                        blockLines.push(bl.slice(blockIndent));
                        i++;
                    }
                    parent[key] = val === '|' ? blockLines.join('\n') : blockLines.join('\n').trim();
                    continue;
                } else if (val === '') {
                    // 嵌套块
                    i++;
                    const child = {};
                    const maybeArray = parseBlock(indent + 2, child);
                    parent[key] = maybeArray;
                    continue;
                } else {
                    parent[key] = parseValue(val);
                }
            }
            i++;
        }
        return parent;
    }

    const parsed = parseBlock(0, result);
    return parsed;
}

export class AgentLoader {
    constructor(agentsDir) {
        this.agentsDir = agentsDir;
        this.agents = new Map();
    }

    /**
     * 加载所有 Agent 定义
     */
    loadAll() {
        this.agents.clear();
        if (!fs.existsSync(this.agentsDir)) {
            fs.mkdirSync(this.agentsDir, { recursive: true });
            return;
        }
        for (const file of fs.readdirSync(this.agentsDir)) {
            if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
            try {
                const text = fs.readFileSync(path.join(this.agentsDir, file), 'utf-8');
                const def = parseYAML(text);
                if (def && def.name) {
                    this.agents.set(def.name, def);
                }
            } catch (e) {
                console.error(`[agent-loader] 加载 ${file} 失败: ${e.message}`);
            }
        }
    }

    /**
     * 获取 Agent 定义
     */
    get(name) {
        return this.agents.get(name);
    }

    /**
     * 列出所有 Agent
     */
    list() {
        return Array.from(this.agents.values()).map(a => {
            const tools = Array.isArray(a.tools) ? a.tools : [];
            const subAgents = Array.isArray(a.subAgents) ? a.subAgents : [];
            return {
                name: a.name,
                displayName: a.displayName || a.name,
                description: a.description || '',
                tools,
                subAgents: subAgents.map(s => (s && typeof s === 'object') ? s.name : s),
                isDefault: a.isDefault === true,
            };
        });
    }

    /**
     * 获取标记为 isDefault: true 的 Agent 定义。
     * 若有多个，返回第一个；若无，返回 null。
     * 供 _cmdStart 在用户未指定 Profile 时自动选用默认方案。
     */
    getDefault() {
        for (const def of this.agents.values()) {
            if (def && def.isDefault === true) return def;
        }
        return null;
    }

    /**
     * 获取默认 Agent 的 name（便利方法）。
     * @returns {string|null}
     */
    getDefaultName() {
        const def = this.getDefault();
        return def ? def.name : null;
    }

    /**
     * 保存 Agent 定义
     */
    save(name, yamlText) {
        const def = parseYAML(yamlText);
        if (!def || !def.name) throw new Error('Agent 定义缺少 name 字段');
        const filePath = path.join(this.agentsDir, `${def.name}.yaml`);
        fs.writeFileSync(filePath, yamlText, 'utf-8');
        this.agents.set(def.name, def);
        return def;
    }

    /**
     * 删除 Agent 定义
     */
    delete(name) {
        const filePath = path.join(this.agentsDir, `${name}.yaml`);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        this.agents.delete(name);
    }

    /**
     * 热重载
     */
    reload() {
        this.loadAll();
    }
}
