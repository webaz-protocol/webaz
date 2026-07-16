// RFC-025 PR-5a — order-submit 审批卡正文(app-agent-approvals.js 在 LOC ceiling 上,故拆出,同 -order.js 先例)。
//   渲染买家下单审批的【全部经济条款】:商品/数量/总额/实付(含捐赠)/轨道/目的地区 + "批准后将发生什么"。
//   人批的 = 执行的:服务端以 params_hash 绑定的 draft 快照执行,任何 drift 硬失败,绝不静默换条件。
//   零 PII:目的地只有 region 标签。Passkey 四元组沿用通用 data-*:{request_id, order_id(=draft_id), action='order_submit', params_hash}。
(function () {
  function waz(u) { return (Number(u || 0) / 1e6).toFixed(2) }
  window.aaOrderSubmitWhat = function (r) {
    var s = r.submit_summary
    if (!s) return '<div style="font-size:12px;color:#dc2626">' + t('草稿摘要不可用(可能已取消/过期)—— 请刷新;无法核对条款时请勿批准') + '</div>'
    var railLine = s.payment_rail === 'direct_p2p'
      ? t('直付(WebAZ 不托管资金;你将按卖家收款说明场外支付)')
      : t('托管(批准后立即从你的钱包扣款入托管)')
    var donation = Number(s.donation_units || 0) > 0
      ? '<div style="font-size:12px;color:#6b7280">' + t('含捐赠') + ': ' + waz(s.donation_units) + ' WAZ</div>' : ''
    var expired = s.draft_status !== 'draft' ? '<div style="font-size:12px;color:#dc2626;margin-top:4px">' + t('注意:草稿状态已变化,批准将被服务端拒绝') + '</div>' : ''
    return '' +
      '<div style="font-size:13px;color:#374151;line-height:1.8">🛒 ' + t('创建订单') + ': <b>' + escHtml(String(s.product_title || s.draft_id)) + '</b>' +
        (s.variant_id ? ' <span style="font-size:11px;color:#6b7280">(' + escHtml(String(s.variant_id)) + ')</span>' : '') +
        ' × <b>' + escHtml(String(s.quantity)) + '</b></div>' +
      '<div style="font-size:13px;color:#111827"><b>' + t('实付') + ': ' + waz(s.payable_units) + ' ' + escHtml(String(s.currency || 'WAZ')) + '</b>' +
        ' <span style="font-size:11px;color:#6b7280">(' + t('总额') + ' ' + waz(s.total_units) + ')</span></div>' + donation +
      '<div style="font-size:12px;color:#6b7280">' + t('支付轨道') + ': ' + railLine + '</div>' +
      '<div style="font-size:12px;color:#6b7280">' + t('收货') + ': ' + t('默认地址') + (s.dest_region ? ' · ' + escHtml(String(s.dest_region)) : '') + '</div>' +
      '<div style="font-size:11px;color:#9ca3af;margin-top:4px">' + t('批准后:服务端按当前市场状态重验此快照(价格/库存/资格任何变化即拒绝),通过才创建真实订单;条款绝不静默变更') + '</div>' +
      expired
  }
})()
