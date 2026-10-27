/**
 * Pure remember-scope computation shared by host and client, so the choice a
 * button labels and the scope `remember` records cannot drift. Client-safe:
 * imports types only.
 *
 * @module @deepseek-ai/dsh-approval-memory/choices
 */

import type { ApprovalRememberSubject } from '@deepseek-ai/dsh-user-approval/types'
import type { GrantScope } from './types.ts'
import { commandDigest, directoryPrefix } from './keys.ts'

/** One remember option a client may present for a pending ask. */
export interface RememberChoice {
  /** Stable choice identity passed back to `remember`. */
  readonly id: 'command' | 'file' | 'parent-dir'
  /** Render hint: the narrow subject the grant covers. */
  readonly detail: { readonly kind: 'command' | 'file' | 'dir'; readonly value: string }
}

/** Configuration for the remember-scope choices a subject offers. */
export interface RememberChoicesConfig {
  /** `file` records the exact denied path; `parent-dir` the whole parent directory. */
  readonly rememberFsScope: 'file' | 'parent-dir'
}

/**
 * The remember choices one subject offers. v1 answers exactly one per ask:
 * the verbatim command for a shell escalation, or the exact file (default) /
 * the whole parent directory (opt-in) for a filesystem escalation. The broad
 * `tool-escalation` kind is never offered.
 * @param subject - the pending ask's remember subject.
 * @param config - scope-shape configuration.
 * @returns the presentable choices (zero or one in v1).
 */
export function rememberChoices(
  subject: ApprovalRememberSubject,
  config: RememberChoicesConfig,
): readonly RememberChoice[] {
  if (subject.command !== undefined) {
    return [{ id: 'command', detail: { kind: 'command', value: subject.command } }]
  }
  const path = subject.paths?.[0]
  if (path === undefined) return []
  if (config.rememberFsScope === 'parent-dir') {
    const parent = parentDirectoryOf(path)
    return [{ id: 'parent-dir', detail: { kind: 'dir', value: parent } }]
  }
  return [{ id: 'file', detail: { kind: 'file', value: path } }]
}

/**
 * The parent directory of a slash-separated absolute path.
 * @param path - an absolute path.
 * @returns the path's directory portion.
 */
function parentDirectoryOf(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const slash = trimmed.lastIndexOf('/')
  return slash <= 0 ? '/' : trimmed.slice(0, slash)
}

/**
 * One grant's human-readable scope line for the `/approvals` table.
 * @param scope - the grant's scope.
 * @returns the scope description.
 */
export function grantScopeLabel(scope: GrantScope): string {
  if (scope.kind === 'command') return `command ${scope.toolName} → ${scope.mode}`
  if (scope.kind === 'fs-prefix') return `files under ${scope.prefix} (${scope.toolName} → ${scope.mode})`
  return `any escalation of ${scope.toolName} → ${scope.mode}`
}

/**
 * The grant scope one validated choice records. Defensive refusals stay
 * reachable: a command choice on a path subject (or vice versa) or an
 * unknown id throws rather than minting a broader scope.
 * @param subject - the validated stash entry's remember subject.
 * @param toolName - the asking tool's name.
 * @param choiceId - the user's remember choice.
 * @returns the grant scope to record.
 */
export function grantScopeFor(
  subject: ApprovalRememberSubject,
  toolName: string,
  choiceId: string,
): GrantScope {
  if (subject.command !== undefined) {
    if (choiceId !== 'command') throw new Error(`unknown remember choice "${choiceId}" for a command escalation`)
    return { kind: 'command', toolName, mode: subject.to, digest: commandDigest(subject.command) }
  }
  const path = subject.paths?.[0]
  if (path === undefined) throw new Error('the remembered ask carries no remember-able subject')
  if (choiceId === 'parent-dir') {
    return { kind: 'fs-prefix', toolName, mode: subject.to, prefix: directoryPrefix(parentDirectoryOf(path)) }
  }
  if (choiceId !== 'file') throw new Error(`unknown remember choice "${choiceId}" for a file escalation`)
  return { kind: 'fs-prefix', toolName, mode: subject.to, prefix: path }
}
