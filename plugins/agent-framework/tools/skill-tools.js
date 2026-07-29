/**
 * Skill 工具
 * 加载和列出 Skill 文件（data/plugins/agent-framework/skills/ 目录下的 .md 文件）
 */

import fs from 'fs';
import path from 'path';

export function createSkillTools(dataDir) {
    const skillsDir = path.join(dataDir, 'skills');

    return [
        {
            name: 'skill.load',
            description: '加载 Skill 文件内容。读取 skills/ 目录下指定名称的 .md 文件。',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Skill 名称（不含 .md 后缀）' },
                },
                required: ['name'],
            },
            handler: async (args) => {
                const filePath = path.join(skillsDir, `${args.name}.md`);
                if (!fs.existsSync(filePath)) {
                    return { error: `Skill "${args.name}" 不存在` };
                }
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    return { name: args.name, content };
                } catch (e) {
                    return { error: `读取失败: ${e.message}` };
                }
            },
        },
        {
            name: 'skill.list',
            description: '列出所有可用的 Skill 文件。',
            parameters: { type: 'object', properties: {} },
            handler: async () => {
                try {
                    if (!fs.existsSync(skillsDir)) {
                        return { skills: [] };
                    }
                    const files = fs.readdirSync(skillsDir)
                        .filter(f => f.endsWith('.md'))
                        .map(f => f.replace(/\.md$/, ''));
                    return { skills: files };
                } catch (e) {
                    return { error: `列目录失败: ${e.message}`, skills: [] };
                }
            },
        },
    ];
}
