#!/usr/bin/env tsx
/**
 * §IV/§V/§VII — DIRECT_TOOL buttons (查看最新状态 / 联系商家 read+send) drive the REAL widget bodies
 * (QUOTE_APPROVAL_BODY_JS + ORDER_TIMELINE_BODY_JS) in node:vm over a minimal mock DOM. Proves: no model
 * follow-up when callTool is available, one structured call, single-flight on send, stable idempotency key,
 * no sensitive-field auto-insert, and an observable fallback_reason when the host has no callTool.
 * Usage: npx tsx scripts/test-mcp-direct-tool-buttons.ts
 */
import vm from 'node:vm'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'directbtn-')); process.env.HOME = home; process.env.USERPROFILE = home
const { __WIDGET_COMPAT_JS, QUOTE_APPROVAL_BODY_JS, ORDER_TIMELINE_BODY_JS } = await import('../src/layer1-agent/L1-1-mcp-server/ui-widgets.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

interface N { tagName: string; className: string; textContent: string; value: string; disabled: boolean; style: Record<string, string>; children: N[]; _h: Record<string, Array<(e: unknown) => void>>; classList: { toggle(c: string): void }; appendChild(c: N): N; setAttribute(k: string, v: string): void; addEventListener(ev: string, fn: (e: unknown) => void): void; scrollIntoView(): void; querySelector(): N | null }
function mk(tag: string): N {
  const n = { tagName: tag, _cls: '', _text: '', value: '', disabled: false, style: {} as Record<string, string>, children: [] as N[], _h: {} as Record<string, Array<(e: unknown) => void>>,
    get className() { return this._cls }, set className(v: string) { this._cls = v },
    get textContent() { return this._text }, set textContent(v: string) { this._text = v; if (v === '') this.children = [] },
    classList: { _s: new Set<string>(), toggle(c: string) { this._s.has(c) ? this._s.delete(c) : this._s.add(c) } },
    appendChild(c: N) { this.children.push(c); return c },
    setAttribute() {}, scrollIntoView() {}, querySelector() { return null },
    addEventListener(ev: string, fn: (e: unknown) => void) { (this._h[ev] = this._h[ev] || []).push(fn) } }
  return n as unknown as N
}
const fire = (n: N, ev = 'click'): void => (n._h[ev] || []).forEach(fn => fn({}))
function findByText(root: N, text: string): N | null {
  const walk = (n: N): N | null => { if ((n.tagName || '').toUpperCase() === 'BUTTON' && n.textContent === text) return n; for (const c of n.children || []) { const r = walk(c); if (r) return r } return null }
  return walk(root)
}
function findTag(root: N, tag: string): N | null {
  const walk = (n: N): N | null => { if ((n.tagName || '').toUpperCase() === tag.toUpperCase()) return n; for (const c of n.children || []) { const r = walk(c); if (r) return r } return null }
  return walk(root)
}

async function driveQuote(): Promise<void> {
  // approval form; callTool returns a resolved promise → status consumed in-place, no follow-up.
  const root = mk('div'); const warns: string[] = []
  const doc = { getElementById: (id: string) => (id === 'root' ? root : null), createElement: (t: string) => mk(t) }
  const ctx: Record<string, unknown> = { document: doc, window: { innerWidth: 1200 }, navigator: { clipboard: { writeText: () => Promise.resolve() } }, setTimeout, Promise, URL, console: { warn: (m: string) => warns.push(String(m)), log() {}, error() {} }, String, Object, Array, Math, JSON, Number }
  ctx.globalThis = ctx; ctx.self = ctx; vm.createContext(ctx)
  vm.runInContext(`${__WIDGET_COMPAT_JS}\n${QUOTE_APPROVAL_BODY_JS}\nthis.__render=renderBody`, ctx)
  const render = ctx.__render as (oai: unknown, out: unknown) => void
  const calls: Array<[string, Record<string, unknown>]> = []; const followups: string[] = []
  const oai = { callTool: (n: string, a: Record<string, unknown>) => { calls.push([n, a]); return Promise.resolve({ structuredContent: { status: 'executed', executed_order_id: 'ord_1' } }) }, sendFollowUpMessage: (o: { prompt?: string }) => { followups.push((o && o.prompt) || '') } }
  render(oai, { schema_version: 'webaz.order_approval.model.v1', request_id: 'apr_1', approval_url: '/#a/apr_1' })
  const refBtn = findByText(root, '🔄 查看最新状态')!
  fire(refBtn)
  await new Promise(r => setTimeout(r, 0))
  ok('Q1. 查看最新状态 DIRECT_TOOL: exactly one callTool webaz_approval_requests(action=get, request_id)', calls.length === 1 && calls[0][0] === 'webaz_approval_requests' && calls[0][1].action === 'get' && calls[0][1].request_id === 'apr_1')
  ok('Q2. no natural-language follow-up when callTool available', followups.length === 0)
  ok('Q3. executed → in-place 查看订单 DIRECT_TOOL button appears', !!findByText(root, '查看订单 ord_1…'.replace('ord_1…', 'ord_1…')) || !!findByText(root, '查看订单 ' + 'ord_1'.slice(0, 10) + '…'))

  // fallback: no callTool → observable fallback_reason + NL fallback
  const root2 = mk('div'); const warns2: string[] = []
  const ctx2: Record<string, unknown> = { document: { getElementById: (id: string) => (id === 'root' ? root2 : null), createElement: (t: string) => mk(t) }, window: { innerWidth: 1200 }, navigator: { clipboard: { writeText: () => Promise.resolve() } }, setTimeout, Promise, URL, console: { warn: (m: string) => warns2.push(String(m)), log() {}, error() {} }, String, Object, Array, Math, JSON, Number }
  ctx2.globalThis = ctx2; ctx2.self = ctx2; vm.createContext(ctx2)
  vm.runInContext(`${__WIDGET_COMPAT_JS}\n${QUOTE_APPROVAL_BODY_JS}\nthis.__render=renderBody`, ctx2)
  const render2 = ctx2.__render as (oai: unknown, out: unknown) => void
  const followups2: string[] = []
  render2({ sendFollowUpMessage: (o: { prompt?: string }) => { followups2.push((o && o.prompt) || '') } }, { schema_version: 'webaz.order_approval.model.v1', request_id: 'apr_2', approval_url: '/#a/apr_2' })
  fire(findByText(root2, '🔄 查看最新状态')!)
  ok('Q4. fallback (no callTool): observable fallback_reason=HOST_COMPONENT_TOOL_CALL_UNAVAILABLE', warns2.some(w => w.includes('view_status fallback_reason=HOST_COMPONENT_TOOL_CALL_UNAVAILABLE')))
  ok('Q5. fallback only when callTool unavailable → NL follow-up used', followups2.length === 1)
}

async function driveTimeline(): Promise<void> {
  const root = mk('div'); const warns: string[] = []
  const ctx: Record<string, unknown> = { document: { getElementById: (id: string) => (id === 'root' ? root : null), createElement: (t: string) => mk(t) }, window: { innerWidth: 1200 }, navigator: { clipboard: { writeText: () => Promise.resolve() } }, setTimeout, Promise, URL, console: { warn: (m: string) => warns.push(String(m)), log() {}, error() {} }, String, Object, Array, Math, JSON, Number }
  ctx.globalThis = ctx; ctx.self = ctx; vm.createContext(ctx)
  vm.runInContext(`${__WIDGET_COMPAT_JS}\n${ORDER_TIMELINE_BODY_JS}\nthis.__render=renderBody`, ctx)
  const render = ctx.__render as (oai: unknown, out: unknown) => void
  const calls: Array<[string, Record<string, unknown>]> = []; const followups: string[] = []
  const oai = { callTool: (n: string, a: Record<string, unknown>) => { calls.push([n, a]); return Promise.resolve({ structuredContent: { messages: [] } }) }, sendFollowUpMessage: (o: { prompt?: string }) => { followups.push((o && o.prompt) || '') } }
  render(oai, { schema_version: 'webaz.order_timeline.model.v1', order_id: 'ord_9', product: { title: 'T' }, status: { label: 'S' }, timeline: [] })
  fire(findByText(root, '联系商家')!)
  ok('C1. 联系商家 DIRECT_TOOL read: one callTool webaz_order_chat(action=list, order_id)', calls.length === 1 && calls[0][0] === 'webaz_order_chat' && calls[0][1].action === 'list' && calls[0][1].order_id === 'ord_9')
  ok('C2. chat read produces NO natural-language follow-up', followups.length === 0)
  // send: type into textarea, click send → one structured send with idempotency_key; double-click → still one
  const inp = findTag(root, 'TEXTAREA')!
  inp.value = '你好，请尽快发货'
  const sendBtn = findByText(root, '发送给订单对方')!
  fire(sendBtn); fire(sendBtn)   // rapid double-click
  await new Promise(r => setTimeout(r, 0))
  const sends = calls.filter(c => c[0] === 'webaz_order_chat' && c[1].action === 'send')
  ok('C3. send DIRECT_TOOL: exactly ONE webaz_order_chat(action=send) despite double-click (single-flight)', sends.length === 1)
  ok('C4. send carries the typed body + an idempotency_key + order_id', sends[0][1].body === '你好，请尽快发货' && typeof sends[0][1].idempotency_key === 'string' && (sends[0][1].idempotency_key as string).length > 0 && sends[0][1].order_id === 'ord_9')
  ok('C5. send body = exactly the user input (no auto-inserted address/token/passkey/payment)', !/api_key|token|passkey|address|地址|凭据|验证码/i.test(String(sends[0][1].body)))
  ok('C6. send produces NO natural-language follow-up', followups.length === 0)

  // fallback: no callTool → observable fallback_reason, no body sent to model
  const root2 = mk('div'); const warns2: string[] = []
  const ctx2: Record<string, unknown> = { document: { getElementById: (id: string) => (id === 'root' ? root2 : null), createElement: (t: string) => mk(t) }, window: { innerWidth: 1200 }, navigator: { clipboard: { writeText: () => Promise.resolve() } }, setTimeout, Promise, URL, console: { warn: (m: string) => warns2.push(String(m)), log() {}, error() {} }, String, Object, Array, Math, JSON, Number }
  ctx2.globalThis = ctx2; ctx2.self = ctx2; vm.createContext(ctx2)
  vm.runInContext(`${__WIDGET_COMPAT_JS}\n${ORDER_TIMELINE_BODY_JS}\nthis.__render=renderBody`, ctx2)
  const render2 = ctx2.__render as (oai: unknown, out: unknown) => void
  const followups2: string[] = []
  render2({ sendFollowUpMessage: (o: { prompt?: string }) => { followups2.push((o && o.prompt) || '') } }, { schema_version: 'webaz.order_timeline.model.v1', order_id: 'ord_x', product: { title: 'T' }, status: { label: 'S' }, timeline: [] })
  fire(findByText(root2, '联系商家')!)
  ok('C7. chat read fallback (no callTool): observable fallback_reason, and NO message body sent to model', warns2.some(w => w.includes('chat_list fallback_reason=HOST_COMPONENT_TOOL_CALL_UNAVAILABLE')) && followups2.length === 0)
}

async function main(): Promise<void> {
  await driveQuote()
  await driveTimeline()
  if (fail > 0) { console.error(`\n❌ direct-tool buttons FAILED  ✅ ${pass} ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ direct-tool buttons: 查看最新状态 + 联系商家(read/send)结构化直调,无模型回传,单发,幂等,零敏感字段自插,fallback 可观察\n  ✅ pass ${pass}`)
}
main().catch(e => { console.error(e); process.exit(1) })
