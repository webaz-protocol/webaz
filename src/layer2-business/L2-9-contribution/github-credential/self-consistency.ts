/**
 * Self-consistency check for GitHub Contribution Credentials (PR 3A).
 *
 * ⚠️ THIS IS NOT TAMPER-PROOF / ANTI-FORGERY. A plain SHA-256 recomputation only proves the
 * credential is **internally self-consistent** — that its stored `core_digest`, `credential_id`,
 * and `observation_digest` match its own content. An attacker who controls the whole payload can
 * edit `core` and simply RE-COMPUTE the digests/id, and this check will pass. It detects accidental
 * corruption / wrong-id wiring, NOT malicious tampering.
 *
 * Real anti-tamper / authenticity is NOT possible from a self-describing payload. It requires an
 * external root of trust (PR 3B): re-fetch + re-derive the credential via an AUTHENTICATED GitHub
 * API, OR verify a trusted-service SIGNATURE / anchored record. PR 3B MUST do that IN ADDITION to
 * schema validation and this self-consistency check — never accept caller-supplied digests as proof.
 *
 * Pure function; returns a typed result (never throws).
 */
import { digestCore, digestObject, credentialIdFromDigest } from './canonical.js'
import type { GithubContributionCredential } from './github-credential.schema.js'

export type SelfConsistencyResult = { ok: true } | { ok: false; reasons: string[] }

export function verifyCredentialSelfConsistency(credential: GithubContributionCredential): SelfConsistencyResult {
  const reasons: string[] = []
  try {
    const expectedCoreDigest = digestCore(credential.core as unknown as Record<string, unknown>)
    if (credential.core_digest !== expectedCoreDigest) {
      reasons.push(`core_digest mismatch: stored ${credential.core_digest} != recomputed ${expectedCoreDigest}`)
    }
    const expectedId = credentialIdFromDigest(expectedCoreDigest)
    if (credential.credential_id !== expectedId) {
      reasons.push(`credential_id mismatch: stored ${credential.credential_id} != derived ${expectedId}`)
    }
    const expectedObsDigest = digestObject(credential.observation as unknown as Record<string, unknown>)
    if (credential.observation_digest !== expectedObsDigest) {
      reasons.push(`observation_digest mismatch: stored ${credential.observation_digest} != recomputed ${expectedObsDigest}`)
    }
  } catch (err) {
    reasons.push(`self-consistency check failed to evaluate: ${(err as Error).message}`)
  }
  return reasons.length ? { ok: false, reasons } : { ok: true }
}
