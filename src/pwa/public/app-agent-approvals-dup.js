// RFC-026 PR-1 — 审批页相似购买警告(生产双订单事故收口的展示层)。
//   同商品+同数量+同金额+同轨的多个待批准 order_submit = 高危相似组 —— 逐张标红,人必须逐笔明确批准;
//   本页无任何"全部批准"。服务端 intent 唯一索引已挡新的等价请求,此警告兜历史行/近似经济差异行。
;(function () {
  window.aaMarkSimilarSubmits = function (reqs) {
    var groups = {}
    reqs.forEach(function (r) { var s = r.submit_summary; if (r.kind !== 'order_submit' || !s) return; var k = [s.product_id, s.quantity, s.payable_units, s.payment_rail].join('|'); (groups[k] = groups[k] || []).push(r) })
    Object.keys(groups).forEach(function (k) {
      var g = groups[k]; if (g.length < 2) return
      var ts = g.map(function (r) { return new Date(r.created_at).getTime() }).filter(isFinite)
      var gap = ts.length >= 2 ? Math.round((Math.max.apply(null, ts) - Math.min.apply(null, ts)) / 1000) : null
      g.forEach(function (r) { r._dup_n = g.length; r._dup_gap_s = gap })
    })
  }
  window.aaDupWarnHtml = function (r) {
    if (!r._dup_n) return ''
    return '<div style="font-size:12px;line-height:1.7;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 10px;margin-bottom:8px">⚠️ <b>' + t('检测到相似购买请求') + '</b>:' + r._dup_n + ' ' + t('个待批准请求为同一商品、同一数量、同一金额') + (r._dup_gap_s != null ? '(' + t('创建时间相差') + ' ' + r._dup_gap_s + 's)' : '') + '。' + t('每一项批准都会创建一笔真实订单;若你只想买一件,请只批准其中一项并拒绝其余。') + '</div>'
  }
})()
