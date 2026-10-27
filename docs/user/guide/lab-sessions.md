# Lab sessions

English | [中文](lab-sessions.zh.md)

The `lab` permission preset is for isolated research machines: it turns off the file sandbox and approval prompts in one explicit selection. This page explains what it changes, what guardrails remain, and the safer composition to prefer whenever the machine is not disposable.

## What lab enables

`lab` bundles the two existing permission knobs at their widest settings:

- **Sandbox**: `danger-full-access` — commands and file tools read and write anywhere the launching user can.
- **Approval**: `never` — no operation asks for consent; anything the policy would have asked about runs.

It adds no new capability: the same combination was already reachable through the `danger-full-access` preset or `DSH_PERMISSION_MODE=danger-full-access`. `lab` exists so the picker and the session log say plainly that this session runs unattended and unsafe.

## Select it

Selection is always an explicit act — no shipped default uses `lab`:

- In a session: `/permission lab`.
- From the Web UI: the Permissions selector shows every configured preset with its name and description; pick **lab — unattended (unsafe)**.
- As a deployment default: set `defaultPreset: lab` on the `permission` row in your own profile patch or overlay.

## What still holds

- **Every attempted escalation is still audit-logged.** Even under `approval: never`, a would-be approval still appends the `approval/asked` / `approval/decided` pair to the session log with outcome `rejected` before the policy short-circuits, so the event log keeps a forensic record of everything that would have required consent.
- **Selection is durable and visible.** Switching presets writes a `permission/preset` session event; `/permission` with no argument reports the current preset.
- **Everything else is unchanged** — session format, tool schemas, telemetry.

## The safer composition

For a machine that is not disposable, prefer keeping the sandbox and remembering specific grants instead:

1. Keep `workspace-write` + `ask` (the default).
2. Enable remembered approval grants with `DSH_APPROVAL_MEMORY=on`, and answer **Always allow** only for the exact command or file a task needs repeated.

The sandbox then still confines everything except the scopes you explicitly remembered.

## Leave lab

Run `/permission workspace-write` (or pick another preset in the Web UI) in each open session. New sessions follow the deployment default again.
