#!/usr/bin/env tsx
/**
 * Pre-launch banner accuracy + welcome back-button nav fix.
 *
 * The pre-launch honesty banner is KEPT (still gated on protocol_phase — not deleted), but reworded to
 * accurately reflect the real state: invite-only pre-launch, escrow is simulated test funds (not real
 * settlement), USDC prices are display units. And the welcome page "返回首页" button navigated to #login,
 * bouncing logged-in users to the login page — fixed to the canonical home (#buy, same as the logo).
 *
 * Usage: npm run test:prelaunch-banner-nav
 */
import { readFileSync } from 'node:fs'

const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')

const ZH = '直付(direct pay)已上线,是你与卖家的真实场外付款;WebAZ 非托管——不代持、不担保、不退款 · 平台托管(escrow)尚未上线(模拟测试币)· 价格按 USDC 计价仅供展示 · 邀请制预发布,勿据此投资或向第三方承诺'
const EN = 'Direct pay is live — a real off-platform payment between you and the seller; WebAZ is non-custodial: it does not hold, guarantee, or refund it · platform escrow is not yet live (simulated test tokens) · USDC prices are display units only · invite-only pre-launch — do not invest or make third-party commitments based on this'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

// 1. banner is KEPT + still flag-gated (not deleted — it's an honesty disclosure)
ok('1a. preLaunchBannerHTML still gated on protocol_phase', APP.includes("if (window._protocolPhase && window._protocolPhase !== 'pre_launch') return ''"))
ok('1b. banner renders the new accurate copy via t()', APP.includes(`\${t('${ZH}')}`))
ok('1c. old copy is no longer a t() call', !APP.includes("t('协议尚未公开上线 · 数据为测试 / demo · 请勿据此投资或承诺第三方')"))

// 2. new copy is accurate to the REAL state: direct pay LIVE+real+non-custodial; escrow NOT live/simulated;
//    USDC display; invite-only pre-launch + no-invest. (Must NOT imply everything is test — direct pay is real.)
ok('2a. states direct pay is LIVE + a real off-platform payment', ZH.includes('直付(direct pay)已上线') && ZH.includes('真实场外付款') && /Direct pay is live/i.test(EN) && /real off-platform payment/i.test(EN))
ok('2b. states WebAZ is non-custodial (不代持/不担保/不退款)', ZH.includes('非托管') && ZH.includes('不代持') && ZH.includes('不担保') && ZH.includes('不退款') && /non-custodial/i.test(EN))
ok('2c. escrow NOT yet live + simulated (尚未上线 · 模拟测试币)', ZH.includes('平台托管(escrow)尚未上线(模拟测试币)') && /escrow is not yet live/i.test(EN))
ok('2d. does NOT falsely claim everything is test / not-real-settlement', !ZH.includes('非真实结算') && !/not real settlement/i.test(EN))
ok('2e. clarifies USDC is display-only', ZH.includes('USDC 计价仅供展示') && /USDC prices are display units only/i.test(EN))
ok('2f. keeps the do-not-invest warning', ZH.includes('勿据此投资') && /do not invest/i.test(EN))

// 3. i18n bilingual parity for the new key
ok('3a. new banner key → EN present', I18N.includes(`'${ZH}':`) && I18N.includes(`'${EN}',`))
ok('3b. old banner i18n key removed', !I18N.includes("'协议尚未公开上线 · 数据为测试 / demo · 请勿据此投资或承诺第三方':"))

// 4. welcome "返回首页" navigates to the canonical home (#buy), not #login (the bug)
const backBtn = APP.split('\n').find(l => l.includes('w-nav-back') && l.includes('返回首页')) || ''
ok('4a. welcome back-button navigates #buy (canonical home, matches logo)', backBtn.includes("navigate('#buy')"))
ok('4b. welcome back-button no longer navigates #login', backBtn.length > 0 && !backBtn.includes("navigate('#login')"))

if (fail > 0) { console.error(`\n❌ prelaunch banner/nav FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ banner kept + accurate (direct pay LIVE+real+non-custodial / escrow not-live+simulated / USDC-display / no-invest) + welcome back→#buy\n  ✅ pass ${pass}`)
