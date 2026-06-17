#!/usr/bin/env tsx
/**
 * PR-5B — RFC-006 build-reputation self-view aligned with the PR-5A uncommitted-value boundary.
 *   用法:npm run test:build-reputation-boundary
 *
 * Verifies: GET /api/build-reputation/me carries value_boundary (value_state='uncommitted',
 * valuation/redemption 'not_defined', economic_rights=false); the response (recursively) has NO
 * economic-promise field key — in particular the legacy `reward_anchored` is gone, replaced by
 * `passkey_anchor_present` (true iff a Passkey/webauthn credential exists); build_points/tier express
 * BUILD reputation (coordination layer) only — the pool note states it never gates verifier/arbitrator;
 * self-only (auth required; no account param honored). No DB write, no schema change, build_points
 * formula untouched.
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Request, Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { initBuildReputationSchema, getBuildProfile } from '../src/layer2-business/L2-9-contribution/build-reputation-engine.js'
import { registerBuildReputationRoutes } from '../src/pwa/routes/build-reputation.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const HERE = dirname(fileURLToPath(import.meta.url))
const ALICE = 'usr_alice', BOB = 'usr_bob'

// economic-PROMISE field keys a pre-redemption contribution display must NEVER carry (RFC-017 I-12 / §7).
const FORBIDDEN_VALUE_KEY = /amount|currency|yield|payout|reward|\bprice\b|promise/i
function collectKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) { for (const x of v) collectKeys(x, out) }
  else if (v && typeof v === 'object') { for (const k of Object.keys(v)) { out.push(k); collectKeys((v as any)[k], out) } }
  return out
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any
function freshDb(): void {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  // minimal tables getBuildProfile reads (only the queried columns)
  db.exec(`CREATE TABLE build_tasks (id TEXT PRIMARY KEY, claimer_id TEXT, created_by TEXT, status TEXT, claimer_provenance TEXT)`)
  db.exec(`CREATE TABLE build_feedback (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, credited_points INTEGER DEFAULT 0)`)
  db.exec(`CREATE TABLE agent_strikes (id TEXT PRIMARY KEY, user_id TEXT, severity TEXT, reason_code TEXT, reason_detail TEXT, issued_at TEXT, expires_at TEXT, appeal_status TEXT)`)
  db.exec(`CREATE TABLE webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)`)
  initBuildReputationSchema(db)
  setSeamDb(db)
}

let server: Server, port = 0
function get(path: string, userId?: string): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (userId) headers['x-test-user'] = userId
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j, raw }) })
    })
    req.on('error', reject); req.end()
  })
}

async function main(): Promise<void> {
  freshDb()
  // alice: a Passkey anchor + some build state; bob: no anchor.
  db.prepare(`INSERT INTO webauthn_credentials (id,user_id) VALUES ('wac_a', ?)`).run(ALICE)
  db.prepare(`INSERT INTO build_reputation (user_id, build_points) VALUES (?, 60)`).run(ALICE)
  db.prepare(`INSERT INTO build_reputation_events (id,user_id,source,points,ref_id) VALUES ('brev_1', ?, 'task_done', 12, 'task_1')`).run(ALICE)
  db.prepare(`INSERT INTO build_tasks (id,claimer_id,created_by,status,claimer_provenance) VALUES ('task_1', ?, ?, 'done', 'human')`).run(ALICE, ALICE)

  // ── engine-level: field renamed, no legacy reward_anchored ──
  const prof = await getBuildProfile(db, ALICE)
  ok('engine: passkey_anchor_present present + true', prof.passkey_anchor_present === true, JSON.stringify(prof.passkey_anchor_present))
  ok('engine: legacy reward_anchored removed', !('reward_anchored' in prof))
  ok('engine: build_points reflected', prof.build_points === 60)
  ok('engine: tier is a build tier', !!(prof.tier as any)?.key)
  const profBob = await getBuildProfile(db, BOB)
  ok('engine: bob has no anchor → passkey_anchor_present false', profBob.passkey_anchor_present === false)

  // ── route-level ──
  const app = express()
  app.use(express.json())
  registerBuildReputationRoutes(app, {
    db,
    auth: (req: Request, res: Response) => { const u = (req.headers['x-test-user'] as string) || ''; if (!u) { res.status(401).json({ error: 'unauth' }); return null } return { id: u } },
  })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, () => { port = (server.address() as any).port; r() }))

  const ME = '/api/build-reputation/me'

  { const r = await get(ME)
    ok('route: no auth → 401', r.status === 401, r.raw) }

  { const r = await get(ME, ALICE)
    ok('route: 200', r.status === 200, r.raw)
    ok('route: value_boundary.value_state = uncommitted', r.json.value_boundary?.value_state === 'uncommitted', r.raw)
    ok('route: valuation/redemption not_defined + economic_rights false',
      r.json.value_boundary?.valuation_state === 'not_defined' && r.json.value_boundary?.redemption_state === 'not_defined' && r.json.value_boundary?.economic_rights === false)
    ok('route: passkey_anchor_present true (alice has Passkey)', r.json.passkey_anchor_present === true)
    ok('route: NO legacy reward_anchored key', !('reward_anchored' in r.json) && !r.raw.includes('reward_anchored'))
    ok('route: NO economic-promise field key anywhere', !collectKeys(r.json).some(k => FORBIDDEN_VALUE_KEY.test(k)), JSON.stringify(collectKeys(r.json).filter(k => FORBIDDEN_VALUE_KEY.test(k))))
    ok('route: build_points/tier express BUILD reputation only', typeof r.json.build_points === 'number' && !!r.json.tier?.key)
    ok('route: pool note = separate from trade reputation (no verifier/arbitrator gating)', typeof r.json.pool === 'string' && /separate|never gates/i.test(r.json.pool))
    ok('route: response is the caller\'s own (user_id = session)', r.json.user_id === ALICE) }

  // bob (no Passkey) → boundary still present, anchor false
  { const r = await get(ME, BOB)
    ok('route: bob 200 + boundary present', r.status === 200 && r.json.value_boundary?.value_state === 'uncommitted', r.raw)
    ok('route: bob passkey_anchor_present false', r.json.passkey_anchor_present === false)
    ok('route: bob response = own user_id', r.json.user_id === BOB) }

  await new Promise<void>(r => server.close(() => r()))

  // ── source guard: route read-only; build_points formula untouched ──
  { const routeSrc = readFileSync(join(HERE, '..', 'src', 'pwa', 'routes', 'build-reputation.ts'), 'utf8')
    ok('source: route does no DB write', !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(routeSrc))
    ok('source: route wraps with withUncommittedValueBoundary', /withUncommittedValueBoundary\s*\(/.test(routeSrc))
    const engSrc = readFileSync(join(HERE, '..', 'src', 'layer2-business', 'L2-9-contribution', 'build-reputation-engine.ts'), 'utf8')
    ok('source: BUILD_POINTS formula unchanged (feedback_accepted:8, task_done:12)', /feedback_accepted:\s*8/.test(engSrc) && /task_done:\s*12/.test(engSrc))
    ok('source: engine returns passkey_anchor_present (not reward_anchored as a field)', /passkey_anchor_present:\s*hasAnchor/.test(engSrc) && !/\breward_anchored:/.test(engSrc)) }

  console.log('\ntest:build-reputation-boundary')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ build-reputation self-view under PR-5A boundary: value_boundary present + no economic-promise key + reward_anchored→passkey_anchor_present + build-only pool + self-only + read-only + formula untouched\n')
}

main().catch(e => { console.error(e); process.exit(1) })
