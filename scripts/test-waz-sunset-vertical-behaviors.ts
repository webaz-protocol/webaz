#!/usr/bin/env tsx
/**
 * WAZ 退役(2026-07-23)— server.ts 内部垂直面的渠道关【行为】测试(Codex #514 R2 MEDIUM)。
 *   源码正则锁抓不到"INSERT 前已有副作用"类回归 → 这里起真 server 子进程,打真数据:
 *   - 拍卖:cron(10s)结算,渠道关 → 'cancelled' 资金归还终局:winner/其他 bid stake + 卖家担保金全退,
 *     商品回架,零 escrow 单;资金守恒(每人 balance+staked+escrowed 总量不变);再等一个 cron tick
 *     验证幂等(status CAS,不双退)。
 *   - RFQ:手动 award(POST /api/rfqs/:id/award)渠道关 → 4xx 拒绝,零建单,买卖双方 stake 原封不动,
 *     RFQ 仍 open(到期 cron 的既有 fallback 会退押金 —— 该退款路径不属本 PR 改动面)。
 *   生产 DEFAULT_PARAMS 种的就是 '0'(默认关)—— 子进程不改 param,测的就是默认态。
 * Usage: npm run test:waz-sunset-vertical
 */
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

const HOME = mkdtempSync(join(tmpdir(), 'wazvert-'))
const PORT = 20000 + Math.floor(Math.random() * 20000)

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const child = spawn(join('node_modules', '.bin', 'tsx'), ['src/pwa/server.ts'], {
  env: { ...process.env, HOME, USERPROFILE: HOME, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let bootLog = ''
child.stdout.on('data', (d: Buffer) => { bootLog += d.toString() })
child.stderr.on('data', (d: Buffer) => { bootLog += d.toString() })

try {
  // ── boot 就绪探针 ──
  let ready = false
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/products?limit=1`); if (r.status < 500) { ready = true; break } } catch { /* not up yet */ }
    await sleep(1000)
  }
  if (!ready) { console.error('server never became ready\n' + bootLog.slice(-3000)); process.exit(1) }

  const Database = (await import('better-sqlite3')).default
  const db = new Database(join(HOME, '.webaz', 'webaz.db'))
  const paramRow = db.prepare("SELECT value FROM protocol_params WHERE key='payment_rail_waz_escrow_enabled'").get() as { value: string } | undefined
  ok("boot: DEFAULT_PARAMS seeded the channel switch OFF ('0')", paramRow?.value === '0', JSON.stringify(paramRow))

  const mkUser = (id: string, role: string, bal: number, staked = 0): void => {
    db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(id, id, role, 'k_' + id)
    db.prepare('INSERT OR REPLACE INTO wallets (user_id, balance, staked, escrowed, earned) VALUES (?,?,?,0,0)').run(id, bal, staked)
  }
  const w = (id: string): { balance: number; staked: number; escrowed: number } => db.prepare('SELECT balance, staked, escrowed FROM wallets WHERE user_id = ?').get(id) as { balance: number; staked: number; escrowed: number }
  const total = (x: { balance: number; staked: number; escrowed: number }): number => Number(x.balance) + Number(x.staked) + Number(x.escrowed)
  const orderCount = (source: string): number => (db.prepare('SELECT COUNT(*) n FROM orders WHERE source = ?').get(source) as { n: number }).n

  // ── ① RFQ 手动 award:渠道关 → 拒绝 + 零建单 + stake 不动 ──────────────────────────
  mkUser('rfqBuyer', 'buyer', 100, 5)      // 5 = RFQ 发布押金(已锁 staked)
  mkUser('rfqSeller', 'seller', 50, 3)     // 3 = bid stake
  // 问责门(AGENT_SCOPE_UNDECLARED):绑 Passkey = 真人豁免 —— 本测试测的是 rail 闸,不是问责门
  db.prepare("INSERT INTO webauthn_credentials (id, user_id, public_key) VALUES ('cred_rfqBuyer','rfqBuyer', x'00')").run()
  db.prepare(`INSERT INTO rfqs (id, buyer_id, title, qty, urgency, award_mode, deadline_at, buyer_stake_locked, status, notes)
              VALUES ('rfq1','rfqBuyer','测试RFQ',1,'flex','manual',datetime('now','+1 hour'),5,'open','addr test')`).run()
  db.prepare("UPDATE rfqs SET notes = NULL WHERE id = 'rfq1'").run()
  db.prepare("UPDATE rfqs SET status='open' WHERE id='rfq1'").run()
  // shipping_address 列在 rfqs 建表后 ALTER 增补 —— award helper 要求非空
  try { db.exec("ALTER TABLE rfqs ADD COLUMN shipping_address TEXT") } catch { /* 已存在 */ }
  db.prepare("UPDATE rfqs SET shipping_address = '1 Test St' WHERE id='rfq1'").run()
  db.prepare(`INSERT INTO bids (id, rfq_id, seller_id, price, qty_offered, stake_locked, status)
              VALUES ('bid1','rfq1','rfqSeller',10,1,3,'active')`).run()
  const buyerBefore = w('rfqBuyer'); const sellerBefore = w('rfqSeller')
  const awardRes = await fetch(`http://127.0.0.1:${PORT}/api/rfqs/rfq1/award`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k_rfqBuyer' }, body: JSON.stringify({ bid_id: 'bid1' }),
  })
  const awardJson = await awardRes.json() as Record<string, unknown>
  ok('rfq: off → award rejected (4xx + 已下架)', awardRes.status >= 400 && /已下架|RAIL_DISABLED/.test(String(awardJson.error || '')), `${awardRes.status} ${JSON.stringify(awardJson)}`)
  ok('rfq: off → zero orders created', orderCount('rfq') === 0)
  ok('rfq: off → buyer + seller stakes untouched', JSON.stringify(w('rfqBuyer')) === JSON.stringify(buyerBefore) && JSON.stringify(w('rfqSeller')) === JSON.stringify(sellerBefore), JSON.stringify({ b: w('rfqBuyer'), s: w('rfqSeller') }))
  ok('rfq: off → rfq still open (expiry cron fallback will refund later — refund path not gated)', (db.prepare("SELECT status FROM rfqs WHERE id='rfq1'").get() as { status: string }).status === 'open')

  // ── ② 拍卖 cron 结算:渠道关 → cancelled 资金归还终局 + 守恒 + 幂等 ─────────────────
  mkUser('aucSeller', 'seller', 30, 4)     // 4 = 卖家拍卖担保金
  mkUser('aucBuyer', 'buyer', 80, 2)       // 2 = winner bid stake
  db.prepare(`INSERT INTO products (id, seller_id, title, description, price, stock, status)
              VALUES ('aucP','aucSeller','拍品','d',20,1,'auction_pending')`).run()
  db.prepare(`INSERT INTO auctions (id, seller_id, product_id, title, qty, starting_price, current_price, deadline_at, seller_stake_locked, status)
              VALUES ('auc1','aucSeller','aucP','测试拍卖',1,10,12,datetime('now','-1 minute'),4,'open')`).run()
  db.prepare(`INSERT INTO auction_bids (id, auction_id, buyer_id, price, stake_locked, status)
              VALUES ('ab1','auc1','aucBuyer',12,2,'active')`).run()
  db.prepare("UPDATE users SET default_address_text = '1 Test St' WHERE id = 'aucBuyer'").run()
  const aucSellerT = total(w('aucSeller')); const aucBuyerT = total(w('aucBuyer'))
  let aucStatus = 'open'
  for (let i = 0; i < 30; i++) { await sleep(1000); aucStatus = (db.prepare("SELECT status FROM auctions WHERE id='auc1'").get() as { status: string }).status; if (aucStatus !== 'open') break }
  ok("auction: off → cron settles as 'cancelled' fund-return terminal (never an escrow order)", aucStatus === 'cancelled', aucStatus)
  ok('auction: off → zero escrow orders', orderCount('auction') === 0)
  const sellerAfter = w('aucSeller'); const buyerAfter = w('aucBuyer')
  ok('auction: seller stake fully returned (staked→balance)', Number(sellerAfter.staked) === 0 && Number(sellerAfter.balance) === 34, JSON.stringify(sellerAfter))
  ok('auction: winner bid stake fully returned', Number(buyerAfter.staked) === 0 && Number(buyerAfter.balance) === 82, JSON.stringify(buyerAfter))
  ok('auction: per-user fund conservation (balance+staked+escrowed unchanged)', total(sellerAfter) === aucSellerT && total(buyerAfter) === aucBuyerT)
  ok('auction: product back on shelf', (db.prepare("SELECT status FROM products WHERE id='aucP'").get() as { status: string }).status === 'active')
  ok('auction: winning bid cancelled', (db.prepare("SELECT status FROM auction_bids WHERE id='ab1'").get() as { status: string }).status === 'cancelled')
  // 幂等:再等一个 cron tick(10s+余量),status CAS 保证不双退
  await sleep(12_000)
  ok('auction: idempotent — a later cron tick changes nothing (no double refund)', JSON.stringify(w('aucSeller')) === JSON.stringify(sellerAfter) && JSON.stringify(w('aucBuyer')) === JSON.stringify(buyerAfter) && (db.prepare("SELECT status FROM auctions WHERE id='auc1'").get() as { status: string }).status === 'cancelled')

  db.close()
} finally {
  child.kill()
}

if (fail > 0) { console.error(`\n❌ waz-sunset-vertical FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ waz-sunset-vertical: real-server behaviors — RFQ award refused (no order, stakes intact); auction settles channel-off as cancelled fund-return terminal (conserved, idempotent)\n  ✅ pass ${pass}`)
process.exit(0)
