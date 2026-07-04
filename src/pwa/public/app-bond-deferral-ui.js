// 缓交收口通知模板(B4)。UI ONLY —— 提醒/到期/转正式全在后端 cron/路由。
;(function () {
  const S = window._notifSub
  const P = (emoji, titleZh, bodyZh) => (p) => ({ title: emoji + ' ' + t(titleZh), body: S(t(bodyZh), p) })
  Object.assign(window.NOTIF_TEMPLATES, {
    deferral_expiring_soon: P('⏰', '保证金缓交即将到期', '你的缓交资格将于 {expires} 到期。请在到期前缴纳履约保证金转正式(设置页-直付履约保证金),否则宽限期后直付资格将关闭。'),
    deferral_expired: P('🚫', '保证金缓交已到期', '缓交资格已到期。若未缴纳保证金,直付资格已关闭(缴纳并经运营确认后可重新开通);在途订单不受影响,请正常履约完成。'),
  })
})()
