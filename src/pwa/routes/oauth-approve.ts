/**
 * RFC-023 PR-2b — OAuth consent approve/deny (mints the RFC-020 grant + single-use auth code).
 *
 * Flow position: GET /oauth/authorize (PR-2a) validated the request and handed off to the SPA
 * consent view (#oauth-consent). The view runs the Passkey ceremony (purpose oauth_consent_approve,
 * purpose_data bound to this exact request) and POSTs the gate token here. These are JSON APIs
 * consumed by the SPA — they return { redirect_to }, the SPA performs the navigation.
 *
 * Security decisions enforced (RFC-023 §4/§6):
 *   I-1   approval REQUIRES live human presence — the gate consumes the token DIRECTLY
 *         (consumeGateToken, not the param-toggleable requireHumanPresence wrapper: a credential
 *         mint must not be disable-able by a protocol param — Codex PR-2b P2). Token is single-use
 *         and purpose-bound to the FULL request (client_id+scope+code_challenge+redirect_uri+resource)
 *         so what the human approved is exactly what mints (Codex PR-2b P2: redirect_uri binding).
 *   I-5   token-for-grant: approve mints an RFC-020 agent_delegation_grants row; the OAuth code/token
 *         (PR-3) is a credential FOR that grant. Capabilities are the OAuth-scope mapping, re-validated
 *         through validateRequestedCapabilities — defense-in-depth: only SAFE tiers can enter (T8/I-6).
 *   T4    the auth code stores the PKCE challenge; stored HASHED, single-use, 60s TTL, bound to
 *         client_id + redirect_uri + resource (verified again at /oauth/token, PR-3)
 *   T5    approve/deny re-validate client + exact redirect_uri — a tampered redirect_uri never
 *         becomes a redirect_to (the validated value, not the raw input, builds the URL)
 *   deny  requires login but NOT a Passkey — refusing must stay cheap (I-1 gates approval only)
 *
 * Grant + code mint is one synchronous better-sqlite3 transaction (no torn state).
 */
import type { Express, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { validateAuthorizeRequest, oauthClients } from './oauth-authorize.js'
import { validateRequestedCapabilities } from '../../runtime/agent-grant-scopes.js'
import type { HumanPresence } from '../human-presence.js'

// D5 coarse OAuth scopes → RFC-020 SAFE capabilities (the grant carries capabilities, not raw
// OAuth scopes; /mcp enforcement stays capability-based — PR-4 maps back at introspection).
// 每个 coarse OAuth scope 映射到端点【真正强制】的 SAFE capabilities —— 全部已可经 gtk_ pairing bundle
// 委托(catalog_agent / fulfillment_agent),OAuth 只是同一批 SAFE scope 的另一个授权前门,不新增权限。
// 覆盖到 /mcp 会 401-挑战的三个工具所需 scope,使「挑战即承诺」成立(Codex PR-5 P1:widen 决策 by Holden):
//   read        → 公开读 + 你自己的目录读 + 最小化订单读(卖家侧 + RFC-025 PR-1 买家侧,均无地址/PII)
//                 → get_agent_order / list_product(mine) / buyer_orders
//   order:draft → 订单草稿 + 提交 accept/ship 请求(仅进人工审批队列,永不执行) → order_action_request
//   list:draft  → 商品草稿(status=warehouse,发布仍需人) → list_product(create/draft)
export const OAUTH_SCOPE_CAPABILITIES: Record<string, readonly string[]> = {
  'read': ['read_public', 'profile_read', 'search', 'seller_products_read', 'seller_orders_read_minimal', 'buyer_orders_read_minimal', 'buyer_discover', 'buyer_case_prepare'],
  'order:draft': ['draft_order', 'order_action_request', 'price_quote', 'order_submit_request'],
  'list:draft': ['seller_product_draft'],
}

export const OAUTH_GRANT_TTL_SECONDS = 3600        // grant lives as long as the access token (D2: no refresh)
export const OAUTH_CODE_TTL_SECONDS = 60           // single-use code; client exchanges it immediately

export interface OAuthApproveDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  consumeGateToken: HumanPresence['consumeGateToken']
  rateLimitOk: (key: string, max?: number, windowMs?: number) => boolean
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function buildRedirect(base: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v)
  return `${base}${base.includes('?') ? '&' : '?'}${qs.toString()}`
}

export function registerOAuthApproveRoutes(app: Express, deps: OAuthApproveDeps): void {
  if (process.env.WEBAZ_OAUTH !== '1') return                 // fail-closed
  if (process.env.WEBAZ_MODE === 'sandbox') {
    console.error('[oauth] REFUSING to mount /oauth/authorize/approve: WEBAZ_MODE=sandbox must never expose OAuth')
    return
  }
  const { db, auth, generateId, consumeGateToken, rateLimitOk } = deps

  app.post('/oauth/authorize/approve', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    if (!rateLimitOk(`oauth_approve:${user.id as string}`, 10, 60_000)) {
      return void res.status(429).json({ error: 'rate limited', error_code: 'RATE_LIMITED' })
    }
    const b = (req.body || {}) as Record<string, unknown>

    // Re-validate the FULL authorize request (T5/T8/I-3/I-4) — the SPA hand-off is untrusted input.
    const v = validateAuthorizeRequest({
      client_id: b.client_id, redirect_uri: b.redirect_uri, response_type: 'code',
      scope: b.scope, code_challenge: b.code_challenge, code_challenge_method: 'S256',
      resource: b.resource, state: b.state,
    }, await oauthClients())
    if (!v.ok) return void res.status(400).json({ error: v.error_description, error_code: v.error.toUpperCase() })

    // I-1: live Passkey — token consumed DIRECTLY (no param toggle can disable a credential mint),
    // purpose-bound to the FULL consent request the human saw (incl. redirect_uri + resource).
    const gate = consumeGateToken(
      user.id as string, asStr(b.webauthn_token), 'oauth_consent_approve',
      (data) => {
        const d = data as Record<string, unknown> | null
        return !!d && d.client_id === v.client.client_id && d.scope === v.scopes.join(' ')
          && d.code_challenge === v.code_challenge && d.redirect_uri === v.redirect_uri && d.resource === v.resource
      },
    )
    if (!gate.ok) return void res.status(412).json({ error: gate.reason || 'Passkey verification required', error_code: 'HUMAN_PRESENCE_REQUIRED' })

    // OAuth scopes → SAFE capabilities; re-classified so a mapping mistake can never mint risk (I-6).
    const caps = [...new Set(v.scopes.flatMap(s => OAUTH_SCOPE_CAPABILITIES[s] ?? []))].map(capability => ({ capability }))
    const cv = validateRequestedCapabilities(caps)
    if (!cv.ok) return void res.status(500).json({ error: 'scope mapping produced a non-SAFE capability — refusing', error_code: 'SCOPE_MAP_INVARIANT' })

    const grantId = generateId('grt')
    const code = `oac_${randomBytes(32).toString('hex')}`
    const codeHash = createHash('sha256').update(code).digest('hex')
    const now = Date.now()
    const grantExpiresAt = new Date(now + OAUTH_GRANT_TTL_SECONDS * 1000).toISOString()
    const codeExpiresAt = new Date(now + OAUTH_CODE_TTL_SECONDS * 1000).toISOString()

    db.transaction(() => {
      // RFC-020 grant (I-5). token_hash NULL — the OAuth access token (PR-3) is the credential.
      db.prepare(
        'INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, human_confirm_required, status, expires_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(grantId, user.id, `OAuth: ${v.client.name}`, JSON.stringify(caps), null, 0, 'active', grantExpiresAt)
      db.prepare(
        'INSERT INTO oauth_auth_codes (code_hash, client_id, user_id, grant_id, scope, code_challenge, redirect_uri, resource, expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(codeHash, v.client.client_id, user.id, grantId, v.scopes.join(' '), v.code_challenge, v.redirect_uri, v.resource, codeExpiresAt)
      // RFC-024: mark the client as having earned a real human consent → exempts it from the
      // never-authorized TTL-sweep (no-op for the dev client, which isn't a DB row).
      db.prepare("UPDATE oauth_clients SET last_authorized_at = ? WHERE client_id = ?").run(new Date(now).toISOString(), v.client.client_id)
    })()

    // The raw code appears exactly once: in the redirect back to the validated redirect_uri.
    res.json({ redirect_to: buildRedirect(v.redirect_uri, { code, state: v.state }) })
  })

  app.post('/oauth/authorize/deny', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const b = (req.body || {}) as Record<string, unknown>
    // Client + exact redirect_uri still required — deny must not become an open redirector either.
    const clientId = asStr(b.client_id)
    const redirectUri = asStr(b.redirect_uri)
    const client = clientId ? (await oauthClients()).find(c => c.client_id === clientId) : undefined
    if (!client || !redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return void res.status(400).json({ error: 'unknown client or unregistered redirect_uri', error_code: 'INVALID_CLIENT' })
    }
    res.json({ redirect_to: buildRedirect(redirectUri, { error: 'access_denied', state: asStr(b.state) }) })
  })
}
