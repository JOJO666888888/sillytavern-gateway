# 自建推理管线（Native Runtime）— 摆脱浏览器，自由切换一切

> 这是「第二 SillyTavern 生态」的核心：**网关自己组装 prompt 并调用 LLM**，
> 不再需要挂着浏览器里的 SillyTavern 前端。ST 退位为「资产编辑器」（你仍用它做角色卡、
> 世界书、预设），网关成为「运行时」。
>
> 它同时解决了两个根本痛点：
> 1. **必须挂浏览器** → 网关独立推理，关掉 ST 页面照样聊。
> 2. **无法自由切换存档/角色卡/世界书/预设** → 每个会话拥有独立 Profile，各切各的，互不干扰。

---

## 一、为什么这样设计

SillyTavern 的 prompt 组装与 LLM 调用全在**浏览器前端 JS** 里，且全局只有**一个**"当前激活会话"。
因此旧方案（ST 前端扩展轮询注入）有两个硬伤：页面必须常开；任何"切换"都是全局副作用，
多个 IM 会话想各绑一个角色就会互相打架、聊天记录互相污染。

自建管线把**会话状态的所有权从 ST 搬到网关**：

```
IM 消息 → 网关 → 取本会话 Profile → 加载角色卡/世界书/预设/存档
        → 组装 prompt → 直连 LLM API → 回复 → 写入 .jsonl 存档 → 发回 IM
```

全程无浏览器参与。每个会话一份 Profile，天然隔离。

---

## 二、启用

编辑 `config/gateway.json` 的 `runtime` 段：

```json
{
  "runtime": {
    "enabled": true,
    "llm": {
      "provider": "openai",
      "baseUrl": "",
      "apiKey": "sk-...",
      "model": "gpt-4o-mini"
    }
  }
}
```

- `provider`：`openai`（含所有 OpenAI 兼容后端：DeepSeek、vLLM、Ollama 的 `/v1` 等）、`claude`、`gemini`
- `baseUrl`：留空用官方默认；本地后端填如 `http://127.0.0.1:11434/v1`
- 启用后，入站消息**不再**走 ST 前端通道，由网关直接生成回复。关闭则回退旧行为。

---

## 三、放置资产

把你在 SillyTavern 里做好的资产直接拷进来（格式完全兼容）：

```
assets/characters/   角色卡  (.png 内嵌 V2/V3，或 .json)
assets/worldbooks/   世界书  (.json)
assets/presets/      预设    (.json)
data/chats/          聊天存档 (.jsonl，与 ST 双向互通)
```

- **角色卡**：支持 PNG 内嵌（`tEXt`/`zTXt` 块中的 `chara`(V2) / `ccv3`(V3)，base64 JSON），也支持纯 JSON 与 V1 扁平格式。角色卡内嵌的 `character_book` 会自动作为世界书生效。
- **聊天存档**：就是 ST 的 `.jsonl`（首行元数据 + 每行一条消息）。**你可以把网关产生的存档直接丢回 ST 继续聊，反之亦然。**

---

## 四、会话级切换命令（⭐ 自由切换的兑现）

在 IM 里直接发命令，**只影响发出命令的那个会话**：

| 命令 | 作用 |
|------|------|
| `/char` | 列出可用角色卡 |
| `/char <名字>` | 本会话切换角色卡（并显示开场白） |
| `/preset` / `/preset <名字>` | 查看 / 切换预设 |
| `/world` | 查看本会话启用的世界书 |
| `/world add <名字>` / `/world remove <名字>` | 启用 / 停用世界书 |
| `/load` / `/load <存档名>` | 查看 / **切换聊天存档** |
| `/new [存档名]` | 新建存档（相当于开新聊天） |
| `/profile` | 查看本会话完整绑定 |

> 群 A 用「月见」+ 存档 a1，群 B 用「另一个角色」+ 存档 b1，私聊用第三套——**同时进行，互不干扰**。
> 这在 ST 前端模型下做不到。

---

## 五、REST API

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/runtime/status` | 运行状态与资产列表 |
| GET | `/api/runtime/profiles` | 所有会话 Profile |
| POST | `/api/runtime/profiles/:platform/:chatId` | 更新某会话绑定 |
| POST | `/api/runtime/preview` | 预览 prompt 组装结果（不调 LLM，调试用） |

`preview` 尤其有用——能看到最终发给模型的完整 messages 与采样参数。

---

## 六、当前能力与边界（骨架版）

**已实现**
- 角色卡 V1/V2/V3（PNG tEXt/zTXt + JSON）解析与 `{{char}}`/`{{user}}` 占位符替换
- 世界书：constant 常驻、关键词触发、selective 辅助关键词、按 order 排序、before/after 分桶、基础递归激活
- 预设：采样参数 + 段落顺序；prompt 组装为 OpenAI 风格 messages
- 聊天存档：`.jsonl` 读写，与 ST 互通，增量追加 + 原子重写
- LLM：OpenAI 兼容 / Claude / Gemini 三类 provider 的请求构造与响应解析
- 每会话 Profile 持久化（`data/profiles.json`）

**尚未实现（后续项）**
- 流式输出（当前为一次性返回；IM 端多数场景可接受）
- token 级历史截断（当前按条数 `historyLimit`）
- 多模态（把入站图片/语音送进模型）——媒体抽象层已就绪，接上即可
- ST 预设 `prompt_order` 的完整还原（当前用内置顺序 + 可选 `gateway_order`）
- 群聊多用户在同一上下文里的身份区分策略

**注意**：`runtime.enabled=true` 后，入站消息由网关直接处理，ST 前端扩展的自动回复通道不再介入。
两者是二选一的关系，不会重复回复。
