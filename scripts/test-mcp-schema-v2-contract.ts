#!/usr/bin/env tsx
/**
 * BUG-06 — unified v2 card contract + backward compatibility.
 * Part A (projection layer): quote/draft/approval/timeline emit v2 (schema_version + type + status
 *   object {code,label,label_en} + positive-int quantity); projectQuantity safe-integer contract —
 *   invalid data (number/string/decimal/negative/zero/overflow/empty/null/non-numeric) → EXPLICIT
 *   invalid result (quantity_valid=false + machine error code), NEVER faked to 1; invalid quantity
 *   disables the quote/draft transaction buttons and fires no tool call; statusView + unknown-code fallback;
 *   promised_eta (webaz.promised_eta.v1) preserved; timestamps ISO-8601 UTC; quantity is display-only
 *   (amount stays price.amount_minor); zero-PII.
 * Part B (component, node:vm): render v1 (legacy) AND v2 forms of every card; unknown schema_version →
 *   "不支持此旧卡片版本" (never mis-renders another card); missing schema_version → no-structured-payload
 *   text; cross-input (wrong card shape) never mis-applies; status object/string both render.
 * Usage: npx tsx scripts/test-mcp-schema-v2-contract.ts
 */
import vm from 'node:vm'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'v2contract-')); process.env.HOME = home; process.env.USERPROFILE = home
const proj = await import('../src/agent-model-projection.js')
const { __WIDGET_COMPAT_JS, QUOTE_APPROVAL_BODY_JS, ORDER_TIMELINE_BODY_JS } = await import('../src/layer1-agent/L1-1-mcp-server/ui-widgets.js')
const { OUTPUT_SCHEMAS } = await import('../src/layer1-agent/L1-1-mcp-server/tool-output-schemas.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }
const noFx = null; const r2c = (): string => 'USD'
const isStatusObj = (s: unknown): boolean => !!s && typeof s === 'object' && typeof (s as Record<string, unknown>).code === 'string' && typeof (s as Record<string, unknown>).label === 'string' && typeof (s as Record<string, unknown>).label_en === 'string'
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

const PE = { schema_version: 'webaz.promised_eta.v1', destination_region: 'SG', estimated_days_text: '3-5', estimated_min_days: 3, estimated_max_days: 5, source: 'template_exact', captured_at: '2026-07-20T00:00:00.000Z' }

// ─────────────── Part A — projection layer ───────────────

// A1. projectQuantity — valid data passes through; invalid data is an EXPLICIT invalid result
//   (NEVER silently faked as "quantity 1"). Diagnostic: {quantity:null, quantity_valid:false, quantity_error}.
const pq = (v: unknown): Record<string, unknown> => proj.projectQuantity(v)
const valid = (v: unknown, n: number): boolean => { const r = pq(v); return r.quantity === n && !('quantity_valid' in r) && !('quantity_error' in r) }
const badq = (v: unknown, code: string): boolean => { const r = pq(v); return r.quantity === null && r.quantity_valid === false && r.quantity_error === code }
ok('A1a. valid 3 → {quantity:3} (no diagnostic field — valid path unchanged)', valid(3, 3))
ok('A1b. valid "2" (clean integer string) → 2', valid('2', 2))
ok('A1c. valid "  4 " (trimmed) → 4', valid('  4 ', 4))
ok('A1d. MAX_SAFE_INTEGER passes through', valid(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER))
ok('A1e. decimal 2.5 → INVALID not_integer (never truncated to 2)', badq(2.5, 'not_integer'))
ok('A1f. decimal string "2.5" → INVALID not_integer', badq('2.5', 'not_integer'))
ok('A1g. negative -3 → INVALID negative (never faked to 1)', badq(-3, 'negative'))
ok('A1h. zero 0 → INVALID zero', badq(0, 'zero'))
ok('A1i. overflow 1e21 → INVALID overflow', badq(1e21, 'overflow'))
ok('A1j. null → INVALID missing', badq(null, 'missing'))
ok('A1k. undefined → INVALID missing', badq(undefined, 'missing'))
ok('A1l. "" → INVALID empty', badq('', 'empty'))
ok('A1m. "abc" → INVALID non_numeric', badq('abc', 'non_numeric'))
ok('A1n. NaN → INVALID non_numeric', badq(NaN, 'non_numeric'))
ok('A1o. object → INVALID non_numeric', badq({} as unknown, 'non_numeric'))
ok('A1p. quantity_error is a machine code (zero-PII, no free text)', /^[a-z_]+$/.test(String(pq(-1).quantity_error)))

// A2. statusView(code, meanings) → object; unknown code falls back to code (never crashes / never invents)
const sD = proj.statusView('draft', proj.DRAFT_STATE_MEANINGS)
ok('A2a. draft status object {code,label(zh),label_en}', isStatusObj(sD) && (sD.code === 'draft') && sD.label === '草稿' && sD.label_en === 'draft')
const sA = proj.statusView('needs_reconcile', proj.APPROVAL_STATE_MEANINGS)
ok('A2b. approval needs_reconcile mapped', isStatusObj(sA) && sA.label === '需对账')
const sU = proj.statusView('totally_unknown_code', proj.DRAFT_STATE_MEANINGS)
ok('A2c. unknown code → {code, label=code, label_en=code} (honest, never dropped)', sU.code === 'totally_unknown_code' && sU.label === 'totally_unknown_code' && sU.label_en === 'totally_unknown_code')

// A3. quote v2 projection
const quoteRaw = { quote_id: 'q1', quote_token: 'qtk_x', product: { product_id: 'prd1', title: 'Ring' }, destination: { region: 'SG', address_summary: 'S… masked' }, payment: { rail: 'escrow' }, shipping: { supported: true, estimated_days: '3-5' }, trade_terms: { return_days: 7 }, quantity: { quoted: 2 }, payable_total: { amount_minor: 7_060_000 }, line_items: [{ code: 'item_subtotal', amount_minor: 7_060_000 }], expires_at: '2026-07-20 01:02:03', promised_eta: PE }
const q = proj.projectQuoteConsumer(quoteRaw, noFx, r2c)
ok('A3a. quote schema_version v2 + type', q.schema_version === 'webaz.order_quote.model.v2' && q.type === 'order_quote')
ok('A3b. quote status object {code:quoted}', isStatusObj(q.status) && (q.status as Record<string, unknown>).code === 'quoted')
ok('A3c. quote quantity positive integer (2)', q.quantity === 2 && Number.isInteger(q.quantity))
ok('A3d. quote expires_at ISO-8601 UTC', UTC.test(String(q.expires_at)))
ok('A3e. quote frozen ETA preserved via shipping.estimated_days (BUG-02, unchanged by BUG-06)', ((q.shipping as Record<string, unknown>).estimated_days) === '3-5')
ok('A3f. quote amount authoritative = price.amount_minor (NOT derived from quantity)', (q.price as Record<string, unknown>).amount_minor === 7_060_000)

// A4. draft v2 projection (raw status was a bare string 'draft')
const draftRaw = { draft_id: 'odr1', status: 'draft', product: { product_id: 'prd1', title: 'Ring' }, destination: { region: 'SG', address_summary: 'masked' }, payable_total: { amount_minor: 7_060_000 }, quantity: '3', expires_at: '2026-07-21 00:00:00', payment_rail: 'escrow', promised_eta: PE }
const d = proj.projectDraftConsumer(draftRaw, noFx, r2c)
ok('A4a. draft schema_version v2 + type', d.schema_version === 'webaz.order_draft.model.v2' && d.type === 'order_draft')
ok('A4b. draft status became an object (was a bare string)', isStatusObj(d.status) && (d.status as Record<string, unknown>).code === 'draft' && (d.status as Record<string, unknown>).label === '草稿')
ok('A4c. draft quantity "3" (string) → 3 (positive integer)', d.quantity === 3 && Number.isInteger(d.quantity))
ok('A4d. draft available_actions still gated on status CODE (draft → submit_request)', JSON.stringify(d.available_actions) === '["submit_request"]')
ok('A4e. draft consumer projection surfaces no promised_eta object (BUG-02 keeps it on the raw draft/order; BUG-06 does not add one)', !('promised_eta' in d))
ok('A4f. draft expires_at ISO UTC', UTC.test(String(d.expires_at)))
// non-draft status → no submit action (safe-fail on wrong status)
const dCancel = proj.projectDraftConsumer({ ...draftRaw, status: 'cancelled' }, noFx, r2c)
ok('A4g. cancelled draft → status object cancelled, no submit action', (dCancel.status as Record<string, unknown>).code === 'cancelled' && JSON.stringify(dCancel.available_actions) === '[]')

// A5. approval v2 projection (raw status was the bare string 'pending'); quantity intentionally n/a
const s1 = proj.projectSubmitConsumer({ request_id: 'apr1', draft_id: 'odr1', approval_url: '/#agent-approvals/apr1' })
ok('A5a. approval schema_version v2 + type', s1.schema_version === 'webaz.order_approval.model.v2' && s1.type === 'order_approval')
ok('A5b. approval status object {code:pending,label:待批准}', isStatusObj(s1.status) && (s1.status as Record<string, unknown>).code === 'pending' && (s1.status as Record<string, unknown>).label === '待批准')
ok('A5c. approval has NO quantity (references draft_id — documented v2 omission)', !('quantity' in s1))
ok('A5d. approval passkey_required stays true', s1.passkey_required === true)

// A6. timeline v2 projection (status already an object; add type + posInt quantity + UTC)
const tlRaw = { order: { order_id: 'ord1', item_ref: 'prd1', product_title: 'Ring', quantity: 2, status: 'accepted', amount: 7.06, payment_rail: 'escrow', deadline: '2026-07-22 03:04:05' }, logistics: { dest_region: 'SG', promised_eta: PE, shipping_est_days: '10-20' }, refund_status: {}, timeline: [{ from: 'created', to: 'accepted', actor_role: 'seller', at: '2026-07-20 00:00:00' }] }
const t = proj.projectOrderTimelineConsumer(tlRaw, noFx, r2c)
ok('A6a. timeline schema_version v2 + type', t.schema_version === 'webaz.order_timeline.model.v2' && t.type === 'order_timeline')
ok('A6b. timeline status object via ORDER_STATE_MEANINGS', isStatusObj(t.status) && (t.status as Record<string, unknown>).code === 'accepted')
ok('A6c. timeline valid quantity 2 → {quantity:2} (no diagnostic field)', t.quantity === 2 && !('quantity_valid' in t))
// A6c2. an order with a genuinely missing quantity → explicit invalid, NOT faked to 1
const tBad = proj.projectOrderTimelineConsumer({ ...tlRaw, order: { ...(tlRaw.order as Record<string, unknown>), quantity: null } }, noFx, r2c)
ok('A6c2. timeline null quantity → invalid diagnostic (never 1)', tBad.quantity === null && tBad.quantity_valid === false && tBad.quantity_error === 'missing')
ok('A6d. timeline promised_eta preserved unchanged as webaz.promised_eta.v1 + kept SEPARATE from shipping_est_days', JSON.stringify((t.logistics as Record<string, unknown>).promised_eta) === JSON.stringify(PE) && ((t.logistics as Record<string, unknown>).promised_eta as Record<string, unknown>).schema_version === 'webaz.promised_eta.v1' && (t.logistics as Record<string, unknown>).shipping_est_days === '10-20')
ok('A6e. timeline deadline.iso + event.at are ISO UTC', UTC.test(String((t.deadline as Record<string, unknown>).iso)) && UTC.test(String((t.timeline as Array<Record<string, unknown>>)[0].at)))

// A7. zero-PII: projections never carry raw address text
const blob = JSON.stringify([q, d, s1, t])
ok('A7. no raw address text leaks (destination only region + masked summary)', !/\d+\s+SG Rd|default_address|street|postal/i.test(blob))

// A8. outputSchema ↔ structuredContent alignment (status declared object, quantity integer)
const draftOS = JSON.stringify(OUTPUT_SCHEMAS.webaz_order_draft)
const quoteOS = JSON.stringify(OUTPUT_SCHEMAS.webaz_quote_order)
ok('A8a. draft outputSchema declares status object + nullable-integer quantity + diagnostics + type + v2 id', /"status":\{"type":"object"/.test(draftOS) && /"quantity":\{"type":\["integer","null"\]/.test(draftOS) && draftOS.includes('quantity_valid') && draftOS.includes('quantity_error') && draftOS.includes('order_draft.model.v2') && /"type":\{"type":"string","const":"order_draft"\}/.test(draftOS))
ok('A8b. quote outputSchema declares status object + nullable-integer quantity + diagnostics + v2 id', /"status":\{"type":"object"/.test(quoteOS) && /"quantity":\{"type":\["integer","null"\]/.test(quoteOS) && quoteOS.includes('quantity_valid') && quoteOS.includes('quantity_error') && quoteOS.includes('order_quote.model.v2'))

// ─────────────── Part B — component render (node:vm) ───────────────
interface N { tagName: string; className: string; textContent: string; children: N[]; _h: Record<string, Array<(e: unknown) => void>>; appendChild(c: N): N; setAttribute(k: string, v: string): void; addEventListener(ev: string, fn: (e: unknown) => void): void }
function mk(tag: string): N {
  const n = { tagName: tag, _cls: '', _text: '', value: '', disabled: false, style: {} as Record<string, string>, children: [] as N[], _h: {} as Record<string, Array<(e: unknown) => void>>,
    get className() { return this._cls }, set className(v: string) { this._cls = v },
    get textContent() { return this._text }, set textContent(v: string) { this._text = v; if (v === '') this.children = [] },
    classList: { _s: new Set<string>(), toggle(c: string) { this._s.has(c) ? this._s.delete(c) : this._s.add(c) } },
    appendChild(c: N) { this.children.push(c); return c }, setAttribute() {}, scrollIntoView() {}, querySelector() { return null },
    addEventListener(ev: string, fn: (e: unknown) => void) { (this._h[ev] = this._h[ev] || []).push(fn) } }
  return n as unknown as N
}
const allText = (n: N): string => (n.textContent || '') + (n.children || []).map(allText).join(' ')
function renderWith(body: string, out: unknown, oai: unknown = { callTool: () => Promise.resolve({}) }): string {
  const root = mk('div')
  const ctx: Record<string, unknown> = { document: { getElementById: (id: string) => (id === 'root' ? root : null), createElement: (t: string) => mk(t) }, window: { innerWidth: 1200 }, navigator: { clipboard: { writeText: () => Promise.resolve() } }, setTimeout, Promise, URL, console: { warn() {}, log() {}, error() {} }, String, Object, Array, Math, JSON, Number, isFinite }
  ctx.globalThis = ctx; ctx.self = ctx; vm.createContext(ctx)
  vm.runInContext(`${__WIDGET_COMPAT_JS}\n${body}\nthis.__render=renderBody`, ctx)
  ;(ctx.__render as (o: unknown, r: unknown) => void)(oai, out)
  return allText(root)
}
const QA = QUOTE_APPROVAL_BODY_JS as string; const TL = ORDER_TIMELINE_BODY_JS as string

// B1. v1 legacy render (bare-string status) still works — no regression for old chat messages
ok('B1a. v1 draft (status STRING "draft") renders', /订单草稿/.test(renderWith(QA, { schema_version: 'webaz.order_draft.model.v1', draft_id: 'odr1', status: 'draft', product: { title: 'Ring' }, quantity: 1, price: { display: '7 USDC' }, disclosures: [] })))
ok('B1b. v1 approval (status STRING "pending") renders', /待 Passkey 审批/.test(renderWith(QA, { schema_version: 'webaz.order_approval.model.v1', request_id: 'apr1', status: 'pending', approval_url: '/#a/apr1', disclosures: [] })))
ok('B1c. v1 quote renders', /报价/.test(renderWith(QA, { schema_version: 'webaz.order_quote.model.v1', product: { title: 'Ring' }, quantity: 1, price: { display: '7 USDC', amount_minor: 7_000_000 }, amounts: { item: 7_000_000, shipping: 0, other: 0 }, shipping: {}, disclosures: [] })))
{ const h = renderWith(QA, { schema_version: 'webaz.order_approval.model.v1', request_id: 'apr1', status: 'pending', approval_url: '/#a/apr1', disclosures: [] }); ok('B1e. v1 approval (bare string "pending") shows 待批准, NOT the English code (bilingual, no i18n regression)', /待批准/.test(h) && !/状态:pending/.test(h)) }
ok('B1d. v1 timeline (status object) renders', /Ring/.test(renderWith(TL, { schema_version: 'webaz.order_timeline.model.v1', order_id: 'o1', product: { title: 'Ring' }, status: { label: '已受理' }, timeline: [] })))

// B2. v2 render (status OBJECT) shows the localized label
ok('B2a. v2 draft status object → label 草稿 shown', /草稿/.test(renderWith(QA, { schema_version: 'webaz.order_draft.model.v2', type: 'order_draft', draft_id: 'odr1', status: { code: 'draft', label: '草稿', label_en: 'draft' }, product: { title: 'Ring' }, quantity: 2, price: { display: '14 USDC' }, disclosures: [] })))
ok('B2b. v2 approval status object → 待批准 shown', /待批准/.test(renderWith(QA, { schema_version: 'webaz.order_approval.model.v2', type: 'order_approval', request_id: 'apr1', status: { code: 'pending', label: '待批准', label_en: 'pending' }, approval_url: '/#a/apr1', disclosures: [] })))
ok('B2c. v2 timeline status object → 已受理 shown', /已受理/.test(renderWith(TL, { schema_version: 'webaz.order_timeline.model.v2', type: 'order_timeline', order_id: 'o1', product: { title: 'Ring' }, status: { code: 'accepted', label: '已受理', label_en: 'accepted' }, timeline: [] })))

// B3. unknown schema_version → safe "unsupported old card version", NEVER a mis-rendered card
const unkQA = renderWith(QA, { schema_version: 'webaz.order_draft.model.v9', draft_id: 'x', status: { code: 'draft' } })
ok('B3a. QuoteAndApproval unknown version → 不支持此旧卡片版本 (no 订单草稿/报价 body)', /不支持此旧卡片版本/.test(unkQA) && !/订单草稿/.test(unkQA))
const unkTL = renderWith(TL, { schema_version: 'webaz.order_timeline.model.v9', order_id: 'x' })
ok('B3b. OrderTimeline unknown version → 不支持此旧卡片版本', /不支持此旧卡片版本/.test(unkTL))

// B4. missing schema_version → no-structured-payload text (never a crash)
ok('B4a. QA missing schema_version → no structured payload', /no structured payload/.test(renderWith(QA, { draft_id: 'x' })))
ok('B4b. TL missing schema_version → no structured payload', /no structured payload/.test(renderWith(TL, { order_id: 'x' })))

// B5. cross-input: wrong card shape under a valid version never mis-applies another card's fields
//   quote schema carrying only a status object + no product → renders the QUOTE branch (header), not a draft/approval body
const cross = renderWith(QA, { schema_version: 'webaz.order_quote.model.v2', type: 'order_quote', status: { code: 'quoted', label: '报价', label_en: 'quoted' }, price: {}, amounts: {}, shipping: {}, disclosures: [] })
ok('B5a. quote-versioned payload routes to the quote branch only (报价), never 待 Passkey 审批', /报价/.test(cross) && !/待 Passkey 审批/.test(cross))
//   a draft-versioned payload whose status is (defensively) a bare string still renders via stLabel
ok('B5b. draft v2 version but status still a bare string → stLabel normalizes (renders, no crash)', /订单草稿/.test(renderWith(QA, { schema_version: 'webaz.order_draft.model.v2', type: 'order_draft', draft_id: 'odr1', status: 'draft', product: { title: 'Ring' }, quantity: 1, price: {}, disclosures: [] })))

// B6. quantity display safety: a malformed quantity shows 数量数据异常, NEVER ×1 (never fakes invalid data)
{ const h = renderWith(QA, { schema_version: 'webaz.order_draft.model.v1', draft_id: 'odr1', status: 'draft', product: { title: 'Ring' }, quantity: 2.5, price: {}, disclosures: [] }); ok('B6a. draft decimal quantity 2.5 → 数量数据异常 (never ×1, never ×2)', /数量数据异常/.test(h) && !/×1|×2/.test(h)) }
{ const h = renderWith(QA, { schema_version: 'webaz.order_draft.model.v1', draft_id: 'odr1', status: 'draft', product: { title: 'Ring' }, quantity: -3, price: {}, disclosures: [] }); ok('B6b. draft negative quantity -3 → 数量数据异常 (never ×1)', /数量数据异常/.test(h) && !/×1/.test(h)) }
ok('B6c. draft quantity "4" (clean integer string) → ×4 display (valid unchanged)', /×4/.test(renderWith(QA, { schema_version: 'webaz.order_draft.model.v1', draft_id: 'odr1', status: 'draft', product: { title: 'Ring' }, quantity: '4', price: {}, disclosures: [] })))
ok('B6d. draft valid quantity 2 → ×2 (valid unchanged)', /×2/.test(renderWith(QA, { schema_version: 'webaz.order_draft.model.v2', type: 'order_draft', draft_id: 'odr1', status: { code: 'draft', label: '草稿', label_en: 'draft' }, product: { title: 'Ring' }, quantity: 2, price: {}, disclosures: [] })))

// B7. invalid quantity → quantity-dependent transaction buttons DISABLED + NO tool call fires (req 5 & 6)
function renderRoot(body: string, out: unknown, oai: unknown): N {
  const root = mk('div')
  const ctx: Record<string, unknown> = { document: { getElementById: (id: string) => (id === 'root' ? root : null), createElement: (t: string) => mk(t) }, window: { innerWidth: 1200 }, navigator: { clipboard: { writeText: () => Promise.resolve() } }, setTimeout, Promise, URL, console: { warn() {}, log() {}, error() {} }, String, Object, Array, Math, JSON, Number, isFinite }
  ctx.globalThis = ctx; ctx.self = ctx; vm.createContext(ctx)
  vm.runInContext(`${__WIDGET_COMPAT_JS}\n${body}\nthis.__render=renderBody`, ctx)
  ;(ctx.__render as (o: unknown, r: unknown) => void)(oai, out)
  return root
}
const fire = (n: N): void => ((n as unknown as { _h: Record<string, Array<(e: unknown) => void>> })._h.click || []).forEach(fn => fn({}))
function findBtn(n: N, text: string): N | null { if ((n.tagName || '').toUpperCase() === 'BUTTON' && (n.textContent || '').indexOf(text) >= 0) return n; for (const c of n.children || []) { const r = findBtn(c, text); if (r) return r } return null }
const isDisabled = (b: N | null): boolean => !!b && (b as unknown as { disabled: boolean }).disabled === true

{ const calls: unknown[] = []; const oai = { callTool: (nm: string, a: unknown) => { calls.push([nm, a]); return Promise.resolve({}) } }
  const root = renderRoot(QA, { schema_version: 'webaz.order_quote.model.v2', type: 'order_quote', product: { title: 'Ring' }, quantity: null, quantity_valid: false, quantity_error: 'zero', quote_token: 'qtk_x', price: {}, amounts: {}, shipping: {}, disclosures: [] }, oai)
  const btn = findBtn(root, '创建订单草稿')
  ok('B7a. invalid quote → 创建订单草稿 button present but DISABLED', isDisabled(btn))
  if (btn) fire(btn)
  ok('B7b. clicking the disabled invalid-quote button fires NO callTool (no draft initiated on bad quantity)', calls.length === 0)
  ok('B7c. invalid quote card shows 数量数据异常 + machine error code', /数量数据异常/.test(allText(root)) && /zero/.test(allText(root))) }

{ const calls: unknown[] = []; const oai = { callTool: (nm: string, a: unknown) => { calls.push([nm, a]); return Promise.resolve({}) } }
  const root = renderRoot(QA, { schema_version: 'webaz.order_draft.model.v2', type: 'order_draft', draft_id: 'odr1', status: { code: 'draft', label: '草稿', label_en: 'draft' }, product: { title: 'Ring' }, quantity: null, quantity_valid: false, quantity_error: 'negative', price: {}, disclosures: [] }, oai)
  const btn = findBtn(root, '提交 Passkey 审批')
  ok('B7d. invalid draft → 提交审批 button DISABLED', isDisabled(btn))
  if (btn) fire(btn)
  ok('B7e. clicking the disabled invalid-draft button fires NO callTool (no submit on bad quantity)', calls.length === 0) }

{ const calls: unknown[] = []; const oai = { callTool: (nm: string, a: unknown) => { calls.push([nm, a]); return Promise.resolve({}) } }
  const root = renderRoot(QA, { schema_version: 'webaz.order_quote.model.v2', type: 'order_quote', product: { title: 'Ring' }, quantity: 2, quote_token: 'qtk_x', price: {}, amounts: {}, shipping: {}, disclosures: [] }, oai)
  const btn = findBtn(root, '创建订单草稿')
  ok('B7f. VALID quote → button ENABLED (valid path unchanged)', !!btn && !isDisabled(btn))
  if (btn) fire(btn)
  ok('B7g. VALID quote → clicking fires exactly one webaz_order_draft call', calls.length === 1 && (calls[0] as unknown[])[0] === 'webaz_order_draft') }

// C. text summary (content) quantity safety — `content` reaches the model AND is the card-less-host
//   fallback: valid → ×N; invalid → 数量数据异常; NEVER ×null (never hand a corrupt quantity to the model)
const summ = (r: Record<string, unknown>): string => proj.summarizeDraftResult(r)
const draftBase = { draft_id: 'odr1', status: { code: 'draft', label: '草稿', label_en: 'draft' }, product: { title: 'Ring' }, price: { display: '28 USDC' }, expires_at: '2026-07-21T00:00:00.000Z' }
{ const s = summ({ ...draftBase, quantity: 4 }); ok('C1. valid draft summary shows ×4 (valid unchanged)', s.includes('×4') && !s.includes('null') && !s.includes('数量数据异常')) }
{ const s = summ({ ...draftBase, quantity: null, quantity_valid: false, quantity_error: 'zero' }); ok('C2. invalid draft summary shows 数量数据异常, NEVER ×null / ×', /数量数据异常/.test(s) && !s.includes('null') && !s.includes('×')) }

if (fail > 0) { console.error(`\n❌ schema-v2-contract FAILED  ✅ ${pass} ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ mcp-schema-v2-contract: v2 unified contract (type/status object/posInt quantity) + v1↔v2 compat + unknown/missing safe-fail + cross-input isolation + promised_eta preserved + UTC + zero-PII\n  ✅ pass ${pass}`)
