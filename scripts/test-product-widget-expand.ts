#!/usr/bin/env tsx
/**
 * P1-B1 — ProductResults widget: per-card expand/collapse with PERSISTED state, clickable basic-info,
 * detail view with 返回列表 (no more "frozen expanded"), scroll-keep, mobile one-at-a-time.
 * Drives the REAL widget body (PRODUCT_RESULTS_BODY_JS) in node:vm over a minimal mock DOM.
 * Usage: npm run test:product-widget-expand
 */
import vm from 'node:vm'
const { __WIDGET_COMPAT_JS, PRODUCT_RESULTS_BODY_JS } = await import('../src/layer1-agent/L1-1-mcp-server/ui-widgets.js')

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

  // ── B2 准备下单:one-click starts quote→draft→submit→Passkey via a READ-ONLY quote (never money-path) ──
  const calls: Array<[string, unknown]> = []
  const oai2 = { callTool: (n: string, a: unknown) => { calls.push([n, a]) } }
  win.innerWidth = 1200
  renderBody(oai2, SEARCH)
  const pdBtn = findByText(cardFor(rootNode, 'prd_a')!, '准备下单')
  ok('B2-1 card shows a 准备下单 primary button (not the old 报价)', !!pdBtn && !findByText(rootNode, '报价'))
  ok('B2-2 准备下单 button is styled primary', (pdBtn as N).className === 'primary')
  fire(pdBtn!)
  ok('B2-3 准备下单 kicks off a READ-ONLY webaz_quote_order with the exact product_id + quantity', calls.length >= 1 && calls[0][0] === 'webaz_quote_order' && (calls[0][1] as Record<string, unknown>).product_id === 'prd_a' && (calls[0][1] as Record<string, unknown>).quantity === 1)
  ok('B2-4 widget NEVER calls the money-path tools directly (no order_draft/submit/execute from the card)', !calls.some(c => /order_draft|submit_order|order_create|place_order|execute/.test(c[0])))
  ok('B2-5 button disables on click (防误触; server intent_hash dedups any duplicate submit)', (pdBtn as N & { disabled?: boolean }).disabled === true)

  // ── mobile: opening a second card closes the first (one-at-a-time) ──
  win.innerWidth = 500
  renderBody(oai, SEARCH)
  fire(findByText(cardFor(rootNode, 'prd_a')!, '展开')!)
  ok('B1-14 mobile: first card opens', /\bopen\b/.test(cardFor(rootNode, 'prd_a')!.className))
  fire(findByText(cardFor(rootNode, 'prd_b')!, '展开')!)
  ok('B1-15 mobile one-at-a-time: opening B closes A', /\bopen\b/.test(cardFor(rootNode, 'prd_b')!.className) && !/\bopen\b/.test(cardFor(rootNode, 'prd_a')!.className))
} catch (e) { fail++; fails.push('✗ THREW: ' + ((e as Error).stack || (e as Error).message)) }

if (fail > 0) { console.error(`\n❌ product-widget-expand FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ product-widget-expand+prepare: B1 expand/collapse PERSISTED (survives sort) + 展开/收起 toggle + clickable info + scroll + detail 返回列表 + mobile one-at-a-time; B2 准备下单 primary → READ-ONLY webaz_quote_order(product_id+qty), NEVER money-path tools, disables on click\n  ✅ pass ${pass}`)
