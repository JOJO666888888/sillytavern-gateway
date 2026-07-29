/**
 * 文件工具
 * 操作工作区文件（data/plugins/agent-framework/ 目录下）
 * 使用 Node.js fs 模块直接操作（工具执行上下文中无 ctx.fs）
 */

import fs from 'fs';
import path from 'path';

export function createFileTools(dataDir) {
    /**
     * 将用户提供的相对路径解析为工作区内的绝对路径，并防止目录穿越
     */
    function resolvePath(relativePath) {
        const resolved = path.resolve(dataDir, relativePath);
        // 防止目录穿越：确保解析后的路径在 dataDir 内
        if (!resolved.startsWith(dataDir)) {
            return null;
        }
        return resolved;
    }

    return [
        {
            name: 'file.read',
            description: '读取工作区文件内容。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '文件相对路径（相对于工作区根目录）' },
                },
                required: ['path'],
            },
            handler: async (args) => {
                const filePath = resolvePath(args.path);
                if (!filePath) return { error: '路径非法' };
                if (!fs.existsSync(filePath)) return { error: `文件不存在: ${args.path}` };
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    return { path: args.path, content };
                } catch (e) {
                    return { error: `读取失败: ${e.message}` };
                }
            },
        },
        {
            name: 'file.write',
            description: '写入工作区文件（覆盖原有内容）。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '文件相对路径（相对于工作区根目录）' },
                    content: { type: 'string', description: '文件内容' },
                },
                required: ['path', 'content'],
            },
            handler: async (args) => {
                const filePath = resolvePath(args.path);
                if (!filePath) return { error: '路径非法' };
                try {
                    fs.mkdirSync(path.dirname(filePath), { recursive: true });
                    fs.writeFileSync(filePath, args.content, 'utf-8');
                    return { success: true, path: args.path };
                } catch (e) {
                    return { error: `写入失败: ${e.message}` };
                }
            },
        },
        {
            name: 'file.list',
            description: '列出工作区目录下的文件和子目录。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '目录相对路径（可选，默认为根目录）' },
                },
            },
            handler: async (args) => {
                const dirPath = resolvePath(args.path || '.');
                if (!dirPath) return { error: '路径非法' };
                if (!fs.existsSync(dirPath)) return { error: `目录不存在: ${args.path}` };
                try {
                    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                    const items = entries.map(e => ({
                        name: e.name,
                        type: e.isDirectory() ? 'directory' : 'file',
                    }));
                    return { path: args.path || '.', items };
                } catch (e) {
                    return { error: `列目录失败: ${e.message}` };
                }
            },
        },
    ];
}
