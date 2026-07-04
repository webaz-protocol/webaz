// 争议协商收口·买家侧 —— "我已收到货 · 撤诉并确认收货"。UI ONLY(权威门在 orders-action dispute_withdraw_confirm:
//   delivered 来源履约争议 + 发起人本人 + 裁定前;dp 轨 D1/D2+Passkey)。可达性来自订单 DTO can_confirm_receipt_close_dispute。
//   注入:包装 mutualCancelCard(协商取消卡下追加;卖家侧收口=协商取消全额退款,买家侧=本卡),app.js 净零行。
;(function () {
  const S = window._notifSub
  Object.assign(window.NOTIF_TEMPLATES, {
    dispute_withdrawn_confirmed: (p) => ({ title: '✅ ' + t('买家已撤诉并确认收货'), body: S(t('买家撤回争议并确认收货,订单已完成结算,双方信誉不受影响。'), p) }),
  })

  const closeCard = (order) => {
    if (!order || !order.can_confirm_receipt_close_dispute) return ''
    const settleNote = order.payment_rail === 'direct_p2p'
      ? t('确认后订单完成:货款你已线下支付,平台服务费照常计提。需 Passkey 确认。')
      : t('确认后订单完成:托管货款将释放给卖家。')
    return `<div class="card" style="border:1px solid #bbf7d0;background:linear-gradient(135deg,#f0fdf4,#dcfce7)">
      <div style="font-size:13px;font-weight:700;color:#166534;margin-bottom:4px">📦 ${t('后来收到货了?')}</div>
      <div style="font-size:12px;color:#4b5563;line-height:1.7;margin-bottom:8px">${t('包裹晚到/在代收点找到了?你可以撤回这条争议并确认收货,订单正常完成,双方信誉都不受影响。')}${settleNote}</div>
      <button class="btn btn-primary btn-sm" style="width:auto" onclick="dcWithdrawConfirm('${order.id}','${order.payment_rail === 'direct_p2p' ? 1 : ''}')">${t('我已收到货 · 撤诉并确认收货')}</button>
    </div>`
  }

  window.dcWithdrawConfirm = async (oid, isDp) => {
    if (typeof confirmModal === 'function' && !(await confirmModal(t('确认撤回争议并确认收货?争议将关闭(不可恢复),订单立即完成结算。'), t('撤诉并确认收货'), { danger: true }))) return
    const body = { action: 'dispute_withdraw_confirm' }
    if (isDp) {
      try { body.webauthn_token = await requestPasskeyGate('direct_pay_order_action', { order_id: oid, action: 'dispute_withdraw_confirm' }) }
      catch (e) { if (window.dpPromptRegisterPasskey) await window.dpPromptRegisterPasskey(e); return }
    }
    const r = await POST('/orders/' + oid + '/action', body)
    if (r.error) return void toast$(r.error, 'error')
    toast$(t('已撤诉并确认收货,订单完成'), 'success')
    renderOrderDetail(document.getElementById('app'), oid)
  }

  // 包装协商取消卡:disputed 订单页在其后追加买家收口卡(app.js 调用点不变,净零行)
  const _origMcCard = window.mutualCancelCard
  window.mutualCancelCard = (order, isBuyer, isSeller) => (_origMcCard ? _origMcCard(order, isBuyer, isSeller) : '') + (isBuyer ? closeCard(order) : '')
})()
