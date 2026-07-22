#!/usr/bin/env tsx
/**
 * RFC-029 Design A · PR-4 — confirm-page payment selector (app-agent-approvals-pay.js), behavioral.
 * vm-runs the real widget JS and drives it with mocked apiRead/apiWriteIdempotent/aaApprove/DOM —
 * proving: aaLoadPay renders one radio per option with the recommended one pre-checked + honest notes;
 * aaChoosePayAndApprove POSTs the chosen option_id, updates the card's bound params_hash, then runs the
 * normal Passkey approve (aaApprove) — choose→rehash→approve, no stubbing of the subject.
 * Usage: npm run test:choose-payment-ui
 */
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const JS = readFileSync(new URL('../src/pwa/public/app-agent-approvals-pay.js', import.meta.url), 'utf8')
let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

interface El { id?: string; innerHTML: string; dataset: Record<string, string>; _attrs: Record<string, string>; getAttribute: (k: string) => string | null }
const mkEl = (id?: string): El => ({ id, innerHTML: '', dataset: {}, _attrs: id ? { 'data-aa-pay-req': id } : {}, getAttribute(k) { return this._attrs[k] ?? null } })

// Fresh vm context with the real pay.js loaded + mocked collaborators; returns handles to drive/inspect it.
function loadCtx() {
  const slot = mkEl('r1'); const card = mkEl(); card.dataset.aaHash = 'OLD_HASH'
  const posted: Array<{ path: string; body: unknown }> = []; let approvedId: string | null = null
  const state = { readResp: { ok: true, data: {} as unknown }, writeResp: {} as unknown, selected: null as string | null }
  const win: Record<string, unknown> = {}
  const ctx: Record<string, unknown> = {
    window: win, t: (s: string) => s, escHtml: (s: string) => String(s), toast$: () => {}, encodeURIComponent, console,
    apiRead: async () => state.readResp,
    apiWriteIdempotent: async (_m: string, path: string, body: unknown) => { posted.push({ path, body }); return state.writeResp },
    document: {
      getElementById: (id: string) => (id === 'aa-pay-r1' ? slot : null),
      querySelector: (sel: string) => { if (sel.indexOf('input[name="aapay-') === 0) return state.selected == null ? null : { value: state.selected }; if (sel.indexOf('[data-aa-id=') === 0) return card; return null },
      querySelectorAll: () => [slot],
    },
  }
  ctx.globalThis = ctx
  win.aaApprove = async (id: string) => { approvedId = id }
  vm.createContext(ctx); vm.runInContext(JS, ctx)
  return { win, slot, card, posted, get approvedId() { return approvedId }, state }
}
const call = (c: ReturnType<typeof loadCtx>, fn: string, id: string): Promise<void> => (c.win[fn] as (i: string) => Promise<void>)(id)

// ── aaLoadPay renders options (recommended pre-checked, honest notes, confirm button) ──
{
  const c = loadCtx()
  c.state.readResp = { ok: true, data: { rail_chosen: false, options: [
    { option_id: 'escrow', rail: 'escrow', settlement_note: '模拟托管测试轨', recommended: false },
    { option_id: 'direct:acc1', rail: 'direct_p2p', method: 'PayNow', recipient_label: 'Bank-A', settlement_note: '直付非托管', recommended: true },
  ] } }
  await call(c, 'aaLoadPay', 'r1')
  ok('aaLoadPay renders one radio per option', (c.slot.innerHTML.match(/type="radio"/g) || []).length === 2)
  ok('aaLoadPay pre-checks the recommended option (direct:acc1), not escrow', /value="direct:acc1"[^>]*checked/.test(c.slot.innerHTML) && !/value="escrow"[^>]*checked/.test(c.slot.innerHTML))
  ok('aaLoadPay shows honest settlement notes + confirm button', c.slot.innerHTML.includes('模拟托管测试轨') && c.slot.innerHTML.includes('直付非托管') && c.slot.innerHTML.includes('aaChoosePayAndApprove'))
}
// ── rail_chosen race → clears selector (falls back to normal approve) ──
{
  const c = loadCtx(); c.state.readResp = { ok: true, data: { rail_chosen: true, options: [] } }
  await call(c, 'aaLoadPay', 'r1')
  ok('aaLoadPay rail_chosen → clears the selector (normal approve flow)', c.slot.innerHTML === '')
}
// ── choose w/o selection → no POST, no approve ──
{
  const c = loadCtx(); c.state.selected = null
  await call(c, 'aaChoosePayAndApprove', 'r1')
  ok('choose w/o selection → no choose-payment POST, no approve', c.posted.length === 0 && c.approvedId === null)
}
// ── happy: choose → POST + rehash card + approve ──
{
  const c = loadCtx(); c.state.selected = 'direct:acc1'; c.state.writeResp = { ok: true, data: { success: true, params_hash: 'NEW_HASH' } }
  await call(c, 'aaChoosePayAndApprove', 'r1')
  ok('choose → POSTs choose-payment with the selected option_id', c.posted.length === 1 && c.posted[0].path.includes('/choose-payment') && (c.posted[0].body as { option_id: string }).option_id === 'direct:acc1')
  ok('choose → updates the card bound params_hash to the new hash (old Passkey token invalidated)', c.card.dataset.aaHash === 'NEW_HASH')
  ok('choose → then runs the normal Passkey approve (aaApprove) for this request', c.approvedId === 'r1')
}
// ── choose failure → never approves an unset rail ──
{
  const c = loadCtx(); c.state.selected = 'direct:acc1'; c.state.writeResp = { ok: false, data: { error: 'PAYMENT_OPTION_UNAVAILABLE' } }
  await call(c, 'aaChoosePayAndApprove', 'r1')
  ok('choose failure → NO approve, card hash unchanged (never approves an unset rail)', c.approvedId === null && c.card.dataset.aaHash === 'OLD_HASH')
}

if (fail > 0) { console.error(`\n❌ choose-payment-ui FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ choose-payment-ui: selector renders options (recommended pre-checked) + choose→rehash→approve wiring; failure never approves an unset rail\n  ✅ pass ${pass}`)
