/**
 * Remembered approval grants: an opt-in prepend answerer over the
 * `approval/request` waterfall backed by the `approval-grants` storage
 * domain. A matching grant answers `allowed-once` (the standard audit pair
 * is still appended by the approval service); a miss delegates with
 * `next()`; any internal error delegates too, so a broken store behaves
 * exactly like "not composed". Recording happens only through the
 * `remember` Remote, which validates the live per-`callId` stash the
 * answerer created on its miss, refuses scopes beneath `denyPrefixes`
 * (default the harness home), and writes durably before resolving.
 *
 * @module dsh-approval-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
// Side-effect type import: declaration-merges `ctx.commands` onto Context.
import type {} from '@deepseek-ai/dsh-commands'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ApprovalOutcome, ApprovalRememberSubject } from '@deepseek-ai/dsh-user-approval/types'
import { grantScopeFor, grantScopeLabel, rememberChoices, type RememberChoice, type RememberChoicesConfig } from './choices.ts'
import { approvalGrantsDomain, type StoredGrantRecord } from './domain.ts'
import { candidateScopes, directoryPrefix, grantKeyOf, prefixCovers, storeKeyOf } from './keys.ts'
import type { GrantRecord } from './types.ts'

export { commandDigest, grantKeyOf, storeKeyOf } from './keys.ts'
export { grantScopeFor, grantScopeLabel, rememberChoices } from './choices.ts'
export type { RememberChoice, RememberChoicesConfig } from './choices.ts'
export { approvalGrantsDomain } from './domain.ts'
export type { StoredGrantRecord } from './domain.ts'
export type { GrantRecord, GrantScope } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    approvalMemory: ApprovalMemoryService
  }
}

/** Plugin config. */
export interface Config {
  /** `file` records the exact denied path; `parent-dir` the whole parent directory. */
  rememberFsScope?: 'file' | 'parent-dir'
  /** Absolute path prefixes beneath which no grant may be recorded. */
  denyPrefixes?: string[]
}

export const Config: z<Config> = z.object({
  rememberFsScope: z.union(['file', 'parent-dir'] as const).default('file'),
  denyPrefixes: z.array(z.string()),
})

/** The live miss-stash entry the `remember` Remote validates against. */
interface PendingRemember {
  readonly subject: ApprovalRememberSubject
  readonly toolName: string
  readonly justification: string
  readonly createdBy: string
}

/**
 * The remembered-grant service: prepend answerer, grant-store owner, and the
 * `remember` / `list` / `revoke` Remote surface plus the `/approvals`
 * command. The domain opens asynchronously in the constructor; every store
 * access awaits that open, and the answerer delegates until it resolves.
 */
export class ApprovalMemoryService extends TypertRemoteService {
  static inject = ['approval', 'storageDomain']

  private readonly opening: Promise<KvTable<string, StoredGrantRecord>>
  private readonly pending = new Map<string, PendingRemember>()
  private readonly choicesConfig: RememberChoicesConfig
  private readonly denyPrefixes: readonly string[]

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'approvalMemory')
    this.choicesConfig = { rememberFsScope: config.rememberFsScope ?? 'file' }
    this.denyPrefixes = config.denyPrefixes ?? [directoryPrefix(resolveDshHome())]
    const opened = ctx.storageDomain.open(approvalGrantsDomain)
    ctx.effect(() => () => { void opened.then(domain => { void domain.close() }) }, 'approval-memory: grant store')
    this.opening = opened.then(domain => domain.table('grants'))
    this.registerAnswerer()
    this.registerCommand()
  }

  /** The prepend answerer: a store hit answers; a miss stashes and delegates. */
  private registerAnswerer(): void {
    this.ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
      // Only this plugin's own lookup/stash work is error-contained: a
      // broken store delegates exactly like "not composed". Once `next()`
      // runs, its outcome — value or failure — belongs to the chain.
      let unstash: (() => void) | undefined
      try {
        if (req.subject === undefined || req.callId === undefined) return await next()
        const hit = await this.matchGrant(req.subject, req.toolName)
        if (hit !== undefined) {
          void this.touchLastUsed(hit)
          return 'allowed-once'
        }
        this.pending.set(req.callId, {
          subject: req.subject,
          toolName: req.toolName,
          justification: req.reason ?? '',
          createdBy: req.agent.id,
        })
        const callId = req.callId
        unstash = () => { this.pending.delete(callId) }
      } catch {
        return await next()
      }
      try {
        return await next()
      } finally {
        unstash()
      }
    }, { prepend: true })
  }

  /** The `/approvals` command: table, revoke, clear. */
  private registerCommand(): void {
    this.ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        definitionId: CommandDefinitionId('@deepseek-ai/dsh-approval-memory'),
        name: 'approvals',
        description: 'List, revoke, or clear remembered approval grants',
        input: { hint: '[revoke <keyPrefix> | clear]' },
        handler: async ({ rawInput }: { rawInput: string }) => {
          const args = rawInput.trim().split(/\s+/).filter((part: string) => part !== '')
          if (args[0] === 'clear') {
            const removed = await this.clear()
            return { kind: 'success', text: `cleared ${String(removed)} remembered grant(s)` }
          }
          if (args[0] === 'revoke') {
            if (args[1] === undefined) return { kind: 'error', text: 'usage: /approvals revoke <keyPrefix>' }
            const removed = await this.revoke(args[1])
            return removed === 0
              ? { kind: 'error', text: `no remembered grant starts with "${args[1]}"` }
              : { kind: 'success', text: `revoked ${String(removed)} remembered grant(s)` }
          }
          const grants = await this.list()
          if (grants.length === 0) return { kind: 'success', text: 'no remembered approval grants' }
          const rows = grants.map(grant =>
            `- ${grant.key} — ${grantScopeLabel(grant.scope)} (created ${new Date(grant.createdAt).toISOString()}, last used ${new Date(grant.lastUsedAt).toISOString()})`)
          return { kind: 'success', text: rows.join('\n') }
        },
      })
    })
  }

  /**
   * Find a stored grant matching one remember subject. Command subjects
   * match their minted digest key; fs subjects match minted keys and, in
   * addition, any stored prefix that segment-aware covers a denied path.
   * @param subject - the ask's remember subject.
   * @param toolName - the asking tool's name.
   * @returns the matching record, or undefined on a miss.
   */
  private async matchGrant(subject: ApprovalRememberSubject, toolName: string): Promise<GrantRecord | undefined> {
    const table = await this.opening
    for (const scope of candidateScopes(subject, toolName)) {
      const record = table.get(storeKeyOf(scope))
      if (record !== undefined) return record
    }
    if (subject.paths === undefined || subject.paths.length === 0) return undefined
    for (const [, record] of table.entries()) {
      const scope = record.scope
      if (scope.kind !== 'fs-prefix') continue
      if (scope.toolName !== toolName || scope.mode !== subject.to) continue
      if (subject.paths.some(path => prefixCovers(scope.prefix, path))) return record
    }
    return undefined
  }

  /** Update `lastUsedAt` fire-and-forget; a failed touch never breaks the answer. */
  private touchLastUsed(record: GrantRecord): void {
    void this.opening
      .then(table => table.put(storeKeyOf(record.scope), { ...record, lastUsedAt: Date.now() }))
      /* v8 ignore start -- fire-and-forget by contract: a failed touch must never break the answer. */
      .catch(() => {})
      /* v8 ignore stop */
  }

  /**
   * Record one grant for a still-pending ask. Validates the live stash for
   * the call, computes the scope from the validated choice, refuses scopes
   * beneath the deny prefixes, and writes durably before resolving.
   * @param callId - the tool call of the still-pending ask.
   * @param choiceId - the remember choice the user picked.
   * @returns the recorded grant.
   */
  @Remote('remember')
  async remember(callId: string, choiceId: string): Promise<GrantRecord> {
    const entry = this.pending.get(callId)
    if (entry === undefined) {
      throw new Error(`no pending remember-able approval for call ${callId}`)
    }
    if (!rememberChoices(entry.subject, this.choicesConfig).some(choice => choice.id === choiceId)) {
      throw new Error(`unknown remember choice "${choiceId}"`)
    }
    const scope = grantScopeFor(entry.subject, entry.toolName, choiceId)
    if (scope.kind === 'fs-prefix' && this.denyPrefixes.some(prefix => prefixCovers(prefix, scope.prefix))) {
      throw new Error('refusing to remember a grant beneath a denied prefix (the harness home by default)')
    }
    const now = Date.now()
    const record: GrantRecord = {
      key: grantKeyOf(scope),
      scope,
      toolName: entry.toolName,
      justification: entry.justification,
      createdAt: now,
      createdBy: entry.createdBy,
      lastUsedAt: now,
    }
    const table = await this.opening
    await table.put(storeKeyOf(scope), record)
    return record
  }

  /**
   * The remember choices a still-pending ask offers, so a client can label
   * its "Always allow" button from the same computation `remember` validates.
   * @param callId - the tool call of the pending ask.
   * @returns the presentable choices; empty for an absent or settled ask.
   */
  @Remote('choices')
  choices(callId: string): RememberChoice[] {
    const entry = this.pending.get(callId)
    return entry === undefined ? [] : [...rememberChoices(entry.subject, this.choicesConfig)]
  }

  /**
   * List every remembered grant.
   * @returns all grant records, in key order.
   */
  @Remote('list')
  async list(): Promise<GrantRecord[]> {
    const table = await this.opening
    return [...table.entries()].map(([, record]) => record)
  }

  /**
   * Revoke every grant whose key starts with the prefix.
   * @param keyPrefix - store-key prefix; the full key from `list` is exact.
   * @returns how many grants were removed.
   */
  @Remote('revoke')
  async revoke(keyPrefix: string): Promise<number> {
    const table = await this.opening
    const keys = [...table.entries()]
      .filter(([storeKey, record]) => record.key.startsWith(keyPrefix) || storeKey.startsWith(keyPrefix))
      .map(([storeKey]) => storeKey)
    return keys.length === 0 ? 0 : await table.deleteMany(keys)
  }

  /**
   * Revoke every remembered grant.
   * @returns how many grants were removed.
   */
  async clear(): Promise<number> {
    const table = await this.opening
    const keys = [...table.keys()]
    return keys.length === 0 ? 0 : await table.deleteMany(keys)
  }
}

export default ApprovalMemoryService
