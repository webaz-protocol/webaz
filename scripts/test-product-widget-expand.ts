#!/usr/bin/env tsx
/**
 * P1-B1 — ProductResults widget: per-card expand/collapse with PERSISTED state, clickable basic-info,
 * detail view with 返回列表 (no more "frozen expanded"), scroll-keep, mobile one-at-a-time.
 * Drives the REAL widget body (PRODUCT_RESULTS_BODY_JS) in node:vm over a minimal mock DOM.
 * Usage: npm run test:product-widget-expand
 */
import vm from 'node:vm'
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
// Codex R2:importing server.ts runs its module-load DB init reading HOME — point it at a throwaway temp HOME
//   BEFORE the dynamic import so this widget unit test never touches the real ~/.webaz/webaz.db.
const __tmpHome = mkdtempSync(join(tmpdir(), 'widget-expand-')); process.env.HOME = __tmpHome; process.env.USERPROFILE = __tmpHome
const { __WIDGET_COMPAT_JS, PRODUCT_RESULTS_BODY_JS } = await import('../src/layer1-agent/L1-1-mcp-server/ui-widgets.js')
const { recommendationPassthrough } = await import('../src/layer1-agent/L1-1-mcp-server/server.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

// ── minimal mock DOM ──
interface N { tagName: string; _cls: string; _text: string; _attrs: Record<string, string>; style: Record<string, string>; title: string; children: N[]; parent?: N; _h: Record<string, Array<(e: unknown) => void>>; _scrolled?: boolean; className: string; textContent: string; appendChild(c: N): N; prepend(c: N): N; setAttribute(k: string, v: string): void; getAttribute(k: string): string | undefined; addEventListener(ev: string, fn: (e: unknown) => void): void; scrollIntoView(): void; querySelector(sel: string): N | null; readonly firstElementChild: N | undefined }
function mk(tag: string): N {
  const node = {
    tagName: tag, _cls: '', _text: '', _attrs: {} as Record<string, string>, style: {} as Record<string, string>, title: '', children: [] as N[], _h: {} as Record<string, Array<(e: unknown) => void>>,
    get className() { return this._cls }, set className(v: string) { this._cls = v },
    get textContent() { return this._text }, set textContent(v: string) { this._text = v; if (v === '') this.children = [] },
    appendChild(c: N) { this.children.push(c); c.parent = this as unknown as N; return c },
    prepend(c: N) { this.children.unshift(c); c.parent = this as unknown as N; return c },
    setAttribute(k: string, v: string) { this._attrs[k] = String(v) },
    getAttribute(k: string) { return this._attrs[k] },
    addEventListener(ev: string, fn: (e: unknown) => void) { (this._h[ev] = this._h[ev] || []).push(fn) },
    scrollIntoView() { this._scrolled = true },
    querySelector(sel: string) { return treeFind(this as unknown as N, sel) },
    get firstElementChild() { return this.children[0] },
  }
  return node as unknown as N
}
function treeFind(root: N, sel: string): N | null {
  const m = sel.match(/\[data-pid="(.*)"\]/); if (!m) return null; const val = m[1]
  const walk = (n: N): N | null => { if (n.getAttribute && n.getAttribute('data-pid') === val) return n; for (const c of n.children || []) { const r = walk(c); if (r) return r } return null }
  return walk(root)
}
const fire = (n: N, ev = 'click') => (n._h[ev] || []).forEach(fn => fn({}))
function findByText(root: N, text: string, tag = 'BUTTON'): N | null {
  const walk = (n: N): N | null => { if ((!tag || (n.tagName || '').toUpperCase() === tag) && n.textContent === text && n.children.length === 0) return n; for (const c of n.children || []) { const r = walk(c); if (r) return r } return null }
  return walk(root)
}
function cardFor(root: N, pid: string): N | null { return treeFind(root, `[data-pid="${pid}"]`) }
function treeTextG(n: N): string { return (n.textContent && n.children.length === 0 ? n.textContent : '') + (n.children || []).map(treeTextG).join(' ') }
function findTag(root: N, tag: string): N | null { const walk = (n: N): N | null => { if ((n.tagName || '').toUpperCase() === tag.toUpperCase()) return n; for (const c of n.children || []) { const r = walk(c); if (r) return r } return null }; return walk(root) }

const rootNode = mk('div'); rootNode.setAttribute('id', 'root')
const win: Record<string, unknown> = { innerWidth: 1200, pageYOffset: 0, scrollTo() {} }
const doc = { getElementById: (id: string) => (id === 'root' ? rootNode : null), createElement: (t: string) => mk(t) }
const ctx: Record<string, unknown> = { document: doc, window: win, setTimeout, Promise, URL, console, String, Object, Array, Math, JSON }
ctx.globalThis = ctx; ctx.self = ctx
vm.createContext(ctx)
vm.runInContext(`${__WIDGET_COMPAT_JS}\n${PRODUCT_RESULTS_BODY_JS}\nthis.__render=renderBody`, ctx)
const renderBody = ctx.__render as (oai: unknown, out: unknown) => void

const oai = { callTool() {} }
const SEARCH = { products: [{ id: 'prd_a', title: 'AAA', price: { amount_minor: 11_500_000, display: '11.5 USDC' }, summary: 'sa', return_days: 7 }, { id: 'prd_b', title: 'BBB', price: { amount_minor: 9_200_000, display: '9.2 USDC' }, summary: 'sb', return_days: 7 }], sellers: {}, result_handle: 'rh1' }

try {
  // ── initial search render: cards present, not open, button says 展开 ──
  renderBody(oai, SEARCH)
  const ca0 = cardFor(rootNode, 'prd_a')!
  ok('B1-1 search renders per-product cards with data-pid', !!ca0 && !!cardFor(rootNode, 'prd_b'))
  ok('B1-2 card starts collapsed (no "open" class)', !/\bopen\b/.test(ca0.className))
  ok('B1-3 expand button labeled 展开 initially', !!findByText(rootNode, '展开'))

  // ── click 展开 on prd_a → persisted open, label 收起 ──
  fire(findByText(cardFor(rootNode, 'prd_a')!, '展开')!)
  let caOpen = cardFor(rootNode, 'prd_a')!
  ok('B1-4 after expand: card has "open" class', /\bopen\b/.test(caOpen.className))
  ok('B1-5 after expand: that card shows 收起 (real toggle, not static 展开)', !!findByText(caOpen, '收起'))
  ok('B1-6 expand scrolls the card to top', caOpen._scrolled === true)

  // ── sort re-render must PRESERVE the open state (the core "state lost on render" bug) ──
  fire(findByText(rootNode, '价格↑')!)
  ok('B1-7 open state SURVIVES a sort re-render (state.open persisted)', /\bopen\b/.test(cardFor(rootNode, 'prd_a')!.className))
  ok('B1-8 the other card stays collapsed after sort', !/\bopen\b/.test(cardFor(rootNode, 'prd_b')!.className))

  // ── clickable basic-info (title) toggles collapse ──
  const titleA = cardFor(rootNode, 'prd_a')!.children.find(x => x.tagName === 'b')!
  ok('B1-9 title is clickable (cursor:pointer) for toggle', titleA.style.cursor === 'pointer')
  fire(titleA)  // collapse via title click
  ok('B1-10 clicking basic-info collapses it', !/\bopen\b/.test(cardFor(rootNode, 'prd_a')!.className))

  // ── detail view: 返回列表 button present + returns to the search list (no more frozen expanded) ──
  renderBody(oai, { schema_version: 'webaz.product_detail.model.v1', products: [{ id: 'prd_a', title: 'AAA', description: 'full desc', price: { display: '11.5 USDC' } }] })
  const backBtn = findByText(rootNode, '← 返回列表')
  ok('B1-11 detail view shows a 返回列表 button (not a dead-end)', !!backBtn)
  ok('B1-12 detail view has NO search cards until we go back (it is the detail)', !cardFor(rootNode, 'prd_b'))
  fire(backBtn!)
  ok('B1-13 返回列表 restores the search list (both cards back) — cached, no tool call', !!cardFor(rootNode, 'prd_a') && !!cardFor(rootNode, 'prd_b'))

  // ── B2 准备下单:one-click sends a structured follow-up (model orchestrates quote→draft→submit→Passkey).
  //    Codex R1 HIGH: it must NOT callTool webaz_quote_order (model-only → app call rejected+swallowed → stuck).
  //    So the card must issue a follow-up (never callTool) carrying the exact product_id. ──
  const calls: Array<[string, unknown]> = []
  const sent: string[] = []
  const oai2 = { callTool: (n: string, a: unknown) => { calls.push([n, a]) }, sendFollowUpMessage: (o: { prompt?: string }) => { sent.push((o && o.prompt) || '') } }
  win.innerWidth = 1200
  renderBody(oai2, SEARCH)
  const pdBtn = findByText(cardFor(rootNode, 'prd_a')!, '准备下单')
  ok('B2-1 card shows a 准备下单 primary button (not the old 报价)', !!pdBtn && !findByText(rootNode, '报价'))
  ok('B2-2 准备下单 button is styled primary', (pdBtn as N).className === 'primary')
  fire(pdBtn!)
  ok('B2-3 准备下单 sends a follow-up carrying the EXACT product_id (structured intent, not just a title)', sent.length >= 1 && sent[0].includes('prd_a') && /准备下单/.test(sent[0]))
  ok('B2-4 does NOT callTool the model-only webaz_quote_order (would be rejected+swallowed on standard hosts → stuck)', !calls.some(c => c[0] === 'webaz_quote_order'))
  ok('B2-5 widget NEVER calls money-path tools from the card (no order_draft/submit/execute)', !calls.some(c => /order_draft|submit_order|order_create|place_order|execute/.test(c[0])))
  // B4 fail-visible: after click, a visible manual path (a copyable phrase carrying the exact product_id) appears —
  //   never a silent no-op / permanent loading. The 准备下单 button re-renders usable (not stuck).
  ok('B4-1 准备下单 shows a fail-visible manual hint carrying the exact product_id (never a silent no-op)', /prd_a/.test(treeTextG(rootNode)) && !!findByText(rootNode, '“为「AAA」准备下单(product_id=prd_a)”', 'SPAN'))
  ok('B4-2 hint offers a 复制 (copy) action so any host without a working bridge can still proceed', !!findByText(rootNode, '复制'))
  ok('B4-3 准备下单 button is not permanently stuck (re-rendered usable, still labeled 准备下单)', !!findByText(cardFor(rootNode, 'prd_a')!, '准备下单') && !findByText(rootNode, '准备中…(报价→草稿→审批)'))
  // no follow-up channel → still fail-visible: hint states the host limitation + gives the same copyable phrase
  const rn2 = mk('div'); rn2.setAttribute('id', 'root'); const doc2 = { getElementById: (id: string) => (id === 'root' ? rn2 : null), createElement: (t: string) => mk(t) }
  const ctx2: Record<string, unknown> = { document: doc2, window: { innerWidth: 1200, pageYOffset: 0, scrollTo() {} }, setTimeout, Promise, URL, console, String, Object, Array, Math, JSON }
  ctx2.globalThis = ctx2; ctx2.self = ctx2; vm.createContext(ctx2)
  vm.runInContext(`${__WIDGET_COMPAT_JS}\n${PRODUCT_RESULTS_BODY_JS}\nthis.__render=renderBody`, ctx2)
  ;(ctx2.__render as (o: unknown, out: unknown) => void)({}, SEARCH)   // oai with NO follow-up channel
  const pd2 = findByText(rn2, '准备下单')!
  fire(pd2)
  ok('B4-4 no follow-up channel → not stuck + fail-visible manual phrase (product_id) shown', !(pd2 as N & { disabled?: boolean }).disabled && /prd_a/.test(treeTextG(rn2)) && !!findByText(rn2, '复制'))
  // B4 详情: openDetail fires the callTool detail fetch AND always shows a copyable manual detail phrase (fail-visible)
  const calls3: Array<[string, unknown]> = []
  const rn5 = mk('div'); rn5.setAttribute('id', 'root'); const doc5 = { getElementById: (id: string) => (id === 'root' ? rn5 : null), createElement: (t: string) => mk(t) }
  const ctx5: Record<string, unknown> = { document: doc5, window: { innerWidth: 1200, pageYOffset: 0, scrollTo() {} }, setTimeout, Promise, URL, console, String, Object, Array, Math, JSON }
  ctx5.globalThis = ctx5; ctx5.self = ctx5; vm.createContext(ctx5)
  vm.runInContext(`${__WIDGET_COMPAT_JS}\n${PRODUCT_RESULTS_BODY_JS}\nthis.__render=renderBody`, ctx5)
  ;(ctx5.__render as (o: unknown, out: unknown) => void)({ callTool: (n: string, a: unknown) => { calls3.push([n, a]) } }, SEARCH)
  fire(findByText(cardFor(rn5, 'prd_a')!, '详情')!)
  ok('B4-5 详情 → callTool webaz_search with result_handle + selected_ids (on-demand detail fetch)', calls3.some(c => c[0] === 'webaz_search' && (c[1] as { result_handle?: string; selected_ids?: string[] }).result_handle === 'rh1' && ((c[1] as { selected_ids?: string[] }).selected_ids || [])[0] === 'prd_a'))
  ok('B4-6 详情 also shows a fail-visible copyable detail phrase (never dead when host does not re-render)', /prd_a/.test(treeTextG(rn5)) && !!findByText(rn5, '复制'))
  // B4 compare→buy: selecting ≥2 renders a comparison table with a per-row 准备下单 that follows-up the row's product_id
  const sent6: string[] = []
  const rn6 = mk('div'); rn6.setAttribute('id', 'root'); const doc6 = { getElementById: (id: string) => (id === 'root' ? rn6 : null), createElement: (t: string) => mk(t) }
  const ctx6: Record<string, unknown> = { document: doc6, window: { innerWidth: 1200, pageYOffset: 0, scrollTo() {} }, setTimeout, Promise, URL, console, String, Object, Array, Math, JSON }
  ctx6.globalThis = ctx6; ctx6.self = ctx6; vm.createContext(ctx6)
  vm.runInContext(`${__WIDGET_COMPAT_JS}\n${PRODUCT_RESULTS_BODY_JS}\nthis.__render=renderBody`, ctx6)
  ;(ctx6.__render as (o: unknown, out: unknown) => void)({ sendFollowUpMessage: (o: { prompt?: string }) => { sent6.push((o && o.prompt) || '') } }, SEARCH)
  fire(findByText(cardFor(rn6, 'prd_a')!, '比较')!); fire(findByText(cardFor(rn6, 'prd_b')!, '比较')!)
  const cmpTable = findTag(rn6, 'TABLE')
  ok('B4-7 selecting ≥2 renders a compare table with a per-row 准备下单 action', !!cmpTable && treeTextG(cmpTable).includes('下单') && !!findByText(cmpTable!, '准备下单'))
  const rows6: N[] = []; (function collect(n: N){ if ((n.tagName || '').toUpperCase() === 'TR') rows6.push(n); (n.children || []).forEach(collect) })(cmpTable!)
  const rowB = rows6.find(r => treeTextG(r).includes('BBB'))!   // prd_b's row specifically (title BBB)
  ok('B4-8 compare-row 准备下单 submits THAT row exact product_id (prd_b), never another', !!rowB && (() => { fire(findByText(rowB, '准备下单')!); const last = sent6[sent6.length - 1] || ''; return last.includes('prd_b') && !last.includes('prd_a') && /准备下单/.test(last) })())

  // B4-9 fail-visible even when the host bridge THROWS synchronously (Codex R1 High) — never a silent no-op.
  const rn7 = mk('div'); rn7.setAttribute('id', 'root'); const doc7 = { getElementById: (id: string) => (id === 'root' ? rn7 : null), createElement: (t: string) => mk(t) }
  const ctx7: Record<string, unknown> = { document: doc7, window: { innerWidth: 1200, pageYOffset: 0, scrollTo() {} }, setTimeout, Promise, URL, console, String, Object, Array, Math, JSON }
  ctx7.globalThis = ctx7; ctx7.self = ctx7; vm.createContext(ctx7)
  vm.runInContext(`${__WIDGET_COMPAT_JS}\n${PRODUCT_RESULTS_BODY_JS}\nthis.__render=renderBody`, ctx7)
  ;(ctx7.__render as (o: unknown, out: unknown) => void)({ sendFollowUpMessage: () => { throw new Error('host bridge boom') } }, SEARCH)
  fire(findByText(cardFor(rn7, 'prd_a')!, '准备下单')!)
  ok('B4-9 host bridge THROWS synchronously → still fail-visible manual phrase + 复制 (not a silent no-op)', /prd_a/.test(treeTextG(rn7)) && !!findByText(rn7, '复制'))
  // B4-10 copy honesty: no working clipboard → button must NOT falsely claim 已复制✓ (Codex R1 Medium)
  const cpBtn = findByText(rn7, '复制')!
  fire(cpBtn)
  ok('B4-10 copy without a working clipboard does NOT falsely claim success (已复制✓)', cpBtn.textContent !== '已复制✓' && /手动选择/.test(cpBtn.textContent))

  // ── B5 0-hit recovery: catalog_sample price is a Model-Projection OBJECT {display, amount_minor};
  //    the recovery card must render the human display, NEVER "[object Object] USDC". ──
  const rn8 = mk('div'); rn8.setAttribute('id', 'root'); const doc8 = { getElementById: (id: string) => (id === 'root' ? rn8 : null), createElement: (t: string) => mk(t) }
  const ctx8: Record<string, unknown> = { document: doc8, window: { innerWidth: 1200, pageYOffset: 0, scrollTo() {} }, setTimeout, Promise, URL, console, String, Object, Array, Math, JSON }
  ctx8.globalThis = ctx8; ctx8.self = ctx8; vm.createContext(ctx8)
  vm.runInContext(`${__WIDGET_COMPAT_JS}\n${PRODUCT_RESULTS_BODY_JS}\nthis.__render=renderBody`, ctx8)
  ;(ctx8.__render as (o: unknown, out: unknown) => void)({}, { products: [], recovery: { catalog_sample: [
    { id: 'prd_x', title: 'XXX', price: { amount_minor: 7_060_000, currency: 'USDC', display: '7.06 USDC' }, price_display: '7.06 USDC' },
    { id: 'prd_y', title: 'YYY', price: { amount_minor: 4_440_000, currency: 'USDC', display: '4.44 USDC' } },
  ] } })
  ok('B5-1 0-hit recovery renders human price display, NEVER "[object Object]"', !treeTextG(rn8).includes('[object Object]'))
  ok('B5-2 recovery card uses server price_display when present (7.06 USDC)', !!findByText(rn8, '7.06 USDC', 'DIV'))
  ok('B5-3 recovery card falls back to price.display when price_display absent (4.44 USDC)', !!findByText(rn8, '4.44 USDC', 'DIV'))

  // ── mobile: opening a second card closes the first (one-at-a-time) ──
  win.innerWidth = 500
  renderBody(oai, SEARCH)
  fire(findByText(cardFor(rootNode, 'prd_a')!, '展开')!)
  ok('B1-14 mobile: first card opens', /\bopen\b/.test(cardFor(rootNode, 'prd_a')!.className))
  fire(findByText(cardFor(rootNode, 'prd_b')!, '展开')!)
  ok('B1-15 mobile one-at-a-time: opening B closes A', /\bopen\b/.test(cardFor(rootNode, 'prd_b')!.className) && !/\bopen\b/.test(cardFor(rootNode, 'prd_a')!.className))
  // ── B3 AI recommendation: server PASSTHROUGH (§15 — server never generates) + widget highlight ──
  const prods = [{ id: 'prd_a' }, { id: 'prd_b' }]
  const recOk = recommendationPassthrough({ recommend_id: 'prd_a', recommend_reason: '品牌更熟悉 容量适中 附挂钩' }, prods) as Record<string, unknown> | undefined
  ok('B3-1 server echoes a model recommendation for an id IN the result set, labeled non-authoritative/assistant', !!recOk && recOk.product_id === 'prd_a' && recOk.reason === '品牌更熟悉 容量适中 附挂钩' && recOk.source === 'assistant' && recOk.non_authoritative === true)
  ok('B3-2 server does NOT highlight an id NOT in the result set (never fabricates a pick)', recommendationPassthrough({ recommend_id: 'prd_ZZZ', recommend_reason: 'x' }, prods) === undefined)
  ok('B3-3 no recommend_id → undefined (server never invents a recommendation)', recommendationPassthrough({}, prods) === undefined)
  const recUrl = recommendationPassthrough({ recommend_id: 'prd_a', recommend_reason: 'buy at http://evil.example' }, prods) as Record<string, unknown>
  ok('B3-4 reason sanitized: URL/@ rejected → reason null, still a valid pick', recUrl.product_id === 'prd_a' && recUrl.reason === null)
  const recUpper = recommendationPassthrough({ recommend_id: 'prd_a', recommend_reason: 'see HTTPS://X and WWW.Y' }, prods) as Record<string, unknown>
  ok('B3-4b URL rejection is case-insensitive (HTTPS/WWW also rejected) — Codex R2', recUpper.reason === null)
  const recLong = recommendationPassthrough({ recommend_id: 'prd_a', recommend_reason: 'x'.repeat(300) }, prods) as Record<string, unknown>
  ok('B3-5 reason capped at 140 chars', typeof recLong.reason === 'string' && (recLong.reason as string).length === 140)
  const recWs = recommendationPassthrough({ recommend_id: 'prd_a', recommend_reason: 'cheap\tbut\nfragile' }, prods) as Record<string, unknown>
  ok('B3-5b whitespace/control-whitespace collapsed to single spaces (not nulled) — Codex R1', recWs.reason === 'cheap but fragile')

  // widget: recommended card gets highlight border + 🌟 AI 推荐 badge + reason; a non-matching id highlights nothing
  const rn3 = mk('div'); rn3.setAttribute('id', 'root')
  const doc3 = { getElementById: (id: string) => (id === 'root' ? rn3 : null), createElement: (t: string) => mk(t) }
  const ctx3: Record<string, unknown> = { document: doc3, window: { innerWidth: 1200, pageYOffset: 0, scrollTo() {} }, setTimeout, Promise, URL, console, String, Object, Array, Math, JSON }
  ctx3.globalThis = ctx3; ctx3.self = ctx3; vm.createContext(ctx3)
  vm.runInContext(`${__WIDGET_COMPAT_JS}\n${PRODUCT_RESULTS_BODY_JS}\nthis.__render=renderBody`, ctx3)
  ;(ctx3.__render as (o: unknown, out: unknown) => void)({}, { ...SEARCH, recommendation: { product_id: 'prd_a', reason: '容量适中并附挂钩', source: 'assistant', non_authoritative: true } })
  const recCard = cardFor(rn3, 'prd_a')!, plainCard = cardFor(rn3, 'prd_b')!
  ok('B3-6 widget highlights the recommended card (rec border class)', /\brec\b/.test(recCard.className) && !/\brec\b/.test(plainCard.className))
  const treeText = (n: N): string => (n.textContent && n.children.length === 0 ? n.textContent : '') + (n.children || []).map(treeText).join(' ')
  ok('B3-7 recommended card shows the 🌟 AI 推荐 badge (not "WebAZ 推荐")', !!findByText(recCard, '🌟 AI 推荐', 'DIV') && !treeText(rn3).includes('WebAZ 推荐'))
  ok('B3-8 recommended card shows the reason', !!findByText(recCard, '“容量适中并附挂钩”', 'DIV'))
} catch (e) { fail++; fails.push('✗ THREW: ' + ((e as Error).stack || (e as Error).message)) }
try { rmSync(__tmpHome, { recursive: true, force: true }) } catch { /* temp HOME cleanup */ }

if (fail > 0) { console.error(`\n❌ product-widget-expand FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ product-widget-expand+prepare+failvisible: B1 expand/collapse PERSISTED (survives sort) + 展开/收起 toggle + clickable info + scroll + detail 返回列表 + mobile one-at-a-time; B2 准备下单 primary → structured follow-up carrying product_id (model orchestrates quote→draft→submit→Passkey), NEVER callTool the model-only quote, NEVER money-path tools; B4 FAIL-VISIBLE: 详情(callTool webaz_search on-demand) + 准备下单 always surface a copyable manual phrase carrying the exact product_id (never a silent no-op / permanent loading on hosts whose widget→host bridge no-ops, e.g. ChatGPT) + 复制 action; compare (≥2) → table per-row 准备下单 (compare→pick→buy) follows-up that product_id; B3 AI 推荐 server PASSTHROUGH (echoes model pick in the result set, sanitizes reason, never generates) + widget highlight (rec border + 🌟 AI 推荐 badge + reason, never "WebAZ 推荐")\n  ✅ pass ${pass}`)
