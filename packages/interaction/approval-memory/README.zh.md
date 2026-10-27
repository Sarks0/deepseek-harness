---
description: "面向用户与维护者的被记住审批授权：组合可选的记忆回答方、记录 Always allow 决策或撤销已存授权。"
kind: "package-reference"
---

# @deepseek-ai/dsh-approval-memory

[English](README.md) | 中文

## 概述

使用 `dsh-approval-memory` 记住显式的 “Always allow” 决策，使完全相同的询问不再弹出。它是 `approval/request` waterfall 上的前置回答方，先检查持久授权存储再交给任何人类回答方：命中则以 `allowed-once` 应答（审批服务仍会追加标准审计对），未命中则原样委托，且本插件自身的失败也委托，因此损坏的存储表现得与“未组合”完全一致。记录只通过 `remember` Remote 发生 —— 即 Web UI 此前休眠的 “Always allow” 按钮 —— 它会校验仍在等待的询问、计算保守范围，并拒绝位于 `denyPrefixes`（默认为 harness home）之下的范围。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在组合了审批 seam 与 storage-domain 表单之处挂载本插件。内置 base 行在环境未选择时处于禁用状态：设置 `DSH_APPROVAL_MEMORY=on`（或在你的 profile patch 或 `--patch` overlay 中启用该行）。

```yaml
- name: '@deepseek-ai/dsh-approval-memory'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `rememberFsScope` | `file` | `file` 记录被拒绝的确切路径；`parent-dir` 记录整个父目录及其下所有内容 |
| `denyPrefixes` | `[$DSH_HOME]` | 其下不可记录任何授权的绝对路径前缀（自我修改防护） |

### 什么会被记住

shell 提权（`bash`/`pwsh` 的 `sandbox_permissions` 重试）记住**逐字命令**的 sha256 摘要 —— 这正是让重复的 `xfreerdp3 /v:…` 调用只询问一次的范围。文件系统提权（`write`/`edit`）记住解析后的目标路径（默认精确到文件；`rememberFsScope: 'parent-dir'` 时为父目录），并按段感知，`/a/foo` 绝不覆盖 `/a/foobar`。普通的 `allowed-once` 回答不记录任何内容。

### 撤销

`/approvals` 列出每个授权的范围、创建与最近使用；`/approvals revoke <keyPrefix>` 移除匹配的授权；`/approvals clear` 清空存储。这些记录也以可读 JSON 形式存放于 `$DSH_HOME/storages/approval_grants/` —— 删除或编辑文件即可，存储会实时重新发出。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

存储是 `approval_grants` storage domain（版本 1，per-record 布局，无效记录备份后跳过），基于已挂载的 json 后端，因此写入在解析前即已持久，根目录保持 `0o700`。键为 `kind \0 toolName \0 mode \0 payload`（payload 为逐字命令摘要或解析前缀），并 base64url 编码为后端的路径安全键字母表。回答方在未命中时把 `{subject, toolName, justification, createdBy}` 暂存在等待询问的 `callId` 之下；`remember` 校验该实时暂存，通过与客户端标签相同的纯函数 `rememberChoices` 计算范围，并在解析前持久写入。`never` 策略由审批服务在任何监听器运行之前决定，因此被委托的子代理（固定为 `never`）永远无法消费授权。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [审批子系统](../../../docs/subsystems/approval.zh.md) —— 回答方所依托的 waterfall、结果词表与审计对。
- [沙箱提权](../../sandbox/sandbox/README.zh.md) —— 其询问携带记忆主体的严格变宽编排。
- [实验室会话](../../../docs/user/guide/lab-sessions.zh.md) —— 何时应改用无人值守预设。

<a id="model-experience"></a>
## 模型体验

间接通过审批 seam：被记住的询问以普通 `allowed-once` 结果解析，其 `approval/asked`/`approval/decided` 审计对保持不变。

#### KV Cache 影响

无；授权只改变哪些审批请求会到达人类，绝不改变任何模型可见的请求内容。

## 已知限制与后续工作

- **非提权询问不可记忆** —— `tools/pre-execute` 询问不携带主体，保持一次性。
- **PTC 与 plugin-manager 提权保持一次性** —— 其调用方不传递记忆要素。
- **`tool-escalation` 仅限手写** —— 宽范围类型存在于词表中但没有 UI 提供它；它授权一个工具到某个模式的任何提权，设计上即不安全。
- **无过期** —— 授权在被撤销前一直有效；`/approvals clear` 是逃生口。
- **无 MCP 工具授权** —— MCP 工具不经由沙箱 seam 提权。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付行为、限制与既定理由以上文、包代码及所链接的 Agent Note 为准。

- Web Settings 界面是否应通过相同的 `list`/`revoke` remote 列出授权是开放的后续工作。
- 已保留 TTL 字段（通过 `storeVersion` 的记录 schema 版本化），但没有 UI 或清扫机制。

</details>
