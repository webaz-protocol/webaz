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
import { initAgentDelegationGrantsSchema, initAgentPairingSchema } from '../../runtime/webaz-schema-helpers.js'
import { validateRequestedCapabilities, clampTtlSeconds, grantIsActive } from '../../runtime/agent-grant-scopes.js'
import { generateUserCode, verifyPkceS256, clampPairingTtlSeconds, pairingApprovable, pairingRetrievable } from '../../runtime/agent-pairing.js'

export interface AgentGrantsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
}

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
  const { db, auth, generateId } = deps
  // PWA runtime self-init (MCP gets the tables via applyWebazRuntimeSchema). Idempotent.
  initAgentDelegationGrantsSchema(db)
  initAgentPairingSchema(db)

  // ─────────────────────────── RFC-020 PR-C1: pairing (device-flow + PKCE) ───────────────────────────
  // C1 = pairing + credential delivery ONLY. No grant is consumed by any tool here (that is PR-C2).

  // (pair 1) Agent starts a pairing — UNAUTHENTICATED (agent has no credential yet). Safe scopes only.
  app.post('/api/agent-grants/pair/start', async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>
    const codeChallenge = typeof body.code_challenge === 'string' ? body.code_challenge : ''
    if (!codeChallenge || codeChallenge.length < 32) return void res.status(400).json({ error: 'code_challenge required (PKCE S256)' })
    const caps = Array.isArray(body.capabilities) ? body.capabilities as Array<{ capability: string; constraints?: Record<string, unknown> }> : []
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

    // Re-validate scopes at approval time (defense in depth) — must still be safe-only.
    const caps = safeParseCaps(p.capabilities) as Array<{ capability: string; constraints?: Record<string, unknown> }>
    const v = validateRequestedCapabilities(caps)
    if (!v.ok) return void res.status(403).json({ error: 'pairing_rejected', rejected: v.rejected })

    const grantId = generateId('grt')
    const expiresAt = new Date(Date.now() + clampTtlSeconds(undefined) * 1000).toISOString()
    // Grant created WITHOUT a token (token_hash NULL) — the bearer is minted only at retrieval.
    await dbRun(
      'INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, human_confirm_required, status, expires_at) VALUES (?,?,?,?,?,?,?,?)',
      [grantId, user.id, p.agent_label || null, JSON.stringify(caps), null, 0, 'active', expiresAt],
    )
    await dbRun(
      "UPDATE agent_pairing_sessions SET status='approved', human_id=?, grant_id=?, approved_at=? WHERE user_code=? AND status='pending'",
      [user.id, grantId, now, req.params.user_code],
    )
    res.json({ success: true, grant_id: grantId, capabilities: caps })
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

  // ── Issue a grant (human-authenticated). Safe scopes only; risk/never-delegable rejected. ──
  app.post('/api/agent-grants', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const body = (req.body || {}) as Record<string, unknown>
    const caps = Array.isArray(body.capabilities) ? body.capabilities as Array<{ capability: string; constraints?: Record<string, unknown> }> : []

    const v = validateRequestedCapabilities(caps)
    if (!v.ok) {
      // Fail-closed: any risk / never-delegable / unknown scope rejects the whole request.
      return void res.status(403).json({ error: 'grant_rejected', rejected: v.rejected })
    }

    const ttl = clampTtlSeconds(body.ttl_seconds)
    const grantId = generateId('grt')
    const token = `gtk_${randomBytes(32).toString('hex')}`           // bearer — shown once
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString()
    const label = typeof body.agent_label === 'string' ? body.agent_label.slice(0, 120) : null
    const capsJson = JSON.stringify(v.safe.map(c => ({
      capability: c,
      constraints: (caps.find(x => x?.capability === c)?.constraints) || {},
    })))

    await dbRun(
      'INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, human_confirm_required, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [grantId, user.id, label, capsJson, tokenHash, 0, 'active', expiresAt],
    )

    res.status(201).json({
      grant_id: grantId,
      token,
      token_note: 'Shown once — store securely. The server keeps only a hash; it cannot show this again.',
      capabilities: JSON.parse(capsJson),
      expires_at: expiresAt,
      note: 'Bearer-first grant for safe scopes only. Risk scopes are not delegable until their route has a live-Passkey gate; PoP binding is required before any risk scope or longer-lived delegation (RFC-020).',
    })
  })

  // ── Read: the human's connected agents (no secrets). ──
  app.get('/api/agent-grants', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll<Record<string, unknown>>(
      'SELECT grant_id, agent_label, capabilities, status, created_at, expires_at, revoked_at, revoked_reason FROM agent_delegation_grants WHERE human_id = ? ORDER BY created_at DESC',
      [user.id],
    )
    const now = new Date().toISOString()
    res.json({
      grants: rows.map(g => ({
        ...g,
        capabilities: safeParseCaps(g.capabilities),
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
