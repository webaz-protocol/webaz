// 直付(direct_p2p)送达后退货·场外退款握手前端 —— 退货骨架 UI 在 app.js renderReturnWidgetForOrder,
//   本模块只提供直付分支的 hooks(状态标签/握手动作块/升级判定与文案)。UI ONLY,真正边界在后端
//   routes/direct-pay-returns.ts + 域模块。中文 t(),英文 i18n.js _EN。库存绝不自动恢复(退货验收上架)。

window.dpReturnStatusLabels = () => ({ await_refund: t('待卖家场外退款'), refund_marked: t('卖家已声明退款 · 待你确认') })
window.dpReturnStatusColors = () => ({ await_refund: '#d97706', refund_marked: '#2563eb', accepted_pickup_pending: '#16a34a', picked_up: '#2563eb' })

// 握手动作块:卖家在 await_refund 声明退款;买家在 refund_marked 确认(Passkey)。其余状态返回 ''。
window.dpReturnHandshake = (item, isBuyer, isSellerView, order) => {
  if (!order || order.payment_rail !== 'direct_p2p') return ''
  const note = `<div style="font-size:11px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 8px;margin-bottom:8px">${t('直付非托管:退款由卖家在协议外完成,平台只记录握手,不经手货款。')}</div>`
  if (isSellerView && item.status === 'await_refund') {
    return `${note}<div style="font-size:12px;color:#374151;margin-bottom:6px">${t('你已同意退货。请在协议外向买家退款,然后声明;买家确认后退货完成。')}</div>
      <input id="dp-ret-ref-${item.id}" class="form-control" maxlength="200" placeholder="${t('退款参考(转账单号等,可选,买家可见)')}" style="margin-bottom:8px;font-size:12px">
      <button class="btn btn-primary btn-sm" style="width:auto;font-size:12px" onclick="dpReturnMarkRefunded('${item.id}','${order.id}')">${t('我已退款')}</button>`
  }
  if (isBuyer && item.status === 'await_refund') {
    return `${note}<div style="font-size:12px;color:#6b7280;margin-bottom:8px">⏳ ${t('卖家已同意退货,等待其在协议外向你退款并声明。超期未退款可升级争议。')}</div>`
  }
  if (isBuyer && item.status === 'refund_marked') {
    return `${note}<div style="font-size:12px;color:#374151;margin-bottom:8px">💸 ${t('卖家已声明退款')}${item.refund_reference ? '「' + escHtml(item.refund_reference) + '」' : ''}。${t('请先核实退款已到账;未收到请勿确认,可发起争议。')}</div>
      <button class="btn btn-primary btn-sm" style="width:auto;font-size:12px" onclick="dpReturnConfirmRefund('${item.id}','${order.id}')">${t('已收到退款,完成退货(需 Passkey)')}</button>`
  }
  if (isSellerView && item.status === 'refund_marked') {
    return `${note}<div style="font-size:12px;color:#6b7280">⏳ ${t('你已声明退款,等待买家确认收到。提示:退回货物须验收后手动上架,库存不会自动恢复。')}</div>`
  }
  return ''
}

// 升级争议判定(与后端 directPayReturnEscalatable 同口径;窗口天数由后端最终裁决,前端只做展示预判)
window.dpReturnCanEscalate = (item, order) => {
  if (!order || order.payment_rail !== 'direct_p2p') return false
  if (item.status === 'refund_marked') return true
  if (item.status === 'await_refund' && item.await_refund_since) return (Date.now() - new Date(String(item.await_refund_since).replace(' ', 'T') + 'Z').getTime()) >= 5 * 86400 * 1000
  return false
}
window.dpReturnEscalateHint = (item) => item.status === 'refund_marked'
  ? t('若卖家声明退款但你并未收到,可升级至平台仲裁(直付为信誉裁决)')
  : t('卖家同意退货后超期未退款 — 可升级至平台仲裁(直付为信誉裁决)')

window.dpReturnMarkRefunded = async (rid, oid) => {
  if (typeof confirmModal === 'function' && !(await confirmModal(t('确认你已在协议外向买家完成退货退款?声明后买家确认即完成;虚假声明将留痕并可被追责。'), t('我已退款'), { danger: true }))) return
  const el = document.getElementById('dp-ret-ref-' + rid)
  const r = await POST('/return-requests/' + rid + '/mark-refunded', { refund_reference: (el && el.value || '').trim() })
  if (r.error) return void toast$(r.error, 'error')
  toast$(t('已声明退款,等待买家确认'), 'success'); renderOrderDetail(document.getElementById('app'), oid)
}
window.dpReturnConfirmRefund = async (rid, oid) => {
  if (typeof confirmModal === 'function' && !(await confirmModal(t('确认已收到卖家退款?确认后退货完成,不可撤销。若尚未到账请勿确认。'), t('已收到,完成退货'), { danger: true }))) return
  let token
  try { token = await requestPasskeyGate('direct_pay_order_action', { order_id: oid, action: 'return_refund_confirm' }) }
  catch (e) { if (window.dpPromptRegisterPasskey) await window.dpPromptRegisterPasskey(e); return }
  const r = await POST('/return-requests/' + rid + '/confirm-refund', { webauthn_token: token })
  if (r.error) return void toast$(window.dpErrorText ? window.dpErrorText(r.error_code, r.error) : r.error, 'error')
  toast$(t('退货已完成'), 'success'); renderOrderDetail(document.getElementById('app'), oid)
}
