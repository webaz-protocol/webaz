#!/usr/bin/env tsx
/**
 * A2 display 线单测 — displayEta / displayExpiresAt / 投影接线。
 * 契约:display_* 永远是【纯字符串或 null】,绝不是对象/JSON 串;原始领域字段(estimated_days /
 * expires_at)原样保留(协议兼容,其他客户端不受影响)。Usage: npm run test:display-fields
 */
import { displayEta, displayExpiresAt, projectProductModel, projectQuoteConsumer, projectDraftConsumer } from '../src/agent-model-projection.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

// ── displayEta:与 widget etaDisplay 同域 ──
ok('D-1 region map picks dest region', displayEta({ SG: 12, all: 9 }, 'SG') === '约12天')
ok('D-1 region map falls to all', displayEta({ SG: 12, all: 9 }) === '约9天')
ok('D-1 region case-insensitive', displayEta({ SG: 12, all: 9 }, 'sg') === '约12天')
ok('D-1 number', displayEta(5) === '约5天')
ok('D-1 numeric string', displayEta('7') === '约7天')
ok('D-1 range string', displayEta('3-5') === '3–5天')
ok('D-1 range object', displayEta({ estimated_min_days: 3, estimated_max_days: 5 }) === '3–5天')
ok('D-1 same-range → 约N天', displayEta({ estimated_min_days: 4, estimated_max_days: 4 }) === '约4天')
ok('D-1 JSON-string region map', displayEta('{"SG":12,"all":12}') === '约12天')
ok('D-1 legacy_missing', displayEta({ legacy_missing: true }) === '下单时未记录预计配送时间')
ok('D-1 null → null (widget 自兜文案)', displayEta(null) === null)
ok('D-1 empty object → null', displayEta({}) === null)
ok('D-1 invalid JSON string → null (不外泄原串)', displayEta('{oops') === null)
ok('D-1 NEVER object/JSON output', [displayEta({ SG: 1 }), displayEta('{"SG":1}'), displayEta(3)].every(v => v === null || (typeof v === 'string' && !/[{}[\]]/.test(v))))

// ── displayExpiresAt:固定新加坡时间 ──
ok('D-2 ISO → SGT string', displayExpiresAt('2026-07-21T06:20:08.994Z') === '2026-07-21 14:20(新加坡时间)')
ok('D-2 midnight rollover', displayExpiresAt('2026-07-21T18:30:00Z') === '2026-07-22 02:30(新加坡时间)')
ok('D-2 null/garbage → null', displayExpiresAt(null) === null && displayExpiresAt('not-a-date') === null && displayExpiresAt('') === null)

// ── 投影接线:display_* 是字符串或 null,原始字段保留 ──
const prod = projectProductModel({ id: 'p1', title: 't', price: 19.9, stock: 3, estimated_days: { SG: 12, all: 12 } }, 'SG')
ok('D-3 product display_eta wired', prod.display_eta === '约12天')
ok('D-3 product raw estimated_days retained', JSON.stringify(prod.estimated_days) === '{"SG":12,"all":12}')
const prodNoRegion = projectProductModel({ id: 'p1', title: 't', price: 1, stock: 9, estimated_days: null })
ok('D-3 product null eta → null', prodNoRegion.display_eta === null)

const fxNull = null as never
const noCcy = (): string => 'USD'
const q = projectQuoteConsumer({ quote_id: 'q1', quote_token: 'qt', product: { product_id: 'p', title: 't' }, quantity: { quoted: 1 },
  payable_total: { amount_minor: 19900000 }, line_items: [], destination: { region: 'SG' },
  shipping: { supported: true, handling_hours: 72, estimated_days: { SG: 12, all: 12 } },
  trade_terms: {}, payment: { rail: 'escrow' }, expires_at: '2026-07-21T06:20:08.994Z' }, fxNull, noCcy)
ok('D-4 quote display_eta wired', q.display_eta === '约12天')
ok('D-4 quote display_expires_at wired', q.display_expires_at === '2026-07-21 14:20(新加坡时间)')
ok('D-4 quote raw expires_at retained (ISO)', typeof q.expires_at === 'string' && String(q.expires_at).includes('T'))

const d = projectDraftConsumer({ draft_id: 'd1', status: 'draft', product: { product_id: 'p', title: 't' }, quantity: 1,
  payable_total: { amount_minor: 19900000 }, destination: { region: 'SG' }, expires_at: '2026-07-21T06:20:08.994Z' }, fxNull, noCcy)
ok('D-5 draft display_expires_at wired', d.display_expires_at === '2026-07-21 14:20(新加坡时间)')

if (fail > 0) { console.error(`\n❌ display-fields FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ display-fields: displayEta/displayExpiresAt 全域(string|null,绝不对象/JSON)+ product/quote/draft 投影接线\n  ✅ pass ${pass}`)
