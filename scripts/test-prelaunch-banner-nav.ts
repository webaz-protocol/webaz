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

const ZH = '预发布测试阶段(邀请制)· 托管为模拟测试资金、非真实结算 · 价格按 USDC 计价仅供展示 · 请勿据此投资或向第三方承诺'
const EN = 'Pre-launch test phase (invite-only) · escrow uses simulated test funds, not real settlement · USDC prices are display units only · do not invest or make third-party commitments based on this'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

// 1. banner is KEPT + still flag-gated (not deleted — it's an honesty disclosure)
ok('1a. preLaunchBannerHTML still gated on protocol_phase', APP.includes("if (window._protocolPhase && window._protocolPhase !== 'pre_launch') return ''"))
ok('1b. banner renders the new accurate copy via t()', APP.includes(`\${t('${ZH}')}`))
ok('1c. old copy is no longer a t() call', !APP.includes("t('协议尚未公开上线 · 数据为测试 / demo · 请勿据此投资或承诺第三方')"))

// 2. new copy is accurate — names simulated escrow / not-real-settlement / USDC-display / no-invest
ok('2a. mentions simulated test funds (模拟测试资金)', ZH.includes('模拟测试资金') && /simulated test funds/i.test(EN))
ok('2b. states not real settlement (非真实结算)', ZH.includes('非真实结算') && /not real settlement/i.test(EN))
ok('2c. clarifies USDC is display-only (计价仅供展示)', ZH.includes('USDC 计价仅供展示') && /USDC prices are display units only/i.test(EN))
ok('2d. keeps the do-not-invest warning', ZH.includes('请勿据此投资') && /do not invest/i.test(EN))

// 3. i18n bilingual parity for the new key
ok('3a. new banner key → EN present', I18N.includes(`'${ZH}':`) && I18N.includes(`'${EN}',`))
ok('3b. old banner i18n key removed', !I18N.includes("'协议尚未公开上线 · 数据为测试 / demo · 请勿据此投资或承诺第三方':"))

// 4. welcome "返回首页" navigates to the canonical home (#buy), not #login (the bug)
const backBtn = APP.split('\n').find(l => l.includes('w-nav-back') && l.includes('返回首页')) || ''
ok('4a. welcome back-button navigates #buy (canonical home, matches logo)', backBtn.includes("navigate('#buy')"))
ok('4b. welcome back-button no longer navigates #login', backBtn.length > 0 && !backBtn.includes("navigate('#login')"))

if (fail > 0) { console.error(`\n❌ prelaunch banner/nav FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ prelaunch banner kept + accurate (simulated escrow / USDC-display / no-invest) + welcome back→#buy\n  ✅ pass ${pass}`)
