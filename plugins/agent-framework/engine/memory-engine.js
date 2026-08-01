import fs from 'fs';
import path from 'path';

const MEMORY_TYPES = ['project', 'reference', 'feedback', 'user'];

/**
 * 记忆引擎
 * 管理四层记忆：project(剧情进度)/reference(参考)/feedback(偏好)/user(用户设定)
 * 支持自动摘要（每N轮调用LLM生成剧情摘要）
 *
 * SubTask 6.8 独立角色模式：支持 namespace 隔离。
 * - 全局记忆（namespace=''）：memory/<type>.md
 * - 角色独立记忆（namespace='char:alice'）：memory/char/alice/<type>.md
 * 这样每个角色子代理拥有独立的四层记忆，实现认知隔离。
 */
export class MemoryEngine {
    constructor(dataDir, options = {}) {
        this.memoryDir = path.join(dataDir, 'memory');
        fs.mkdirSync(this.memoryDir, { recursive: true });
        this.summaryInterval = options.summaryInterval || 10;
        this.llm = null; // 运行时注入
    }

    setLLM(llm) {
        this.llm = llm;
    }

    /**
     * 将 namespace 转换为安全的子目录路径段。
     * 'char:alice' -> 'char/alice'，'' -> ''（全局）
     * @param {string} namespace
     * @returns {string}
     * @private
     */
    _namespaceToPath(namespace) {
        if (!namespace) return '';
        // 把 namespace 中的冒号转为路径分隔符，并清洗非法字符
        return String(namespace)
            .replace(/:/g, path.sep)
            .replace(/[^a-zA-Z0-9_\-\\/]/g, '_');
    }

    /**
     * 根据 namespace 计算记忆文件的完整路径。
     * @param {string} type - 记忆类型（project/reference/feedback/user）
     * @param {string} [namespace] - 命名空间，空或未传则用全局记忆
     * @returns {string}
     * @private
     */
    _getFilePath(type, namespace) {
        const sub = this._namespaceToPath(namespace || '');
        if (!sub) {
            return path.join(this.memoryDir, `${type}.md`);
        }
        const nsDir = path.join(this.memoryDir, sub);
        if (!fs.existsSync(nsDir)) {
            fs.mkdirSync(nsDir, { recursive: true });
        }
        return path.join(nsDir, `${type}.md`);
    }

    /**
     * 读取记忆文件
     * @param {string} type - 记忆类型
     * @param {string} [namespace] - 命名空间（独立角色模式用）
     */
    read(type, namespace = '') {
        if (!MEMORY_TYPES.includes(type)) return null;
        const filePath = this._getFilePath(type, namespace);
        if (!fs.existsSync(filePath)) return '';
        return fs.readFileSync(filePath, 'utf-8').trim();
    }

    /**
     * 更新记忆文件
     * @param {string} type - 记忆类型
     * @param {string} content - 新内容
     * @param {string} [namespace] - 命名空间
     */
    update(type, content, namespace = '') {
        if (!MEMORY_TYPES.includes(type)) return false;
        const filePath = this._getFilePath(type, namespace);
        fs.writeFileSync(filePath, content, 'utf-8');
        return true;
    }

    /**
     * 追加到记忆文件
     * @param {string} type - 记忆类型
     * @param {string} content - 追加内容
     * @param {string} [namespace] - 命名空间
     */
    append(type, content, namespace = '') {
        if (!MEMORY_TYPES.includes(type)) return false;
        const existing = this.read(type, namespace) || '';
        const updated = existing ? `${existing}\n\n${content}` : content;
        return this.update(type, updated, namespace);
    }

    /**
     * 检索记忆（简单关键词匹配）
     * @param {string} query - 查询关键词
     * @param {number} [limit=5] - 结果上限
     * @param {string} [namespace] - 命名空间；未传或空则检索全局记忆
     */
    recall(query, limit = 5, namespace = '') {
        const results = [];
        for (const type of MEMORY_TYPES) {
            const content = this.read(type, namespace);
            if (!content) continue;
            // 简单关键词匹配：按段落分割，匹配关键词
            const paragraphs = content.split(/\n\n+/);
            for (const para of paragraphs) {
                if (query.split(/\s+/).some(q => para.toLowerCase().includes(q.toLowerCase()))) {
                    results.push({ type, content: para, namespace: namespace || '' });
                }
                if (results.length >= limit) return results;
            }
        }
        return results;
    }

    /**
     * 获取所有记忆的 prompt 片段
     * @param {string} [namespace] - 命名空间；未传或空则取全局记忆
     */
    getPromptSnippet(namespace = '') {
        const parts = [];
        const labels = {
            project: '剧情记忆',
            reference: '参考信息',
            feedback: '用户偏好',
            user: '用户设定',
        };
        for (const type of MEMORY_TYPES) {
            const content = this.read(type, namespace);
            if (content) {
                parts.push(`【${labels[type]}】\n${content}`);
            }
        }
        return parts.join('\n\n');
    }

    /**
     * 列出所有已创建的 namespace 目录（供调试/管理用）。
     * 返回相对 memoryDir 的子目录路径列表，不含全局。
     * @returns {string[]}
     */
    listNamespaces() {
        const result = [];
        const walk = (dir, prefix) => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                // 如果该目录下有 .md 文件，则视为一个 namespace 叶子
                const hasMd = fs.readdirSync(path.join(dir, entry.name)).some(f => f.endsWith('.md'));
                if (hasMd) result.push(rel);
                walk(path.join(dir, entry.name), rel);
            }
        };
        walk(this.memoryDir, '');
        return result;
    }

    /**
     * 自动摘要：调用 LLM 生成剧情摘要
     * @param {Array} history - 对话历史
     * @param {string} [namespace] - 命名空间
     */
    async generateSummary(history, namespace = '') {
        if (!this.llm || !history || history.length === 0) return null;

        const dialogText = history
            .filter(h => h.role === 'user' || h.role === 'assistant')
            .slice(-20)
            .map(h => `${h.role === 'user' ? '用户' : 'AI'}: ${(h.content || '').slice(0, 500)}`)
            .join('\n');

        const messages = [
            {
                role: 'system',
                content: '你是一个剧情摘要助手。请根据以下对话记录，生成一份简短的剧情进度摘要（不超过300字），包含：当前剧情进展、关键事件、角色关系变化、下一阶段可能的方向。只输出摘要内容。',
            },
            { role: 'user', content: dialogText },
        ];

        try {
            const summary = await this.llm.chat(messages, { temperature: 0.3, max_tokens: 4096 });
            if (summary && summary.trim()) {
                this.update('project', summary.trim(), namespace);
                return summary.trim();
            }
        } catch (e) {
            // 静默失败
        }
        return null;
    }

    /**
     * 检查是否需要生成摘要
     */
    shouldSummarize(turnCount) {
        if (this.summaryInterval <= 0) return false;
        return turnCount > 0 && turnCount % this.summaryInterval === 0;
    }
}
