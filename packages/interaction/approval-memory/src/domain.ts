/**
 * The `approval_grants` storage domain: one version-stamped document per
 * grant under the json backend root at `<root>/approval_grants/grants/<key>.json`.
 *
 * @module @deepseek-ai/dsh-approval-memory/domain
 */

import { z } from 'zod'
import { SANDBOX_MODES } from '@deepseek-ai/dsh-sandbox-policy'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { GrantRecord } from './types.ts'

const scopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fs-prefix'),
    toolName: z.string(),
    mode: z.enum(SANDBOX_MODES),
    prefix: z.string(),
  }),
  z.object({
    kind: z.literal('command'),
    toolName: z.string(),
    mode: z.enum(SANDBOX_MODES),
    digest: z.string().length(64),
  }),
  z.object({
    kind: z.literal('tool-escalation'),
    toolName: z.string(),
    mode: z.enum(SANDBOX_MODES),
  }),
])

const recordSchema = z.object({
  key: z.string(),
  scope: scopeSchema,
  toolName: z.string(),
  justification: z.string(),
  createdAt: z.number(),
  createdBy: z.string(),
  lastUsedAt: z.number(),
}).refine(record => record.key.startsWith(`${record.scope.kind}\0${record.scope.toolName}\0${record.scope.mode}\0`), {
  message: 'record key must be derived from its scope',
})

/** The grant table's zod-inferred record shape (identical to {@link GrantRecord}). */
export type StoredGrantRecord = z.infer<typeof recordSchema>

/**
 * The domain declaration. `per-record` layout gives each grant its own
 * document — natural for list/revoke/edit — and `backup-and-skip` makes an
 * invalid or future-shape record a skipped record, not a broken store.
 */
export const approvalGrantsDomain = defineDomain({
  name: 'approval_grants',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    grants: domainTable<string, StoredGrantRecord>(recordSchema),
  },
})

export type { GrantRecord }
