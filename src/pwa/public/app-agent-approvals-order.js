// RFC-021 PR2 — order-action 审批卡正文(app-agent-approvals.js 在 LOC ceiling 上,故拆出)。
//   渲染"对订单 <order_id> 执行 <accept|ship>(+tracking)"。不含任何买家地址/PII(list 端已 sanitize)。
//   Passkey 三元组由 aaApprove 从 card 的 data-* 读取:{request_id, order_id, action, params_hash}。
(function () {
  window.aaOrderWhat = function (r) {
    var ap = r.action_params || {}
    var actionLabel = r.order_action === 'ship' ? t('发货') : r.order_action === 'accept' ? t('接单') : String(r.order_action || '')
    var trackingLine = (r.order_action === 'ship' && ap.tracking)
      ? '<div style="font-size:12px;color:#6b7280;margin-top:4px">' + t('物流单号') + ': <code>' + escHtml(String(ap.tracking)) + '</code></div>'
      : ''
    return '' +
      '<div style="font-size:13px;color:#374151;line-height:1.7">⚡ ' + t('对订单') +
        ' <code style="font-size:12px">' + escHtml(String(r.order_id || '')) + '</code> ' + t('执行') +
        ' <b style="color:#6b21a8">' + escHtml(actionLabel) + '</b></div>' +
      trackingLine +
      '<div style="font-size:11px;color:#9ca3af;margin-top:2px">' + t('批准后由服务端在你授权下执行;agent 不直接执行') + '</div>'
  }
})()
