#!/usr/bin/env tsx
/**
 * 2026-07 订单流遍历审计:时间线/徽章渲染回归锁(真实前端代码,node 内求值,非复刻)。
 *   根因事故:fault_seller→completed 一秒穿越后,UI 把违约关单画成「买家确认 ✓」的成功交易
 *   (生产 ord_87c21c0b04ae 实锤)。本测试锁:
 *   ① 处置型 completed(completed 事件 from_status≠confirmed)→ 物流时间线返回空、stepper 走异常 banner;
 *   ② 正常 confirmed→completed 仍画满格成功;
 *   ③ direct_p2p 轨节点映射:卖家接单←direct_pay_window 事件,已付款←accepted 事件(人/时间不再错位);
 *   ④ orderStatusBadges:completed+settled_fault_at → 中性「已关单」,正常 completed → 「已完成」。
 * Usage: npm run test:order-timeline-render
 */
import { readFileSync } from 'fs'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// ── 浏览器全局桩(t=恒等,时间戳原样输出便于断言)──
const g = globalThis as Record<string, unknown>
g.window = { _lang: 'zh', dpTerminalLabel: undefined, dpNegotiationLabel: undefined, dpAcceptLabel: undefined }
g.t = (s: string): string => s
g.escHtml = (s: unknown): string => String(s ?? '')
g.fmtTime = (iso: string): string => String(iso ?? '')
g.fmtCountdown = (): string => 'countdown'
g.trackingEvidenceLine = (label: string): string => `<div>EV:${label}</div>`

// 真实源码求值:时间线域整文件 + app.js 里的 badge 两函数(抽取,不复刻)
// eslint-disable-next-line no-eval
;(0, eval)(readFileSync('src/pwa/public/app-order-timeline.js', 'utf8'))
const appjs = readFileSync('src/pwa/public/app.js', 'utf8')
const grab = (name: string): string => {
  const m = appjs.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))
  if (!m) throw new Error(`app.js 里找不到 function ${name}`)
  return m[0]
}
// eslint-disable-next-line no-eval
;(0, eval)(grab('statusBadge') + '\n' + grab('orderStatusBadges') + '\n;globalThis.__badge = orderStatusBadges;')
const orderStatusBadges = (globalThis as Record<string, unknown>).__badge as (o: Record<string, unknown>) => string
const timeline = (g as Record<string, unknown>).orderTrackingTimeline as unknown as (o: Record<string, unknown>, h: Array<Record<string, unknown>>, ti: Array<Record<string, unknown>>, s?: Record<string, string>) => string
const stepper = (g as Record<string, unknown>).orderStageTimeline as unknown as (o: Record<string, unknown>, h: Array<Record<string, unknown>>) => string
ok('0. 两个渲染函数已成为全局(classic script 契约)', typeof timeline === 'function' && typeof stepper === 'function')

const H = (rows: Array<[string | null, string, string, string]>): Array<Record<string, unknown>> =>
  rows.map(([from, to, at, actor]) => ({ from_status: from, to_status: to, created_at: at, actor_name: actor, actor_role: 'x', notes: null, evidence_items: [] }))

// ═══ ① 处置型 completed(生产事故形态):fault_seller→completed ═══
{
  const order = { status: 'completed', payment_rail: 'direct_p2p', settled_fault_at: '2026-07-20 15:28:03', ship_deadline: '2026-07-20 15:26:48' }
  const hist = H([
    [null, 'created', '2026-07-17 15:24:46', '系统'], ['created', 'pending_accept', '2026-07-17 15:24:46', '系统'],
    ['pending_accept', 'direct_pay_window', '2026-07-17 15:24:55', '卖家乙'], ['direct_pay_window', 'accepted', '2026-07-17 15:26:48', '买家甲'],
    ['accepted', 'fault_seller', '2026-07-20 15:28:03', '系统'], ['fault_seller', 'completed', '2026-07-20 15:28:03', '系统'],
  ])
  ok('1a. 物流时间线返回空(不画假「买家确认 ✓」)', timeline(order, hist, []) === '', timeline(order, hist, []).slice(0, 200))
  const s = stepper(order, hist)
  ok('1b. stepper 走异常 banner:卖家违约 + 已关单', s.includes('卖家违约') && s.includes('已关单') && s.includes('系统已按协议处置并关闭订单'), s.slice(0, 300))
  ok('1c. stepper 不画满格成功(无「完成」stage 打勾结构)', !s.includes('物流追踪') && !/完成<\/div>/.test(s.split('已关单')[0] ?? ''))
}

// ═══ ② 正常成交 confirmed→completed:仍满格 ═══
{
  const order = { status: 'completed', payment_rail: 'escrow', settled_fault_at: null }
  const hist = H([
    [null, 'created', 't1', 'b'], ['created', 'paid', 't2', 'b'], ['paid', 'accepted', 't3', 's'], ['accepted', 'shipped', 't4', 's'],
    ['shipped', 'picked_up', 't5', 's'], ['picked_up', 'in_transit', 't6', 's'], ['in_transit', 'delivered', 't7', 's'],
    ['delivered', 'confirmed', 't8', '买家甲'], ['confirmed', 'completed', 't9', '系统'],
  ])
  const tl = timeline(order, hist, [])
  ok('2a. 正常完成:时间线渲染且买家确认打勾', tl.includes('物流追踪') && tl.includes('买家确认'), tl.slice(0, 120))
  ok('2b. stepper 不走异常 banner', !stepper(order, hist).includes('已关单'))
}

// ═══ ③ direct_p2p 节点映射:接单←direct_pay_window,已付款←accepted ═══
{
  const order = { status: 'accepted', payment_rail: 'direct_p2p', pending_accept_deadline: null, direct_pay_window_deadline: null, ship_deadline: '2999-01-01T00:00:00Z' }
  const hist = H([
    [null, 'created', 'T_CREATE', '系统'], ['created', 'pending_accept', 'T_CREATE', '系统'],
    ['pending_accept', 'direct_pay_window', 'T_ACCEPT_BY_SELLER', '卖家乙'], ['direct_pay_window', 'accepted', 'T_PAID_BY_BUYER', '买家甲'],
  ])
  const tl = timeline(order, hist, [])
  const sellerNode = tl.split('卖家接单')[1]?.split('已付款')[0] ?? ''
  const paidNode = tl.split('已付款')[1]?.split('卖家发货')[0] ?? ''
  ok('3a. 「卖家接单」挂 direct_pay_window 事件(卖家/接单时间)', sellerNode.includes('T_ACCEPT_BY_SELLER') && sellerNode.includes('卖家乙'), sellerNode.slice(0, 200))
  ok('3b. 「已付款」挂 accepted 事件(买家/付款时间),不再错标成接单', paidNode.includes('T_PAID_BY_BUYER') && paidNode.includes('买家甲'), paidNode.slice(0, 200))
  ok('3c. 时间线节点顺序 = 接单在付款前(direct 真实事件序)', tl.indexOf('卖家接单') < tl.indexOf('已付款'))
}

// ═══ ④ 徽章:completed+settled_fault_at → 已关单;正常 completed → 已完成 ═══
{
  const closed = orderStatusBadges({ status: 'completed', settled_fault_at: '2026-07-20', payment_rail: 'direct_p2p' })
  const done = orderStatusBadges({ status: 'completed', settled_fault_at: null, payment_rail: 'escrow' })
  ok('4a. 处置关单徽章 = 中性「已关单」(非绿色已完成)', closed.includes('已关单') && closed.includes('badge-gray') && !closed.includes('已完成'), closed)
  ok('4b. 正常完成徽章不受影响', done.includes('已完成') && done.includes('badge-green'), done)
}

// ═══ ④b 处置来源专用标签:disputed→completed=仲裁结案;return_pending→completed=退货已结算 ═══
{
  const ordArb = { status: 'completed', payment_rail: 'escrow', settled_fault_at: null }
  const histArb = H([[null, 'created', 't1', 'b'], ['paid', 'disputed', 't2', 'b'], ['disputed', 'completed', 't3', '系统']])
  const sArb = stepper(ordArb, histArb)
  ok('4c. disputed→completed banner = 仲裁结案(非"订单进入争议")', sArb.includes('仲裁结案') && !sArb.includes('订单进入争议'), sArb.slice(0, 250))
  const ordRet = { status: 'completed', payment_rail: 'escrow', settled_fault_at: '2026-07-01' }
  const histRet = H([[null, 'created', 't1', 'b'], ['delivery_failed', 'return_pending', 't2', '系统'], ['return_pending', 'completed', 't3', '系统']])
  const sRet = stepper(ordRet, histRet)
  ok('4d. return_pending→completed banner = 退货流程已结算(非"等待退货确认")', sRet.includes('退货流程已结算') && !sRet.includes('等待退货确认'), sRet.slice(0, 250))
}

// ═══ ⑤ 其余异常状态时间线抑制(delivery_failed / return_pending / declined_nofault)═══
{
  for (const st of ['delivery_failed', 'return_pending', 'declined_nofault', 'resolved_for_seller']) {
    ok(`5. ${st} 不画物流时间线`, timeline({ status: st, payment_rail: 'escrow' }, [], []) === '')
  }
}

if (fail > 0) { console.error(`\n❌ order-timeline-render FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ order timeline render:处置型 completed 绝不画成功 + 正常完成不受影响 + direct 轨节点映射修正 + 已关单徽章\n  ✅ pass ${pass}`)
