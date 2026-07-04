// 直付取消退款握手前端(审计项 C)—— 付款后(accepted)·发货前:买家申请取消 → 卖家场外退款并声明 →
//   买家确认收到(Passkey)→ 系统无责关单。UI ONLY(真正边界在后端 direct-pay-cancel-refund 路由 + 域模块)。
//   状态来自订单详情 DTO 的 order.cancel_refund(仅 direct_p2p+accepted 计算),同步渲染。中文 t(),英文 i18n.js _EN。

window.dpCancelRefundCard = (order, isBuyer, isSeller) => {
  if (!order || order.payment_rail !== 'direct_p2p' || order.status !== 'accepted' || !(isBuyer || isSeller)) return ''
  const cr = order.cancel_refund
  if (!cr) return ''
  const oid = order.id
  const req = cr.request
  const eff = req && req.status
  const head = `<div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:4px">↩️ ${t('取消订单并退款(直付)')}</div>
    <div style="font-size:12px;color:#4b5563;line-height:1.7;margin-bottom:8px">${t('直付非托管:平台不持货款,退款由卖家在协议外完成,双方在此握手确认,订单无责取消。')}</div>`
  let body = ''
  if (isBuyer && cr.can_confirm) {
    body = `<div style="font-size:12px;color:#374151;margin-bottom:8px">💸 ${t('卖家已声明退款')}${req && req.refund_reference ? '「' + escHtml(req.refund_reference) + '」' : ''}。${t('请先核实退款已到账;未收到请勿确认,可发起争议。')}</div>
      <button class="btn btn-primary btn-sm" style="width:auto" onclick="dpCrConfirm('${oid}')">${t('已收到退款,确认取消订单(需 Passkey)')}</button>`
  } else if (isBuyer && eff === 'requested') {
    body = `<div style="font-size:12px;color:#6b7280;margin-bottom:8px">⏳ ${t('已向卖家发出取消退款请求,等待响应(超期可重新申请或发起争议)。')}</div>
      <button class="btn btn-outline btn-sm" style="width:auto" onclick="dpCrWithdraw('${oid}')">${t('撤回请求')}</button>`
  } else if (isBuyer && cr.can_request) {
    const hint = eff === 'declined' ? `<div style="font-size:12px;color:#b91c1c;margin-bottom:6px">${t('卖家拒绝了上次请求(继续发货)。可再次申请或与卖家沟通。')}</div>` : (eff === 'expired' ? `<div style="font-size:12px;color:#b91c1c;margin-bottom:6px">${t('上次请求卖家未在期限内响应。可重新申请,或发起争议。')}</div>` : '')
    body = `${hint}<textarea id="dp-cr-reason-${oid}" class="form-control" rows="2" placeholder="${t('取消理由(可选,卖家可见)')}" style="margin-bottom:8px;font-size:12px"></textarea>
      <button class="btn btn-outline btn-sm" style="width:auto" onclick="dpCrRequest('${oid}')">${t('申请取消并退款')}</button>`
  } else if (isSeller && cr.can_respond) {
    body = `<div style="font-size:12px;color:#374151;margin-bottom:8px">📩 ${t('买家申请取消订单并退款。')}${req && req.reason ? '「' + escHtml(req.reason) + '」' : ''} ${t('同意:先在协议外退款,再点"我已退款";不同意:拒绝并继续发货。')}</div>
      <input id="dp-cr-ref-${oid}" class="form-control" maxlength="200" placeholder="${t('退款参考(转账单号等,可选,买家可见)')}" style="margin-bottom:8px;font-size:12px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" style="width:auto" onclick="dpCrMarkRefunded('${oid}')">${t('我已退款')}</button>
        <button class="btn btn-outline btn-sm" style="width:auto" onclick="dpCrDecline('${oid}')">${t('拒绝(继续发货)')}</button>
      </div>`
  } else if (isSeller && eff === 'refund_marked') {
    body = `<div style="font-size:12px;color:#6b7280">⏳ ${t('你已声明退款,等待买家确认收到后订单将无责取消。')}</div>`
  } else return ''
  return `<div class="card" style="border:1px solid #fde68a;background:linear-gradient(135deg,#fffbeb,#fef3c7)">${head}${body}</div>`
}

const dpCrToast = (m, kind) => { if (typeof toast$ === 'function') toast$(m, kind) }
const dpCrReload = (oid) => renderOrderDetail(document.getElementById('app'), oid)

window.dpCrRequest = async (oid) => {
  const el = document.getElementById('dp-cr-reason-' + oid)
  const r = await POST('/orders/' + oid + '/cancel-refund/request', { reason: (el && el.value || '').trim() })
  if (r.error) return void dpCrToast(r.error, 'error')
  dpCrToast(t('已发出取消退款请求,等待卖家响应'), 'success'); dpCrReload(oid)
}
window.dpCrDecline = async (oid) => {
  const r = await POST('/orders/' + oid + '/cancel-refund/decline', {})
  if (r.error) return void dpCrToast(r.error, 'error')
  dpCrReload(oid)
}
window.dpCrMarkRefunded = async (oid) => {
  if (typeof confirmModal === 'function' && !(await confirmModal(t('确认你已在协议外向买家完成退款?声明后买家确认即取消订单;虚假声明将留痕并可被追责。'), t('我已退款'), { danger: true }))) return
  const el = document.getElementById('dp-cr-ref-' + oid)
  const r = await POST('/orders/' + oid + '/cancel-refund/mark-refunded', { refund_reference: (el && el.value || '').trim() })
  if (r.error) return void dpCrToast(r.error, 'error')
  dpCrToast(t('已声明退款,等待买家确认'), 'success'); dpCrReload(oid)
}
window.dpCrWithdraw = async (oid) => {
  const r = await POST('/orders/' + oid + '/cancel-refund/withdraw', {})
  if (r.error) return void dpCrToast(r.error, 'error')
  dpCrReload(oid)
}
window.dpCrConfirm = async (oid) => {
  if (typeof confirmModal === 'function' && !(await confirmModal(t('确认已收到卖家退款?确认后订单将无责取消,不可撤销。若尚未到账请勿确认。'), t('已收到,取消订单'), { danger: true }))) return
  let token
  try { token = await requestPasskeyGate('direct_pay_order_action', { order_id: oid, action: 'cancel_refund_confirm' }) }
  catch (e) { if (window.dpPromptRegisterPasskey) await window.dpPromptRegisterPasskey(e); return }
  const r = await POST('/orders/' + oid + '/cancel-refund/confirm', { webauthn_token: token })
  if (r.error) return void dpCrToast(window.dpErrorText ? window.dpErrorText(r.error_code, r.error) : r.error, 'error')
  dpCrToast(t('订单已无责取消'), 'success'); dpCrReload(oid)
}
