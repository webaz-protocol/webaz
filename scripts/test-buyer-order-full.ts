#!/usr/bin/env tsx
/**
 * RFC-026 PR-3 — 订单全量只读 + 钱包最小只读。用法:npm run test:buyer-order-full
 *
 * 真实 route + 真 oat_ grant。覆盖:scope 门/非-grandfathering(minimal 不含 full)· 全量视图
 * (结构时间线/冻结条款胜过被改的商品行/物流含 Passkey 批准的 agent 单号/截止+下一责任人/退款状态/
 * available_actions 执行者诚实标注)· 残缺快照不 crash · 钱包只读投影 key 锁(绝无提现/收款面)·
 * 隔离 · 全库内容级零写(审计表豁免且增长)。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'

const tmpHome = mkdtempSync(join(tmpdir(), 'webaz-full-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome
process.env.WEBAZ_MODE = 'network'
delete process.env.WEBAZ_API_KEY

const { initDatabase, generateId } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAgentGrantsRoutes } = await import('../src/pwa/routes/agent-grants.js')
const { initUserModerationSchema, initWebauthnSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { initDisputeSchema } = await import('../src/layer3-trust/L3-1-dispute-engine/dispute-engine.js')
const { initMutualCancelSchema } = await import('../src/layer3-trust/L3-1-dispute-engine/mutual-cancel.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const db = initDatabase(); db.pragma('foreign_keys = OFF'); setSeamDb(db)
initUserModerationSchema(db); applyWebazRuntimeSchema(db); initWebauthnSchema(db); initDisputeSchema(db); initMutualCancelSchema(db)

const FUTURE = new Date(Date.now() + 3600_000).toISOString()
const SNAP = JSON.stringify({ v: 1, captured_at: '2026-07-01T00:00:00Z',
  shipping: { source: 'template', region: 'SG', fee: 2, est_days: '3-5' },
  fulfilment: { handling_hours: 24, estimated_days: '3-5', return_days: 7, return_condition: 'x', warranty_days: 90 },
  logistics: { weight_kg: null, package_size: null, origin_country: null, country_of_origin: null, customs_description: null, hs_code: null },
  declarations: { ship_regions_text: null, sale_regions_rule: null, tax_lines: null, import_duty_terms: 'ddp' }, accept_mode: 'auto' })
db.prepare("INSERT INTO users (id,name,handle,role,api_key) VALUES ('buyer1','B','h_b','buyer','k_b'),('buyer2','B2','h_o','buyer','k_o'),('seller1','S','h_s','seller','k_s')").run()
db.prepare("INSERT INTO wallets (user_id,balance,staked,escrowed,earned) VALUES ('buyer1',92.94,0,7.06,0)").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,return_days) VALUES ('prd_f','seller1','Stand','d',30,'WAZ',9,'x','active',14)").run()   // 商品行 return_days=14,快照=7 → 快照赢
db.prepare(`INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,notes,ship_to_region,shipping_fee,shipping_est_days,trade_terms_snapshot,confirm_deadline) VALUES ('ord_f','buyer1','seller1','prd_f','delivered',1,30,30,30,'escrow','9 SECRET Rd +65 91234567','note SECRET',?, 2,'3-5',?,?)`).run('SG', SNAP, FUTURE)
db.prepare("INSERT INTO order_state_history (id,order_id,from_status,to_status,actor_id,actor_role,notes) VALUES ('h1','ord_f','paid','shipped','seller1','seller',?)").run('shipped from 9 SECRET Rd')
db.prepare("INSERT INTO return_requests (id,order_id,buyer_id,seller_id,product_id,reason,reason_text,refund_amount,status,resolved_at) VALUES ('rr1','ord_f','buyer1','seller1','prd_f','quality','box at 9 SECRET Rd',7.06,'refunded',?)").run(FUTURE)
// Passkey 批准执行过的 agent ship 动作(tracking 经 I6 sanitize)
db.prepare(`INSERT INTO agent_permission_requests (id,human_id,grant_id,agent_label,requested_scopes,risk_level,duration,status,expires_at,kind,order_id,order_action,params_hash,action_params,executed_at)
  VALUES ('apr_ship','buyer1','g','A','[]','high','once','approved',?,'order_action','ord_f','ship','ph',?,?)`).run(FUTURE, JSON.stringify({ tracking: 'SG12345678' }), FUTURE)
// 残缺快照订单(不 crash)
db.prepare("INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,trade_terms_snapshot) VALUES ('ord_bad','buyer1','seller1','prd_f','paid',1,30,30,30,'escrow','x','{\"v\":1}')").run()
db.prepare("INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,shipping_address) VALUES ('ord_other','buyer2','seller1','prd_f','paid',1,30,30,30,'escrow','y')").run()
// 谓词矩阵:completed 窗口内 / completed 过窗 / shipped / paid / dp 付款窗 / disputed(from delivered,买家发起)/ refund_marked
const NOW = new Date().toISOString(); const OLD = new Date(Date.now() - 30 * 86400_000).toISOString()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,currency,stock,category,status,return_days) VALUES ('prd_ret','seller1','Ret','d',30,'WAZ',9,'x','active',14)").run()
const mkOrd = (id: string, st: string, rail: string, prod = 'prd_ret', upd: string = NOW): void => {
  db.prepare("INSERT INTO orders (id,buyer_id,seller_id,product_id,status,quantity,unit_price,total_amount,escrow_amount,payment_rail,shipping_address,updated_at) VALUES (?,'buyer1','seller1',?,?,1,30,30,30,?,'x',?)").run(id, prod, st, rail, upd)
}
mkOrd('ord_c', 'completed', 'escrow'); mkOrd('ord_cx', 'completed', 'escrow', 'prd_ret', OLD)
mkOrd('ord_s', 'shipped', 'escrow'); mkOrd('ord_p', 'paid', 'escrow'); mkOrd('ord_dpw', 'direct_pay_window', 'direct_p2p')
mkOrd('ord_dsp', 'disputed', 'escrow'); mkOrd('ord_rm', 'completed', 'direct_p2p'); mkOrd('ord_rme', 'completed', 'escrow')
mkOrd('ord_pq', 'payment_query', 'direct_p2p'); mkOrd('ord_df', 'delivery_failed', 'escrow'); mkOrd('ord_dsp2', 'disputed', 'escrow')
db.prepare("INSERT INTO order_state_history (id,order_id,from_status,to_status,actor_id,actor_role) VALUES ('hd1','ord_dsp','delivered','disputed','buyer1','buyer')").run()
db.prepare("INSERT INTO disputes (id,order_id,initiator_id,defendant_id,reason,status) VALUES ('dsp_f','ord_dsp','buyer1','seller1','not as described','open')").run()
db.prepare("INSERT INTO return_requests (id,order_id,buyer_id,seller_id,product_id,reason,refund_amount,status) VALUES ('rr2','ord_rm','buyer1','seller1','prd_ret','quality',30,'refund_marked')").run()
db.prepare("INSERT INTO return_requests (id,order_id,buyer_id,seller_id,product_id,reason,refund_amount,status) VALUES ('rr3','ord_rme','buyer1','seller1','prd_ret','quality',30,'refund_marked')").run()
// 非发起人争议(卖家发起)→ 买家无撤诉动作
db.prepare("INSERT INTO order_state_history (id,order_id,from_status,to_status,actor_id,actor_role) VALUES ('hd2','ord_dsp2','delivered','disputed','seller1','seller')").run()
db.prepare("INSERT INTO disputes (id,order_id,initiator_id,defendant_id,reason,status) VALUES ('dsp_s','ord_dsp2','seller1','buyer1','buyer not responding','open')").run()

const auth = (_req: Request, res: Response) => { res.status(401).json({ error: 'login' }); return null }
const app = express(); app.use(express.json())
registerAgentGrantsRoutes(app, { db, auth, generateId, rateLimitOk: () => true, getProtocolParam: <T,>(k: string, fb: T): T => (k === 'payment_rail_waz_escrow_enabled' ? 1 as unknown as T /* WAZ 退役:验证渠道【开着时】语义 */ : fb) })
const server = app.listen(0)
process.env.WEBAZ_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

const webazDir = join(tmpHome, '.webaz')
const useCred = (g: string, b: string, caps: string[]): void => {
  mkdirSync(webazDir, { recursive: true })
  writeFileSync(join(webazDir, 'credentials'), JSON.stringify({ [g]: { token: b, stored_at: '2026-01-01T00:00:00Z' } }), { mode: 0o600 })
  writeFileSync(join(webazDir, 'grant-current.json'), JSON.stringify({ grant_id: g, handle: `file:~/.webaz/credentials#${g}`, capabilities: caps.map(c => ({ capability: c })), expires_at: '2099-01-01T00:00:00Z' }), { mode: 0o600 })
}
const clearCred = (): void => { try { rmSync(join(webazDir, 'grant-current.json')) } catch { /* */ } }
const mkOAuth = (gid: string, oat: string, caps: string[]): void => {
  db.prepare("INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,NULL,'active',?)")
    .run(gid, 'buyer1', 'OAuth: test', JSON.stringify(caps.map(c => ({ capability: c }))), FUTURE)
  db.prepare("INSERT INTO oauth_access_tokens (token_hash, grant_id, client_id, scope, aud, expires_at) VALUES (?,?,?,?,?,?)")
    .run(sha(oat), gid, 'cli_t', 'read', 'https://webaz.xyz/mcp', FUTURE)
}
mkOAuth('grt_full', 'oat_full_read', ['buyer_orders_read', 'buyer_orders_read_minimal', 'wallet_read_minimal'])
mkOAuth('grt_min', 'oat_min_read', ['buyer_orders_read_minimal'])
const PII = /SECRET|91234567|9 SECRET Rd/i
const O = (a: Record<string, unknown>) => (mcp as unknown as { handleBuyerOrders: (x: Record<string, unknown>) => Promise<Record<string, unknown>> }).handleBuyerOrders(a)
const W = (a: Record<string, unknown>) => (mcp as unknown as { handleWalletView: (x: Record<string, unknown>) => Promise<Record<string, unknown>> }).handleWalletView(a)
const dbSnapshot = (): string => {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'agent_grant_auth_log' ORDER BY name").all() as Array<{ name: string }>).map(t => t.name)
  return sha(JSON.stringify(tables.map(t => [t, sha(JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all()))])))
}
const auditCount = (): number => (db.prepare('SELECT COUNT(*) c FROM agent_grant_auth_log').get() as { c: number }).c

const before = dbSnapshot(); const auditBefore = auditCount()
try {
  clearCred()
  ok('F-1 no grant → GRANT_REQUIRED', (await O({ order_id: 'ord_f', full: true })).error_code === 'GRANT_REQUIRED')
  useCred('grt_min', 'oat_min_read', ['buyer_orders_read_minimal'])
  ok('F-2 NON-GRANDFATHERING: minimal-only grant → PERMISSION_REQUIRED on full (hint names buyer_orders_read)',
    await O({ order_id: 'ord_f', full: true }).then(r => r.error_code === 'PERMISSION_REQUIRED' && /buyer_orders_read/.test(String(r.hint))))
  ok('F-2b minimal view still works on the same grant', (await O({ order_id: 'ord_f' }) as { order?: { order_id?: string } }).order?.order_id === 'ord_f')

  useCred('grt_full', 'oat_full_read', ['buyer_orders_read', 'buyer_orders_read_minimal', 'wallet_read_minimal'])
  const F = await O({ order_id: 'ord_f', full: true })
  ok('F-3 FULL view assembled over a REAL oat_ bearer', (F.order as Record<string, unknown>)?.order_id === 'ord_f' && Array.isArray(F.timeline) && (F.timeline as unknown[]).length === 1, JSON.stringify(F).slice(0, 300))
  const ott = F.order_time_terms as Record<string, unknown>
  ok('F-4 FROZEN terms win over the mutated product row (snapshot 7d vs live 14d) + ddp', ott?.source === 'order_snapshot' && ott?.return_days === 7 && ott?.warranty_days === 90 && ott?.import_duty_terms === 'ddp', JSON.stringify(ott))
  const lg = F.logistics as Record<string, unknown>
  ok('F-5 logistics: region/fee/eta + Passkey-approved agent ship tracking', lg?.dest_region === 'SG' && lg?.shipping_fee === 2 && lg?.tracking === 'SG12345678', JSON.stringify(lg))
  const dl = F.deadlines as Record<string, unknown>
  ok('F-6 deadlines carry next_actor (same source as the human view)', typeof dl?.next_actor === 'string' || dl?.next_actor === null, JSON.stringify(dl).slice(0, 200))
  const rs = F.refund_status as Record<string, unknown>
  ok('F-7 refund status surfaces the refunded return request', Array.isArray(rs?.return_requests) && (rs.return_requests as Array<Record<string, unknown>>)[0]?.status === 'refunded' && (rs.return_requests as Array<Record<string, unknown>>)[0]?.refund_amount === 7.06, JSON.stringify(rs).slice(0, 250))
  const acts = F.available_actions as Array<Record<string, string>>
  const actsOf = async (id: string) => ((await O({ order_id: id, full: true })).available_actions as Array<Record<string, string>>).map(a => a.action)
  ok('F-8 delivered: confirm+dispute advertised, return NOT (route needs completed); executor tags on every action',
    acts.some(a => a.action === 'confirm_receipt') && acts.some(a => a.action === 'open_dispute')
    && !acts.some(a => a.action === 'request_return') && !acts.some(a => a.action === 'request_cancel')
    && acts.some(a => a.action === 'prepare_case' && a.executor === 'agent_tool' && a.tool === 'webaz_prepare_case')
    && acts.every(a => a.executor === 'human_order_page' || a.executor === 'agent_tool'), JSON.stringify(acts).slice(0, 300))
  // 谓词矩阵 = 与人类路由一字不差(Codex HIGH 回归)
  { const c = await actsOf('ord_c'); ok('F-8b completed + live return window → request_return advertised', c.includes('request_return') && !c.includes('confirm_receipt') && !c.includes('open_dispute'), JSON.stringify(c)) }
  { const cx = await actsOf('ord_cx'); ok('F-8c completed but window expired → return NOT advertised', !cx.includes('request_return'), JSON.stringify(cx)) }
  { const sh = await actsOf('ord_s'); ok('F-8d shipped: dispute yes, confirm NO (delivered-only per state machine)', sh.includes('open_dispute') && !sh.includes('confirm_receipt'), JSON.stringify(sh)) }
  { const pd = await actsOf('ord_p'); ok('F-8e paid escrow: dispute yes, NO buyer cancel (escrow has no unilateral cancel), NO confirm', pd.includes('open_dispute') && !pd.includes('request_cancel') && !pd.includes('confirm_receipt'), JSON.stringify(pd)) }
  { const dw = await actsOf('ord_dpw'); ok('F-8f direct_pay_window: pay+mark_paid и cancel advertised (orders-action same predicate)', dw.includes('pay_seller_offplatform_then_mark_paid') && dw.includes('request_cancel'), JSON.stringify(dw)) }
  { const dp = await actsOf('ord_dsp'); ok('F-8g disputed from delivered by THIS buyer → withdraw+confirm offered + mutual-cancel propose (domain helper)', dp.includes('withdraw_dispute_confirm_receipt') && dp.includes('mutual_cancel_propose'), JSON.stringify(dp)) }
  { const rm = await actsOf('ord_rm'); ok('F-8h refund_marked on DIRECT rail → confirm_refund_received (route gate = direct_p2p only); active request blocks a second return', rm.includes('confirm_refund_received') && !rm.includes('request_return'), JSON.stringify(rm)) }
  { const rme = await actsOf('ord_rme'); ok('F-8i refund_marked on ESCROW rail → NOT advertised (escrow refunds release from escrow, no manual confirm route)', !rme.includes('confirm_refund_received'), JSON.stringify(rme)) }
  { const pq = await actsOf('ord_pq'); ok('F-8j payment_query (dp): cancel + dispute advertised', pq.includes('request_cancel') && pq.includes('open_dispute'), JSON.stringify(pq)) }
  { const df = await actsOf('ord_df'); ok('F-8k delivery_failed: buyer dispute advertised (transitions allow-set completeness)', df.includes('open_dispute'), JSON.stringify(df)) }
  { const d2 = await actsOf('ord_dsp2'); ok('F-8l seller-initiated dispute → buyer gets NO withdraw action (initiator predicate)', !d2.includes('withdraw_dispute_confirm_receipt'), JSON.stringify(d2)) }
  ok('F-9 ZERO PII in the full view (address/phone/notes markers absent)', !PII.test(JSON.stringify(F)), JSON.stringify(F).slice(0, 200))
  const FB = await O({ order_id: 'ord_bad', full: true })
  ok('F-10 malformed {"v":1} snapshot → unavailable, NO crash', (FB.order_time_terms as Record<string, unknown>)?.source === 'unavailable' && (FB.order as Record<string, unknown>)?.order_id === 'ord_bad')
  ok('F-11 isolation: another buyer\'s order → ORDER_NOT_FOUND', (await O({ order_id: 'ord_other', full: true })).error_code === 'ORDER_NOT_FOUND')

  // ── 钱包最小只读 ──
  const Wv = await W({})
  ok('W-1 wallet view: balances + escrow + refund landing', Wv.available_balance === 92.94 && Wv.in_escrow === 7.06 && Wv.currency === 'WAZ' && (Wv.recent_refunds as Array<Record<string, unknown>>)[0]?.order_id === 'ord_f', JSON.stringify(Wv).slice(0, 250))
  ok('W-2 wallet projection KEY LOCK: read_only + NO withdraw/receive/credential surface',
    Wv.read_only === true && JSON.stringify(Object.keys(Wv).sort()) === JSON.stringify(['available_balance', 'currency', 'in_escrow', 'notes', 'read_only', 'recent_refunds']), JSON.stringify(Object.keys(Wv)))
  ok('W-2b RECURSIVE forbidden-key sweep (nested objects incl. recent_refunds carry no credential/receive-account shapes)',
    !/withdraw|receive_account|address|api_key|token|bank|seed|private/i.test(JSON.stringify(Wv).replace(/READ-ONLY forever[^"]*|no withdrawals[^"]*/gi, '')), JSON.stringify(Wv).slice(0, 200))
  useCred('grt_min', 'oat_min_read', ['buyer_orders_read_minimal'])
  ok('W-3 wallet without wallet_read_minimal → PERMISSION_REQUIRED', (await W({})).error_code === 'PERMISSION_REQUIRED')

  ok('Z-1 whole-DB content unchanged (read-only; audit log exempt and grown)', dbSnapshot() === before && auditCount() > auditBefore, `audit ${auditBefore}→${auditCount()}`)
} finally { server.close(); clearCred() }

if (fail > 0) { console.error(`\n❌ buyer-order-full FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ buyer-order-full: 全量只读 — 冻结条款权威 · 物流/截止/退款 · 动作面执行者诚实 · 钱包永远只读 · 零 PII · 零写\n  ✅ pass ${pass}`)
