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
ok('dpSelectedRail defaults to escrow', /dpSelectedRail = \(\)[\s\S]{0,180}:[\s\S]{0,10}'escrow'/.test(DP))
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
ok('dpSelectedRail outputs direct_p2p ONLY when window._dpDirectAvailable === true', /dpSelectedRail = \(\)[\s\S]{0,160}_dpDirectAvailable === true[\s\S]{0,40}'direct_p2p'[\s\S]{0,20}:[\s\S]{0,10}'escrow'/.test(DP))
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
ok('12l. admin hub exposes a #admin/deferrals entry card', has(APP, "'#admin/deferrals')") && has(APP, '履约保证金缓交审批'))
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
ok('13k. discoverability: admin hub exposes #admin/product-verifications card', has(APP, "'#admin/product-verifications')"))
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
ok('14l. discoverability: admin hub exposes #admin/store-verifications card', has(APP, "'#admin/store-verifications')"))
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
ok('15h. discoverability: admin hub exposes #admin/compliance card', has(APP, "'#admin/compliance')"))
ok('15i. compliance UI touches no wallet/escrow/settle/refund', !/\/wallet|\/escrow|\/settle|\/refund|\/returns/.test(CMPCODE))
for (const k of ['商户合规录入', 'KYB 复核结论', '制裁筛查结论', '记录 KYB(真人 Passkey)', 'KYB 结论已记录']) {
  ok(`15-i18n EN present: ${k.slice(0, 8)}`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))
}

if (fail > 0) { console.error(`\n❌ direct-pay UI (PR-4f-b) FAILED\n  ✅ pass ${pass}\n  ❌ fail ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ direct-pay UI (PR-4f-b): seller instruction CRUD + buyer rail/disclosure/ack + order-detail disclosures + Passkey-gated actions; bilingual copy + i18n parity; non-custodial, no payment-capability surface\n  ✅ pass ${pass}`)
