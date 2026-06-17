#!/usr/bin/env tsx
/**
 * PR-F4 — GitHub identity-claim READ surface tests (engine + route). Fresh in-memory DB; no network.
 *   用法:npm run test:identity-claim-read
 *
 * Verifies: the surface is scope-anchored on the caller — only MY bindings/facts; another account's
 * private binding is never disclosed; a historical fact of a bound actor surfaces as mine via the
 * overlay (without mutating contribution_facts.accountable_ref); an UNBOUND actor's fact is not shown;
 * a credential for my actor on a fact executed by SOMEONE ELSE is not shown; GET requires auth and
 * ignores any account_id/github_actor_id query/body param (no cross-account); responses leak no other
 * account_id / token / email / nonce / nonce_hash; the route writes no core tables.
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Request, Response } from 'express'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { initGithubCredentialStoreSchema } from '../src/layer2-business/L2-9-contribution/github-credential-store.js'
import { initIdentityBindingSchema } from '../src/layer2-business/L2-9-contribution/identity-binding-store.js'
import { bindGithubIdentity } from '../src/layer2-business/L2-9-contribution/identity-binding-engine.js'
import { getMyGithubIdentitySurface } from '../src/layer2-business/L2-9-contribution/identity-claim-read.js'
import { withUncommittedValueBoundary, UNCOMMITTED_VALUE_BOUNDARY } from '../src/layer2-business/L2-9-contribution/contribution-display-envelope.js'
import { registerContributionIdentityRoutes } from '../src/pwa/routes/contribution-identity.js'

// economic-PROMISE field keys that a pre-redemption display must NEVER carry (RFC-017 I-12 / §7).
const FORBIDDEN_VALUE_KEY = /amount|currency|yield|payout|reward|\bprice\b|promise/i
function collectKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) { for (const x of v) collectKeys(x, out) }
  else if (v && typeof v === 'object') { for (const k of Object.keys(v)) { out.push(k); collectKeys((v as any)[k], out) } }
  return out
}

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

const HERE = dirname(fileURLToPath(import.meta.url))
const ALICE = 'usr_alice', BOB = 'usr_bob'

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any

// seed one credential-backed github fact for `actor` at `sek`; optional executorActor lets the fact's
// executor_ref name a DIFFERENT actor than the credential (to test the executor-match overlay condition).
function seedFact(sek: string, actor: string, factId: string, credId: string, opts: { executorActor?: string; status?: string } = {}): void {
  const executor = `github:${opts.executorActor ?? actor}`
  db.prepare(`INSERT INTO contribution_facts (fact_id,source_event_key,source,type,artifact_ref,occurred_at,executor_ref,accountable_ref,provenance,status) VALUES (?,?,'github','code','m','t',?,NULL,'unknown',?)`)
    .run(factId, sek, executor, opts.status ?? 'active')
  db.prepare(`INSERT INTO github_contribution_credentials (credential_id,core_digest,credential_version,source_event_key,repository_id,pr_node_id,pr_number,merge_commit_sha,merged_at,github_actor_id,lifecycle_event,core_json) VALUES (?,?,'2',?,'R','P',1,'m','t',?,'merged','{}')`)
    .run(credId, `dig_${credId}`, sek, actor)
  db.prepare(`INSERT INTO github_fact_credentials (fact_id,credential_id,source_event_key) VALUES (?,?,?)`).run(factId, credId, sek)
}

function freshDb(): void {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, api_key TEXT UNIQUE NOT NULL)`)
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_alice','Alice','c','ka'),('usr_bob','Bob','c','kb')`).run()
  initGithubCredentialStoreSchema(db)
  initIdentityBindingSchema(db)
  setSeamDb(db)
}

const errorRes = (res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void => {
  res.status(status).json({ error: message, error_code: code, ...(extra || {}) })
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
  // bindings: alice→U_alice, bob→U_bob (both default-private). U_orphan bound to NOBODY.
  await bindGithubIdentity({ githubActorId: 'U_alice', accountId: ALICE, proofMethod: 'github_publication_challenge' })
  await bindGithubIdentity({ githubActorId: 'U_bob', accountId: BOB, proofMethod: 'github_publication_challenge' })
  // facts: alice's, bob's, an orphan actor's (credential-backed but unbound), and a "mismatched executor"
  // fact (credential names U_alice but the fact was executed by U_other → must NOT surface as alice's).
  seedFact('sek:alice:1', 'U_alice', 'cf_alice', 'cr_alice')
  seedFact('sek:bob:1', 'U_bob', 'cf_bob', 'cr_bob')
  seedFact('sek:orphan:1', 'U_orphan', 'cf_orphan', 'cr_orphan')
  seedFact('sek:mismatch:1', 'U_alice', 'cf_mismatch', 'cr_mismatch', { executorActor: 'U_other' })
  // a credential-backed fact for alice's bound actor but status='reverted' — the surface is the ACTIVE
  // attribution view, so it must NOT appear (mirrors the doc + F2/F3b precondition).
  seedFact('sek:reverted:1', 'U_alice', 'cf_reverted', 'cr_reverted', { status: 'reverted' })

  // ── engine-level: overlay correctness ──
  const aliceSurface = await getMyGithubIdentitySurface(ALICE)
  ok('engine: alice has exactly 1 binding (U_alice)', aliceSurface.bindings.length === 1 && aliceSurface.bindings[0].github_actor_id === 'U_alice', JSON.stringify(aliceSurface.bindings))
  ok('engine: binding visibility private (default)', aliceSurface.bindings[0]?.visibility === 'private')
  const aliceFactIds = aliceSurface.attributable_facts.map(f => f.fact_id).sort()
  ok('engine: alice attributable facts = [cf_alice] only', JSON.stringify(aliceFactIds) === JSON.stringify(['cf_alice']), JSON.stringify(aliceFactIds))
  ok('engine: alice does NOT see bob/orphan/mismatch facts', !aliceFactIds.includes('cf_bob') && !aliceFactIds.includes('cf_orphan') && !aliceFactIds.includes('cf_mismatch'))
  ok('engine: reverted fact of a bound actor is EXCLUDED (active-only surface)', !aliceFactIds.includes('cf_reverted'))
  ok('engine: fact carries the bound actor it is attributed THROUGH', aliceSurface.attributable_facts[0]?.github_actor_id === 'U_alice')

  const bobSurface = await getMyGithubIdentitySurface(BOB)
  ok('engine: bob sees only his own binding + fact', bobSurface.bindings.length === 1 && bobSurface.bindings[0].github_actor_id === 'U_bob' && bobSurface.attributable_facts.map(f => f.fact_id).join() === 'cf_bob', JSON.stringify(bobSurface))

  // overlay must NOT have mutated the immutable fact's accountable_ref
  const accCol = db.prepare(`SELECT accountable_ref FROM contribution_facts WHERE fact_id='cf_alice'`).get() as any
  ok('engine: contribution_facts.accountable_ref untouched (still NULL — read-overlay)', accCol.accountable_ref === null)

  // unbound account → empty surface; empty accountId → empty (defensive)
  ok('engine: unrelated account → empty surface', (await getMyGithubIdentitySurface('usr_nobody')).attributable_facts.length === 0)
  ok('engine: empty accountId → empty surface', (await getMyGithubIdentitySurface('')).bindings.length === 0)

  // the surface returns the lifecycle status column (always 'active' here — the query filters to active).
  ok('engine: fact row exposes status = active', aliceSurface.attributable_facts[0]?.status === 'active')

  // ── PR-5A: uncommitted-value boundary helper (unit) ──
  { const wrapped = withUncommittedValueBoundary({ bindings: [], attributable_facts: [] })
    ok('envelope: value_state=uncommitted', wrapped.value_boundary.value_state === 'uncommitted')
    ok('envelope: valuation_state=not_defined', wrapped.value_boundary.valuation_state === 'not_defined')
    ok('envelope: redemption_state=not_defined', wrapped.value_boundary.redemption_state === 'not_defined')
    ok('envelope: economic_rights=false', wrapped.value_boundary.economic_rights === false)
    ok('envelope: preserves the payload', Array.isArray(wrapped.bindings) && Array.isArray(wrapped.attributable_facts))
    ok('envelope: adds NO economic-promise key', !collectKeys(wrapped).some(k => FORBIDDEN_VALUE_KEY.test(k)), JSON.stringify(collectKeys(wrapped)))
    const src = { bindings: [], attributable_facts: [] } as any
    withUncommittedValueBoundary(src)
    ok('envelope: does not mutate input', !('value_boundary' in src))
    ok('envelope: boundary constant is frozen', Object.isFrozen(UNCOMMITTED_VALUE_BOUNDARY)) }

  // ── route-level ──
  const app = express()
  app.use(express.json())
  registerContributionIdentityRoutes(app, {
    auth: (req: Request, res: Response) => { const u = (req.headers['x-test-user'] as string) || ''; if (!u) { res.status(401).json({ error: 'unauth' }); return null } return { id: u } },
    requireHumanPresence: (() => ({ ok: true })) as any,   // not used by the read endpoint
    errorRes,
    getGithubReadToken: () => undefined,                   // not used by the read endpoint
  })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, () => { port = (server.address() as any).port; r() }))

  const ME = '/api/contribution-identity/github/me'

  // no auth → 401
  { const r = await get(ME)
    ok('route: no auth → 401', r.status === 401, r.raw) }

  // alice sees only her own
  { const r = await get(ME, ALICE)
    ok('route: alice 200', r.status === 200, r.raw)
    ok('route: alice bindings = [U_alice]', r.json.bindings.length === 1 && r.json.bindings[0].github_actor_id === 'U_alice')
    ok('route: alice facts = [cf_alice]', r.json.attributable_facts.map((f: any) => f.fact_id).join() === 'cf_alice')
    ok('route: alice response contains NO other account_id (bob)', !r.raw.includes(BOB) && !r.raw.includes('account_id'))
    ok('route: no nonce/nonce_hash/token/email leak', !/nonce|token|email/i.test(r.raw))
    // PR-5A: response carries the uncommitted-value boundary, and NO economic-promise field key.
    ok('route: value_boundary.value_state = uncommitted', r.json.value_boundary?.value_state === 'uncommitted', r.raw)
    ok('route: boundary valuation/redemption not_defined + economic_rights false',
      r.json.value_boundary?.valuation_state === 'not_defined' && r.json.value_boundary?.redemption_state === 'not_defined' && r.json.value_boundary?.economic_rights === false)
    ok('route: NO economic-promise field key (amount/currency/yield/payout/reward/price/promise)',
      !collectKeys(r.json).some(k => FORBIDDEN_VALUE_KEY.test(k)), JSON.stringify(collectKeys(r.json))) }

  // private not exposed to others: bob's /me never shows alice's binding/fact
  { const r = await get(ME, BOB)
    ok('route: bob sees only his own (no alice)', r.json.bindings.every((b: any) => b.github_actor_id === 'U_bob') && r.json.attributable_facts.every((f: any) => f.fact_id === 'cf_bob'))
    ok('route: bob response has no alice fact', !r.raw.includes('cf_alice') && !r.raw.includes('U_alice')) }

  // cannot use account_id / github_actor_id query params to read another account
  { const r = await get(`${ME}?account_id=${BOB}&github_actor_id=U_bob`, ALICE)
    ok('route: query account_id/github_actor_id IGNORED (still alice)', r.status === 200 && r.json.bindings.length === 1 && r.json.bindings[0].github_actor_id === 'U_alice' && r.json.attributable_facts.map((f: any) => f.fact_id).join() === 'cf_alice', r.raw)
    ok('route: injection attempt returns no bob data', !r.raw.includes('cf_bob') && !r.raw.includes('U_bob')) }

  await new Promise<void>(r => server.close(() => r()))

  // ── source guard: route holds no db handle / no core-table writes; engine no reward/KYC import ──
  { const routeSrc = readFileSync(join(HERE, '..', 'src', 'pwa', 'routes', 'contribution-identity.ts'), 'utf8')
    ok('source: route has no db.prepare/db.exec', !/db\.(prepare|exec)\s*\(/.test(routeSrc))
    ok('source: route no write to identity/contribution core tables', !/(INSERT|UPDATE|DELETE|REPLACE)\b[^;]*(identity_binding|contribution_facts|github_fact_credentials|identity_claim_challenges)/i.test(routeSrc))
    ok('source: read endpoint takes no req.query/req.body', !/req\.(query|body)/.test(routeSrc.slice(routeSrc.indexOf("app.get('/api/contribution-identity/github/me'"))))
    const engSrc = readFileSync(join(HERE, '..', 'src', 'layer2-business', 'L2-9-contribution', 'identity-claim-read.ts'), 'utf8')
    ok('source: read engine no reward/kyc/wallet/economic import', !/\bfrom\s+['"][^'"]*(wallet|reward|kyc|economic|payout|valuation)[^'"]*['"]/i.test(engSrc))
    ok('source: read engine never writes (no INSERT/UPDATE/DELETE)', !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(engSrc))
    const envSrc = readFileSync(join(HERE, '..', 'src', 'layer2-business', 'L2-9-contribution', 'contribution-display-envelope.ts'), 'utf8')
    ok('source: envelope no reward/kyc/wallet/economic import', !/\bfrom\s+['"][^'"]*(wallet|reward|kyc|economic|payout|valuation)[^'"]*['"]/i.test(envSrc))
    ok('source: envelope writes/reads no DB (pure display contract)', !/\b(INSERT|UPDATE|DELETE|REPLACE|dbAll|dbOne|dbRun|db\.prepare)\b/i.test(envSrc)) }

  console.log('\ntest:identity-claim-read')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ F4 read surface + 5A boundary: scope-anchored on the caller + credential-backed active overlay + no accountable_ref mutation + auth-gated + param-injection ignored + no other-account/secret leak + uncommitted-value boundary (no economic-promise field)\n')
}

main().catch(e => { console.error(e); process.exit(1) })
