// 直付判责关单退款握手前端(P1-D 买家事后救济·方案 A)—— 卖家违约被系统关单(completed+settled_fault_at)后:
//   买家申请场外退款 → 卖家声明已退款 → 买家确认收到(Passkey)= 握手闭环留档(零资金、订单状态不动);
//   卖家拒绝/超时/声明后未到账 → 买家举证升级仲裁(信誉裁决)。UI ONLY,边界在后端 direct-fault-refund 路由。
//   状态来自订单详情 DTO 的 order.fault_refund(仅 direct_p2p+处置关单计算)。中文 t(),英文 i18n.js _EN。
//   本文件同时注册自己的通知 i18n 模板(frc_*)—— 域内聚,不再增长已顶格的 notif-templates 文件。

window.dpFaultRefundCard = (order, isBuyer, isSeller) => {
  if (!order || order.payment_rail !== 'direct_p2p' || order.status !== 'completed' || !order.settled_fault_at || !(isBuyer || isSeller)) return ''
  const fr = order.fault_refund
  if (!fr || !fr.eligible) return ''
  const oid = order.id
  const req = fr.request
  const eff = req && req.status
  const head = `<div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:4px">💸 ${t('违约关单退款(直付)')}</div>
    <div style="font-size:12px;color:#4b5563;line-height:1.7;margin-bottom:8px">${t('本单因卖家违约被系统关闭。直付非托管:平台不持货款、不能代退,退款由卖家在协议外完成,双方在此握手留档;卖家不配合可举证仲裁(信誉裁决)。')}</div>`
  let body = ''
  if (fr.claim) {
    const ruled = fr.claim.status === 'resolved'
    body = ruled
      ? `<div style="font-size:12px;color:#374151">⚖️ ${t('退款申索已裁定')}:${fr.claim.ruling_type === 'refund_failed_confirmed' ? t('买家申索成立(卖家未退款,信誉已追加处罚)') : t('卖家退款成立(申索不成立)')}</div>`
      : `<div style="font-size:12px;color:#6b7280">⚖️ ${t('退款申索仲裁进行中(信誉裁决),可在争议页补充证据。')}</div>`
  } else if (isBuyer && fr.can_confirm) {
    body = `<div style="font-size:12px;color:#374151;margin-bottom:8px">💸 ${t('卖家已声明退款')}${req && req.refund_reference ? '「' + escHtml(req.refund_reference) + '」' : ''}。${t('请先核实退款已到账;未收到请勿确认,可举证升级仲裁。')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" style="width:auto" onclick="dpFrConfirm('${oid}')">${t('已收到退款,确认留档(需 Passkey)')}</button>
        <button class="btn btn-outline btn-sm" style="width:auto" onclick="dpFrEscalate('${oid}')">${t('未收到,举证仲裁')}</button>
      </div>`
  } else if (isBuyer && eff === 'requested') {
    body = `<div style="font-size:12px;color:#6b7280;margin-bottom:8px">⏳ ${t('已向卖家发出退款请求,等待响应(超期可举证仲裁)。')}</div>
      <button class="btn btn-outline btn-sm" style="width:auto" onclick="dpFrWithdraw('${oid}')">${t('撤回请求')}</button>`
  } else if (isBuyer && (eff === 'declined' || eff === 'expired') && fr.can_escalate) {
    const hint = eff === 'declined' ? t('卖家拒绝了退款请求。') : t('卖家未在期限内响应。')
    body = `<div style="font-size:12px;color:#b91c1c;margin-bottom:6px">${hint}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" style="width:auto" onclick="dpFrEscalate('${oid}')">${t('举证升级仲裁')}</button>
        ${fr.can_request ? `<button class="btn btn-outline btn-sm" style="width:auto" onclick="dpFrRequest('${oid}')">${t('再次申请')}</button>` : ''}
      </div>`
  } else if (isBuyer && fr.can_request) {
    body = `<textarea id="dp-fr-reason-${oid}" class="form-control" rows="2" placeholder="${t('说明(可选,卖家可见):付款方式/时间/金额')}" style="margin-bottom:8px;font-size:12px"></textarea>
      <button class="btn btn-primary btn-sm" style="width:auto" onclick="dpFrRequest('${oid}')">${t('申请场外退款')}</button>`
  } else if (isBuyer && eff === 'settled') {
    body = `<div style="font-size:12px;color:#166534">✅ ${t('退款握手已闭环:你已确认收到卖家场外退款(已留档)。')}</div>`
  } else if (isSeller && fr.can_respond) {
    body = `<div style="font-size:12px;color:#374151;margin-bottom:8px">📩 ${t('买家申请违约关单退款。')}${req && req.reason ? '「' + escHtml(req.reason) + '」' : ''} ${t('已退款:附参考并点"我已退款";未退款:请尽快在协议外退款。持续不响应买家可举证仲裁,将追加信誉处罚。')}</div>
      <input id="dp-fr-ref-${oid}" class="form-control" maxlength="200" placeholder="${t('退款参考(转账单号等,可选,买家可见)')}" style="margin-bottom:8px;font-size:12px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" style="width:auto" onclick="dpFrMarkRefunded('${oid}')">${t('我已退款')}</button>
        <button class="btn btn-outline btn-sm" style="width:auto" onclick="dpFrDecline('${oid}')">${t('拒绝')}</button>
      </div>`
  } else if (isSeller && eff === 'refund_marked') {
    body = `<div style="font-size:12px;color:#6b7280">⏳ ${t('你已声明退款,等待买家确认收到留档。')}</div>`
  } else if (isSeller && eff === 'settled') {
    body = `<div style="font-size:12px;color:#166534">✅ ${t('买家已确认收到退款,握手闭环留档。')}</div>`
  } else return ''
  return `<div class="card" style="border:1px solid #fde68a;background:linear-gradient(135deg,#fffbeb,#fef3c7)">${head}${body}</div>`
}

const dpFrToast = (m, kind) => { if (typeof toast$ === 'function') toast$(m, kind) }
const dpFrReload = (oid) => renderOrderDetail(document.getElementById('app'), oid)

window.dpFrRequest = async (oid) => {
  const el = document.getElementById('dp-fr-reason-' + oid)
  const r = await POST('/orders/' + oid + '/fault-refund/request', { reason: (el && el.value || '').trim() })
  if (r.error) return void dpFrToast(r.error, 'error')
  dpFrToast(t('已发出退款请求,等待卖家响应'), 'success'); dpFrReload(oid)
}
window.dpFrDecline = async (oid) => {
  const r = await POST('/orders/' + oid + '/fault-refund/decline', {})
  if (r.error) return void dpFrToast(r.error, 'error')
  dpFrReload(oid)
}
window.dpFrMarkRefunded = async (oid) => {
  if (typeof confirmModal === 'function' && !(await confirmModal(t('确认你已在协议外向买家完成退款?虚假声明将留痕并在仲裁中被追责。'), t('我已退款'), { danger: true }))) return
  const el = document.getElementById('dp-fr-ref-' + oid)
  const r = await POST('/orders/' + oid + '/fault-refund/mark-refunded', { refund_reference: (el && el.value || '').trim() })
  if (r.error) return void dpFrToast(r.error, 'error')
  dpFrToast(t('已声明退款,等待买家确认'), 'success'); dpFrReload(oid)
}
window.dpFrWithdraw = async (oid) => {
  const r = await POST('/orders/' + oid + '/fault-refund/withdraw', {})
  if (r.error) return void dpFrToast(r.error, 'error')
  dpFrReload(oid)
}
window.dpFrConfirm = async (oid) => {
  if (typeof confirmModal === 'function' && !(await confirmModal(t('确认已收到卖家场外退款?确认后握手闭环留档,不可撤销。'), t('已收到退款'), { danger: true }))) return
  let token
  try { token = await requestPasskeyGate('direct_pay_order_action', { order_id: oid, action: 'fault_refund_confirm' }) }
  catch (e) { if (window.dpPromptRegisterPasskey) await window.dpPromptRegisterPasskey(e); return }
  const r = await POST('/orders/' + oid + '/fault-refund/confirm', { webauthn_token: token })
  if (r.error) return void dpFrToast(window.dpErrorText ? window.dpErrorText(r.error_code, r.error) : r.error, 'error')
  dpFrToast(t('已确认收到退款,握手闭环'), 'success'); dpFrReload(oid)
}
window.dpFrEscalate = async (oid) => {
  const notes = typeof promptModal === 'function' ? await promptModal(t('请说明情况(≥10 字):付款方式/时间/金额,以及卖家未退款的经过。提交后进入仲裁(信誉裁决),可在争议页补充凭证。')) : window.prompt(t('请说明情况(≥10 字):付款方式/时间/金额,以及卖家未退款的经过。'))
  if (!notes) return
  const r = await POST('/orders/' + oid + '/fault-refund/escalate', { notes: String(notes).trim() })
  if (r.error) return void dpFrToast(r.error, 'error')
  dpFrToast(t('退款申索已提交仲裁'), 'success'); dpFrReload(oid)
}

// ── 统一仲裁台:fault_refund_claim 两选裁决表单(app.js 裁决区按 dispute_type 分流到此;复用 handleArbitrate,
//    后端 arbitrate 路由分流到唯一 resolver:信誉裁决,零资金零订单转移)──
window.frcRulingForm = function (dispute) {
  var radio = function (val, label) {
    return '<label style="display:flex;align-items:flex-start;gap:8px;padding:8px;border:1px solid #fde68a;border-radius:6px;cursor:pointer;font-size:13px"><input type="radio" name="arb-ruling-radio" value="' + val + '" style="margin-top:2px"> <span>' + label + '</span></label>'
  }
  return '' +
    '<div style="margin-top:12px;border:1px solid #fde68a;background:#fffbeb;border-radius:8px;padding:12px">' +
      '<div style="font-weight:600;font-size:13px;color:#92400e;margin-bottom:8px">⚖ ' + t('退款申索仲裁裁决(信誉裁决,不涉资金)') + '</div>' +
      '<div id="arbitrate-msg"></div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px">' +
        radio('refund_failed_confirmed', t('买家申索成立 —— 卖家未场外退款,追加信誉处罚')) +
        radio('refund_confirmed', t('卖家退款成立 —— 申索不成立,发起方按争议败诉记录')) +
      '</div>' +
      '<textarea class="form-control" id="arb-reason" rows="3" placeholder="' + t('裁定理由(必填)') + '" style="width:100%;margin-bottom:8px"></textarea>' +
      '<button class="btn btn-primary btn-sm" style="width:auto" onclick="handleArbitrate(\'' + dispute.id + '\')">' + t('确认裁定') + '</button>' +
    '</div>'
}
// 裁定结果 chip 标签:装饰 dpRulingLabel(frc 案必为 direct_p2p,通用 chip 走 dpRulingLabel 分支)
;(function () {
  var prev = window.dpRulingLabel
  window.dpRulingLabel = function (ruling) {
    if (ruling === 'refund_failed_confirmed') return t('买家申索成立(卖家未退款)')
    if (ruling === 'refund_confirmed') return t('卖家退款成立(申索不成立)')
    return prev ? prev(ruling) : null
  }
})()

// ── 通知 i18n 模板(域内聚注册;服务端落库 template_key+params,此处按 viewer locale 渲染)──
;(function () {
  const S = window._notifSub
  const P = (emoji, titleZh, bodyZh) => (p) => ({ title: emoji + ' ' + t(titleZh), body: S(t(bodyZh), p) })
  Object.assign(window.NOTIF_TEMPLATES, {
    frc_requested: P('💸', '买家申请违约关单退款', '订单「{product}」因你违约被系统关闭,买家已场外付款并申请退款。已退款请点"我已退款"并附参考;未退款请尽快场外退款。持续不响应买家可举证仲裁,将追加信誉处罚。'),
    frc_declined: P('❌', '卖家拒绝了退款握手', '订单「{product}」:卖家拒绝了退款握手请求。你可以举证升级仲裁(提供付款凭证,信誉裁决)。'),
    frc_marked: P('💸', '卖家已声明退款', '订单「{product}」:卖家声明已在协议外向你退款。请核实到账后确认(需 Passkey);未收到请勿确认,可举证升级仲裁。'),
    frc_settled: P('✅', '退款握手完成', '订单「{product}」:场外退款握手已闭环留档(非托管,零资金操作)。'),
    frc_withdrawn: P('↩️', '买家撤回了退款握手请求', '订单「{product}」的退款握手请求已被买家撤回。'),
    frc_escalated: P('⚖️', '退款申索已进入仲裁', '订单「{product}」的退款申索已进入统一仲裁台(信誉裁决,非托管不涉资金)。当事方可在争议页提交/补充凭证。'),
    frc_ruled_refund_failed: P('⚖️', '退款申索裁定:买家申索成立', '订单「{product}」退款申索已裁定:卖家未场外退款成立。卖家信誉已追加处罚并留公开违约记录(非托管:协议不代退,退款仍须双方场外完成)。'),
    frc_ruled_refund_confirmed: P('⚖️', '退款申索裁定:卖家退款成立', '订单「{product}」退款申索已裁定:卖家已退款成立,申索不成立(发起方信誉按争议败诉记录)。'),
  })
})()
