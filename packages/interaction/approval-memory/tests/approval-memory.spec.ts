/**
 * Approval-memory behavior: store hit answers `allowed-once` with a
 * `lastUsedAt` touch; a miss stashes and delegates; own failures delegate;
 * `remember` validates the live stash, computes conservative scopes, and
 * refuses deny-prefixed scopes; fs matching is segment-aware; command
 * digests are verbatim; the `never` policy short-circuits before any
 * listener.
 */
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import ApprovalMemoryService from '../src/index.ts'
import { commandDigest, grantKeyOf } from '../src/index.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const dir = await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), 'dsh-approval-memory-')))
  tempDirs.push(dir)
  return dir
}

/** A fake agent with an open turn, mirroring the user-approval spec harness. */
function fakeAgent(ctx: Context): Agent {
  const session = ctx.sessions.create()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'seed' }] }), { surfaceOp: 'append' })
  return { session } as Agent
}

interface Harness {
  ctx: Context
  agent: Agent
  service: ApprovalMemoryService
}

async function harness(config: Record<string, unknown> = {}): Promise<Harness> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const root = await tempRoot()
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(ApprovalMemoryService, config)
  return { ctx, agent: fakeAgent(ctx), service: ctx.approvalMemory }
}

const commandSubject: ApprovalRememberSubjectLike = { kind: 'sandbox-escalation', from: 'workspace-write', to: 'danger-full-access', command: 'xfreerdp3 /v:canary' }
/** Any escalation subject shape the tests build. */
interface ApprovalRememberSubjectLike {
  kind: 'sandbox-escalation'
  from: 'read-only' | 'workspace-write' | 'danger-full-access'
  to: 'read-only' | 'workspace-write' | 'danger-full-access'
  command?: string
  paths?: string[]
}

const fsSubject: ApprovalRememberSubjectLike = { kind: 'sandbox-escalation', from: 'workspace-write', to: 'danger-full-access', paths: ['/lab/notes/report.md'] }

async function ask(ctx: Context, agent: Agent, subject: ApprovalRememberSubjectLike | undefined, callId: string, toolName = 'bash'): Promise<ApprovalOutcome> {
  return await ctx.approval.request({
    agent,
    toolName,
    callId: ToolCallId(callId),
    reason: 'escalate sandbox to danger-full-access: the lab VM needs it',
    ...subject !== undefined ? { subject } : {},
  })
}

describe('ApprovalMemoryService answerer', () => {
  it('answers allowed-once on a matching command grant and touches lastUsedAt', async () => {
    const { ctx, agent, service } = await harness()
    // Seed the store through a real ask answered the way the Web client will
    // be: a later listener remembers, then settles allowed-once.
    const seen = Promise.withResolvers<void>()
    ctx.on('approval/request', async (req) => {
      if (req.callId === undefined) return 'rejected'
      await service.remember(String(req.callId), 'command')
      seen.resolve()
      return 'allowed-once'
    })
    await expect(ask(ctx, agent, commandSubject, 'c-seed')).resolves.toBe('allowed-once')
    await seen.promise
    const grants = await service.list()
    expect(grants[0]?.scope).toEqual({ kind: 'command', toolName: 'bash', mode: 'danger-full-access', digest: commandDigest('xfreerdp3 /v:canary') })

    // A repeat ask hits the store and answers without any listener.
    const consulted = vi.fn()
    ctx.on('approval/request', async () => {
      consulted()
      return 'rejected'
    })
    await expect(ask(ctx, agent, commandSubject, 'c-repeat')).resolves.toBe('allowed-once')
    expect(consulted).not.toHaveBeenCalled()
    const stored = await service.list()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.lastUsedAt).toBeGreaterThanOrEqual(stored[0]!.createdAt)
  })

  it('answers allowed-once on a matching fs grant, segment-aware', async () => {
    const { ctx, agent, service } = await harness()
    ctx.on('approval/request', async (req) => {
      if (req.callId === undefined || String(req.callId) !== 'f-seed') return 'rejected'
      await service.remember(String(req.callId), 'file')
      return 'allowed-once'
    })
    await expect(ask(ctx, agent, fsSubject, 'f-seed')).resolves.toBe('allowed-once')

    await expect(ask(ctx, agent, fsSubject, 'f-repeat')).resolves.toBe('allowed-once')
    // A sibling path sharing the prefix as a string prefix is NOT covered:
    // memory misses and the gate listener answers rejected.
    const sibling = { ...fsSubject, paths: ['/lab/notes/report.md.bak'] }
    await expect(ask(ctx, agent, sibling, 'f-sibling')).resolves.toBe('rejected')
  })

  it('records the parent directory when configured', async () => {
    const { ctx, agent, service } = await harness({ rememberFsScope: 'parent-dir' })
    const rememberChoice = 'parent-dir'
    let prefix: string | undefined
    ctx.on('approval/request', async (req) => {
      if (req.callId === undefined) return 'rejected'
      const grant = await service.remember(String(req.callId), rememberChoice)
      prefix = grant.scope.kind === 'fs-prefix' ? grant.scope.prefix : undefined
      return 'allowed-once'
    })
    await expect(ask(ctx, agent, fsSubject, 'p-seed')).resolves.toBe('allowed-once')
    expect(prefix).toBe('/lab/notes/')
    // The sibling beneath the remembered directory is covered.
    const sibling = { ...fsSubject, paths: ['/lab/notes/other.md'] }
    await expect(ask(ctx, agent, sibling, 'p-sibling')).resolves.toBe('allowed-once')
  })

  it('exposes the pending ask choices and empties them once settled', async () => {
    const { ctx, agent, service } = await harness()
    let stashed = false
    ctx.on('approval/request', async (req, next) => {
      if (!stashed && req.callId !== undefined && service.choices(String(req.callId)).length > 0) {
        stashed = true
        return 'allowed-once'
      }
      return await next()
    })
    expect(service.choices('k-absent')).toEqual([])
    await expect(ask(ctx, agent, commandSubject, 'k-1')).resolves.toBe('allowed-once')
    expect(stashed).toBe(true)
    expect(service.choices('k-1')).toEqual([])
  })

  it('delegates to next() on a miss (no answerer ⇒ unavailable) and clears the stash', async () => {
    const { ctx, agent, service } = await harness()
    await expect(ask(ctx, agent, commandSubject, 'm-1')).resolves.toBe('unavailable')
    // The stash is gone once the ask settled: remember refuses the stale id.
    await expect(service.remember('m-1', 'command')).rejects.toThrow(/no pending remember-able approval/)
  })

  it('stashes a reason-less ask (empty justification) and still records', async () => {
    const { ctx, agent, service } = await harness()
    ctx.on('approval/request', async (req) => {
      if (req.callId === undefined) return 'rejected'
      await service.remember(String(req.callId), 'command')
      return 'allowed-once'
    })
    await expect(ctx.approval.request({
      agent,
      toolName: 'bash',
      callId: ToolCallId('no-reason'),
      subject: { kind: 'sandbox-escalation', from: 'workspace-write', to: 'danger-full-access', command: 'echo hi' },
    })).resolves.toBe('allowed-once')
    expect((await service.list())[0]?.justification).toBe('')
  })

  it('the fs fallback scan is conservative across tool, mode, and kind', async () => {
    const { ctx, agent, service } = await harness()
    ctx.on('approval/request', async (req) => {
      if (req.callId === undefined) return 'rejected'
      if (String(req.callId).endsWith('seed')) {
        await service.remember(String(req.callId), String(req.callId).startsWith('fs') ? 'file' : 'command')
      }
      return 'rejected'
    })
    // A command grant and an fs grant for the write tool coexist.
    await ask(ctx, agent, commandSubject, 'cmd-seed')
    await ask(ctx, agent, fsSubject, 'fs-seed', 'write')
    // Same paths but a different tool: the write grant must not answer for bash.
    await expect(ask(ctx, agent, fsSubject, 'fs-other-tool')).resolves.toBe('rejected')
    // Same tool and paths but a different target mode: still no match.
    const narrower = { ...fsSubject, to: 'workspace-write' as const }
    await expect(ask(ctx, agent, narrower, 'fs-other-mode')).resolves.toBe('rejected')
    // A path not covered by the stored prefix falls through too.
    const elsewhere = { ...fsSubject, paths: ['/other/report.md'] }
    await expect(ask(ctx, agent, elsewhere, 'fs-elsewhere')).resolves.toBe('rejected')
  })

  it('the fallback scan returns a stored prefix that covers a non-candidate path', async () => {
    const { ctx, agent, service } = await harness({ rememberFsScope: 'parent-dir' })
    ctx.on('approval/request', async (req) => {
      if (req.callId === undefined) return 'rejected'
      if (String(req.callId).endsWith('seed')) {
        await service.remember(String(req.callId), 'parent-dir')
      }
      return 'rejected'
    })
    // Remember /lab/ via its own child; then ask for a sibling in a DEEPER
    // directory whose minted candidates (/lab/notes/report.md, /lab/notes/)
    // do not include the stored /lab/ prefix — only the scan matches.
    await ask(ctx, agent, { ...fsSubject, paths: ['/lab/top.md'] }, 'scan-seed', 'write')
    const deeper = { ...fsSubject, paths: ['/lab/notes/report.md'] }
    await expect(ask(ctx, agent, deeper, 'scan-hit', 'write')).resolves.toBe('allowed-once')
  })

  it('does not consult the store when the ask carries no subject', async () => {
    const { ctx, agent } = await harness()
    await expect(ask(ctx, agent, undefined, 'n-1')).resolves.toBe('unavailable')
  })

  it('never runs under the never policy (delegated children stay one-shot)', async () => {
    const { ctx, agent } = await harness()
    setApprovalPolicy(agent.session, 'never')
    const consulted = vi.fn()
    ctx.on('approval/request', async () => {
      consulted()
      return 'allowed-once'
    })
    await expect(ask(ctx, agent, commandSubject, 'v-1')).resolves.toBe('rejected')
    expect(consulted).not.toHaveBeenCalled()
  })

  it('delegates when its own store lookup fails (broken store behaves as not composed)', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ApprovalService)
    // A storage-domain stub whose open rejects: the service's every lookup fails.
    ctx.provide('storageDomain', {
      open: () => Promise.reject(new Error('medium unavailable')),
    })
    await ctx.plugin(ApprovalMemoryService)
    const agent = fakeAgent(ctx)
    await expect(ask(ctx, agent, commandSubject, 'b-1')).resolves.toBe('unavailable')
  })

  it('refuses a command cross-match: digests are verbatim', async () => {
    const { ctx, agent, service } = await harness()
    ctx.on('approval/request', async (req) => {
      if (req.callId === undefined || String(req.callId) !== 'x-seed') return 'rejected'
      await service.remember(String(req.callId), 'command')
      return 'allowed-once'
    })
    await expect(ask(ctx, agent, commandSubject, 'x-seed')).resolves.toBe('allowed-once')
    const nearMiss = { ...commandSubject, command: 'xfreerdp3 /v:canary ' }
    await expect(ask(ctx, agent, nearMiss, 'x-2')).resolves.toBe('rejected')
  })
})

describe('ApprovalMemoryService remember', () => {
  it('refuses an absent or stale callId', async () => {
    const { service } = await harness()
    await expect(service.remember('nope', 'command')).rejects.toThrow(/no pending remember-able approval/)
  })

  it('refuses an unknown choice id', async () => {
    const { ctx, agent, service } = await harness()
    ctx.on('approval/request', async (req) => {
      if (req.callId === undefined) return 'rejected'
      await expect(service.remember(String(req.callId), 'file')).rejects.toThrow(/unknown remember choice/)
      return 'rejected'
    })
    await expect(ask(ctx, agent, commandSubject, 'u-seed')).resolves.toBe('rejected')
  })

  it('refuses a scope beneath denyPrefixes', async () => {
    const { ctx, agent, service } = await harness({ denyPrefixes: ['/lab/'] })
    ctx.on('approval/request', async (req) => {
      if (req.callId === undefined) return 'rejected'
      await expect(service.remember(String(req.callId), 'file')).rejects.toThrow(/refusing to remember/)
      return 'rejected'
    })
    await expect(ask(ctx, agent, fsSubject, 'd-seed')).resolves.toBe('rejected')
    expect(await service.list()).toHaveLength(0)
  })
})

describe('ApprovalMemoryService revocation', () => {
  it('revokes by key prefix and clears everything', async () => {
    const { ctx, agent, service } = await harness()
    ctx.on('approval/request', async (req) => {
      if (req.callId === undefined || String(req.callId) === 'r-3') return 'rejected'
      await service.remember(String(req.callId), 'command')
      return 'allowed-once'
    })
    for (const callId of ['r-1', 'r-2']) {
      await expect(ask(ctx, agent, commandSubject, callId)).resolves.toBe('allowed-once')
    }
    // Both asks share one scope, so the store holds one grant they both touch.
    expect(await service.list()).toHaveLength(1)
    const first = (await service.list())[0]!
    expect(await service.revoke(grantKeyOf(first.scope))).toBe(1)
    expect(await service.list()).toHaveLength(0)
    expect(await service.clear()).toBe(0)
    // After revocation memory misses and the gated listener answers rejected.
    await expect(ask(ctx, agent, commandSubject, 'r-3')).resolves.toBe('rejected')
  })
})

describe('approveEscalation end to end with memory', () => {
  it('a remembered grant resolves the escalation without a human answerer', async () => {
    const { ctx, agent, service } = await harness()
    ctx.on('approval/request', async (req) => {
      if (req.callId === undefined) return 'rejected'
      await service.remember(String(req.callId), 'command')
      return 'allowed-once'
    })
    // Seed the grant through the same choreography approveEscalation drives.
    const { approveEscalation } = await import('@deepseek-ai/dsh-sandbox')
    await expect(approveEscalation(
      { requestedMode: 'danger-full-access', justification: 'lab VM', effectiveMode: 'workspace-write', subject: 'command', rememberSubject: { command: 'xfreerdp3 /v:canary' } },
      { approver: ctx.approval, agent, callId: ToolCallId('e-seed'), toolName: 'bash' },
    )).resolves.toBe('danger-full-access')

    // The repeat resolves from memory with no human answerer composed at all.
    await expect(approveEscalation(
      { requestedMode: 'danger-full-access', justification: 'lab VM again', effectiveMode: 'workspace-write', subject: 'command', rememberSubject: { command: 'xfreerdp3 /v:canary' } },
      { approver: ctx.approval, agent, callId: ToolCallId('e-repeat'), toolName: 'bash' },
    )).resolves.toBe('danger-full-access')
  })
})
