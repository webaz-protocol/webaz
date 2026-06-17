/**
 * PR-F3a — GitHub identity-claim publication-proof verifier (GitHub Gist proof v1). INTERNAL.
 *
 * Trust root (lesson from #308): identity-claim authenticity must come from WebAZ's OWN authenticated
 * re-fetch, never from caller-supplied JSON / owner / digest. This verifier RE-FETCHES the gist via the
 * #295/#301 audited primitives (`pathFromOrigin` + `getJson`, fixed origin https://api.github.com,
 * GET-only, manual-redirect, AbortSignal timeout) and verifies:
 *   - the gist's `owner.id` STRICTLY equals `githubActorId` (the stable id — NEVER login);
 *   - a gist file contains the marker `webaz-identity-claim:v1:<challengeId>:<nonce>`;
 *   - `sha256(nonce)` equals `expectedNonceHash` (the value stored in identity_claim_challenges).
 *
 * Scope: ONLY GitHub Gist proof v1. No API/DB write/claim-commit here. The production entry takes NO
 * fetchImpl/now/caller-owner injection (uses globalThis.fetch; tests swap the global). `token` is a
 * trusted-config dep (optional — public gists need none); it is sent ONLY to api.github.com and NEVER
 * appears in any result/reasons. Truncated content → refused `proof_truncated` (raw_url is NEVER
 * followed). Every failure is a TYPED outcome; the function never throws a predictable error.
 */
import { z } from 'zod'
import { getJson, pathFromOrigin, DEFAULT_TIMEOUT_MS, type FetchOutcome } from './github-credential/github-fetch-adapter.js'
import { sha256hex } from './github-credential/canonical.js'

export const CLAIM_MARKER_PREFIX = 'webaz-identity-claim:v1:'   // full marker: <prefix><challengeId>:<nonce>
const NONCE_RE_BODY = '([A-Za-z0-9_-]+)'

// Strict args — rejects unknown keys (fetchImpl / now / caller-supplied owner all refused as invalid_request).
const ArgsSchema = z.strictObject({
  gistId: z.string().min(1),
  githubActorId: z.string().min(1),
  challengeId: z.string().min(1),
  expectedNonceHash: z.string().regex(/^[0-9a-f]{64}$/),   // sha256 hex
  token: z.string().min(1).optional(),                     // trusted config; public gists need none
  timeoutMs: z.number().int().positive().max(30_000).optional(),
})

// Tolerant view of the GitHub Gist response (extra fields ignored; missing/typed-wrong → malformed_response).
const GistResponse = z.object({
  owner: z.object({ id: z.union([z.number(), z.string()]) }).passthrough().nullable().optional(),
  truncated: z.boolean().optional(),
  files: z.record(z.string(), z.object({ content: z.string().optional(), truncated: z.boolean().optional() }).passthrough()),
}).passthrough()

export type ProofRefusal =
  | FetchOutcome                 // getJson's typed transport outcomes (not_found / rate_limited / timeout / …)
  | 'owner_mismatch'
  | 'proof_not_found'
  | 'nonce_mismatch'
  | 'proof_truncated'

export type ProofResult =
  | { ok: true; github_actor_id: string; challenge_id: string }
  | { ok: false; outcome: ProofRefusal; reasons: string[] }

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export async function verifyGithubGistProof(args: unknown): Promise<ProofResult> {
  const parsed = ArgsSchema.safeParse(args)
  if (!parsed.success) {
    // codes only — never echo a value (no token / nonce / url leak)
    const reasons = parsed.error.issues.map(i =>
      i.code === 'unrecognized_keys'
        ? `unrecognized argument(s): ${(i as { keys?: string[] }).keys?.join(', ')}`
        : `${i.path.join('.') || '(args)'}: ${i.code}`)
    return { ok: false, outcome: 'invalid_request', reasons }
  }
  const a = parsed.data
  const timeoutMs = a.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = globalThis.fetch                          // runtime transport — NOT caller-injectable

  try {
    let url: string
    try { url = pathFromOrigin('gists', a.gistId) }          // fixed origin api.github.com; encodes the id
    catch { return { ok: false, outcome: 'invalid_request', reasons: ['could not build a safe api.github.com gist URL'] } }

    // WebAZ's own authenticated read (getJson rejects any non-https://api.github.com URL — #301 P1).
    const res = await getJson(doFetch, url, a.token, timeoutMs)
    if (res.kind === 'fail') return { ok: false, outcome: res.outcome, reasons: res.reasons }   // getJson reasons are token-free

    const parsedGist = GistResponse.safeParse(res.body)
    if (!parsedGist.success) return { ok: false, outcome: 'malformed_response', reasons: ['gist response missing/typed-wrong fields'] }
    const gist = parsedGist.data

    // owner.id must STRICTLY equal the claimed stable actor id (never login; anonymous gist → no owner).
    if (!gist.owner || String(gist.owner.id) !== a.githubActorId) {
      return { ok: false, outcome: 'owner_mismatch', reasons: ['gist owner.id != githubActorId'] }
    }

    // search every NON-truncated file for the challenge marker; raw_url is NEVER followed.
    const re = new RegExp(escapeRegex(`${CLAIM_MARKER_PREFIX}${a.challengeId}:`) + NONCE_RE_BODY)
    let anyTruncated = gist.truncated === true
    for (const fname of Object.keys(gist.files)) {
      const f = gist.files[fname]
      if (f?.truncated === true) { anyTruncated = true; continue }   // incomplete → don't trust; don't fetch raw_url
      const content = f?.content
      if (typeof content !== 'string') continue
      const m = re.exec(content)
      if (m) {
        if (sha256hex(m[1]) === a.expectedNonceHash) return { ok: true, github_actor_id: a.githubActorId, challenge_id: a.challengeId }
        return { ok: false, outcome: 'nonce_mismatch', reasons: ['sha256(nonce) != expectedNonceHash'] }
      }
    }
    if (anyTruncated) return { ok: false, outcome: 'proof_truncated', reasons: ['gist content truncated; raw_url NOT followed — re-post the marker in a small file'] }
    return { ok: false, outcome: 'proof_not_found', reasons: ['claim marker not found in gist files'] }
  } catch {
    return { ok: false, outcome: 'upstream_unavailable', reasons: ['unexpected verifier error'] }   // never leak the token
  }
}
