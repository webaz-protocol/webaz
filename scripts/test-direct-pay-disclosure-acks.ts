#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) 风险披露 ack 端点测试 (PR-4d) — 真 express + 真 #87 helper + 真 requireDirectPayHumanPasskey
 *   + 【真 consumeGateToken(createHumanPresence)】+ seeded webauthn_gate_tokens(P1 修正:走真实 purpose/purpose_data 链路,
 *   不再 stub gate)。
 * human-only = 现场真人 gate:① 绑 Passkey;② 一次性 WebAuthn token,purpose 固定 'direct_pay_disclosure_ack',
 *   order/stage 走 purpose_data + validate。wrong-order / wrong-stage / 复用 / 无 token 全部 fail-closed。
 * Usage: npm run test:direct-pay-disclosure-acks
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-disc-'))

import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { createHumanPresence } = await import('../src/pwa/human-presence.js')
const { registerDirectPayDisclosureAckRoutes } = await import('../src/pwa/routes/direct-pay-disclosure-acks.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
db.pragma('foreign_keys = OFF')
setSeamDb(db)
db.exec('CREATE TABLE IF NOT EXISTS webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT)')
db.exec('CREATE TABLE IF NOT EXISTS webauthn_gate_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, purpose_data TEXT, expires_at TEXT NOT NULL, consumed_at TEXT)')
db.prepare("INSERT OR IGNORE INTO penalty_fund (id, balance, total_fee_stake_slash, total_base_bond_slash, updated_at) VALUES ('main',0,0,0,datetime('now'))").run()
for (const u of ['buyer1', 'otheruser', 'seller1', 'nopk']) db.prepare("INSERT OR IGNORE INTO users (id,name,role,api_key) VALUES (?,?,?,?)").run(u, u, 'buyer', 'k_' + u)
db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance) VALUES ('buyer1', 100)").run()
db.prepare("INSERT INTO webauthn_credentials (id, user_id) VALUES ('pk_buyer1','buyer1')").run()  // buyer1 有 Passkey;nopk 没有

// 真实 gate token 消费器(非 stub)。getProtocolParam 仅 requireHumanPresence 用,consumeGateToken 不依赖。
const { consumeGateToken } = createHumanPresence(db, <T,>(_k: string, fb: T): T => fb)
function seedToken(id: string, user: string, data: Record<string, unknown>, opts: { purpose?: string; expired?: boolean } = {}): string {
  db.prepare('INSERT INTO webauthn_gate_tokens (id, user_id, purpose, purpose_data, expires_at) VALUES (?,?,?,?,?)')
    .run(id, user, opts.purpose ?? 'direct_pay_disclosure_ack', JSON.stringify(data), new Date(Date.now() + (opts.expired ? -1000 : 60_000)).toISOString())
  return id
}

let oc = 0
function mkOrder(id: string, rail: string, buyer = 'buyer1', status = 'direct_pay_window'): void {
  db.prepare(`INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail)
     VALUES (?, 'p1', ?, 'seller1', 1, 50, 50, 0, ?, ?)`).run(id, buyer, status, rail)
}
const ostatus = (id: string) => (db.prepare('SELECT status FROM orders WHERE id=?').get(id) as { status: string } | undefined)?.status
const ackRows = (id: string) => db.prepare('SELECT stage FROM direct_pay_disclosure_acks WHERE order_id=?').all(id).map((r: any) => r.stage).sort()
const wbal = (u: string) => (db.prepare('SELECT balance FROM wallets WHERE user_id=?').get(u) as { balance: number } | undefined)?.balance
const penProv = () => (db.prepare("SELECT total_base_bond_slash AS s FROM penalty_fund WHERE id='main'").get() as { s: number }).s

const app = express(); app.use(express.json())
registerDirectPayDisclosureAckRoutes(app, {
  db,
  auth: (req: Request, res: Response) => {
    const uid = req.headers['x-test-uid'] as string | undefined
    if (!uid) { res.status(401).json({ error: 'login required' }); return null }
    return { id: uid, role: 'buyer' }
  },
  generateId: (p: string) => `${p}_${++oc}`,
  consumeGateToken,
})
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server.address() as any).port)) })

function call(method: 'POST' | 'GET', path: string, body: Record<string, unknown> | null, uid?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : ''
    const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
    if (uid) headers['x-test-uid'] = uid
    const rq = httpRequest({ host: '127.0.0.1', port, method, path, headers }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve({ status: res.statusCode || 0, json: data ? JSON.parse(data) : null }) } catch { resolve({ status: res.statusCode || 0, json: data }) } })
    })
    rq.on('error', reject); if (payload) rq.write(payload); rq.end()
  })
}
const POST = (b: Record<string, unknown>, uid?: string) => call('POST', '/api/direct-pay/disclosure-acks', b, uid)
const GET = (orderId: string, uid?: string) => call('GET', `/api/direct-pay/disclosure-acks/${orderId}`, null, uid)

mkOrder('o1', 'direct_p2p')

// ── 1. unauthenticated → 401 ──
ok('unauthenticated POST → 401', (await POST({ order_id: 'o1', stage: 'pre_select', webauthn_token: seedToken('t_u', 'buyer1', { order_id: 'o1', stage: 'pre_select' }) })).status === 401)

// ── 2. 无 Passkey 用户 → 403 PASSKEY_REQUIRED(① 在 token 之前)──
mkOrder('oNoPk', 'direct_p2p', 'nopk')
const r2 = await POST({ order_id: 'oNoPk', stage: 'pre_select', webauthn_token: seedToken('t_npk', 'nopk', { order_id: 'oNoPk', stage: 'pre_select' }) }, 'nopk')
ok('no-Passkey → 403 PASSKEY_REQUIRED_FOR_DIRECT_PAY', r2.status === 403 && r2.json?.error_code === 'PASSKEY_REQUIRED_FOR_DIRECT_PAY', JSON.stringify(r2))

// ── 3. 有 Passkey 无 token → 403 HUMAN_PRESENCE_REQUIRED ──
const r3 = await POST({ order_id: 'o1', stage: 'pre_select' }, 'buyer1')
ok('Passkey, no token → 403 HUMAN_PRESENCE_REQUIRED', r3.status === 403 && r3.json?.error_code === 'HUMAN_PRESENCE_REQUIRED', JSON.stringify(r3))

// ── 4. 不存在的 token → 403 ──
ok('nonexistent token → 403', (await POST({ order_id: 'o1', stage: 'pre_select', webauthn_token: 'no-such' }, 'buyer1')).status === 403)

// ── 5. wrong-order token → 403(validate 拒)──
const r5 = await POST({ order_id: 'o1', stage: 'pre_select', webauthn_token: seedToken('t_wo', 'buyer1', { order_id: 'oX', stage: 'pre_select' }) }, 'buyer1')
ok('wrong-order token → 403 HUMAN_PRESENCE_REQUIRED', r5.status === 403 && r5.json?.error_code === 'HUMAN_PRESENCE_REQUIRED', JSON.stringify(r5))
ok('wrong-order token did NOT record an ack', ackRows('o1').length === 0)

// ── 6. wrong-stage token → 403 ──
const r6 = await POST({ order_id: 'o1', stage: 'pre_select', webauthn_token: seedToken('t_ws', 'buyer1', { order_id: 'o1', stage: 'pre_confirm' }) }, 'buyer1')
ok('wrong-stage token → 403', r6.status === 403 && r6.json?.error_code === 'HUMAN_PRESENCE_REQUIRED', JSON.stringify(r6))

// ── 7. non-buyer → 403(ownership 在 gate 前)──
const r7 = await POST({ order_id: 'o1', stage: 'pre_select', webauthn_token: seedToken('t_nb', 'otheruser', { order_id: 'o1', stage: 'pre_select' }) }, 'otheruser')
ok('non-buyer → 403 NOT_ORDER_BUYER', r7.status === 403 && r7.json?.error_code === 'NOT_ORDER_BUYER', JSON.stringify(r7))

// ── 8. non-direct_p2p → 409 ──
mkOrder('oEsc', 'escrow', 'buyer1', 'created')
ok('escrow order → 409 NOT_DIRECT_PAY_ORDER', (await POST({ order_id: 'oEsc', stage: 'pre_select', webauthn_token: 'x' }, 'buyer1')).json?.error_code === 'NOT_DIRECT_PAY_ORDER')

// ── 9. invalid stage → 400 ──
ok('invalid stage → 400', (await POST({ order_id: 'o1', stage: 'bogus', webauthn_token: 'x' }, 'buyer1')).status === 400)

// ── 10. 正确 token → D1/D2 分别记录 ──
const a1 = await POST({ order_id: 'o1', stage: 'pre_select', webauthn_token: seedToken('t_d1a', 'buyer1', { order_id: 'o1', stage: 'pre_select' }) }, 'buyer1')
ok('valid D1 token → 200 both:false', a1.status === 200 && a1.json?.ok === true && a1.json?.both === false, JSON.stringify(a1))
const a2 = await POST({ order_id: 'o1', stage: 'pre_confirm', webauthn_token: seedToken('t_d2', 'buyer1', { order_id: 'o1', stage: 'pre_confirm' }) }, 'buyer1')
ok('valid D2 token → 200 both:true', a2.status === 200 && a2.json?.both === true, JSON.stringify(a2))
ok('both stages = 2 rows', JSON.stringify(ackRows('o1')) === JSON.stringify(['pre_confirm', 'pre_select']))

// ── 11. ack 幂等(新 token,重复 D1)──
await POST({ order_id: 'o1', stage: 'pre_select', webauthn_token: seedToken('t_d1b', 'buyer1', { order_id: 'o1', stage: 'pre_select' }) }, 'buyer1')
ok('duplicate D1 ack idempotent (still 2 rows)', ackRows('o1').length === 2)

// ── 12. token 复用(已消费)→ 403 ──
ok('reused (consumed) token → 403', (await POST({ order_id: 'o1', stage: 'pre_select', webauthn_token: 't_d1a' }, 'buyer1')).status === 403)

// ── 13. GET 缺一 → false;齐全 → true(只读,无需 token)──
mkOrder('o2', 'direct_p2p'); mkOrder('o3', 'direct_p2p'); mkOrder('o4', 'direct_p2p')
await POST({ order_id: 'o2', stage: 'pre_select', webauthn_token: seedToken('t_o2a', 'buyer1', { order_id: 'o2', stage: 'pre_select' }) }, 'buyer1')
const g13 = await GET('o2', 'buyer1')
ok('GET after D1 only → both:false', g13.status === 200 && g13.json?.both === false && g13.json?.acked?.pre_select === true && g13.json?.acked?.pre_confirm === false, JSON.stringify(g13))
await POST({ order_id: 'o2', stage: 'pre_confirm', webauthn_token: seedToken('t_o2b', 'buyer1', { order_id: 'o2', stage: 'pre_confirm' }) }, 'buyer1')
ok('GET after both → both:true', (await GET('o2', 'buyer1')).json?.both === true)

// ── 14. GET 买家视角文案,无卖家机制 ──
const g14 = await GET('o2', 'buyer1')
const disc = JSON.stringify(g14.json?.disclosures || {})
ok('GET buyer-view disclosures (zh present)', !!g14.json?.disclosures?.pre_select?.zh && !!g14.json?.disclosures?.pre_confirm?.zh)
ok('disclosures do NOT leak seller mechanics (质押/平台费/fee-stake/bond)', !/质押|平台费|fee-stake|bond/i.test(disc), disc)

// ── 15. ack 不改订单状态 / 不动 wallet·penalty ──
ok('order status unchanged (direct_pay_window)', ostatus('o1') === 'direct_pay_window')
ok('buyer wallet unchanged', wbal('buyer1') === 100)
ok('penalty provenance unchanged', penProv() === 0)

// ── 16. missing / not found ──
ok('missing order_id → 400', (await POST({ stage: 'pre_select', webauthn_token: 'x' }, 'buyer1')).status === 400)
ok('order not found → 404', (await POST({ order_id: 'nope', stage: 'pre_select', webauthn_token: 'x' }, 'buyer1')).status === 404)

// ── 17. stage:'both'(contract v14):一次 ceremony 记两行 ack ──
const b1 = await POST({ order_id: 'o3', stage: 'both', webauthn_token: seedToken('t_both', 'buyer1', { order_id: 'o3', stage: 'both' }) }, 'buyer1')
ok('both: one ceremony → 200 both:true', b1.status === 200 && b1.json?.both === true, JSON.stringify(b1))
ok('both: records TWO ack rows (evidence model unchanged)', JSON.stringify(ackRows('o3')) === JSON.stringify(['pre_confirm', 'pre_select']))
ok('both: single-stage token cannot masquerade as both (validate stage)', (await POST({ order_id: 'o4', stage: 'both', webauthn_token: seedToken('t_single', 'buyer1', { order_id: 'o4', stage: 'pre_select' }) }, 'buyer1')).status === 403)
ok('both: both-token cannot replay a single stage (validate stage)', (await POST({ order_id: 'o4', stage: 'pre_select', webauthn_token: seedToken('t_bmis', 'buyer1', { order_id: 'o4', stage: 'both' }) }, 'buyer1')).status === 403)

// ── 18. 版本升级 re-ack(审计 P0):upsert 让新版本确认真正刷新行,不再静默 no-op ──
{
  db.prepare("INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail) VALUES ('oVer','p','buyer1','seller1',1,50,50,0,'direct_pay_window','direct_p2p')").run()
  // 手动塞一行【旧版本】 ack(模拟 bump 前已 ack)
  db.prepare("INSERT INTO direct_pay_disclosure_acks (id, order_id, buyer_id, stage, notice_version, acked_at) VALUES ('old1','oVer','buyer1','pre_select','d1.v1.OLD', datetime('now','-1 day'))").run()
  const gOld = await GET('oVer', 'buyer1')
  ok('P0: stale-version ack reads as NOT acked (version-scoped)', gOld.json?.acked?.pre_select === false)
  await POST({ order_id: 'oVer', stage: 'pre_select', webauthn_token: seedToken('t_ver', 'buyer1', { order_id: 'oVer', stage: 'pre_select' }) }, 'buyer1')
  const gNew = await GET('oVer', 'buyer1')
  ok('P0: re-ack under current version UPSERTS the row → now acked (not silent no-op)', gNew.json?.acked?.pre_select === true)
  const ver = (db.prepare("SELECT notice_version FROM direct_pay_disclosure_acks WHERE order_id='oVer' AND stage='pre_select'").get() as { notice_version: string }).notice_version
  ok('P0: row upgraded to current d1.v2 version (single row, not duplicated)', /d1\.v2/.test(ver) && (db.prepare("SELECT COUNT(*) n FROM direct_pay_disclosure_acks WHERE order_id='oVer' AND stage='pre_select'").get() as { n: number }).n === 1)
}

server!.close()
if (fail > 0) { console.error(`\n${fail} test(s) failed:`); console.log(fails.join('\n')); process.exit(1) }
console.log(`✅ ${pass} direct-pay-disclosure-acks tests passed`)
