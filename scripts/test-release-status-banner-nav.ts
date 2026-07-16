#!/usr/bin/env tsx
/** Public-release payment-status banner accuracy + welcome back-button nav guard. */
import { readFileSync } from 'node:fs'

const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
const LAUNCH_MIGRATIONS = readFileSync('src/pwa/public-launch-migrations.ts', 'utf8')
const PUBLIC_UTILS = readFileSync('src/pwa/routes/public-utils.ts', 'utf8')
const MCP = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')
const INDEX = readFileSync('src/pwa/public/index.html', 'utf8')
const README = readFileSync('README.md', 'utf8')
const README_ZH = readFileSync('README.zh-CN.md', 'utf8')

const ZH_SHORT = 'WebAZ 已发布 · Direct Pay 可进行真实付款 · 其他支付方式持续接入'
const ZH = 'Direct Pay 已上线:买家向卖家进行真实场外付款;WebAZ 记录订单状态与证据,但非托管——不代持本金、不担保、不代为退款 · 托管(escrow)当前仍为模拟测试流程,不是真实支付方式 · 其他支付方式正在持续接入'
const EN = 'Direct Pay is live: buyers make real off-platform payments to sellers; WebAZ records order states and evidence but is non-custodial — it does not hold principal, guarantee payment, or issue refunds on the seller\'s behalf · escrow remains a simulated test flow, not a real payment method · additional payment methods are being added'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

ok('paymentStatusBannerHTML exists', APP.includes('function paymentStatusBannerHTML()'))
ok('banner renders launched + payment status via t()', APP.includes(`\${t('${ZH_SHORT}')}`) && APP.includes(`\${t('${ZH}')}`))
ok('old pre-launch banner and phase gate are gone', !APP.includes('preLaunchBannerHTML') && !APP.includes('_protocolPhase'))
ok('states Direct Pay is live + real', ZH.includes('Direct Pay 已上线') && ZH.includes('真实场外付款') && /Direct Pay is live/i.test(EN))
ok('states WebAZ is non-custodial', ZH.includes('非托管') && ZH.includes('不代持本金') && ZH.includes('不担保') && /non-custodial/i.test(EN))
ok('escrow remains simulated', ZH.includes('模拟测试流程') && ZH.includes('不是真实支付方式') && /simulated test flow/i.test(EN))
ok('additional payment methods are being added', ZH.includes('其他支付方式正在持续接入') && /additional payment methods are being added/i.test(EN))
ok('new banner key has English parity', I18N.includes(`'${ZH}':`) && I18N.includes('Direct Pay is live: buyers make real off-platform payments to sellers') && I18N.includes('additional payment methods are being added'))
ok('old invite-only pre-launch banner key removed', !I18N.includes('邀请制预发布'))
ok('runtime defaults protocol phase to launched', (PUBLIC_UTILS.match(/\|\| 'launched'/g) || []).length >= 2 && MCP.includes("phase: 'launched'"))
ok('existing pre_launch DB state migrates once to launched', LAUNCH_MIGRATIONS.includes("migration_public_launch_20260716") && LAUNCH_MIGRATIONS.includes("SET value = 'launched' WHERE key = 'protocol_phase' AND value = 'pre_launch'"))
ok('static metadata says publicly launched + Direct Pay real', /publicly launched/i.test(INDEX) && /Direct Pay supports real/i.test(INDEX))
ok('README badges and status are live in both languages', /Status-Live-brightgreen/.test(README) && /Publicly launched/.test(README) && /Status-Live-brightgreen/.test(README_ZH) && /已公开发布/.test(README_ZH))
ok('README files contain no MLM self-defense copy', !/MLM|multi-level marketing|传销/i.test(README + README_ZH))

const backBtn = APP.split('\n').find(l => l.includes('w-nav-back') && l.includes('返回首页')) || ''
ok('welcome back-button navigates #buy', backBtn.includes("navigate('#buy')"))
ok('welcome back-button no longer navigates #login', backBtn.length > 0 && !backBtn.includes("navigate('#login')"))

if (fail > 0) { console.error(`\n❌ release-status banner/nav FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ launched payment-status banner accurate + welcome back→#buy\n  ✅ pass ${pass}`)
