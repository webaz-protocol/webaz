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
const PROFILE = P('app-profile.js')
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

// ── 5. order/dispute evidence-request card: raw template strings now t()-wrapped + EN parity ──
ok('5a. evidence card "提交所需证据" t()-wrapped', has(APP, ">${t('提交所需证据')}<"))
ok('5b. evidence type select placeholder t()-wrapped', has(APP, "${t('— 选择证据类型 —')}"))
ok('5c. evidence hash input placeholder t()-wrapped', has(APP, "placeholder=\"${t('（可选）文件哈希 / IPFS CID / 链上 TX ID')}\""))
ok('5d. evidence submit button t()-wrapped', has(APP, ">${t('提交证据')}</button>"))
// 提交证据 was a key collision: 4 evidence-submit BUTTONS (Submit evidence) vs the arbitration
// TIMELINE label (Evidence Submitted). Root fix: 提交证据 = canonical "Submit evidence"; timeline
// title disambiguated to 证据提交 = "Evidence Submitted".
ok('5d-1. 提交证据 = Submit evidence (canonical button)', /'提交证据':\s*'Submit evidence'/.test(I18N))
ok('5d-2. timeline title disambiguated to 证据提交', /title: '证据提交'/.test(APP) && !/title: '提交证据'/.test(APP))
ok('5d-3. 证据提交 = Evidence Submitted', /'证据提交':\s*'Evidence Submitted'/.test(I18N))
ok('5e. evidence requester line t()-wrapped (👤/请求/对方, no raw)', has(APP, "${isMe ? t('👤 需要你提供') : `${t('请求')} → ${req.requested_from_name || t('对方')}") && !has(APP, "? '👤 需要你提供' :"))
ok('5f. evidence 类型/截止 labels t()-wrapped', has(APP, ">${t('类型：')}${typeLabels}<") && has(APP, ">${t('截止：')}${fmtTime(req.deadline)}<"))
const ORDER_DISPUTE_EN = [
  '✅ 我已付款', '包装状态描述 / 货物说明（可选）', '提交所需证据', '— 选择证据类型 —',
  '（可选）文件哈希 / IPFS CID / 链上 TX ID', '提交证据', '证据提交', '👤 需要你提供', '请求', '对方', '类型：', '截止：',
]
for (const k of ORDER_DISPUTE_EN) ok(`5g. i18n EN entry exists: ${k}`, has(I18N, `'${k}':`))
// 5h. dictionary hygiene — chunk-1 keys we own must each appear EXACTLY ONCE (catches the dup-add regression
//     where a later existing entry silently overrides the new one). NOTE: i18n.js has ~170 pre-existing
//     duplicate keys file-wide; a global zero-dup gate is a separate cleanup, out of scope here.
const cnt = (k: string) => I18N.split(`'${k}':`).length - 1
const ONCE_KEYS = [
  '✅ 我已付款', '包装状态描述 / 货物说明（可选）', '👤 需要你提供', '请求', '对方', '类型：', '截止：',
  '提交所需证据', '— 选择证据类型 —', '（可选）文件哈希 / IPFS CID / 链上 TX ID', '提交证据', '证据提交',
]
for (const k of ONCE_KEYS) ok(`5h. no duplicate i18n key: ${k} (found ${cnt(k)})`, cnt(k) === 1)

// ── 6. translation-correctness pass: keep-last (from the #146 dedup) had locked in a value that was
//       WRONG for the actual usage context. These value-fixes correct it (verified against usages). ──
ok('6a. 确认 = Confirm (not "to confirm"; 3 confirm-dialog prefixes)', /'确认':\s+'Confirm',/.test(I18N) && !has(I18N, "'确认': 'to confirm'"))
ok('6b. 待处理 = Pending (not "New"; 10 pending-status usages)', /'待处理':\s+'Pending',/.test(I18N))
ok('6c. 确认上架 = Confirm & List (not "Confirm re-list"; publish-imported button)', /'确认上架':\s+'Confirm & List',/.test(I18N))
ok('6d. 信誉 = Reputation (not "Rating")', /'信誉':\s+'Reputation',/.test(I18N))
ok('6e. 收藏 = Save (action button; not "Saved")', /'收藏':\s+'Save',/.test(I18N))
ok('6f. profile saved-items tab uses 已收藏 (Bookmarked), not the 收藏 action key', has(PROFILE, "'bookmarked', label: '★ ' + t('已收藏')") && !has(PROFILE, "'bookmarked', label: '★ ' + t('收藏')"))

if (fail > 0) { console.error(`\n❌ i18n discover/dispute labels FAILED\n  ✅ pass ${pass}\n  ❌ fail ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ i18n discover/dispute labels: discover chips + RULING_LABELS/EVIDENCE_TYPE_LABELS render sites t()-wrapped (no shadowed t), EN parity present\n  ✅ pass ${pass}`)
