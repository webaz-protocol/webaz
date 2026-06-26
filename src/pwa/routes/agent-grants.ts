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
import { initAgentDelegationGrantsSchema } from '../../runtime/webaz-schema-helpers.js'
import { validateRequestedCapabilities, clampTtlSeconds, grantIsActive } from '../../runtime/agent-grant-scopes.js'

export interface AgentGrantsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
}

function safeParseCaps(json: unknown): unknown {
  try { return JSON.parse(String(json)) } catch { return [] }
}

export function registerAgentGrantsRoutes(app: Application, deps: AgentGrantsDeps): void {
  const { db, auth, generateId } = deps
  // PWA runtime self-init (MCP gets the table via applyWebazRuntimeSchema). Idempotent.
  initAgentDelegationGrantsSchema(db)

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
