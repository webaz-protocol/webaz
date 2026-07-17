// RFC-026 PR-6 — 买家动作审批卡(confirm_receipt / cancel / request_return)。经济后果全披露:
//   confirm=托管释放金额;cancel=直付未付零资金;return=默认退款额。Passkey 四元组
//   {request_id, order_id, action, params_hash} 绑定后果快照,执行前服务端同谓词重验,任何漂移硬拒。
(function () {
  function waz(x) { return Number(x || 0).toFixed(2) }
  window.aaBuyerActionWhat = function (r) {
    var s = r.buyer_action
    if (!s) return '<div style="font-size:12px;color:#dc2626">' + t('动作摘要不可用 —— 请刷新;无法核对时请勿批准') + '</div>'
    var snap = s.snapshot || {}
    var head = s.action === 'confirm_receipt' ? ('✅ ' + t('确认收货并结算订单') + ' <b style="color:#b45309">' + waz(snap.settlement_total) + ' WAZ</b> · ' + t('按订单冻结规则分账'))
      : s.action === 'cancel' ? ('🚫 ' + t('取消直付订单(未付款,零资金移动)'))
      : ('↩️ ' + t('申请退货') + '(' + escHtml(String(snap.reason || '')) + ',' + t('默认退款') + ' ' + waz(snap.refund_amount) + ')')
    return '' +
      '<div style="font-size:13px;color:#374151;line-height:1.8">' + head + '</div>' +
      '<div style="font-size:12px;color:#6b7280;margin-top:4px">' + t('订单') + ': <code style="font-size:11px">' + escHtml(String(s.order_id)) + '</code>' + (s.product_title ? ' · ' + escHtml(String(s.product_title)) : '') + ' · ' + t('当前状态') + ': <b>' + escHtml(String(s.current_status || '')) + '</b></div>' +
      '<div style="font-size:11px;color:#9ca3af;margin-top:4px">' + t('批准后:服务端按当前状态重验后果快照(任何变化即拒绝),再经真实订单路由执行 —— 绝不静默变更') + '</div>'
  }
})()
