// RFC-026 PR-1 — 审批页相似购买警告(生产双订单事故收口的展示层)。
//   同商品+同数量+同金额+同轨的多个待批准 order_submit = 高危相似组 —— 逐张标红,人必须逐笔明确批准;
//   本页无任何"全部批准"。服务端 intent 唯一索引已挡新的等价请求,此警告兜历史行/近似经济差异行。
;(function () {
  window.aaMarkSimilarSubmits = function (reqs) {
    var groups = {}
    reqs.forEach(function (r) { var s = r.submit_summary; if (r.kind !== 'order_submit' || !s) return; var k = [s.product_id, s.variant_id || '', s.quantity, s.payable_units, s.payment_rail, s.direct_receive_account_id || '', s.dest_region || ''].join('|'); (groups[k] = groups[k] || []).push(r) })
    Object.keys(groups).forEach(function (k) {
      var g = groups[k]; if (g.length < 2) return
      var ts = g.map(function (r) { return new Date(r.created_at).getTime() }).filter(isFinite)
      var gap = ts.length >= 2 ? Math.round((Math.max.apply(null, ts) - Math.min.apply(null, ts)) / 1000) : null
      g.forEach(function (r) { r._dup_n = g.length; r._dup_gap_s = gap })
    })
  }
  // 冻结态(上次执行结果不明)的和解提示:再次 Passkey 批准 = 服务端核对是否已建单(已建→补记返回订单号;未建→安全重试)
  window.aaReconcileNoteHtml = function (r) {
    if (!r.needs_reconcile) return ''
    return '<div style="font-size:12px;line-height:1.7;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px;margin-bottom:8px">⏸ <b>' + t('上次执行结果不明') + '</b>。' + t('再次用 Passkey 批准即安全核对:若订单已创建会直接返回订单号,不会重复下单;若未创建则重新执行。') + '</div>'
  }
  window.aaDupWarnHtml = function (r) {
    if (!r._dup_n) return ''
    return '<div style="font-size:12px;line-height:1.7;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 10px;margin-bottom:8px">⚠️ <b>' + t('检测到相似购买请求') + '</b>:' + r._dup_n + ' ' + t('个待批准请求为同一商品、同一数量、同一金额') + (r._dup_gap_s != null ? '(' + t('创建时间相差') + ' ' + r._dup_gap_s + 's)' : '') + '。' + t('每一项批准都会创建一笔真实订单;若你只想买一件,请只批准其中一项并拒绝其余。') + '</div>'
  }
})()
