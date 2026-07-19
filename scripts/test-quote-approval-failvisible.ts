#!/usr/bin/env tsx
/**
 * PR-B7 — QuoteAndApproval widget: 全链按钮 fail-visible + 审批卡「🔄 查看最新状态」。
 *   驱动真实 QUOTE_APPROVAL_BODY_JS 于 node:vm/mock DOM。核心:批准在 webaz.xyz 完成(卡外),本卡是快照;
 *   点按钮永不静默死 —— 宿主回调不生效时追加可复制手动指令(减少用户打字)。
 * Usage: npm run test:quote-approval-failvisible
 */
import vm from 'node:vm'
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
const __tmpHome = mkdtempSync(join(tmpdir(), 'qa-fv-')); process.env.HOME = __tmpHome; process.env.USERPROFILE = __tmpHome
const { __WIDGET_COMPAT_JS, QUOTE_APPROVAL_BODY_JS } = await import('../src/layer1-agent/L1-1-mcp-server/ui-widgets.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

interface N { tagName: string; _cls: string; _text: string; style: Record<string, string>; children: N[]; _h: Record<string, Array<(e: unknown) => void>>; className: string; textContent: string; classList: { toggle(): void }; appendChild(c: N): N; addEventListener(ev: string, fn: (e: unknown) => void): void }
function mk(tag: string): N {
  const node = {
    tagName: tag, _cls: '', _text: '', style: {} as Record<string, string>, children: [] as N[], _h: {} as Record<string, Array<(e: unknown) => void>>,
    get className() { return this._cls }, set className(v: string) { this._cls = v },
    get textContent() { return this._text }, set textContent(v: string) { this._text = v; if (v === '') this.children = [] },
    classList: { toggle() {} },
    appendChild(c: N) { this.children.push(c); return c },
    addEventListener(ev: string, fn: (e: unknown) => void) { (this._h[ev] = this._h[ev] || []).push(fn) },
  }
  return node as unknown as N
}
const fire = (n: N, ev = 'click') => (n._h[ev] || []).forEach(fn => fn({}))
function findBtn(root: N, textIncludes: string): N | null {
  const walk = (n: N): N | null => { if ((n.tagName || '').toUpperCase() === 'BUTTON' && (n.textContent || '').includes(textIncludes)) return n; for (const c of n.children || []) { const r = walk(c); if (r) return r } return null }
  return walk(root)
}
const treeText = (n: N): string => (n.textContent && n.children.length === 0 ? n.textContent : '') + (n.children || []).map(treeText).join(' ')

function render(out: unknown, oai: Record<string, unknown>): { root: N; threw?: string } {
  const root = mk('div')
  const doc = { getElementById: (id: string) => (id === 'root' ? root : null), createElement: (t: string) => mk(t) }
  const ctx: Record<string, unknown> = { document: doc, window: { innerWidth: 1200 }, setTimeout, Promise, URL, console, String, Object, Array, Math, JSON, navigator: undefined }
  ctx.globalThis = ctx; ctx.self = ctx; vm.createContext(ctx)
  try {
    vm.runInContext(`${__WIDGET_COMPAT_JS}\n${QUOTE_APPROVAL_BODY_JS}\nthis.__render=renderBody`, ctx)
    ;(ctx.__render as (o: unknown, out: unknown) => void)(oai, out)
    return { root }
  } catch (e) { return { root, threw: (e as Error).message } }
}

const APPROVAL = { schema_version: 'webaz.order_approval.model.v1', request_id: 'apr_123', on_approval: 'x', approval_url: '/#agent-approvals/apr_123', status: 'pending', disclosures: [] }
const QUOTE = { schema_version: 'webaz.order_quote.model.v1', product: { title: 'AAA' }, quantity: 1, price: { display: '7.06 USDC', amount_minor: 7_060_000 }, amounts: { item: 7_060_000, shipping: 0, other: 0 }, shipping: {}, payment_rail: 'direct_p2p', quote_token: 'qt_1', expires_at: 'x', disclosures: [] }
const DRAFT = { schema_version: 'webaz.order_draft.model.v1', draft_id: 'odr_1', status: 'draft', product: { title: 'AAA' }, quantity: 1, price: { display: '7.06 USDC' }, payment_rail: 'direct_p2p', expires_at: 'x', disclosures: [] }

try {
  // ── B7-1: approval card renders + has the 「查看最新状态」refresh button + snapshot note ──
  const sent: string[] = []
  const oai = { sendFollowUpMessage: (o: { prompt?: string }) => { sent.push((o && o.prompt) || '') } }
  const rA = render(APPROVAL, oai)
  ok('B7-1 approval card renders without throwing', !rA.threw)
  const refBtn = findBtn(rA.root, '查看最新状态')
  ok('B7-2 approval card has a 🔄 查看最新状态 refresh button', !!refBtn)
  ok('B7-3 card states it is a snapshot that does NOT auto-update', treeText(rA.root).includes('不会自动更新'))
  fire(refBtn!)
  ok('B7-4 refresh → follow-up to re-read status carrying request_id (webaz_approval_requests)', sent.some(s => s.includes('apr_123') && /webaz_approval_requests|最新状态/.test(s)))
  ok('B7-5 refresh also surfaces a copyable manual phrase (fail-visible; never a silent no-op)', treeText(rA.root).includes('查这笔审批/订单的最新状态(request_id=apr_123)'))

  // ── B7-6: no follow-up channel → refresh still fail-visible (copyable phrase) ──
  const rA2 = render(APPROVAL, {})
  fire(findBtn(rA2.root, '查看最新状态')!)
  ok('B7-6 no host channel → refresh shows the manual phrase (not stuck / not silent)', treeText(rA2.root).includes('查这笔审批/订单的最新状态(request_id=apr_123)'))

  // ── B7-7/8: quote + draft buttons are fail-visible (callTool AND copyable fallback) ──
  const calls: Array<[string, unknown]> = []
  const oai2 = { callTool: (n: string, a: unknown) => { calls.push([n, a]) } }
  const rQ = render(QUOTE, oai2)
  ok('B7-7a quote card 创建订单草稿 button present', !!findBtn(rQ.root, '创建订单草稿'))
  fire(findBtn(rQ.root, '创建订单草稿')!)
  const draftCall = calls.find(c => c[0] === 'webaz_order_draft')
  ok('B7-7 create-draft → callTool webaz_order_draft with EXACT args {action:create, quote_token} (deep-equal, no extra keys) + fail-visible hint', !!draftCall && JSON.stringify(draftCall![1]) === JSON.stringify({ action: 'create', quote_token: 'qt_1' }) && treeText(rQ.root).includes('创建订单草稿(quote_token=qt_1)'))
  const rD = render(DRAFT, oai2)
  fire(findBtn(rD.root, '提交')!)
  const submitCall = calls.find(c => c[0] === 'webaz_submit_order_request')
  ok('B7-8 submit → callTool webaz_submit_order_request with EXACT args {draft_id} (deep-equal, no extra keys) + fail-visible hint', !!submitCall && JSON.stringify(submitCall![1]) === JSON.stringify({ draft_id: 'odr_1' }) && treeText(rD.root).includes('draft_id=odr_1'))

  // ── B7-9/10/11: 打开审批页 must be fail-visible even when openExternal THROWS or silently drops (Codex R2 High) ──
  const rThrow = render(APPROVAL, { openExternal: () => { throw new Error('boom') } })
  fire(findBtn(rThrow.root, '打开审批页面')!)
  ok('B7-9 open-approval: openExternal THROWS → no crash + copyable approval URL shown (fail-visible)', !rThrow.threw && treeText(rThrow.root).includes('https://webaz.xyz/#agent-approvals/apr_123'))
  const rDrop = render(APPROVAL, { openExternal: () => undefined })
  fire(findBtn(rDrop.root, '打开审批页面')!)
  ok('B7-10 open-approval: openExternal exists but silently drops → copyable approval URL STILL shown (not a silent no-op)', treeText(rDrop.root).includes('https://webaz.xyz/#agent-approvals/apr_123'))
  ok('B7-11 fail-visible hints carry a 复制 (copy) affordance', !!findBtn(rDrop.root, '复制'))
} catch (e) { fail++; fails.push('✗ THREW: ' + ((e as Error).stack || (e as Error).message)) }
try { rmSync(__tmpHome, { recursive: true, force: true }) } catch { /* temp HOME cleanup */ }

if (fail > 0) { console.error(`\n❌ quote-approval-failvisible FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ quote-approval-failvisible: approval card 🔄 查看最新状态 (out-of-band Passkey → snapshot, refresh re-reads status) + quote/draft/approval buttons all fail-visible (host callback fires AND a copyable manual phrase always appears; never a silent no-op / stuck button) — click-first, minimal typing\n  ✅ pass ${pass}`)
