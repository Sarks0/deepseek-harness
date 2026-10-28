/**
 * Tests for the `.mcp.json` discovery plugin: document parsing, environment
 * expansion, precedence against explicit rows, exclusion, and registration
 * call-through into the MCP client bridge.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

// The discovery plugin mounts the MCP client bridge per discovered server;
// a mock keeps these tests at the discovery contract, not the wire protocol.
/** Per-test behavior of the mocked bridge apply; tests may override to fail a server. */
let applyBehavior: (config: { serverName: string }) => void = () => {}

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({
  name: 'mcp-client',
  inject: [],
  Config: { '~standard': { validate: (value: unknown) => ({ value }) } },
  apply: vi.fn(async (_ctx: unknown, config: { serverName: string }): Promise<void> => {
    applyBehavior(config)
  }),
}))

import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { apply, parseMcpJson } from '../src/index.ts'

const mockApply = vi.mocked(mcpClient.apply)

/** The bridge configs discovery mounted, in mount order. */
function mountedConfigs(): unknown[] {
  return mockApply.mock.calls.map(call => call[1])
}

beforeEach(() => {
  mockApply.mockClear()
  applyBehavior = () => {}
})

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-${name}-`))
  tempDirs.push(dir)
  return dir
}

/** A loader whose entries claim the supplied explicit MCP server names. */
function fakeLoader(explicitNames: string[]): { entries: () => { options: unknown }[] } {
  return {
    entries: () => explicitNames.map(serverName => ({
      options: {
        name: '@deepseek-ai/dsh-mcp-client',
        config: { serverName },
      },
    })),
  }
}

async function setup(config: import('../src/index.ts').Config = {}, explicitNames: string[] = []): Promise<Context> {
  const ctx = new Context()
  ctx.provide('loader', fakeLoader(explicitNames))
  await apply(ctx, config)
  return ctx
}

describe('parseMcpJson', () => {
  it('parses stdio and http servers with env expansion', () => {
    vi.stubEnv('MCP_TOKEN', 'secret-token')
    vi.stubEnv('LAB_ROOT', '/vr-lab')
    const parsed = parseMcpJson(JSON.stringify({
      mcpServers: {
        lab: {
          command: 'npx',
          args: ['-y', '${LAB_ROOT}/server.js'],
          env: { TOKEN: '$MCP_TOKEN', STATIC: 'plain' },
          cwd: '$LAB_ROOT',
        },
        remote: {
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
        },
      },
    }), process.env)

    expect(parsed.unknownFields).toEqual([])
    expect(parsed.servers).toEqual([
      {
        name: 'lab',
        stdio: {
          command: 'npx',
          args: ['-y', '/vr-lab/server.js'],
          env: { TOKEN: 'secret-token', STATIC: 'plain' },
          cwd: '/vr-lab',
        },
      },
      {
        name: 'remote',
        streamableHttp: {
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer secret-token' },
        },
      },
    ])
  })

  it('expands an unset variable to an empty string', () => {
    const parsed = parseMcpJson(JSON.stringify({
      mcpServers: { lab: { command: 'echo', args: ['${UNSET_VAR}', '$ALSO_UNSET'] } },
    }), {})

    expect(parsed.servers[0]?.stdio?.args).toEqual(['', ''])
  })

  it('honors an explicit type and collects unknown per-server fields', () => {
    const parsed = parseMcpJson(JSON.stringify({
      mcpServers: {
        remote: { type: 'http', url: 'https://mcp.example.com', command: 'ignored-unknown' },
      },
    }), {})

    // An explicit http type makes `command` unknown for that server, not fatal.
    expect(parsed.unknownFields).toEqual(['remote.command'])
    expect(parsed.servers[0]?.streamableHttp?.url).toBe('https://mcp.example.com')
  })

  it('returns no servers for a missing mcpServers member', () => {
    expect(parseMcpJson('{"other": true}', {})).toEqual({ servers: [], unknownFields: [] })
  })

  it.each([
    ['malformed json', '{ not json', /^invalid JSON:/],
    ['non-object root', '[1]', /expected a JSON object/],
    ['non-object mcpServers', '{"mcpServers": 3}', /expected "mcpServers" to be an object/],
    ['non-object server', '{"mcpServers": {"a": 1}}', /server "a" must be an object/],
    ['invalid name', '{"mcpServers": {"bad name!": {"command": "x"}}}', /not a valid server name/],
    ['unsupported type', '{"mcpServers": {"a": {"type": "sse", "url": "https://x"}}}', /unsupported type/],
    ['missing url and command', '{"mcpServers": {"a": {}}}', /requires a non-empty string "command"/],
    ['empty url', '{"mcpServers": {"a": {"url": ""}}}', /requires a non-empty string "url"/],
    ['non-string args', '{"mcpServers": {"a": {"command": "x", "args": [1]}}}', /"args" must be an array of strings/],
    ['non-object env', '{"mcpServers": {"a": {"command": "x", "env": 2}}}', /"env" must be an object/],
    ['non-string cwd', '{"mcpServers": {"a": {"command": "x", "cwd": 3}}}', /"cwd" must be a string/],
    ['non-object headers', '{"mcpServers": {"a": {"url": "https://x", "headers": 4}}}', /"headers" must be an object/],
  ])('rejects %s with a clear error', (_label, text, pattern) => {
    expect(() => parseMcpJson(text, {})).toThrow(pattern)
  })
})

describe('mcp-json-discovery apply', () => {
  it('is a clean no-op when the document is absent', async () => {
    const dir = await tempDir('mcp-json-absent')
    await setup({ path: join(dir, '.mcp.json') })
    expect(mountedConfigs()).toEqual([])
  })

  it('is a clean no-op for an empty mcpServers object', async () => {
    const dir = await tempDir('mcp-json-empty')
    await writeFile(join(dir, '.mcp.json'), '{"mcpServers": {}}')
    await setup({ path: join(dir, '.mcp.json') })
    expect(mountedConfigs()).toEqual([])
  })

  it('reads nothing when disabled', async () => {
    const dir = await tempDir('mcp-json-disabled')
    const path = join(dir, '.mcp.json')
    await writeFile(path, '{"mcpServers": {"a": {"command": "x"}}}')
    await setup({ enabled: false, path })
    expect(mountedConfigs()).toEqual([])
  })

  it('resolves the default document path against the package-manager caller directory recorded in INIT_CWD', async () => {
    // `pnpm --dir <repo> dsh` chdirs into the repo; the caller's directory
    // survives only as INIT_CWD, and the default `.mcp.json` belongs there.
    const dir = await tempDir('mcp-json-init-cwd')
    await writeFile(join(dir, '.mcp.json'), '{"mcpServers": {"a": {"command": "x"}}}')
    vi.stubEnv('INIT_CWD', dir)
    await setup()
    expect(mountedConfigs()).toEqual([expect.objectContaining({ serverName: 'a' })])
  })

  it('resolves a relative document path against the launch directory', async () => {
    const dir = await tempDir('mcp-json-relative')
    await writeFile(join(dir, 'project.mcp.json'), '{"mcpServers": {"a": {"command": "x"}}}')
    vi.stubEnv('INIT_CWD', dir)
    await setup({ path: 'project.mcp.json' })
    expect(mountedConfigs()).toEqual([expect.objectContaining({ serverName: 'a' })])
  })

  it('mounts discovered stdio and http servers through the bridge', async () => {
    vi.stubEnv('MCP_TOKEN', 'secret-token')
    const dir = await tempDir('mcp-json-mount')
    await writeFile(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        lab: { command: 'npx', args: ['-y', 'server'], env: { TOKEN: '$MCP_TOKEN' } },
        remote: { url: 'https://mcp.example.com', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } },
      },
    }))
    await setup({ path: join(dir, '.mcp.json') })
    expect(mountedConfigs()).toEqual([
      {
        serverName: 'lab',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'server'],
        env: { TOKEN: 'secret-token' },
        cwd: '',
        toolCallTimeoutMs: 60_000,
        failOnStartupError: false,
      },
      {
        serverName: 'remote',
        transport: 'streamable-http',
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer secret-token' },
        toolCallTimeoutMs: 60_000,
        failOnStartupError: false,
      },
    ])
  })

  it('skips servers an explicit mcp-client row already configures', async () => {
    const dir = await tempDir('mcp-json-precedence')
    await writeFile(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        explicit: { command: 'from-file' },
        discovered: { command: 'from-file' },
      },
    }))
    await setup({ path: join(dir, '.mcp.json') }, ['explicit'])

    expect(mountedConfigs()).toEqual([
      expect.objectContaining({ serverName: 'discovered', command: 'from-file' }),
    ])
  })

  it('excludes servers matching excludeServers patterns', async () => {
    const dir = await tempDir('mcp-json-exclude')
    await writeFile(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'vr-lab': { command: 'a' },
        editor: { command: 'b' },
      },
    }))
    await setup({ path: join(dir, '.mcp.json'), excludeServers: ['vr-*'] })

    expect(mountedConfigs()).toEqual([expect.objectContaining({ serverName: 'editor' })])
  })

  it('contains a per-server registration failure and mounts the rest', async () => {
    const dir = await tempDir('mcp-json-failure')
    await writeFile(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        bad: { command: 'a' },
        good: { command: 'b' },
      },
    }))
    applyBehavior = (config) => {
      if (config.serverName === 'bad') throw new Error('connection refused')
    }
    const ctx = new Context()
    ctx.provide('loader', fakeLoader([]))

    await expect(apply(ctx, { path: join(dir, '.mcp.json') })).resolves.toBeUndefined()
    expect(mountedConfigs()).toEqual([
      expect.objectContaining({ serverName: 'bad' }),
      expect.objectContaining({ serverName: 'good' }),
    ])
  })

  it('fails loudly for a malformed document', async () => {
    const dir = await tempDir('mcp-json-malformed')
    await writeFile(join(dir, '.mcp.json'), '{ not json')
    const path = join(dir, '.mcp.json')

    await expect(setup({ path })).rejects.toThrow(/invalid JSON/)
  })
})
