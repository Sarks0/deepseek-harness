/**
 * Grant-key minting and conservative matching. Keys are pure functions of a
 * scope; matching computes a subject's candidate keys and checks the store —
 * it never falls back to a broader kind, tool, or mode.
 *
 * @module @deepseek-ai/dsh-approval-memory/keys
 */

import { createHash } from 'node:crypto'
import { dirname, resolve, sep } from 'node:path'
import type { ApprovalRememberSubject } from '@deepseek-ai/dsh-user-approval/types'
import type { GrantScope } from './types.ts'

/** Separator that cannot appear in any key component's vocabulary. */
const KEY_SEPARATOR = '\0'

/** Directory keys carry a trailing separator so `/a/foo` never covers `/a/foobar`. */
export function directoryPrefix(prefix: string): string {
  return prefix.endsWith(sep) ? prefix : `${prefix}${sep}`
}

/** sha256 over the verbatim command string, hex-encoded. */
export function commandDigest(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex')
}

/**
 * Mint one grant's store key: `kind \0 toolName \0 mode \0 payload`.
 * @param scope - the scope the key identifies.
 * @returns the deterministic store key.
 */
export function grantKeyOf(scope: GrantScope): string {
  const payload = scope.kind === 'command'
    ? scope.digest
    : scope.kind === 'fs-prefix'
      ? scope.prefix
      : ''
  return [scope.kind, scope.toolName, scope.mode, payload].join(KEY_SEPARATOR)
}

/**
 * The path-safe store key for one grant: the base64url encoding of its
 * logical {@link grantKeyOf} key (the json backend's per-record keys must
 * match `[a-zA-Z0-9_-]+`; the base64url alphabet is exactly that).
 * @param scope - the scope the key identifies.
 * @returns the deterministic store key.
 */
export function storeKeyOf(scope: GrantScope): string {
  return Buffer.from(grantKeyOf(scope), 'utf8').toString('base64url')
}

/**
 * The grant scopes one remember-able subject can authorize for a tool, in
 * narrowest-first order. A command subject yields its verbatim digest; a
 * paths subject yields the exact file and (when distinct) the parent
 * directory beneath it; a subject with neither yields none — an ask without
 * ingredients is not remember-able.
 * @param subject - the ask's remember subject.
 * @param toolName - the asking tool's name.
 * @returns candidate scopes, narrowest first.
 */
export function candidateScopes(subject: ApprovalRememberSubject, toolName: string): GrantScope[] {
  if (subject.command !== undefined) {
    return [{
      kind: 'command',
      toolName,
      mode: subject.to,
      digest: commandDigest(subject.command),
    }]
  }
  if (subject.paths === undefined || subject.paths.length === 0) return []
  const scopes: GrantScope[] = []
  for (const path of subject.paths) {
    // A trailing separator marks a directory: it yields itself once, not a
    // file scope plus a bogus parent candidate (dirname() strips it, so the
    // comparison anchors on the normalized path).
    const normalized = resolve(path)
    const absolute = path.endsWith(sep) ? directoryPrefix(normalized) : normalized
    scopes.push({ kind: 'fs-prefix', toolName, mode: subject.to, prefix: absolute })
    // A directory input yields exactly itself; a file input also offers its
    // parent directory as the next-wider candidate.
    if (!path.endsWith(sep)) {
      scopes.push({ kind: 'fs-prefix', toolName, mode: subject.to, prefix: directoryPrefix(dirname(normalized)) })
    }
  }
  return scopes
}

/**
 * Whether one stored fs-prefix grant covers a candidate absolute path,
 * segment-aware: `/a/foo` never covers `/a/foobar`.
 * @param prefix - the grant's resolved prefix.
 * @param path - the candidate absolute path.
 * @returns whether the path lies at or beneath the prefix.
 */
export function prefixCovers(prefix: string, path: string): boolean {
  const base = directoryPrefix(prefix)
  return path === prefix || path.startsWith(base)
}
