/**
 * RFC-020 PR-B — Agent delegation grants: minimal PWA issue / read / revoke API.
 *
 * This is the human-owned side of RFC-020: a logged-in human mints a **scoped,
 * short-lived, revocable** delegation grant for an agent — NOT a permanent api_key.
 * The (future) MCP `webaz_pair` consumer + per-request scope enforcement are NOT in
 * this PR.
 *
 * HARD BOUNDARIES (PR-B):
 *   - A grant may carry ONLY safe scopes. Risk scopes are default-hard-rejected;
 *     never-delegable scopes are hard-rejected forever (see agent-grant-scopes.ts).
 *   - Touches NO payment / wallet / order / refund / escrow / commission / fund /
 *     tokenomics code — only the `agent_delegation_grants` table.
 *   - Bearer-first: the raw bearer is returned ONCE; only its SHA-256 hash is stored.
 *     PoP (`agent_pubkey`) is reserved, not implemented — required before any risk
 *     scope or longer-lived delegation.
 *   - `human_confirm_required` is a stored design field only; its enforcement (when
 *     risk scopes are later enabled) reuses the existing webauthn_gate_tokens /
 *     requireHumanPresence gate — no second confirmation mechanism is built here.
 *
 * Registered from registerWebauthnRoutes (Passkey-domain security routes) so the
 * money-dense src/pwa/server.ts stays untouched and within the complexity ratchet.
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'
import { initAgentDelegationGrantsSchema, initAgentPairingSchema, initAgentGrantAuthLogSchema, initAgentPermissionRequestsSchema } from '../../runtime/webaz-schema-helpers.js'
import { validateRequestedCapabilities, clampTtlSeconds, grantIsActive, resolveBundle, durationAllowedForScopes, suggestedDurationForScopes, durationToSeconds, riskLevelForScopes, type GrantDuration } from '../../runtime/agent-grant-scopes.js'
import { generateUserCode, verifyPkceS256, clampPairingTtlSeconds, pairingApprovable, pairingRetrievable } from '../../runtime/agent-pairing.js'
import { verifyGrantToken, type GrantPrincipal } from '../../runtime/agent-grant-verifier.js'

export interface AgentGrantsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  rateLimitOk: (key: string, max?: number, windowMs?: number) => boolean  // throttles the anonymous pair/start
  // 人工在场 gate:批准配对必须真人 Passkey/WebAuthn(与 agent_revoke 同机制)。param 关闭时放行。
  requireHumanPresence: (userId: string, purpose: 'agent_pair_approve' | 'agent_permission_approve', token: string | undefined, paramKey: string, validate?: (data: unknown) => boolean) => { ok: boolean; error_code?: string; reason?: string }
  // RFC-020 PR-4: shared product-create handler (single source with the human POST /api/products); used by the
  //   grant-gated warehouse-draft route so the agent path can never drift from the human validation.
  createProductDraftHandler?: (req: Request, res: Response, user: Record<string, unknown>, opts?: { forceStatus?: 'warehouse'; onCreated?: (productId: string) => Promise<void> | void; skipExternalLinkEffects?: boolean }) => Promise<void>
}

// Bounds on a pairing request (anti-bloat for the anonymous start endpoint).
const MAX_CAPABILITIES = 12
const MAX_CONSTRAINTS_JSON = 2000

// Thrown inside the approve transaction when the grant is no longer active (revoked/expired in the race
// window) — rolls the whole tx back so the request claim + expansion + audit are all-or-nothing.
class GrantInactiveError extends Error {}

function safeParseCaps(json: unknown): unknown {
  try { return JSON.parse(String(json)) } catch { return [] }
}

/** Server-generated consent view for a pairing — canonical scope labels only, no secrets. */
function consentView(p: Record<string, unknown>): Record<string, unknown> {
  return {
    pairing_id: p.pairing_id,
    agent_label: p.agent_label || null,
    reason: p.reason || null,                       // agent-supplied free text (display only)
    capabilities: safeParseCaps(p.capabilities),    // server-validated safe scopes
    status: p.status,
    expires_at: p.expires_at,
    notice: 'Approving issues a scoped, short-lived, revocable delegation grant — NOT your api_key, NOT your funds. Safe (read/draft) scopes only; it can never move money, vote, arbitrate, or change keys.',
  }
}

export function registerAgentGrantsRoutes(app: Application, deps: AgentGrantsDeps): void {
  const { db, auth, generateId, rateLimitOk, requireHumanPresence, createProductDraftHandler } = deps
  // PWA runtime self-init (MCP gets the tables via applyWebazRuntimeSchema). Idempotent.
  initAgentDelegationGrantsSchema(db)
  initAgentPairingSchema(db)
  initAgentGrantAuthLogSchema(db)
  initAgentPermissionRequestsSchema(db)

  // Resolve the ACTIVE grant behind a gtk_ bearer (no scope check) — used to bind a permission request to
  // (grant_id, human_id). Returns null on missing/expired/revoked. token_hash lookup mirrors the verifier.
  async function resolveActiveGrantByBearer(req: Request): Promise<{ grant_id: string; human_id: string; agent_label: string | null; capabilities: string } | null> {
    const bearer = (req.header('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!bearer.startsWith('gtk_')) return null
    const g = await dbOne<{ grant_id: string; human_id: string; agent_label: string | null; capabilities: string; status: string; expires_at: string; revoked_at: string | null }>(
      'SELECT grant_id, human_id, agent_label, capabilities, status, expires_at, revoked_at FROM agent_delegation_grants WHERE token_hash = ?',
      [createHash('sha256').update(bearer).digest('hex')])
    if (!g || !grantIsActive(g, new Date().toISOString())) return null
    return { grant_id: g.grant_id, human_id: g.human_id, agent_label: g.agent_label, capabilities: g.capabilities }
  }

  // ─────────────────────────── RFC-020 PR-C2a: opt-in grant-scope enforcement ───────────────────────────
  // EXPLICIT, per-route, per-SAFE-scope. NOT global auth — a gtk_* token is accepted ONLY by routes that
  // deliberately mount requireAgentGrantScope(scope); auth()/api_key is untouched and never accepts gtk_*.
  // Risk / never-delegable scopes can never pass (the verifier hard-fails non-safe required scopes).
  const requireAgentGrantScope = (scope: string) =>
    async (req: Request, res: Response, next: () => void): Promise<void> => {
      // Anti-abuse: throttle the grant-consumption path BEFORE any DB work (parity with pair/start).
      // Bounds both anonymous probing and valid-grant spam, and caps audit-log growth.
      if (!rateLimitOk(`agent_grant:${req.ip || 'anon'}`, 30, 60_000)) {
        return void res.status(429).json({ error: 'too_many_grant_requests', error_code: 'GRANT_RATE_LIMITED', retry_after_s: 60 })
      }
      const bearer = (req.header('authorization') || '').replace(/^Bearer\s+/i, '')
      const presentedGrant = bearer.startsWith('gtk_')   // a request that presents no grant bearer isn't "grant-authorized"
      const r = await verifyGrantToken(bearer, scope)
      // Append-only audit (RFC-020 §3.7 + invariant: every grant-authorized request is audited). Only audit
      // requests that actually presented a grant bearer — a no-token request is pure noise (and an unauth
      // bloat vector), not a grant-authorized request.
      let audited = false
      if (presentedGrant) {
        try {
          await dbRun(
            'INSERT INTO agent_grant_auth_log (grant_id, human_id, capability, outcome, error_code) VALUES (?,?,?,?,?)',
            [r.ok ? r.principal.grant_id : (r.grant_id ?? null), r.ok ? r.principal.human_id : (r.human_id ?? null), scope, r.ok ? 'allow' : 'deny', r.ok ? null : r.error_code],
          )
          audited = true
        } catch (e) {
          console.error('[agent-grant] audit write failed:', (e as Error).message)
        }
      }
      // Deny path: return the denial regardless of audit (no access is granted, so nothing to fail closed on).
      if (!r.ok) {
        // Structured permission_required (RFC-020): the agent IS validly connected but its grant simply lacks
        //   this SAFE scope. Instead of a bare 403, hand it the exact next step — ask the human to expand the
        //   grant (approval_url + the create-request call), then retry this same request. Other grant failures
        //   (no/expired/revoked/suspended grant) stay plain: those aren't "request more", they must re-pair.
        if (r.error_code === 'SCOPE_NOT_GRANTED') {
          return void res.status(403).json({
            error: `this action needs the "${scope}" permission, which your grant does not carry`,
            error_code: 'PERMISSION_REQUIRED',
            required_scope: scope,
            missing_scopes: [scope],
            approval_url: '/#agent-approvals',
            retry_after_approval: true,
            request_permission: { method: 'POST', endpoint: '/api/agent-grants/permission-requests', body: { scopes: [scope] } },
            note: 'Ask the human to approve at approval_url; on approval your existing grant is expanded — then retry this request.',
          })
        }
        return void res.status(r.status).json({ error: r.error, error_code: r.error_code })
      }
      // Success path: FAIL CLOSED if the authorization could not be audited — a grant-authorized request
      // must never proceed unaudited (RFC-020 invariant). Better to deny (503, retryable) than act unaccountably.
      if (!audited) return void res.status(503).json({ error: 'authorization audit unavailable; refusing to proceed unaudited', error_code: 'GRANT_AUDIT_FAILED' })
      ;(req as Request & { agentGrant?: GrantPrincipal }).agentGrant = r.principal
      next()
    }

  // Vertical slice (zero-risk): grant principal introspection. Proves the verifier + opt-in middleware
  // end-to-end on a brand-new read-only endpoint that touches NO existing route and NO money path.
  app.get('/api/agent-grants/whoami', requireAgentGrantScope('read_public'), (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant
    res.json({ grant: p, note: 'Authorized via delegation grant (safe scope read_public). This is a grant principal, not a human session.' })
  })

  // First REAL grant-consumed seller surface (Catalog Agent): read the grant human's OWN catalog. Read-only,
  //   money fields (commission/stake) excluded. A grant that lacks seller_products_read → structured
  //   permission_required (see requireAgentGrantScope) so the agent can request → human approves → retry.
  //   The consumption (allow AND the permission_required deny) is audited by the middleware.
  app.get('/api/agent/seller/products', requireAgentGrantScope('seller_products_read'), async (req, res) => {
    const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
    const rows = await dbAll<Record<string, unknown>>(
      "SELECT id, title, status, price, currency, stock, category, created_at, updated_at FROM products WHERE seller_id = ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 200",
      [p.human_id])
    res.json({ seller_id: p.human_id, agent_label: p.agent_label, count: rows.length, products: rows, note: 'Seller-owned catalog read via delegation grant (safe scope seller_products_read). Read-only; no money/commission fields.' })
  })

  // POST create a DRAFT product via a delegation grant (Catalog Agent, safe scope seller_product_draft). The
  //   draft is FORCED to status='warehouse' (not public/sellable). PUBLISHING STAYS HUMAN-ONLY — the human
  //   flips warehouse→active in the existing 我的商品→仓库 UI (publish is never delegated to a grant, matching
  //   the taxonomy). Reuses the SAME product-create validation as the human POST /api/products
  //   (createProductDraftHandler) so the agent path can't drift. Audited by the middleware. Lightweight signal:
  //   a notification tells the human a draft is waiting to review + publish.
  if (createProductDraftHandler) {
    app.post('/api/agent/seller/products', requireAgentGrantScope('seller_product_draft'), async (req, res) => {
      const p = (req as Request & { agentGrant?: GrantPrincipal }).agentGrant!
      const human = await dbOne<{ id: string; role: string }>('SELECT id, role FROM users WHERE id = ?', [p.human_id])
      if (!human || human.role !== 'seller') return void res.status(403).json({ error: 'the grant owner is not a seller — product drafts need a seller account', error_code: 'NOT_A_SELLER' })
      await createProductDraftHandler(req, res, human as Record<string, unknown>, {
        forceStatus: 'warehouse',
        skipExternalLinkEffects: true,   // a SAFE draft grant must never trigger wallet debit / verify_tasks / auto-verified links (source_url stays inert metadata)
        onCreated: async (productId) => {
          try {
            await dbRun("INSERT INTO notifications (id, user_id, type, title, body) VALUES (?,?,?,?,?)",
              [generateId('ntf'), p.human_id, 'agent_product_draft', 'AI 助手起草了商品草稿', `${p.agent_label || 'An agent'} 起草了商品草稿 ${productId}，请到「我的商品 → 仓库」审核并发布。`])
          } catch (e) { console.error('[agent-grant draft notify]', (e as Error).message) }
        },
      })
    })
  }

  // helpers for the permission-request flow ----------------------------------------------------------------
  const parseCapList = (json: string): Array<{ capability: string; constraints?: Record<string, unknown> }> => { try { const a = JSON.parse(json); return Array.isArray(a) ? a : [] } catch { return [] } }
  const scopeNames = (json: string): string[] => parseCapList(json).map(c => (typeof c === 'string' ? c : c?.capability)).filter((s): s is string => typeof s === 'string')
  // Returns true iff the audit row was durably written. Callers on the grant-authorized SUCCESS path MUST
  // fail closed when this is false (RFC-020 invariant: a grant-authorized action is audited or it does not
  // happen) — parity with the requireAgentGrantScope middleware above.
  const auditGrant = async (grantId: string | null, humanId: string | null, cap: string, outcome: 'allow' | 'deny', errorCode?: string): Promise<boolean> => {
    try { await dbRun('INSERT INTO agent_grant_auth_log (grant_id, human_id, capability, outcome, error_code) VALUES (?,?,?,?,?)', [grantId, humanId, cap, outcome, errorCode ?? null]); return true } catch (e) { console.error('[agent-grant] audit write failed:', (e as Error).message); return false }
  }
  const bundleSummary = (key: string | null): string | null => { const b = key ? resolveBundle(key) : null; return b ? b.human_summary : null }

  // GET verify — grant-authed. Returns the FULL grant (scopes, bundle, expiry, status), not just read_public.
  //   Audited (acceptance #8: every grant use logs). Never returns the raw token/api_key.
  app.get('/api/agent-grants/verify', async (req, res) => {
    const g = await resolveActiveGrantByBearer(req)
    if (!g) { return void res.status(401).json({ error: 'active delegation grant required', error_code: 'GRANT_REQUIRED' }) }
    const full = await dbOne<{ grant_id: string; human_id: string; agent_label: string | null; capabilities: string; status: string; expires_at: string; permission_bundle: string | null }>(
      'SELECT grant_id, human_id, agent_label, capabilities, status, expires_at, permission_bundle FROM agent_delegation_grants WHERE grant_id = ?', [g.grant_id])
    // Fail closed: a grant-authorized read is audited or it does not proceed (parity with requireAgentGrantScope).
    if (!(await auditGrant(g.grant_id, g.human_id, 'grant:verify', 'allow'))) return void res.status(503).json({ error: 'authorization audit unavailable; refusing to proceed unaudited', error_code: 'GRANT_AUDIT_FAILED' })
    res.json({ grant: { grant_id: full!.grant_id, human_id: full!.human_id, agent_label: full!.agent_label, scopes: scopeNames(full!.capabilities), permission_bundle: full!.permission_bundle, expires_at: full!.expires_at, status: full!.status }, note: 'Full grant principal — all authorized scopes/bundle/expiry/status. Not a human session; never authorizes risk/never-delegable actions.' })
  })

  // POST create a permission request — the AGENT (holding its current grant) asks for MORE scope / a bundle.
  //   Bound to (human_id, grant_id) from the grant bearer. Rate-limited. Safe-only: risk/never-delegable are
  //   NOT grantable (they need a per-action live Passkey, not a persistent grant) → structured reject.
  app.post('/api/agent-grants/permission-requests', async (req, res) => {
    if (!rateLimitOk(`agent_perm_req:${req.ip || 'anon'}`, 20, 60_000)) return void res.status(429).json({ error: 'too_many_permission_requests', retry_after_s: 60 })
    const g = await resolveActiveGrantByBearer(req)
    if (!g) return void res.status(401).json({ error: 'an active delegation grant is required to request more permissions (pair first with webaz_pair)', error_code: 'GRANT_REQUIRED' })
    const body = (req.body || {}) as Record<string, unknown>
    const bundleKey = typeof body.bundle === 'string' ? body.bundle : null
    const bundle = bundleKey ? resolveBundle(bundleKey) : null
    if (bundleKey && !bundle) return void res.status(400).json({ error: 'unknown permission bundle', error_code: 'UNKNOWN_BUNDLE' })
    const scopes = bundle ? [...bundle.scopes] : (Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : [])
    if (scopes.length === 0) return void res.status(400).json({ error: 'bundle or scopes required', error_code: 'NO_SCOPES' })
    const v = validateRequestedCapabilities(scopes.map(s => ({ capability: s })))
    if (!v.ok) return void res.status(403).json({ error: 'permission_not_grantable', error_code: 'PERMISSION_NOT_GRANTABLE', rejected: v.rejected, note: 'Only safe (read/draft) scopes can be granted. Risk actions (order/publish/refund/…) require the human to act with a live Passkey — they are never delegated to a persistent grant.' })
    const risk = riskLevelForScopes(scopes)
    const duration: GrantDuration = durationAllowedForScopes(scopes, body.duration) ? body.duration as GrantDuration : suggestedDurationForScopes(scopes)
    const id = generateId('apr')
    const reqTtlIso = new Date(Date.now() + 7 * 86400_000).toISOString()   // request auto-expires in 7d if unanswered
    await dbRun(
      'INSERT INTO agent_permission_requests (id, human_id, grant_id, agent_label, requested_scopes, permission_bundle, reason, task_context, risk_level, duration, status, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, g.human_id, g.grant_id, g.agent_label, JSON.stringify(scopes), bundleKey, typeof body.reason === 'string' ? body.reason.slice(0, 280) : null, typeof body.task_context === 'string' ? body.task_context.slice(0, 500) : null, risk, duration, 'pending', reqTtlIso],
    )
    res.status(201).json({ approval_id: id, approval_url: '/#agent-approvals', status: 'pending', risk_level: risk, requested_scopes: scopes, permission_bundle: bundleKey, human_summary: bundleSummary(bundleKey), suggested_duration: duration, note: 'Ask the human to open approve_url (logged in) and approve. On approval your existing grant is expanded; then retry.' })
  })

  // GET list this human's PENDING permission requests (for #agent-approvals). Human-authed.
  app.get('/api/agent-grants/permission-requests', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll<Record<string, unknown>>(
      "SELECT id, agent_label, requested_scopes, permission_bundle, reason, task_context, risk_level, duration, created_at, expires_at FROM agent_permission_requests WHERE human_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 100",
      [user.id, new Date().toISOString()])
    res.json({ requests: rows.map(r => ({ ...r, requested_scopes: scopeNames(String(r.requested_scopes)), human_summary: bundleSummary(r.permission_bundle as string | null) })) })
  })

  // GET list the requests THIS grant created — GRANT-authed (the agent, via webaz_pair), so an agent can poll
  //   its own request status (pending/approved/rejected/expired) without hitting the target surface. Bound to
  //   grant_id: an agent sees ONLY its own requests, never the human's other agents'. Audited (fail-closed).
  app.get('/api/agent-grants/my-permission-requests', async (req, res) => {
    if (!rateLimitOk(`agent_perm_list:${req.ip || 'anon'}`, 30, 60_000)) return void res.status(429).json({ error: 'too_many_requests', error_code: 'GRANT_RATE_LIMITED', retry_after_s: 60 })
    const g = await resolveActiveGrantByBearer(req)
    if (!g) return void res.status(401).json({ error: 'an active delegation grant is required (pair first with webaz_pair)', error_code: 'GRANT_REQUIRED' })
    const rows = await dbAll<Record<string, unknown>>(
      'SELECT id, requested_scopes, permission_bundle, risk_level, duration, status, created_at, expires_at, approved_at FROM agent_permission_requests WHERE grant_id = ? ORDER BY created_at DESC LIMIT 50', [g.grant_id])
    if (!(await auditGrant(g.grant_id, g.human_id, 'grant:list_requests', 'allow'))) return void res.status(503).json({ error: 'authorization audit unavailable; refusing to proceed unaudited', error_code: 'GRANT_AUDIT_FAILED' })
    res.json({ requests: rows.map(r => ({ ...r, requested_scopes: scopeNames(String(r.requested_scopes)), human_summary: bundleSummary(r.permission_bundle as string | null) })) })
  })

  // RFC-020: expanding an agent grant is a privilege escalation (like initial pairing) — a stolen web session
  //   must NOT widen an agent from read_public to a long-term bundle. So a LIVE Passkey bound to this request_id
  //   is required. Grant-active is checked BEFORE claiming the request, and the expand is guarded + reversible,
  //   so a mid-flight expire/revoke can never strand a phantom 'approved'.
  // POST approve — human-authed + live Passkey; expands the bound grant (union scopes + bundle + extend expiry). Audited.
  app.post('/api/agent-grants/permission-requests/:id/approve', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const now = new Date().toISOString()
    const r = await dbOne<{ human_id: string; grant_id: string; requested_scopes: string; permission_bundle: string | null; duration: string; status: string; expires_at: string }>(
      'SELECT human_id, grant_id, requested_scopes, permission_bundle, duration, status, expires_at FROM agent_permission_requests WHERE id = ?', [req.params.id])
    if (!r) return void res.status(404).json({ error: 'permission_request_not_found' })
    if (r.human_id !== user.id) return void res.status(403).json({ error: 'not your permission request' })
    if (r.status !== 'pending' || r.expires_at <= now) return void res.status(409).json({ error: 'permission_request_not_pending', status: r.status })
    // Live Passkey, bound to THIS request (a token minted for request A can't approve B).
    const hp = requireHumanPresence(user.id as string, 'agent_permission_approve', (req.body || {}).webauthn_token as string | undefined, 'require_human_presence_for_agent_permission_approve',
      (data) => { try { return typeof data === 'object' && data !== null && (data as Record<string, unknown>).request_id === req.params.id } catch { return false } })
    if (!hp.ok) return void res.status(412).json({ error: hp.reason, error_code: hp.error_code })
    const reqScopes = scopeNames(r.requested_scopes)
    // Defense in depth: re-validate safe-only + duration allowed at approval time.
    if (!validateRequestedCapabilities(reqScopes.map(s => ({ capability: s }))).ok) return void res.status(403).json({ error: 'permission_not_grantable', error_code: 'PERMISSION_NOT_GRANTABLE' })
    if (!durationAllowedForScopes(reqScopes, r.duration)) return void res.status(403).json({ error: 'duration_not_allowed_for_risk', error_code: 'DURATION_NOT_ALLOWED' })
    // (P2) Verify the grant is ACTIVE *before* claiming the request — never leave a phantom 'approved'.
    const grant = await dbOne<{ grant_id: string; capabilities: string; status: string; expires_at: string; revoked_at: string | null }>(
      'SELECT grant_id, capabilities, status, expires_at, revoked_at FROM agent_delegation_grants WHERE grant_id = ?', [r.grant_id])
    if (!grant || !grantIsActive(grant, now)) return void res.status(409).json({ error: 'grant_inactive', error_code: 'GRANT_INACTIVE', note: 'the agent grant expired or was revoked; re-pair (this request stays pending)' })
    // Union new scopes into the grant; set bundle; extend expiry (never shorten). 'once' → short 1h window.
    const union = [...new Set([...scopeNames(grant.capabilities), ...reqScopes])].map(s => ({ capability: s, constraints: {} }))
    const secs = durationToSeconds(r.duration as GrantDuration) || 3600
    const newExpiry = new Date(Date.now() + secs * 1000).toISOString()
    const expiresAt = newExpiry > grant.expires_at ? newExpiry : grant.expires_at
    // ATOMIC (RFC-020 invariant: a grant expansion is audited-or-it-does-not-happen; parity with arbitrator
    //   approve). CAS-claim the request + guarded-expand the grant + write the audit row in ONE sync
    //   db.transaction. If the audit INSERT throws, OR the grant was revoked in the race window (guarded
    //   WHERE → 0 rows → GrantInactiveError), the WHOLE tx rolls back: scopes unchanged, request stays pending.
    let outcome: 'expanded' | 'not_pending'
    try {
      outcome = db.transaction((): 'expanded' | 'not_pending' => {
        const claimed = db.prepare("UPDATE agent_permission_requests SET status='approved', approved_at=? WHERE id=? AND status='pending'").run(now, req.params.id)
        if (claimed.changes !== 1) return 'not_pending'
        const expanded = db.prepare("UPDATE agent_delegation_grants SET capabilities=?, permission_bundle=COALESCE(?, permission_bundle), expires_at=? WHERE grant_id=? AND status='active' AND revoked_at IS NULL").run(JSON.stringify(union), r.permission_bundle, expiresAt, grant.grant_id)
        if (expanded.changes !== 1) throw new GrantInactiveError()
        db.prepare('INSERT INTO agent_grant_auth_log (grant_id, human_id, capability, outcome, error_code) VALUES (?,?,?,?,?)').run(grant.grant_id, user.id as string, `permission_request:approve:${r.permission_bundle || reqScopes.join(',')}`, 'allow', null)
        return 'expanded'
      })()
    } catch (e) {
      if (e instanceof GrantInactiveError) return void res.status(409).json({ error: 'grant_inactive', error_code: 'GRANT_INACTIVE', note: 'the agent grant was revoked while approving; request stays pending' })
      console.error('[agent-grant] approve tx failed (audit unavailable?):', (e as Error).message)
      return void res.status(503).json({ error: 'authorization audit unavailable; refusing to expand unaudited', error_code: 'GRANT_AUDIT_FAILED' })
    }
    if (outcome === 'not_pending') return void res.status(409).json({ error: 'permission_request_not_pending' })
    res.json({ success: true, grant_id: grant.grant_id, scopes: union.map(u => u.capability), permission_bundle: r.permission_bundle, expires_at: expiresAt })
  })

  // POST reject — human-authed. Terminal 'rejected'; nothing is granted.
  app.post('/api/agent-grants/permission-requests/:id/reject', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const r = await dbOne<{ human_id: string; status: string }>('SELECT human_id, status FROM agent_permission_requests WHERE id = ?', [req.params.id])
    if (!r) return void res.status(404).json({ error: 'permission_request_not_found' })
    if (r.human_id !== user.id) return void res.status(403).json({ error: 'not your permission request' })
    if (r.status !== 'pending') return void res.status(409).json({ error: 'permission_request_not_pending', status: r.status })
    const rj = await dbRun("UPDATE agent_permission_requests SET status='rejected' WHERE id=? AND status='pending'", [req.params.id])
    if (!rj || rj.changes !== 1) return void res.status(409).json({ error: 'permission_request_not_pending' })
    res.json({ success: true, status: 'rejected' })
  })

  // ─────────────────────────── RFC-020 PR-C1: pairing (device-flow + PKCE) ───────────────────────────
  // C1 = pairing + credential delivery ONLY. No grant is consumed by any tool here (that is PR-C2).

  // (pair 1) Agent starts a pairing — UNAUTHENTICATED (agent has no credential yet). Safe scopes only.
  app.post('/api/agent-grants/pair/start', async (req, res) => {
    // Rate-limit the anonymous write FIRST (anti-bloat: no DB row unless under the cap).
    if (!rateLimitOk(`agent_pair_start:${req.ip || 'anon'}`, 10, 60_000)) {
      return void res.status(429).json({ error: 'too_many_pairing_starts', retry_after_s: 60 })
    }
    const body = (req.body || {}) as Record<string, unknown>
    const codeChallenge = typeof body.code_challenge === 'string' ? body.code_challenge : ''
    if (!codeChallenge || codeChallenge.length < 32 || codeChallenge.length > 256) return void res.status(400).json({ error: 'code_challenge required (PKCE S256)' })
    const caps = Array.isArray(body.capabilities) ? body.capabilities as Array<{ capability: string; constraints?: Record<string, unknown> }> : []
    if (caps.length > MAX_CAPABILITIES) return void res.status(400).json({ error: 'too_many_capabilities', max: MAX_CAPABILITIES })
    const v = validateRequestedCapabilities(caps)
    if (!v.ok) return void res.status(403).json({ error: 'pairing_rejected', rejected: v.rejected })  // risk + never-delegable hard-reject

    const pairingId = generateId('par')
    const userCode = generateUserCode()
    const ttl = clampPairingTtlSeconds(body.ttl_seconds)
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString()
    const label = typeof body.agent_label === 'string' ? body.agent_label.slice(0, 120) : null
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 280) : null               // agent free text only
    const pubkey = typeof body.agent_pubkey === 'string' ? body.agent_pubkey.slice(0, 1000) : null  // RESERVED (PoP), not verified in C1
    const capsJson = JSON.stringify(v.safe.map(c => ({ capability: c, constraints: (caps.find(x => x?.capability === c)?.constraints) || {} })))
    if (capsJson.length > MAX_CONSTRAINTS_JSON) return void res.status(400).json({ error: 'capabilities_too_large', max_bytes: MAX_CONSTRAINTS_JSON })

    await dbRun(
      'INSERT INTO agent_pairing_sessions (pairing_id, user_code, code_challenge, agent_label, agent_pubkey, reason, capabilities, status, expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [pairingId, userCode, codeChallenge, label, pubkey, reason, capsJson, 'pending', expiresAt],
    )
    res.status(201).json({
      pairing_id: pairingId,
      user_code: userCode,
      approve_url: `/#pair?code=${userCode}`,
      expires_at: expiresAt,
      note: 'Ask the human to open approve_url at webaz.xyz (logged in) and approve. Then retrieve the credential with the PKCE verifier.',
    })
  })

  // (pair 2) Human reviews the server-generated consent — human-authenticated.
  app.get('/api/agent-grants/pair/:user_code', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const p = await dbOne<Record<string, unknown>>('SELECT * FROM agent_pairing_sessions WHERE user_code = ?', [req.params.user_code])
    if (!p) return void res.status(404).json({ error: 'pairing_not_found' })
    if (!pairingApprovable(p, new Date().toISOString())) return void res.status(409).json({ error: 'pairing_not_pending_or_expired', status: p.status })
    res.json({ consent: consentView(p) })
  })

  // (pair 3) Human approves — human-authenticated. Issues the grant (token_hash filled at retrieve).
  app.post('/api/agent-grants/pair/:user_code/approve', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const now = new Date().toISOString()
    const p = await dbOne<Record<string, unknown>>('SELECT * FROM agent_pairing_sessions WHERE user_code = ?', [req.params.user_code])
    if (!p) return void res.status(404).json({ error: 'pairing_not_found' })
    if (!pairingApprovable(p, now)) return void res.status(409).json({ error: 'pairing_not_pending_or_expired', status: p.status })

    // 人工在场 gate:批准 = 真人 Passkey/WebAuthn 确认(默认必需,param 可关)。挡"账号被静默批准"。
    //   注:这挡的是"是不是真人在批",不挡 illicit-consent(人被骗批错 agent)—— 那由前端强制口令核对 + safe-scope 兜底。
    //   token 必须【绑定这个配对码】(purpose_data.user_code === :user_code)—— 防"为批 A 拿到的 token 被首次提交去批 B"(与 delete_passkey 绑 credential_id 同法)。
    const hp = requireHumanPresence(user.id as string, 'agent_pair_approve', (req.body || {}).webauthn_token as string | undefined, 'require_human_presence_for_agent_pair_approve',
      (data) => { try { return typeof data === 'object' && data !== null && (data as Record<string, unknown>).user_code === req.params.user_code } catch { return false } })
    if (!hp.ok) return void res.status(412).json({ error: hp.reason, error_code: hp.error_code })

    // Re-validate scopes at approval time (defense in depth) — must still be safe-only.
    const caps = safeParseCaps(p.capabilities) as Array<{ capability: string; constraints?: Record<string, unknown> }>
    const v = validateRequestedCapabilities(caps)
    if (!v.ok) return void res.status(403).json({ error: 'pairing_rejected', rejected: v.rejected })

    const grantId = generateId('grt')
    const expiresAt = new Date(Date.now() + clampTtlSeconds(undefined) * 1000).toISOString()
    // 先【CAS 抢占】pending 配对(唯一赢家),再插 grant —— 竞态下输家 changes!==1 直接 409、不插任何 grant,
    //   杜绝"插了 grant 但配对更新失败"留下 token_hash NULL 的 orphan grant(污染连接记录)。
    const claimed = await dbRun(
      "UPDATE agent_pairing_sessions SET status='approved', human_id=?, grant_id=?, approved_at=? WHERE user_code=? AND status='pending'",
      [user.id, grantId, now, req.params.user_code],
    )
    if (!claimed || claimed.changes !== 1) return void res.status(409).json({ error: 'pairing_not_pending_or_expired' })
    // Grant created WITHOUT a token (token_hash NULL) — the bearer is minted only at retrieval.
    await dbRun(
      'INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, human_confirm_required, status, expires_at) VALUES (?,?,?,?,?,?,?,?)',
      [grantId, user.id, p.agent_label || null, JSON.stringify(caps), null, 0, 'active', expiresAt],
    )
    res.json({ success: true, grant_id: grantId, capabilities: caps })
  })

  // (pair 3b) Human rejects — human-authenticated. Terminal 'rejected' → agent's retrieve fails clearly (no silent lingering).
  //   拒绝是保护性动作,无需 Passkey(不签发任何凭证)。幂等:仅 pending 可拒。
  app.post('/api/agent-grants/pair/:user_code/reject', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const p = await dbOne<{ status: string }>('SELECT status FROM agent_pairing_sessions WHERE user_code = ?', [req.params.user_code])
    if (!p) return void res.status(404).json({ error: 'pairing_not_found' })
    if (p.status !== 'pending') return void res.status(409).json({ error: 'pairing_not_pending', status: p.status })
    const r = await dbRun("UPDATE agent_pairing_sessions SET status='rejected', human_id=? WHERE user_code=? AND status='pending'", [user.id, req.params.user_code])
    if (!r || r.changes !== 1) return void res.status(409).json({ error: 'pairing_not_pending' })
    res.json({ success: true, status: 'rejected' })
  })

  // (pair 4) Agent retrieves the credential ONCE via PKCE verifier — UNAUTHENTICATED (PKCE-gated).
  app.post('/api/agent-grants/pair/:pairing_id/retrieve', async (req, res) => {
    const now = new Date().toISOString()
    const verifier = typeof req.body?.code_verifier === 'string' ? req.body.code_verifier : ''
    const p = await dbOne<Record<string, unknown>>('SELECT * FROM agent_pairing_sessions WHERE pairing_id = ?', [req.params.pairing_id])
    if (!p) return void res.status(404).json({ error: 'pairing_not_found' })
    if (p.status === 'consumed' || p.consumed_at) return void res.status(409).json({ error: 'pairing_already_consumed' })
    if (!pairingRetrievable(p, now)) return void res.status(409).json({ error: 'pairing_not_approved_or_expired', status: p.status })
    if (!verifyPkceS256(verifier, String(p.code_challenge))) return void res.status(403).json({ error: 'pkce_mismatch' })

    // Confirm the issued grant is still active (could have been revoked between approve and retrieve).
    const grant = await dbOne<{ grant_id: string; status: string; capabilities: string; expires_at: string }>(
      'SELECT grant_id, status, capabilities, expires_at FROM agent_delegation_grants WHERE grant_id = ?', [String(p.grant_id)])
    if (!grant || grant.status !== 'active') return void res.status(409).json({ error: 'grant_inactive' })

    // Mint the bearer ONCE here; persist only its SHA-256 hash. Raw bearer is returned a single time.
    const token = `gtk_${randomBytes(32).toString('hex')}`
    const tokenHash = createHash('sha256').update(token).digest('hex')
    // One-time consume: only succeeds if still approved+unconsumed (guards against retrieval races/reuse).
    const consumed = await dbRun(
      "UPDATE agent_pairing_sessions SET status='consumed', consumed_at=? WHERE pairing_id=? AND status='approved' AND consumed_at IS NULL",
      [now, req.params.pairing_id],
    )
    if (!consumed || consumed.changes !== 1) return void res.status(409).json({ error: 'pairing_already_consumed' })
    await dbRun('UPDATE agent_delegation_grants SET token_hash=? WHERE grant_id=?', [tokenHash, grant.grant_id])

    res.json({
      grant_id: grant.grant_id,
      token,                                    // shown ONCE — agent stores it locally; server keeps only the hash
      token_note: 'Shown once. Store in your OS secret store; the server keeps only a hash and cannot reissue it.',
      capabilities: safeParseCaps(grant.capabilities),
      expires_at: grant.expires_at,
    })
  })

  // ── Direct grant issuance is DISABLED — single blessed path is the Passkey pairing flow. ──
  //   旧的"仅登录即直接 mint 原文 bearer"入口会旁路 #pair 的真人 Passkey 批准,削弱"human Passkey-approves
  //   agent delegation"的安全叙事。零消费方(前端/MCP/测试均不用),故降级为不可用,统一走 pairing。
  app.post('/api/agent-grants', (req, res) => {
    const user = auth(req, res); if (!user) return
    return void res.status(410).json({
      error: 'USE_PAIRING_FLOW', error_code: 'USE_PAIRING_FLOW',
      note: 'Direct grant issuance is disabled. Start pairing with webaz_pair (action=start); the human approves at /#pair with a Passkey, then the agent retrieves the credential with its PKCE verifier. No endpoint mints a bearer without a live Passkey ceremony bound to the pairing.',
    })
  })

  // ── Read: the human's connected agents (no secrets) + recent-use from the audit log (PR-D). ──
  // last_used_at / use_count come from agent_grant_auth_log (RFC-020 §3.7) — the data the
  // "Connected agents" UI shows so a human can spot stale/unused or busy agents before revoking.
  app.get('/api/agent-grants', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll<Record<string, unknown>>(
      `SELECT g.grant_id, g.agent_label, g.capabilities, g.status, g.created_at, g.expires_at, g.revoked_at, g.revoked_reason,
              MAX(CASE WHEN l.outcome = 'allow' THEN l.ts END) AS last_used_at,
              COUNT(CASE WHEN l.outcome = 'allow' THEN 1 END) AS use_count
         FROM agent_delegation_grants g
         LEFT JOIN agent_grant_auth_log l ON l.grant_id = g.grant_id
        WHERE g.human_id = ?
        GROUP BY g.grant_id
        ORDER BY g.created_at DESC`,
      [user.id],
    )
    const now = new Date().toISOString()
    res.json({
      grants: rows.map(g => ({
        ...g,
        capabilities: safeParseCaps(g.capabilities),
        use_count: Number(g.use_count) || 0,
        active: grantIsActive(g as { status?: string; expires_at?: string; revoked_at?: string | null }, now),
      })),
    })
  })

  // ── Revoke (online, one-click). ──
  app.post('/api/agent-grants/:grant_id/revoke', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const grantId = req.params.grant_id
    const g = await dbOne<{ grant_id: string; status: string }>(
      'SELECT grant_id, status FROM agent_delegation_grants WHERE grant_id = ? AND human_id = ?',
      [grantId, user.id],
    )
    if (!g) return void res.status(404).json({ error: 'grant_not_found' })
    if (g.status === 'revoked') return void res.json({ success: true, already_revoked: true, grant_id: grantId })
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : null
    await dbRun(
      "UPDATE agent_delegation_grants SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE grant_id = ? AND human_id = ?",
      [new Date().toISOString(), reason, grantId, user.id],
    )
    res.json({ success: true, grant_id: grantId })
  })
}
