// 订单按【支付轨(类型)】筛选 —— renderOrders 的类型 chip / badge / 筛选逻辑抽出(app.js 已达 ratchet 上限,新域不回塞)。
//   托管 escrow(默认)/ 直接收款 direct_p2p。纯只读客户端筛选,与 scope/status 分组同层;仅当有直接收款单才显示 chip。
;(function () {
  // 按 state.ordersRail 过滤订单数组(全部/托管/直接收款);返回过滤后的新数组。
  window.orderRailApply = (orders) => {
    const r = state.ordersRail || 'all'
    if (r === 'direct_p2p') return orders.filter(o => o.payment_rail === 'direct_p2p')
    if (r === 'escrow')     return orders.filter(o => (o.payment_rail || 'escrow') === 'escrow')
    return orders
  }
  // 类型筛选 chip 行(传入【筛选前】订单以判定是否有直接收款单;无则返回空串,纯托管用户不打扰)。
  window.orderRailChipsHtml = (ordersBeforeFilter) => {
    if (!ordersBeforeFilter.some(o => o.payment_rail === 'direct_p2p')) return ''
    const cur = state.ordersRail || 'all'
    return `<div style="display:flex;gap:6px;margin-bottom:10px">${[['all', t('全部类型')], ['escrow', '🏦 ' + t('托管')], ['direct_p2p', '🤝 ' + t('直接收款')]].map(([k, label]) => {
      const on = cur === k
      return `<button onclick="setOrdersRail('${k}')" style="padding:4px 10px;border-radius:12px;font-size:11px;border:1px solid ${on ? '#5b21b6' : '#e5e7eb'};background:${on ? '#5b21b6' : '#fff'};color:${on ? '#fff' : '#374151'};cursor:pointer;font-weight:${on ? '600' : '400'}">${label}</button>`
    }).join('')}</div>`
  }
  // 订单卡上的类型徽标(只给直接收款打标,托管是默认不打扰)。
  window.orderRailBadge = (o) => o.payment_rail === 'direct_p2p' ? ` · <span style="color:#7c3aed;font-weight:600">🤝 ${t('直接收款')}</span>` : ''
  window.setOrdersRail = (r) => { state.ordersRail = r; renderOrders(document.getElementById('app')) }
})()
