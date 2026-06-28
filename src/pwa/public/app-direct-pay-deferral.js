// Direct Pay (Rail 1) — SELLER 缓交(deferred base-bond)apply + status panel (PR-②b)。UI ONLY。
//   缓交 = 先入场、履约保证金延后交,由管理员【人工审批】(绝不自动批)。本面板让卖家:① 申请缓交;② 查看自己申请状态。
//   数据/动作:GET + POST /api/direct-receive/deferral(后端脱敏:不含 admin 身份)。申请只创建 pending,【不授予任何资格】;
//   真正放行 = 管理员 ROOT + 真人 Passkey 审批。即便批准,直付仍需满足全部合规门(实名/制裁/AML/Passkey/收款说明)。
//   不碰 wallet/escrow/settlement/refund/钱路;不开真实 rail;不声称已上线。买家侧不展示本面板。

window.dpDeferralCopy = () => ({
  pending:  { icon: '⏳', text: t('缓交申请审核中,等待管理员人工审批') },
  granted:  { icon: '✅', text: t('缓交已批准') },
  rejected: { icon: '🚫', text: t('缓交申请未通过') },
  expired:  { icon: '⌛', text: t('缓交已到期') },
})

window.dpSellerDeferralSection = () => `
  <div class="card" style="margin-bottom:12px;border:1px solid #e5e7eb">
    <div style="font-size:14px;font-weight:700;margin-bottom:4px">🪙 ${t('履约保证金缓交(仅你可见)')}</div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('缓交 = 先入场、履约保证金延后交,由管理员人工审批。批准后直付仍需满足全部合规条件(身份与商户合规审核、Passkey、收款说明);缓交期内额度会被压低。')}</div>
    <div id="dp-seller-deferral">${loading$()}</div>
  </div>`

// 申请表单(无活跃申请时显示)。period 选填(留空走后端默认 30);reason 选填。
window.dpDeferralApplyForm = () => `
  <div style="display:flex;flex-direction:column;gap:8px">
    <textarea id="dp-dfr-reason" maxlength="500" placeholder="${t('申请原因(选填)')}" style="width:100%;min-height:56px;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px"></textarea>
    <input id="dp-dfr-days" type="number" min="1" placeholder="${t('缓交天数(选填,默认 30)')}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">
    <button onclick="window.dpSubmitDeferral()" style="align-self:flex-start;padding:8px 16px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">${t('提交缓交申请')}</button>
  </div>`

window.dpHydrateSellerDeferral = async () => {
  const box = document.getElementById('dp-seller-deferral')
  if (!box) return
  const r = await GET('/direct-receive/deferral')
  if (!r || r.error) { box.innerHTML = `<div style="font-size:12px;color:#dc2626">${window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试')}</div>`; return }
  const d = r.deferral, active = r.active
  // 无申请,或上一条已拒绝/过期(且当前无生效缓交)→ 可(重新)申请。
  if (!d || (!active && (d.status === 'rejected' || d.status === 'expired'))) {
    const prior = d ? `<div style="font-size:12px;color:#6b7280;margin-bottom:8px">${window.dpDeferralCopy()[d.status].icon} ${escHtml(window.dpDeferralCopy()[d.status].text)} · ${t('可重新申请')}</div>` : ''
    box.innerHTML = prior + window.dpDeferralApplyForm()
    return
  }
  const meta = window.dpDeferralCopy()[d.status] || { icon: 'ℹ️', text: d.status }
  const lines = [`<div style="font-size:13px;font-weight:600;color:#374151">${meta.icon} ${escHtml(meta.text)}</div>`]
  if (active) {
    lines.push(`<div style="font-size:12px;color:#6b7280;line-height:1.7">${t('缓交期额度系数')}: <b>${active.reduced_quota_factor}</b></div>`)
    if (active.expires_at) lines.push(`<div style="font-size:12px;color:#6b7280">${t('保证金到期日')}: ${escHtml(active.expires_at)}</div>`)
    if (active.grace_until) lines.push(`<div style="font-size:12px;color:#6b7280">${t('宽限至')}: ${escHtml(active.grace_until)}</div>`)
    if (active.in_grace) lines.push(`<div style="font-size:12px;color:#dc2626;font-weight:600">⚠️ ${t('已进入宽限期,请尽快补交履约保证金,否则直付资格将被暂停')}</div>`)
  }
  box.innerHTML = `<div style="display:flex;flex-direction:column;gap:4px">${lines.join('')}</div>`
}

window.dpSubmitDeferral = async () => {
  const reasonEl = document.getElementById('dp-dfr-reason'), daysEl = document.getElementById('dp-dfr-days')
  const body = {}
  if (reasonEl && reasonEl.value.trim()) body.reason = reasonEl.value.trim()
  if (daysEl && daysEl.value) body.period_days = Number(daysEl.value)
  const r = await POST('/direct-receive/deferral', body)
  if (!r || r.error) { alert(window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试')); return }
  toast$(t('缓交申请已提交,等待管理员审批'))
  window.dpHydrateSellerDeferral()
}
