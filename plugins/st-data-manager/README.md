# ST数据管理插件 (st-data-manager)

SillyTavern Gateway 插件 -- 远程管理 SillyTavern 数据 + 多群聊角色路由。

## 核心功能

1. **角色卡管理** -- 上传/删除/列出 ST 角色卡（支持 V3 内嵌世界书）
2. **世界书管理** -- 上传/删除世界书
3. **场景注入** -- 加载预设场景世界书词条（赛博朋克/中世纪奇幻/现代都市/末日废土）
4. **预设管理** -- 上传预设 JSON 到 ST
5. **会话-角色绑定** -- 将群聊绑定到 ST 角色卡，实现多群聊聊天记录隔离

## 多群聊隔离原理

```
QQ群A (/bind 苏晚)     ──┐
                         ├── ST扩展轮询绑定表
QQ群B (/bind 另一角色)  ──┘
                         │
                    检查 platform:chatId 绑定
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
        切换到"苏晚"           切换到"另一角色"
        注入消息到苏晚的        注入消息到另一角色的
        聊天记录                聊天记录
```

每个群聊绑定独立的 ST 角色卡，消息自动路由到对应角色的聊天记录，互不干扰。

## 安装

### 1. 安装网关插件

将 `st-data-manager/` 目录放入网关的 `plugins/` 文件夹：

```
plugins/
└── st-data-manager/
    ├── plugin.json
    ├── index.js
    └── README.md
```

重启网关或调用 `POST /api/plugins/st-data-manager/reload`。

### 2. 更新 ST 扩展

本插件需要配合修改后的 ST 扩展（根目录 `index.js`）使用。修改后的扩展会在轮询时拉取绑定表并自动切换角色。

如果你的 ST 扩展是旧版，需要更新到包含角色路由逻辑的版本。

## 配置

在网关面板或通过 API 配置：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `stUrl` | string | `http://localhost:8000` | SillyTavern 后端地址 |
| `stAuth` | string | `""` | ST Basic Auth 凭证 (base64(user:pass))，无认证则留空 |
| `stDataDir` | string | `""` | ST 的 data 目录路径（预设上传用，留空则仅用 API） |
| `bindings` | object | `{}` | 会话-角色绑定表（由 /bind 命令自动维护） |

### 如何获取 ST Basic Auth 凭证

1. 在 ST 的 `config.yaml` 中设置 `basicAuth: true`
2. 设置 `username` 和 `password`
3. 计算 base64：`echo -n "user:password" | base64`
4. 将结果填入 `stAuth` 配置项

如果 ST 未启用 Basic Auth（默认本地访问），`stAuth` 留空即可。

## 命令

### 角色卡管理

| 命令 | 别名 | 说明 |
|------|------|------|
| `/char_list` | `/角色列表` | 列出所有 ST 角色卡 |
| `/char_upload <json>` | `/上传角色` | 导入角色卡 JSON（V3 卡自动含世界书） |
| `/char_delete <角色名>` | `/删除角色` | 删除角色卡及其聊天记录 |

### 世界书管理

| 命令 | 别名 | 说明 |
|------|------|------|
| `/world_upload <名称> <json>` | `/上传世界书` | 导入世界书 |
| `/world_delete <名称>` | `/删除世界书` | 删除世界书 |

### 场景注入

| 命令 | 别名 | 说明 |
|------|------|------|
| `/scene_list` | `/场景列表` | 列出可用场景 |
| `/scene_load <场景名>` | `/加载场景` | 加载预设场景世界书 |
| `/scene_clear` | `/清除场景` | 清除已加载的场景 |

可用场景：赛博朋克、中世纪奇幻、现代都市、末日废土

### 预设管理

| 命令 | 别名 | 说明 |
|------|------|------|
| `/preset_upload <名称> <json>` | `/上传预设` | 上传预设 JSON 到 ST |

### 会话-角色绑定

| 命令 | 别名 | 说明 |
|------|------|------|
| `/bind <角色名>` | `/绑定` | 将当前群聊绑定到 ST 角色 |
| `/unbind` | `/解绑` | 解除当前群聊的绑定 |
| `/bind_list` | `/绑定列表` | 查看所有绑定 |
| `/st_status` | `/ST状态` | 查看 ST 连接状态和当前绑定 |

## 使用流程

### 1. 启动 ST 和网关

确保 SillyTavern 正在运行（默认 `http://localhost:8000`），网关也已启动。

### 2. 导入角色卡

在 QQ/TG 中发送：
```
/char_upload {"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"苏晚","description":"..."}}
```

V3 角色卡如果包含 `character_book` 字段，ST 会自动提取创建世界书。

### 3. 绑定角色

在 QQ 群 A 中发送：
```
/bind 苏晚
```

在 QQ 群 B 中发送：
```
/bind 另一个角色
```

### 4. 开始对话

两个群的消息会分别路由到各自绑定的角色，聊天记录独立。

### 5. 加载场景（可选）

```
/scene_load 赛博朋克
```

这会创建一个名为 `scene_赛博朋克` 的世界书文件，包含赛博朋克设定的词条。请在 ST 中激活该世界书以生效。

## 技术细节

- **无外部依赖**：使用 Node.js 18+ 内置 `fetch` 和 `FormData`
- **绑定表存储**：存储在插件 config (`data/plugins/st-data-manager.json`)，自动持久化
- **ST 扩展轮询**：每 5 秒拉取一次绑定表（节流），角色切换最多 3 秒延迟
- **角色切换**：尝试 3 种方式（slash command / selectCharacterById / window 全局函数），兼容不同 ST 版本
- **V3 角色卡**：导入时 ST 自动提取 `character_book` 创建世界书

## ST API 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/characters/all` | POST | 获取所有角色 |
| `/api/characters/import` | POST | 导入角色卡 |
| `/api/characters/delete` | POST | 删除角色 |
| `/api/worldinfo/import` | POST | 导入世界书 |
| `/api/worldinfo/delete` | POST | 删除世界书 |

## 许可

MIT
