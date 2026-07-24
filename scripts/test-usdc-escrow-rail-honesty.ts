#!/usr/bin/env tsx
/**
 * PR-B6b-1 — usdc_escrow rail honesty surfaces + rail-aware correctness.
 *
 * `payment_rail='usdc_escrow'` is REAL payment: real USDC, held by the WebAZ escrow contract on Base,
 * WebAZ never touches the principal. Before this PR, several disclosure surfaces were hard-coded as a
 * BINARY (`rail === 'direct_p2p' ? A : B`), so this rail was labelled "simulated escrow test — not real
 * USDC". At flip time that becomes a LIVE LIE.
 *
 * This test locks the fix in BOTH directions:
 *   A. usdc_escrow → on-chain/real custody wording, never "模拟 / simulated / 不代表真实".
 *   B. **WAZ honesty regression lock** — `escrow` and null/undefined (a legacy row missing the column IS
 *      WAZ) MUST still carry the "模拟托管" wording byte-for-byte. That sentence is TRUE for WAZ; deleting
 *      it while removing the lie for USDC would manufacture a NEW dishonesty. Over-deletion is the core
 *      risk of this PR, so it gets its own assertions.
 *   C. Every binary became an EXPLICIT branch whose DEFAULT is the WAZ/simulated semantics (fail-closed):
 *      a future rail can never be silently mislabelled as real custody.
 *   D. Two correctness bugs (not copy): usdc_escrow completed orders fell into NO GMV rail bucket
 *      (silently vanished from the seller analytics split), and the return-request modal labelled the
 *      currency of usdc orders as WAZ.
 *
 * Usage: npm run test:usdc-escrow-rail-honesty
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
process.env.HOME = mkdtempSync(join(tmpdir(), 'usdcrh-'))
import express, { type Request, type Response } from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'

const { railHonesty, projectOrderTimelineConsumer } = await import('../src/agent-model-projection.js')
const { initDatabase } = await import('../src/layer0-foundation/L0-1-database/schema.js')
const { applyWebazRuntimeSchema } = await import('../src/runtime/apply-webaz-runtime-schema.js')
const { setSeamDb } = await import('../src/layer0-foundation/L0-1-database/db.js')
const { registerAnalyticsRoutes } = await import('../src/pwa/routes/analytics.js')
const { registerSellerQuotaRoutes } = await import('../src/pwa/routes/seller-quota.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const SIM_ZH = /模拟|不代表真实/
const SIM_EN = /[Ss]imulated/

// ─────────────────────────────────────────────────────────────────────────────
// ① railHonesty — usdc_escrow is real on-chain custody
// ─────────────────────────────────────────────────────────────────────────────
const hUsdc = railHonesty('usdc_escrow')
ok('1a. railHonesty(usdc_escrow) says 链上(on-chain contract custody)', /链上/.test(hUsdc), hUsdc)
ok('1b. railHonesty(usdc_escrow) carries NO simulated/not-real wording', !SIM_ZH.test(hUsdc), hUsdc)
ok('1c. railHonesty(usdc_escrow) names USDC + 担保合约 and says the platform holds no principal',
  /USDC/.test(hUsdc) && /担保合约/.test(hUsdc) && /不经手本金/.test(hUsdc), hUsdc)

// ② WAZ honesty REGRESSION LOCK — the "模拟托管" sentence is TRUE for WAZ and must survive verbatim
const WAZ_HONESTY = '支付轨道:模拟托管测试 —— 本流程不代表真实 USDC 或法币结算'
ok('2a. railHonesty(escrow) still the verbatim WAZ simulated-custody disclosure', railHonesty('escrow') === WAZ_HONESTY, railHonesty('escrow'))
ok('2b. railHonesty(null) (legacy row missing the column = WAZ) still the verbatim WAZ disclosure', railHonesty(null) === WAZ_HONESTY, railHonesty(null))
ok('2c. railHonesty(undefined) still the verbatim WAZ disclosure', railHonesty(undefined) === WAZ_HONESTY, railHonesty(undefined))
ok('2d. fail-closed default: an UNKNOWN future rail falls back to the WAZ simulated wording, never to "real custody"',
  railHonesty('some_future_rail') === WAZ_HONESTY, railHonesty('some_future_rail'))

// ③ untouched rails — byte-for-byte string snapshots
ok('3a. railHonesty(direct_p2p) unchanged (byte-for-byte)',
  railHonesty('direct_p2p') === '买家直接向卖家付款;WebAZ 不托管本金;实际付款方式和币种以确认页面为准', railHonesty('direct_p2p'))
ok('3b. railHonesty(deferred) unchanged (byte-for-byte)',
  railHonesty('deferred') === '支付方式尚未选择 —— 将在确认页(webaz.xyz)从卖家支持的方式中选择,选定后才可 Passkey 批准', railHonesty('deferred'))

// ─────────────────────────────────────────────────────────────────────────────
// ④ railBadge / railBadgeEn + ⑤ refund note (projectOrderTimelineConsumer)
// ─────────────────────────────────────────────────────────────────────────────
const timeline = (rail: unknown): Record<string, unknown> => projectOrderTimelineConsumer({
  order: { order_id: 'o1', item_ref: 'p1', quantity: 1, amount: 10, status: 'completed', ...(rail === undefined ? {} : { payment_rail: rail }) },
  logistics: {}, timeline: [], available_actions: [],
  refund_status: { return_requests: [{ status: 'refunded', refund_amount: 10, created_at: '2026-07-24 00:00:00' }] },
}, null, () => 'USD')

const tUsdc = timeline('usdc_escrow'), tWaz = timeline('escrow'), tNull = timeline(null), tUndef = timeline(undefined), tDp = timeline('direct_p2p')
ok('4a. railBadge(usdc_escrow) = on-chain escrow (USDC · Base), no simulated wording',
  /链上合约担保/.test(String(tUsdc.rail_badge)) && !SIM_ZH.test(String(tUsdc.rail_badge)), String(tUsdc.rail_badge))
ok('4b. railBadgeEn(usdc_escrow) says on-chain / held by contract and contains NO "Simulated"',
  /[Oo]n-chain escrow/.test(String(tUsdc.rail_badge_en)) && !SIM_EN.test(String(tUsdc.rail_badge_en)), String(tUsdc.rail_badge_en))
const WAZ_BADGE = '模拟托管测试订单 — 不代表真实 USDC 或法币托管'
const WAZ_BADGE_EN = 'Simulated escrow test order — not real USDC or fiat custody'
ok('4c. railBadge(escrow) WAZ simulated badge survives byte-for-byte', tWaz.rail_badge === WAZ_BADGE, String(tWaz.rail_badge))
ok('4d. railBadgeEn(escrow) WAZ simulated badge survives byte-for-byte', tWaz.rail_badge_en === WAZ_BADGE_EN, String(tWaz.rail_badge_en))
ok('4e. railBadge(null) (legacy = WAZ) still the WAZ simulated badge, both languages',
  tNull.rail_badge === WAZ_BADGE && tNull.rail_badge_en === WAZ_BADGE_EN, String(tNull.rail_badge))
ok('4f. railBadge(missing column) (legacy = WAZ) still the WAZ simulated badge, both languages',
  tUndef.rail_badge === WAZ_BADGE && tUndef.rail_badge_en === WAZ_BADGE_EN, String(tUndef.rail_badge))
ok('4g. railBadge(direct_p2p) unchanged, both languages',
  tDp.rail_badge === '直付(WebAZ 不托管本金)' && tDp.rail_badge_en === 'Direct pay (WebAZ holds no principal)', String(tDp.rail_badge))

const refund = (t: Record<string, unknown>): Record<string, unknown> => (t.refund ?? {}) as Record<string, unknown>
ok('5a. refund note(usdc_escrow) has NO simulated semantics and names the on-chain contract release',
  !SIM_ZH.test(String(refund(tUsdc).note)) && /链上/.test(String(refund(tUsdc).note)), String(refund(tUsdc).note))
ok('5b. refund is_real_funds_flow(usdc_escrow) = true (real USDC moves on Base)', refund(tUsdc).is_real_funds_flow === true)
const WAZ_REFUND_NOTE = '模拟托管轨:退款按争议/退货结果从模拟托管释放,不代表真实 USDC 或法币资金流'
ok('5c. refund note(escrow) WAZ simulated wording survives byte-for-byte', refund(tWaz).note === WAZ_REFUND_NOTE, String(refund(tWaz).note))
ok('5d. refund note(null) (legacy = WAZ) still the WAZ simulated wording', refund(tNull).note === WAZ_REFUND_NOTE, String(refund(tNull).note))
ok('5e. refund is_real_funds_flow stays false for escrow / null / direct_p2p',
  refund(tWaz).is_real_funds_flow === false && refund(tNull).is_real_funds_flow === false && refund(tDp).is_real_funds_flow === false)
ok('5f. refund note(direct_p2p) unchanged (byte-for-byte)',
  refund(tDp).note === '协议已记录责任结果;本金未由 WebAZ 托管;实际退款需由买卖双方完成', String(refund(tDp).note))

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ widget BUILD ARTIFACT lock — widget-js.generated.ts must have been regenerated from src/
// ─────────────────────────────────────────────────────────────────────────────
const GEN = readFileSync('src/layer1-agent/L1-1-mcp-server/widgets/widget-js.generated.ts', 'utf8')
ok('6a. generated widget bundle carries the usdc_escrow rail-note branch (artifact WAS regenerated)',
  GEN.includes("String(rail)==='usdc_escrow'") && /your USDC is held by the WebAZ escrow contract on Base/.test(GEN))
ok('6b. generated widget bundle carries the usdc_escrow refund-meta branch',
  /On-chain escrow rail: the escrow contract on Base releases the real USDC/.test(GEN))
ok('6c. generated bundle: no "simulated escrow" string sits on a usdc_escrow line (the lie is gone for this rail)',
  !GEN.split('\\n').some(l => /usdc_escrow/.test(l) && /simulated escrow/i.test(l)))
ok('6d. generated bundle KEEPS the WAZ simulated wording for the default branch (both surfaces)',
  GEN.includes('Payment rail: simulated escrow test — this flow is not real USDC or fiat settlement')
  && GEN.includes('Simulated escrow rail: refunds release from simulated escrow per the dispute/return outcome'))

// ⑥bis. widget SOURCE keeps the same shape (so a future regen can't drift)
const WSRC = readFileSync('src/layer1-agent/L1-1-mcp-server/widgets/src/compat-core.ts', 'utf8')
ok('6e. widget source railNoteText: usdc_escrow branch precedes the WAZ default (explicit, fail-closed)',
  WSRC.indexOf("if(String(rail)==='usdc_escrow')") > -1
  && WSRC.indexOf("if(String(rail)==='usdc_escrow')") < WSRC.indexOf("return 'Payment rail: simulated escrow test"))

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ WAZ simulated banner — whitelist / fail-closed
// ─────────────────────────────────────────────────────────────────────────────
const g = globalThis as unknown as { window: Record<string, unknown>; t: (x: string) => string }
g.t = (x: string) => x; g.window = g as unknown as Record<string, unknown>
;(0, eval)(readFileSync('src/pwa/public/app-escrow-waz-sim.js', 'utf8'))
const banner = g.window.wazEscrowOrderBanner as (o: Record<string, unknown> | null, isBuyer: boolean) => string
ok('7a. banner is ON for the WAZ rail (payment_rail=escrow) — the true disclosure still renders',
  banner({ payment_rail: 'escrow' }, true).includes('测试托管订单'))
ok('7b. banner is ON for a legacy order with NO payment_rail (missing column = WAZ)',
  banner({ payment_rail: null }, true).includes('测试托管订单') && banner({}, true).includes('测试托管订单'))
ok('7c. banner is OFF for usdc_escrow (real on-chain custody must never wear the simulated banner)',
  banner({ payment_rail: 'usdc_escrow' }, true) === '')
ok('7d. banner is OFF for direct_p2p (unchanged)', banner({ payment_rail: 'direct_p2p' }, true) === '')
ok('7e. fail-closed whitelist: an UNKNOWN future rail gets NO simulated banner',
  banner({ payment_rail: 'some_future_rail' }, true) === '')
ok('7f. banner still gated on buyer + simulated-mode', banner({ payment_rail: 'escrow' }, false) === '' && banner(null, true) === '')

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ return-request modal currency label (app.js source lock — the template is inline in a 25k-line file)
// ─────────────────────────────────────────────────────────────────────────────
const APP = readFileSync('src/pwa/public/app.js', 'utf8')
ok('8a. return modal: currency is chosen by a WAZ WHITELIST (WAZ only for escrow/legacy; everything else USDC)',
  APP.includes("openReturnRequestModal('${order.id}', ${Number(order.total_amount)}, '${(!order.payment_rail || order.payment_rail === 'escrow') ? 'WAZ' : 'USDC'}')"))
ok('8b. return modal: the old direct_p2p binary (which labelled usdc_escrow orders as WAZ) is gone',
  !APP.includes("order.payment_rail === 'direct_p2p' ? 'USDC' : 'WAZ'"))
ok('8c. admin order list amount uses the same WAZ whitelist (usdc_escrow amounts are real USDC)',
  APP.includes("${o.total_amount} ${(!o.payment_rail || o.payment_rail === 'escrow') ? 'WAZ' : 'USDC'}"))

// ⑧bis. approval-card economic_effect (source lock): usdc_escrow branch present, WAZ default preserved
const APR = readFileSync('src/pwa/approval-requests-read.ts', 'utf8')
ok('8d. approval economic_effect: usdc_escrow branch says approval moves NO funds and is NOT simulated',
  /rail === 'usdc_escrow'[\s\S]{0,400}moves_funds: false, simulated: false/.test(APR))
ok('8e. approval economic_effect: the WAZ default branch still declares the SIMULATED test ledger',
  APR.includes('the escrow rail is a SIMULATED test ledger'))

// ─────────────────────────────────────────────────────────────────────────────
// ⑨ GMV rail buckets — usdc_escrow completed orders must land in a bucket of their own
// ─────────────────────────────────────────────────────────────────────────────
const db = initDatabase(); applyWebazRuntimeSchema(db); db.pragma('foreign_keys = OFF'); setSeamDb(db)
db.prepare("INSERT INTO users (id,name,role,api_key) VALUES ('s1','s1','seller','k_s1'),('b1','b1','buyer','k_b1')").run()
db.prepare("INSERT INTO products (id,seller_id,title,description,price,stock) VALUES ('p','s1','P','d',10,99)").run()
let oc = 0
const mk = (rail: string | null, status: string, total: number): void => {
  db.prepare("INSERT INTO orders (id,product_id,buyer_id,seller_id,quantity,unit_price,total_amount,escrow_amount,status,payment_rail,created_at) VALUES (?, 'p','b1','s1',1,?,?,0,?,?, datetime('now'))")
    .run(`o_${++oc}`, total, total, status, rail)
}
mk('escrow', 'completed', 100)          // WAZ 托管
mk('direct_p2p', 'completed', 200)      // 场外直接收款
mk('usdc_escrow', 'completed', 400)     // 链上合约担保(此前两桶都不进 = 凭空蒸发)
mk('usdc_escrow', 'cancelled', 900)     // 未完成:不计

const app = express(); app.use(express.json())
const auth = (req: Request, res: Response): Record<string, unknown> | null => {
  const u = req.headers['x-test-uid'] as string | undefined
  if (!u) { res.status(401).json({ error: 'login' }); return null }
  return { id: u, role: 'seller' }
}
registerAnalyticsRoutes(app, { db, auth } as never)
registerSellerQuotaRoutes(app, { db, auth, generateId: (p: string) => p + '_x', requireUsersAdmin: () => null, safeRoles: () => ['seller'], checkSellerCanList: () => ({ ok: true }), adminCanOperateOn: () => true, logAdminAction: () => {}, QUOTA_TIERS: [200, 500, 1000] } as never)
let server: Server
const port: number = await new Promise(r => { server = createServer(app); server.listen(0, () => r((server!.address() as { port: number }).port)) })
const get = (path: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const rq = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/api' + path, headers: { 'x-test-uid': 's1' } }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => resolve((() => { try { return JSON.parse(d) as Record<string, unknown> } catch { return {} } })()))
  })
  rq.on('error', reject); rq.end()
})

try {
  const a = (await get('/sellers/me/analytics?window=30')).orders as Record<string, number>
  ok('9a. analytics gmv_escrow = 100 (WAZ bucket unchanged)', Number(a.gmv_escrow) === 100, JSON.stringify(a))
  ok('9b. analytics gmv_direct_pay = 200 (unchanged)', Number(a.gmv_direct_pay) === 200)
  ok('9c. analytics gmv_usdc_escrow = 400 (NEW bucket — no longer vanishes)', Number(a.gmv_usdc_escrow) === 400)
  ok('9d. analytics: the three rail buckets sum to the total gmv (nothing evaporates)',
    Number(a.gmv_escrow) + Number(a.gmv_direct_pay) + Number(a.gmv_usdc_escrow) === Number(a.gmv), JSON.stringify(a))

  const s = (await get('/seller/insights')).summary as Record<string, number>
  ok('9e. insights gmv_escrow = 100 / gmv_direct_pay = 200 (unchanged)', Number(s.gmv_escrow) === 100 && Number(s.gmv_direct_pay) === 200, JSON.stringify(s))
  ok('9f. insights gmv_usdc_escrow = 400 (NEW bucket)', Number(s.gmv_usdc_escrow) === 400)
  ok('9g. insights: the three rail buckets sum to the total gmv',
    Number(s.gmv_escrow) + Number(s.gmv_direct_pay) + Number(s.gmv_usdc_escrow) === Number(s.gmv), JSON.stringify(s))

  // display chip: usdc_escrow alone must surface the split (previously invisible)
  ;(0, eval)(readFileSync('src/pwa/public/app-gmv-rail-split.js', 'utf8'))
  const split = g.window.gmvRailSplitHtml as (e: number, d: number, u?: number, f?: (n: number) => string) => string
  ok('9h. split chip: pure-WAZ seller still sees nothing (unchanged)', split(150, 0, 0) === '')
  const onlyUsdc = split(150, 0, 400)
  ok('9i. split chip: usdc-only seller now sees the on-chain bucket (was invisible before)',
    /链上担保/.test(onlyUsdc) && onlyUsdc.includes('400') && !/🤝/.test(onlyUsdc), onlyUsdc)   // 🤝 = 直接收款 chip(标题 tooltip 里的词不算渲染出的桶)
  const all3 = split(150, 200, 400)
  ok('9j. split chip: all three rails render distinctly', /托管/.test(all3) && /链上担保/.test(all3) && /直接收款/.test(all3) && all3.includes('150') && all3.includes('200') && all3.includes('400'), all3)

  // bilingual parity for the strings this PR introduced into the PWA
  const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
  ok('9k. bilingual: the new split-chip tooltip and 链上担保 label both have _EN entries',
    I18N.includes("'托管=平台托管收入;链上担保=USDC 存入链上合约,平台不经手本金;直接收款=场外收款,平台不经手':") && I18N.includes("'链上担保':"))
} finally { server!.close() }

if (fail > 0) { console.error(`\n❌ usdc-escrow-rail-honesty FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ usdc_escrow rail honesty: real on-chain custody wording on every disclosure surface, WAZ "simulated escrow" wording locked verbatim (both directions), fail-closed defaults, + GMV third bucket & return-modal currency fixed\n  ✅ pass ${pass}`)
