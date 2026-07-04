// 保证金退出退还 UI(B2)。UI ONLY —— blockers/冷静期/凭据/复核全在后端。
//   经 app-bond-ui.js 的两个 hook 注入:卖家卡尾 bondRefundBlock(s) / admin 行尾 bondAdmRefundActions(d)。
;(function () {
  const S = window._notifSub
  const P = (emoji, titleZh, bodyZh) => (p) => ({ title: emoji + ' ' + t(titleZh), body: S(t(bodyZh), p) })
  Object.assign(window.NOTIF_TEMPLATES, {
    bond_refund_requested: P('↩️', '保证金退出申请待处理', '卖家 {seller} 申请退还履约保证金(冷静期 {days} 天,期间其直付资格已暂停)。冷静期满且复核无未了结责任后,场外退还并在 admin 后台记录执行。'),
    bond_refund_executed: P('✅', '履约保证金已退还', '你的保证金已在协议外退还并记录(凭据:{evidence})。直付资格随保证金退出关闭;重新缴纳后可再次开通。'),
  })
  const BLOCKER_LABEL = () => ({
    OPEN_DIRECT_PAY_ORDERS: t('有在途直付订单'), OPEN_CANCEL_REFUND_HANDSHAKE: t('取消退款握手进行中'),
    OPEN_RETURN_FLOW: t('退货/售后流进行中'), UNPAID_PLATFORM_FEES: t('平台服务费欠费未结清'),
  })

  // 卖家卡尾:locked → 申请退出(或 blockers 列表);refunding → 冷静期说明 + 撤销
  window.bondRefundBlock = (s) => {
    const d = s.deposit
    if (!d) return ''
    if (d.status === 'locked' && s.refund) {
      if (s.refund.can_request) {
        return `<div style="margin-top:8px;border-top:1px dashed #e5e7eb;padding-top:8px">
          <button class="btn btn-outline btn-sm" style="width:auto;font-size:11px" onclick="bondRefundRequest()">↩️ ${t('申请退出并退还保证金')}</button>
          <div style="font-size:11px;color:#9ca3af;margin-top:4px">${t('申请后进入')} ${s.refund.cooling_days} ${t('天冷静期,期间直付资格暂停;可随时撤销。')}</div></div>`
      }
      const L = BLOCKER_LABEL()
      return `<div style="margin-top:8px;border-top:1px dashed #e5e7eb;padding-top:8px;font-size:11px;color:#92400e">
        ${t('暂不能申请退还 —— 有未了结的直付责任')}:${(s.refund.blockers || []).map(b => `${L[b.code] || b.code}${b.count ? `(${b.count})` : ''}`).join('、')}</div>`
    }
    if (d.status === 'refunding') {
      return `<div style="margin-top:8px;border-top:1px dashed #e5e7eb;padding-top:8px;font-size:12px;color:#92400e">
        ⏳ ${t('退出申请处理中')}:${t('冷静期')} ${s.refund ? s.refund.cooling_days : 14} ${t('天')}(${t('自申请时起')});${t('期间直付资格暂停。冷静期满、复核无未了结责任后平台场外退还并记录。')}
        <div style="margin-top:6px"><button class="btn btn-outline btn-sm" style="width:auto;font-size:11px" onclick="bondRefundCancel()">${t('撤销退出申请(恢复资格)')}</button></div></div>`
    }
    if (d.status === 'refunded') {
      return `<div style="margin-top:8px;font-size:12px;color:#16a34a">✅ ${t('保证金已退还')}${d.refund_evidence_ref ? `(${t('凭据')} ${escHtml(d.refund_evidence_ref)})` : ''};${t('直付资格已关闭,重新缴纳后可再次开通。')}</div>`
    }
    return ''
  }
  window.bondRefundRequest = async () => {
    if (typeof confirmModal === 'function' && !(await confirmModal(t('确认申请退出并退还保证金?冷静期内你的直付资格将暂停(不可接新直付单),可随时撤销。'), t('申请退出'), { danger: true }))) return
    const r = await POST('/direct-receive/bond-refund-request', {})
    if (r.error) { toast$(r.error_code === 'REFUND_BLOCKED' ? t('有未了结的直付责任,暂不能申请退还') : r.error, 'error'); window.bondHydrateSeller(); return }
    toast$(t('退出申请已提交,进入冷静期'), 'success'); window.bondHydrateSeller()
  }
  window.bondRefundCancel = async () => {
    const r = await POST('/direct-receive/bond-refund-request/cancel', {})
    if (r.error) return void toast$(r.error, 'error')
    toast$(t('已撤销,直付资格已恢复'), 'success'); window.bondHydrateSeller()
  }

  // admin 行尾:refunding 行给"记录场外退还"按钮(Passkey;冷静期未满/复核有责任会被后端拒,明示)
  window.bondAdmRefundActions = (d) => {
    if (d.status !== 'refunding') return ''
    return `<div style="margin-top:8px"><button class="btn btn-primary btn-sm" style="width:auto;font-size:11px" onclick="bondAdmExecuteRefund('${d.id}')">↩️ ${t('已场外退还,记录执行(Passkey)')}</button>
      <span style="font-size:11px;color:#9ca3af;margin-left:6px">${t('冷静期未满或复核有未了结责任会被拒,属预期')}</span></div>`
  }
  window.bondAdmExecuteRefund = async (id) => {
    const evidence = prompt(t('场外退还凭据(转账单号/链上 tx,必填)'), ''); if (!evidence || !evidence.trim()) return
    let token
    try { token = await requestPasskeyGate('direct_receive_bond_refund', { deposit_id: id, evidence_ref: evidence.trim() }) }
    catch (e) { if (window.dpPromptRegisterPasskey) await window.dpPromptRegisterPasskey(e); return }
    const r = await POST(`/admin/direct-receive/deposits/${id}/execute-refund`, { evidence_ref: evidence.trim(), webauthn_token: token })
    if (r.error) return void toast$(r.error, 'error')
    toast$(t('退还已记录,卖家已通知'), 'success'); window.bondAdmHydrate()
  }
})()
