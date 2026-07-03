#!/usr/bin/env tsx
/**
 * Fix C — 双语 parity 守卫(zh/en)。用户铁律:每条面向用户的中文都必须有 _EN 对照,否则英文模式回退中文。
 *
 * 背景:交易流程的状态/步骤提示/动作按钮/退货时间线其实【已】全部 t() 包装 + 有 _EN(排查 Fix C 时确认,
 *   之前的"只有中文"排查高估了)。真正残留的是零星 admin/PV 标签缺 _EN,以及"未来新增中文忘记补 _EN"的漂移风险。
 * 本守卫把该铁律变成 CI 门:
 *  ① 字面量 parity:app*.js 里每个 t('中文字面量') 必须在 i18n.js _EN 有条目。
 *  ② 交易数据表 parity:STATUS_ZH / STEP_HINT / RET_TYPE_META 这类经 t(变量) 渲染的标签(字面量在数据对象里,
 *     ① 的字面量扫描抓不到)也必须有 _EN —— 直接命中用户关心的"交易状态/提示"面。
 * Usage: npm run test:i18n-parity
 */
import { readFileSync, readdirSync } from 'fs'
let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
const enKeys = new Set([...I18N.matchAll(/^\s*'((?:[^'\\]|\\.)*)'\s*:/gm)].map(m => m[1]))
const hasCJK = (s: string) => /[一-鿿]/.test(s)

// ① 字面量 parity —— 全部 app*.js
const dir = 'src/pwa/public'
let litChecked = 0
for (const f of readdirSync(dir).filter(f => /^app.*\.js$/.test(f)).sort()) {
  const src = readFileSync(`${dir}/${f}`, 'utf8')
  const miss = [...new Set([...src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'\)/g)].map(m => m[1]).filter(hasCJK).filter(c => !enKeys.has(c)))]
  litChecked++
  ok(`[${f}] every t('中文') has _EN`, miss.length === 0, miss.length ? `missing: ${miss.join(' | ')}` : '')
}
ok('scanned app*.js files', litChecked >= 20)

// ② 交易数据表 parity —— STATUS_ZH / STEP_HINT(buyer/seller/overdueConsequence)/ RET_TYPE_META(title)
const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const statusBlock = (APP.match(/const STATUS_ZH = \{[\s\S]*?\n {2}\}/) || [''])[0]
const statusVals = [...statusBlock.matchAll(/'([一-鿿][^']*)'/g)].map(m => m[1])
const fieldVals = [...APP.matchAll(/\b(?:buyer|seller|overdueConsequence|title): '([一-鿿][^']*)'/g)].map(m => m[1])
const txnLabels = [...new Set([...statusVals, ...fieldVals])]
ok('extracted transaction data-map labels', txnLabels.length >= 20, `got ${txnLabels.length}`)
for (const zh of txnLabels) ok(`txn label _EN: ${zh.slice(0, 12)}`, enKeys.has(zh), enKeys.has(zh) ? '' : `no _EN for '${zh}'`)

if (fail > 0) { console.error(`\n❌ i18n parity FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ i18n parity: app*.js t('中文') literals + transaction data-map labels (${txnLabels.length}) all have _EN\n  ✅ pass ${pass}`)
