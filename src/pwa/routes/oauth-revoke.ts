/**
 * RFC-023 PR-3(revoke) — token revocation endpoint (RFC 7009).
 *
 * POST /oauth/revoke (application/x-www-form-urlencoded per RFC 7009; JSON also accepted)
 *   token=<oat_…|ort_…> & [token_type_hint=access_token|refresh_token] & client_id
 *
 * Semantics: the presented token identifies its backing RFC-020 grant (the single principal). Revoking
 * tears down the WHOLE connection — grant status→revoked AND every access + refresh token of that grant —
 * in one synchronous .immediate() transaction. That is exactly what a client "disconnect" wants, and each
 * OAuth consent mints its OWN grant (1:1 with the connection), so this never affects other clients/grants.
 *
 * RFC 7009 posture:
 *   - 200 on success OR on an unknown/already-revoked token (NO oracle — never reveal token validity).
 *   - a token whose client_id ≠ the presenting client_id is a NO-OP + 200 (a client may only revoke its own
 *     tokens; no cross-client revocation DoS, and still no oracle).
 *   - 400 invalid_request only for a malformed/oversized body or a missing token.
 *   - 401 invalid_client for a missing/unknown client_id (public-client identity, same as /oauth/token).
 *
 * Fail-closed mount (WEBAZ_OAUTH=1, sandbox refuses), per-IP rate limit (best-effort behind CF). no-store.
 */
import express from 'express'
import type { Express, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { oauthClients } from './oauth-authorize.js'

const REVOKE_TOKEN_RE = /^o(at|rt)_[0-9a-f]{64}$/   // oat_ access OR ort_ refresh (prefix + 256-bit hex)

export interface OAuthRevokeDeps {
  db: Database.Database   // sync handle — grant + token cascade revocation is one .immediate() transaction
  rateLimitOk: (key: string, max?: number, windowMs?: number) => boolean
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
function sha256hex(s: string): string { return createHash('sha256').update(s).digest('hex') }

const IP_RE = /^[0-9a-fA-F:.]{3,45}$/
function clientIp(req: Request): string {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim()
  if (cf && IP_RE.test(cf)) return cf
  return req.ip || 'unknown'
}

export function registerOAuthRevokeRoutes(app: Express, deps: OAuthRevokeDeps): void {
  if (process.env.WEBAZ_OAUTH !== '1') return                 // fail-closed
  if (process.env.WEBAZ_MODE === 'sandbox') {
    console.error('[oauth] REFUSING to mount /oauth/revoke: WEBAZ_MODE=sandbox must never expose OAuth')
    return
  }
  const { db, rateLimitOk } = deps

  // Same body-parser guards as /oauth/token: convert body-parser errors (from this route's urlencoded parser
  // OR the earlier global express.json()) into RFC-shaped JSON + no-store; pass any OTHER earlier error through.
  const BODY_PARSER_ERR = /^(entity\.|encoding\.|charset\.|request\.|parameters\.|stream\.)/
  app.use('/oauth/revoke', (err: unknown, _req: Request, res: Response, next: (e?: unknown) => void): void => {
    if (!err) return next()
    const type = (err as { type?: unknown }).type
    if (typeof type !== 'string' || !BODY_PARSER_ERR.test(type)) return next(err)
    if (res.headersSent) return next(err)
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache')
    res.status(400).json({ error: 'invalid_request', error_description: 'malformed or oversized request body' })
  })
  const bodyParser = express.urlencoded({ extended: false, limit: '2kb' })
  const parseGuard = (req: Request, res: Response, next: (e?: unknown) => void): void => {
    bodyParser(req, res, (e?: unknown) => {
      if (e) {
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache')
        return void res.status(400).json({ error: 'invalid_request', error_description: 'malformed or oversized request body' })
      }
      next()
    })
  }

  app.post('/oauth/revoke', parseGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    const err = (status: number, error: string, error_description: string): void =>
      void res.status(status).json({ error, error_description })

    if (!rateLimitOk(`oauth_revoke:${clientIp(req)}`, 30, 60_000)) return err(429, 'invalid_request', 'rate limited')
    const b = (req.body || {}) as Record<string, unknown>

    const clientId = asStr(b.client_id)
    const client = clientId ? (await oauthClients()).find(c => c.client_id === clientId) : undefined
    if (!client) return err(401, 'invalid_client', 'unknown or missing client_id')

    const token = asStr(b.token)
    if (!token) return err(400, 'invalid_request', 'token is required')

    // Unknown / malformed token → 200 no-op (RFC 7009: never reveal token validity).
    if (!REVOKE_TOKEN_RE.test(token)) return void res.status(200).json({ revoked: false })
    const hint = asStr(b.token_type_hint)
    const tokenHash = sha256hex(token)
    const now = new Date().toISOString()

    // Resolve the token → its backing grant + owning client. Honor token_type_hint but fall back to the other
    // table (RFC 7009 §2.1: the hint is advisory; a wrong hint must not cause a failed revocation).
    const findAccess = () => db.prepare('SELECT grant_id, client_id FROM oauth_access_tokens WHERE token_hash = ?').get(tokenHash) as { grant_id: string; client_id: string } | undefined
    const findRefresh = () => db.prepare('SELECT grant_id, client_id FROM oauth_refresh_tokens WHERE token_hash = ?').get(tokenHash) as { grant_id: string; client_id: string } | undefined
    const row = hint === 'refresh_token'
      ? (findRefresh() ?? findAccess())
      : (findAccess() ?? findRefresh())

    // Unknown token, or a token that belongs to a DIFFERENT client → 200 no-op (no oracle, no cross-client revoke).
    if (!row || row.client_id !== client.client_id) return void res.status(200).json({ revoked: false })

    // Tear the whole connection down: grant → revoked, and every access + refresh token of that grant. One
    // .immediate() tx so the cascade is atomic. Revoking the grant alone already fails all downstream
    // introspection/refresh (they check grant liveness); we also stamp the token rows for clean audit.
    db.transaction(() => {
      db.prepare("UPDATE agent_delegation_grants SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE grant_id = ? AND status != 'revoked'").run(now, 'oauth_revoke', row.grant_id)
      db.prepare('UPDATE oauth_access_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(now, row.grant_id)
      db.prepare('UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(now, row.grant_id)
    }).immediate()

    res.status(200).json({ revoked: true })
  })
}
