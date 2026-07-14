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

export function registerOAuthTokenRoutes(app: Express, deps: OAuthTokenDeps): void {
  if (process.env.WEBAZ_OAUTH !== '1') return                 // fail-closed
  if (process.env.WEBAZ_MODE === 'sandbox') {
    console.error('[oauth] REFUSING to mount /oauth/token: WEBAZ_MODE=sandbox must never expose OAuth')
    return
  }
  const { rateLimitOk } = deps

  app.post('/oauth/token', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    const err = (status: number, error: string, error_description: string): void =>
      void res.status(status).json({ error, error_description })   // RFC 6749 §5.2 shape

    if (!rateLimitOk(`oauth_token:${req.ip}`, 30, 60_000)) return err(429, 'invalid_request', 'rate limited')
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
        'UPDATE oauth_access_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND grant_id = (SELECT grant_id FROM oauth_auth_codes WHERE code_hash = ?)',
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
