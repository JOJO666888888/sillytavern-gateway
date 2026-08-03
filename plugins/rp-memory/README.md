# RP记忆管理插件 (rp-memory)

SillyTavern Gateway 插件 —— 为对话式角色扮演提供长期记忆管理。

## 功能

- **提取摘要**：自动从 AI 回复中提取 `<summary>` 标签内容，存储为长期记忆
- **剥离标签**：发送给用户前自动移除 `<think>`/`<thinking>` 和 `<summary>` 标签
- **上下文注入**：在用户消息前注入历史摘要，让 LLM 保持剧情连贯
- **跨平台记忆**：通过链接码在 QQ / Telegram / Discord 之间共享记忆

## 安装

### 方式一：从 GitHub 安装（推荐）

在网关面板「插件管理」->「从 GitHub 安装插件」填入：

```
https://github.com/JOJO666888888/rp-memory
```

或调用 API：

```bash
curl -X POST http://127.0.0.1:3210/api/plugins/install/github \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://github.com/JOJO666888888/rp-memory" }'
```

### 方式二：手动安装

将本仓库下载并放入网关的 `plugins/` 目录：

```
plugins/
└── rp-memory/
    ├── plugin.json
    └── index.js
```

重启网关或调用 `POST /api/plugins/rp-memory/reload`。

## 命令

| 命令 | 说明 |
|------|------|
| `/memory` | 查看记忆状态 |
| `/memory list` | 列出所有摘要 |
| `/memory clear` | 清空当前会话记忆 |
| `/memory limit <n>` | 设置上下文注入的摘要数量（0=关闭） |
| `/memory link` | 创建跨平台记忆链接码 |
| `/memory join <码>` | 加入已有记忆组 |

## 配置项

| 配置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `contextSummaries` | number | 10 | 每次注入的最近摘要数量 |
| `stripThinkTags` | boolean | true | 剥离 `<think>` 标签 |
| `stripSummaryTags` | boolean | true | 剥离 `<summary>` 标签 |
| `injectContext` | boolean | true | 是否注入历史摘要作为上下文 |
| `maxSummaries` | number | 100 | 每个记忆组最大摘要数 |

## 配合预设使用

本插件设计用于配合「露水情缘」预设工作。预设底部指令要求 AI 在正文后输出：

```
<summary>本次互动摘要（时间/地点/关键事件/角色状态变化，50字内）</summary>
```

插件自动提取此标签并存储，在后续对话中注入：

```
<memory>
# 以下是之前互动的记忆摘要，作为上下文参考：
[1] 苏晚和用户在咖啡馆相遇，聊起了她的插画工作
[2] 用户请苏晚喝了第二杯热可可，她笑了
</memory>
```

## 跨平台记忆

1. 在平台 A（如 QQ）发送 `/memory link`，得到链接码如 `A3K9XZ`
2. 在平台 B（如 Telegram）发送 `/memory join A3K9XZ`
3. 两个平台共享同一记忆池，剧情互通

## 数据存储

记忆数据持久化在 `data/plugins/rp-memory-data.json`，插件配置持久化在 `data/plugins/rp-memory.json`。

## 技术细节

- 出站过滤器 priority: 5（在 regex-filter 之前执行）
- 入站监听器 priority: 50（不阻止消息流转）
- 标签提取正则：`/<summary>([\s\S]*?)<\/summary>/g`
- 思维链剥离正则：`/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g`

## 许可

MIT
