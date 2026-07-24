#!/usr/bin/env tsx
/**
 * order detail — seller-side inline return handling (static source contract).
 *   用法:npm run test:order-detail-return-inline
 *
 * 背景:#359 dashboard 异常桶把退货单 link 到 #order/:id,但订单详情原本只给【买家】渲染退货 widget,
 * 卖家打开同一订单看不到退货、无法处理 → 死路。本改动:订单详情对卖家也渲染退货 widget(有申请才显示),
 * 并内联卖家动作(pending→接受/拒绝、picked_up→确认收到→退款),复用既有退款处理 endpoint/handler,
 * 不改退款资金逻辑。处理完回到订单详情(orderId 上下文),退货中心调用不传 orderId,行为不变。
 */
import { readFileSync } from 'node:fs'
const app = readFileSync('src/pwa/public/app.js', 'utf8')
const i18n = readFileSync('src/pwa/public/i18n.js', 'utf8')

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

// 1) 订单详情对卖家也渲染退货卡 + 走 widget 水合(direct_p2p 非托管无退款 → 该卡对 direct_p2p 不渲染)
ok('order detail renders a seller return card (isSeller && completed; direct_p2p un-gated since contract v15)',
  /\$\{\(isSeller && isGenuineCompleted\) \? `[\s\S]{0,160}ret-card-\$\{order\.id\}/.test(app))   // 2026-07:处置关单(settled_fault_at)不开售后面 → isGenuineCompleted 门
ok('return cards UN-gated for direct_p2p (v15: off-protocol refund handshake replaces the block)',
  (app.match(/order\.status === 'completed'[^`]*order\.payment_rail !== 'direct_p2p'/g) || []).length === 0
  && /window\.dpReturnHandshake \? window\.dpReturnHandshake\(item, isBuyer, isSellerView, order\)/.test(app))
ok('hydration calls renderReturnWidgetForOrder for seller too',
  /\(\(isBuyer && Number\(order\.effective_return_days \?\? product\?\.return_days \?\? 0\) > 0\) \|\| isSeller\) && isGenuineCompleted[\s\S]{0,160}renderReturnWidgetForOrder\(order, product\)/.test(app))   // RFC-026:服务端生效退货窗优先

// 2) widget:卖家无退货申请 → 隐藏整卡(不显示"申请退货")
const widget = app.slice(app.indexOf('async function renderReturnWidgetForOrder'), app.indexOf('async function renderReturnWidgetForOrder') + 5200)
ok('widget computes seller view', /const isSellerView = state\.user && state\.user\.id === order\.seller_id/.test(widget))
ok('widget hides the card for a seller when no return exists', /isSellerView && !mine[\s\S]{0,120}card\.style\.display = 'none'[\s\S]{0,20}return/.test(widget))

// 3) widget:卖家内联动作(复用既有 handler),传 order.id 上下文
// B6b-2 A6:usdc_escrow 的诚实禁用分支插在 accept 按钮之前 → 放宽匹配窗口,并单独锁住那个分支确实存在。
ok('seller pending → accept/reject inline (decideReturn with orderId ctx; accept label rail-aware)',
  /isSellerView && item\.status === 'pending'[\s\S]{0,600}decideReturn\('\$\{item\.id\}','accept','\$\{order\.id\}'\)[\s\S]{0,300}decideReturn\('\$\{item\.id\}','reject','\$\{order\.id\}'\)/.test(widget)
  && /同意退货\(场外退款\)/.test(widget))
ok('seller accept renders a DISABLED honest state on usdc_escrow (returns.ts 409s — on-chain refund unwired)',
  /order\.payment_rail === 'usdc_escrow' \? `<button class="btn btn-sm"[^`]*disabled>\$\{t\('接受退款\(链上退款接线中\)'\)\}<\/button>`/.test(widget))
ok('seller picked_up → received inline (confirmReturnReceived with orderId ctx)',
  /isSellerView && item\.status === 'picked_up'/.test(widget) && /confirmReturnReceived\('\$\{item\.id\}','\$\{order\.id\}'\)/.test(widget))

// 4) handlers 接受可选 orderId:有则回订单详情,无则回退货中心(退货中心调用向后兼容)
ok('confirmReturnReceived(id, orderId) re-renders order detail when orderId given',
  /window\.confirmReturnReceived = async \(id, orderId\)[\s\S]{0,260}if \(orderId\) renderOrderDetail\(document\.getElementById\('app'\), orderId\)[\s\S]{0,80}else renderReturnsCenter/.test(app))
ok('confirmDecideReturn(id, decision, orderId) re-renders order detail when orderId given',
  /window\.confirmDecideReturn = async \(id, decision, orderId\)[\s\S]{0,600}if \(orderId\) renderOrderDetail\(document\.getElementById\('app'\), orderId\)[\s\S]{0,80}else renderReturnsCenter/.test(app))
ok('decideReturn passes orderId through to confirmDecideReturn', /confirmDecideReturn\('\$\{id\}','\$\{decision\}','\$\{orderId \|\| ''\}'\)/.test(app))
// returns-center calls stay backward compatible (no orderId arg → returns-center re-render)
ok('returns center still calls decideReturn without orderId (unchanged)', /onclick="decideReturn\('\$\{it\.id\}','accept'\)"/.test(app))
ok('returns center still calls confirmReturnReceived without orderId (unchanged)', /onclick="confirmReturnReceived\('\$\{it\.id\}'\)"/.test(app))

// 5) 诚实:退款仍由卖家 accept / 确认收到触发,不谎称"自动退款"
ok('refund stays seller-driven (received → 触发退款, not auto)', /已收到退货 · 触发退款/.test(app))

// 6) i18n parity
ok('i18n EN present: ✓ 已收到退货 · 触发退款', /'✓ 已收到退货 · 触发退款'\s*:/.test(i18n))
for (const k of ['退货处理', '拒绝退货', '接受退款']) {
  ok(`i18n EN present: ${k}`, new RegExp(`'${k}'\\s*:`).test(i18n))
}

if (fail === 0) {
  console.log(`\n✅ order-detail inline return: 卖家在订单详情内联查看+处理退货(pending 接受/拒绝、picked_up 确认收到→退款);无申请隐藏卡;复用既有退款 handler 不改资金逻辑;处理完回订单详情;退货中心调用向后兼容;i18n parity\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
} else {
  console.error(`\n❌ order-detail inline return FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
  process.exit(1)
}
