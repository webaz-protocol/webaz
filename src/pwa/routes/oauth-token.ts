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
 *   D2      no refresh token — expires_in caps at the UNDERLYING GRANT's expiry (I-5): a token can
 *           never outlive the grant the human approved.
 *   D4      public clients — client identity is the allowlist id + possession of code+verifier.
 *
 * Fail-closed mount (WEBAZ_OAUTH=1, sandbox refuses), per-IP rate limit (best-effort behind CF).
 */
import express from 'express'
import type { Express, Request, Response } from 'express'
import { createHash, randomBytes } from 'node:crypto'
import { oauthClients } from './oauth-authorize.js'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'

export const OAUTH_TOKEN_TTL_SECONDS = 3600
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/   // RFC 7636 §4.1 unreserved charset

export interface OAuthTokenDeps {
  rateLimitOk: (key: string, max?: number, windowMs?: number) => boolean
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
function sha256hex(s: string): string { return createHash('sha256').update(s).digest('hex') }

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
  const { rateLimitOk } = deps

  // P2(Codex PR-3 两轮):parser 错误也必须守 RFC 6749 错误形状 + no-store。两个来源都要接住:
  //   ① 本路由的 urlencoded parser(显式 2kb 上限);② 生产在本路由注册【之前】挂的全局 express.json()
  //   —— 它的 parse 错误发生在路由匹配前,route 级 guard 接不到。解法 = path-scoped 4-arg error handler
  //   (Express 错误处理器按注册序在错误后运行,不管错误来自哪个更早的中间件),统一转 RFC JSON。
  app.use('/oauth/token', (err: unknown, _req: Request, res: Response, next: (e?: unknown) => void): void => {
    if (!err) return next()
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

    if (asStr(b.grant_type) !== 'authorization_code') return err(400, 'unsupported_grant_type', 'only grant_type=authorization_code is supported')
    const clientId = asStr(b.client_id)
    const client = clientId ? oauthClients().find(c => c.client_id === clientId) : undefined
    if (!client) return err(401, 'invalid_client', 'unknown or missing client_id')
    const code = asStr(b.code)
    const verifier = asStr(b.code_verifier)
    const redirectUri = asStr(b.redirect_uri)
    if (!code || !verifier || !VERIFIER_RE.test(verifier) || !redirectUri) {
      return err(400, 'invalid_request', 'code, code_verifier (RFC 7636) and redirect_uri are required')
    }

    const codeHash = sha256hex(code)
    const nowIso = new Date().toISOString()

    // CAS-consume FIRST (single-use, unexpired). A consumed/unknown/expired code never proceeds.
    const claimed = await dbRun(
      'UPDATE oauth_auth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?',
      [nowIso, codeHash, nowIso],
    )
    if (claimed.changes !== 1) {
      // Replay of an ALREADY-consumed code → the code leaked; revoke that grant's tokens (RFC 6749 §10.5).
      const revoked = await dbRun(
        'UPDATE oauth_access_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND grant_id = (SELECT grant_id FROM oauth_auth_codes WHERE code_hash = ? AND consumed_at IS NOT NULL)',
        [nowIso, codeHash],
      )
      if (revoked.changes > 0) console.error(`[oauth] auth-code replay detected — revoked ${revoked.changes} token(s) on the code's grant`)
      return err(400, 'invalid_grant', 'code is invalid, expired, or already used')
    }
    const row = await dbOne<Record<string, unknown>>('SELECT * FROM oauth_auth_codes WHERE code_hash = ?', [codeHash]) as Record<string, unknown>

    // Binding checks — failures leave the code burned (deliberate: see header).
    if (row.client_id !== client.client_id) return err(400, 'invalid_grant', 'code was issued to a different client')
    if (row.redirect_uri !== redirectUri) return err(400, 'invalid_grant', 'redirect_uri does not match the authorization request')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    if (challenge !== row.code_challenge) return err(400, 'invalid_grant', 'PKCE verification failed')
    const resource = asStr(b.resource)
    if (resource !== undefined && resource !== row.resource) return err(400, 'invalid_target', 'resource does not match the authorization request')

    // I-5: the grant is the principal — it must still be alive (mid-flight revocation/expiry honored).
    const grant = await dbOne<{ grant_id: string; expires_at: string }>(
      "SELECT grant_id, expires_at FROM agent_delegation_grants WHERE grant_id = ? AND status = 'active' AND revoked_at IS NULL AND expires_at > ?",
      [row.grant_id, nowIso],
    )
    if (!grant) return err(400, 'invalid_grant', 'the underlying delegation grant is no longer active')

    // D1 opaque token, hashed at rest; D2 no refresh — expiry clamped to the grant's (never outlives it).
    const token = `oat_${randomBytes(32).toString('hex')}`
    const tokenExpiry = Math.min(Date.now() + OAUTH_TOKEN_TTL_SECONDS * 1000, new Date(grant.expires_at).getTime())
    await dbRun(
      'INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?)',
      [sha256hex(token), row.grant_id, client.client_id, row.scope, row.resource, new Date(tokenExpiry).toISOString()],
    )

    res.json({
      access_token: token,                 // the ONLY time the raw token exists in a response
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.floor((tokenExpiry - Date.now()) / 1000)),
      scope: row.scope,
    })
  })
}
