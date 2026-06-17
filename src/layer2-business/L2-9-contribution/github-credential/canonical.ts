/**
 * Canonical serialization + SHA-256 digest for GitHub Contribution Credentials (PR 3A).
 *
 * Reuse note: `canonicalSerialize` below is **byte-identical** to
 * `src/layer0-foundation/L0-2-state-machine/order-chain.ts` canonicalSerialize (the
 * repo's established canonical-JSON idiom). It is inlined here so the credential verifier
 * stays a self-contained pure module (no coupling to the order state machine); the static
 * test asserts equivalence with the src version on samples (no-drift guard).
 *
 * No new dependency — SHA-256 via Node built-in `node:crypto`.
 */
import { createHash } from 'node:crypto'

/** Deterministic canonical JSON: recursively sort object keys; arrays keep order. */
export function canonicalSerialize(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(canonicalSerialize).join(',') + ']'
  if (typeof obj === 'object') {
    const keys = Object.keys(obj as Record<string, unknown>).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalSerialize((obj as Record<string, unknown>)[k])).join(',') + '}'
  }
  return JSON.stringify(obj)
}

export const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex')

/**
 * The `core` object = the immutable, GitHub-authoritative fact. These are the ONLY fields
 * that the `core_digest` (and thus `credential_id`) authenticate. The observation envelope
 * (display names, observed_at, self-reported, evidence summaries) is explicitly NOT part of
 * this digest — it is mutable / non-authoritative and carries its own `observation_digest`.
 */
export const DIGEST_CORE_FIELDS = [
  'credential_type',            // fixed protocol domain — isolates this credential family in the digest
  'credential_version',         // version domain — a future v2 of the SAME GitHub fact gets a DIFFERENT id
  'repository_id',
  'pr_node_id',
  'pr_number',
  'base_ref',
  'head_sha',
  'merge_commit_sha',
  'merged_at',
  'github_actor_id',
  'lifecycle_event',
  'supersedes_credential_id',   // lifecycle parent link is bound into the immutable fact
] as const

/** Canonical SHA-256 over the exact core-field set (key-order independent). */
export function digestCore(source: Record<string, unknown>): string {
  const picked: Record<string, unknown> = {}
  for (const k of DIGEST_CORE_FIELDS) picked[k] = source[k] === undefined ? null : source[k]
  return sha256hex(canonicalSerialize(picked))
}

/** Canonical SHA-256 over an arbitrary (observation) object — key-order independent. */
export function digestObject(obj: Record<string, unknown>): string {
  return sha256hex(canonicalSerialize(obj))
}

/** Deterministic credential id derived from the CORE digest (idempotent for the same fact). */
export function credentialIdFromDigest(coreDigest: string): string {
  return `ghc_${coreDigest.slice(0, 40)}`
}
