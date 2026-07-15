/**
 * RFC-024 — OAuth Dynamic Client Registration (RFC 7591): POST /oauth/register.
 *
 * Lets any MCP client self-register (incl. localhost/ephemeral-port clients that cannot be
 * pre-arranged) → mints a public `client_id` stored in oauth_clients. A registered client is INERT:
 * it can do nothing until a human approves it on the Passkey consent screen (RFC-023 I-1), and even
 * then only within SAFE scopes + short/audience-bound/revocable tokens. So the only new risk is
 * impersonation, which the consent screen mitigates by marking every DCR client `unverified`.
 *
 * Controls (RFC-024 §4):
 *   T1 impersonation → status/verified=0 (consent shows "unverified · self-declared"); name escaped display-only.
 *   T2 spam/bloat → per-IP rate limit (validated CF-Connecting-IP); ≤5 redirect_uris; inert until consented.
 *   T3 open-redirect → isRegisterableRedirectUri (https OR loopback; no wildcard/fragment/userinfo/scheme).
 *   T5 no secret → public client, PKCE only (RFC-023 D4); client_id server-minted random.
 *   T6 fail-closed → mounts only under WEBAZ_OAUTH=1; refuses sandbox.
 *   T7 no scopes at registration → scopes are chosen at /authorize under the consent gate.
 */
import type { Express, Request, Response } from 'express'
import { randomBytes } from 'node:crypto'
import { isRegisterableRedirectUri } from './oauth-authorize.js'
import { dbRun } from '../../layer0-foundation/L0-1-database/db.js'

const MAX_REDIRECT_URIS = 5
const MAX_NAME_LEN = 120

export interface OAuthRegisterDeps {
  rateLimitOk: (key: string, max?: number, windowMs?: number) => boolean
}

const IP_RE = /^[0-9a-fA-F:.]{3,45}$/
function clientIp(req: Request): string {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim()
  if (cf && IP_RE.test(cf)) return cf
  return req.ip || 'unknown'
}

export function registerOAuthRegisterRoutes(app: Express, deps: OAuthRegisterDeps): void {
  if (process.env.WEBAZ_OAUTH !== '1') return                 // fail-closed (T6)
  if (process.env.WEBAZ_MODE === 'sandbox') {
    console.error('[oauth] REFUSING to mount /oauth/register: WEBAZ_MODE=sandbox must never expose OAuth')
    return
  }
  const { rateLimitOk } = deps

  app.post('/oauth/register', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store')
    // RFC 7591 §3.2.2 error shape: { error, error_description }
    const err = (status: number, error: string, error_description: string): void =>
      void res.status(status).json({ error, error_description })

    // Per-IP limit (validated CF-Connecting-IP). Residual: a direct-origin attacker bypassing CF can
    //   rotate the header — same known residual as /mcp & /token (needs cf-origin-guard enforce).
    // Defense-in-depth for THIS row-creating endpoint (Codex P2): a GLOBAL cap bounds total
    //   oauth_clients growth regardless of IP spoofing; the 30d never-authorized sweep bounds the rest.
    if (!rateLimitOk(`oauth_register:${clientIp(req)}`, 10, 60_000)) return err(429, 'invalid_request', 'rate limited')
    if (!rateLimitOk('oauth_register:global', 60, 60_000)) return err(429, 'invalid_request', 'registration temporarily rate limited')
    const b = (req.body || {}) as Record<string, unknown>

    // redirect_uris: required, 1..MAX, each https-or-loopback (T3)
    const uris = b.redirect_uris
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
      return err(400, 'invalid_redirect_uri', `redirect_uris must be a non-empty array of at most ${MAX_REDIRECT_URIS} URIs`)
    }
    if (!uris.every(isRegisterableRedirectUri)) {
      return err(400, 'invalid_redirect_uri', 'each redirect_uri must be https, or http on loopback (localhost/127.0.0.1/[::1]); no wildcards, fragments, userinfo, or custom schemes')
    }
    // Only public-client, authorization_code+PKCE registrations are accepted (RFC-023 D4).
    const authMethod = b.token_endpoint_auth_method
    if (authMethod !== undefined && authMethod !== 'none') {
      return err(400, 'invalid_client_metadata', 'only public clients are supported: token_endpoint_auth_method must be "none"')
    }
    for (const [field, allowed] of [['grant_types', 'authorization_code'], ['response_types', 'code']] as const) {
      const val = b[field]
      if (val !== undefined && !(Array.isArray(val) && val.length === 1 && val[0] === allowed)) {
        return err(400, 'invalid_client_metadata', `${field}, if present, must be ["${allowed}"]`)
      }
    }
    const rawName = typeof b.client_name === 'string' ? b.client_name.trim().slice(0, MAX_NAME_LEN) : ''
    const name = rawName || 'Unnamed client'   // display-only, self-declared; escaped on the consent screen

    const clientId = `oac_client_${randomBytes(16).toString('hex')}`
    const nowIso = new Date().toISOString()
    await dbRun(
      "INSERT INTO oauth_clients (client_id, name, redirect_uris, status, verified, created_at, created_ip_hash, client_metadata) VALUES (?,?,?,?,?,?,?,?)",
      [clientId, name, JSON.stringify(uris), 'active', 0, nowIso, hashIp(clientIp(req)), JSON.stringify({ client_name: name, redirect_uris: uris })],
    )

    // RFC 7591 §3.2.1 success — public client, no secret; echo the registered metadata.
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(new Date(nowIso).getTime() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    })
  })
}

// Hash the registering IP for abuse-audit without storing a raw IP (privacy).
import { createHash } from 'node:crypto'
function hashIp(ip: string): string { return createHash('sha256').update('oauth_reg:' + ip).digest('hex').slice(0, 32) }

/**
 * RFC-024 §T2 — DCR client TTL sweep. `/oauth/register` lets anyone self-register an INERT client
 * (verified=0, last_authorized_at NULL). Without expiry those rows accumulate unbounded — the global
 * rate limit caps the registration *rate*, not the cumulative total. This deletes clients that are
 * unverified AND never consented AND older than 30 days. Such a client has never been through the
 * Passkey consent that mints its grant/auth-code/token, so it owns no oauth_auth_codes or
 * oauth_access_tokens rows — the delete is FK-safe. Verified or ever-authorized clients are never
 * touched. Returns the number of rows swept. Driven by the server boot cron (every 24h).
 */
export async function sweepStaleOAuthClients(nowMs: number = Date.now()): Promise<number> {
  const cutoff = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString()
  const r = await dbRun(
    `DELETE FROM oauth_clients WHERE verified = 0 AND last_authorized_at IS NULL AND created_at < ?`,
    [cutoff],
  )
  return r.changes
}

/** Start the 24h TTL-sweep cron (server boot wiring, kept out of server.ts to respect its size ceiling). */
export function startOAuthClientSweepCron(intervalMs = 24 * 60 * 60 * 1000): NodeJS.Timeout {
  const run = (): void => void sweepStaleOAuthClients()
    .then(n => { if (n > 0) console.log(`[oauth-cron] swept ${n} never-authorized DCR clients >30d`) })
    .catch(e => console.error('[oauth-cron]', e))
  const timer = setInterval(run, intervalMs)
  console.log('🧹 oauth_clients TTL cron 已启动（每 24h 清 verified=0 且从未 consent 的 >30d DCR client）')
  return timer
}
