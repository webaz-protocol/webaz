// 直付卖家对账卡(审计项 F)。UI ONLY;不碰钱路。买家 mark_paid 后(accepted,发货前)在卖家视角显性化
//   对账三要素:①期望参考号(dpPayRef 派生,银行流水附言应恰为此值,一键复制便于流水搜索)②应付金额
//   (E 冻结的 payable 快照,与买家所见同一数字)③同买家同金额在途多单告警(DTO duplicate_amount_alert,
//   与 mark_paid D2 时间线预警同口径 —— 防一笔转账冒充两单)。买家声称的参考在时间线(mark_paid note)可见。
//   发货即确认收款(D4 弹窗把关),此卡把核对动作前置到打开订单页的每一刻。中文 t(),英文 i18n.js _EN。
window.dpReconcileCard = (order, isSeller) => {
  if (!order || !isSeller || order.payment_rail !== 'direct_p2p' || order.status !== 'accepted') return ''
  const ref = window.dpPayRef ? window.dpPayRef(order.id) : ''
  const pay = window.dpPayAmountText ? window.dpPayAmountText(order) : ''
  const dup = Number(order.duplicate_amount_alert) || 0
  return `<div class="card" style="border:1px solid #bbf7d0;background:linear-gradient(135deg,#f0fdf4,#dcfce7)">
    <div style="font-size:13px;font-weight:700;color:#166534;margin-bottom:4px">🧾 ${t('发货前对账(买家已标记付款)')}</div>
    <div style="font-size:12px;color:#374151;line-height:1.9">
      <div>${t('银行/收款App流水附言应为')} <code style="font-size:13px;font-weight:700;background:#fff;border:1px solid #bbf7d0;border-radius:6px;padding:2px 6px">${escHtml(ref)}</code>${window.dpCopyBtn ? window.dpCopyBtn(ref) : ''}</div>
      ${pay ? `<div>💸 ${escHtml(pay)}</div>` : ''}
      ${dup > 0 ? `<div style="color:#b91c1c;font-weight:600">⚠️ ${t('同买家另有')} ${dup} ${t('笔同金额直付订单在途 —— 每笔转账只能核销一个订单,请逐单核对参考号,谨防一笔款冒充多单。')}</div>` : ''}
      <div style="font-size:11px;color:#6b7280">${t('请核实款项【已到账】且附言/金额与本单一致再发货;发货即视为确认收款。未收到请点"未收到货款"。')}</div>
    </div></div>`
}
