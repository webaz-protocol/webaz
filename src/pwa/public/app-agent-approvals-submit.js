// RFC-025 PR-5a — order-submit 审批卡正文(app-agent-approvals.js 在 LOC ceiling 上,故拆出,同 -order.js 先例)。
//   完整披露(Codex BLOCKER-3):卡片展示 params_hash 绑定的【每一个】经济/身份字段 —— 单价/小计/运费/
//   捐赠 bps/收款账户/匿名收件/卖家(脱敏)/草稿有效期。人批的 = 执行的:服务端以 hash 绑定的 draft 快照
//   执行,任何 drift 硬失败,绝不静默换条件。商品标题是【当前】listing 标题(仅助识别;绑定的是 product_id,
//   卡上如实标注)。零 PII:目的地只有 region 标签。Passkey 四元组沿用通用 data-*:
//   {request_id, order_id(=draft_id), action='order_submit', params_hash}。
(function () {
  function waz(u) { return (Number(u || 0) / 1e6).toFixed(2) }
  function row(label, val) { return '<div style="font-size:12px;color:#6b7280">' + label + ': ' + val + '</div>' }
  window.aaOrderSubmitWhat = function (r) {
    var s = r.submit_summary
    if (!s) return '<div style="font-size:12px;color:#dc2626">' + t('草稿摘要不可用(可能已取消/过期)—— 请刷新;无法核对条款时请勿批准') + '</div>'
    var railLine = s.payment_rail === 'direct_p2p'
      ? t('直付(WebAZ 不托管资金;你将按卖家收款说明场外支付)')
      : t('托管(批准后立即从你的钱包扣款入托管)')
    return '' +
      '<div style="font-size:13px;color:#374151;line-height:1.8">🛒 ' + t('创建订单') + ': <b>' + escHtml(String(s.product_title || s.product_id)) + '</b>' +
        ' <span style="font-size:10px;color:#9ca3af">(' + t('当前标题,仅供识别;绑定的是商品 ID') + ' <code>' + escHtml(String(s.product_id)) + '</code>)</span>' +
        (s.variant_id ? ' <span style="font-size:11px;color:#6b7280">' + t('规格') + ': ' + escHtml(String(s.variant_id)) + '</span>' : '') +
        ' × <b>' + escHtml(String(s.quantity)) + '</b></div>' +
      '<div style="font-size:13px;color:#111827"><b>' + t('实付') + ': ' + waz(s.payable_units) + ' ' + escHtml(String(s.currency || 'WAZ')) + '</b>' +
        ' <span style="font-size:11px;color:#6b7280">(' + t('总额') + ' ' + waz(s.total_units) + ')</span></div>' +
      row(t('单价'), waz(s.unit_price_units) + ' × ' + escHtml(String(s.quantity)) + ' = ' + waz(s.item_units)) +
      row(t('运费'), waz(s.shipping_units)) +
      (Number(s.donation_bps || 0) > 0 ? row(t('捐赠'), (Number(s.donation_bps) / 100).toFixed(1) + '% = ' + waz(s.donation_units) + ' WAZ ' + t('(额外扣款,入公益池)')) : '') +
      row(t('支付轨道'), railLine) +
      (s.direct_receive_account_id ? row(t('卖家收款账户'), '<code>' + escHtml(String(s.direct_receive_account_id)) + '</code>') : '') +
      (s.anonymous_recipient ? row(t('匿名收件'), t('已开启(卖家/物流不见你的身份)')) : '') +
      row(t('卖家'), '<code>' + escHtml(String(s.seller_id_hint || '')) + '</code>') +
      row(t('收货'), t('默认地址') + (s.dest_region ? ' · ' + escHtml(String(s.dest_region)) : '')) +
      row(t('草稿有效期至'), escHtml(String(s.draft_expires_at || '')).slice(0, 16)) +
      '<div style="font-size:11px;color:#9ca3af;margin-top:4px">' + t('批准后:服务端按当前市场状态重验此快照(价格/库存/资格/卖家任何变化即拒绝),通过才创建真实订单;条款绝不静默变更') + '</div>' +
      (s.draft_status !== 'draft' ? '<div style="font-size:12px;color:#dc2626;margin-top:4px">' + t('注意:草稿状态已变化,批准将被服务端拒绝') + '</div>' : '')
  }
})()
