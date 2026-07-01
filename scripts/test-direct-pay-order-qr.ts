#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — 买家订单收款二维码端点 (Phase D2)。真 express + 真 orders-read 路由 + 真 seam。
 * 验 GET /api/orders/:id/direct-pay-qr:仅【订单买家】+【D1/D2 both-acked】后服务【当时那一版】QR 字节(硬化头);
 *   未 ack / 非买家 / 无 qr_ref / 非 direct_p2p → 统一 404(不枚举)。图字节不入 order JSON。
 * Usage: npm run test:direct-pay-order-qr
 */
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'dp-oqr-'))

import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'

const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerOrdersReadRoutes } = await import('../src/pwa/routes/orders-read.js')
const { recordDisclosureAck } = await import('../src/direct-pay-disclosures.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const db = initDatabase()
setSeamDb(db)
db.pragma('foreign_keys = OFF')
for (const [u, role] of [['buyer1', 'buyer'], ['buyer2', 'buyer'], ['seller1', 'seller']] as const) db.prepare('INSERT INTO users (id,name,role,api_key) VALUES (?,?,?,?)').run(u, u, role, 'k_' + u)

// valid png bytes (magic + filler) → base64; a matching immutable qr_images row keyed (ref, seller_id).
const pngBuf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('QRDATA')])
const b64 = pngBuf.toString('base64')
db.prepare('INSERT INTO direct_receive_account_qr_images (ref, account_id, seller_id, mime, data_b64, byte_len, sha256) VALUES (?,?,?,?,?,?,?)')
  .run('qref1', 'acc1', 'seller1', 'image/png', b64, pngBuf.length, 'qref1')

const insOrder = (id: string, opts: { buyer?: string; rail?: string; qrRef?: string | null }) =>
  db.prepare("INSERT INTO orders (id, product_id, buyer_id, seller_id, quantity, unit_price, total_amount, escrow_amount, status, payment_rail, direct_pay_account_snapshot) VALUES (?,?,?,?,?,?,?,0,?,?,?)")
    .run(id, 'p1', opts.buyer ?? 'buyer1', 'seller1', 1, 10, 10, 'direct_pay_window', opts.rail ?? 'direct_p2p',
      opts.qrRef === null ? null : JSON.stringify({ account_id: 'acc1', method: 'PayNow', currency: 'SGD', label: 'A', qr_ref: opts.qrRef ?? 'qref1' }))
insOrder('ord_ok', {})                                  // buyer1, direct_p2p, qr_ref=qref1
insOrder('ord_noqr', { qrRef: null })                   // no account snapshot → no qr
insOrder('ord_escrow', { rail: 'escrow' })              // not direct_p2p

const app = express(); app.use(express.json())
const stub = () => ({})
registerOrdersReadRoutes(app, {
  db,
  auth: (req: Request, res: Response): Record<string, unknown> | null => { const uid = String(req.headers['x-user'] || ''); const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid) as Record<string, unknown> | undefined; if (!u) { res.status(401).json({ error: 'unauth' }); return null } return u },
  getOrderStatus: stub, getOrderChain: stub, verifyOrderChain: stub, getOrderDispute: stub,
} as unknown as Parameters<typeof registerOrdersReadRoutes>[1])
const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const getQr = async (orderId: string, user?: string): Promise<{ status: number; ct: string | null; cc: string | null; nosniff: string | null; len: number }> => {
  const r = await fetch(`${base}/api/orders/${orderId}/direct-pay-qr`, { headers: user ? { 'x-user': user } : {} })
  const ab = Buffer.from(await r.arrayBuffer())
  return { status: r.status, ct: r.headers.get('content-type'), cc: r.headers.get('cache-control'), nosniff: r.headers.get('x-content-type-options'), len: ab.length }
}

try {
  ok('1. unauth → 401', (await getQr('ord_ok')).status === 401)
  ok('2. buyer, NOT acked → 404 (disclosure gate; non-enumerating)', (await getQr('ord_ok', 'buyer1')).status === 404)
  // ack only D1 → still gated
  recordDisclosureAck(db, { orderId: 'ord_ok', buyerId: 'buyer1', stage: 'pre_select', ackId: 'ack1' })
  ok('3. only D1 acked → still 404', (await getQr('ord_ok', 'buyer1')).status === 404)
  // ack D2 → both acked → serves bytes
  recordDisclosureAck(db, { orderId: 'ord_ok', buyerId: 'buyer1', stage: 'pre_confirm', ackId: 'ack2' })
  const served = await getQr('ord_ok', 'buyer1')
  ok('4. both acked → 200 image/png bytes', served.status === 200 && served.ct === 'image/png' && served.len === pngBuf.length, JSON.stringify(served))
  ok('5. hardened headers: nosniff + private no-store', served.nosniff === 'nosniff' && /private/.test(served.cc || '') && /no-store/.test(served.cc || ''))
  // non-buyer (even seller) → 404
  ok('6. non-buyer (buyer2) → 404', (await getQr('ord_ok', 'buyer2')).status === 404)
  ok('6b. seller of the order → 404 (endpoint is buyer-only)', (await getQr('ord_ok', 'seller1')).status === 404)
  // order with no qr_ref → 404 even if acked
  recordDisclosureAck(db, { orderId: 'ord_noqr', buyerId: 'buyer1', stage: 'pre_select', ackId: 'ack3' })
  recordDisclosureAck(db, { orderId: 'ord_noqr', buyerId: 'buyer1', stage: 'pre_confirm', ackId: 'ack4' })
  ok('7. no qr_ref on order → 404', (await getQr('ord_noqr', 'buyer1')).status === 404)
  // non-direct_p2p → 404
  ok('8. escrow order → 404 (direct_p2p only)', (await getQr('ord_escrow', 'buyer1')).status === 404)
  // nonexistent order → 404
  ok('9. nonexistent order → 404', (await getQr('nope', 'buyer1')).status === 404)

  if (fail > 0) { console.error(`\n❌ direct-pay order QR endpoint FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
  else console.log(`✅ direct-pay order QR endpoint (D2): buyer-only + both-disclosures-acked · serves snapshotted (ref,seller) bytes · hardened headers · non-enumerating 404 for not-acked/non-buyer/no-qr/escrow\n  ✅ pass ${pass}`)
} finally {
  server.close()
}
