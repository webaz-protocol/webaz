// RFC-026 PR-5 — 地址变更审批卡正文(主文件顶格,拆出同 -order/-submit 先例)。
//   人在这里看到【完整新地址】(human-authed list 附带,agent 面永远拿不到),Passkey 三元组
//   {request_id, action:'address_change', params_hash} 绑定内容哈希(无订单实体,order_id 不参与绑定) —— 批的=写入的,一字不差。
(function () {
  window.aaAddressWhat = function (r) {
    var ac = r.address_change
    if (!ac) return '<div style="font-size:12px;color:#dc2626">' + t('待确认地址内容缺失 —— 请刷新;无法核对时请勿批准') + '</div>'
    return '' +
      '<div style="font-size:13px;color:#374151;line-height:1.8">📮 <b>' + t('修改默认收货地址') + '</b></div>' +
      '<div style="font-size:13px;color:#111827;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;margin-top:6px;white-space:pre-wrap">' + escHtml(String(ac.address_text)) + '</div>' +
      '<div style="font-size:12px;color:#6b7280;margin-top:4px">' + t('地区') + ': <b>' + escHtml(String(ac.region)) + '</b></div>' +
      '<div style="font-size:11px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:6px 10px;margin-top:6px">⚠️ ' + t('批准后立即生效为你的默认收货地址;此前报价/草稿因地址变化会在执行时被安全拒绝(需重新报价)。agent 永远无法读取完整地址。') + '</div>'
  }
})()
