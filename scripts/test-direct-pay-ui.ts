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
const FEEOPS = P('app-direct-pay-fee-ops.js')   // PR-B: Direct Pay 商户运营 hub + 平台服务费(预充值)账户
const I18N = P('i18n.js')
const HTML = P('index.html')
const WAZ = P('app-escrow-waz-sim.js')  // [ESCROW-WAZ-SIM] 模拟币提醒 + 强制显式选 rail

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
ok('rail selector defines escrow + direct_p2p radios', /value="escrow"/.test(DP) && /value="direct_p2p"/.test(DP))
// [ESCROW-WAZ-SIM] escrow 不再硬预选;模拟期(_wazSimulated)不带 checked,强制买家显式选择(真实启用置 false 后恢复 checked)。
ok('[ESCROW-WAZ-SIM] escrow pre-select gated on !_wazSimulated', /value="escrow"\s+\$\{window\._wazSimulated \? '' : 'checked'\}/.test(DP) && /window\._wazSimulated \? '' : 'escrow'/.test(DP))
// #28 (permanent, not sim-gated): direct_p2p selected but availability unconfirmed → dpSelectedRail() returns '' (never silently falls back to escrow); the checkout gate blocks on any empty rail so the backend never receives an empty payment_rail that it would create as escrow.
ok('#28 dpSelectedRail returns empty for direct_p2p-not-available (no silent escrow fallback)', /if \(c === 'direct_p2p'\) return window\._dpDirectAvailable === true \? 'direct_p2p' : ''/.test(DP))
ok('#28 checkout blocks on empty payment_rail (general, not radio-checked)', /if \(!payment_rail\)/.test(APP) && /dp-rail-block[\s\S]{0,40}open\s*=\s*true/.test(APP))
// P2 (review): the buy button must NOT closeSheet() inline — that would immediately hide the block prompt + the auto-expanded selector. doBuy closes the sheet itself, only after rail validation passes.
ok('P2 buy button onclick does not closeSheet inline', /onclick="doBuy\([^"]*\)"/.test(APP) && !/doBuy\([^"]*\);\s*closeSheet\(\)/.test(APP))
ok('P2 doBuy closes sheet only after rail validation passes (block branch returns first)', /return \}\s*if \(window\.closeSheet\) window\.closeSheet\(\)/.test(APP))
ok('[ESCROW-WAZ-SIM] app-escrow-waz-sim.js loaded before app.js', HTML.indexOf('/app-escrow-waz-sim.js') > 0 && HTML.indexOf('/app-escrow-waz-sim.js') < HTML.indexOf('/app.js'))
ok('[ESCROW-WAZ-SIM] app-escrow-waz-sim.js defines _wazSimulated flag + escrow notice helpers', /window\._wazSimulated\s*=\s*true/.test(WAZ) && /wazEscrowOrderBanner/.test(WAZ) && /wazEscrowRailNote/.test(WAZ))
ok('dpSelectedRail defaults to escrow (escrow selected, or non-simulated fallback)', /c === 'escrow' \? 'escrow' : \(window\._wazSimulated \? '' : 'escrow'\)/.test(DP))
ok('order create payload includes payment_rail', /payment_rail/.test(APP) && /window\.dpSelectedRail/.test(APP))
ok('direct_p2p create routes to dpAfterCreate', /payment_rail === 'direct_p2p'.*dpAfterCreate/.test(APP))

// ── 4. disclosure acks (pre_select + pre_confirm), Passkey-gated, after order exists ──
ok('acks POST to disclosure-acks endpoint', /POST\('\/direct-pay\/disclosure-acks'/.test(DP))
ok('acks cover pre_select AND pre_confirm', has(DP, 'pre_select') && has(DP, 'pre_confirm'))
ok('ack uses live Passkey gate (direct_pay_disclosure_ack)', /requestPasskeyGate\('direct_pay_disclosure_ack'/.test(DP))
ok('dpAfterCreate drives the ack flow', /dpAfterCreate\s*=/.test(DP) && has(DP, 'dpEnsureAcks'))

// ── 4b. BOUNDARY: instruction revealed ONLY AFTER D1/D2 acks, and sourced from the ack-gated order read (NOT the create response) ──
const AFTER = DP.slice(DP.indexOf('dpAfterCreate = async'), DP.indexOf('dpEnsureAcks = async'))
ok('dpAfterCreate runs dpEnsureAcks BEFORE opening the payment modal', AFTER.indexOf('dpEnsureAcks') < AFTER.indexOf('dpShowPaymentModal') && AFTER.includes('dpShowPaymentModal'))
ok('dpAfterCreate sources order from GET /orders (not the create response)', /GET\(`\/orders\//.test(AFTER) && !/res\.payment_instruction/.test(DP))
ok('dpAfterCreate bails before opening payment modal when acks not completed', /if \(!acked\)[\s\S]*?return/.test(AFTER) && AFTER.indexOf('if (!acked)') < AFTER.indexOf('dpShowPaymentModal'))

// ── 5. order detail / actions: disclosures always shown; SNAPSHOT ack-gated; gated actions ──
ok('order detail shows direct_p2p disclosures', has(APP, 'dpOrderDisclosureHtml'))
ok('disclosure HTML does NOT inline the snapshot (not in DOM pre-ack)', !/direct_pay_instruction_snapshot/.test(DP.slice(DP.indexOf('dpOrderDisclosureHtml = '), DP.indexOf('dpHydrateOrderDisclosure'))))
ok('order detail hydrates snapshot via ack-gated path', has(APP, 'dpHydrateOrderDisclosure') && /dpHydrateOrderDisclosure\s*=/.test(DP))
const HYD = DP.slice(DP.indexOf('dpHydrateOrderDisclosure = async'), DP.indexOf('dpCompleteAcksThenReveal = async'))
ok('snapshot revealed only AFTER both-acked (st.both gates the delegate call)', HYD.indexOf('st.both') < HYD.indexOf('dpRenderPaymentInfo') && HYD.includes('dpRenderPaymentInfo') && /!st\.both[\s\S]*return/.test(HYD) && /direct_pay_instruction_snapshot/.test(P('app-direct-pay-reveal.js')))
ok('not-both-acked branch shows a "complete D1/D2" gate, not the snapshot', /!st\.both/.test(HYD) && has(HYD, 'dpCompleteAcksThenReveal') && !HYD.slice(HYD.indexOf('!st.both'), HYD.indexOf('dpCompleteAcksThenReveal') + 60).includes('direct_pay_instruction_snapshot'))
ok('getActions offers mark_paid in direct_pay_window', /direct_pay_window/.test(APP) && /'mark_paid'/.test(APP))
ok('handleAction routes direct_p2p gated actions to dpHandleAction', /_dpOrderRail === 'direct_p2p'.*dpHandleAction/.test(APP))
ok('order action uses Passkey gate (direct_pay_order_action)', /requestPasskeyGate\('direct_pay_order_action'/.test(DP))
ok('order action hits existing endpoints (action + confirm-in-person)', /\/orders\/\$\{orderId\}\/action/.test(DP) && /confirm-in-person/.test(DP))

// ── 5b. P2: clear register-Passkey entry for buyers without a Passkey ──
ok('register-Passkey prompt helper exists', /dpPromptRegisterPasskey\s*=/.test(DP))
ok('Passkey-gate failure offers registration (navigate to #me)', has(DP, 'dpPromptRegisterPasskey') && /navigate\('#me'\)/.test(DP))
ok('rail note links to Passkey registration (#me)', /href="#me"/.test(DP))

// ── 6. honest non-custodial copy — present in zh (source) AND en (i18n)。措辞准确化:无退款能力 ≠ 拒绝退款 ──
for (const zh of ['不托管', '不担保', '无退款能力', '不代维权', 'WebAZ 不验证付款方式或币种', '本金不经 WebAZ']) {
  ok(`zh copy present: ${zh}`, has(DP, zh))
}
ok('en copy: non-custodial + no refund capability (accurate framing)', /has NO refund capability/i.test(I18N))
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

// ── 9. PR-5c: availability/control reason codes have bilingual copy + availability-gated rail ──
const REASON_COPY: Record<string, string> = {
  DIRECT_PAY_DISABLED: '直付当前未开放',
  DIRECT_PAY_RAIL_BREAKER: '直付暂停受理(运营维护中),请稍后再试',
  DIRECT_PAY_REGION_UNSUPPORTED: '直付在你所在地区暂未开放',
  DIRECT_PAY_CAP_EXCEEDED: '超出直付单笔上限(按 WebAZ 记录的订单金额计;不涉及你与卖家场外实际付款金额)',
  DIRECT_PAY_SELLER_NOT_ELIGIBLE: '该卖家暂不支持直付',
  DIRECT_PAY_SELLER_SUSPENDED: '该卖家直付已被暂停',
  NO_PAYMENT_INSTRUCTION: '卖家尚未设置收款说明,暂不可直付',
  DIRECT_PAY_SIMPLE_PRODUCT_ONLY: '直付当前仅支持简单商品(无规格)',
  DIRECT_PAY_UNSUPPORTED_OPTION: '直付当前不支持该下单选项',
}
// 9a. dpErrorText maps every reason code; each zh string has an EN i18n entry.
const DPERR = DP.slice(DP.indexOf('window.dpErrorText'), DP.indexOf('window.dpRailSelectorHtml'))
for (const code of Object.keys(REASON_COPY)) ok(`dpErrorText maps ${code}`, new RegExp(`\\b${code}\\s*:`).test(DPERR))
// DIRECT_PAY_NOT_AVAILABLE + DIRECT_PAY_KYC_REQUIRED also mapped (shared/own copy)
ok('dpErrorText maps DIRECT_PAY_NOT_AVAILABLE', /\bDIRECT_PAY_NOT_AVAILABLE\s*:/.test(DPERR))
ok('dpErrorText maps DIRECT_PAY_KYC_REQUIRED', /\bDIRECT_PAY_KYC_REQUIRED\s*:/.test(DPERR))
for (const zh of Object.values(REASON_COPY)) ok(`i18n EN present: ${zh.slice(0, 12)}`, new RegExp(`'${zh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
// 9b. cap copy ties to WebAZ-recorded order total, NOT off-platform payment control.
ok('cap zh copy: WebAZ-recorded order amount + not off-platform', /WebAZ 记录的订单金额/.test(DP) && /不涉及[\s\S]{0,12}场外/.test(DP))
ok('cap en copy: WebAZ-recorded order total + off-platform disclaimer', /WebAZ-recorded order total/.test(I18N) && /off-platform/.test(I18N))
// 9c. rail selector availability-gated: direct_p2p queries /direct-pay/availability; only available===true allows it.
ok('rail selector queries /direct-pay/availability', /\/direct-pay\/availability/.test(DP))
ok('direct_p2p allowed only when av.available === true', /av\.available === true/.test(DP))
ok('unavailable → shows dpErrorText reason (not raw JSON)', /dp-rail-unavailable/.test(DP) && /dpErrorText\(av/.test(DP))
ok('unavailable → reverts to escrow (blocks entering direct_p2p create)', /value="escrow"\][\s\S]{0,90}checked = true/.test(DP))
// 9c-race: dpSelectedRail gates on a confirmed-availability flag — pending/unavailable never yields direct_p2p,
//   so a fast "confirm" before availability returns posts escrow (never payment_rail:'direct_p2p').
ok('dpSelectedRail outputs direct_p2p ONLY when window._dpDirectAvailable === true (else empty, never escrow)', /_dpDirectAvailable === true \? 'direct_p2p' : ''/.test(DP))
ok('rail change resets availability flag to false (pending) before the async check', /dpOnRailChange[\s\S]{0,160}_dpDirectAvailable = false/.test(DP))
ok('flag set true only on av.available === true', /av\.available === true[\s\S]{0,40}_dpDirectAvailable = true/.test(DP))
// 9d. boundary copy held + no production-ready claim.
ok('copy: off-platform + WebAZ 不托管/不担保/不退款', /场外/.test(DP) && /不托管/.test(DP) && /不担保/.test(DP) && /不退款/.test(DP))
ok('no production-ready claim', !/production[- ]?ready|可上线|已上线/i.test(DPCODE))

// ── 10. seller de-identified readiness panel (new app-direct-pay-readiness.js) ──
const RDY = P('app-direct-pay-readiness.js')
const RDYCODE = RDY.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
const PKG = readFileSync('package.json', 'utf8')
const RATCHET = readFileSync('scripts/complexity-ratchet-guard.ts', 'utf8')
ok('10. index.html loads app-direct-pay-readiness.js before app.js', has(HTML, '/app-direct-pay-readiness.js') && HTML.indexOf('/app-direct-pay-readiness.js') < HTML.indexOf('/app.js'))
ok('10a. readiness file in check:pwa-syntax', /node --check src\/pwa\/public\/app-direct-pay-readiness\.js/.test(PKG))
ok('10b. readiness file has a LOC ceiling (ratchet covered)', /'src\/pwa\/public\/app-direct-pay-readiness\.js'\s*:/.test(RATCHET))
ok('10c. seller readiness panel + hydrate defined', /dpSellerReadinessSection\s*=/.test(RDY) && /dpHydrateSellerReadiness\s*=/.test(RDY))
ok('10d. reads the seller self readiness endpoint', /GET\('\/direct-receive\/readiness'\)/.test(RDY))
ok('10e. app.js settings tab renders + hydrates the readiness panel', has(APP, 'dpSellerReadinessSection') && has(APP, 'dpHydrateSellerReadiness'))
// de-identified: the seller UI must NOT contain KYB / sanctions / AML / KYC terms or raw launch blocker codes
ok('10f. seller UI exposes NO KYB/sanctions/AML/KYC terms', !/KYB|SANCTION|AML|KYC/i.test(RDYCODE))
ok('10g. seller UI exposes NO raw launch blocker codes', !/DIRECT_PAY_(NOT_ENABLED|RAIL_|REGION_NOT|PER_TX|NO_LEGAL|SELLER_)/.test(RDYCODE))
ok('10h. seller copy de-identified ("履约保证金未完成", collapsed compliance)', has(RDY, '履约保证金未完成') && has(RDY, '商户审核进行中或未通过'))
ok('10i. no production-ready / launched claim in readiness UI', !/production[- ]?ready|已上线|可上线/i.test(RDYCODE))
// EN parity for the new readiness copy
for (const k of ['直付开通进度(仅你可见)', '履约保证金未完成', '商户审核进行中或未通过', '直付平台侧暂未开放(无需你操作)', '直付资格已被暂停']) {
  ok(`10-i18n EN present: ${k.slice(0, 12)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}
// readiness UI is read-only too: no money/state endpoint writes
ok('10j. readiness UI touches no wallet/escrow/settle/refund', !/\/wallet|\/escrow|\/settle|\/refund|\/returns/.test(RDYCODE))

// ── 11. seller 缓交 apply/status panel (new app-direct-pay-deferral.js, PR-②b) ──
const DFR = P('app-direct-pay-deferral.js')
const DFRCODE = DFR.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
ok('11. index.html loads app-direct-pay-deferral.js before app.js', has(HTML, '/app-direct-pay-deferral.js') && HTML.indexOf('/app-direct-pay-deferral.js') < HTML.indexOf('/app.js'))
ok('11a. deferral file in check:pwa-syntax', /node --check src\/pwa\/public\/app-direct-pay-deferral\.js/.test(PKG))
ok('11b. deferral file has a LOC ceiling (ratchet covered)', /'src\/pwa\/public\/app-direct-pay-deferral\.js'\s*:/.test(RATCHET))
ok('11c. seller deferral section + hydrate + submit defined', /dpSellerDeferralSection\s*=/.test(DFR) && /dpHydrateSellerDeferral\s*=/.test(DFR) && /dpSubmitDeferral\s*=/.test(DFR))
ok('11d. reads self deferral status (GET)', /GET\('\/direct-receive\/deferral'\)/.test(DFR))
ok('11e. applies via POST (not Passkey-gated client-side — apply grants nothing)', /POST\('\/direct-receive\/deferral'/.test(DFR) && !/requestPasskeyGate/.test(DFRCODE))
ok('11f. app.js settings tab renders + hydrates the deferral panel', has(APP, 'dpSellerDeferralSection') && has(APP, 'dpHydrateSellerDeferral'))
// de-identified: seller deferral UI must NOT leak KYB/sanctions/AML/KYC or admin identity or raw blocker codes
ok('11g. deferral UI exposes NO KYB/sanctions/AML/KYC terms', !/KYB|SANCTION|AML|KYC/i.test(DFRCODE))
ok('11h. deferral UI exposes NO approved_by / admin identity field', !/approved_by/.test(DFRCODE))
ok('11i. deferral UI exposes NO raw launch blocker codes', !/DIRECT_PAY_(NOT_ENABLED|RAIL_|REGION_NOT|PER_TX|NO_LEGAL|SELLER_)/.test(DFRCODE))
ok('11j. no production-ready / launched claim in deferral UI', !/production[- ]?ready|已上线|可上线/i.test(DFRCODE))
// deferral UI must NOT touch money/state endpoints (apply/status only)
ok('11k. deferral UI touches no wallet/escrow/settle/refund', !/\/wallet|\/escrow|\/settle|\/refund|\/returns/.test(DFRCODE))
// EN parity for the new deferral copy
for (const k of ['履约保证金缓交(仅你可见)', '缓交申请审核中,等待管理员人工审批', '缓交已批准', '提交缓交申请', '宽限至', '缓交申请已提交,等待管理员审批']) {
  ok(`11-i18n EN present: ${k.slice(0, 12)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 12. ADMIN 缓交 approval queue panel (new app-direct-pay-deferral-admin.js, PR-②c) ──
const ADFR = P('app-direct-pay-deferral-admin.js')
const ADFRCODE = ADFR.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
ok('12. index.html loads app-direct-pay-deferral-admin.js before app.js', has(HTML, '/app-direct-pay-deferral-admin.js') && HTML.indexOf('/app-direct-pay-deferral-admin.js') < HTML.indexOf('/app.js'))
ok('12a. admin deferral file in check:pwa-syntax', /node --check src\/pwa\/public\/app-direct-pay-deferral-admin\.js/.test(PKG))
ok('12b. admin deferral file has a LOC ceiling (ratchet covered)', /'src\/pwa\/public\/app-direct-pay-deferral-admin\.js'\s*:/.test(RATCHET))
ok('12c. admin queue render + approve/reject handlers defined', /renderAdminDirectPayDeferrals\s*=/.test(ADFR) && /doApproveDeferralInline\s*=/.test(ADFR) && /doRejectDeferralInline\s*=/.test(ADFR))
ok('12d. app.js router dispatches #admin/deferrals', /params\[0\] === 'deferrals'[\s\S]{0,60}renderAdminDirectPayDeferrals/.test(APP))
ok('12e. reads the admin approval queue (GET pending)', /GET\('\/admin\/direct-receive\/deferrals\?status=pending'\)/.test(ADFR))
ok('12f. approve/reject hit the ROOT admin endpoints (POST)', /POST\(`\/admin\/direct-receive\/deferrals\/\$\{id\}\/approve`/.test(ADFR) && /POST\(`\/admin\/direct-receive\/deferrals\/\$\{id\}\/reject`/.test(ADFR))
// IRON RULE: both approve AND reject must go through a live Passkey ceremony, purpose-bound
ok('12g. approve uses live Passkey gate (direct_pay_deferral_approve)', /requestPasskeyGate\('direct_pay_deferral_approve'/.test(ADFR))
ok('12h. reject uses live Passkey gate (direct_pay_deferral_reject)', /requestPasskeyGate\('direct_pay_deferral_reject'/.test(ADFR))
// purpose_data must be the SAME object posted (terms binding): approve passes `body` to both gate and POST
ok('12i. approve binds purpose_data to the posted terms (same body to gate + POST)', /requestPasskeyGate\('direct_pay_deferral_approve',\s*body\)/.test(ADFR) && /\.\.\.body,\s*webauthn_token/.test(ADFR))
// admin panel must NOT touch money/state endpoints beyond the deferral approve/reject
ok('12j. admin panel touches no wallet/escrow/settle/refund', !/\/wallet|\/escrow|\/settle|\/refund|\/returns/.test(ADFRCODE))
// 12k. CRITICAL (Codex #121 P1): every requestPasskeyGate purpose the admin UI requests MUST be in the
//   WebAuthn /api/webauthn/auth/start allowed set — else /auth/start returns 400 'invalid purpose', no gate
//   token is minted, and approve/reject are dead buttons. Cross-check source-to-source so it can't regress.
const WEBAUTHN = readFileSync('src/pwa/routes/webauthn.ts', 'utf8')
const allowedDecl = WEBAUTHN.slice(WEBAUTHN.indexOf('const allowed = new Set('), WEBAUTHN.indexOf('const allowed = new Set(') + 1500)
const adminGatePurposes = [...ADFR.matchAll(/requestPasskeyGate\('([^']+)'/g)].map(m => m[1])
ok('12k. admin UI requests both approve + reject Passkey purposes', adminGatePurposes.includes('direct_pay_deferral_approve') && adminGatePurposes.includes('direct_pay_deferral_reject'))
for (const p of adminGatePurposes) {
  ok(`12k. WebAuthn allowed set includes '${p}' (token actually mintable)`, allowedDecl.includes(`'${p}'`))
}
// 12l. discoverability: admin overview links to #admin/deferrals (root-only entry card), not hash-only
ok('12l. Direct Pay 商户运营 hub exposes a #admin/deferrals entry card', has(FEEOPS, "'#admin/deferrals')") && has(FEEOPS, '履约保证金缓交审批'))
ok('12l-2. protocol admin hub consolidates direct-pay into a single #admin/dp-ops card', has(APP, "'#admin/dp-ops')") && has(APP, 'Direct Pay 商户运营'))
// EN parity for the new admin copy
for (const k of ['履约保证金缓交审批', '缓交期(天)', '真人确认批准', '真人确认拒绝', '暂无待审缓交申请', '额度系数(如 0.5)']) {
  ok(`12-i18n EN present: ${k.slice(0, 10)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 13. per-product verification UI (new app-direct-pay-product-verify.js, PR-④b) — seller panel + admin queue ──
const PVU = P('app-direct-pay-product-verify.js')
const PVUCODE = PVU.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
ok('13. index.html loads app-direct-pay-product-verify.js before app.js', has(HTML, '/app-direct-pay-product-verify.js') && HTML.indexOf('/app-direct-pay-product-verify.js') < HTML.indexOf('/app.js'))
ok('13a. file in check:pwa-syntax + ratchet', /node --check src\/pwa\/public\/app-direct-pay-product-verify\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-product-verify\.js'\s*:/.test(RATCHET))
// seller panel
ok('13b. seller section + hydrate + request + submit defined', /dpSellerProductVerifySection\s*=/.test(PVU) && /dpHydrateSellerProductVerify\s*=/.test(PVU) && /dpRequestProductVerify\s*=/.test(PVU) && /dpSubmitProductVerify\s*=/.test(PVU))
ok('13c. seller reads own products + own verifications', /GET\('\/my-products'\)/.test(PVU) && /GET\('\/direct-receive\/product-verifications'\)/.test(PVU))
ok('13d. seller requests (POST) + submits link (PUT); request NOT Passkey-gated (grants nothing)', /POST\('\/direct-receive\/product-verification'/.test(PVU) && /PUT\('\/direct-receive\/product-verification'/.test(PVU))
ok('13e. app.js settings tab renders + hydrates the seller product-verify panel', has(APP, 'dpSellerProductVerifySection') && has(APP, 'dpHydrateSellerProductVerify'))
// admin queue
ok('13f. admin render + review handler defined', /renderAdminProductVerifications\s*=/.test(PVU) && /doReviewProductVerify\s*=/.test(PVU))
ok('13g. app.js router dispatches #admin/product-verifications', /params\[0\] === 'product-verifications'[\s\S]{0,70}renderAdminProductVerifications/.test(APP))
ok('13h. admin reads queue (GET) + reviews (POST)', /GET\('\/admin\/direct-receive\/product-verifications\?status=submitted'\)/.test(PVU) && /POST\(`\/admin\/direct-receive\/product-verifications\/\$\{id\}\/review`/.test(PVU))
// IRON RULE + mintability: admin review uses a live Passkey purpose that MUST be in the WebAuthn allowed set
ok('13i. admin review uses live Passkey gate (direct_pay_product_verify)', /requestPasskeyGate\('direct_pay_product_verify'/.test(PVU))
ok('13j. direct_pay_product_verify is in the WebAuthn allowed set (token mintable)', allowedDecl.includes("'direct_pay_product_verify'"))
ok('13k. discoverability: Direct Pay 商户运营 hub exposes #admin/product-verifications card', has(FEEOPS, "'#admin/product-verifications')"))
// no money path
ok('13l. product-verify UI touches no wallet/escrow/settle/refund', !/\/wallet|\/escrow|\/settle|\/refund|\/returns/.test(PVUCODE))
// EN parity for the new copy
for (const k of ['逐产品直付验证(仅你可见)', '申请验证', '提交链接', '逐产品直付验证审核', '暂无待核验商品', '通过(真人 Passkey)']) {
  ok(`13-i18n EN present: ${k.slice(0, 10)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 14. store verification UI (exemption path; new app-direct-pay-store-verify.js, PR-⑤b) — seller panel + admin queue ──
const SVU = P('app-direct-pay-store-verify.js')
const SVUCODE = SVU.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
ok('14. index.html loads app-direct-pay-store-verify.js before app.js', has(HTML, '/app-direct-pay-store-verify.js') && HTML.indexOf('/app-direct-pay-store-verify.js') < HTML.indexOf('/app.js'))
ok('14a. file in check:pwa-syntax + ratchet', /node --check src\/pwa\/public\/app-direct-pay-store-verify\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-store-verify\.js'\s*:/.test(RATCHET))
ok('14b. seller section + hydrate + request + submit defined', /dpSellerStoreVerifySection\s*=/.test(SVU) && /dpHydrateSellerStoreVerify\s*=/.test(SVU) && /dpRequestStoreVerify\s*=/.test(SVU) && /dpSubmitStoreVerify\s*=/.test(SVU))
ok('14c. seller reads own store verification (GET) incl exempt flag surface', /GET\('\/direct-receive\/store-verification'\)/.test(SVU) && /r\.exempt/.test(SVU))
ok('14d. seller requests (POST) + submits (PUT); request NOT Passkey-gated', /POST\('\/direct-receive\/store-verification'/.test(SVU) && /PUT\('\/direct-receive\/store-verification'/.test(SVU))
ok('14e. app.js settings tab renders + hydrates the seller store-verify panel', has(APP, 'dpSellerStoreVerifySection') && has(APP, 'dpHydrateSellerStoreVerify'))
ok('14f. admin render + review handler defined', /renderAdminStoreVerifications\s*=/.test(SVU) && /doReviewStoreVerify\s*=/.test(SVU))
ok('14g. app.js router dispatches #admin/store-verifications', /params\[0\] === 'store-verifications'[\s\S]{0,70}renderAdminStoreVerifications/.test(APP))
ok('14h. admin reads queue (GET) + reviews (POST)', /GET\('\/admin\/direct-receive\/store-verifications\?status=submitted'\)/.test(SVU) && /POST\(`\/admin\/direct-receive\/store-verifications\/\$\{id\}\/review`/.test(SVU))
ok('14i. admin review uses live Passkey gate (direct_pay_store_verify) + binds per_product_exempt', /requestPasskeyGate\('direct_pay_store_verify',\s*body\)/.test(SVU) && /per_product_exempt:\s*exempt/.test(SVU))
ok('14j. direct_pay_store_verify is in the WebAuthn allowed set (token mintable)', allowedDecl.includes("'direct_pay_store_verify'"))
ok('14k. admin offers the per-product-exempt checkbox', /sv-exempt-/.test(SVU) && /type="checkbox"/.test(SVU))
ok('14l. discoverability: Direct Pay 商户运营 hub exposes #admin/store-verifications card', has(FEEOPS, "'#admin/store-verifications')"))
ok('14m. store-verify UI touches no wallet/escrow/settle/refund', !/\/wallet|\/escrow|\/settle|\/refund|\/returns/.test(SVUCODE))
for (const k of ['店铺认证(可申请免逐品验证)', '申请店铺认证', '提交店铺链接', '店铺认证审核', '免逐品验证(通过后该卖家所有商品可直付)', '暂无待核验店铺']) {
  ok(`14-i18n EN present: ${k.slice(0, 10)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 15. admin compliance ingest UI (new app-direct-pay-compliance.js, PR-⑧) — KYB + sanctions ──
const CMP = P('app-direct-pay-compliance.js')
const CMPCODE = CMP.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
ok('15. index.html loads app-direct-pay-compliance.js before app.js', has(HTML, '/app-direct-pay-compliance.js') && HTML.indexOf('/app-direct-pay-compliance.js') < HTML.indexOf('/app.js'))
ok('15a. file in check:pwa-syntax + ratchet', /node --check src\/pwa\/public\/app-direct-pay-compliance\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-compliance\.js'\s*:/.test(RATCHET))
ok('15b. render + KYB + sanctions handlers defined', /renderAdminDirectReceiveCompliance\s*=/.test(CMP) && /doIngestKyb\s*=/.test(CMP) && /doIngestSanctions\s*=/.test(CMP))
ok('15c. app.js router dispatches #admin/compliance', /params\[0\] === 'compliance'[\s\S]{0,60}renderAdminDirectReceiveCompliance/.test(APP))
ok('15d. posts to the ROOT KYB + sanctions ingest endpoints (via shared helper)', has(CMP, "'/admin/direct-receive/kyb-reviews'") && has(CMP, "'/admin/direct-receive/sanctions-screenings'") && /POST\(path,/.test(CMP))
ok('15e. both live Passkey purposes referenced (kyb_ingress + sanctions_ingress)', has(CMP, "'direct_pay_kyb_ingress'") && has(CMP, "'direct_pay_sanctions_ingress'"))
ok('15f. both ingest purposes are in the WebAuthn allowed set (token mintable)', allowedDecl.includes("'direct_pay_kyb_ingress'") && allowedDecl.includes("'direct_pay_sanctions_ingress'"))
ok('15g. purpose_data bound to posted body (same body to gate + POST)', /requestPasskeyGate\(purpose,\s*body\)/.test(CMP) && /\.\.\.body,\s*webauthn_token/.test(CMP))
ok('15h. discoverability: Direct Pay 商户运营 hub exposes #admin/compliance card', has(FEEOPS, "'#admin/compliance')"))
ok('15i. compliance UI touches no wallet/escrow/settle/refund', !/\/wallet|\/escrow|\/settle|\/refund|\/returns/.test(CMPCODE))
// P1: provider_ref must NOT be labeled as a credential/ID number (it's stored plaintext) + must warn against PII
ok('15j. no PII-inviting label (凭证号/证件号) for provider_ref', !/凭证号|证件号/.test(CMP) && /vendor case id/.test(CMP))
ok('15k. warns provider_ref is plaintext / no ID/passport/doc links', /明文入库/.test(CMP) && /身份证\/护照/.test(CMP))
// P2: status options must match the backend allowlists exactly (else Passkey-then-INVALID_STATUS)
ok('15l. sanctions options = clear/flagged/blocked (no pending; backend allowlist)', /'clear'/.test(CMP) && /'flagged'/.test(CMP) && /'blocked'/.test(CMP) && !/cmp-sanc-status[\s\S]{0,200}'pending'/.test(CMP))
ok('15m. KYB options include revoked (full backend allowlist)', /'approved'/.test(CMP) && /'rejected'/.test(CMP) && /'revoked'/.test(CMP))
for (const k of ['商户合规录入', 'KYB 复核结论', '制裁筛查结论', '记录 KYB(真人 Passkey)', 'KYB 结论已记录']) {
  ok(`15-i18n EN present: ${k.slice(0, 8)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 17. PR-B: Direct Pay 商户运营 hub + 平台服务费(预充值)账户 ──
ok('17a. fee-ops file loaded in index.html before app.js', has(HTML, '/app-direct-pay-fee-ops.js') && HTML.indexOf('/app-direct-pay-fee-ops.js') < HTML.indexOf('/app.js'))
ok('17b. fee-ops in check:pwa-syntax', /node --check src\/pwa\/public\/app-direct-pay-fee-ops\.js/.test(PKG))
ok('17c. fee-ops has a LOC ceiling (ratchet covered)', /'src\/pwa\/public\/app-direct-pay-fee-ops\.js'\s*:/.test(RATCHET))
ok('17d. app.js routes #admin/dp-ops → renderAdminDirectPayHub', has(APP, "'dp-ops'") && has(APP, 'renderAdminDirectPayHub'))
ok('17e. app.js routes #admin/dp-fee → renderAdminDirectPayFeeOps', has(APP, "'dp-fee'") && has(APP, 'renderAdminDirectPayFeeOps'))
ok('17f. fee-ops hub links the new #admin/dp-fee fee account', has(FEEOPS, "'#admin/dp-fee')"))
// money writes use live Passkey gate with the matching purposes
ok('17g. topup uses requestPasskeyGate(direct_pay_fee_prepay_record)', has(FEEOPS, "requestPasskeyGate('direct_pay_fee_prepay_record'") || has(FEEOPS, "'direct_pay_fee_prepay_record'"))
ok('17h. adjust uses direct_pay_fee_adjust + refund uses direct_pay_fee_refund', has(FEEOPS, "'direct_pay_fee_adjust'") && has(FEEOPS, "'direct_pay_fee_refund'"))
ok('17i. those purposes are in the WebAuthn allowed set (token mintable)', allowedDecl.includes("'direct_pay_fee_adjust'") && allowedDecl.includes("'direct_pay_fee_refund'") && allowedDecl.includes("'direct_pay_fee_prepay_record'"))
ok('17j. fee account read calls GET fee-account', has(FEEOPS, '/admin/direct-receive/fee-account/'))
// i18n parity — load-bearing new zh keys have EN entries
for (const k of ['Direct Pay 商户运营', '平台服务费预充值与账户', '可用预充值余额', '记录预充值(真人 Passkey)', '退款(真实退还未消耗预付款)', '账务更正(可正可负,非退款)', '首单宽限']) {
  ok(`17k. i18n EN entry for ${k}`, has(I18N, `'${k}':`))
}
// non-custodial copy: prepayment is platform service fee, not buyer funds/escrow/collateral
ok('17l. fee-ops states prepayment is NOT buyer funds/escrow/collateral', has(FEEOPS, '非买家货款') && has(FEEOPS, 'escrow') && has(FEEOPS, '保证金'))

// ── 18. PR-C: seller fee center section ──
const FEECTR = P('app-direct-pay-fee-center.js')
ok('18a. fee-center loaded before app.js', has(HTML, '/app-direct-pay-fee-center.js') && HTML.indexOf('/app-direct-pay-fee-center.js') < HTML.indexOf('/app.js'))
ok('18b. fee-center in check:pwa-syntax', /node --check src\/pwa\/public\/app-direct-pay-fee-center\.js/.test(PKG))
ok('18c. fee-center has a LOC ceiling', /'src\/pwa\/public\/app-direct-pay-fee-center\.js'\s*:/.test(RATCHET))
ok('18d. seller settings sub-tab composes dpSellerFeeSection', has(APP, 'dpSellerFeeSection'))
ok('18e. seller settings hydrates dpHydrateSellerFee', has(APP, 'dpHydrateSellerFee'))
ok('18f. fee-center reads own account via GET /direct-receive/my-fee-account', has(FEECTR, '/direct-receive/my-fee-account'))
ok('18g. seller-only + non-custodial copy (not buyer funds/escrow/collateral)', has(FEECTR, '仅你可见') && has(FEECTR, '非买家货款') && has(FEECTR, 'escrow') && has(FEECTR, '保证金'))
for (const k of ['平台服务费账户(仅你可见)', '待补平台服务费', '首单宽限可用:你的第一笔直付无需预充值。']) ok(`18h. i18n EN for ${k}`, has(I18N, `'${k}':`))

// ── 19. Phase C2: seller multi receive-account + QR management (new app-direct-pay-accounts.js) ──
const ACC = P('app-direct-pay-accounts.js')
const ACCCODE = ACC.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
ok('19. index.html loads app-direct-pay-accounts.js before app.js', has(HTML, '/app-direct-pay-accounts.js') && HTML.indexOf('/app-direct-pay-accounts.js') < HTML.indexOf('/app.js'))
ok('19a. accounts file in check:pwa-syntax', /node --check src\/pwa\/public\/app-direct-pay-accounts\.js/.test(PKG))
ok('19b. accounts file has a LOC ceiling (ratchet covered)', /'src\/pwa\/public\/app-direct-pay-accounts\.js'\s*:/.test(RATCHET))
ok('19c. section + hydrate + add/update/deactivate/qr handlers defined', /draAccountsSection\s*=/.test(ACC) && /draHydrateAccounts\s*=/.test(ACC) && /draAddAccount\s*=/.test(ACC) && /draUpdateAccount\s*=/.test(ACC) && /draDeactivateAccount\s*=/.test(ACC) && /draUploadQr\s*=/.test(ACC))
ok('19d. reads the seller accounts list (GET)', /GET\('\/direct-receive\/accounts'\)/.test(ACC))
ok('19e. writes hit the CRUD + QR endpoints', /POST\('\/direct-receive\/accounts'/.test(ACC) && /PUT\('\/direct-receive\/accounts\/'/.test(ACC) && /api\('DELETE', '\/direct-receive\/accounts\/'/.test(ACC) && /\/qr'/.test(ACC))
ok('19f. app.js settings tab renders + hydrates the accounts panel', has(APP, 'draAccountsSection') && has(APP, 'draHydrateAccounts'))
// IRON RULE: every write (add/update/deactivate/qr) goes through a live Passkey ceremony, purpose-bound
ok('19g. all writes use live Passkey gate (direct_receive_account_manage)', has(ACC, "requestPasskeyGate('direct_receive_account_manage'"))
const accGatePurposes = [...ACC.matchAll(/requestPasskeyGate\('([^']+)'/g)].map(m => m[1])
for (const p of accGatePurposes) ok(`19g. WebAuthn allowed set includes '${p}' (token mintable)`, allowedDecl.includes(`'${p}'`))
// QR preview must fetch with Authorization header (owner-only endpoint; <img src> can't carry it)
ok('19h. QR thumbnail fetched with Authorization header (not <img src> to the API)', /fetch\('\/api\/direct-receive\/accounts\/'[^)]*Authorization/.test(ACC.replace(/\n/g, ' ')))
// client-side QR guard mirrors backend: png|webp only, ≤ 64KB
ok('19i. client pre-validates QR type (png|webp) + size (64KB)', /image\/png/.test(ACC) && /image\/webp/.test(ACC) && /64\s*\*\s*1024/.test(ACC))
// non-custodial: the accounts UI must NOT touch any money/state endpoint
ok('19j. accounts UI touches no wallet/escrow/settle/refund', !/\/wallet|\/escrow|\/settle|\/refund|\/returns/.test(ACCCODE))
// non-custodial copy present (store/display only, no verify/route/custody, no QR parsing)
ok('19k. accounts UI states store-only / non-custodial boundary', has(ACC, '只存储与展示') && has(ACC, '不路由/托管资金') && has(ACC, '不解析二维码'))
// EN parity for the new copy
for (const k of ['直付收款账号', '新增收款账号', '尚未添加收款账号', '收款方式', '币种', '上传二维码', '更换二维码', '无二维码', '二维码已上传', '停用后买家将无法选择该收款账号,确定停用?']) {
  ok(`19-i18n EN present: ${k.slice(0, 12)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 20. Phase D3: buyer account selection + per-account FX + post-ack QR (new app-direct-pay-buyer.js) ──
const BUY = P('app-direct-pay-buyer.js')
const BUYCODE = BUY.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
ok('20. index.html loads app-direct-pay-buyer.js before app.js', has(HTML, '/app-direct-pay-buyer.js') && HTML.indexOf('/app-direct-pay-buyer.js') < HTML.indexOf('/app.js'))
ok('20a. buyer file in check:pwa-syntax + ratchet', /node --check src\/pwa\/public\/app-direct-pay-buyer\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-buyer\.js'\s*:/.test(RATCHET))
ok('20b. loader/selector/QR handlers + FX helper defined', /dpLoadBuyerAccounts\s*=/.test(BUY) && /dpSelectedAccountId\s*=/.test(BUY) && /dpLoadOrderQr\s*=/.test(BUY) && /dpFxInCurrency\s*=/.test(BUY))
ok('20c. reads selectable-accounts (metadata-only D1 endpoint)', /GET\('\/direct-receive\/selectable-accounts/.test(BUY))
ok('20d. order QR fetched with Authorization header (owner+ack endpoint; not <img src>)', /direct-pay-qr[\s\S]{0,120}Authorization/.test(BUY.replace(/\n/g, ' ')))
// app-direct-pay.js net-zero hooks that make the new module reachable
ok('20e. rail selector renders the account-picker container + carries price data attr', has(DP, 'id="dp-account-picker"') && has(DP, 'data-amt='))
ok('20f. dpOnRailChange loads buyer accounts when available; clears on switch', has(DP, 'dpLoadBuyerAccounts') && has(DP, "getElementById('dp-account-picker')"))
ok('20g. order disclosure hydrate reveals QR post-ack (container + call in reveal module)', has(P('app-direct-pay-reveal.js'), 'id="dp-order-qr"') && has(P('app-direct-pay-reveal.js'), 'dpLoadOrderQr'))
// app.js wiring: price passed to rail selector + account id threaded into POST /orders
ok('20h. app.js passes price to rail selector', /dpRailSelectorHtml\(prod\.id,\s*prod\.price\)/.test(APP))
ok('20i. app.js threads direct_receive_account_id into POST /orders (direct_p2p only)', /direct_receive_account_id:\s*\(payment_rail === 'direct_p2p'[\s\S]{0,80}dpSelectedAccountId/.test(APP))
// non-custodial: buyer module touches no money/state endpoint (reads accounts + order QR only)
ok('20j. buyer UI touches no wallet/escrow/settle/refund', !/\/wallet|\/escrow|\/settle|\/refund|\/returns/.test(BUYCODE))
// P1 (multi-qty): per-account FX must reflect ORDER TOTAL (unit × quantity), not unit price
ok('20k. FX amount uses order total = unit(data-amt) × quantity(#inp-qty), not unit price', /dpAccountTotalUsdc\s*=/.test(BUY) && /getElementById\('inp-qty'\)/.test(BUY) && /unit\s*\*\s*qty/.test(BUY))
ok('20l. per-account FX renders from the total (dpRenderAccountFx over data-dp-fx-cur)', /dpRenderAccountFx\s*=/.test(BUY) && /data-dp-fx-cur/.test(BUY) && /dpAccountTotalUsdc\(\)/.test(BUY))
ok('20m. quantity change refreshes the account FX (qtyStep + qtyClamp call dpRenderAccountFx)', (APP.match(/dpRenderAccountFx/g) || []).length >= 2)
// EN parity for the new copy
for (const k of ['选择卖家收款方式', '卖家按此收款', '收款明细与二维码将在完成风险确认后显示']) {
  ok(`20-i18n EN present: ${k.slice(0, 12)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 21. platform receive accounts admin UI (new app-platform-receive-accounts.js) ──
const PRA = P('app-platform-receive-accounts.js')
const PRACODE = PRA.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
ok('21. index.html loads app-platform-receive-accounts.js before app.js', has(HTML, '/app-platform-receive-accounts.js') && HTML.indexOf('/app-platform-receive-accounts.js') < HTML.indexOf('/app.js'))
ok('21a. file in check:pwa-syntax + ratchet', /node --check src\/pwa\/public\/app-platform-receive-accounts\.js/.test(PKG) && /'src\/pwa\/public\/app-platform-receive-accounts\.js'\s*:/.test(RATCHET))
ok('21b. render + hydrate + CRUD handlers defined', /renderAdminPlatformReceiveAccounts\s*=/.test(PRA) && /praHydrate\s*=/.test(PRA) && /praAdd\s*=/.test(PRA) && /praUpdate\s*=/.test(PRA) && /praDeactivate\s*=/.test(PRA))
ok('21c. root-only gated render', /admin_type[\s\S]{0,40}root/.test(PRA) && /仅限根管理员/.test(PRA))
ok('21d. hits admin platform-receive endpoints (GET/POST/PUT/DELETE)', /GET\('\/admin\/platform-receive-accounts'\)/.test(PRA) && /POST\('\/admin\/platform-receive-accounts'/.test(PRA) && /PUT\('\/admin\/platform-receive-accounts\/'/.test(PRA) && /api\('DELETE', '\/admin\/platform-receive-accounts\/'/.test(PRA))
ok('21e. all writes use live Passkey (platform_receive_account_manage)', has(PRA, "requestPasskeyGate('platform_receive_account_manage'"))
const praPurposes = [...PRA.matchAll(/requestPasskeyGate\('([^']+)'/g)].map(m => m[1])
for (const p of praPurposes) ok(`21e. WebAuthn allowed set includes '${p}'`, allowedDecl.includes(`'${p}'`))
ok('21f. client QR pre-validate png|webp + 64KB', /image\/png/.test(PRA) && /image\/webp/.test(PRA) && /64 \* 1024/.test(PRA))
ok('21g. app.js routes #admin/platform-receive → renderAdminPlatformReceiveAccounts', /'platform-receive'[\s\S]{0,60}renderAdminPlatformReceiveAccounts/.test(APP))
ok('21h. dp-ops hub links #admin/platform-receive', has(FEEOPS, "'#admin/platform-receive')"))
ok('21i. UI touches no wallet/escrow/settle/refund/fee balance write', !/\/wallet|\/escrow|\/settle|\/refund|fee-prepay/.test(PRACODE))
for (const k of ['平台收款方式', '新增平台收款方式', '平台收款明细', '收款二维码(可选,PNG/WebP ≤64KB)', '移除现有二维码']) {
  ok(`21-i18n EN present: ${k.slice(0, 12)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 22. seller fee-prepay request UI (new app-direct-pay-fee-request.js) ──
const FRQ = P('app-direct-pay-fee-request.js')
const FRQCODE = FRQ.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
ok('22. index.html loads app-direct-pay-fee-request.js before app.js', has(HTML, '/app-direct-pay-fee-request.js') && HTML.indexOf('/app-direct-pay-fee-request.js') < HTML.indexOf('/app.js'))
ok('22a. file in check:pwa-syntax + ratchet', /node --check src\/pwa\/public\/app-direct-pay-fee-request\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-fee-request\.js'\s*:/.test(RATCHET))
ok('22b. section + hydrate + submit + cancel defined', /dpFeeRequestSection\s*=/.test(FRQ) && /dpHydrateFeeRequest\s*=/.test(FRQ) && /dpSubmitFeeRequest\s*=/.test(FRQ) && /dpCancelFeeRequest\s*=/.test(FRQ))
ok('22c. reads platform accounts + own requests (GET)', /GET\('\/direct-receive\/platform-receive-accounts'\)/.test(FRQ) && /GET\('\/direct-receive\/fee-prepay-requests'\)/.test(FRQ))
ok('22d. submits via POST (NOT Passkey — request grants nothing)', /POST\('\/direct-receive\/fee-prepay-request'/.test(FRQ) && !/requestPasskeyGate/.test(FRQCODE))
ok('22e. evidence_ref required client-side (不能无据)', has(FRQ, 'evidence_ref') && /付款凭证号必填/.test(FRQ))
ok('22f. app.js settings tab composes + hydrates the section', has(APP, 'dpFeeRequestSection') && has(APP, 'dpHydrateFeeRequest'))
ok('22g. UI touches no wallet/escrow/settle/refund/admin fee write', !/\/wallet|\/escrow|\/settle|\/refund|\/admin\/direct-receive\/fee/.test(FRQCODE))
for (const k of ['申请平台服务费预充值', '平台收款方式(据此付款)', '付款凭证号 evidence_ref', '我的申请', '申请已提交,等待平台核实入账']) {
  ok(`22-i18n EN present: ${k.slice(0, 12)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 23. admin fee-prepay-request review UI (new app-direct-pay-fee-requests-admin.js) ──
const AFPR = P('app-direct-pay-fee-requests-admin.js')
const AFPRCODE = AFPR.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
ok('23. index.html loads app-direct-pay-fee-requests-admin.js before app.js', has(HTML, '/app-direct-pay-fee-requests-admin.js') && HTML.indexOf('/app-direct-pay-fee-requests-admin.js') < HTML.indexOf('/app.js'))
ok('23a. file in check:pwa-syntax + ratchet', /node --check src\/pwa\/public\/app-direct-pay-fee-requests-admin\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-fee-requests-admin\.js'\s*:/.test(RATCHET))
ok('23b. render + hydrate + approve + reject defined', /renderAdminFeePrepayRequests\s*=/.test(AFPR) && /afprHydrate\s*=/.test(AFPR) && /afprApprove\s*=/.test(AFPR) && /afprReject\s*=/.test(AFPR))
ok('23c. root-only gated', /admin_type[\s\S]{0,40}root/.test(AFPR) && /仅限根管理员/.test(AFPR))
ok('23d. reads queue + approve/reject endpoints', /GET\('\/admin\/direct-receive\/fee-prepay-requests/.test(AFPR) && /\/approve'/.test(AFPR) && /\/reject'/.test(AFPR))
ok('23e. approve Passkey uses its OWN purpose, bound to {request,seller,amount,method}', /requestPasskeyGate\('direct_pay_fee_prepay_request_approve',\s*\{[^}]*request_id[^}]*seller_id[^}]*amount_units[^}]*method/.test(AFPR.replace(/\n/g, ' ')) && !/requestPasskeyGate\('direct_pay_fee_prepay_record'/.test(AFPR))
ok('23f. reject uses its own Passkey purpose', /requestPasskeyGate\('direct_pay_fee_prepay_reject'/.test(AFPR))
const afprPurposes = [...AFPR.matchAll(/requestPasskeyGate\('([^']+)'/g)].map(m => m[1])
for (const p of afprPurposes) ok(`23f. WebAuthn allowed set includes '${p}'`, allowedDecl.includes(`'${p}'`))
ok('23g. shows request id (fpr_…) for management', has(AFPR, "t('申请 id')"))
ok('23h. app.js routes #admin/fee-prepay-requests', /'fee-prepay-requests'[\s\S]{0,60}renderAdminFeePrepayRequests/.test(APP))
ok('23i. dp-ops hub links #admin/fee-prepay-requests', has(FEEOPS, "'#admin/fee-prepay-requests')"))
ok('23j. seller list also shows request id', has(FRQ, "t('申请 id')"))
for (const k of ['平台服务费预充值申请', '确认到账并入账(真人 Passkey)', '暂无待审核申请', '申请 id']) {
  ok(`23-i18n EN present: ${k.slice(0, 12)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 24. order-amount display (PR-1d): order totals → USDC; direct_p2p shows the CHOSEN seller-account currency,
//    NOT the buyer's region local FX (buyer can only pay in a currency the seller supports). ─────────────────
const OAH = APP.slice(APP.indexOf('window.orderAmountHtml ='), APP.indexOf('window.orderAmountHtml =') + 1000)
ok('24a. orderAmountHtml helper defined', has(APP, 'window.orderAmountHtml ='))
ok('24b. direct_p2p branch reads account-snapshot currency + uses dpFxInCurrency (seller currency)', /payment_rail === 'direct_p2p'/.test(OAH) && /direct_pay_account_snapshot/.test(OAH) && /dpFxInCurrency/.test(OAH))
ok('24c. direct_p2p does NOT use region _fxLocal (seller-supported currency only)', !/_fxLocal/.test(OAH))
ok('24d. escrow branch falls back to fmtPrice (USDC + region local)', /return window\.fmtPrice\(usdc\)/.test(OAH))
ok('24e. no-rate currency → currency code, never fabricated (dpFxInCurrency contract)', /return cur\b/.test(P('app-direct-pay-buyer.js')))
ok('24f. order detail 金额 + buyer/seller lists route through orderAmountHtml', (APP.match(/window\.orderAmountHtml\(/g) || []).length >= 4)
ok("24g. '应付' has EN entry (bilingual)", /'应付'\s*:/.test(I18N))
ok('24h. legacy WAZ→$ usdHint helper fully removed', !has(APP, 'function usdHint(') && !has(APP, 'function wazToUsd('))

// ── 25. payment-moment UX (PR-1): 待支付 timeline stage + concrete 应付 amount at the decision touchpoints. ──
const PAY = P('app-direct-pay-pay.js')
ok('25a. new file registered (index.html + pwa-syntax + ratchet)', has(HTML, '/app-direct-pay-pay.js') && /node --check src\/pwa\/public\/app-direct-pay-pay\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-pay\.js'\s*:/.test(RATCHET))
ok('25b. fiat seller account → binding amount via dpFxInCurrency (from account snapshot)', /window\.dpPayAmountText\s*=/.test(PAY) && /direct_pay_account_snapshot/.test(PAY) && /dpFxInCurrency/.test(PAY))
ok('25b2. USDC seller account → shows USDC + buyer local-fiat reference (_fxLocal), not USDC-only', /=== 'USD'\) \{ const loc = window\._fxLocal/.test(PAY) && /USDC\$\{loc \? ' ≈ ' \+ loc/.test(PAY))
ok('25c. no-rate seller currency → currency code, never fabricated', /fx !== cur/.test(PAY))
ok("25d. amount uses '应付' (bilingual EN present)", /t\('应付'\)/.test(PAY) && /'应付'\s*:/.test(I18N))
ok('25e. D2 (pre_confirm) ack dialog injects the confirmed amount', /pre_confirm' && _pay/.test(DP))
ok('25f. after acks, create flow opens the fused payment modal (not a passive 我知道了 confirm)', /window\.dpShowPaymentModal\(o\.order\)/.test(DP))
ok('25g. order-detail box delegates to the visibility renderer (dpRenderPaymentInfo)', /window\.dpRenderPaymentInfo\(box,/.test(DP))
ok('25h. timeline maps direct_pay_window → 待支付 step (not idx 0)', /direct_pay_window: 1/.test(APP) && /direct_expired_unconfirmed: 1/.test(APP))

// ── 26. payment-info visibility lifecycle (PR-2): pending=5-min window+lightweight re-reveal; other states=hidden+Passkey二次验证+risk. ──
const RVL = P('app-direct-pay-reveal.js')
const RVLCODE = RVL.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
ok('26a. new file registered (index.html + pwa-syntax + ratchet)', has(HTML, '/app-direct-pay-reveal.js') && /node --check src\/pwa\/public\/app-direct-pay-reveal\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-reveal\.js'\s*:/.test(RATCHET))
ok('26b. 30-minute window constant', /DP_REVEAL_MS = 30 \* 60 \* 1000/.test(RVL))
ok('26b2. order-scoped box guard (dpInstrBox checks data-order-id === orderId); container binds data-order-id', /dpInstrBox = \(orderId\) =>[\s\S]{0,140}data-order-id'\) === String\(orderId\)/.test(RVL) && /id="dp-order-instr" data-order-id=/.test(DP))
ok('26b3. show/hide acquire the box ONLY via dpInstrBox (getElementById only inside the guard, once)', /const box = window\.dpInstrBox\(orderId\)/.test(RVL) && (RVL.match(/document\.getElementById\('dp-order-instr'\)/g) || []).length === 1)
ok('26b4. render GUARDS current order BEFORE clearing timers (stale hydrate cannot wipe current timer)', /dpRenderPaymentInfo = \([^)]*\) => \{[\s\S]{0,140}dpInstrBox\(orderId\)[\s\S]{0,80}dpClearAllRevealTimers/.test(RVL))
ok('26c. pending (direct_pay_window) → auto-reveal window, lightweight re-reveal', /status === 'direct_pay_window'.*dpShowPaymentInfo\(order, orderId, true\)/.test(RVLCODE.replace(/\n/g, ' ')) && /dpReShowPaymentInfo/.test(RVL))
ok('26d. re-show re-dispatches by FRESH status (dpRenderPaymentInfo), no inline lightweight bypass / Passkey', /dpReShowPaymentInfo = async[\s\S]{0,300}dpRenderPaymentInfo\(box, ord, orderId\)/.test(RVL) && !/dpReShowPaymentInfo[\s\S]{0,300}dpShowPaymentInfo\(ord, orderId, true\)/.test(RVL) && !/dpReShowPaymentInfo[\s\S]{0,300}requestPasskeyGate/.test(RVL))
ok('26e. non-pending → hidden by default (dpHidePaymentInfo, gated button)', /else window\.dpHidePaymentInfo\(order, orderId, false\)/.test(RVL) && /dpGatedRevealPaymentInfo/.test(RVL))
ok('26f. gated re-view requires Passkey 二次验证 (direct_pay_payment_info_reveal purpose)', /requestPasskeyGate\('direct_pay_payment_info_reveal'/.test(RVL))
ok('26g. purpose whitelisted in webauthn allow-set', /'direct_pay_payment_info_reveal'/.test(readFileSync('src/pwa/routes/webauthn.ts', 'utf8')))
ok('26h. state-aware risk warning: void order → do-not-pay', /dpIsVoidOrder/.test(RVL) && /请【勿再付款】/.test(RVL))
ok('26i. void-state list covers cancelled + expired + disputed + refunded', /'cancelled'/.test(RVL) && /'expired'/.test(RVL) && /'disputed'/.test(RVL) && /'refunded_full'/.test(RVL))
ok('26j. timer cleanup on hide/re-render (no leaked intervals)', /dpClearRevealTimer/.test(RVL) && /clearInterval/.test(RVL) && /clearTimeout/.test(RVL))
ok('26k. honesty: comment states this is client-side display/consent, not a new server boundary', /并非】新的服务器机密边界/.test(RVL))
for (const k of ['自动隐藏倒计时', '重新显示', '查看收款信息(需 Passkey 验证)', '继续(需 Passkey)']) {
  ok(`26-i18n EN present: ${k.slice(0, 10)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 27. BEHAVIORAL (P1 order-isolation): a stale reveal timer / re-show must NOT write another order's panel. ──
//    Execute the reveal module against a fake DOM + captured timers; simulate A→B navigation and fire A's stale timers.
{
  const src = readFileSync('src/pwa/public/app-direct-pay-reveal.js', 'utf8')
  const mkEl = (oid: string) => { let h = ''; return { getAttribute: (k: string) => (k === 'data-order-id' ? oid : null), get innerHTML() { return h }, set innerHTML(v: string) { h = v }, querySelector: () => ({ textContent: '' }) } }
  const cur: { el: ReturnType<typeof mkEl> | null } = { el: null }
  const doc = { getElementById: (id: string) => (id === 'dp-order-instr' ? cur.el : null) }
  const win: any = { dpPayAmountText: (o: any) => 'PAY ' + (o ? o.id : ''), dpLoadOrderQr: () => {} }
  const timers: Record<string, () => void> = {}; let seq = 0
  const sT = (fn: () => void) => { const id = 'to' + (++seq); timers[id] = fn; return id }
  const sI = (fn: () => void) => { const id = 'iv' + (++seq); timers[id] = fn; return id }
  const cX = (id: string) => { delete timers[id] }
  const ordersFix: Record<string, any> = {
    A: { id: 'A', payment_rail: 'direct_p2p', status: 'direct_pay_window', direct_pay_instruction_snapshot: 'ACCOUNT-A', total_amount: 30 },
    B: { id: 'B', payment_rail: 'direct_p2p', status: 'direct_pay_window', direct_pay_instruction_snapshot: 'ACCOUNT-B', total_amount: 50 },
  }
  const GETfix = async (p: string) => ({ order: ordersFix[(p.match(/orders\/(\w+)/) || [])[1] || ''] })
  new Function('window', 'document', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'GET', 'escHtml', 't', 'confirmModal', 'requestPasskeyGate', src)(
    win, doc, sT, sI, cX, cX, GETfix, (x: string) => x, (x: string) => x, async () => true, async () => 'tok')

  cur.el = mkEl('A'); win.dpShowPaymentInfo(ordersFix.A, 'A', true)
  ok('27a. correct order account shown on its own page', /ACCOUNT-A/.test(cur.el.innerHTML))
  const aTimer = win._dpRevealTimers['A']
  cur.el = mkEl('B'); cur.el.innerHTML = 'B-PANEL'                         // navigate to order B (fresh #dp-order-instr bound to B)
  timers[aTimer.to]()                                                     // A's stale hide-timer fires
  ok('27b. stale A hide-timer does NOT overwrite B panel', cur.el.innerHTML === 'B-PANEL')
  if (timers[aTimer.iv]) timers[aTimer.iv]()                              // A's stale countdown interval fires
  ok('27c. stale A countdown interval does NOT touch B panel', cur.el.innerHTML === 'B-PANEL')
  win.dpReShowPaymentInfo('A')                                           // A re-show while on page B → guard bails before GET
  ok('27d. A re-show does NOT render A account into B page', cur.el.innerHTML === 'B-PANEL' && !/ACCOUNT-A/.test(cur.el.innerHTML))
  win.dpRenderPaymentInfo(cur.el, ordersFix.B, 'B')                       // rendering B clears stale timers + shows B
  ok('27e. new-order render clears stale timers + shows B account', !win._dpRevealTimers['A'] && /ACCOUNT-B/.test(cur.el.innerHTML))

  // P1: order A goes cancelled while its lightweight "重新显示" button is still on the (unrefreshed) page.
  cur.el = mkEl('A'); win.dpHidePaymentInfo(ordersFix.A, 'A', true)       // A hidden with the lightweight re-show button (was pending)
  ok('27f-pre. lightweight re-show button present while pending', /重新显示/.test(cur.el.innerHTML))
  ordersFix.A.status = 'cancelled'                                        // server-side state change, page not refreshed
  await win.dpReShowPaymentInfo('A')                                      // clicking the stale button re-fetches + re-dispatches by fresh status
  ok('27f. re-show on a now-cancelled order does NOT lightweight-reveal the account', !/ACCOUNT-A/.test(cur.el.innerHTML))
  ok('27g. instead it drops to the Passkey-gated re-view entry', /查看收款信息/.test(cur.el.innerHTML) && /dpGatedRevealPaymentInfo/.test(cur.el.innerHTML))
  ordersFix.A.status = 'direct_pay_window'                                // restore fixture

  // P1: order B shown with a live auto-hide timer; order A's stale hydrate returns late and must NOT clear B's timer.
  cur.el = mkEl('B'); win.dpShowPaymentInfo(ordersFix.B, 'B', true)
  const bTimer = win._dpRevealTimers['B']
  ok('27h-pre. B revealed with a live auto-hide timer', !!bTimer && /ACCOUNT-B/.test(cur.el.innerHTML))
  win.dpRenderPaymentInfo(mkEl('A'), ordersFix.A, 'A')                    // stale hydrate for A while page is B
  ok('27h. stale A render does NOT clear B auto-hide timer (info still auto-hides)', win._dpRevealTimers['B'] === bTimer)
  ok('27i. stale A render does NOT overwrite B panel', /ACCOUNT-B/.test(cur.el.innerHTML))
}

// ── 28. seller "未收到货款" now opens NEGOTIATION (report_nonpayment → payment_query), NOT arbitration.
//    PR-C rewired the legacy accepted→disputed button to the report_nonpayment action. ──
{
  const g = APP.slice(APP.indexOf('function getActions('), APP.indexOf('function renderActions('))
  const shipLine = (g.match(/return \[\{ action: 'ship', label: '确认发货'[\s\S]*?\n/) || [''])[0]
  ok('28a. direct-pay seller @accepted still has 确认发货', /action: 'ship', label: '确认发货'/.test(shipLine))
  ok('28b. direct-pay seller @accepted 未收到货款 → report_nonpayment (negotiation, NOT dispute)', /payment_rail === 'direct_p2p' \?[\s\S]*action: 'report_nonpayment', label: '未收到货款/.test(shipLine) && !/action: 'dispute'/.test(shipLine))
  ok('28c. non-direct-pay (escrow) seller @accepted gets ship only', /: \[\]\)\]/.test(shipLine))
  ok('28d. getActions delegates direct_p2p payment_query/disputed to dpNegotiationActions', /order\.payment_rail === 'direct_p2p' && window\.dpNegotiationActions/.test(g))
  for (const k of ['未收到货款', '未收到货款(告知买家核实)']) ok(`28-i18n EN present: ${k}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 29. verifiable payment memo: unique per-order reference the buyer includes when paying, back-filled to the
//    order timeline (as the mark_paid note) so the seller can tell identical-amount payers apart. ──
const MEMO = P('app-direct-pay-memo.js')
ok('29a. new file registered (index.html + pwa-syntax + ratchet)', has(HTML, '/app-direct-pay-memo.js') && /node --check src\/pwa\/public\/app-direct-pay-memo\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-memo\.js'\s*:/.test(RATCHET))
ok('29b. dpPayRef is deterministic per order (derived from order id)', /dpPayRef = \(orderId\) => 'WAZ-' \+ String\(orderId[\s\S]*slice\(-8\)\.toUpperCase\(\)/.test(MEMO))
// 参考号 READ-ONLY(<code> 非可改 <input>)+ 一键复制(防两单复用同参考号骗重复确认;买家场外抄写零错)
ok('29c. reference shown read-only (<code id=dp-buyer-memo>, escaped) with a copy button — NOT an editable input', /<code id="dp-buyer-memo"[^>]*>\$\{escHtml\(ref\)\}<\/code>\$\{window\.dpCopyBtn \? window\.dpCopyBtn\(ref\)/.test(MEMO) && !/dp-buyer-memo" value=/.test(MEMO) && !/<input id="dp-buyer-memo"/.test(MEMO))
ok('29d. dpReadMemo returns the canonical derived ref (no DOM read, cannot be spoofed), tags 付款参考', /dpReadMemo = \(orderId\) => `\$\{t\('付款参考'\)\}: \$\{window\.dpPayRef\(orderId\)\}`/.test(MEMO) && !/dpReadMemo[\s\S]*getElementById/.test(MEMO))
ok('29e. memo input shown ONLY in the pending (lightweight) reveal box', /\$\{lightweight && window\.dpMemoInputHtml \? window\.dpMemoInputHtml\(orderId\) : ''\}/.test(P('app-direct-pay-reveal.js')))
ok('29f. mark_paid sends the memo as its note (back-fill timeline)', /action === 'mark_paid' && window\.dpReadMemo \? \{ notes: window\.dpReadMemo\(orderId\) \}/.test(DP))
ok('29g. order timeline renders transition notes (seller sees the memo)', /h\.notes \?/.test(APP))
// 29h/29i. 一键复制:独立 helper 文件(dpCopyBtn/dpDoCopy,走健壮 copyText)+ 收款说明也可复制
const COPY = P('app-direct-pay-copy.js')
ok('29h. copy helper file registered + exports dpCopyBtn/dpDoCopy via robust copyText', has(HTML, '/app-direct-pay-copy.js') && /node --check src\/pwa\/public\/app-direct-pay-copy\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-copy\.js'\s*:/.test(RATCHET) && /window\.dpCopyBtn =/.test(COPY) && /window\.dpDoCopy =/.test(COPY) && /copyText\(/.test(COPY))
ok('29i. payment instruction (snap) has a copy button in the reveal box', /window\.dpCopyBtn\(snap, t\('复制收款说明'\)\)/.test(P('app-direct-pay-reveal.js')))
for (const k of ['付款参考', '付款时请在附言/备注填入(便于卖家核对)', '复制收款说明', '此参考号系统生成、不可修改;相同金额时卖家靠它区分付款方,标记"我已付款"时自动记入订单流程。']) ok(`29-i18n EN present: ${k.slice(0, 8)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))

// ── 30. SECURITY (stored XSS): order timeline must ESCAPE user-controlled fields. The buyer-editable payment
//    memo flows notes → order_state_history → timeline; that + evidence descriptions + actor names must be escHtml'd. ──
{
  const tl = APP.slice(APP.indexOf('const historyHtml ='), APP.indexOf('const historyHtml =') + 700)
  ok('30a. timeline notes escaped (memo stored-XSS closed)', /💬 \$\{escHtml\(h\.notes\)\}/.test(tl) && !/💬 \$\{h\.notes\}/.test(tl))
  ok('30b. timeline evidence description escaped', /📎 \$\{escHtml\(e\.description\)\}/.test(tl) && !/📎 \$\{e\.description\}/.test(tl))
  ok('30c. timeline actor name/role escaped', /\$\{escHtml\(h\.actor_name\)\}/.test(tl) && !/>\$\{h\.actor_name\}/.test(tl))
  ok('30d. tracking-timeline actor name/notes already escaped', /actor\?\.name \? ' · ' \+ escHtml\(actor\.name\)/.test(APP) && /💬 \$\{escHtml\(actor\.notes\)\}/.test(APP))
  // order-detail body: seller-controlled product title + buyer-controlled shipping address must be escaped (self-audit findings)
  // 锚在 商品 label 收尾 + value 开头(对 label/value 加 style 属性稳健;product 详情行唯一)。窗口 1800:实测
  //   shipping_address 断言在 ~856 处,900 只剩 44 字余量——中间行随手加个 badge 就把 30f 挤出窗产生假红。
  //   负向 pattern 用 [^>]* 容忍 span 属性(否则加了 style 后永匹配不到=空转,漏掉未转义的新写法)。
  const _pm = "${t('商品')}</span><span class=\"detail-value\""; const _pi = APP.indexOf(_pm); const od = _pi >= 0 ? APP.slice(_pi, _pi + 1800) : ''
  ok('30e. product.title escaped in order detail', /\$\{escHtml\(product\?\.title \|\| ''\)\}/.test(od) && !/detail-value"[^>]*>\$\{product\?\.title/.test(od))
  ok('30f. shipping_address escaped in order detail', /\$\{escHtml\(order\.shipping_address\)\}/.test(od) && !/detail-value"[^>]*>\$\{order\.shipping_address\}/.test(od))
  // reveal QR loader: after its await, bail if the box left the document (no cross-order write)
  ok('30g. dpLoadOrderQr guards with box.isConnected after fetch', /const resp = await fetch[\s\S]{0,200}if \(!box\.isConnected\) return/.test(P('app-direct-pay-buyer.js')))
  // server-side notes length bound (memo + all note sources)
  ok('30h. server bounds notes length', /let notes = String\(req\.body\?\.notes \?\? ''\)\.slice\(0, 500\)/.test(readFileSync('src/pwa/routes/orders-action.ts', 'utf8')))
}

// ── 31. rail-aware dispute copy: direct_p2p is reputation-only, so status labels / timeline / arbitrator panel
//    must NOT say 退款/资金释放/仲裁费. Escrow copy unchanged. ──
{
  const LBL = P('app-order-labels.js')
  ok('31a. app-order-labels.js registered (index.html + pwa-syntax + ratchet)', has(HTML, '/app-order-labels.js') && /node --check src\/pwa\/public\/app-order-labels\.js/.test(PKG) && /'src\/pwa\/public\/app-order-labels\.js'\s*:/.test(RATCHET))
  ok('31b. rail-aware helpers defined', /window\.dpTerminalBadge =/.test(LBL) && /window\.dpTerminalLabel =/.test(LBL) && /window\.dpArbFeeNote =/.test(LBL) && /window\.dpArbRulingOptions =/.test(LBL))
  ok('31c. direct_p2p terminal labels use reputation semantics (胜诉/责任)', /买家胜诉\(信誉裁决\)/.test(LBL) && /卖家胜诉\(信誉裁决\)/.test(LBL))
  ok('31d. direct_p2p arb note + ruling options are reputation-only (胜诉/责任, no refund/release)', /非托管\(直付\)争议:仅信誉裁决,不发生退款/.test(LBL) && /判买家胜诉\(信誉裁决\)/.test(LBL) && /判卖家胜诉\(信誉裁决\)/.test(LBL))
  ok('31e. statusBadge rail-aware via dpTerminalBadge; orderStatusBadges passes order.payment_rail', /function statusBadge\(status, rail\)/.test(APP) && /rail === 'direct_p2p' && \(+window\.dpTerminalBadge/.test(APP) && /statusBadge\(order\.status, order\.payment_rail\)/.test(APP))
  ok('31f. timeline banner rail-aware via dpTerminalLabel', /order\.payment_rail === 'direct_p2p' && \(+window\.dpTerminalLabel/.test(APP))
  ok('31g. arbitrator panel uses dpArbFeeNote + dpArbRulingOptions (rail + can_dismiss_to_negotiation)', /window\.dpArbFeeNote\(dispute\.payment_rail\)/.test(APP) && /window\.dpArbRulingOptions\(dispute\.payment_rail, dispute\.can_dismiss_to_negotiation\)/.test(APP))
  const ENG = readFileSync('src/layer3-trust/L3-1-dispute-engine/dispute-engine.ts', 'utf8')
  ok('31h. dispute DTO exposes payment_rail (getDisputeDetails + getOrderDispute)', (ENG.match(/o\.payment_rail as payment_rail/g) || []).length >= 2)
  ok('31i. non-custodial ruling message is reputation-only', /getNonCustodialRulingDescription/.test(ENG) && /非托管信誉裁决/.test(ENG))
  for (const k of ['买家胜诉(信誉裁决)', '卖家胜诉(信誉裁决)']) ok(`31-i18n EN present: ${k.slice(0, 6)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))

  // ── 32. direct_p2p arbitration takes NO amount (no 退款/赔付金额 input), and timeline shows no refund amount ──
  ok('32a. arb-rail marker carries dispute.payment_rail', /id="arb-rail" value="\$\{dispute\.payment_rail/.test(APP))
  ok('32b. onArbRulingChange keeps amount blocks hidden for direct_p2p', /arb-rail'\)\?\.value === 'direct_p2p'/.test(APP) && /!nc && ruling === 'partial_refund'/.test(APP) && /!nc && ruling === 'liability_split'/.test(APP))
  ok('32c. handleArbitrate skips refund_amount / liability for direct_p2p (no amount required/sent)', /const nc = document\.getElementById\('arb-rail'\)\?\.value === 'direct_p2p'/.test(APP) && /if \(!nc && ruling === 'partial_refund'\)/.test(APP) && /if \(!nc && ruling === 'liability_split'\)/.test(APP))
  ok('32d. direct_p2p ruling options exclude liability_split (no payout allocation)', !(/direct_p2p'[\s\S]{0,260}liability_split/.test(LBL)))
  ok('32e. dispute timeline hides refund amount + liability for direct_p2p', /dispute\.payment_rail !== 'direct_p2p' && meta\.refund_amount/.test(APP) && /dispute\.payment_rail !== 'direct_p2p' && liability\.length/.test(APP))
  ok('32f. engine does not persist refund_amount/liability for non-custodial disputes', /nonCustodial \? null : \(refundAmount \?\? null\)/.test(ENG) && /nonCustodial \? \[\] : \(liabilityParties/.test(ENG))
  ok('32g. dispute-timeline ruling TITLE is rail-aware (direct_p2p → dpRulingLabel, not global RULING_LABELS)', /dispute\.payment_rail === 'direct_p2p' && window\.dpRulingLabel && window\.dpRulingLabel\(rulingLabel\)/.test(APP) && /window\.dpRulingLabel =/.test(P('app-order-labels.js')))

  // ── 33. exhaustive-audit follow-ups: no refund UI + no money notification for direct_p2p ──
  // 33a(重锚,contract v15):直付退货已解禁 —— 退货卡不再 rail-gate,改走场外退款握手
  //   (app-direct-pay-returns.js hooks:状态标签/握手块/升级判定;确认收款走 Passkey RISK)。
  const DPRET = P('app-direct-pay-returns.js')
  ok('33a. return cards UN-gated for direct_p2p + off-protocol refund handshake wired',
    !/order\.status === 'completed'[^`]*order\.payment_rail !== 'direct_p2p'/.test(APP)
    && /window\.dpReturnHandshake \? window\.dpReturnHandshake\(item, isBuyer, isSellerView, order\)/.test(APP)
    && /dpReturnStatusLabels/.test(APP) && /dpReturnCanEscalate/.test(APP)
    && /await_refund/.test(DPRET) && /refund_marked/.test(DPRET)
    && /requestPasskeyGate\('direct_pay_order_action', \{ order_id: oid, action: 'return_refund_confirm' \}\)/.test(DPRET)
    && /库存不会自动恢复/.test(DPRET))
  // 33b: settlement notifications are rail-aware — direct_p2p seller is NOT told "WAZ 结算中 / 资金到账 / 查看钱包"
  const NOTIF = readFileSync('src/layer2-business/L2-6-notifications/notification-engine.ts', 'utf8')
  ok('33b. getOrderCtx exposes payment_rail; title may be a function', /o\.payment_rail/.test(NOTIF) && /typeof rule\.title === 'function'/.test(NOTIF) && /paymentRail:/.test(NOTIF))
  ok('33c. delivered→confirmed + confirmed→completed are rail-aware (no WAZ/钱包 for direct_p2p)', /paymentRail === 'direct_p2p' \? '✅ 买家确认收货'/.test(NOTIF) && /无平台资金入账/.test(NOTIF) && /无平台资金结算/.test(NOTIF))
  ok('33d. direct_p2p settlement notif bodies carry no WAZ / 结算中 / 收益已入账', !/direct_p2p'\s*\?\s*`[^`]*(WAZ|结算中|收益已入账|查看钱包)/.test(NOTIF))

  // ── 34. no fake money in the SIGNED order-chain + MCP tool for direct_p2p ──
  // 34a: arbitration order_events payload is rail-aware — direct_p2p forces non_custodial + null refund/liability (no fake amount in the signed chain/timeline)
  const DW = readFileSync('src/pwa/routes/disputes-write.ts', 'utf8')
  ok('34a. arbitration order-chain payload rail-aware (direct_p2p → non_custodial + null amounts)', /const ncRail = dispute\.payment_rail === 'direct_p2p'/.test(DW) && /non_custodial: ncRail \|\| undefined/.test(DW) && /refund_amount: ncRail \? null/.test(DW) && /liability_parties: ncRail \? null/.test(DW))
  // 34b: MCP webaz_dispute view is rail-aware (payment_rail + reputation-only ruling_options, no liability_split/refund_amount for direct_p2p)
  const MCP = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
  ok('34b. MCP dispute view exposes payment_rail + non_custodial', /payment_rail: dispute\.payment_rail \|\| 'escrow'/.test(MCP) && /non_custodial: dpNonCustodial/.test(MCP))
  ok('34c. MCP ruling_options rail-aware (direct_p2p = 信誉裁决, no liability_split/refund_amount)', /dpNonCustodial \? \[[\s\S]{0,240}判买家胜诉[\s\S]{0,240}\] : \[/.test(MCP) && !/dpNonCustodial \? \[[\s\S]{0,240}liability_split/.test(MCP))
  ok('34d. MCP arbitrate description flags direct_p2p as reputation-only (no fund disposition)', /DIRECT PAY[\s\S]{0,120}reputation-only ruling — NO refund\/release/.test(MCP))
  ok('34e. MCP list_open amount rail-aware (direct_p2p → USDC/信誉, not WAZ)', /d\.payment_rail === 'direct_p2p' \? `\$\{d\.total_amount\} USDC/.test(MCP))

  // ── 35. nextActionCard overdue consequence is rail-aware: direct_p2p carries no 退款/资金释放/放款 ──
  ok('35a. overdueConsequence rail-aware (computed + rendered instead of raw hint)', /const overdueConsequence = order\.payment_rail === 'direct_p2p'/.test(APP) && /isOverdue && overdueConsequence \?/.test(APP) && /\$\{t\(overdueConsequence\)\}/.test(APP))
  const ocArm = (APP.match(/order\.payment_rail === 'direct_p2p'\s*\?\s*\(\{[\s\S]{0,420}?\}\[order\.status\]/) || [''])[0]
  ok('35b. direct_p2p overdue arm uses honest reputation copy', /直付非托管,WebAZ 不退款\/不放款/.test(ocArm) && /不涉及平台放款/.test(ocArm))
  ok('35c. direct_p2p overdue arm has NO escrow refund/release affirmatives', !!ocArm && !/全额退款给你|退款给你|资金释放给卖家|资金原路退回/.test(ocArm))
}

// ── 36. PR-C: payment_query negotiation UI — actions per state/role + status labels + explainer card. ──
{
  const NEG = P('app-direct-pay-negotiation.js')
  ok('36a. app-direct-pay-negotiation.js registered (index.html + pwa-syntax + ratchet)', has(HTML, '/app-direct-pay-negotiation.js') && /node --check src\/pwa\/public\/app-direct-pay-negotiation\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-negotiation\.js'\s*:/.test(RATCHET))
  ok('36b. payment_query seller actions: confirm_received + request_cancel', /confirm_received[\s\S]{0,120}request_cancel/.test(NEG))
  ok('36c. payment_query buyer actions: pq_escalate(evidence) + cancel', /pq_escalate'[\s\S]{0,120}needsEvidence: true[\s\S]{0,200}action: 'cancel'/.test(NEG))
  ok('36d. disputed → pq_withdraw only when backend flag can_withdraw_payment_query_dispute set (NOT all disputed)', /s === 'disputed' && \(isBuyer \|\| isSeller\) && order\.can_withdraw_payment_query_dispute[\s\S]{0,120}action: 'pq_withdraw'/.test(NEG))
  ok('36-guard. route rejects pq_withdraw on non-payment_query disputes (NOT_PAYMENT_QUERY_DISPUTE)', /order_state_history[\s\S]{0,160}to_status = 'disputed'[\s\S]{0,400}NOT_PAYMENT_QUERY_DISPUTE/.test(readFileSync('src/pwa/routes/orders-action.ts', 'utf8')))
  ok('36-dto. /api/orders/:id exposes can_withdraw_payment_query_dispute from latest disputed from_status', /can_withdraw_payment_query_dispute\s*=[\s\S]{0,160}disputedFroms\[disputedFroms\.length - 1\] === 'payment_query'/.test(readFileSync('src/pwa/routes/orders-read.ts', 'utf8')))
  ok('36e. dpNegotiationBadge + dpNegotiationLabel for payment_query', /dpNegotiationBadge = \(status\) => status === 'payment_query'/.test(NEG) && /dpNegotiationLabel = \(status\) => status === 'payment_query'/.test(NEG))
  ok('36f. dpNegotiationCard shown only for payment_query', /dpNegotiationCard = \(order\) => \(!order \|\| order\.status !== 'payment_query'\)/.test(NEG))
  ok('36g. statusBadge + timeline banner wired to negotiation label; ANOMALY includes payment_query', /window\.dpNegotiationBadge && window\.dpNegotiationBadge\(status\)/.test(APP) && /window\.dpNegotiationLabel && window\.dpNegotiationLabel\(order\.status\)/.test(APP) && /'disputed', 'payment_query'/.test(APP))
  ok('36h. order detail renders the negotiation card', /window\.dpNegotiationCard \? window\.dpNegotiationCard\(order\)/.test(APP))
  for (const k of ['货款协商中', '确认已收到货款(恢复订单)', '撤回仲裁 · 回到协商']) ok(`36-i18n EN present: ${k.slice(0, 8)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 37. 取消退款握手(审计项 C):付款后·发货前 买家取消+场外退款三步握手 UI。 ──
{
  const CRF = P('app-direct-pay-cancel-refund.js')
  ok('37a. app-direct-pay-cancel-refund.js registered (index.html + pwa-syntax + ratchet)', has(HTML, '/app-direct-pay-cancel-refund.js') && /node --check src\/pwa\/public\/app-direct-pay-cancel-refund\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-cancel-refund\.js'\s*:/.test(RATCHET))
  ok('37b. card gated to direct_p2p + accepted + party only', /order\.payment_rail !== 'direct_p2p' \|\| order\.status !== 'accepted' \|\| !\(isBuyer \|\| isSeller\)/.test(CRF))
  ok('37c. card wired into order detail', /window\.dpCancelRefundCard \? window\.dpCancelRefundCard\(order, isBuyer, isSeller\)/.test(APP))
  ok('37d. confirm requires Passkey gate token (purpose direct_pay_order_action, action cancel_refund_confirm)', /requestPasskeyGate\('direct_pay_order_action', \{ order_id: oid, action: 'cancel_refund_confirm' \}\)/.test(CRF))
  ok('37e. buyer confirm has danger confirmModal (irreversible; do NOT confirm if refund not arrived)', /确认后订单将无责取消,不可撤销。若尚未到账请勿确认/.test(CRF))
  ok('37f. seller mark-refunded has accountability confirmModal (false declaration recorded)', /虚假声明将留痕并可被追责/.test(CRF))
  ok('37g. seller can decline (fulfilment continues) + buyer can withdraw before response', /dpCrDecline/.test(CRF) && /dpCrWithdraw/.test(CRF) && CRF.includes("t('拒绝(继续发货)')"))
  ok('37h. DTO: orders-read exposes order.cancel_refund only for direct_p2p+accepted', /payment_rail === 'direct_p2p' && order\.status === 'accepted'[\s\S]{0,200}getCancelRefundState/.test(readFileSync('src/pwa/routes/orders-read.ts', 'utf8')))
  ok('37i. state machine: accepted→cancelled is system-only (parties cannot drive it directly)', /'accepted→cancelled': \{[\s\S]{0,60}allowedRoles: \['system'\]/.test(readFileSync('src/layer0-foundation/L0-2-state-machine/transitions.ts', 'utf8')))
  for (const k of ['取消订单并退款(直付)', '申请取消并退款', '我已退款', '拒绝(继续发货)', '已收到退款,确认取消订单(需 Passkey)', '撤回请求', '订单已无责取消']) ok(`37-i18n EN present: ${k.slice(0, 10)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 43. 首单 UX 优化:文案准确化 + 融合付款弹窗(可复制三要素)+ 重复注册提醒修复。 ──
{
  const PM = P('app-direct-pay-paymodal.js')
  ok('43a. paymodal registered (index.html + pwa-syntax + ratchet)', has(HTML, '/app-direct-pay-paymodal.js') && /node --check src\/pwa\/public\/app-direct-pay-paymodal\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-paymodal\.js'\s*:/.test(RATCHET))
  ok('43b. fused modal copy-rows for account + amount + reference (dpCopyBtn per row; amount reuses dpPayAmountText display, copies numeric)', /window\.dpCopyBtn\(copyText\)/.test(PM) && /row\(t\('收款账号 \/ 说明'\)[\s\S]{0,40}instr\)/.test(PM) && /row\(t\('应付金额'\), escHtml\(amtText\), amtCopy\)/.test(PM) && /window\.dpPayAmountText \? window\.dpPayAmountText\(order\)/.test(PM) && /window\.dpPayRef\(oid\)/.test(PM))
  ok('43c. modal 我已付款 → dpHandleAction mark_paid (no extra Passkey; reuses gate)', /dpPayModalMarkPaid[\s\S]{0,120}window\.dpHandleAction\(oid, 'mark_paid'\)/.test(PM))
  ok('43d. 稍后处理 → navigate to order page (fallback still reachable)', /dpPayModalLater[\s\S]{0,80}navigate\('#order\/' \+ oid\)/.test(PM))
  // 文案准确化:披露 + 卡片不再"拒绝退款",改"无退款能力/不能承诺退款"
  const DISC = readFileSync('src/direct-pay-disclosures.ts', 'utf8')
  ok('43e. D1/D2 reframed to no-refund-capability (versions bumped)', /不能承诺退款/.test(DISC) && /无退款能力/.test(DISC) && /d1\.v2/.test(DISC) && /d2\.v2/.test(DISC))
  ok('43f. disclosure card bullet reframed (非担保 · 无退款能力 · 仅信誉处罚)', /非担保交易:WebAZ 不托管本金、无退款能力,仅对卖家有信誉处罚权/.test(DP))
  ok('43g. ack confirm button = 了解直接付款', /t\('了解直接付款\(需 Passkey\)'\)/.test(DP))
  // 重复注册提醒修复:仅 NO_PASSKEY_REGISTERED 才导去注册;已注册取消/设备失败仅提示
  ok('43h. dpPromptRegisterPasskey gates registration prompt on err.code NO_PASSKEY_REGISTERED only; else localized retry (no wrong-locale raw reason)', /err\.code === 'NO_PASSKEY_REGISTERED'/.test(DP) && /toast\$\(t\('验证未完成,请重试'\)/.test(DP))
  ok('43i. webauthn start returns NO_PASSKEY_REGISTERED code + requestPasskeyGate propagates it', /error_code: 'NO_PASSKEY_REGISTERED'/.test(readFileSync('src/pwa/routes/webauthn.ts', 'utf8')) && /_e\.code = start\.error_code/.test(APP))
  // Passkey 3→2:两屏披露都缺 → 一次 ceremony(stage 'both');dpAfterCreate 先落订单页再叠弹窗(防 overlay/ESC 关掉后失联)
  ok('43j. dpEnsureAcks fuses both missing disclosures into ONE ceremony (dpDoAck both)', /dpDoAck\(orderId, missing\.length === 2 \? 'both' : missing\[0\]\)/.test(DP) && /下一步/.test(DP))
  ok('43k. route accepts stage:both → records both stages (contract v14)', /stage !== 'both' && !VALID_STAGES\.includes/.test(readFileSync('src/pwa/routes/direct-pay-disclosure-acks.ts', 'utf8')) && /CONTRACT_VERSION = 28/.test(readFileSync('src/version.ts', 'utf8')))
  ok('43l. dpAfterCreate navigates to order page BEFORE opening the modal (dismissal-safe)', /navigate\(`#order\/\$\{orderId\}`\)[\s\S]{0,120}dpShowPaymentModal/.test(DP))
  for (const k of ['了解直接付款(需 Passkey)', '下一步', '请按以下信息付款', '收款账号 / 说明', '应付金额', '付款附言(务必填写,用于卖家核对)', '稍后在订单页处理', '验证未完成,请重试', '非担保交易:WebAZ 不托管本金、无退款能力,仅对卖家有信誉处罚权']) ok(`43-i18n EN present: ${k.slice(0, 8)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 42. 审计项 B(N1 通知 i18n 架构 + N2 直付覆盖):template_key+params 客户端渲染,旧行回退。 ──
{
  const NT = P('app-notif-templates.js')
  ok('42a. app-notif-templates.js registered (index.html + pwa-syntax + ratchet, loads before app.js)', HTML.indexOf('/app-notif-templates.js') > 0 && HTML.indexOf('/app-notif-templates.js') < HTML.indexOf('/app-admin.js') && /node --check src\/pwa\/public\/app-notif-templates\.js/.test(PKG) && /'src\/pwa\/public\/app-notif-templates\.js'\s*:/.test(RATCHET))
  ok('42b. 5 direct-pay templates registered', ['dp_new_order', 'dp_marked_paid', 'dp_window_expired', 'dp_grace_cancelled_buyer', 'dp_grace_cancelled_seller'].every(k => NT.includes(k + ':')))
  ok('42c. list render + SSE toast both go through notifRender (fallback-safe)', /window\.notifRender \? window\.notifRender\(nRaw\) : nRaw/.test(APP) && /window\.notifRender \? window\.notifRender\(data\) : data/.test(APP))
  // runtime:真实 eval 模板注册表 —— 占位符替换 + 未知 key/坏 params 回退原 title/body
  {
    const sandbox: Record<string, unknown> = {}
    ;(new Function('window', 't', NT))(sandbox, (s: string) => s)
    const render = sandbox.notifRender as (n: Record<string, unknown>) => { title: string; body: string }
    const r1 = render({ title: '旧', body: '旧体', template_key: 'dp_window_expired', params: '{"graceHours":48}' })
    ok('42d. runtime: template renders with param substitution', r1.title.includes('直付付款窗口已过期') && r1.body.includes('48 小时'), JSON.stringify(r1))
    const r2 = render({ title: '旧标题', body: '旧体', template_key: 'unknown_key', params: '{}' })
    const r3 = render({ title: '旧标题2', body: '旧体2', template_key: 'dp_window_expired', params: '{bad json' })
    ok('42e. runtime: unknown key / bad params fall back to stored title/body', r2.title === '旧标题' && r3.title === '旧标题2' && r3.body === '旧体2')
  }
  ok('42f. engine: createNotification persists template_key+params (opts)', /INSERT INTO notifications \(id, user_id, order_id, type, title, body, template_key, params\)/.test(readFileSync('src/layer2-business/L2-6-notifications/notification-engine.ts', 'utf8')))
  for (const k of ['新直付订单,等买家付款', '买家已标记付款,请核对后发货', '直付付款窗口已过期', '直付订单已自动取消', '直付订单已自动取消(买家未付款)', '商品「{product}」× {qty},应付 {amount} USDC。买家完成场外付款并标记后你会收到发货提醒。', '若你已付款:请在 {graceHours} 小时宽限期内到订单页提交付款凭证发起争议;未付款可直接关闭订单,否则宽限期满将自动取消。']) ok(`42-i18n EN present: ${k.slice(0, 10)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 41. 审计项 G/H(收尾):admin rail 区分 + expired 状态买家双出口。 ──
{
  const NEG = P('app-direct-pay-negotiation.js')
  ok('41a. H: expired 宽限期买家动作 = 主张已付(证据争议)+ 确认未付关单', /s === 'direct_expired_unconfirmed' && isBuyer/.test(NEG) && /action: 'dispute'[\s\S]{0,120}needsEvidence: true/.test(NEG) && /我未付款 · 关闭订单/.test(NEG))
  const OA = readFileSync('src/pwa/routes/orders-action.ts', 'utf8')
  ok('41b. H: 后端 cancel guard 与状态机对齐(payment_query + direct_expired_unconfirmed)', /\['payment_query', 'direct_expired_unconfirmed'\]\.includes\(order\.status as string\)/.test(OA))
  const AR = readFileSync('src/pwa/routes/admin-reports.ts', 'utf8')
  ok('41c. G: admin orders 下发 payment_rail + ?rail 过滤', /o\.created_at, o\.payment_rail/.test(AR) && /if \(rail\) \{ where\.push\('o\.payment_rail = \?'\)/.test(AR))
  ok('41d. G: admin 订单列表按轨显示(直付徽标 + USDC;escrow 仍 WAZ)', /o\.payment_rail === 'direct_p2p' \? [\s\S]{0,220}\$\{t\('直付'\)\}[\s\S]{0,80}USDC` : `\$\{o\.total_amount\} WAZ`/.test(APP))
  ok('41e. G: create 单买家在途上限(param 驱动,只读门,精确 429 code)', /direct_pay\.max_open_per_buyer_seller/.test(readFileSync('src/direct-pay-create.ts', 'utf8')) && /DIRECT_PAY_TOO_MANY_OPEN/.test(readFileSync('src/direct-pay-create.ts', 'utf8')))
}

// ── 40. 审计项 F(卖家对账卡):accepted 时卖家显性看到 期望参考号+应付+同金额告警。 ──
{
  const REC = P('app-direct-pay-reconcile.js')
  ok('40a. app-direct-pay-reconcile.js registered (index.html + pwa-syntax + ratchet)', has(HTML, '/app-direct-pay-reconcile.js') && /node --check src\/pwa\/public\/app-direct-pay-reconcile\.js/.test(PKG) && /'src\/pwa\/public\/app-direct-pay-reconcile\.js'\s*:/.test(RATCHET))
  ok('40b. card gated to seller + direct_p2p + accepted only', /!order \|\| !isSeller \|\| order\.payment_rail !== 'direct_p2p' \|\| order\.status !== 'accepted'/.test(REC))
  ok('40c. card shows expected reference (dpPayRef, escaped) + copy button', /window\.dpPayRef\(order\.id\)/.test(REC) && /escHtml\(ref\)/.test(REC) && /window\.dpCopyBtn \? window\.dpCopyBtn\(ref\)/.test(REC))
  ok('40d. card shows frozen payable (dpPayAmountText) + dup-amount alert from DTO', /dpPayAmountText\(order\)/.test(REC) && /order\.duplicate_amount_alert/.test(REC))
  ok('40e. card wired into order detail', /window\.dpReconcileCard \? window\.dpReconcileCard\(order, isSeller\)/.test(APP))
  ok('40f. DTO: duplicate_amount_alert computed seller-only for direct_p2p accepted', /order\.seller_id === user\.id[\s\S]{0,400}duplicate_amount_alert/.test(readFileSync('src/pwa/routes/orders-read.ts', 'utf8')))
  for (const k of ['发货前对账(买家已标记付款)', '银行/收款App流水附言应为', '同买家另有', '笔同金额直付订单在途 —— 每笔转账只能核销一个订单,请逐单核对参考号,谨防一笔款冒充多单。', '请核实款项【已到账】且附言/金额与本单一致再发货;发货即视为确认收款。未收到请点"未收到货款"。']) ok(`40-i18n EN present: ${k.slice(0, 10)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 39. 审计项 E(应付金额稳定化):下单冻结的参考换算优先,不随实时汇率漂移。 ──
{
  const PAY = P('app-direct-pay-pay.js')
  ok('39a. dpPayAmountText prefers the at-create payable snapshot over live conversion', /Number\.isFinite\(Number\(snap\.payable_approx\)\)/.test(PAY) && /下单时参考价,以卖家收款说明为准/.test(PAY))
  ok('39b. legacy orders (no snapshot) still fall back to live conversion then USDC-only', /window\.dpFxInCurrency \? window\.dpFxInCurrency\(usdc, cur\)/.test(PAY))
  ok('39c. create freezes payable_* into the account snapshot (server-side, sync cached FX)', /buildPayableSnapshot\(ctx\.totalAmount, acc\.currency\)/.test(readFileSync('src/direct-pay-create.ts', 'utf8')) && /getUsdRatesSync/.test(readFileSync('src/fx-rates.ts', 'utf8')))
  ok('39d. mark_paid timeline carries the payable amount', /应付 \$\{order\.total_amount\} USDC/.test(readFileSync('src/pwa/routes/orders-action.ts', 'utf8')))
  for (const k of ['下单时参考价,以卖家收款说明为准']) ok(`39-i18n EN present: ${k.slice(0, 10)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

// ── 38. 防作弊 D(对账正确性):服务端权威参考号 + 直付发货前核款提示。 ──
{
  const OA = readFileSync('src/pwa/routes/orders-action.ts', 'utf8')
  ok('38a. mark_paid 服务端权威派生参考号(忽略客户端伪造,与前端 dpPayRef 同算法)', /const canonicalRef = 'WAZ-' \+ req\.params\.id\.replace/.test(OA) && /notes = `付款参考: \$\{canonicalRef\}/.test(OA))
  ok('38b. 同买家同金额在途多单 → mark_paid 时间线预警', /同买家另有 \$\{dup!\.n\} 笔同金额直付订单在途/.test(OA))
  ok('38c. 直付发货确认弹窗:核款 + 参考号 + 发货即认款', /window\._dpOrderRail === 'direct_p2p' && window\.dpPayRef\) \? `\$\{t\('直付订单:发货前请核实货款已到账/.test(APP))
  for (const k of ['直付订单:发货前请核实货款已到账 —— 银行流水附言应为', '(同买家同金额多单务必逐单核对参考号)。发货即视为你确认已收到货款;发货后不可再报告未收款,只能走争议。']) ok(`38-i18n EN present: ${k.slice(0, 12)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

if (fail > 0) { console.error(`\n❌ direct-pay UI (PR-4f-b) FAILED\n  ✅ pass ${pass}\n  ❌ fail ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ direct-pay UI (PR-4f-b): seller instruction CRUD + buyer rail/disclosure/ack + order-detail disclosures + Passkey-gated actions; bilingual copy + i18n parity; non-custodial, no payment-capability surface\n  ✅ pass ${pass}`)
