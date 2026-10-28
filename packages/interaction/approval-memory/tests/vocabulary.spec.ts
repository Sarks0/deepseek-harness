/**
 * Unit coverage for the pure vocabulary (keys, choices, domain schema) and
 * the `/approvals` command surface.
 */
import { describe, expect, it } from 'vitest'
import { approvalGrantsDomain } from '../src/domain.ts'
import { candidateScopes, commandDigest, directoryPrefix, grantKeyOf, prefixCovers, storeKeyOf } from '../src/keys.ts'
import { grantScopeFor, grantScopeLabel, rememberChoices } from '../src/choices.ts'

const commandSubject = { kind: 'sandbox-escalation' as const, from: 'workspace-write' as const, to: 'danger-full-access' as const, command: 'echo hi' }
const fsSubject = { kind: 'sandbox-escalation' as const, from: 'workspace-write' as const, to: 'danger-full-access' as const, paths: ['/lab/notes/report.md'] }

describe('keys', () => {
  it('mints verbatim command digests and distinct keys per ingredient', () => {
    const scope = candidateScopes(commandSubject, 'bash')[0]!
    expect(scope).toEqual({ kind: 'command', toolName: 'bash', mode: 'danger-full-access', digest: commandDigest('echo hi') })
    expect(grantKeyOf(scope)).toBe(`command\0bash\0danger-full-access\0${commandDigest('echo hi')}`)
    expect(storeKeyOf(scope)).toMatch(/^[A-Za-z0-9_-]+$/)
    // The reserved broad form mints with an empty payload.
    expect(grantKeyOf({ kind: 'tool-escalation', toolName: 'bash', mode: 'danger-full-access' }))
      .toBe('tool-escalation\0bash\0danger-full-access\0')
  })

  it('mints narrowest-first fs candidates, including the parent directory', () => {
    const scopes = candidateScopes(fsSubject, 'write')
    expect(scopes[0]).toMatchObject({ kind: 'fs-prefix', prefix: '/lab/notes/report.md' })
    expect(scopes[1]).toMatchObject({ kind: 'fs-prefix', prefix: '/lab/notes/' })
    // A directory path yields itself once, not twice.
    const dirOnly = candidateScopes({ ...fsSubject, paths: ['/lab/notes/'] }, 'write')
    expect(dirOnly).toHaveLength(1)
    expect(dirOnly[0]).toMatchObject({ prefix: '/lab/notes/' })
    // A relative path resolves against the process cwd.
    const relative = candidateScopes({ ...fsSubject, paths: ['notes/report.md'] }, 'write')
    expect(relative[0]).toMatchObject({ prefix: `${process.cwd()}/notes/report.md` })
  })

  it('yields no candidates without ingredients', () => {
    expect(candidateScopes({ kind: 'sandbox-escalation', from: 'workspace-write', to: 'danger-full-access' }, 'bash')).toEqual([])
    expect(candidateScopes({ ...fsSubject, paths: [] }, 'write')).toEqual([])
  })

  it('matches prefixes segment-aware', () => {
    expect(prefixCovers('/lab/notes/report.md', '/lab/notes/report.md')).toBe(true)
    expect(prefixCovers('/lab/notes/', '/lab/notes/report.md')).toBe(true)
    expect(prefixCovers('/lab/notes/report.md', '/lab/notes/report.md.bak')).toBe(false)
    expect(prefixCovers('/lab/notes', '/lab/notes2/other.md')).toBe(false)
    expect(directoryPrefix('/lab/notes')).toBe(`/lab/notes${import.meta.dirname.startsWith('/') ? '/' : '\\'}`)
  })
})

describe('rememberChoices', () => {
  it('offers the verbatim command for a shell escalation', () => {
    expect(rememberChoices(commandSubject, { rememberFsScope: 'file' }))
      .toEqual([{ id: 'command', detail: { kind: 'command', value: 'echo hi' } }])
  })

  it('offers the file by default and the parent directory when configured', () => {
    expect(rememberChoices(fsSubject, { rememberFsScope: 'file' }))
      .toEqual([{ id: 'file', detail: { kind: 'file', value: '/lab/notes/report.md' } }])
    expect(rememberChoices(fsSubject, { rememberFsScope: 'parent-dir' }))
      .toEqual([{ id: 'parent-dir', detail: { kind: 'dir', value: '/lab/notes' } }])
  })

  it('grantScopeFor mints each choice and refuses mismatches defensively', () => {
    expect(grantScopeFor(commandSubject, 'bash', 'command'))
      .toEqual({ kind: 'command', toolName: 'bash', mode: 'danger-full-access', digest: commandDigest('echo hi') })
    expect(grantScopeFor(fsSubject, 'write', 'file'))
      .toEqual({ kind: 'fs-prefix', toolName: 'write', mode: 'danger-full-access', prefix: '/lab/notes/report.md' })
    expect(grantScopeFor(fsSubject, 'write', 'parent-dir'))
      .toEqual({ kind: 'fs-prefix', toolName: 'write', mode: 'danger-full-access', prefix: '/lab/notes/' })
    expect(() => grantScopeFor(commandSubject, 'bash', 'file')).toThrow(/for a command escalation/)
    expect(() => grantScopeFor(fsSubject, 'write', 'command')).toThrow(/for a file escalation/)
    expect(() => grantScopeFor({ ...fsSubject, paths: [] }, 'write', 'file')).toThrow(/no remember-able subject/)
  })

  it('labels every grant-scope kind for the /approvals table', () => {
    expect(grantScopeLabel({ kind: 'command', toolName: 'bash', mode: 'danger-full-access', digest: 'd' }))
      .toBe('command bash → danger-full-access')
    expect(grantScopeLabel({ kind: 'fs-prefix', toolName: 'write', mode: 'danger-full-access', prefix: '/lab/' }))
      .toBe('files under /lab/ (write → danger-full-access)')
    expect(grantScopeLabel({ kind: 'tool-escalation', toolName: 'bash', mode: 'danger-full-access' }))
      .toBe('any escalation of bash → danger-full-access')
  })

  it('offers nothing without ingredients, and roots at /', () => {
    expect(rememberChoices({ ...fsSubject, paths: [] }, { rememberFsScope: 'file' })).toEqual([])
    expect(rememberChoices({ ...fsSubject, paths: ['/top.md'] }, { rememberFsScope: 'parent-dir' }))
      .toEqual([{ id: 'parent-dir', detail: { kind: 'dir', value: '/' } }])
    // A trailing-separator path roots the same way through the trim branch.
    expect(rememberChoices({ ...fsSubject, paths: ['/top/'] }, { rememberFsScope: 'parent-dir' }))
      .toEqual([{ id: 'parent-dir', detail: { kind: 'dir', value: '/' } }])
  })
})

describe('grant record schema', () => {
  const grants = approvalGrantsDomain.tables.grants!.valueSchema

  it('accepts each scope kind and rejects a key not derived from the scope', () => {
    const digest = commandDigest('echo hi')
    const record = {
      key: `command\0bash\0danger-full-access\0${digest}`,
      scope: { kind: 'command', toolName: 'bash', mode: 'danger-full-access', digest },
      toolName: 'bash',
      justification: 'lab',
      createdAt: 1,
      createdBy: 'sess',
      lastUsedAt: 1,
    }
    expect(grants.safeParse(record).success).toBe(true)
    expect(grants.safeParse({ ...record, scope: { kind: 'tool-escalation', toolName: 'bash', mode: 'danger-full-access' } }).success).toBe(false)
    expect(grants.safeParse({ ...record, key: 'other\0bash\0x\0y' }).success).toBe(false)
  })

  it('rejects an unknown scope kind, mode, or malformed digest', () => {
    const base = {
      key: 'x',
      toolName: 'bash',
      justification: 'lab',
      createdAt: 1,
      createdBy: 'sess',
      lastUsedAt: 1,
    }
    expect(grants.safeParse({ ...base, scope: { kind: 'glob', toolName: 'bash', mode: 'read-only' } }).success).toBe(false)
    expect(grants.safeParse({ ...base, scope: { kind: 'command', toolName: 'bash', mode: 'nope', digest: 'a'.repeat(64) } }).success).toBe(false)
    expect(grants.safeParse({ ...base, scope: { kind: 'command', toolName: 'bash', mode: 'read-only', digest: 'short' } }).success).toBe(false)
  })
})
