#!/usr/bin/env tsx
/**
 * R0 — Request Readiness Gate. Three-layer guarantee:
 *   ① orchestration guidance via a RESOURCE channel (webaz://guide/request-readiness + GET /api/agent/request-readiness),
 *      budget-free (not in tools/list);
 *   ② server validation: discover zero-signal → 400 EMPTY_INTENT with missing_fields + recommended_question + safe_next_action;
 *   ③ §15 neutrality: the guide teaches WHEN to ask / how to fetch minimally — WebAZ never authors a recommendation.
 * Usage: npm run test:request-readiness-gate
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createHash } from 'node:crypto'
process.env.HOME = mkdtempSync(join(tmpdir(), 'r0-')); process.env.USERPROFILE = process.env.HOME
process.env.WEBAZ_MODE = 'network'; delete process.env.WEBAZ_API_KEY
import express from 'express'; import type { AddressInfo } from 'node:net'

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { REQUEST_READINESS_GUIDE } = await import('../src/pwa/agent-request-readiness.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('buyer1','B','buyer','k_b')").run()
db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES ('grt_disc','buyer1','DA', ?, ?, 'active', ?)")
  .run(JSON.stringify([{ capability: 'buyer_discover' }]), sha('gtk_disc'), new Date(Date.now() + 3600_000).toISOString())
const auth = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'no human' }); return null }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true } as never)
const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const j = async (path: string, opts: { method?: string; body?: unknown; bearer?: string } = {}) => {
  const r = await fetch(base + path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json', ...(opts.bearer ? { authorization: 'Bearer ' + opts.bearer } : {}) }, ...(opts.body != null ? { body: JSON.stringify(opts.body) } : {}) })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}

try {
  // ── ① guidance resource: HTTP fallback channel (no auth), same data as webaz://guide/request-readiness ──
  const g = await j('/api/agent/request-readiness')
  ok('R0-1 GET /api/agent/request-readiness → 200 guidance (no auth channel)', g.status === 200 && g.body.schema_version === 'webaz.request_readiness.v1')
  ok('R0-2 guide has the three readiness tiers (ready/assume/clarify)', !!g.body.readiness_tiers && !!(g.body.readiness_tiers as Record<string, unknown>).ready && !!(g.body.readiness_tiers as Record<string, unknown>).assume && !!(g.body.readiness_tiers as Record<string, unknown>).clarify)
  ok('R0-3 guide has friction_budget + minimal_fetch + server_guards', !!g.body.friction_budget && Array.isArray(g.body.minimal_fetch) && !!g.body.server_guards)

  // ── §15 neutrality: the guide must frame recommendation as the ASSISTANT's, non-authoritative — WebAZ never authors it ──
  const gs = JSON.stringify(REQUEST_READINESS_GUIDE)
  ok('R0-4 §15: recommendation is the assistant\'s, non-authoritative; WebAZ returns facts only (no "best buy" authored)', /FACTS only/.test(gs) && /recommendation is YOURS/.test(gs) && /non-authoritative/.test(gs))
  ok('R0-5 clarify-once discipline present (你帮我决定/随便 → balanced default, do not keep asking)', /balanced default/.test(gs) && /Do NOT keep asking/.test(gs))

  // ── ② server validation: discover zero-signal → 400 EMPTY_INTENT with the machine-executable clarification fields ──
  const empty = await j('/api/agent/discover', { method: 'POST', bearer: 'gtk_disc', body: {} })
  ok('R0-6 discover with no category/keywords → 400 EMPTY_INTENT', empty.status === 400 && empty.body.error_code === 'EMPTY_INTENT')
  ok('R0-7 EMPTY_INTENT carries missing_fields + recommended_question + safe_next_action (structured clarification)',
    Array.isArray(empty.body.missing_fields) && (empty.body.missing_fields as string[]).includes('category') && (empty.body.missing_fields as string[]).includes('keywords')
    && typeof empty.body.recommended_question === 'string' && (empty.body.recommended_question as string).length > 0
    && empty.body.safe_next_action === 'ask_user')
  ok('R0-8 does NOT auto-expand a zero-signal request into a full-catalog browse (no products returned)', !Array.isArray(empty.body.candidates) || (empty.body.candidates as unknown[]).length === 0)

  // ── wiring: resource registered in ListResources + read handler (budget-free channel) ──
  const SERVER = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
  ok('R0-9 webaz://guide/request-readiness registered as an MCP resource + read handler', (SERVER.match(/webaz:\/\/guide\/request-readiness/g) || []).length >= 2)
} finally { server.close(); try { rmSync(process.env.HOME as string, { recursive: true, force: true }) } catch {} }

if (fail > 0) { console.error(`\n❌ request-readiness-gate FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ request-readiness-gate: guidance resource (MCP + HTTP fallback, budget-free) with 3 readiness tiers + friction budget + minimal-fetch + server-guard map; §15 neutral (recommendation is the assistant's, non-authoritative); discover zero-signal → 400 EMPTY_INTENT + missing_fields + recommended_question + safe_next_action (no auto full-catalog browse)\n  ✅ pass ${pass}`)
