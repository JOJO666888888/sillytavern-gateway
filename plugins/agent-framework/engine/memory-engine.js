import fs from 'fs';
import path from 'path';

const MEMORY_TYPES = ['project', 'reference', 'feedback', 'user'];

/**
 * 记忆引擎
 * 管理四层记忆：project(剧情进度)/reference(参考)/feedback(偏好)/user(用户设定)
 * 支持自动摘要（每N轮调用LLM生成剧情摘要）
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
     * 读取记忆文件
     */
    read(type) {
        if (!MEMORY_TYPES.includes(type)) return null;
        const filePath = path.join(this.memoryDir, `${type}.md`);
        if (!fs.existsSync(filePath)) return '';
        return fs.readFileSync(filePath, 'utf-8').trim();
    }

    /**
     * 更新记忆文件
     */
    update(type, content) {
        if (!MEMORY_TYPES.includes(type)) return false;
        const filePath = path.join(this.memoryDir, `${type}.md`);
        fs.writeFileSync(filePath, content, 'utf-8');
        return true;
    }

    /**
     * 追加到记忆文件
     */
    append(type, content) {
        if (!MEMORY_TYPES.includes(type)) return false;
        const existing = this.read(type) || '';
        const updated = existing ? `${existing}\n\n${content}` : content;
        return this.update(type, updated);
    }

    /**
     * 检索记忆（简单关键词匹配）
     */
    recall(query, limit = 5) {
        const results = [];
        for (const type of MEMORY_TYPES) {
            const content = this.read(type);
            if (!content) continue;
            // 简单关键词匹配：按段落分割，匹配关键词
            const paragraphs = content.split(/\n\n+/);
            for (const para of paragraphs) {
                if (query.split(/\s+/).some(q => para.toLowerCase().includes(q.toLowerCase()))) {
                    results.push({ type, content: para });
                }
                if (results.length >= limit) return results;
            }
        }
        return results;
    }

    /**
     * 获取所有记忆的 prompt 片段
     */
    getPromptSnippet() {
        const parts = [];
        for (const type of MEMORY_TYPES) {
            const content = this.read(type);
            if (content) {
                const labels = {
                    project: '剧情记忆',
                    reference: '参考信息',
                    feedback: '用户偏好',
                    user: '用户设定',
                };
                parts.push(`【${labels[type]}】\n${content}`);
            }
        }
        return parts.join('\n\n');
    }

    /**
     * 自动摘要：调用 LLM 生成剧情摘要
     */
    async generateSummary(history) {
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
            const summary = await this.llm.chat(messages, { temperature: 0.3, max_tokens: 512 });
            if (summary && summary.trim()) {
                this.update('project', summary.trim());
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
