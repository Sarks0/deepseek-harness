---
description: "Project .mcp.json discovery for users and maintainers registering a standard mcpServers document through the MCP client bridge without hand-maintained rows."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-json-discovery

English | [中文](README.zh.md)

## Summary

Use `dsh-mcp-json-discovery` to read a project's `.mcp.json` (the shared `mcpServers` document format) and register every server it describes through `@deepseek-ai/dsh-mcp-client`, so tool naming (`mcp__<server>__<tool>`), reconnect, and failure semantics are identical to hand-written rows. A server an explicit `@deepseek-ai/dsh-mcp-client` row already configures is skipped in the discovered file's favor; a missing or empty document is a clean no-op.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin beside the MCP client bridge when a project keeps its MCP servers in `.mcp.json` (the format Claude Code, Codex, and many tools share) and hand-maintaining one cordis.yml row per server is unwanted.

### Mount and configure

```yaml
- name: '@deepseek-ai/dsh-mcp-json-discovery'
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn discovery off without removing the row |
| `path` | `.mcp.json` | Document path; relative paths resolve against the harness launch directory (`INIT_CWD ?? process.cwd()`) |
| `excludeServers` | `[]` | Picomatch patterns (e.g. `vr-*`) naming servers to leave unregistered |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-json-discovery) is the exhaustive source for every accepted field.

### Document format

Each `mcpServers` entry names a server (1–32 of `A-Za-z0-9_-`). A `url` field selects Streamable HTTP (`url`, `headers`); a `command` field selects stdio (`command`, `args`, `env`, `cwd`); an explicit `type: "http"` or `"stdio"` decides when both markers appear. `${VAR}` and `$VAR` references expand against the harness environment in `command`, `args`, `env` values, `url`, and `headers` values; an unset variable expands to an empty string. Unknown per-server fields are ignored and listed once in the startup log.

### Precedence and collisions

Discovery reads the composed plugin entries before mounting anything: a server name an explicit `@deepseek-ai/dsh-mcp-client` loader row configures is skipped with a log line naming the winner, regardless of activation order. Names in `excludeServers` are skipped the same way. A same-name explicit row added after boot for a name discovery already registered still fails loudly through the MCP client bridge's own duplicate-name check.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The registration mechanism is per-server programmatic mounting of the MCP client bridge (`ctx.plugin(dsh-mcp-client, config)`), the same composition style the session controller uses for its sub-plugins; the bridge stays the single owner of connections, tool bridging, and reconnection. Precedence is decided from configuration rather than activation order: the composed loader entry list is complete before any plugin activates, so discovery reads it once, collects explicit `serverName`s from `@deepseek-ai/dsh-mcp-client` rows, and skips those names. Per-server mount failures are caught and logged so one broken server cannot unregister the others; a malformed document fails the discovery plugin itself at load. Parsing, validation, and environment expansion live in [`src/parse.ts`](src/parse.ts) as pure functions; file access, precedence, and mounting live in [`src/index.ts`](src/index.ts).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [MCP client bridge](../mcp-client/README.md) — the plugin each discovered server mounts through, and its naming and failure contract.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-json-discovery) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-mcp-client`, which owns every model-visible surface a discovered server produces.

#### KV Cache effect

None directly; the mounted bridge owns any cache effect from its tool definitions.

## Known Limitations and Deferred Work

- **Discovery runs once at boot** — the document is not watched; editing `.mcp.json` needs a profile reload to take effect.
- **Explicit-row detection matches the exact module name** — a row naming the bridge through a re-export or alias specifier is invisible to precedence.
- **Preset-scoped bridge rows are invisible** — an agent preset's own `dsh-mcp-client` rows register in that agent's scope and cannot conflict with these host-level registrations.
- **A post-boot explicit row for a discovered name fails loudly** — the bridge's duplicate-`serverName` check rejects the later instance; remove the `.mcp.json` entry or reload without discovery to hand that name to an explicit row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: open design questions and undecided directions. Shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Watching `.mcp.json` for live reload (a `domain/changed`-style re-discovery) is an open direction; boot-time discovery is the v1 contract.
- Whether preset-scoped bridge rows should also count as "explicit" through a registry query (rather than loader entries alone) is undecided; the loader read is deterministic and covers every host-level row today.

</details>
