#!/usr/bin/env tsx
/**
 * Direct Pay 收款信息 / 选轨 UX 回归(前端,纯 UI —— 不碰后端披露门/redaction/钱路)。
 *   用法:npm run test:direct-pay-reveal-ux
 *
 * 用 node:vm + 极简 fake DOM 真正【执行】app-*.js 并断言渲染输出(无 jsdom)。三项修复各一条:
 *   ③新 附言竞态:index.html 里 memo.js 必须在 reveal.js/paymodal.js【之前】(静态锁死)+ 首渲染即含参考号(功能)+ 反证。
 *   ③旧 空快照文案:pending_accept → "卖家尚未接单"(非"尚未设置");direct_pay_window 空快照 → "请先完成风险披露"。
 *   ① 选轨软提醒:has_passkey=true → 不显示;false → 显示(D1/D2 契约门仍后端硬强制,与本软提醒无关)。
 */
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }
const src = (f: string) => readFileSync(`src/pwa/public/${f}`, 'utf8')

interface FakeEl { id: string; style: { display: string }; innerHTML: string; textContent: string; _oid: string | null; getAttribute(a: string): string | null; querySelector(): null }
function mkEl(id: string): FakeEl {
  return { id, style: { display: '' }, innerHTML: '', textContent: '', _oid: null,
    getAttribute(a) { return a === 'data-order-id' ? this._oid : null }, querySelector() { return null } }
}
/* eslint-disable @typescript-eslint/no-explicit-any */
function makeCtx(overrides: Record<string, any> = {}) {
  const elements: Record<string, FakeEl> = {}
  const document = {
    getElementById: (id: string) => elements[id] ?? null,
    querySelector: (sel: string) => (overrides.__querySelector ? overrides.__querySelector(sel) : null),
  }
  const win: any = {}
  const ctx: any = {
    window: win, document, t: (s: string) => s, escHtml: (s: unknown) => String(s ?? ''),
    GET: async () => ({}), state: { user: {} },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    Date, JSON, Number, String, Math, Boolean, isFinite, encodeURIComponent, console,
    confirmModal: async () => true, requestPasskeyGate: async () => 'tok',
    ...overrides,
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  return { ctx, win, elements }
}
const load = (ctx: any, files: string[]) => { for (const f of files) vm.runInContext(src(f), ctx) }

async function main(): Promise<void> {
  // ══ ③新:附言/参考号 加载竞态 ══
  const HTML = src('index.html')
  const iMemo = HTML.indexOf('/app-direct-pay-memo.js'), iRev = HTML.indexOf('/app-direct-pay-reveal.js'), iPay = HTML.indexOf('/app-direct-pay-paymodal.js')
  ok('③新-a index.html: memo.js 在 reveal.js 之前(锁死顺序,memo 被挪到消费方后即报红)', iMemo > 0 && iRev > 0 && iMemo < iRev)
  ok('③新-b index.html: memo.js 在 paymodal.js 之前', iMemo > 0 && iPay > 0 && iMemo < iPay)
  { // 功能:按 index.html 顺序(memo 先)加载 → 首渲染即含参考号,无需刷新
    const h = makeCtx(); h.elements['dp-order-instr'] = mkEl('dp-order-instr'); h.elements['dp-order-instr']._oid = 'ord_ABCD1234'
    load(h.ctx, ['app-direct-pay-memo.js', 'app-direct-pay-reveal.js'])
    h.win.dpShowPaymentInfo({ direct_pay_instruction_snapshot: '银行卡 6222 **** 1234', total_amount: 30, status: 'direct_pay_window', payment_rail: 'direct_p2p' }, 'ord_ABCD1234', true)
    const ref = h.win.dpPayRef('ord_ABCD1234')
    ok('③新-c 订单页首渲染即含附言/参考号(不依赖刷新)', ref.startsWith('WAZ-') && h.elements['dp-order-instr'].innerHTML.includes(ref), `ref=${ref}`) }
  { // 反证:memo 未先加载(模拟旧顺序竞态)→ 首渲染缺参考号 → 证明顺序修复的必要性
    const h = makeCtx(); h.elements['dp-order-instr'] = mkEl('dp-order-instr'); h.elements['dp-order-instr']._oid = 'ord_ABCD1234'
    load(h.ctx, ['app-direct-pay-reveal.js'])   // memo 尚未加载
    h.win.dpShowPaymentInfo({ direct_pay_instruction_snapshot: 'x', total_amount: 30, status: 'direct_pay_window', payment_rail: 'direct_p2p' }, 'ord_ABCD1234', true)
    ok('③新-d 反证:memo 未先加载 → 首渲染缺参考号(顺序修复有效)', !h.elements['dp-order-instr'].innerHTML.includes('WAZ-')) }

  // ══ ③旧:空快照按状态分文案 ══
  { const h = makeCtx(); h.elements['dp-order-instr'] = mkEl('dp-order-instr'); h.elements['dp-order-instr']._oid = 'ord_PA'
    load(h.ctx, ['app-direct-pay-memo.js', 'app-direct-pay-reveal.js'])
    h.win.dpShowPaymentInfo({ status: 'pending_accept', payment_rail: 'direct_p2p', direct_pay_instruction_snapshot: '', total_amount: 30 }, 'ord_PA', false)
    const html = h.elements['dp-order-instr'].innerHTML
    ok('③旧-a pending_accept 空快照 → "卖家尚未接单"(非误标"尚未设置收款说明")', html.includes('尚未接单') && !html.includes('尚未设置收款说明'), html.slice(0, 120)) }
  { const h = makeCtx(); h.elements['dp-order-instr'] = mkEl('dp-order-instr'); h.elements['dp-order-instr']._oid = 'ord_DW'
    load(h.ctx, ['app-direct-pay-memo.js', 'app-direct-pay-reveal.js'])
    h.win.dpShowPaymentInfo({ status: 'direct_pay_window', payment_rail: 'direct_p2p', direct_pay_instruction_snapshot: '', total_amount: 30 }, 'ord_DW', true)
    ok('③旧-b direct_pay_window 空快照 → "请先完成两次风险披露"', h.elements['dp-order-instr'].innerHTML.includes('风险披露')) }

  // ══ ①:选轨软提醒仅对无 Passkey 用户显示 ══
  const railNoteDisplay = async (hasPasskey: boolean): Promise<string> => {
    const h = makeCtx({ GET: async () => ({ available: true }), state: { user: { has_passkey: hasPasskey } },
      __querySelector: (sel: string) => sel.includes(':checked') ? { value: 'direct_p2p' } : null })
    h.elements['dp-rail-note'] = mkEl('dp-rail-note'); h.elements['dp-rail-note'].style.display = 'none'
    h.elements['dp-rail-unavailable'] = mkEl('dp-rail-unavailable'); h.elements['dp-account-picker'] = mkEl('dp-account-picker')
    load(h.ctx, ['app-direct-pay.js'])
    await h.win.dpOnRailChange('prd_x')
    return h.elements['dp-rail-note'].style.display
  }
  ok('①-a has_passkey=true → 软提醒不显示(display=none)', (await railNoteDisplay(true)) === 'none')
  ok('①-b has_passkey=false → 软提醒显示(display="")', (await railNoteDisplay(false)) === '')

  if (fail === 0) console.log(`\n✅ direct-pay reveal/rail UX 回归(纯前端,未碰后端披露门/redaction/钱路):③新附言竞态(顺序锁+首渲染含参考号+反证)· ③旧空快照按状态分文案 · ① 软提醒 !has_passkey 才显示\n  ✅ pass ${pass}`)
  else { console.error(`\n❌ FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exitCode = 1 }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
