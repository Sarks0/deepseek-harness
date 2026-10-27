/**
 * Wire-safe approval-memory vocabulary, free of cordis/service imports so
 * browser type chains can consume them without loading this package's
 * Context augmentation.
 * @module @deepseek-ai/dsh-approval-memory/types
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
export type { ApprovalRememberSubject } from '@deepseek-ai/dsh-user-approval/types'

/**
 * The closed grant-scope vocabulary. A grant authorizes exactly one scope;
 * matching is conservative and never falls back to a broader kind.
 */
export type GrantScope =
  | {
    kind: 'fs-prefix'
    toolName: string
    mode: SandboxMode
    /** Absolute, symlink-resolved prefix; directory keys carry a trailing separator. */
    prefix: string
  }
  | {
    kind: 'command'
    toolName: string
    mode: SandboxMode
    /** sha256 over the VERBATIM command string. */
    digest: string
  }
  | {
    /** Reserved broad form; not offered by the UI in v1. Hand-written only. */
    kind: 'tool-escalation'
    toolName: string
    mode: SandboxMode
  }

/** One remembered grant as the store persists and the remotes project it. */
export interface GrantRecord {
  /** The grant's store key; `kind \0 toolName \0 mode \0 payload`. */
  key: string
  /** What the grant authorizes. */
  scope: GrantScope
  /** The asking tool, denormalized for store queries and the revocation table. */
  toolName: string
  /** The asker's first recorded justification, for the revocation surface. */
  justification: string
  /** Epoch milliseconds of the human decision that created the grant. */
  createdAt: number
  /** Session id of the session whose ask was remembered. */
  createdBy: string
  /** Epoch milliseconds of the last memory-served match; `createdAt` until first use. */
  lastUsedAt: number
}

/** Configuration for the remember-scope choices a subject offers. */
export interface RememberChoicesConfig {
  /** `file` records the exact denied path; `parent-dir` the whole parent directory. */
  readonly rememberFsScope: 'file' | 'parent-dir'
}

/** One remember option a client may present for a pending ask. */
export interface RememberChoice {
  /** Stable choice identity passed back to `remember`. */
  readonly id: string
  /** The scope recording this choice creates. */
  readonly scope: GrantScope
  /** Render hint: the narrow subject the grant covers. */
  readonly detail: { readonly kind: 'command' | 'file' | 'dir'; readonly value: string }
}
