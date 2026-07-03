// Direct Pay 货款协商(payment_query)前端 —— 状态标签 + 订单页动作 + 协商说明卡。UI ONLY。
//   争议≠仲裁:payment_query = 买卖双方【协商】(非仲裁)。卖家报未收款 → 协商;买家可取消(未付)或提交凭证升级举证(已付);
//   卖家可确认已收(恢复)或宽限后申请取消。动作走通用 /orders/:id/action(非 Passkey 门;pq_escalate 需证据)。
//   非托管:全程无退款/放款/WAZ 语义。中文 t(),英文 i18n.js _EN(双语 parity 由 test-direct-pay-ui.ts 守)。

window.dpNegotiationBadge = (status) => status === 'payment_query' ? ['yellow', t('货款协商中')] : null
window.dpNegotiationLabel = (status) => status === 'payment_query' ? t('货款协商中(非仲裁)') : null

// 订单页按状态/角色返回协商动作(仅 direct_p2p 调用)。返回数组=接管;null=交回默认。
window.dpNegotiationActions = (order, isBuyer, isSeller) => {
  const s = order.status
  if (s === 'payment_query') {
    if (isSeller) return [
      { action: 'confirm_received', label: '确认已收到货款(恢复订单)', style: 'success' },
      { action: 'request_cancel', label: '申请取消订单(买家未回应时)', style: 'secondary' },
    ]
    if (isBuyer) return [
      { action: 'pq_escalate', label: '我已付款 · 提交凭证升级举证', style: 'primary', needsEvidence: true, noteLabel: '付款凭证 / 参考号', evidencePlaceholder: '链上 tx / 银行回执 / 付款参考号(与下单时附言一致)' },
      { action: 'cancel', label: '我未付款 · 取消订单', style: 'secondary' },
    ]
  }
  if (s === 'disputed' && (isBuyer || isSeller)) return [
    { action: 'pq_withdraw', label: '撤回仲裁 · 回到协商', style: 'secondary' },
  ]
  return null
}

// 协商说明卡(payment_query 时展示):解释状态 + 提示买家复述付款参考。
window.dpNegotiationCard = (order) => (!order || order.status !== 'payment_query') ? '' : `
  <div class="card" style="border:1px solid #fde68a;background:linear-gradient(135deg,#fffbeb,#fef3c7)">
    <div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:6px">🔎 ${t('货款协商中(非仲裁)')}</div>
    <div style="font-size:12px;color:#374151;line-height:1.7">${t('卖家报告未收到货款。这是买卖双方【协商】阶段,不是仲裁:若你确已付款,请提交付款凭证升级举证;若未付款,可取消订单。谈不拢再进举证仲裁。直付非托管,WebAZ 不代收/不退款。')}</div>
  </div>`
