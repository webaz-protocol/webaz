#!/usr/bin/env tsx
/**
 * i18n source-contract test — discover filter chips + dispute/evidence labels.
 *
 * Static source contract (no browser/server): reads the PWA .js + i18n.js as text and asserts that
 *   (a) the discover filter chips and the RULING_LABELS / EVIDENCE_TYPE_LABELS render sites are t()-wrapped
 *       (so they translate in EN mode instead of rendering raw Chinese), and
 *   (b) the EN entries those t() keys depend on exist in i18n.js (parity), and
 *   (c) no local `.map(t => …)` callback shadows the global i18n t() on the evidence-label lines.
 *
 * Scope: this mechanical UI fix ONLY. It does NOT cover the 133 remaining frontend hardcodes or the
 *   server-side notification i18n — those are tracked as follow-ups (see PR body).
 *
 * Usage: npm run test:i18n-labels
 */
import { readFileSync } from 'node:fs'

const P = (f: string) => readFileSync(`src/pwa/public/${f}`, 'utf8')
const DISCOVER = P('app-discover.js')
const APP = P('app.js')
const I18N = P('i18n.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const has = (hay: string, needle: string) => hay.includes(needle)

// ── 1. discover filter chips: every label t()-wrapped ──
const DISCOVER_LABELS = ['热门', '推荐多', '胜诉率', '最新', '信誉', '价格 ↑', '随机', '零售', '批发', '服务', '数字']
for (const k of DISCOVER_LABELS) ok(`1. discover chip t()-wrapped: ${k}`, has(DISCOVER, `t('${k}')`))
// negative: no raw "emoji + space + Chinese" label literal left in the chip maps (the old un-wrapped form)
ok('1z. no raw un-wrapped chip literal (🔥 热门 / 🛍️ 零售)', !/'🔥 热门'/.test(DISCOVER) && !/'🛍️ 零售'/.test(DISCOVER))

// ── 2. dispute ruling labels: render site t()-wrapped ──
ok('2a. RULING_LABELS render site t()-wrapped', /t\(RULING_LABELS\[rulingLabel\] \|\| rulingLabel\)/.test(APP))

// ── 3. evidence-type labels: all render sites t()-wrapped, no shadowed t ──
ok('3a. evidence typeLabels map t()-wrapped (et param, not shadowed t)', /types\.map\(et => `\$\{EVIDENCE_TYPE_ICONS\[et\] \|\| ''\}\$\{t\(EVIDENCE_TYPE_LABELS\[et\] \|\| et\)\}/.test(APP))
ok('3b. evidence inline span t()-wrapped', /EVIDENCE_TYPE_LABELS\[it\.type\] \? t\(EVIDENCE_TYPE_LABELS\[it\.type\]\) : escHtml\(it\.type\)/.test(APP))
ok('3c. evidence <option> map t()-wrapped (et param)', /types\.map\(et => `<option value="\$\{et\}">\$\{EVIDENCE_TYPE_ICONS\[et\]\} \$\{t\(EVIDENCE_TYPE_LABELS\[et\] \|\| et\)\}/.test(APP))
ok('3d. evidence meta typeLabel t()-wrapped', /const typeLabel = t\(EVIDENCE_TYPE_LABELS\[meta\.evidence_type\] \|\| meta\.evidence_type\)/.test(APP))
// negative: the shadowed form EVIDENCE_TYPE_LABELS[t] (where t is a .map param, not the i18n fn) must be gone
ok('3z. no shadowed EVIDENCE_TYPE_LABELS[t] (map param shadowing global t)', !/EVIDENCE_TYPE_LABELS\[t\]/.test(APP))

// ── 4. i18n EN parity for every t() key the above sites depend on ──
const EN_KEYS = [
  ...DISCOVER_LABELS,
  '🔵 全额退款给买家', '🟢 资金释放给卖家', '🟡 部分退款', '⚖️ 责任分配裁定',
  '文字说明', '图片', '视频', '单据/文件', '链上数据（不可篡改）',
]
for (const k of EN_KEYS) ok(`4. i18n EN entry exists: ${k}`, has(I18N, `'${k}':`))
ok("4z. 随机 maps to 'Random'", /'随机':\s*'Random'/.test(I18N))

if (fail > 0) { console.error(`\n❌ i18n discover/dispute labels FAILED\n  ✅ pass ${pass}\n  ❌ fail ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ i18n discover/dispute labels: discover chips + RULING_LABELS/EVIDENCE_TYPE_LABELS render sites t()-wrapped (no shadowed t), EN parity present\n  ✅ pass ${pass}`)
