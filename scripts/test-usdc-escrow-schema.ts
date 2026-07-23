#!/usr/bin/env tsx
/**
 * USDC 合约担保 PR-B2 — schema + 收款地址注册回归锁。
 * Proves:
 *   ① 四表建齐(payout/intents/chain_events/watcher_state),组合根自动拾取(initUsdcEscrowSchema
 *     re-export),chain_events UNIQUE(tx_hash,log_index) 幂等。
 *   ② 地址:任意大小写输入 → EIP-55 canonical 存储;非法拒;同卖家同地址 active 去重;retire 不
 *     DELETE(行保留 status='retired')且幂等;retire 后可重新登记同地址。
 *   ③ 路由:非卖家 403;卖家增/列/退全链路;列表只出 active。
 *   ④ append-only 纪律(代码层):chain_events 重复 (tx,log) INSERT 抛 UNIQUE。
 * Usage: npm run test:usdc-escrow-schema
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'uesch-'))
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { canonicalEvmAddress, addPayoutAddress, listActivePayoutAddresses, retirePayoutAddress } = await import('../src/usdc-escrow-store.js')
const { registerUsdcPayoutAddressRoutes } = await import('../src/pwa/routes/usdc-payout-address.js')
const express = (await import('express')).default

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
applyWebazRuntimeSchema(db)   // ← 组合根应自动建出 B2 四表(re-export 拾取)

// ── ① 表存在 + 幂等 ──
const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%usdc_escrow%' OR name='seller_payout_addresses'").all() as { name: string }[]).map(t => t.name)
ok('composition root auto-creates all four tables', ['seller_payout_addresses', 'usdc_escrow_intents', 'usdc_escrow_chain_events', 'usdc_escrow_watcher_state'].every(t => tables.includes(t)), JSON.stringify(tables))
db.prepare("INSERT INTO usdc_escrow_chain_events (id, order_key, event_name, tx_hash, log_index, block_number, block_hash, payload_json) VALUES ('e1','0xk','Deposited','0xt1',0,100,'0xb1','{}')").run()
let dupThrew = false
try { db.prepare("INSERT INTO usdc_escrow_chain_events (id, order_key, event_name, tx_hash, log_index, block_number, block_hash, payload_json) VALUES ('e2','0xk','Deposited','0xt1',0,100,'0xb1','{}')").run() } catch { dupThrew = true }
ok('chain_events (tx_hash, log_index) is idempotent-unique', dupThrew)
// 真 append-only:UPDATE/DELETE 被触发器 ABORT;重组走 orphans 标记表(加行不改行,同样 append-only)
let updThrew = false; let delThrew = false
try { db.prepare("UPDATE usdc_escrow_chain_events SET block_hash='0xEVIL' WHERE id='e1'").run() } catch { updThrew = true }
try { db.prepare("DELETE FROM usdc_escrow_chain_events WHERE id='e1'").run() } catch { delThrew = true }
ok('chain_events is TRULY append-only (UPDATE/DELETE ABORT)', updThrew && delThrew)
db.prepare("INSERT INTO usdc_escrow_event_orphans (event_id, reason) VALUES ('e1','reorg: block_hash mismatch')").run()
let orphDupThrew = false; let orphUpdThrew = false
try { db.prepare("INSERT INTO usdc_escrow_event_orphans (event_id, reason) VALUES ('e1','again')").run() } catch { orphDupThrew = true }
try { db.prepare("UPDATE usdc_escrow_event_orphans SET reason='x' WHERE event_id='e1'").run() } catch { orphUpdThrew = true }
ok('orphan marker: one-shot per event + append-only', orphDupThrew && orphUpdThrew)
// intents 字段形状与合约对齐(orderKey/amount 6dp units/fee_bps/auto_release_at)
const intentCols = (db.prepare('PRAGMA table_info(usdc_escrow_intents)').all() as { name: string }[]).map(c => c.name)
ok('intents columns align with the contract voucher fields', ['order_id', 'order_key', 'contract_addr', 'buyer_id', 'seller_id', 'seller_addr', 'amount_units', 'fee_bps', 'auto_release_at', 'voucher_sig', 'auth_expires_at', 'status'].every(c => intentCols.includes(c)), JSON.stringify(intentCols))

// ── ② 地址归一 ──
const mixed = '0x8ba1f109551bD432803012645Ac136ddd64DBA72'
ok('canonical: lowercase in → EIP-55 out', canonicalEvmAddress(mixed.toLowerCase()) === mixed)
ok('canonical: uppercase-hex in → same EIP-55 out', canonicalEvmAddress('0x' + mixed.slice(2).toUpperCase()) === mixed)
ok('canonical: junk rejected', canonicalEvmAddress('0x123') === null && canonicalEvmAddress('bogus') === null && canonicalEvmAddress(42) === null)

db.prepare("INSERT INTO users (id,name,role,roles,api_key) VALUES ('s1','s1','seller','[\"seller\"]','k_s1'),('b1','b1','buyer','[\"buyer\"]','k_b1'),('s2','s2','seller','[\"seller\"]','k_s2'),('weird','weird','buyer','\"reseller\"','k_w')").run()   // weird: roles 是 JSON 字符串 "reseller" —— R1 High 的子串放行回归钉
let seq = 0
const genId = (p: string): string => `${p}_${++seq}`
const added = addPayoutAddress(db, { generateId: genId, sellerId: 's1', address: mixed.toLowerCase(), label: '主收款' })
ok('add: stored canonical + label', added.ok && added.row.address === mixed && added.row.label === '主收款')
const dup = addPayoutAddress(db, { generateId: genId, sellerId: 's1', address: '0x' + mixed.slice(2).toUpperCase() })
ok('add: same address (any casing) deduped while active', !dup.ok && !('row' in dup) && (dup as { error_code: string }).error_code === 'PAYOUT_ADDRESS_DUPLICATE')

const firstId = (added as { row: { id: string } }).row.id
ok('retire: idempotent, row kept (never DELETE)', retirePayoutAddress(db, 's1', firstId).ok && retirePayoutAddress(db, 's1', firstId).ok
  && (db.prepare("SELECT status FROM seller_payout_addresses WHERE id = ?").get(firstId) as { status: string }).status === 'retired')
ok('retire: other seller cannot retire mine', retirePayoutAddress(db, 'b1', firstId).ok === false)
ok('re-register after retire allowed', addPayoutAddress(db, { generateId: genId, sellerId: 's1', address: mixed }).ok === true)
ok('list: only active rows', listActivePayoutAddresses(db, 's1').length === 1)

// ── ③ 路由 ──
const auth = (req: { headers: Record<string, unknown> }, res: { status: (n: number) => { json: (b: unknown) => void } }): Record<string, unknown> | null => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(String(req.headers['x-test-user'] || '')) as Record<string, unknown> | undefined
  if (!u) { res.status(401).json({ error: 'login required' }); return null }
  return u
}
const app = express(); app.use(express.json())
/* eslint-disable @typescript-eslint/no-explicit-any */
registerUsdcPayoutAddressRoutes(app, { db, auth: auth as any, isTrustedRole: () => false, generateId: genId })
const srv = app.listen(0)
const port = (srv.address() as { port: number }).port
const call = async (method: string, path: string, user: string, body?: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': user }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: await r.json() as Record<string, unknown> }
}
ok('route: buyer-only account 403', (await call('GET', '/api/usdc-escrow/payout-addresses', 'b1')).status === 403)
ok('route: roles-as-string "reseller" does NOT substring-pass the seller gate (R1 High)', (await call('GET', '/api/usdc-escrow/payout-addresses', 'weird')).status === 403)
const post = await call('POST', '/api/usdc-escrow/payout-addresses', 's1', { address: '0x0000000000000000000000000000000000000001'.toLowerCase(), label: 'x' })
ok('route: seller add works', post.status === 200 && post.json.success === true, JSON.stringify(post))
const list = await call('GET', '/api/usdc-escrow/payout-addresses', 's1')
ok('route: list shows both active', (list.json.items as unknown[]).length === 2)
const bad = await call('POST', '/api/usdc-escrow/payout-addresses', 's1', { address: 'nope' })
ok('route: invalid address 400', bad.status === 400 && bad.json.error_code === 'PAYOUT_ADDRESS_INVALID')
// retire 路由 + 越权/存在性不泄露(他人的 id 与不存在的 id 同一响应体)
const myId = ((list.json.items as Array<{ id: string }>)[0]).id
const cross = await call('POST', `/api/usdc-escrow/payout-addresses/${myId}/retire`, 's2')
const ghost = await call('POST', '/api/usdc-escrow/payout-addresses/spa_nope/retire', 's2')
ok('route: cross-seller retire and nonexistent id are indistinguishable 404s', cross.status === 404 && ghost.status === 404 && JSON.stringify(cross.json) === JSON.stringify(ghost.json), JSON.stringify({ cross, ghost }))
const ret = await call('POST', `/api/usdc-escrow/payout-addresses/${myId}/retire`, 's1')
ok('route: owner retire works and list shrinks', ret.status === 200 && ((await call('GET', '/api/usdc-escrow/payout-addresses', 's1')).json.items as unknown[]).length === 1)
srv.close()
// trusted-role 门
const app2 = express(); app2.use(express.json())
registerUsdcPayoutAddressRoutes(app2, { db, auth: auth as any, isTrustedRole: () => true, generateId: genId })
const srv2 = app2.listen(0)
const port2 = (srv2.address() as { port: number }).port
const tr = await fetch(`http://127.0.0.1:${port2}/api/usdc-escrow/payout-addresses`, { headers: { 'x-test-user': 's1' } })
ok('route: trusted-role 403', tr.status === 403)
srv2.close()

if (fail > 0) { console.error(`\n❌ usdc-escrow-schema FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ usdc-escrow-schema: four tables via composition root + EIP-55 canonical payout addresses (dedupe/retire-not-delete) + seller-gated routes + idempotent event mirror\n  ✅ pass ${pass}`)
