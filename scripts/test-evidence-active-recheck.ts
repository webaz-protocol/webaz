#!/usr/bin/env tsx
/**
 * PR-E fix (P2b):被指派仲裁员读证据必须【仍是 active arbitrator_whitelist】—— suspended/revoked 立即失权。
 *   涉案方(买卖/物流/发起/被诉)始终可读;非参与方拒。直接插 evidence 行(不走 blob),专测授权门。
 * Usage: npm run test:evidence-active-recheck
 */
import { mkdtempSync } from 'fs'; import { join } from 'path'; import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'ev-active-'))
import Database from 'better-sqlite3'
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { listEvidence } = await import('../src/layer3-trust/L3-1-dispute-engine/evidence-storage.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = new Database(':memory:'); setSeamDb(db)
db.exec(`
  CREATE TABLE orders (id TEXT PRIMARY KEY, buyer_id TEXT, seller_id TEXT, logistics_id TEXT);
  CREATE TABLE disputes (id TEXT PRIMARY KEY, order_id TEXT, initiator_id TEXT, defendant_id TEXT, assigned_arbitrators TEXT DEFAULT '[]');
  CREATE TABLE arbitrator_whitelist (user_id TEXT PRIMARY KEY, status TEXT DEFAULT 'active');
  CREATE TABLE evidence (id TEXT PRIMARY KEY, dispute_id TEXT, order_id TEXT, uploader_id TEXT, type TEXT, description TEXT, file_hash TEXT, size INTEGER, mime TEXT, sig TEXT, filename TEXT, created_at TEXT DEFAULT (datetime('now')), withdrawn_at TEXT);
`)
db.prepare("INSERT INTO orders VALUES ('o1','buyer1','seller1',NULL)").run()
db.prepare(`INSERT INTO disputes (id,order_id,initiator_id,defendant_id,assigned_arbitrators) VALUES ('d1','o1','buyer1','seller1','["arbA"]')`).run()
db.prepare("INSERT INTO evidence (id,dispute_id,order_id,uploader_id,type,description) VALUES ('e1','d1','o1','buyer1','text','x')").run()
db.prepare("INSERT INTO arbitrator_whitelist (user_id,status) VALUES ('arbA','active')").run()

const canList = async (uid: string): Promise<{ ok: boolean; n?: number; err?: string }> => {
  try { const r = await listEvidence(db, 'd1', uid) as unknown[]; return { ok: true, n: r.length } }
  catch (e) { return { ok: false, err: (e as Error).message } }
}

try {
  ok('assigned + active arbitrator CAN read evidence', (await canList('arbA')).ok === true)
  ok('case party (buyer) CAN read evidence', (await canList('buyer1')).ok === true)
  ok('non-party → denied', (await canList('stranger')).err === 'not_dispute_party')
  db.prepare("UPDATE arbitrator_whitelist SET status='suspended' WHERE user_id='arbA'").run()
  ok('★ assigned but SUSPENDED arbitrator → denied (active recheck)', (await canList('arbA')).err === 'not_dispute_party')
  db.prepare("UPDATE arbitrator_whitelist SET status='revoked' WHERE user_id='arbA'").run()
  ok('★ assigned but REVOKED arbitrator → denied', (await canList('arbA')).err === 'not_dispute_party')
  db.prepare("UPDATE arbitrator_whitelist SET status='active' WHERE user_id='arbA'").run()
  ok('reinstated active → can read again', (await canList('arbA')).ok === true)

  if (fail > 0) { console.error(`\n❌ evidence-active-recheck FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ evidence-active-recheck: assigned arbitrator must stay active whitelist to read evidence; parties always; non-party denied\n  ✅ pass ${pass}`)
} catch (e) { console.error(e); process.exit(1) }
