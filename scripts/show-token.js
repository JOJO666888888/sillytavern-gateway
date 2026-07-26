#!/usr/bin/env node
/**
 * 打印当前生效的网关鉴权 token。
 *
 * 存在的理由：日志管道会把长十六进制串脱敏（防止用户贴日志时泄露凭据），
 * 所以自动生成的 token 没法从 `docker compose logs` 里捞出来。
 * 这个脚本直接读配置，是取回 token 的官方途径。
 *
 * 用法：
 *   npm run token
 *   docker compose exec gateway npm run token
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'gateway.json');

// 环境变量优先——与 server/utils/env-config.js 的覆盖顺序保持一致
const fromEnv = process.env.GATEWAY_AUTH_TOKEN;
if (fromEnv) {
    console.log(fromEnv);
    console.error('（来源：环境变量 GATEWAY_AUTH_TOKEN，未落盘）');
    process.exit(0);
}

if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`配置文件不存在: ${CONFIG_FILE}`);
    console.error('网关至少启动过一次才会生成 token。');
    process.exit(1);
}

let token;
try {
    token = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))?.server?.authToken;
} catch (e) {
    console.error(`配置文件解析失败: ${e.message}`);
    process.exit(1);
}

if (!token) {
    console.error('配置里没有 server.authToken。');
    console.error('若 server.requireAuth 为 false 则无需 token；否则启动一次网关会自动生成。');
    process.exit(1);
}

// token 走 stdout、说明走 stderr，方便 `npm run token --silent | pbcopy` 这类管道
console.log(token);
