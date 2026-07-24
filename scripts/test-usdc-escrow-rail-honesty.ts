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
// 1c — B6b-2 B1:「平台不经手本金」不可辩护(合约按 feeBps 从担保额扣平台费到 treasury,且仲裁 key 可对 Funded
//   单 flag+裁决分账)。可辩护的表述:合约只认买家/卖家/平台费三个去向,平台无法转给任意地址。
ok('1c. railHonesty(usdc_escrow) names USDC + 担保合约 and makes the BOUNDED claim (three destinations, no arbitrary address)',
  /USDC/.test(hUsdc) && /担保合约/.test(hUsdc) && /任意地址/.test(hUsdc) && /平台费/.test(hUsdc), hUsdc)
ok('1d. railHonesty(usdc_escrow) no longer claims 平台不经手本金 (the contract deducts a platform fee from the escrowed amount)',
  !/不经手本金/.test(hUsdc), hUsdc)

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
// 5a/5b — B6b-2 A3 推翻了上一轮的主张:此 refund 块【只在有退货申请时】渲染,而退货要求订单 completed;本轨走到
//   completed 必然是链上已 Released(终态)→ 合约此刻不可能再退款(arbiterResolve 要 Disputed、flagDispute 要
//   Funded),协议内仲裁对本轨还被 B3 硬拒到 B7,而 autoRelease 是【付给卖家】。故:无模拟语义(仍然对),但
//   绝不承诺链上退款,且 is_real_funds_flow 对所有轨都是 false。
ok('5a. refund note(usdc_escrow) has NO simulated semantics, and promises NO on-chain refund payout',
  !SIM_ZH.test(String(refund(tUsdc).note)) && /链上/.test(String(refund(tUsdc).note))
  && /协议外/.test(String(refund(tUsdc).note))
  && !/由担保合约在 Base 链上直接放款/.test(String(refund(tUsdc).note))
  && !/是真实 USDC 资金流/.test(String(refund(tUsdc).note)), String(refund(tUsdc).note))
ok('5b. refund is_real_funds_flow is false on EVERY rail (a post-completion return refund is never an on-chain flow today)',
  refund(tUsdc).is_real_funds_flow === false, JSON.stringify(refund(tUsdc)))
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
ok('6b. generated widget bundle carries the usdc_escrow refund-meta branch, and it does NOT promise an on-chain refund',
  /On-chain escrow rail: the principal was held by the escrow contract on Base/.test(GEN)
  && !/releases the real USDC per the arbitration outcome/.test(GEN))
// 6c — 上一轮这条是【空守卫】:在 main 上也通过,因为改前那一行含的是 'direct_p2p' 而非 'usdc_escrow',
//   `some()` 对空集恒 false。改成能真正检出回归的形式:先断言样本集非空(6c-pre),再断言其中无模拟措辞。
//   (bundle 把源码嵌成一个带转义 \n 的字符串字面量,故按【转义换行】切才得到逻辑行。)
const genRailNoteLines = GEN.split('\\n').filter(l => /usdc_escrow/.test(l))
ok('6c-pre. the bundle really does contain usdc_escrow lines (guards against a vacuously-true 6c)', genRailNoteLines.length >= 2, String(genRailNoteLines.length))
ok('6c. generated bundle: no "simulated"/"not real USDC" wording sits on any usdc_escrow line (the lie is gone for this rail)',
  !genRailNoteLines.some(l => /simulated|not real USDC/i.test(l)), genRailNoteLines.find(l => /simulated|not real USDC/i.test(l)) || '')
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
  APP.includes("openReturnRequestModal('${order.id}', ${Number(order.total_amount)}, '${(!order.payment_rail || order.payment_rail === 'escrow') ? 'WAZ' : 'USDC'}', '${order.payment_rail || 'escrow'}')"))
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
// ⑩ B6b-2 round-2 audit fixes — the HUMAN consent surface must say what the machine surface says,
//    and no copy may describe something the code cannot do today (B7 / on-chain arbitration is unwired).
// ─────────────────────────────────────────────────────────────────────────────
const rd = (p: string): string => readFileSync(p, 'utf8')
const SUBMIT = rd('src/pwa/public/app-agent-approvals-submit.js')
const I18N_SRC = rd('src/pwa/public/i18n.js')

// A1 — the Passkey order-submit card (human side). Was rendering the WAZ default: "扣款入托管 / 模拟测试轨".
ok('10a. A1 approval card has an explicit usdc_escrow rail line', /payment_rail === 'usdc_escrow'/.test(SUBMIT), '')
ok('10a2. A1 usdc_escrow line says approval creates the order and debits NO WebAZ balance',
  /链上合约担保 —— 批准只创建订单,不从任何 WebAZ 余额扣款/.test(SUBMIT), '')
ok('10a3. A1 usdc_escrow line names the buyer\'s own wallet deposit into the Base contract',
  /用自己的链上钱包把真实 USDC 存入 Base 上的 WebAZ 担保合约/.test(SUBMIT), '')
ok('10a4. A1 the WAZ default line survives byte-for-byte (its "simulated / debits your wallet" wording is TRUE for WAZ)',
  SUBMIT.includes("t('托管(批准后立即从你的钱包扣款入托管)—— 模拟测试轨,金额以 USDC 显示为别名,不代表真实 USDC 或法币托管/结算')"), '')
ok('10a5. A1 bilingual: the new zh line has an _EN entry', I18N_SRC.includes("'链上合约担保 —— 批准只创建订单,不从任何 WebAZ 余额扣款;之后需你用自己的链上钱包把真实 USDC 存入 Base 上的 WebAZ 担保合约,链上确认后订单才进入已付款':"), '')

// A2 — buyer_action card unit + the confirm_receipt refusal (runtime assertion lives in ⑪).
const AABUY = rd('src/pwa/public/app-agent-approvals-buyer.js')
ok('10b. A2 buyer-action card picks the unit from a WAZ whitelist (no bare " WAZ" literal on the settlement head)',
  /\(!snap\.rail \|\| snap\.rail === 'escrow'\) \? 'WAZ' : 'USDC'/.test(AABUY) && !/waz\(snap\.settlement_total\) \+ ' WAZ'/.test(AABUY), '')

// A4 — the OAuth REST full view (no projection layer sits under it).
const FULL = rd('src/pwa/buyer-order-full-view.ts')
ok('10c. A4 REST refund_status has an explicit usdc_escrow branch', /rail === 'usdc_escrow'/.test(FULL), '')
ok('10c2. A4 usdc_escrow branch no longer claims "escrow currently simulated WAZ" and promises no WebAZ refund',
  /WebAZ cannot issue a refund here/.test(FULL) && /on-chain arbitration refunds are not wired yet/.test(FULL), '')
ok('10c3. A4 the WAZ default branch keeps its (true) simulated disclosure',
  FULL.includes('Escrow-rail refunds release from escrow per dispute/return outcomes (escrow currently simulated WAZ).'), '')

// A5 — return modal hint: was `cur === 'USDC'`, which called a usdc_escrow order "直付".
ok('10d. A5 return-modal hint branches on RAIL, not on the currency label', !APP.includes("${cur === 'USDC' ? ' · ' + t('直付退款在协议外完成,金额为参考') : ''}"), '')
ok('10d2. A5 usdc_escrow gets an honest hint that does NOT contain the word 直付',
  APP.includes("rail === 'usdc_escrow' ? ' · ' + t('本轨退款由买卖双方在协议外完成,金额为参考')") && I18N_SRC.includes("'本轨退款由买卖双方在协议外完成,金额为参考':"), '')
ok('10d3. A5 direct_p2p keeps its original hint', APP.includes("rail === 'direct_p2p' ? ' · ' + t('直付退款在协议外完成,金额为参考')"), '')

// A6 — the return handshake is a dead end for this rail: fail-closed at the entrance (runtime in ⑪).
const RET = rd('src/pwa/routes/returns.ts')
ok('10e. A6 returns /decide refuses accept for usdc_escrow with a distinct error_code',
  /decision === 'accept' && railRow\?\.payment_rail === 'usdc_escrow'/.test(RET) && /USDC_ESCROW_RETURN_NOT_WIRED/.test(RET), '')
ok('10e2. A6 returns /received also refuses usdc_escrow (in-flight rows can never land in await_refund)',
  (RET.match(/USDC_ESCROW_RETURN_NOT_WIRED/g) || []).length >= 2, '')
ok('10e3. A6 the error_code is bilingual-mapped for the UI',
  rd('src/pwa/public/app-order-errors.js').includes('USDC_ESCROW_RETURN_NOT_WIRED') && I18N_SRC.includes("'USDC 担保订单的退货退款需链上退款(接线中),请在订单页与对方协商或发起争议':"), '')
ok('10e4. A6 the seller "accept refund" buttons render a disabled honest state on this rail',
  (APP.match(/order\.payment_rail === 'usdc_escrow' \? `<button class="btn btn-sm"[^`]*disabled>\$\{t\('接受退款\(链上退款接线中\)'\)\}<\/button>`/g) || []).length === 2
  && I18N_SRC.includes("'接受退款(链上退款接线中)':"), '')

// A7 — the GMV/AOV headline unit.
ok('10f. A7 the 30-day GMV headline is no longer labelled WAZ (repo convention = app-seller.js "GMV (USDC)")',
  APP.includes('${Number(s.gmv||0).toFixed(0)} <span style="font-size:11px;font-weight:600;color:#6b7280">USDC</span>'), '')
ok('10f2. A7 客单价 (AOV) uses the same unit as the GMV it derives from',
  APP.includes('${Number(s.aov||0).toFixed(1)} <span style="font-size:11px;font-weight:600;color:#6b7280">USDC</span>'), '')

// A8 — two promises of a WAZ refund that no code performs.
const MC = rd('src/pwa/public/app-mutual-cancel.js')
ok('10g. A8 mutual-cancel card: usdc_escrow no longer promises 货款全额退回买家 (backend returns *_MUTUAL_CANCEL_NOT_WIRED)',
  /payment_rail === 'usdc_escrow' \? t\('链上合约担保:本金在链上合约中,协商取消需链上退款\(接线中\),本轨暂不可执行'\)/.test(MC), '')
ok('10g2. A8 mutual-cancel card keeps the (true) WAZ escrow settlement note', MC.includes("t('托管:货款全额退回买家,卖家质押原样返还')"), '')
ok('10g3. A8 overdue consequence: usdc_escrow says enforcement is on-chain (engine.ts `continue`s — nothing runs in the DB)',
  APP.includes("order.payment_rail === 'usdc_escrow' ? '本轨超时执法在链上:协议内不判责、不动资金;担保合约到期无争议后自动放款给卖家'")
  && I18N_SRC.includes("'本轨超时执法在链上:协议内不判责、不动资金;担保合约到期无争议后自动放款给卖家':"), '')

// A9 — return timeline unit (was hard-coded WAZ with NO rail check at all).
ok('10h. A9 return-timeline created event picks its unit from the rail', APP.includes("${ev.meta?.refund_amount || 0} ${(!rail || rail === 'escrow') ? 'WAZ' : 'USDC'}"), '')
ok('10h2. A9 the rail is actually threaded from the order into buildReturnTimelineEvent',
  APP.includes('function buildReturnTimelineEvent(ev, isMeBuyer, rail)') && APP.includes('buildReturnTimelineEvent(ev, isBuyer, order.payment_rail)'), '')

// B1 — "the platform never touches the principal" is not defensible (feeBps to treasury + arbiter key).
const PROJ = rd('src/agent-model-projection.ts')
const CORE = rd('src/layer1-agent/L1-1-mcp-server/widgets/src/compat-core.ts')
ok('10i. B1 projection railHonesty(usdc_escrow) drops 不经手本金 and states the bounded claim', !/不经手本金'/.test(PROJ.slice(PROJ.indexOf("=== 'usdc_escrow'"), PROJ.indexOf("=== 'usdc_escrow'") + 400)), '')
ok('10i2. B1 widget railNoteText drops "WebAZ never touches the principal" and names the three destinations',
  !/never touches the principal'/.test(CORE) && /can only pay the buyer, the seller, or the platform fee/.test(CORE), '')
ok('10i3. B1 approval economic_effect drops "never holds the principal" and names the arbiter split',
  !/never holds the principal/.test(APR) && /the platform arbiter key decides the split/.test(APR), '')

// B2 — usdc_escrow disputes CAN be created (only the ruling is fail-closed) → they really show up in queues.
const ADM = rd('src/pwa/public/app-admin-disputes.js')
ok('10j. B2 admin dispute list has a usdc_escrow rail badge', /rail === 'usdc_escrow'/.test(ADM), '')
ok('10j2. B2 admin dispute list amount uses the WAZ whitelist (no bare " WAZ" literal)',
  ADM.includes("${(!d.payment_rail || d.payment_rail === 'escrow') ? 'WAZ' : 'USDC'}") && !/\$\{d\.total_amount\} WAZ/.test(ADM), '')
const MCPS = rd('src/layer1-agent/L1-1-mcp-server/server.ts')
ok('10j3. B2 MCP arbitrator dispute list labels usdc_escrow as USDC and says the in-protocol ruling is unwired',
  /d\.payment_rail === 'usdc_escrow' \? `\$\{d\.total_amount\} USDC（链上合约担保·协议内裁决未接线）`/.test(MCPS), '')

// B4 — the agent draft REST view (display only; the quote row still stores the literal 'WAZ').
const DRAFT = rd('src/pwa/order-draft.ts')
ok('10k. B4 draft view projects USDC for usdc_escrow (display only — storage untouched)',
  /railStr === 'usdc_escrow' \? 'USDC' : String\(row\.currency \?\? 'WAZ'\)/.test(DRAFT), '')
ok('10k2. B4 the "an escrow order will debit at creation" note is not shown for a rail that debits nothing',
  /creating the order itself debits nothing/.test(DRAFT), '')

// B5 — dead-deposit notification promised a refund mechanism that does not exist.
const NOTIF = rd('src/pwa/public/app-notif-templates-usdc-escrow.js')
ok('10l. B5 dead-deposit notices no longer promise 平台将协助你处理链上退款 / 平台正在处理链上退款',
  !/平台将协助你处理链上退款/.test(NOTIF) && !/平台正在处理链上退款/.test(NOTIF), '')
ok('10l2. B5 they state what is actually true (funds still in the contract + alerted + manual follow-up), bilingually',
  /平台已收到告警并会人工跟进/.test(NOTIF) && I18N_SRC.includes('the platform has been alerted and will follow up manually'), '')

// B6 — the model-visible tools/list schema description.
ok('10m. B6 rail_note schema description is three-rail, not the old binary',
  /escrow \(WAZ\) = simulated, not real custody; usdc_escrow = real USDC held by the on-chain contract on Base; direct_p2p = no principal held/
    .test(rd('src/layer1-agent/L1-1-mcp-server/tool-output-schemas.ts')), '')

// B8 — the orphaned two-rail tooltip key is gone (i18n has dup/parity tests, so it must be a clean delete).
ok('10n. B8 the orphaned two-rail GMV tooltip key is deleted', !I18N_SRC.includes("'托管=平台托管收入;直接收款=场外收款,平台不经手':"), '')

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
// B6b-2 B7 —— 让「桶和 === gmv」成为【属性】而非 fixture 算术:
mk(null, 'completed', 50)               // NULL 轨(历史单缺列)= WAZ 桶(SQL COALESCE 与 JS ?? 必须一致)
mk('some_future_rail', 'completed', 7)  // 未知的第 4 条轨 → 必须落进 gmv_other,不许蒸发、也不许被并进 WAZ 桶
mk('', 'completed', 3)                  // 脏数据('' ≠ NULL):旧 JS 的 `|| 'escrow'` 会把它算进 WAZ 桶,SQL 不会 —— 两处谓词分歧的实证

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
  ok('9a. analytics gmv_escrow = 150 (WAZ bucket = explicit escrow 100 + NULL-rail legacy 50; the "" row is NOT WAZ)', Number(a.gmv_escrow) === 150, JSON.stringify(a))
  ok('9b. analytics gmv_direct_pay = 200 (unchanged)', Number(a.gmv_direct_pay) === 200)
  ok('9c. analytics gmv_usdc_escrow = 400 (NEW bucket — no longer vanishes)', Number(a.gmv_usdc_escrow) === 400)
  ok('9c2. analytics gmv_other = 10 (unknown 4th rail 7 + dirty "" 3) — B6b-2 B7 residual bucket', Number(a.gmv_other) === 10, JSON.stringify(a))
  ok('9d. analytics: buckets + other === total gmv — a PROPERTY, so a future 4th rail can never evaporate',
    Number(a.gmv_escrow) + Number(a.gmv_direct_pay) + Number(a.gmv_usdc_escrow) + Number(a.gmv_other) === Number(a.gmv), JSON.stringify(a))

  const s = (await get('/seller/insights')).summary as Record<string, number>
  ok('9e. insights gmv_escrow = 150 / gmv_direct_pay = 200 (JS predicate now matches the SQL COALESCE — "" is NOT WAZ)', Number(s.gmv_escrow) === 150 && Number(s.gmv_direct_pay) === 200, JSON.stringify(s))
  ok('9f. insights gmv_usdc_escrow = 400 (NEW bucket)', Number(s.gmv_usdc_escrow) === 400)
  ok('9f2. insights gmv_other = 10 (residual bucket, same value as the SQL implementation)', Number(s.gmv_other) === 10, JSON.stringify(s))
  ok('9g. insights: buckets + other === total gmv (property, not fixture arithmetic)',
    Number(s.gmv_escrow) + Number(s.gmv_direct_pay) + Number(s.gmv_usdc_escrow) + Number(s.gmv_other) === Number(s.gmv), JSON.stringify(s))
  ok('9g2. the two implementations (SQL in analytics.ts, JS in seller-quota.ts) agree bucket-for-bucket',
    Number(a.gmv_escrow) === Number(s.gmv_escrow) && Number(a.gmv_direct_pay) === Number(s.gmv_direct_pay)
    && Number(a.gmv_usdc_escrow) === Number(s.gmv_usdc_escrow) && Number(a.gmv_other) === Number(s.gmv_other),
    JSON.stringify({ sql: a, js: s }))

  // display chip: usdc_escrow alone must surface the split (previously invisible)
  ;(0, eval)(readFileSync('src/pwa/public/app-gmv-rail-split.js', 'utf8'))
  const split = g.window.gmvRailSplitHtml as (e: number, d: number, u?: number, f?: ((n: number) => string) | null, o?: number) => string
  ok('9h. split chip: pure-WAZ seller still sees nothing (unchanged)', split(150, 0, 0) === '')
  const onlyOther = split(150, 0, 0, null, 10)
  ok('9h2. split chip: a residual-only seller now sees the other bucket (B6b-2 B7 — was invisible)',
    /其他支付轨/.test(onlyOther) && onlyOther.includes('10'), onlyOther)
  ok('9h3. split chip: the other bucket is hidden when it is zero (no noise for normal sellers)',
    !/其他支付轨/.test(split(150, 200, 400, null, 0)), split(150, 200, 400, null, 0))
  const onlyUsdc = split(150, 0, 400)
  ok('9i. split chip: usdc-only seller now sees the on-chain bucket (was invisible before)',
    /链上担保/.test(onlyUsdc) && onlyUsdc.includes('400') && !/🤝/.test(onlyUsdc), onlyUsdc)   // 🤝 = 直接收款 chip(标题 tooltip 里的词不算渲染出的桶)
  const all3 = split(150, 200, 400)
  ok('9j. split chip: all three rails render distinctly', /托管/.test(all3) && /链上担保/.test(all3) && /直接收款/.test(all3) && all3.includes('150') && all3.includes('200') && all3.includes('400'), all3)

  // bilingual parity for the strings this PR introduced into the PWA
  const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
  ok('9k. bilingual: the new split-chip tooltip and 链上担保 label both have _EN entries',
    I18N.includes("'托管=平台托管收入;链上担保=USDC 存入链上合约,平台不能转给任意地址(合约只认买家/卖家/平台费);直接收款=场外收款,平台不经手':") && I18N.includes("'链上担保':"))
  // B6b-2 收尾:tooltip 不得再出现"平台不经手本金"式的过度承诺(合约按 feeBps 从担保金额扣平台费,
  //   且仲裁 key 可对 Funded 单 flag+裁决分账)—— 与 B1 在投影/widget/审批三处的收敛同一口径。
  ok('9k1. split-chip tooltip drops the over-claim (no 不经手本金 / never touches the principal)',
    !readFileSync('src/pwa/public/app-gmv-rail-split.js', 'utf8').includes('平台不经手本金')
    && !/On-chain escrow[^;]*never touches the principal/.test(I18N))
  ok('9k2. bilingual: the residual-bucket label has an _EN entry', I18N.includes("'其他支付轨':"))
} finally { server!.close() }

// ─────────────────────────────────────────────────────────────────────────────
// ⑪ RUNTIME behaviour (not source locks) — A2 refusal + A6 dead-end fail-closed
// ─────────────────────────────────────────────────────────────────────────────
const { createBuyerActionRequest } = await import('../src/pwa/buyer-action-agent.js')
const { registerReturnsRoutes } = await import('../src/pwa/routes/returns.js')

// A2 — a confirm_receipt request must NOT be generated for usdc_escrow: the executor (orders-action.ts)
//   hard-409s it, so generating one only makes a human sign a Passkey for a doomed action.
db.prepare("UPDATE orders SET status='delivered' WHERE id='o_3'").run()   // o_3 = usdc_escrow
db.prepare("UPDATE orders SET status='delivered' WHERE id='o_1'").run()   // o_1 = WAZ escrow (control)
const mkReq = (orderId: string): Record<string, unknown> => createBuyerActionRequest(db, {
  humanId: 'b1', grantId: 'g1', agentLabel: 'a', orderId, action: 'confirm_receipt', generateId: (p: string) => `${p}_${orderId}`,
}) as unknown as Record<string, unknown>
const usdcConfirm = mkReq('o_3')
ok('11a. A2 confirm_receipt is REFUSED for usdc_escrow (no Passkey request is created for a doomed action)',
  usdcConfirm.ok === false && usdcConfirm.error_code === 'USDC_ESCROW_CONFIRM_NOT_WIRED', JSON.stringify(usdcConfirm))
ok('11a2. A2 the refusal shares the executor\'s error_code (orders-action.ts hard-409)',
  readFileSync('src/pwa/routes/orders-action.ts', 'utf8').includes('USDC_ESCROW_CONFIRM_NOT_WIRED'))
ok('11a3. A2 no request row was written for the refused usdc_escrow action',
  Number((db.prepare("SELECT COUNT(*) c FROM agent_permission_requests WHERE order_id='o_3'").get() as { c: number }).c) === 0)
ok('11a4. A2 REGRESSION LOCK: the WAZ escrow rail still generates a confirm_receipt request (nothing over-blocked)',
  mkReq('o_1').ok === true, JSON.stringify(mkReq('o_1')))

// A6 — the return handshake: request can be filed, but the seller CANNOT accept and the row never
//   reaches await_refund (every exit of the off-protocol handshake requires direct_p2p → permanent dead end).
db.prepare("UPDATE orders SET status='completed' WHERE id IN ('o_1','o_3')").run()
try { db.exec('ALTER TABLE return_requests ADD COLUMN pickup_requested INTEGER DEFAULT 0') } catch { /* 镜像 server.ts 的运行时 DDL(取件流是 A6 真正会搁浅的路径) */ }
db.prepare("INSERT INTO return_requests (id, order_id, product_id, buyer_id, seller_id, reason, refund_amount, status, pickup_requested) VALUES ('rr_u','o_3','p','b1','s1','quality',400,'pending',0),('rr_w','o_1','p','b1','s1','quality',100,'pending',0),('rr_p','o_3','p','b1','s1','damaged',400,'pending',1)").run()
try { db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('s1',1000),('b1',0)").run() } catch { /* schema variant without wallets seed — the WAZ control below tolerates a settlement failure, it only locks the ABSENCE of the usdc gate */ }
const app2 = express(); app2.use(express.json())
registerReturnsRoutes(app2, {
  db, generateId: (p: string) => `${p}_t`, auth: (req: Request, res: Response) => auth(req, res),
  isTrustedRole: () => false, errorRes: (res: Response, st: number, code: string, msg: string) => { res.status(st).json({ error: msg, error_code: code }) },
  broadcastSystemEvent: () => {}, detectFraud: () => [],
} as never)
let server2: Server
const port2: number = await new Promise(r => { server2 = createServer(app2); server2.listen(0, () => r((server2!.address() as { port: number }).port)) })
const post = (path: string, body: unknown, uid: string): Promise<{ status: number; body: Record<string, unknown> }> => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body)
  const rq = httpRequest({ host: '127.0.0.1', port: port2, method: 'POST', path: '/api' + path, headers: { 'x-test-uid': uid, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode || 0, body: (() => { try { return JSON.parse(d) as Record<string, unknown> } catch { return {} } })() }))
  })
  rq.on('error', reject); rq.write(payload); rq.end()
})
try {
  const dec = await post('/return-requests/rr_u/decide', { decision: 'accept' }, 's1')
  // 实证的旧行为(未修代码):这里返回 NOT_DIRECT_PAY「仅直付订单走场外退款握手」—— 对 usdc_escrow 卖家是
  //   误导性错误(他的单本来就不是直付),且不给任何出路。新行为 = 诚实的分轨码 + 可操作指引。
  ok('11b. A6 seller accept is REFUSED for usdc_escrow with the honest rail-specific code (was the misleading NOT_DIRECT_PAY)',
    dec.status === 409 && dec.body.error_code === 'USDC_ESCROW_RETURN_NOT_WIRED', JSON.stringify(dec))
  const st = (db.prepare("SELECT status FROM return_requests WHERE id='rr_u'").get() as { status: string }).status
  ok('11b2. A6 the return row NEVER enters await_refund (no buttons, no endpoints exist for this rail there)',
    st === 'pending', st)
  // 取件流才是真正会【搁浅】的路径:accept 不经 enterAwaitRefund → 未修代码会落 accepted_pickup_pending,
  //   一路到 /received 才撞墙,退货卡在中间态无终态。修后必须在入口就拒。
  const pick = await post('/return-requests/rr_p/decide', { decision: 'accept' }, 's1')
  const stP = (db.prepare("SELECT status FROM return_requests WHERE id='rr_p'").get() as { status: string }).status
  ok('11b1b. A6 the PICKUP accept path is refused too (it bypasses enterAwaitRefund and would strand the return)',
    pick.status === 409 && pick.body.error_code === 'USDC_ESCROW_RETURN_NOT_WIRED', JSON.stringify(pick))
  ok('11b1c. A6 the pickup return never reaches accepted_pickup_pending (the stranding state)', stP === 'pending', stP)
  const rej = await post('/return-requests/rr_u/decide', { decision: 'reject', response: '不同意' }, 's1')
  ok('11b3. A6 rejecting a return is still allowed on this rail (only the money-moving accept is fail-closed)',
    rej.status === 200 && (db.prepare("SELECT status FROM return_requests WHERE id='rr_u'").get() as { status: string }).status === 'rejected', JSON.stringify(rej))
  const wazDec = await post('/return-requests/rr_w/decide', { decision: 'accept' }, 's1')
  ok('11b4. A6 REGRESSION LOCK: the WAZ escrow rail\'s accept path is untouched (not over-blocked)',
    wazDec.status !== 409 || wazDec.body.error_code !== 'USDC_ESCROW_RETURN_NOT_WIRED', JSON.stringify(wazDec))
} finally { server2!.close() }

if (fail > 0) { console.error(`\n❌ usdc-escrow-rail-honesty FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ usdc_escrow rail honesty: real on-chain custody wording on every disclosure surface, WAZ "simulated escrow" wording locked verbatim (both directions), fail-closed defaults, human Passkey card == machine economic_effect, no promise of the unwired on-chain arbitration refund, + GMV residual bucket & unified rail predicate\n  ✅ pass ${pass}`)
