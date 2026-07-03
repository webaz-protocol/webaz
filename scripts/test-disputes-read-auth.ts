#!/usr/bin/env tsx
/**
 * PR-E dispute 读接口权限门:GET /api/disputes/:id 与 /:id/parties 只允许
 *   涉案方(buyer/seller/logistics/initiator/defendant)或 active whitelist 仲裁员。
 *   不再用 role === 'arbitrator';非涉案普通登录用户 / suspended / revoked / role-only 一律 403。
 * Usage: npm run test:disputes-read-auth
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'disp-read-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { initSystemUser } = await import('../src/layer0-foundation/L0-2-state-machine/engine.js')
const { initArbitratorReviewSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const D = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { isEligibleArbitrator, grantArbitrator, suspendArbitrator, revokeArbitrator } = await import('../src/pwa/arbitrator-lifecycle.js')
const { registerDisputesReadRoutes } = await import('../src/pwa/routes/disputes-read.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initSystemUser(db); initArbitratorReviewSchema(db); initWebauthnSchema(db); D.initDisputeSchema(db)
const mkUser = (id: string, role = 'buyer', pk = false): void => {
  db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(id, id, role, 'k_' + id)
  if (pk) db.prepare('INSERT INTO webauthn_credentials (id,user_id,public_key,counter) VALUES (?,?,?,0)').run('c_' + id, id, Buffer.from([1]))
}
mkUser('buyer1'); mkUser('seller1', 'seller'); mkUser('arb', 'buyer', true); mkUser('susp', 'buyer', true); mkUser('rev', 'buyer', true); mkUser('roleArb', 'arbitrator'); mkUser('outsider')
grantArbitrator(db, { userId: 'arb', grantedBy: 'a1' })
grantArbitrator(db, { userId: 'susp', grantedBy: 'a1' }); suspendArbitrator(db, { userId: 'susp' })
grantArbitrator(db, { userId: 'rev', grantedBy: 'a1' }); revokeArbitrator(db, { userId: 'rev' })
db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail) VALUES ('o1','p','buyer1','seller1',1,50,50,0,'disputed','direct_p2p')").run()
const disp = D.createDispute(db, 'o1', 'buyer1', 'r', [])
const disputeId = disp.disputeId as string

const app = express(); app.use(express.json())
registerDisputesReadRoutes(app, {
  db,
  auth: (req: Request, res: Response) => { const uid = req.headers['x-test-uid'] as string | undefined; if (!uid) { res.status(401).json({ error: 'login' }); return null } return { id: uid, role: 'buyer' } },
  errorRes: (res: Response, s: number, c: string, m: string) => { res.status(s).json({ error: m, error_code: c }) },
  getOpenDisputes: () => [], getDisputeDetails: D.getDisputeDetails, getEvidenceRequests: () => [],
  listEvidenceFiles: async () => [], isEligibleArbitrator: (uid: string) => isEligibleArbitrator(db, uid),
} as any)
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })
const get = (path: string, uid?: string): Promise<{ status: number }> => new Promise((resolve, reject) => {
  const headers: Record<string, string> = {}; if (uid) headers['x-test-uid'] = uid
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers }, res => { res.on('data', () => {}); res.on('end', () => resolve({ status: res.statusCode || 0 })) })
  rq.on('error', reject); rq.end()
})

try {
  const parties = `/api/disputes/${disputeId}/parties`
  const details = `/api/disputes/${disputeId}`
  // parties (light route, full matrix)
  ok('parties: party (buyer) → 200', (await get(parties, 'buyer1')).status === 200)
  ok('parties: party (seller) → 200', (await get(parties, 'seller1')).status === 200)
  ok('parties: active whitelist arbitrator → 200', (await get(parties, 'arb')).status === 200)
  ok('parties: non-party ordinary user → 403 (was any-logged-in leak)', (await get(parties, 'outsider')).status === 403)
  ok('parties: suspended arbitrator → 403', (await get(parties, 'susp')).status === 403)
  ok('parties: revoked arbitrator → 403', (await get(parties, 'rev')).status === 403)
  ok('parties: role-only (no whitelist) → 403', (await get(parties, 'roleArb')).status === 403)
  // details (gate is early-return; assert 403 for the denied set, and party/arb get PAST the gate ≠ 403)
  ok('details: non-party ordinary user → 403', (await get(details, 'outsider')).status === 403)
  ok('details: suspended arbitrator → 403', (await get(details, 'susp')).status === 403)
  ok('details: revoked arbitrator → 403', (await get(details, 'rev')).status === 403)
  ok('details: role-only → 403 (role bypass removed)', (await get(details, 'roleArb')).status === 403)
  // details positive (party / active arbitrator authorized) is covered by the identical gate on /parties above.
  // similar-cases (same gate; test the denied set which early-returns 403)
  const similar = `/api/disputes/${disputeId}/similar-cases`
  ok('similar-cases: non-party → 403', (await get(similar, 'outsider')).status === 403)
  ok('similar-cases: suspended → 403', (await get(similar, 'susp')).status === 403)
  ok('similar-cases: role-only → 403 (role bypass removed)', (await get(similar, 'roleArb')).status === 403)

  server!.close()
  if (fail > 0) { console.error(`\n❌ disputes-read-auth FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ disputes-read-auth: details + parties gated to party OR active whitelist arbitrator; non-party/suspended/revoked/role-only all 403\n  ✅ pass ${pass}`)
} catch (e) { console.error(e); server!.close(); process.exit(1) }
