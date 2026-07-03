// Direct Pay (Rail 1) — 付款时刻 UI 辅助。UI ONLY;不碰钱路。dpPayAmountText(order):应付金额纯文本,
//   用于 D2 弹窗/风险确认弹窗/订单收款说明框。审计项 E:优先【下单时冻结的应付参考换算】(snapshot payable_* —
//   买家/卖家/时间线同一稳定数字,不随实时汇率漂移;标注"下单时参考,以卖家收款说明为准");旧单无快照 → 回落
//   实时换算(dpFxInCurrency);再无 → 仅 USDC。USDC/USD 账户:另附买家本地法币参考(_fxLocal)。中英 i18n parity。
window.dpPayAmountText = (order) => {
  if (!order) return ''
  const usdc = Number(order.total_amount)
  const s = Number.isFinite(usdc) ? (Number.isInteger(usdc) ? String(usdc) : usdc.toFixed(2)) : '—'
  let snap = {}; try { snap = JSON.parse(order.direct_pay_account_snapshot || '{}') || {} } catch {}
  const cur = String(snap.currency || '').toUpperCase()
  if (!cur || cur === 'USDC' || cur === 'USD') { const loc = window._fxLocal ? window._fxLocal(usdc) : ''; return `${t('应付')} ${s} USDC${loc ? ' ≈ ' + loc : ''}` }
  if (Number.isFinite(Number(snap.payable_approx))) return `${t('应付')} ≈ ${cur} ${Number(snap.payable_approx).toFixed(2)}（${s} USDC · ${t('下单时参考价,以卖家收款说明为准')}）`
  const fx = window.dpFxInCurrency ? window.dpFxInCurrency(usdc, cur) : ''
  return (fx && fx !== cur) ? `${t('应付')} ≈ ${fx}（${s} USDC）` : `${t('应付')} ${s} USDC · ${cur}`
}
