// Direct Pay (Rail 1) — 付款时刻 UI 辅助。UI ONLY;不碰 wallet/escrow/settlement/refund/订单钱路。
//   dpPayAmountText(order):直付订单【应付金额】纯文本,用于两次披露弹窗(D2)/ 风险确认完成弹窗 / 订单收款说明框。
//   买家只能按【下单时所选卖家收款账户的币种】付款,故金额换算走该账户币种(dpFxInCurrency,取自 direct_pay_account_snapshot),
//   不是买家本地币(买家本地币不一定是卖家支持的收款币种);无该币种汇率 → 回落币种码,绝不臆造换算。金额本身非敏感,始终可展示。
//   面向用户中文走 t(),英文在 i18n.js _EN(双语 parity 由 test-direct-pay-ui.ts 守)。
window.dpPayAmountText = (order) => {
  if (!order) return ''
  const usdc = Number(order.total_amount)
  const s = Number.isFinite(usdc) ? (Number.isInteger(usdc) ? String(usdc) : usdc.toFixed(2)) : '—'
  let cur = ''
  try { cur = String(JSON.parse(order.direct_pay_account_snapshot || '{}').currency || '').toUpperCase() } catch {}
  if (!cur || cur === 'USDC' || cur === 'USD') return `${t('应付')} ${s} USDC`
  const fx = window.dpFxInCurrency ? window.dpFxInCurrency(usdc, cur) : ''
  return (fx && fx !== cur) ? `${t('应付')} ≈ ${fx}（${s} USDC）` : `${t('应付')} ${s} USDC · ${cur}`
}
