/**
 * Client-namespace projection of the approval-memory domain: a pure
 * re-export of the package's types and choice computation. Client code
 * imports ONLY the client namespace (repo discipline).
 *
 * @module @deepseek-ai/dsh-approval-memory/client
 */

export type * from './types.ts'
export { grantScopeFor, grantScopeLabel, rememberChoices } from './choices.ts'
export type { RememberChoice, RememberChoicesConfig } from './choices.ts'
