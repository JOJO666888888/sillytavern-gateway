# 选项拆分发送 (Option Splitter)

SillyTavern Gateway 插件：将 AI 回复中的选项从正文中拆出，先发送正文（含幕后信息），再逐条补发每个选项，形成类似 Galgame 的交互体验。

## 功能

- 从 AI 回复中提取 `<options>` 块或散落的 `>选项X：` 行
- 正文（含幕后信息块）作为第一条消息正常发送
- 选项逐条补发，可配置发送间隔
- 支持自定义提取正则、可配置标签名
- 支持 `sequential`（逐条补发）和 `batch`（合并发送）两种策略
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

## 命令

| 命令 | 说明 |
|------|------|
| `/option list` | 查看当前配置 |
| `/option on` / `/option off` | 开启/关闭拆分 |
| `/option test` | 用示例文本测试解析效果 |
| `/option help` | 帮助 |

## 依赖

- SillyTavern Gateway v2+（需要 `bypassFilters` + `skipDedup` + schema 驱动 UI 支持）
