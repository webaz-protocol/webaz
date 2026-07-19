#!/usr/bin/env tsx
/** Customer-facing naming contract for the #buy AI Match experience. */
import { readFileSync } from 'node:fs'

const APP = readFileSync('src/pwa/public/app.js', 'utf8')
const DISCOVER = readFileSync('src/pwa/public/app-discover.js', 'utf8')
const ACCOUNT = readFileSync('src/pwa/public/app-account.js', 'utf8')
const I18N = readFileSync('src/pwa/public/i18n.js', 'utf8')
const MANIFEST = JSON.parse(readFileSync('src/pwa/public/manifest.json', 'utf8'))
const ROUTE = readFileSync('src/pwa/routes/agent-buy.ts', 'utf8')

let pass = 0
let fail = 0
const failures: string[] = []
const ok = (name: string, condition: boolean): void => {
  if (condition) pass++
  else { fail++; failures.push(`x ${name}`) }
}

ok('buyer and guest navigation use AI找同款 with a search icon',
  (APP.match(/icon: '🔎', label: t\('AI找同款'\)/g) || []).length === 2)
ok('empty state explains find first, order only after a decision',
  DISCOVER.includes("t('已经知道想买什么？输入商品信息，先找到同款，再决定是否下单。')"))
ok('AI Match guidance is compact by default and expandable on demand',
  DISCOVER.includes('id="ai-match-guide"')
    && DISCOVER.includes('class="ai-match-guide-body"')
    && DISCOVER.includes("t('展开')"))
ok('link workflow starts with find-match language',
  DISCOVER.includes("t('开始找同款')") && APP.includes("t('正在找同款...')"))
ok('real transaction CTA remains explicit and separate', DISCOVER.includes("t('查看并下单')"))
ok('photo entry is honest about not being live yet',
  DISCOVER.includes("t('拍照找同款')") && DISCOVER.includes("t('拍照找同款功能即将上线 — 已暂存图片：')"))
ok('old customer-facing name is gone from active UI calls',
  ![APP, DISCOVER, ACCOUNT].some(src => /t\('智能下单/.test(src)))
ok('PWA shortcut uses the new name but keeps the stable #buy URL',
  MANIFEST.shortcuts?.[0]?.name === 'AI找同款'
    && MANIFEST.shortcuts?.[0]?.short_name === '找同款'
    && MANIFEST.shortcuts?.[0]?.url === '/#buy')
ok('English translation is consumer-readable', I18N.includes("'AI找同款': 'AI Match'"))
ok('legacy API route remains compatible', ROUTE.includes("app.post('/api/agent-buy'"))
ok('buyer-only API error uses the new customer name', ROUTE.includes("error: 'AI找同款仅限买家使用'"))

if (fail > 0) {
  console.error(`\nAI find-same naming FAILED\n  pass ${pass}  fail ${fail}\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`AI find-same naming: clear discovery language, honest photo state, stable routes\n  pass ${pass}`)
