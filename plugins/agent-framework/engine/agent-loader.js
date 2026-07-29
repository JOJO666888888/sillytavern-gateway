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
        if (/^-?\d+$/.test(val)) return parseInt(val);
        if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
        // 去除引号
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            return val.slice(1, -1);
        }
        return val;
    }
    
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
                    // 可能是对象列表项
                    const obj = {};
                    const [k, ...v] = val.split(': ');
                    obj[k.trim()] = parseValue(v.join(': '));
                    parent.push(obj);
                } else if (val === '') {
                    // 多行列表项，看下一行
                    i++;
                    const subVal = {};
                    parseBlock(indent + 2, subVal);
                    parent.push(subVal);
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
                    parseBlock(indent + 2, child);
                    parent[key] = child;
                    continue;
                } else {
                    parent[key] = parseValue(val);
                }
            }
            i++;
        }
    }
    
    parseBlock(0, result);
    return result;
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
        return Array.from(this.agents.values()).map(a => ({
            name: a.name,
            displayName: a.displayName || a.name,
            description: a.description || '',
            tools: a.tools || [],
            subAgents: (a.subAgents || []).map(s => s.name),
        }));
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
