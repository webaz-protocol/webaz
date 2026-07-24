// USDC 合约担保(B 线)通知 i18n 模板(PR-B6a)。UI ONLY —— 服务端 notifyTransition / watcher 落库
//   template_key + params,此处按 viewer locale 用 t() 渲染;honest 中文回退。与 orders/lifecycle 同机制。
//   _ue = usdc_escrow 分轨:货款在【链上合约托管】,平台不经手,绝无 WAZ / 平台钱包入账话术。新句对已进 i18n.js。
//   新文件而非续写(orders/lifecycle 顶格,复杂度 ratchet 禁增行)。
;(function () {
  const S = window._notifSub
  const P = (emoji, titleZh, bodyZh) => (p) => ({ title: emoji + ' ' + t(titleZh), body: S(t(bodyZh), { logistics: t('物流方'), ...p }) })
  Object.assign(window.NOTIF_TEMPLATES, {
    ord_created_paid_ue: P('🛍️', '新订单', '{buyer} 下单了「{product}」并已将 {amount} USDC 存入链上合约托管，请及时接单发货。'),
    ord_delivered_confirmed_ue: P('✅', '买家确认收货，链上释放中', '{buyer} 已确认收货，货款经链上合约释放至你的收款地址(平台不经手)。'),
    ord_confirmed_completed_ue: P('✅', '交易完成，链上已结算', '订单「{product}」交易完成，货款已由链上合约结算至你的收款地址(平台不经手、无平台钱包入账)。'),
    usdc_dead_deposit_buyer: P('⚠️', '资金已入合约但订单已取消', '你的 USDC 已进入链上担保合约，但该订单已取消。平台将协助你处理链上退款，请勿担心。'),
    usdc_dead_deposit_seller: P('⚠️', '已取消订单收到链上存入，请勿发货', '一笔已取消订单收到了买家的链上存入。请勿发货;平台正在处理链上退款。'),
  })
})()
