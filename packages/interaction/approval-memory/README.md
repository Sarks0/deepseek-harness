---
description: "Remembered approval grants for users and maintainers composing the opt-in memory answerer, recording Always-allow decisions, or revoking stored grants."
kind: "package-reference"
---

# @deepseek-ai/dsh-approval-memory

English | [中文](README.zh.md)

## Summary

Use `dsh-approval-memory` to remember explicit "Always allow" decisions so an identical ask never prompts again. A prepend answerer over the `approval/request` waterfall checks a durable grant store before any human answerer: a match answers `allowed-once` (the standard audit pair still lands), a miss delegates unchanged, and the plugin's own failures delegate too, so a broken store behaves exactly like "not composed". Recording happens only through the `remember` Remote — the Web UI's "Always allow" button — which validates the still-pending ask, computes a conservative scope, and refuses scopes beneath `denyPrefixes` (the harness home by default).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin wherever the approval seam and the storage-domain form are composed. The shipped base row is disabled unless the environment opts in: set `DSH_APPROVAL_MEMORY=on` (or enable the row in your profile patch or a `--patch` overlay).

```yaml
- name: '@deepseek-ai/dsh-approval-memory'
```

| Field | Default | Meaning |
|---|---|---|
| `rememberFsScope` | `file` | `file` records the exact denied path; `parent-dir` the whole parent directory and everything beneath it |
| `denyPrefixes` | `[$DSH_HOME]` | Absolute path prefixes beneath which no grant may be recorded (self-modification guard) |

### What gets remembered

A shell escalation (`bash`/`pwsh` `sandbox_permissions` retry) remembers a sha256 digest of the **verbatim command** — the scope that makes a repeated `xfreerdp3 /v:…` invocation prompt exactly once. A filesystem escalation (`write`/`edit`) remembers the resolved target path (exact file by default; the parent directory under `rememberFsScope: 'parent-dir'`), segment-aware so `/a/foo` never covers `/a/foobar`. An ordinary `allowed-once` answer records nothing.

### Revocation

`/approvals` lists every grant with its scope, creation, and last use; `/approvals revoke <keyPrefix>` removes matching grants; `/approvals clear` empties the store. The records also live as readable JSON under `$DSH_HOME/storages/approval_grants/` — delete or edit a file; the store re-emits live.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The store is the `approval_grants` storage domain (version 1, per-record layout, invalid records backed up and skipped) over the already-mounted json backend, so writes are durable before they resolve and the root stays `0o700`. Keys are `kind \0 toolName \0 mode \0 payload` (payload: the verbatim-command digest or the resolved prefix), base64url-encoded to the backend's path-safe key alphabet. The answerer stashes `{subject, toolName, justification, createdBy}` under the pending ask's `callId` on a miss; `remember` validates that live stash, computes the scope through the same pure `rememberChoices` the client labels from, and writes durably before resolving. The `never` policy is decided by the approval service before any listener runs, so delegated subagents (pinned `never`) can never consume grants.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Approval subsystem](../../../docs/subsystems/approval.md) — the waterfall, outcome vocabulary, and audit pair the answerer rides.
- [Sandbox escalation](../../../packages/sandbox/sandbox/README.md) — the strictly-wider choreography whose asks carry remember subjects.
- [Lab sessions](../../../docs/user/guide/lab-sessions.md) — when to prefer the unattended preset instead.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the approval seam: a remembered ask resolves as an ordinary `allowed-once` outcome whose `approval/asked`/`approval/decided` audit pair is unchanged.

#### KV Cache effect

None; grants alter which approval requests reach a human, never any model-visible request content.

## Known Limitations and Deferred Work

- **No remember for non-escalation asks** — `tools/pre-execute` asks carry no subject and stay one-shot.
- **PTC and plugin-manager escalations stay one-shot** — their callers pass no remember ingredients.
- **`tool-escalation` is hand-written only** — the broad kind exists in the vocabulary but no UI offers it; it authorizes any escalation of one tool to one mode and is unsafe by design.
- **No expiry** — grants live until revoked; `/approvals clear` is the escape hatch.
- **No MCP-tool grants** — MCP tools do not escalate through the sandbox seam.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Whether the Web Settings surface should list grants through the same `list`/`revoke` remotes is an open follow-up.
- A TTL field is reserved (record schema versioning via `storeVersion`) but no UI or sweep exists.

</details>
