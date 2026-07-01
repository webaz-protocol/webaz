#!/usr/bin/env tsx
/**
 * Secondhand detail alignment (secondhand #3).
 *
 * Mirrors UOMA's used-goods detail: the condition grade sits INLINE with the price (the key secondhand signal,
 * previously buried in the meta chip-row), plus a compact "交易保障" (guarantees) row. The guarantees row states
 * ONLY what WebAZ actually backs — escrow, in-person escrow, and the community claim-verification that renders
 * right below on the same page — and must NOT over-claim things we don't provide (authenticity guarantee /
 * official appraisal / no-questions returns).
 *
 * Usage: npm run test:secondhand-detail-alignment
 */
import { readFileSync } from 'node:fs'

const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
const lines = APP.split('\n')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }
const has = (n: string) => APP.includes(n)

// 1. condition grade is INLINE with the price (same rendered line as the price)
const priceLine = lines.find(l => l.includes('Number(it.price).toFixed(2)} WAZ')) || ''
ok('1a. condition badge (t(cond.label)) is on the price line', priceLine.includes('${t(cond.label)}'))
ok('1b. price line wraps price + condition in a flex group', priceLine.includes('display:flex;align-items:center'))
// 1c. condition is no longer ALSO in the meta chip-row (no duplicate 4px-radius cond chip)
ok('1c. duplicate condition chip removed from the meta chip-row', !has('color:${cond.color};padding:3px 8px;border-radius:4px;font-weight:600">${t(cond.label)}</span>'))

// 2. guarantees row: titled, fee, and only the three real guarantees
ok('2a. guarantees row title 🛡️ + WebAZ 交易保障', has("🛡️ ${t('WebAZ 交易保障')}") )
ok('2b. protocol fee shown', has("${t('协议费 1%')}"))
ok('2c. escrow guarantee', has("${t('资金托管·确认收货才放款')}"))
ok('2d. in-person escrow guarantee', has("${t('面交也可托管')}"))
ok('2e. community claim-verification guarantee (ties to 声明验证 block below)', has("${t('成色声明可社区验证')}"))
ok('2f. old single escrow paragraph replaced', !has('WebAZ escrow 保障：付款后资金锁仓'))

// 3. bilingual parity for the new strings
const parity: [string, string][] = [
  ['WebAZ 交易保障', 'WebAZ trade protection'],
  ['协议费 1%', '1% protocol fee'],
  ['资金托管·确认收货才放款', 'Funds escrowed · released only on delivery confirmation'],
  ['面交也可托管', 'Escrow available for in-person deals too'],
  ['成色声明可社区验证', 'Condition claims can be community-verified'],
]
for (const [zh, en] of parity) ok(`3. EN parity: ${zh}`, I18N.includes(`'${zh}': '${en}'`))

// 4. HONESTY — the guarantees row must NOT over-claim protections WebAZ doesn't provide
const overclaim = /正品保证|保证正品|假一赔[十三]|官方鉴定|无理由退货|包退包换|authenticity guarantee|official appraisal|no-questions|guaranteed authentic/i
// scope the check to the guarantees block region (between 交易保障 title and the isOwn button)
const gStart = APP.indexOf('WebAZ 交易保障')
const gEnd = APP.indexOf('doShToggleClose', gStart)
const gBlock = gStart > 0 && gEnd > gStart ? APP.slice(gStart, gEnd) : ''
ok('4a. guarantees block does not over-claim (正品/鉴定/无理由退货…)', gBlock.length > 0 && !overclaim.test(gBlock))

if (fail > 0) { console.error(`\n❌ secondhand detail alignment FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ secondhand detail alignment: condition inline with price + honest 交易保障 guarantees row (escrow / in-person / community-verify) + bilingual, no over-claim\n  ✅ pass ${pass}`)
