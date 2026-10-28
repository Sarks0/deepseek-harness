/**
 * The `/approvals` command surface: table rendering, revoke, clear, and the
 * usage error.
 */
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import ApprovalMemoryService, { commandDigest, storeKeyOf } from '../src/index.ts'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** One registered command definition, captured from the registry stub. */
interface CapturedCommand {
  definition: CommandDefinition
  invoke(rawInput: string): Promise<{ kind: string; text: string }>
}

describe('/approvals command', () => {
  async function setup(): Promise<CapturedCommand[]> {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const root = await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), 'dsh-approvals-')))
    tempDirs.push(root)
    await ctx.plugin(Storage)
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ApprovalService)
    const captured: CapturedCommand[] = []
    ctx.provide('commands', {
      register: (definition: CommandDefinition) => {
        const entry: CapturedCommand = {
          definition,
          async invoke(rawInput) {
            return await definition.handler({ rawInput } as never) as { kind: string; text: string }
          },
        }
        captured.push(entry)
        return () => {}
      },
    } as never)
    await ctx.plugin(ApprovalMemoryService)
    // Seed one command grant through a real pending ask answered by a listener.
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'seed' }] }), { surfaceOp: 'append' })
    const agent = { session } as Agent
    ctx.on('approval/request', async (req) => {
      if (req.callId === undefined) return 'rejected'
      await ctx.approvalMemory.remember(String(req.callId), 'command')
      return 'allowed-once'
    })
    await expect(ctx.approval.request({
      agent,
      toolName: 'bash',
      callId: ToolCallId('seed-1'),
      reason: 'escalate sandbox to danger-full-access: lab VM',
      subject: { kind: 'sandbox-escalation', from: 'workspace-write', to: 'danger-full-access', command: 'xfreerdp3 /v:canary' },
    })).resolves.toBe('allowed-once')
    return captured
  }

  it('registers under the approvals name and lists grants', async () => {
    const captured = await setup()
    expect(captured).toHaveLength(1)
    const command = captured[0]!
    expect(command.definition.name).toBe('approvals')
    const empty = await command.invoke('   ')
    expect(empty.kind).toBe('success')
    expect(empty.text).toContain('command bash → danger-full-access')
    expect(empty.text).toContain('last used')
  })

  it('reports when nothing is remembered', async () => {
    const captured = await setup()
    await ctxApprovalsClear(captured[0]!)
    const result = await captured[0]!.invoke('')
    expect(result.text).toBe('no remembered approval grants')
  })

  it('revokes by key prefix and errors on no match or missing argument', async () => {
    const captured = await setup()
    const revoked = await captured[0]!.invoke('revoke command')
    expect(revoked.kind).toBe('success')
    expect(revoked.text).toContain('revoked 1')
    // Re-seed, then revoke through the store-key (base64url) prefix path.
    const reseeded = await setup()
    const digest = commandDigestOf('xfreerdp3 /v:canary')
    const storePrefix = storeKeyPrefixOf(digest)
    const byStoreKey = await reseeded[0]!.invoke(`revoke ${storePrefix}`)
    expect(byStoreKey.kind).toBe('success')
    expect(byStoreKey.text).toContain('revoked 1')
    const again = await captured[0]!.invoke('revoke command')
    expect(again.kind).toBe('error')
    const usage = await captured[0]!.invoke('revoke')
    expect(usage.kind).toBe('error')
    expect(usage.text).toContain('usage')
  })

  it('clears everything', async () => {
    const captured = await setup()
    const cleared = await captured[0]!.invoke('clear')
    expect(cleared.kind).toBe('success')
    expect(cleared.text).toContain('cleared 1')
    const after = await captured[0]!.invoke('')
    expect(after.text).toBe('no remembered approval grants')
  })
})

/** Clear through the command under test before asserting the empty listing. */
async function ctxApprovalsClear(command: CapturedCommand): Promise<void> {
  await command.invoke('clear')
}

/** Digest of the seeded command, reused to build the store-key prefix. */
function commandDigestOf(command: string): string {
  return commandDigest(command)
}

/** A short store-key prefix unique to the seeded grant. */
function storeKeyPrefixOf(digest: string): string {
  return storeKeyOf({ kind: 'command', toolName: 'bash', mode: 'danger-full-access', digest }).slice(0, 12)
}
