/**
 * Parsing for the project `.mcp.json` discovery source: the shared
 * `mcpServers` document format, environment expansion, and per-server field
 * validation. Pure functions only; the plugin entry in `index.ts` owns file
 * access, precedence, and mounting.
 *
 * @module @deepseek-ai/dsh-mcp-json-discovery/parse
 */

/** Valid `serverName`, matching the MCP client bridge's namespace budget. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** `${VAR}` and `$VAR` references, the forms shell-style expansion accepts. */
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g

/** Fields `mcpServers.<name>` accepts for a stdio (spawned) server. */
const STDIO_FIELDS: Readonly<Record<string, true>> = {
  command: true, args: true, env: true, cwd: true, type: true,
}

/** Fields `mcpServers.<name>` accepts for a Streamable HTTP server. */
const HTTP_FIELDS: Readonly<Record<string, true>> = {
  url: true, headers: true, type: true,
}

/** One discovered server, in the MCP client bridge's own config vocabulary. */
export interface DiscoveredServer {
  /** Namespace for the server's `mcp__<name>__<tool>` tools; unique per scope. */
  readonly name: string
  /** A stdio server: executable, arguments, extra environment, working directory. */
  readonly stdio?: {
    readonly command: string
    readonly args?: readonly string[]
    readonly env?: Readonly<Record<string, string>>
    readonly cwd?: string
  }
  /** A Streamable HTTP server: endpoint URL and extra request headers. */
  readonly streamableHttp?: {
    readonly url: string
    readonly headers?: Readonly<Record<string, string>>
  }
}

/** The outcome of parsing one `.mcp.json` document. */
export interface ParsedMcpJson {
  /** Discovered servers in document order. */
  readonly servers: readonly DiscoveredServer[]
  /**
   * Unknown per-server field paths (`<server>.<field>`), collected rather
   * than rejected so a richer upstream document still loads.
   */
  readonly unknownFields: readonly string[]
}

/** Expand `${VAR}` and `$VAR` references against the supplied lookup. */
export function expandEnvVars(value: string, env: Readonly<Record<string, string | undefined>>): string {
  return value.replaceAll(ENV_REFERENCE, (_match, braced: string | undefined, bare: string | undefined) =>
    env[braced ?? bare ?? ''] ?? '')
}

function expandStringRecord(
  record: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const expanded: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    expanded[key] = typeof value === 'string' ? expandEnvVars(value, env) : String(value)
  }
  return expanded
}

/**
 * Parse one `.mcp.json` document into discovery results.
 *
 * `type: 'stdio' | 'http'` is honored when present; otherwise a `url` field
 * selects Streamable HTTP and a `command` field selects stdio. Environment
 * references in `command`, `args`, `env` values, `url`, and `headers` values
 * expand against `env`; an unset variable expands to an empty string. Unknown
 * per-server fields are collected into {@link ParsedMcpJson.unknownFields}
 * instead of failing the document.
 * @param text - the raw file contents.
 * @param env - the environment variable lookup for expansion.
 * @returns the discovered servers and unknown-field paths.
 * @throws a clear error for malformed JSON, a non-object document, a
 *   non-object `mcpServers`, or a server entry with neither `url` nor
 *   `command`, naming the offending server.
 */
export function parseMcpJson(text: string, env: Readonly<Record<string, string | undefined>>): ParsedMcpJson {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error('expected a JSON object at the document root')
  }
  const serversValue = (document as { mcpServers?: unknown }).mcpServers
  if (serversValue === undefined) return { servers: [], unknownFields: [] }
  if (typeof serversValue !== 'object' || serversValue === null || Array.isArray(serversValue)) {
    throw new Error('expected "mcpServers" to be an object')
  }

  const servers: DiscoveredServer[] = []
  const unknownFields: string[] = []
  for (const [name, entry] of Object.entries(serversValue as Record<string, unknown>)) {
    if (!SERVER_NAME_PATTERN.test(name)) {
      throw new Error(`server "${name}" is not a valid server name (expected 1-32 of A-Z a-z 0-9 _ -)`)
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`server "${name}" must be an object`)
    }
    const record = entry as Record<string, unknown>
    const declaredType = record.type
    if (declaredType !== undefined && declaredType !== 'stdio' && declaredType !== 'http') {
      throw new Error(`server "${name}" declares an unsupported type "${String(declaredType)}"`)
    }
    const wantsHttp = declaredType === 'http' || (declaredType === undefined && record.url !== undefined)
    const allowed = wantsHttp ? HTTP_FIELDS : STDIO_FIELDS
    for (const field of Object.keys(record)) {
      if (allowed[field] !== true) unknownFields.push(`${name}.${field}`)
    }
    if (wantsHttp) {
      const url = record.url
      if (typeof url !== 'string' || url.length === 0) {
        throw new Error(`server "${name}" requires a non-empty string "url"`)
      }
      const headers = record.headers
      if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers))) {
        throw new Error(`server "${name}" field "headers" must be an object`)
      }
      servers.push({
        name,
        streamableHttp: {
          url: expandEnvVars(url, env),
          ...headers !== undefined ? { headers: expandStringRecord(headers as Record<string, unknown>, env) } : {},
        },
      })
      continue
    }
    const command = record.command
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error(`server "${name}" requires a non-empty string "command" (or a "url" for a Streamable HTTP server)`)
    }
    const args = record.args
    if (args !== undefined && (!Array.isArray(args) || args.some(arg => typeof arg !== 'string'))) {
      throw new Error(`server "${name}" field "args" must be an array of strings`)
    }
    const serverEnv = record.env
    if (serverEnv !== undefined && (typeof serverEnv !== 'object' || serverEnv === null || Array.isArray(serverEnv))) {
      throw new Error(`server "${name}" field "env" must be an object`)
    }
    const cwd = record.cwd
    if (cwd !== undefined && typeof cwd !== 'string') {
      throw new Error(`server "${name}" field "cwd" must be a string`)
    }
    servers.push({
      name,
      stdio: {
        command: expandEnvVars(command, env),
        ...args !== undefined ? { args: (args as unknown[]).map(arg => expandEnvVars(arg as string, env)) } : {},
        ...serverEnv !== undefined ? { env: expandStringRecord(serverEnv as Record<string, unknown>, env) } : {},
        ...cwd !== undefined ? { cwd: expandEnvVars(cwd, env) } : {},
      },
    })
  }
  return { servers, unknownFields }
}
