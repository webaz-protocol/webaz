/**
 * RFC-023 PR-3 — token endpoint: exchange a consent-minted auth code for an OPAQUE access token.
 *
 * POST /oauth/token (application/x-www-form-urlencoded per OAuth 2.1; JSON also accepted)
 *   grant_type=authorization_code & code & code_verifier & redirect_uri & client_id [& resource]
 *
 * Security decisions enforced (RFC-023 §4/§6):
 *   T4/I-4  PKCE verify: S256(code_verifier) must equal the challenge stored AT CONSENT; the code is
 *           CAS-consumed BEFORE verification — any failed attempt burns it (a wrong verifier against
 *           a real code is an attack signal, not a retry; client restarts the flow).
 *   T4      code replay (already-consumed) additionally REVOKES every access token of that code's
 *           grant (RFC 6749 §10.5 posture: a replayed code means the code leaked).
 *   T5      redirect_uri must exactly equal the value bound at consent.
 *   T2/I-3  aud is stamped from the code row's resource (== https://webaz.xyz/mcp); a caller-supplied
 *           resource, if present, must match it (RFC 8707).
 *   D1      token is OPAQUE (random 256-bit, prefix oat_), stored HASHED; revocation is online.
 *   PR-1    refresh tokens (OAuth 2.1 §4.3): issued alongside the access token (prefix ort_, stored
 *           HASHED). ROTATING + single-use — a used/expired/revoked refresh token never mints again,
 *           and REUSE of a rotated/revoked one is treated as theft: the whole rotation family AND every
 *           access token of that grant are revoked (RFC 6819 §5.2.2.3). I-5 still holds — a refresh
 *           token is clamped to (and can never outlive) the underlying grant the human approved, and the
 *           /mcp edge NEVER accepts ort_ (only oat_/gtk_), so refresh grants no capability.
 *   D4      public clients — client identity is the allowlist id + possession of code+verifier.
 *
 * Fail-closed mount (WEBAZ_OAUTH=1, sandbox refuses), per-IP rate limit (best-effort behind CF).
 */
import express from 'express'
import type { Express, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { oauthClients } from './oauth-authorize.js'

export const OAUTH_TOKEN_TTL_SECONDS = 3600                 // access token TTL (clamped to grant)
export const OAUTH_REFRESH_TTL_SECONDS = 90 * 24 * 3600     // refresh TTL ceiling; ALWAYS clamped to grant (I-5)
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/   // RFC 7636 §4.1 unreserved charset
const REFRESH_RE = /^ort_[0-9a-f]{64}$/            // opaque refresh token shape (prefix + 256-bit hex)

export interface OAuthTokenDeps {
  db: Database.Database   // sync handle — token/refresh mint is one better-sqlite3 transaction (no torn state)
  rateLimitOk: (key: string, max?: number, windowMs?: number) => boolean
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
function sha256hex(s: string): string { return createHash('sha256').update(s).digest('hex') }

interface TokenPair { access: string; accessExpMs: number; refresh: string; refreshExpMs: number }

/**
 * Generate a fresh opaque access + refresh token PAIR (raw values only — NO DB write). Kept pure so the
 * refresh path can compute the successor's hash BEFORE the atomic claim (see below). Both expiries are
 * clamped to the grant's — a credential never outlives the grant the human approved (I-5).
 */
function genPair(grantExpiresMs: number): TokenPair {
  const now = Date.now()
  return {
    access: `oat_${randomBytes(32).toString('hex')}`,
    accessExpMs: Math.min(now + OAUTH_TOKEN_TTL_SECONDS * 1000, grantExpiresMs),
    refresh: `ort_${randomBytes(32).toString('hex')}`,
    refreshExpMs: Math.min(now + OAUTH_REFRESH_TTL_SECONDS * 1000, grantExpiresMs),
  }
}

/** Persist a generated pair, both hashed at rest. SYNCHRONOUS — must run inside a db.transaction(). */
function insertPair(db: Database.Database, p: TokenPair & {
  grantId: string; clientId: string; scope: string; aud: string; familyId: string
}): void {
  db.prepare('INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?)')
    .run(sha256hex(p.access), p.grantId, p.clientId, p.scope, p.aud, new Date(p.accessExpMs).toISOString())
  db.prepare('INSERT INTO oauth_refresh_tokens (token_hash, grant_id, client_id, family_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(sha256hex(p.refresh), p.grantId, p.clientId, p.familyId, p.scope, p.aud, new Date(p.refreshExpMs).toISOString())
}

// 客户端 IP 真相源(同 mcp-remote.ts):CF 后 req.ip 塌缩成边缘 IP → 优先取 CF-Connecting-IP(CF 重写,
// 经 CF 不可伪造;校验 IP 形态防任意字符串桶键)。★残余(已知并接受,同 mcp-remote):直连 origin 可伪造
// 该头规避限流 —— 仅 DoS 规避,非鉴权风险(code 256-bit+60s TTL+单次焚毁才是主控);彻底闭合=cf-origin-guard enforce。
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/
function clientIp(req: Request): string {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim()
  if (cf && IP_RE.test(cf)) return cf
  return req.ip || 'unknown'
}

export function registerOAuthTokenRoutes(app: Express, deps: OAuthTokenDeps): void {
  if (process.env.WEBAZ_OAUTH !== '1') return                 // fail-closed
  if (process.env.WEBAZ_MODE === 'sandbox') {
    console.error('[oauth] REFUSING to mount /oauth/token: WEBAZ_MODE=sandbox must never expose OAuth')
    return
  }
  const { db, rateLimitOk } = deps

  // P2(Codex PR-3 两轮):parser 错误也必须守 RFC 6749 错误形状 + no-store。两个来源都要接住:
  //   ① 本路由的 urlencoded parser(显式 2kb 上限);② 生产在本路由注册【之前】挂的全局 express.json()
  //   —— 它的 parse 错误发生在路由匹配前,route 级 guard 接不到。解法 = path-scoped 4-arg error handler
  //   (Express 错误处理器按注册序在错误后运行,不管错误来自哪个更早的中间件),统一转 RFC JSON。
  // Convert ONLY body-parser errors (Codex PR-3 round-3): a body-parser error always sets a string
  // `.type` (entity.parse.failed / entity.too.large / encoding.unsupported / …). Any OTHER earlier
  // error on /oauth/token must pass through untouched — masking it as invalid_request would hide real
  // failures.
  const BODY_PARSER_ERR = /^(entity\.|encoding\.|charset\.|request\.|parameters\.|stream\.)/
  app.use('/oauth/token', (err: unknown, _req: Request, res: Response, next: (e?: unknown) => void): void => {
    if (!err) return next()
    const type = (err as { type?: unknown }).type
    if (typeof type !== 'string' || !BODY_PARSER_ERR.test(type)) return next(err)   // not a parse error → don't hijack
    if (res.headersSent) return next(err)
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache')
    res.status(400).json({ error: 'invalid_request', error_description: 'malformed or oversized request body' })
  })
  //   route 级 urlencoded 的错误在栈中发生于本 handler【之后】,error handler 只向后查找 —— 所以
  //   urlencoded 仍需 wrap guard(错误就地转 RFC JSON),两个来源各有各的接法。
  const tokenBodyParser = express.urlencoded({ extended: false, limit: '2kb' })
  const parseGuard = (req: Request, res: Response, next: (e?: unknown) => void): void => {
    tokenBodyParser(req, res, (e?: unknown) => {
      if (e) {
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache')
        return void res.status(400).json({ error: 'invalid_request', error_description: 'malformed or oversized request body' })
      }
      next()
    })
  }
  app.post('/oauth/token', parseGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    const err = (status: number, error: string, error_description: string): void =>
      void res.status(status).json({ error, error_description })   // RFC 6749 §5.2 shape

    if (!rateLimitOk(`oauth_token:${clientIp(req)}`, 30, 60_000)) return err(429, 'invalid_request', 'rate limited')
    const b = (req.body || {}) as Record<string, unknown>

    const grantType = asStr(b.grant_type)

    // Discriminated result of a mint transaction: an RFC error shape, or the issued tokens.
    type MintResult =
      | { status: number; error: string; desc: string }
      | { ok: true; access: string; accessExpMs: number; refresh: string; scope: string }
    const respond = (out: MintResult): void => {
      if (!('ok' in out)) return err(out.status, out.error, out.desc)
      res.json({
        access_token: out.access,               // the ONLY time the raw tokens exist in a response
        token_type: 'Bearer',
        expires_in: Math.max(1, Math.floor((out.accessExpMs - Date.now()) / 1000)),
        refresh_token: out.refresh,
        scope: out.scope,
      })
    }

    // ── grant_type=authorization_code: PKCE code exchange → access + refresh (fresh rotation family) ──
    if (grantType === 'authorization_code') {
      const clientId = asStr(b.client_id)
      const client = clientId ? (await oauthClients()).find(c => c.client_id === clientId) : undefined
      if (!client) return err(401, 'invalid_client', 'unknown or missing client_id')
      const code = asStr(b.code)
      const verifier = asStr(b.code_verifier)
      const redirectUri = asStr(b.redirect_uri)
      if (!code || !verifier || !VERIFIER_RE.test(verifier) || !redirectUri) {
        return err(400, 'invalid_request', 'code, code_verifier (RFC 7636) and redirect_uri are required')
      }
      const codeHash = sha256hex(code)
      const nowIso = new Date().toISOString()
      const resource = asStr(b.resource)
      const challenge = createHash('sha256').update(verifier).digest('base64url')

      // The whole exchange is ONE synchronous better-sqlite3 transaction (like oauth-approve): CAS-consume,
      // binding/PKCE/grant checks, and the access+refresh mint either all commit or all roll back — no torn
      // state, and single-use is guaranteed because the tx runs to completion before any other request's tx.
      const out: MintResult = db.transaction((): MintResult => {
        // CAS-consume FIRST (single-use, unexpired). A consumed/unknown/expired code never proceeds.
        const claimed = db.prepare('UPDATE oauth_auth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?').run(nowIso, codeHash, nowIso)
        if (claimed.changes !== 1) {
          // Replay of an ALREADY-consumed code → the code leaked; revoke that grant's tokens (RFC 6749 §10.5).
          const revoked = db.prepare('UPDATE oauth_access_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND grant_id = (SELECT grant_id FROM oauth_auth_codes WHERE code_hash = ? AND consumed_at IS NOT NULL)').run(nowIso, codeHash)
          if (revoked.changes > 0) console.error(`[oauth] auth-code replay detected — revoked ${revoked.changes} token(s) on the code's grant`)
          return { status: 400, error: 'invalid_grant', desc: 'code is invalid, expired, or already used' }
        }
        const row = db.prepare('SELECT * FROM oauth_auth_codes WHERE code_hash = ?').get(codeHash) as Record<string, unknown>
        // Binding checks — failures leave the code burned (deliberate: the consume above is committed).
        if (row.client_id !== client.client_id) return { status: 400, error: 'invalid_grant', desc: 'code was issued to a different client' }
        if (row.redirect_uri !== redirectUri) return { status: 400, error: 'invalid_grant', desc: 'redirect_uri does not match the authorization request' }
        if (challenge !== row.code_challenge) return { status: 400, error: 'invalid_grant', desc: 'PKCE verification failed' }
        if (resource !== undefined && resource !== row.resource) return { status: 400, error: 'invalid_target', desc: 'resource does not match the authorization request' }
        // I-5: the grant is the principal — it must still be alive (mid-flight revocation/expiry honored).
        const grant = db.prepare("SELECT grant_id, expires_at FROM agent_delegation_grants WHERE grant_id = ? AND status = 'active' AND revoked_at IS NULL AND expires_at > ?").get(row.grant_id, nowIso) as { grant_id: string; expires_at: string } | undefined
        if (!grant) return { status: 400, error: 'invalid_grant', desc: 'the underlying delegation grant is no longer active' }
        // A brand-new rotation family starts here — every subsequent refresh keeps this family_id. The code
        // was already CAS-consumed above (single-use), so a plain insert is sufficient here.
        const pair = genPair(new Date(grant.expires_at).getTime())
        insertPair(db, { ...pair, grantId: String(row.grant_id), clientId: client.client_id, scope: String(row.scope), aud: String(row.resource), familyId: `orf_${randomBytes(16).toString('hex')}` })
        return { ok: true, access: pair.access, accessExpMs: pair.accessExpMs, refresh: pair.refresh, scope: String(row.scope) }
      })()
      return respond(out)
    }

    // ── grant_type=refresh_token: rotate → new access + new refresh (same family); reuse = theft ──
    if (grantType === 'refresh_token') {
      const clientId = asStr(b.client_id)
      const client = clientId ? (await oauthClients()).find(c => c.client_id === clientId) : undefined
      if (!client) return err(401, 'invalid_client', 'unknown or missing client_id')
      const refreshTok = asStr(b.refresh_token)
      if (!refreshTok || !REFRESH_RE.test(refreshTok)) return err(400, 'invalid_request', 'a well-formed refresh_token is required')
      const rHash = sha256hex(refreshTok)
      const nowIso = new Date().toISOString()

      // The whole rotation is ONE synchronous transaction: read → validate → CONDITIONAL-CLAIM → mint | theft.
      // The consume is a CONDITIONAL WRITE (UPDATE ... WHERE rotated_at IS NULL AND revoked_at IS NULL AND
      // expires_at > now, require changes===1) — that conditional, not the surrounding tx, is the atomic
      // serialization point: even across independent DB connections / under any isolation level, at most ONE
      // caller's claim can win. The successor's refresh hash is computed BEFORE the claim (genPair is pure),
      // so the claim stamps rotated_at + replaced_by in one write. A LOST claim (0 changes) means the token
      // was concurrently spent/already-spent/revoked → theft posture: revoke the whole family + the grant's
      // access tokens (RFC 6819 §5.2.2.3). VALIDATE-BEFORE-CLAIM keeps a wrong-client / dead-grant request
      // from ever burning a still-valid token.
      const out: MintResult = db.transaction((): MintResult => {
        const rt = db.prepare('SELECT grant_id, client_id, family_id, scope, aud, expires_at, rotated_at, revoked_at FROM oauth_refresh_tokens WHERE token_hash = ?').get(rHash) as
          { grant_id: string; client_id: string; family_id: string; scope: string; aud: string; expires_at: string; rotated_at: string | null; revoked_at: string | null } | undefined
        const invalid = { status: 400, error: 'invalid_grant', desc: 'refresh token is invalid, expired, or already used' } as const
        if (!rt) return invalid
        const revokeFamily = (): void => {
          db.prepare('UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(nowIso, rt.family_id)
          db.prepare('UPDATE oauth_access_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(nowIso, rt.grant_id)
          console.error("[oauth] refresh-token replay/concurrent-use — revoked the rotation family + the grant's access tokens")
        }
        if (rt.rotated_at || rt.revoked_at) { revokeFamily(); return invalid }   // sequential replay of a spent token
        if (rt.expires_at <= nowIso) return invalid
        // Validate BEFORE claiming — these must NOT burn a still-valid token.
        if (rt.client_id !== client.client_id) return { status: 400, error: 'invalid_grant', desc: 'refresh token was issued to a different client' }
        const grant = db.prepare("SELECT expires_at FROM agent_delegation_grants WHERE grant_id = ? AND status = 'active' AND revoked_at IS NULL AND expires_at > ?").get(rt.grant_id, nowIso) as { expires_at: string } | undefined
        if (!grant) return { status: 400, error: 'invalid_grant', desc: 'the underlying delegation grant is no longer active' }
        // Successor first (pure, no write), then the ATOMIC conditional claim.
        const pair = genPair(new Date(grant.expires_at).getTime())
        const claim = db.prepare('UPDATE oauth_refresh_tokens SET rotated_at = ?, replaced_by = ? WHERE token_hash = ? AND rotated_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
          .run(nowIso, sha256hex(pair.refresh), rHash, nowIso)
        if (claim.changes !== 1) { revokeFamily(); return invalid }   // lost the race → concurrent use = theft posture
        // Won the claim → persist the successor (same family; scope/aud carried forward, no escalation).
        insertPair(db, { ...pair, grantId: rt.grant_id, clientId: client.client_id, scope: rt.scope, aud: rt.aud, familyId: rt.family_id })
        return { ok: true, access: pair.access, accessExpMs: pair.accessExpMs, refresh: pair.refresh, scope: rt.scope }
      })()
      return respond(out)
    }

    return err(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
  })
}
