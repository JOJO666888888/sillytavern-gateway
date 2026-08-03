# Phase 3 多 Agent 协作规范

> 版本：1.0（本期范围：协议设计 + CollabBus 基础框架 + 子代理任务分配增强）
> 关联代码：`engine/collab-bus.js`、`tools/collab-tools.js`、`agent-runner.js`（`_triggerSubAgents` 增强）、`subagent-dispatcher.js`（`parentResult`/`runId`）

---

## 1. 目标与本期范围

让多个 Agent（主 Agent + 子代理）在**一次 run 内**高效协同完成复杂 RP 任务：

- 主 Agent 产出初稿 → 子代理（批评家/编辑/角色）按分工并行或链式处理 → 结果汇入 run 结果。
- Agent 之间通过**进程内协作总线（CollabBus）**交换消息，`collab.*` 工具供 LLM 使用。

**本期交付**：
1. 协作协议（消息结构 / 路由 / 生命周期 / 超时重试）。
2. CollabBus 基础框架（publish/subscribe/request/recv/close）。
3. `collab.*` 工具集（send / request / state_sync / recv）。
4. 任务分配算法增强（`split_by_section` 落地，`sequential_feedback` 基础版，`consensus` 设计就绪）。
5. 冲突解决策略设计（本期实现"优先级覆盖合并"基础规则，完整实现在队列）。

**不在本期**：仲裁 Agent（Mediator）、投票共识、版本合并器、跨进程通信、ST 兼容前端桥（见 §6 队列）。

---

## 2. 协作协议

### 2.1 消息结构

所有协作消息均为一个对象：

```ts
interface CollabMessage {
    from: string;            // 发送方 Agent 名称（必填）
    to: string;              // 接收方 Agent 名称；'' 表示广播（必填字段，缺省 ''）
    type: 'request' | 'response' | 'broadcast' | 'state_sync';  // 必填
    topic: string;           // 消息主题（路由键，必填）
    payload: any;            // 消息内容（建议 object）
    runId: string;           // 所属 run（无 runId 的消息不进邮箱，仅同步分发）
    seq: number;             // 总线递增序号（publish 时生成）
    ts: number;              // 发布时间戳（publish 时生成）
}
```

**校验规则**（`CollabBus._validate`）：`from`/`topic` 必填且为字符串；`type` 必须在四枚举内；`to` 缺省视为广播。校验失败返回 `{ error }`，不抛异常。

### 2.2 路由规则

- 按 **topic 订阅**：`subscribe(topic, handler)` 的订阅者收到该 topic 的**所有**消息（broadcast/request/state_sync/response 均按 topic 路由）。
- **邮箱模式**（Agent 工具侧）：`publish` 时若消息带 `runId`，同时写入 `mailbox[runId][topic]`；Agent 通过 `collab.recv(topic)` 拉取并消费（读取即移除）。LLM 采用"拉取式"消费，不依赖常驻回调。
- **request-应答**：`collab.request` 广播 `type='request'` 后等待同 topic 的 `type='response'` 消息（按 `from`/`runId` 约束）。

### 2.3 生命周期

- 消息在 **run 内有效**：邮箱与挂起请求均以 `runId` 为键。
- `AgentRunner.run` 的 `finally` 调用 `collabBus.close(runId)`：清空该 runId 邮箱，并将挂起的 request resolve 为 `{ error: 'run_closed' }`。
- 跨 run 不共享（无残留泄漏）。

### 2.4 超时与重试约定

| 场景 | 行为 |
|---|---|
| `collab.request` 无应答 | 默认 30s 超时，返回 `{ error: 'timeout', topic, timeoutMs }`；可经参数 `timeoutMs` 调整 |
| run 结束仍有挂起 request | `close(runId)` 立即 resolve `{ error: 'run_closed' }` |
| 重试 | 由调用方（LLM）决策：收到 timeout/run_closed 后可重新 `collab.send`/`collab.request`；总线不做自动重发 |

### 2.5 典型时序

```
主 Agent                        子代理 (critic)              总线
   |-- collab.send(topic=draft_review) ------------------------> 写入邮箱(critic 可 recv)
   |-- collab.request(topic=consensus) ----- request ----------> 订阅者收到
   |        <--------------------------- response (critic) ---- resolve
   |-- collab.recv(topic=feedback)  <--- 邮箱拉取 -------------- 消费即清空
run 结束 → collabBus.close(runId) → 清邮箱 + 挂起请求
```

---

## 3. 任务分配算法

子代理定义新增可选字段 `task`：

```yaml
subAgents:
  - name: critic
    trigger: after_draft
    parallel: true
    task:
      divide: split_by_section        # split_by_section | sequential_feedback | consensus
      sections:
        - "审查开篇的节奏与悬念"
        - "审查高潮的冲突张力"
```

### 3.1 `split_by_section`（本期已实现）

**语义**：把主稿文本按段落（`\n\n+`）连续切分为 N 块（N = `sections.length`，缺省 1），每块交给一次独立的子代理调度，并行执行（`Promise.allSettled`）。

**伪代码**：

```
function split_by_section(mainText, sections):
    N = len(sections)
    paras = mainText.split(/\n\n+/).filter(非空)
    chunks = 连续均分(paras, N)          # 每块 ceil(len/N) 段
    results = parallel_for i in [0, N):
        dispatch(sections[i].agent or 默认子代理,
                 task = "审查以下内容片段（sections[i]）:\n" + chunks[i],
                 opts = { parentResult: mainText, runId })
    return results                        # 结构化 { agent, mode, count, results }
```

**产出口径**：返回 `{ agent, mode: 'split_by_section', count, results }`，写入 `AgentRunResult` 的 SUBAGENT 事件。

### 3.2 `sequential_feedback`（本期基础版）

**语义**：子代理按定义顺序链式执行，**前一个子代理的产出作为下一个的 `parentResult`** 注入（"链式传稿"）。适合"初稿 → 批评 → 修订"的流水线。

**伪代码**：

```
function sequential_feedback(subAgents, mainText):
    cur = mainText
    for s in subAgents(顺序):
        out = dispatch(s.name, task=审查 cur, opts={ parentResult: cur, runId })
        if out 成功且含 text: cur = out.text
    return 各步结果
```

### 3.3 `consensus`（设计就绪、实现排期）

**语义**：多个子代理对同一话题各自给出意见，经**冲突解决**（§5）合并为最终结论。

**本期行为**：按 `sequential_feedback` 基础版执行（不报错），并 `logger.warn` 提示"consensus 模式设计就绪、完整实现排期"。

**计划实现**：意见收集（`collab.request` 广播 + 多应答聚合）→ 冲突仲裁（Mediator Agent）→ 投票共识 → 版本合并（见 §6 队列）。

---

## 4. 与现有架构的关系

```
                          ┌──────────────────────────────────────────┐
                          │              AgentRunner                 │
                          │  run(): 主 agent loop（runTools/Stream） │
                          │    ├── toolRegistry 工具循环              │
                          │    └── _triggerSubAgents()               │
                          │           ├── 按 trigger 分组              │
                          │           ├── parallel  → Promise.allSettled
                          │           ├── sequential → 链式传稿        │
                          │           └── split_by_section → N 次 dispatch
                          └───────┬──────────────────┬───────────────┘
                                  │ dispatch(runId,   │ collabBus
                                  │  parentResult)    │ publish/request
                          ┌───────▼───────┐   ┌───────▼────────────────┐
                          │SubagentDispatcher│   │  CollabBus            │
                          │  namespace 隔离   │   │  topic 订阅 / 邮箱     │
                          │  runId 注入工具 ctx│   │  run 级生命周期        │
                          └───────┬───────┘   └───────┬────────────────┘
                                  │ executor context   │ collab.* 工具
                          ┌───────▼───────┐   ┌───────▼────────────────┐
                          │ 子代理 agent loop│   │ toolRegistry           │
                          │ (独立上下文/记忆) │   │ collab.send/request/   │
                          └───────────────┘   │ state_sync/recv         │
                                              └─────────────────────────┘
```

- **namespace 认知隔离**不变：子代理仍通过 `SubagentDispatcher._resolveNamespace` 获得独立 state/memory 存储（`char:*`），协作消息与认知存储解耦。
- `runId` 经 `createExecutor` context 注入每个工具执行（主 Agent 与子代理一致），`collab.*` 工具据此绑定消息归属。

---

## 5. 冲突解决策略

### 5.1 本期：优先级覆盖合并（基础规则）

- 子代理定义可声明 `priority`（数字，缺省 0，越大越优先）。
- **同 topic 的冲突版本**：高 `priority` 子代理的产出覆盖低者（写入 run 结果时按 priority 降序取最高版本）。
- **冲突事件留痕**：每次覆盖在 `AgentRunResult` 追加一条 `collab_conflict` 事件 `{ topic, winner, loser, ts }`，供审计与前端展示。

实现位置：`_triggerSubAgents` 汇结果时对同 topic 结果按 priority 排序取最优，并记录冲突事件（本轮在 SUBAGENT 事件中带 `priority` 信息；完整合并器见队列）。

### 5.2 队列（P4，后续迭代）

| 策略 | 说明 | 状态 |
|---|---|---|
| 仲裁 Agent（Mediator） | 独立 Agent 裁决冲突版本 | 设计就绪 |
| 投票共识 | 多子代理对版本投票，多数通过 | 设计就绪 |
| 版本合并器 | 按块 merge 多版本（diff/三路合并） | 设计就绪 |

---

## 6. 后续产品规划优先级队列

| 优先级 | 事项 |
|---|---|
| P0 | 网关 P0 改进（既有计划） |
| P1 | 嵌入向量引擎启用（任务 2b 延伸：`createRetriever('embedding')` 接真实 embedder） |
| P3 | 冲突仲裁 Agent / 投票共识 / 版本合并器 |
| P4 | Pi/CC 桥接、RP 专用前端、ST 兼容前端桥（Phase 3 完整版） |

---

## 7. 验证清单

- [x] CollabBus 消息校验 / 订阅分发 / request-应答 / 超时 / 邮箱 / close 清理（`test/collab-bus.test.js`）
- [x] collab.* 工具声明与消息绑定（from/runId）
- [x] `_splitBySections` 切块正确性
- [x] split_by_section 并行调度 + parentResult/runId 透传
- [x] consensus 模式基础执行 + warn
- [x] `npm test` 全量通过（无既有用例回归）
