#!/usr/bin/env tsx
/**
 * auto_accept Skill — honest risk copy (static source contract).
 *   用法:npm run test:auto-accept-risk-copy
 *
 * shouldAutoAccept(skill-engine) 只校验金额/每日上限,【不校验库存】,且把 paid→accepted(跳过卖家拒单窗口),
 * 接单后履约/超时责任不变。UI 必须诚实披露这三点,不能写"自动免责"或暗示自动接单=没有责任。
 */
import { readFileSync } from 'node:fs'
const app = readFileSync('src/pwa/public/app.js', 'utf8')
const i18n = readFileSync('src/pwa/public/i18n.js', 'utf8')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// 1) 配置提示(SKILL_CONFIG_HINTS.auto_accept)诚实披露三点责任
const hintBlock = app.slice(app.indexOf('SKILL_CONFIG_HINTS'), app.indexOf('SKILL_CONFIG_HINTS') + 1200)
ok('auto_accept hint warns: fulfillment/timeout liability unchanged', /auto_accept:[\s\S]{0,400}按时发货[\s\S]{0,40}违约判责/.test(hintBlock))
ok('auto_accept hint warns: skips the decline window', /auto_accept:[\s\S]{0,400}拒绝接单[\s\S]{0,40}无法再拒单/.test(hintBlock))
ok('auto_accept hint warns: stock is NOT checked', /auto_accept:[\s\S]{0,400}不校验库存/.test(hintBlock))
ok('auto_accept hint dropped the old misleading "无需手动操作，系统自动接受。可设置" line',
  !/auto_accept:\s*'自动接单：买家下单后无需手动操作，系统自动接受。可设置每日上限、金额范围。'/.test(app))

// 2) 卖家技能卡持续风险提示(仅 auto_accept)
ok('seller auto_accept skill card shows a persistent risk note',
  /s\.skill_type === 'auto_accept' \?[\s\S]{0,200}自动接单仍受约束/.test(app))

// 3) 诚实:不得有【正面】"自动免责"声明。允许诚实否定式("不是自动免责"/"说成自动免责")。
//    auto_accept 自己的文案完全不出现该词。
const positiveExemption = app.replace(/不是自动免责/g, '').replace(/说成自动免责/g, '')
ok('no POSITIVE "自动免责" claim (negated forms are allowed)', !/自动免责/.test(positiveExemption))
ok('auto_accept hint + card never use "自动免责"', !/(auto_accept:[\s\S]{0,500}自动免责)|(自动接单仍受约束[\s\S]{0,200}自动免责)/.test(app))

// 4) i18n parity
for (const k of [
  '自动接单仍受约束：接单后须按时发货，超时按卖家违约判责；跳过「拒绝接单」窗口；不校验库存。',
]) {
  ok(`i18n EN present: ${k.slice(0, 16)}…`, new RegExp(`'${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(i18n))
}
ok('i18n EN present for auto_accept long hint', /Auto-accept: paid orders are accepted automatically/.test(i18n))

if (fail === 0) {
  console.log(`\n✅ auto_accept risk copy: 诚实披露 履约/超时责任不变 · 跳过拒单窗口 · 不校验库存;创建提示 + 卖家卡持续提示;无"自动免责";i18n parity\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
} else {
  console.error(`\n❌ auto_accept risk copy FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
  process.exit(1)
}
