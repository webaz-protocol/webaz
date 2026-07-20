#!/usr/bin/env tsx
/**
 * BUG-08 §一 — "再买一份" end-to-end DIRECT_TOOL chain in the REAL QUOTE_APPROVAL_BODY_JS over node:vm.
 * Proves the deterministic chain quote → draft → submit(new_purchase_intent): 3 structured calls in
 * order, NO natural-language, one consistent purchase_intent_instance, distinct per-step idempotency_key,
 * no reuse of the original quote_token/draft/approval, fail-stop on any step, single-flight on double-click,
 * and both approval entries preserved on success.
 * Usage: npx tsx scripts/test-bug08-second-purchase-widget-flow.ts
 */
import vm from 'node:vm'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'sp-widget-')); process.env.HOME = home; process.env.USERPROFILE = home
const { __WIDGET_COMPAT_JS, QUOTE_APPROVAL_BODY_JS } = await import('../src/layer1-agent/L1-1-mcp-server/ui-widgets.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

interface N { tagName: string; className: string; textContent: string; children: N[]; _h: Record<string, Array<(e: unknown) => void>>; appendChild(c: N): N }
function mk(tag: string): N {
  const n = { tagName: tag, _cls: '', _text: '', value: '', disabled: false, style: {} as Record<string, string>, children: [] as N[], _h: {} as Record<string, Array<(e: unknown) => void>>, parentNode: null as unknown,
    get className() { return this._cls }, set className(v: string) { this._cls = v },
    get textContent() { return this._text }, set textContent(v: string) { this._text = v; if (v === '') this.children = [] },
    classList: { _s: new Set<string>(), toggle(c: string) { this._s.has(c) ? this._s.delete(c) : this._s.add(c) } },
    appendChild(c: N) { (c as unknown as { parentNode: unknown }).parentNode = this; this.children.push(c); return c },
    setAttribute() {}, scrollIntoView() {}, querySelector() { return null },
    addEventListener(ev: string, fn: (e: unknown) => void) { (this._h[ev] = this._h[ev] || []).push(fn) } }
  return n as unknown as N
}
const allText = (n: N): string => (n.textContent || '') + (n.children || []).map(allText).join(' ')
const fireClick = (n: N): void => (n._h.click || []).forEach(fn => fn({}))
function findBtn(n: N, text: string): N | null { if ((n.tagName || '').toUpperCase() === 'BUTTON' && (n.textContent || '').indexOf(text) >= 0) return n; for (const c of n.children || []) { const r = findBtn(c, text); if (r) return r } return null }
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0))

function makeHost(handlers: Record<string, (a: Record<string, unknown>) => unknown>): { oai: Record<string, unknown>; calls: Array<[string, Record<string, unknown>]>; followups: string[] } {
  const calls: Array<[string, Record<string, unknown>]> = []; const followups: string[] = []
  const oai = {
    callTool: (name: string, a: Record<string, unknown>) => { calls.push([name, a]); const h = handlers[name]; return Promise.resolve(h ? h(a) : {}) },
    sendFollowUpMessage: (o: { prompt?: string }) => { followups.push((o && o.prompt) || '') },
    openExternal: () => true,
  }
  return { oai, calls, followups }
}
function renderApproval(oai: unknown, out: unknown): N {
  const root = mk('div')
  const ctx: Record<string, unknown> = { document: { getElementById: (id: string) => (id === 'root' ? root : null), createElement: (t: string) => mk(t) }, window: { innerWidth: 1200, openai: oai }, navigator: { clipboard: { writeText: () => Promise.resolve() } }, setTimeout, Promise, URL, Date, Math, console: { warn() {}, log() {}, error() {} }, String, Object, Array, JSON, Number, isFinite }
  ctx.globalThis = ctx; ctx.self = ctx; vm.createContext(ctx)
  vm.runInContext(`${__WIDGET_COMPAT_JS}\n${QUOTE_APPROVAL_BODY_JS}\nthis.__render=renderBody`, ctx)
  ;(ctx.__render as (o: unknown, r: unknown) => void)(oai, out)
  return root
}
const DUP = { schema_version: 'webaz.order_approval.model.v2', type: 'order_approval', request_id: 'apr_orig', status: { code: 'pending', label: '待批准', label_en: 'pending' }, approval_url: '/#agent-approvals/apr_orig', duplicate: true, duplicate_reason: 'ACTIVE_INTENT_REUSED', duplicate_of: 'apr_orig', available_actions: ['open_existing_approval', 'cancel_current_attempt', 'create_second_purchase'], reorder: { product_id: 'prd1', quantity: 2 }, disclosures: [] }

// ── 1. happy path: quote → draft → submit, 3 ordered structured calls, no NL, instance consistent ──
{
  const staged = makeHost({
    webaz_quote_order: () => ({ structuredContent: { schema_version: 'webaz.order_quote.model.v2', quote_token: 'qtk_NEW', quote_id: 'q_new' } }),
    webaz_order_draft: () => ({ structuredContent: { schema_version: 'webaz.order_draft.model.v2', draft_id: 'odr_NEW' } }),
    webaz_submit_order_request: () => ({ structuredContent: { schema_version: 'webaz.order_approval.model.v2', request_id: 'apr_NEW', approval_url: '/#agent-approvals/apr_NEW' } }),
  })
  const root = renderApproval(staged.oai, DUP)
  const again = findBtn(root, '再买一份')!
  ok('1. 再买一份 button present on ACTIVE_INTENT_REUSED', !!again)
  fireClick(again)
  await tick(); await tick(); await tick(); await tick()
  ok('2. exactly 3 tool calls, in order quote→draft→submit', staged.calls.length === 3 && staged.calls[0][0] === 'webaz_quote_order' && staged.calls[1][0] === 'webaz_order_draft' && staged.calls[2][0] === 'webaz_submit_order_request')
  ok('3. NO natural-language follow-up sent (all DIRECT_TOOL)', staged.followups.length === 0)
  const qArgs = staged.calls[0][1], dArgs = staged.calls[1][1], sArgs = staged.calls[2][1]
  ok('4. quote re-quotes the SAME product/quantity from reorder', qArgs.product_id === 'prd1' && qArgs.quantity === 2)
  ok('5. draft uses the NEW quote_token (not the original)', dArgs.action === 'create' && dArgs.quote_token === 'qtk_NEW')
  ok('6. submit uses the NEW draft_id + new_purchase_intent + purchase_intent_instance', sArgs.draft_id === 'odr_NEW' && sArgs.new_purchase_intent === true && typeof sArgs.purchase_intent_instance === 'string')
  const inst = String(sArgs.purchase_intent_instance)
  ok('7. purchase_intent_instance is the SAME instance threaded through every step key', String(qArgs.idempotency_key) === 'q_' + inst && String(dArgs.idempotency_key) === 'd_' + inst && String(sArgs.idempotency_key) === 's_' + inst)
  ok('8. each write step uses a DISTINCT idempotency_key', qArgs.idempotency_key !== dArgs.idempotency_key && dArgs.idempotency_key !== sArgs.idempotency_key && qArgs.idempotency_key !== sArgs.idempotency_key)
  ok('9. instance matches [A-Za-z0-9_-]{1,64} (server-validatable nonce)', /^[A-Za-z0-9_-]{1,64}$/.test(inst))
  ok('10. did NOT reuse the original approval (apr_orig) as the draft/submit target', dArgs.quote_token !== 'apr_orig' && sArgs.draft_id !== 'apr_orig')
  const txt = allText(root)
  ok('11. success shows BOTH the original approval entry and the new approval entry (no confusion)', /打开审批页面/.test(txt) && /打开新审批/.test(txt) && /apr_NEW/.test(txt) && /原审批入口保留/.test(txt))
}

// ── 2. fail-stop: quote fails (delisted/price/region) → stops, no draft/submit, recovery text ──
{
  const staged = makeHost({ webaz_quote_order: () => ({ structuredContent: { error: 'product delisted', error_code: 'PRODUCT_UNAVAILABLE' } }) })
  const root = renderApproval(staged.oai, DUP)
  fireClick(findBtn(root, '再买一份')!)
  await tick(); await tick(); await tick()
  ok('12. quote failure → ONLY the quote call fires (no draft, no submit)', staged.calls.length === 1 && staged.calls[0][0] === 'webaz_quote_order')
  ok('13. fail-stop shows the failing step + "未创建任何订单" recovery text', /再买一份失败.*报价/.test(allText(root)) && /未创建任何订单/.test(allText(root)))
}

// ── 3. fail-stop at draft ──
{
  const staged = makeHost({
    webaz_quote_order: () => ({ structuredContent: { quote_token: 'qtk_NEW' } }),
    webaz_order_draft: () => ({ structuredContent: { error: 'stock exhausted', error_code: 'OUT_OF_STOCK' } }),
  })
  const root = renderApproval(staged.oai, DUP)
  fireClick(findBtn(root, '再买一份')!)
  await tick(); await tick(); await tick()
  ok('14. draft failure → quote+draft fire but NO submit (no order)', staged.calls.length === 2 && staged.calls[1][0] === 'webaz_order_draft' && !staged.calls.some(c => c[0] === 'webaz_submit_order_request'))
}

// ── 4. rapid double-click → only ONE chain starts (single-flight) ──
{
  const staged = makeHost({
    webaz_quote_order: () => ({ structuredContent: { quote_token: 'qtk_NEW' } }),
    webaz_order_draft: () => ({ structuredContent: { draft_id: 'odr_NEW' } }),
    webaz_submit_order_request: () => ({ structuredContent: { request_id: 'apr_NEW', approval_url: '/#a/apr_NEW' } }),
  })
  const root = renderApproval(staged.oai, DUP)
  const again = findBtn(root, '再买一份')!
  fireClick(again); fireClick(again); fireClick(again)   // triple-click before the chain resolves
  await tick(); await tick(); await tick(); await tick()
  const quoteCalls = staged.calls.filter(c => c[0] === 'webaz_quote_order').length
  ok('15. triple-click starts ONE chain (exactly one quote, one submit)', quoteCalls === 1 && staged.calls.filter(c => c[0] === 'webaz_submit_order_request').length === 1)
}

// ── 5. cancel clears local flow, does NOT cancel the existing approval; wording is explicit ──
{
  const staged = makeHost({})
  const root = renderApproval(staged.oai, DUP)
  fireClick(findBtn(root, '取消本次')!)
  ok('16. 取消本次 → no tool call (does not cancel the existing approval) + explicit wording', staged.calls.length === 0 && /原有待审批购买不受影响/.test(allText(root)))
}

// ── 6. remount does NOT auto-replay a write (render alone fires nothing) ──
{
  const staged = makeHost({ webaz_quote_order: () => ({}), webaz_order_draft: () => ({}), webaz_submit_order_request: () => ({}) })
  renderApproval(staged.oai, DUP)   // render only, no click
  await tick()
  ok('17. render/remount alone fires NO write (chain only on explicit click)', staged.calls.length === 0)
}

if (fail > 0) { console.error(`\n❌ second-purchase-widget-flow FAILED  ✅ ${pass} ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ bug08-second-purchase-widget-flow: quote→draft→submit DIRECT_TOOL chain · instance consistent · distinct per-step keys · no NL · fail-stop · single-flight · both approvals kept · no auto-replay\n  ✅ pass ${pass}`)
