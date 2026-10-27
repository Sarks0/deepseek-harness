/**
 * Project `.mcp.json` discovery plugin: reads the shared `mcpServers`
 * document from the workspace root and registers every server it does not
 * find in explicit configuration through the MCP client bridge, so tool
 * surfacing, naming, reconnect, and failure semantics stay identical to
 * hand-written rows.
 *
 * @module @deepseek-ai/dsh-mcp-json-discovery
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import picomatch from 'picomatch'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { parseMcpJson, type DiscoveredServer } from './parse.ts'

export { parseMcpJson } from './parse.ts'
export type { DiscoveredServer, ParsedMcpJson } from './parse.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-json-discovery'

/** Per-call timeout forwarded to every discovered server, the bridge's default. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000
/** The module specifier of the plugin explicit rows name. */
const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Discovery configuration. */
export interface Config {
  /** Whether discovery runs; `false` turns the plugin into a no-op. */
  enabled?: boolean
  /**
   * Path of the discovery document. Relative paths resolve against the
   * harness launch directory (the deployment workspace), the same root the
   * base bundle's sandbox policy uses.
   */
  path?: string
  /** Picomatch patterns naming servers to leave unregistered; empty keeps all. */
  excludeServers?: string[]
}

/** Validate and default the discovery configuration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default('.mcp.json'),
  excludeServers: z.array(z.string()).default([]),
})

/** One loader entry's declared options, the shape precedence reads. */
interface LoaderEntryOptions {
  readonly name?: unknown
  readonly config?: unknown
  readonly disabled?: unknown
}

/**
 * Server names an explicit `@deepseek-ai/dsh-mcp-client` loader row already
 * claims. The composed entry list is complete before any plugin activates, so
 * this read is deterministic regardless of activation order; rows mounted
 * inside an agent preset are scoped to that agent and invisible here.
 * @param ctx - plugin context, used only to reach the loader service.
 * @returns the explicitly configured server names.
 */
function explicitServerNames(ctx: Context): Set<string> {
  const names = new Set<string>()
  const loader = ctx.get('loader')
  if (loader === undefined) return names
  for (const entry of loader.entries()) {
    const options = (entry as { options?: LoaderEntryOptions }).options
    if (options === undefined || options.name !== MCP_CLIENT_MODULE || options.disabled === true) continue
    const serverName = (options.config as { serverName?: unknown } | undefined)?.serverName
    if (typeof serverName === 'string') names.add(serverName)
  }
  return names
}

/** Build the MCP client bridge config one discovered server mounts with. */
function mcpClientConfig(server: DiscoveredServer): mcpClient.Config {
  if (server.stdio !== undefined) {
    return {
      serverName: server.name,
      transport: 'stdio',
      command: server.stdio.command,
      args: [...server.stdio.args ?? []],
      env: { ...server.stdio.env },
      cwd: server.stdio.cwd ?? '',
      toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: false,
    }
  }
  const http = server.streamableHttp
  if (http === undefined) {
    throw new Error(`mcp-json-discovery: server "${server.name}" declares neither a stdio nor an HTTP transport`)
  }
  return {
    serverName: server.name,
    transport: 'streamable-http',
    url: http.url,
    headers: { ...http.headers },
    toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: false,
  }
}

/**
 * Discover `.mcp.json` servers and mount the unclaimed ones. A missing or
 * empty document is a clean no-op; a malformed document fails this plugin at
 * load; per-server mount failures are logged and contained so one bad server
 * cannot unregister the others.
 * @param ctx - plugin context carrying the loader and tool registry services.
 * @param config - validated discovery configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.enabled === false) return
  const documentPath = isAbsolute(config.path ?? '.mcp.json')
    ? (config.path ?? '.mcp.json')
    : resolve(process.cwd(), config.path ?? '.mcp.json')

  let text: string
  try {
    text = await readFile(documentPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error(`mcp-json-discovery: cannot read ${documentPath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const parsed = parseMcpJson(text, process.env)
  if (parsed.unknownFields.length > 0) {
    ctx.logger.info(
      `mcp-json-discovery: ignored unknown fields in ${documentPath}: ${parsed.unknownFields.join(', ')}`,
    )
  }
  if (parsed.servers.length === 0) return

  const excluded = config.excludeServers !== undefined && config.excludeServers.length > 0
    ? picomatch([...config.excludeServers])
    : undefined
  const explicit = explicitServerNames(ctx)
  for (const server of parsed.servers) {
    if (excluded?.(server.name) === true) {
      ctx.logger.info(`mcp-json-discovery: excluded server "${server.name}" by configuration`)
      continue
    }
    if (explicit.has(server.name)) {
      ctx.logger.info(
        `mcp-json-discovery: explicit ${MCP_CLIENT_MODULE} row configures server "${server.name}"; the .mcp.json entry is skipped`,
      )
      continue
    }
    try {
      await ctx.plugin(mcpClient, mcpClientConfig(server))
    } catch (error) {
      ctx.logger.error(
        `mcp-json-discovery: registering server "${server.name}" from ${documentPath} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
