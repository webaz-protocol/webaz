// 协商取消(mutual cancel)前端 —— 争议中订单的无责·双方合意下车口。UI ONLY(真正边界在后端 mutual-cancel 路由)。
//   握手:任一当事方提议 → 对方确认执行。无责:双方信誉不受影响。托管单买家全额退款+卖家质押返还;直付单零资金仅关单。
//   状态来自订单详情 DTO 的 order.mutual_cancel(仅 disputed 单计算),同步渲染,无需额外请求。中文 t(),英文 i18n.js _EN。

window.mutualCancelCard = (order, isBuyer, isSeller) => {
  if (!order || order.status !== 'disputed' || !(isBuyer || isSeller)) return ''
  const mc = order.mutual_cancel
  if (!mc) return ''
  const oid = order.id
  const settleNote = order.payment_rail === 'direct_p2p' ? t('直付非托管:关闭订单,双方零资金往来') : order.payment_rail === 'usdc_escrow' ? t('链上合约担保:本金在链上合约中,协商取消需链上退款(接线中),本轨暂不可执行') : t('托管:货款全额退回买家,卖家质押原样返还')   // B6b-2 A8:后端 settleMutualCancel 对本轨返回 USDC_ESCROW_MUTUAL_CANCEL_NOT_WIRED,绝不承诺"全额退回买家"
  const head = `<div style="font-size:13px;font-weight:700;color:#3730a3;margin-bottom:4px">🤝 ${t('协商取消订单(无责)')}</div>
    <div style="font-size:12px;color:#4b5563;line-height:1.7;margin-bottom:8px">${t('不走判罚:双方同意即可取消这笔争议订单,任何一方信誉都不受影响。')}${settleNote}。</div>`
  let body
  if (mc.proposal && mc.proposal.mine) {
    body = `<div style="font-size:12px;color:#6b7280;margin-bottom:8px">⏳ ${t('你已提议协商取消,等待对方确认。')}</div>
      <button class="btn btn-outline btn-sm" style="width:auto" onclick="mcWithdraw('${oid}')">${t('撤回提议')}</button>`
  } else if (mc.proposal) {
    body = `<div style="font-size:12px;color:#374151;margin-bottom:8px">📩 ${t('对方提议协商取消这笔订单。')}${mc.proposal.reason ? ' 「' + escHtml(mc.proposal.reason) + '」' : ''}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" style="width:auto" onclick="mcAccept('${oid}')">${t('接受 · 取消订单')}</button>
        <button class="btn btn-outline btn-sm" style="width:auto" onclick="mcDecline('${oid}')">${t('拒绝')}</button>
      </div>`
  } else if (mc.can_propose) {
    body = `<textarea id="mc-reason-${oid}" class="form-control" rows="2" placeholder="${t('原因(可选)')}" style="margin-bottom:8px;font-size:12px"></textarea>
      <button class="btn btn-outline btn-sm" style="width:auto" onclick="mcPropose('${oid}')">${t('提议协商取消')}</button>`
  } else return ''
  return `<div class="card" style="border:1px solid #c7d2fe;background:linear-gradient(135deg,#eef2ff,#e0e7ff)">${head}${body}</div>`
}

const mcToast = (m, kind) => { if (typeof toast$ === 'function') toast$(m, kind) }
const mcReload = (oid) => renderOrderDetail(document.getElementById('app'), oid)

window.mcPropose = async (oid) => {
  const el = document.getElementById('mc-reason-' + oid)
  const r = await POST('/orders/' + oid + '/mutual-cancel/propose', { reason: (el && el.value || '').trim() })
  if (r.error) return void mcToast(r.error, 'error')
  mcToast(t('已提议协商取消,等待对方确认'), 'success'); mcReload(oid)
}
window.mcAccept = async (oid) => {
  if (typeof confirmModal === 'function' && !(await confirmModal(t('确认接受协商取消?订单将被取消,双方无责。'), t('接受'), {}))) return
  const r = await POST('/orders/' + oid + '/mutual-cancel/accept', {})
  if (r.error) return void mcToast(r.error, 'error')
  mcToast(t('订单已协商取消'), 'success'); mcReload(oid)
}
window.mcDecline = async (oid) => {
  const r = await POST('/orders/' + oid + '/mutual-cancel/decline', {})
  if (r.error) return void mcToast(r.error, 'error')
  mcReload(oid)
}
window.mcWithdraw = async (oid) => {
  const r = await POST('/orders/' + oid + '/mutual-cancel/withdraw', {})
  if (r.error) return void mcToast(r.error, 'error')
  mcReload(oid)
}
