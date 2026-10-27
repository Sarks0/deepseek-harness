---
description: "面向用户与维护者的项目 .mcp.json 发现：通过 MCP 客户端桥注册标准 mcpServers 文档，无需手工维护行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-json-discovery

[English](README.md) | 中文

## 摘要

使用 `dsh-mcp-json-discovery` 读取项目的 `.mcp.json`（共享的 `mcpServers` 文档格式），并通过 `@deepseek-ai/dsh-mcp-client` 注册其中描述的每个服务器，因此工具命名（`mcp__<server>__<tool>`）、重连与失败语义与手写行完全一致。显式 `@deepseek-ai/dsh-mcp-client` 行已配置的服务器会被跳过，以显式配置为准；文档缺失或为空时干净地不做任何事。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

当项目把 MCP 服务器保存在 `.mcp.json`（Claude Code、Codex 等工具共享的格式）且不想为每个服务器手写 cordis.yml 行时，将本插件与 MCP 客户端桥一起挂载。

### 挂载与配置

```yaml
- name: '@deepseek-ai/dsh-mcp-json-discovery'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 不移除行即可关闭发现 |
| `path` | `.mcp.json` | 文档路径；相对路径相对 harness 启动目录解析 |
| `excludeServers` | `[]` | picomatch 模式（如 `vr-*`），命名不注册的服务器 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-json-discovery)是每个接受字段的详尽来源。

### 文档格式

每个 `mcpServers` 条目命名一个服务器（1–32 个 `A-Za-z0-9_-`）。`url` 字段选择 Streamable HTTP（`url`、`headers`）；`command` 字段选择 stdio（`command`、`args`、`env`、`cwd`）；当两个标记同时出现时，显式 `type: "http"` 或 `"stdio"` 决定。`command`、`args`、`env` 值、`url` 与 `headers` 值中的 `${VAR}` 与 `$VAR` 引用按 harness 环境展开；未设置的变量展开为空字符串。未知的逐服务器字段会被忽略，并在启动日志中一次性列出。

### 优先级与冲突

发现会在挂载前读取已组合的插件条目：显式 `@deepseek-ai/dsh-mcp-client` 行已配置的服务器名会被跳过并记录获胜者，与激活顺序无关。`excludeServers` 中的名称同样被跳过。启动之后为发现已注册的名称添加的同名显式行，仍会通过 MCP 客户端桥自身的重名检查响亮失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

注册机制是按服务器程序化挂载 MCP 客户端桥（`ctx.plugin(dsh-mcp-client, config)`），与会话控制器组装子插件的组合方式相同；桥仍是连接、工具桥接与重连的唯一所有者。优先级由配置而非激活顺序决定：已组合的加载器条目列表在任何插件激活之前完成，因此发现只读取一次，从 `@deepseek-ai/dsh-mcp-client` 行收集显式 `serverName` 并跳过这些名称。逐服务器的挂载失败会被捕获并记录，因此一个损坏的服务器不会注销其他服务器；格式错误的文档会使发现插件自身在加载时失败。解析、校验与环境展开位于 [`src/parse.ts`](src/parse.ts) 的纯函数中；文件访问、优先级与挂载位于 [`src/index.ts`](src/index.ts)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [MCP 客户端桥](../mcp-client/README.zh.md) — 每个被发现服务器通过其挂载的插件，及其命名与失败契约。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-json-discovery) — 每个接受字段及其来源声明。

-----

<a id="model-experience"></a>
## 模型体验

间接通过 `@deepseek-ai/dsh-mcp-client`，它拥有被发现服务器产生的每个模型可见表面。

#### KV Cache 影响

无直接影响；被挂载的桥拥有其工具定义带来的任何缓存影响。

## 已知限制与后续工作

- **发现只在启动时运行一次** — 文档不被监视；编辑 `.mcp.json` 需要重载配置才能生效。
- **显式行检测匹配精确模块名** — 通过再导出或别名指定符命名桥的行对优先级不可见。
- **预设作用域的桥行不可见** — 代理预设自身的 `dsh-mcp-client` 行在该代理作用域内注册，不会与这些宿主级注册冲突。
- **启动后为已发现名称添加显式行会响亮失败** — 桥的重复 `serverName` 检查拒绝后到的实例；移除 `.mcp.json` 条目或不带发现地重载，才能把该名称交给显式行。
