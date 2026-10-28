# 实验室会话

[English](lab-sessions.md) | 中文

`lab` 权限预设面向隔离的研究机器：一次显式选择即可同时关闭文件沙箱与审批提示。本页说明它改变了什么、保留了哪些护栏，以及在机器并非一次性环境时应优先选择的更安全组合。

## lab 启用了什么

`lab` 把两个既有权限旋钮固定在最宽设置：

- **沙箱**：`danger-full-access` —— 命令与文件工具可以在启动用户的任何可读写位置操作。
- **审批**：`never` —— 任何操作都不再请求同意；策略本会询问的一切直接运行。

它没有新增任何能力：同样的组合此前已经可以通过 `danger-full-access` 预设或 `DSH_PERMISSION_MODE=danger-full-access` 达到。`lab` 的意义在于让选择器与会话日志直白地表明这个会话是在无人值守、不安全的状态下运行。

## 选择它

选择永远是一次显式动作 —— 没有任何内置默认使用 `lab`：

- 在会话中：`/permission lab`。
- 在 Web UI 中：权限选择器会连同名称与描述列出全部已配置预设；选择 **lab — unattended (unsafe)**。
- 作为部署默认：在你自己的 profile patch 或 overlay 中为 `permission` 行设置 `defaultPreset: lab`。

## 仍然成立的护栏

- **每一次尝试的提权仍会写入审计日志。** 即使在 `approval: never` 下，本会触发审批的操作仍会在策略短路前向会话日志追加 `approval/asked` / `approval/decided` 事件对（结果为 `rejected`），事件日志因此保留了一份“哪些操作本需要同意”的取证记录。
- **选择是持久且可见的。** 切换预设会写入 `permission/preset` 会话事件；不带参数的 `/permission` 会报告当前预设。
- **其余一切不变** —— 会话格式、工具 schema、遥测。

## 更安全的组合

对于并非一次性的机器，优先保留沙箱并改为记忆特定授权：

1. 保持 `workspace-write` + `ask`（默认值）。
2. 以 `DSH_APPROVAL_MEMORY=on` 启用[被记住的审批授权](../../subsystems/approval.zh.md#remembered-grants)，并且只对任务需要重复执行的精确命令或文件回答 **Always allow**。

沙箱随后仍约束一切，只有你显式记住的范围例外。

## 离开 lab

在每个打开的会话中运行 `/permission workspace-write`（或在 Web UI 中选择其他预设）。新会话重新遵循部署默认。
