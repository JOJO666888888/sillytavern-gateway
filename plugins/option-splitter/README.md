# 选项拆分发送 (Option Splitter)

SillyTavern Gateway 插件：将 AI 回复中的选项从正文中拆出，先发送正文（含幕后信息），再逐条补发每个选项，形成类似 Galgame 的交互体验。

## 功能

- 从 AI 回复中提取 `<options>` 块或散落的 `>选项X：` 行
- 正文（含幕后信息块）作为第一条消息正常发送
- 选项逐条补发，可配置发送间隔
- 支持自定义提取正则、可配置标签名
- 支持 `sequential`（逐条补发）和 `batch`（合并发送）两种策略
- **图片等待时序协作**：当出站链上存在 message-to-image 插件（正文会渲染成图片）时，
  选项补发会等待**所有图片发送完成**后才开始，避免"选项先于正文图片"的乱序；
  图片插件未发信号时按 `mediaWaitTimeout` 兜底超时后照常补发
- 配置 UI 自动生成（需网关 v2+ 支持 schema 驱动 UI）

## 安装

在网关面板的「插件管理」中，通过「从 GitHub 安装插件」输入：

```
JOJO666888888/sillytavern-gateway-option-splitter
```

## 配置

安装后，在插件列表中点击「配置」按钮即可打开配置面板。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true | 是否启用拆分 |
| `extractPattern` | string | "" | 自定义提取正则（留空=自动检测 >选项X： 格式） |
| `optionsTag` | string | "options" | 选项块标签名 |
| `stripPrefix` | boolean | true | 发送选项时去掉前缀行 |
| `outputFormat` | enum | "sequential" | 发送策略：sequential/batch |
| `initialDelay` | number | 500 | 正文后首选项延迟（ms） |
| `optionDelay` | number | 800 | 选项间发送间隔（ms） |
| `mediaWaitTimeout` | number | 20000 | 等待图片发送完成的超时（ms）；超时后不再空等，直接补发选项 |
| `optionPrefix` | string | "" | 补发选项时添加的前缀 |
| `applyToPlatforms` | array | [] | 生效平台（空=全部） |

## 提示词要求

AI 回复需用 `<options>` 标签包裹选项：

```
正文内容...

<options>
>选项一：选项内容1
>选项二：选项内容2
>选项三：选项内容3
>选项四：选项内容4
</options>

幕后信息（内心戏、地点等）属于正文，不得放入 <options>
```

## 与 message-to-image 的时序协作

当过滤链上同时存在 message-to-image 插件时，正文会被渲染成图片异步补发（通常需要数秒），
而选项默认在几百毫秒后就补发——会出现"选项先出现、正文图片后到"的乱序。

本插件通过**跨插件软契约**解决（不硬依赖对方插件）：

1. option-splitter 在正文消息的 metadata 上写入等待键 `_mediaWaitKey`
2. message-to-image 在**所有图片发送完成**（或确定不渲染 / 渲染失败）后，
   通过网关事件总线发出 `media-sent` 信号（携带等待键）
3. option-splitter 收到匹配的信号后才开始逐条补发选项；超过 `mediaWaitTimeout`
   仍未收到信号时兜底直接补发，不会空等卡死

过滤链中不存在 message-to-image 时，本插件完全跳过等待逻辑，行为与旧版一致。

## 命令

| 命令 | 说明 |
|------|------|
| `/option list` | 查看当前配置 |
| `/option on` / `/option off` | 开启/关闭拆分 |
| `/option test` | 用示例文本测试解析效果 |
| `/option help` | 帮助 |

## 依赖

- SillyTavern Gateway v2+（需要 `bypassFilters` + `skipDedup` + schema 驱动 UI 支持）
