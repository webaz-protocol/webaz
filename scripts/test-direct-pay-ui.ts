#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — bilingual UI wiring source-contract test (PR-4f-b).
 *
 * Static source contract (no browser/server): reads the PWA .js + index.html + i18n.js as text and asserts
 *   the wiring exists, the honest non-custodial copy is present in BOTH zh and en, and that NO forbidden
 *   surface was introduced (no payment_method/provider/crypto/fiat selector; no wallet/escrow/settlement/
 *   refund/order-status mutation in the Direct Pay module). Mirrors test-connected-agents-ui.ts.
 *
 * Usage: npm run test:direct-pay-ui
 */
import { readFileSync } from 'node:fs'

const P = (f: string) => readFileSync(`src/pwa/public/${f}`, 'utf8')
const DP = P('app-direct-pay.js')      // the Direct Pay UI domain module (all logic here)
// comment-stripped view (for NEGATIVE assertions — the honest disclaimer comments name the very things we forbid)
const DPCODE = DP.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
const APP = P('app.js')                // hooks live here
const I18N = P('i18n.js')
const HTML = P('index.html')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const has = (hay: string, needle: string) => hay.includes(needle)

// ── 1. load order: app-direct-pay.js before app.js ──
ok('index.html loads app-direct-pay.js', has(HTML, '/app-direct-pay.js'))
ok('app-direct-pay.js loaded BEFORE app.js', HTML.indexOf('/app-direct-pay.js') < HTML.indexOf('/app.js') && HTML.indexOf('/app-direct-pay.js') > 0)

// ── 2. seller workbench: Direct Pay payment-instruction entry + GET/PUT/DELETE ──
ok('seller workbench has a settings sub-tab', /subTabBtn\('settings'/.test(APP))
ok('settings section calls dpSellerInstructionSection', has(APP, 'dpSellerInstructionSection'))
ok('settings tab hydrates instruction after render', has(APP, 'dpHydrateInstruction'))
ok('dpSellerInstructionSection defined', /dpSellerInstructionSection\s*=/.test(DP))
ok('UI reads instruction (GET)', /GET\('\/direct-receive\/payment-instruction'\)/.test(DP))
ok('UI saves instruction (PUT)', /PUT\('\/direct-receive\/payment-instruction'/.test(DP))
ok('UI deactivates instruction (DELETE)', /api\('DELETE',\s*'\/direct-receive\/payment-instruction'\)/.test(DP))
ok('instruction max length enforced client-side (maxlength 500)', /maxlength="500"/.test(DP))

// ── 3. buyer checkout: direct_p2p as an OPTIONAL rail; escrow default ──
ok('checkout renders rail selector', has(APP, 'dpRailSelectorHtml'))
ok('rail selector defines escrow + direct_p2p radios', /value="escrow"\s+checked/.test(DP) && /value="direct_p2p"/.test(DP))
ok('dpSelectedRail defaults to escrow', /dpSelectedRail\s*=.*\|\|\s*'escrow'/.test(DP))
ok('order create payload includes payment_rail', /payment_rail/.test(APP) && /window\.dpSelectedRail/.test(APP))
ok('direct_p2p create routes to dpAfterCreate', /payment_rail === 'direct_p2p'.*dpAfterCreate/.test(APP))

// ── 4. disclosure acks (pre_select + pre_confirm), Passkey-gated, after order exists ──
ok('acks POST to disclosure-acks endpoint', /POST\('\/direct-pay\/disclosure-acks'/.test(DP))
ok('acks cover pre_select AND pre_confirm', has(DP, 'pre_select') && has(DP, 'pre_confirm'))
ok('ack uses live Passkey gate (direct_pay_disclosure_ack)', /requestPasskeyGate\('direct_pay_disclosure_ack'/.test(DP))
ok('dpAfterCreate drives the ack flow', /dpAfterCreate\s*=/.test(DP) && has(DP, 'dpEnsureAcks'))

// ── 4b. BOUNDARY: instruction revealed ONLY AFTER D1/D2 acks, and sourced from the ack-gated order read (NOT the create response) ──
const AFTER = DP.slice(DP.indexOf('dpAfterCreate = async'), DP.indexOf('dpEnsureAcks = async'))
ok('dpAfterCreate runs dpEnsureAcks BEFORE reading the snapshot', AFTER.indexOf('dpEnsureAcks') < AFTER.indexOf('direct_pay_instruction_snapshot') && AFTER.includes('direct_pay_instruction_snapshot'))
ok('dpAfterCreate sources snapshot from GET /orders (not the create response)', /GET\(`\/orders\//.test(AFTER) && !/res\.payment_instruction/.test(DP))
ok('dpAfterCreate bails before reading snapshot when acks not completed', /if \(!acked\)[\s\S]*?return/.test(AFTER) && AFTER.indexOf('if (!acked)') < AFTER.indexOf('direct_pay_instruction_snapshot'))

// ── 5. order detail / actions: disclosures always shown; SNAPSHOT ack-gated; gated actions ──
ok('order detail shows direct_p2p disclosures', has(APP, 'dpOrderDisclosureHtml'))
ok('disclosure HTML does NOT inline the snapshot (not in DOM pre-ack)', !/direct_pay_instruction_snapshot/.test(DP.slice(DP.indexOf('dpOrderDisclosureHtml = '), DP.indexOf('dpHydrateOrderDisclosure'))))
ok('order detail hydrates snapshot via ack-gated path', has(APP, 'dpHydrateOrderDisclosure') && /dpHydrateOrderDisclosure\s*=/.test(DP))
const HYD = DP.slice(DP.indexOf('dpHydrateOrderDisclosure = async'), DP.indexOf('dpCompleteAcksThenReveal = async'))
ok('snapshot only read AFTER checking both-acked (st.both)', HYD.indexOf('st.both') < HYD.indexOf('direct_pay_instruction_snapshot') && HYD.includes('direct_pay_instruction_snapshot'))
ok('not-both-acked branch shows a "complete D1/D2" gate, not the snapshot', /!st\.both/.test(HYD) && has(HYD, 'dpCompleteAcksThenReveal') && !HYD.slice(HYD.indexOf('!st.both'), HYD.indexOf('dpCompleteAcksThenReveal') + 60).includes('direct_pay_instruction_snapshot'))
ok('getActions offers mark_paid in direct_pay_window', /direct_pay_window/.test(APP) && /'mark_paid'/.test(APP))
ok('handleAction routes direct_p2p gated actions to dpHandleAction', /_dpOrderRail === 'direct_p2p'.*dpHandleAction/.test(APP))
ok('order action uses Passkey gate (direct_pay_order_action)', /requestPasskeyGate\('direct_pay_order_action'/.test(DP))
ok('order action hits existing endpoints (action + confirm-in-person)', /\/orders\/\$\{orderId\}\/action/.test(DP) && /confirm-in-person/.test(DP))

// ── 5b. P2: clear register-Passkey entry for buyers without a Passkey ──
ok('register-Passkey prompt helper exists', /dpPromptRegisterPasskey\s*=/.test(DP))
ok('Passkey-gate failure offers registration (navigate to #me)', has(DP, 'dpPromptRegisterPasskey') && /navigate\('#me'\)/.test(DP))
ok('rail note links to Passkey registration (#me)', /href="#me"/.test(DP))

// ── 6. honest non-custodial copy — present in zh (source) AND en (i18n) ──
for (const zh of ['不托管', '不担保', '不退款', '不代维权', 'WebAZ 不验证付款方式或币种', '本金不经 WebAZ']) {
  ok(`zh copy present: ${zh}`, has(DP, zh))
}
ok('en copy: does not custody / guarantee / refund', /does not custody, guarantee, refund/i.test(I18N))
ok('en copy: does not verify the payment method or currency', /does not verify the payment method or currency/i.test(I18N))
ok('en copy: principal never passes through WebAZ', /principal never passes through WebAZ/i.test(I18N))

// ── 7. i18n parity — every new zh key has an EN entry (sample the load-bearing ones) ──
for (const k of [
  '支付方式', '直付(Direct Pay · 非托管)', '直付收款说明', '我已付款', '取消订单',
  '收款说明', '停用', '卖家尚未设置收款说明,暂不可直付', '直付需要先注册 Passkey',
  '需先完成两次风险披露确认(D1 + D2)', '订单尚未送达,暂不可确认收货',
  '这是你自填的收款展示文本(场外结算用);WebAZ 不验证付款方式或币种,不路由支付,不托管资金。',
]) {
  ok(`i18n EN present: ${k.slice(0, 16)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 8. NEGATIVE: no forbidden payment-capability surface in the Direct Pay module ──
ok('no payment_method selector', !/payment_method/.test(DPCODE))
ok('no payment_provider selector', !/payment_provider/.test(DPCODE))
ok('no crypto/fiat/USDC currency judgment or allowlist in UI', !/\b(crypto|fiat|USDC|allowlist)\b/i.test(DPCODE))
// UI-only: the Direct Pay module must NOT touch money/state endpoints (no wallet/escrow/settlement/refund writes,
// no order-status mutation beyond the existing disclosure-ack / order-action / instruction endpoints).
ok('no wallet endpoint call', !/\/wallet/.test(DPCODE))
ok('no escrow endpoint call', !/\/escrow/.test(DPCODE))
ok('no settlement endpoint call', !/\/settle/.test(DPCODE))
ok('no refund/returns endpoint call', !/\/refund|\/returns/.test(DPCODE))

if (fail > 0) { console.error(`\n❌ direct-pay UI (PR-4f-b) FAILED\n  ✅ pass ${pass}\n  ❌ fail ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ direct-pay UI (PR-4f-b): seller instruction CRUD + buyer rail/disclosure/ack + order-detail disclosures + Passkey-gated actions; bilingual copy + i18n parity; non-custodial, no payment-capability surface\n  ✅ pass ${pass}`)
