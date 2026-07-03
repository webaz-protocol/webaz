#!/usr/bin/env tsx
/**
 * Fix A — 交易流程错误码双语覆盖守卫。
 *  ① 完整性:orders-action.ts + direct-pay-disclosure-acks.ts 的每个 error_code 都必须被前端
 *     orderErrorLookup(或 dpErrorText 的可用性码表)映射 —— 杜绝"后端中文 error 原样弹进英文 UI"。
 *  ② 双语 parity:orderErrorLookup 每条中文 t() 都有 i18n.js _EN 条目。
 *  ③ 渲染点:订单动作 / 面交确认 / 披露路径的错误渲染都经 orderErrorText/dpErrorText,不再裸弹 res.error。
 * Usage: npm run test:order-errors
 */
import { readFileSync } from 'fs'
let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

const OE = readFileSync('src/pwa/public/app-order-errors.js', 'utf8')
const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const DP = readFileSync('src/pwa/public/app-direct-pay.js', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
const ACTION = readFileSync('src/pwa/routes/orders-action.ts', 'utf8')
const ACK = readFileSync('src/pwa/routes/direct-pay-disclosure-acks.ts', 'utf8')

// orderErrorLookup 映射的码
const lookupBody = OE.slice(OE.indexOf('orderErrorLookup'), OE.indexOf('window.orderErrorText'))
const mappedCodes = new Set([...lookupBody.matchAll(/\b([A-Z][A-Z_]+):\s*t\(/g)].map(m => m[1]))
// dpErrorText 的可用性码(部分码由它覆盖)
const dpBody = DP.slice(DP.indexOf('window.dpErrorText'), DP.indexOf('window.dpRailSelectorHtml'))
const dpCodes = new Set([...dpBody.matchAll(/\b([A-Z][A-Z_]+):\s*t\(/g)].map(m => m[1]))

// ① 完整性
for (const [src, name] of [[ACTION, 'orders-action.ts'], [ACK, 'disclosure-acks.ts']] as const) {
  const codes = new Set([...src.matchAll(/error_code: '([A-Z_]+)'/g)].map(m => m[1]))
  for (const c of codes) ok(`[${name}] error_code ${c} bilingual-mapped`, mappedCodes.has(c) || dpCodes.has(c))
}

// ② 双语 parity
const zhStrings = [...lookupBody.matchAll(/t\('([^']+)'\)/g)].map(m => m[1])
ok('orderErrorLookup has entries', zhStrings.length >= 25)
for (const zh of zhStrings) ok(`i18n EN parity: ${zh.slice(0, 12)}`, new RegExp(`'${zh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`).test(I18N))

// ③ 渲染点已路由
ok('order-action error → orderErrorText', /orderErrorText\(res\.error_code, res\.error\)/.test(APP) && /orders\/\$\{orderId\}\/action`, body\)/.test(APP))
ok('confirm-in-person error → orderErrorText', /confirm-in-person`, \{\}\)[\s\S]{0,140}orderErrorText\(res\.error_code, res\.error\)/.test(APP))
ok('dpErrorText delegates to orderErrorLookup', /window\.orderErrorLookup && window\.orderErrorLookup\(code\)/.test(DP))

if (fail > 0) { console.error(`\n❌ order-errors i18n FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ order-errors i18n: every transaction error_code bilingual-mapped (${mappedCodes.size} codes) + EN parity + render sites routed\n  ✅ pass ${pass}`)
