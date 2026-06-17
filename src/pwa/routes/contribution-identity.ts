/**
 * PR-F3c — minimal GitHub identity-claim API (the first human-facing, Passkey-gated claim closed loop).
 *
 * Two endpoints wire together the already-audited engines; this layer adds NO new trust — it only
 * orchestrates and shapes responses:
 *
 *   POST /api/contribution-identity/github/claim-challenge
 *     logged-in user → issueGithubIdentityClaimChallenge (F3b) → returns { challenge_id, expires_at,
 *     proof_marker }. The user posts the proof_marker into a PUBLIC GitHub Gist they own.
 *
 *   POST /api/contribution-identity/github/claim-complete
 *     ① requireHumanPresence('identity_claim', …) — one-time WebAuthn gate token bound (via purpose_data)
 *        to this exact { github_actor_id, source_event_key, challenge_id }; agent replay can't pass it.
 *     ② getIssuedChallengeForVerification (F3b read) — confirms the challenge is ISSUED, not expired, and
 *        owned by THIS (account, actor, source) BEFORE any network call, and yields the stored nonce_hash.
 *     ③ verifyGithubGistProof (F3a) — WebAZ RE-FETCHES the gist itself (never trusts caller JSON) and
 *        checks owner.id == actor + marker + sha256(nonce) == nonce_hash.
 *     ④ claimGithubIdentity (F2) — atomically CAS-consumes the challenge + binds, proofVerified:true.
 *
 * Iron-rule boundaries this route MUST honor (scripts/identity-claim-iron-rules-guard.ts):
 *   - It holds NO db handle and runs NO SQL: every read/write to a core table goes through a layer2
 *     engine (rule4). The authoritative single-use challenge consume is the CAS inside F2.
 *   - accountId is ALWAYS the session user — never accepted from the body.
 *   - The GitHub read token comes ONLY from trusted server config (`getGithubReadToken`) — never the body;
 *     if it is not configured, completion FAILS CLOSED (no anonymous, rate-limited identity reads in prod).
 *   - Caller cannot supply expectedNonceHash / proofVerified / nonce — strict input rejects unknown keys.
 *   - Responses never leak the token, nonce, nonce_hash, gist content, or a stack trace.
 *
 * PR-F4 adds a READ-ONLY surface (GET .../github/me) — the caller's own bindings + attributable facts;
 * read-only, no input, scope-anchored on the session account (docs/IDENTITY-CLAIM-DESIGN.md §8.7).
 *
 * spec: docs/IDENTITY-CLAIM-DESIGN.md §8.6.
 */
import type { Application, Request, Response } from 'express'
import { z } from 'zod'
import {
  issueGithubIdentityClaimChallenge,
  getIssuedChallengeForVerification,
} from '../../layer2-business/L2-9-contribution/identity-claim-challenge-engine.js'
import { verifyGithubGistProof } from '../../layer2-business/L2-9-contribution/identity-claim-proof-verifier.js'
import { claimGithubIdentity } from '../../layer2-business/L2-9-contribution/identity-claim-engine.js'
import { getMyGithubIdentitySurface } from '../../layer2-business/L2-9-contribution/identity-claim-read.js'
import { listClaimableGithubIdentityFacts } from '../../layer2-business/L2-9-contribution/identity-claim-discovery.js'
import { withUncommittedValueBoundary } from '../../layer2-business/L2-9-contribution/contribution-display-envelope.js'

export interface ContributionIdentityDeps {
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  // 铁律 human-presence gate (server.ts → createHumanPresence). purpose must be 'identity_claim'.
  requireHumanPresence: (
    userId: string,
    purpose: 'identity_claim',
    token: string | undefined,
    paramKey: string,
    validate?: (data: unknown) => boolean,
  ) => { ok: boolean; reason?: string; error_code?: string; required_when_enabled?: boolean }
  errorRes: (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>) => void
  // Trusted server config ONLY (e.g. process.env.GITHUB_CONTRIB_READ_TOKEN). undefined → completion fails closed.
  getGithubReadToken: () => string | undefined
}

// ── strict request bodies (unknown/sensitive keys → rejected; nothing trusts a caller field) ──
const ChallengeBody = z.strictObject({
  source_event_key: z.string().min(1),
  github_actor_id: z.string().min(1),
})
const CompleteBody = z.strictObject({
  source_event_key: z.string().min(1),
  github_actor_id: z.string().min(1),
  challenge_id: z.string().min(1),
  gist_id: z.string().min(1),
  webauthn_token: z.string().min(1),   // one-time WebAuthn gate token id (purpose 'identity_claim')
})

const PARAM_KEY = 'require_human_presence_for_identity_claim'

export function registerContributionIdentityRoutes(app: Application, deps: ContributionIdentityDeps): void {
  const { auth, requireHumanPresence, errorRes, getGithubReadToken } = deps

  // ── 1) issue a publication challenge ─────────────────────────────────────────────────────────
  app.post('/api/contribution-identity/github/claim-challenge', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const parsed = ChallengeBody.safeParse(req.body ?? {})
    if (!parsed.success) return void errorRes(res, 400, 'INVALID_REQUEST', '请求参数无效')

    // accountId is ALWAYS the session user (never the body).
    const r = await issueGithubIdentityClaimChallenge({
      accountId: user.id as string,
      githubActorId: parsed.data.github_actor_id,
      sourceEventKey: parsed.data.source_event_key,
    })

    if (r.ok && r.status === 'issued') {
      return void res.json({ status: 'issued', challenge_id: r.challenge_id, expires_at: r.expires_at, proof_marker: r.proof_marker })
    }
    if (r.ok && r.status === 'already_bound_self') {
      return void res.json({ status: 'already_bound_self', github_actor_id: r.github_actor_id })
    }
    // refused — map to a status without leaking internals.
    switch (r.reason) {
      case 'invalid_request':       return void errorRes(res, 400, 'INVALID_REQUEST', '请求参数无效')
      case 'fact_not_found':        return void errorRes(res, 404, 'FACT_NOT_CLAIMABLE', '没有可认领的、经凭证背书的 GitHub 贡献记录')
      case 'actor_mismatch':        return void errorRes(res, 403, 'ACTOR_MISMATCH', '该贡献记录的执行者与所声明的 GitHub 身份不符')
      case 'already_bound_other':   return void errorRes(res, 409, 'ALREADY_BOUND', '该 GitHub 身份已被其他账号认领')
      case 'backend_unsupported':   return void errorRes(res, 503, 'BACKEND_UNSUPPORTED', '当前后端暂不支持身份认领')
      case 'db_busy':               return void errorRes(res, 503, 'DB_BUSY', '系统繁忙，请稍后重试')
      default:                      return void errorRes(res, 500, 'INTERNAL', '内部错误')
    }
  })

  // ── 2) complete the claim (human gate → re-fetch gist proof → atomic consume+bind) ────────────
  app.post('/api/contribution-identity/github/claim-complete', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const parsed = CompleteBody.safeParse(req.body ?? {})
    if (!parsed.success) return void errorRes(res, 400, 'INVALID_REQUEST', '请求参数无效')
    const { source_event_key, github_actor_id, challenge_id, gist_id, webauthn_token } = parsed.data
    const userId = user.id as string

    // Server-config precondition FIRST — don't burn the one-time human gate token if the server can't
    // perform the authenticated GitHub read (fail closed; issuing a challenge never needs a token).
    const githubToken = getGithubReadToken()
    if (!githubToken) return void errorRes(res, 503, 'GITHUB_READ_NOT_CONFIGURED', '身份认领暂不可用')

    // ① human presence — the gate token must be bound (purpose_data) to THIS exact claim tuple, so a
    //    token minted for one claim cannot complete another, and an agent cannot replay it.
    const hp = requireHumanPresence(userId, 'identity_claim', webauthn_token, PARAM_KEY, (data) => {
      const d = data as { github_actor_id?: unknown; source_event_key?: unknown; challenge_id?: unknown } | null
      return !!d && d.github_actor_id === github_actor_id && d.source_event_key === source_event_key && d.challenge_id === challenge_id
    })
    if (!hp.ok) return void errorRes(res, 412, hp.error_code || 'HUMAN_PRESENCE_REQUIRED', hp.reason || '此操作需真实人工 WebAuthn 验证')

    // ② confirm the challenge is issued/owned/unexpired and fetch the stored nonce_hash (read-only;
    //    BEFORE the network call so a bad challenge never triggers a GitHub fetch). Not consumed here.
    const look = getIssuedChallengeForVerification({ challengeId: challenge_id, accountId: userId, githubActorId: github_actor_id, sourceEventKey: source_event_key })
    if (!look.ok) {
      switch (look.reason) {
        case 'challenge_not_found':   return void errorRes(res, 404, 'CHALLENGE_NOT_FOUND', '认领挑战不存在或不属于当前账号')
        case 'challenge_expired':     return void errorRes(res, 410, 'CHALLENGE_EXPIRED', '认领挑战已过期，请重新发起')
        case 'challenge_already_used':return void errorRes(res, 409, 'CHALLENGE_ALREADY_USED', '认领挑战已被使用')
        case 'backend_unsupported':   return void errorRes(res, 503, 'BACKEND_UNSUPPORTED', '当前后端暂不支持身份认领')
        default:                      return void errorRes(res, 400, 'INVALID_REQUEST', '请求参数无效')
      }
    }

    // ③ WebAZ re-fetches the gist itself (trusted token from config; NEVER the body) and verifies
    //    owner.id == actor + marker + sha256(nonce) == stored nonce_hash. A failure here does NOT consume
    //    the challenge (F2 is not called) — the user can fix the gist and retry.
    const proof = await verifyGithubGistProof({
      gistId: gist_id,
      githubActorId: github_actor_id,
      challengeId: challenge_id,
      expectedNonceHash: look.nonceHash,
      token: githubToken,
    })
    if (!proof.ok) {
      // Surface only the typed outcome (verifier guarantees its reasons are token-free; we don't echo them).
      const code = proof.outcome === 'rate_limited' ? 429
        : proof.outcome === 'timeout' || proof.outcome === 'upstream_unavailable' ? 502
        : proof.outcome === 'not_found' ? 404
        : proof.outcome === 'invalid_request' ? 400
        : 422
      return void errorRes(res, code, 'PROOF_REJECTED', '未能验证 GitHub 公开发布凭证', { proof_outcome: proof.outcome })
    }

    // ④ atomic consume(CAS) + bind — proofVerified:true; accountId is the session user.
    const claim = await claimGithubIdentity({
      accountId: userId,
      githubActorId: github_actor_id,
      sourceEventKey: source_event_key,
      challengeId: challenge_id,
      proofVerified: true,
    })
    if (claim.ok) {
      return void res.json({ status: claim.status, github_actor_id: claim.github_actor_id, challenge_id: claim.challenge_id })
    }
    switch (claim.reason) {
      case 'already_bound_other':    return void errorRes(res, 409, 'ALREADY_BOUND', '该 GitHub 身份已被其他账号认领')
      case 'challenge_already_used': return void errorRes(res, 409, 'CHALLENGE_ALREADY_USED', '认领挑战已被使用')
      case 'challenge_expired':      return void errorRes(res, 410, 'CHALLENGE_EXPIRED', '认领挑战已过期，请重新发起')
      case 'challenge_not_found':    return void errorRes(res, 404, 'CHALLENGE_NOT_FOUND', '认领挑战不存在或不属于当前账号')
      case 'fact_not_found':         return void errorRes(res, 404, 'FACT_NOT_CLAIMABLE', '没有可认领的、经凭证背书的 GitHub 贡献记录')
      case 'actor_mismatch':         return void errorRes(res, 403, 'ACTOR_MISMATCH', '该贡献记录的执行者与所声明的 GitHub 身份不符')
      case 'backend_unsupported':    return void errorRes(res, 503, 'BACKEND_UNSUPPORTED', '当前后端暂不支持身份认领')
      case 'db_busy':                return void errorRes(res, 503, 'DB_BUSY', '系统繁忙，请稍后重试')
      default:                       return void errorRes(res, 500, 'INTERNAL', '内部错误')   // proof_not_verified / invariant_violation
    }
  })

  // ── 3) READ-ONLY: the caller's OWN bindings + attributable facts (PR-F4) ──────────────────────
  // No query/body input is read — accountId is ALWAYS the session user, so a caller cannot ask about
  // another account or github_actor_id. Returns no other account's id, no token/nonce/nonce_hash.
  // PR-5A: the response is wrapped in the uncommitted-value boundary (RFC-017 I-12 / §7) so this
  // metering/display surface can never read as a payout promise — facts + attribution only.
  app.get('/api/contribution-identity/github/me', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    try {
      const surface = await getMyGithubIdentitySurface(user.id as string)
      res.json(withUncommittedValueBoundary(surface))
    } catch {
      return void errorRes(res, 500, 'INTERNAL', '内部错误')   // never leak a stack / query
    }
  })

  // F10 — claimable-fact discovery (read-only). Same posture as /github/me: auth required, the account
  // context is ALWAYS the session user (the request query/body are never read — an ?account_id= is ignored), the
  // engine issues SELECT only (no challenge, no binding write, no accountable_ref change), the response
  // carries the uncommitted-value boundary, and errors never leak SQL/stack.
  app.get('/api/contribution-identity/github/claimable', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    try {
      const surface = await listClaimableGithubIdentityFacts(user.id as string)
      res.json(withUncommittedValueBoundary(surface))
    } catch {
      return void errorRes(res, 500, 'INTERNAL', '内部错误')   // never leak a stack / query
    }
  })
}
