// 商家履约保证金 UI(B1 缴纳闭环)。UI ONLY —— 双锁/凭据/幂等全在后端。
//   ① 通知模板(申报/确认/驳回);② 卖家 settings 状态卡(要求额度/状态/缓交/申报表单——通道未放行时隐藏表单,诚实提示);
//   ③ admin 保证金申报队列页(#admin/bond-deposits:核对到账→确认[ROOT+Passkey,当前被 Lock B 挡属预期]/驳回)。
;(function () {
  const S = window._notifSub
  const P = (emoji, titleZh, bodyZh) => (p) => ({ title: emoji + ' ' + t(titleZh), body: S(t(bodyZh), p) })
  Object.assign(window.NOTIF_TEMPLATES, {
    bond_deposit_submitted: P('🏦', '新保证金缴纳申报待核实', '卖家 {seller} 申报已缴纳履约保证金(T0,凭据 {evidence})。请核对真实到账后在 admin 后台确认(ROOT+Passkey)。'),
    bond_deposit_confirmed: P('✅', '履约保证金已确认锁定', '你的保证金已核实到账并正式锁定,直付入场的保证金门已满足。退出时可申请退还(须无未了结直付责任)。'),
    bond_deposit_rejected: P('❌', '保证金申报未通过核实', '你的保证金缴纳申报未通过核实{note}。请核对付款凭据后重新提交,或联系平台。'),
  })

  const ST = () => ({ pending: t('待运营核实'), confirmed: t('已核实待锁定'), locked: t('已锁定生效'), insufficient: t('金额不足待补缴'), expired: t('已失效/被驳回'), refunding: t('退还中'), refunded: t('已退还'), slashed: t('已被罚没') })

  // ② 卖家 settings 状态卡(settings 链尾注入 + hydrate)
  window.bondSellerSection = () => `
    <div class="card" id="bond-card">
      <div style="font-size:14px;font-weight:700;margin-bottom:6px">🏦 ${t('直付履约保证金')}</div>
      <div id="bond-body" style="font-size:12px;color:#6b7280">${loading$()}</div>
    </div>`
  window.bondHydrateSeller = async () => {
    const box = document.getElementById('bond-body'); if (!box) return
    const s = await GET('/direct-receive/bond-status').catch(() => null)
    if (!s) { box.textContent = t('加载失败,请刷新'); return }
    const d = s.deposit
    const statusLine = d
      ? `<div style="margin-bottom:6px">${t('当前状态')}:<strong>${ST()[d.status] || d.status}</strong>${d.status === 'pending' ? ` · ${t('凭据')} ${escHtml(d.evidence_ref || '-')}` : ''}${d.reject_note ? `<br><span style="color:#dc2626">${t('驳回说明')}:${escHtml(d.reject_note)}</span>` : ''}</div>`
      : `<div style="margin-bottom:6px">${t('当前状态')}:<strong>${t('未缴纳')}</strong></div>`
    const deferralLine = s.deferral
      ? `<div style="margin-bottom:6px;color:#92400e">🕓 ${t('缓交生效中')}${s.deferral.expires_at ? ` · ${t('到期')} ${fmtTime(s.deferral.expires_at)}` : ''}(${t('额度受限;缴清保证金后转正式')})</div>` : ''
    const payBlock = s.rail_cleared
      ? `<div style="margin:8px 0;padding:8px;background:#f9fafb;border-radius:8px">
          <div style="font-weight:600;margin-bottom:4px">${t('缴纳方式')}(${t('转账后提交凭据申报')}):</div>
          ${(s.payment_accounts || []).map(a => `<div style="margin-bottom:4px">· ${escHtml(a.method || '')} ${escHtml(a.currency || '')}:${escHtml(a.instruction || '')}</div>`).join('') || t('暂无收款方式,请联系平台')}
        </div>
        ${(!d || ['expired', 'refunded'].includes(d.status)) ? `
        <input class="form-control" id="bond-evidence" maxlength="120" placeholder="${t('付款凭据号(转账单号/链上 tx,必填)')}" style="margin-bottom:8px;font-size:12px">
        <button class="btn btn-primary btn-sm" style="width:auto" onclick="bondSubmitDeposit()">${t('提交缴纳申报')}</button>` : ''}
        ${d && d.status === 'pending' ? `<button class="btn btn-outline btn-sm" style="width:auto" onclick="bondCancelDeposit('${d.id}')">${t('撤回申报')}</button>` : ''}`
      : `<div style="margin:8px 0;padding:8px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;color:#92400e">${escHtml(s.note || '')}</div>`
    box.innerHTML = `
      <div style="margin-bottom:6px">${t('要求额度')}:<strong>${s.required.display} ${s.required.currency}</strong>(${s.required.tier})</div>
      ${statusLine}${deferralLine}${payBlock}${window.bondRefundBlock ? window.bondRefundBlock(s) : ''}${window.bondSlashNotice ? window.bondSlashNotice(s) : ''}
      <div id="bond-msg" style="margin-top:6px;font-size:11px"></div>`
  }
  window.bondSubmitDeposit = async () => {
    const msg = document.getElementById('bond-msg')
    const evidence = (document.getElementById('bond-evidence')?.value || '').trim()
    if (!evidence) { msg.innerHTML = `<span style="color:#dc2626">${t('付款凭据号必填')}</span>`; return }
    const r = await POST('/direct-receive/bond-deposit', { evidence_ref: evidence })
    if (r.error) { msg.innerHTML = `<span style="color:#dc2626">${r.error}</span>`; return }
    toast$(t('申报已提交,等待运营核实'), 'success'); window.bondHydrateSeller()
  }
  window.bondCancelDeposit = async (id) => {
    if (typeof confirmModal === 'function' && !(await confirmModal(t('确认撤回保证金缴纳申报?'), t('撤回申报'), { danger: true }))) return
    const r = await POST(`/direct-receive/bond-deposit/${id}/cancel`, {})
    if (r.error) return void toast$(r.error, 'error')
    window.bondHydrateSeller()
  }

  // ③ admin 申报队列页(#admin/bond-deposits;确认走既有 confirm-production 端点 —— Lock B 未放行前 409 属预期,页面明示)
  window.renderAdminBondDeposits = function (app) {
    if (!state.user) { renderLogin(); return }
    if (typeof isAdmin === 'function' && !isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
    if ((state.user.admin_type || 'root') !== 'root') { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限根管理员')}</div>`, 'admin'); return }
    app.innerHTML = shell(`
      <h1 class="page-title">🏦 ${t('保证金缴纳申报')}</h1>
      <div style="margin-bottom:8px"><button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#admin/dp-ops')">${t('返回 Direct Pay 商户运营')}</button></div>
      <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('卖家的履约保证金缴纳申报。请【核对凭据对应的真实到账】后确认(ROOT+Passkey,双锁:生产放行 registry 未开时确认会被拒,属预期 fail-closed);核不上则驳回(留说明)。')}</div>
      <div id="bond-adm-box">${loading$()}</div>
    `, 'admin')
    window.bondAdmHydrate()
  }
  window.bondAdmHydrate = async (status) => {
    const box = document.getElementById('bond-adm-box'); if (!box) return
    const r = await GET(`/admin/direct-receive/deposits${status ? `?status=${status}` : ''}`).catch(() => null)
    if (!r || !Array.isArray(r.deposits)) { box.textContent = t('加载失败,请刷新'); return }
    if (r.deposits.length === 0) { box.innerHTML = `<div class="alert alert-info">${t('暂无申报')}</div>`; return }
    box.innerHTML = r.deposits.map(d => `
      <div class="card" style="font-size:12px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div><strong>${escHtml(d.seller_name || d.user_id)}</strong> ${d.seller_handle ? '@' + escHtml(d.seller_handle) : ''} · ${d.tier} · ${t('要求')} ${d.required_amount} ${String(d.currency).toUpperCase()}</div>
          <div><strong>${ST()[d.status] || d.status}</strong></div>
        </div>
        <div style="color:#6b7280;margin-top:4px">${t('申报单')} ${d.id} · ${t('凭据')}:${escHtml(d.external_ref || '-')} · ${fmtTime(d.created_at)}${d.reject_note ? ` · <span style="color:#dc2626">${escHtml(d.reject_note)}</span>` : ''}</div>${window.bondAdmRefundActions ? window.bondAdmRefundActions(d) : ''}
        ${d.status === 'pending' ? `
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" style="width:auto;font-size:11px" onclick="bondAdmConfirm('${d.id}', ${Math.round(Number(d.required_amount) * 1e6)}, '${escHtml(d.external_ref || '')}')">${t('已核实到账,确认锁定(Passkey)')}</button>
          <button class="btn btn-outline btn-sm" style="width:auto;font-size:11px;color:#dc2626;border-color:#fecaca" onclick="bondAdmReject('${d.id}')">${t('核不上,驳回')}</button>
        </div>` : ''}
      </div>`).join('')
  }
  window.bondAdmConfirm = async (id, amountUnits, receiptRef) => {
    const jurisdiction = prompt(t('法域代码(须在放行白名单内,如 SG)'), 'SG'); if (!jurisdiction) return
    let token
    try { token = await requestPasskeyGate('direct_receive_production_confirm', { deposit_id: id, rail_id: 'operator_attested', amount_units: amountUnits, receipt_ref: receiptRef, jurisdiction }) }
    catch (e) { if (window.dpPromptRegisterPasskey) await window.dpPromptRegisterPasskey(e); return }
    const r = await POST(`/admin/direct-receive/deposits/${id}/confirm-production`, { rail_id: 'operator_attested', expected_amount_units: amountUnits, receipt_ref: receiptRef, jurisdiction, webauthn_token: token })
    if (r.error) return void toast$(r.error_code === 'PRODUCTION_RAIL_NOT_CLEARED' ? t('生产放行 registry 未开(法务清门后翻转)—— 确认被拒属预期 fail-closed') : r.error, 'error')
    toast$(t('已确认锁定,卖家保证金门已满足'), 'success'); window.bondAdmHydrate()
  }
  window.bondAdmReject = async (id) => {
    const note = prompt(t('驳回说明(卖家可见,可空)'), '') ?? ''
    const r = await POST(`/admin/direct-receive/deposits/${id}/reject`, { note })
    if (r.error) return void toast$(r.error, 'error')
    toast$(t('已驳回'), 'success'); window.bondAdmHydrate()
  }
})()
