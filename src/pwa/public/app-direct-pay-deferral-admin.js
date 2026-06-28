// Direct Pay (Rail 1) — ADMIN 缓交(deferred base-bond)审批队列 (PR-②c)。UI ONLY。
//   ROOT admin 审批商户的缓交申请:列出 pending,批准(设压低额度系数 + 宽限天数)或拒绝。
//   铁律:批准/拒绝是 RISK 动作 → 必须真人 Passkey(requestPasskeyGate),purpose_data 绑定【完整条款】
//   (deferral_id + reduced_quota_factor + grace_days),与请求体逐字一致;agent 无 Passkey 凭证会被后端硬拒。
//   纯前端:只调既有受门控端点 GET/POST /api/admin/direct-receive/deferrals[/:id/approve|reject];
//   不碰 wallet/escrow/settlement/refund;授予绝不自动(approveDeferral 是唯一 writer,后端 ROOT+Passkey 强制)。

window.renderAdminDirectPayDeferrals = async function (app) {
  if (!state.user) { renderLogin(); return }
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(loading$(), 'admin')
  const data = await GET('/admin/direct-receive/deferrals?status=pending')
  if (!data || data.error) { app.innerHTML = shell(alert$('error', (data && data.error) || t('加载失败')), 'admin'); return }
  const rows = (data.deferrals || [])
  const list = rows.length ? rows.map(d => `
    <div class="card" style="margin-bottom:10px">
      <div style="font-size:11px;color:#9ca3af">${escHtml(d.user_id)} · ${fmtTime(d.created_at)}</div>
      <div style="font-size:13px;margin-top:6px">${t('缓交期(天)')}: <strong>${d.period_days}</strong></div>
      ${d.reason ? `<div style="font-size:12px;color:#6b7280;margin-top:6px;padding:6px;background:#f9fafb;border-radius:4px">${escHtml(d.reason)}</div>` : ''}
      <div style="display:flex;gap:6px;margin-top:10px">
        <button class="btn btn-primary btn-sm" style="font-size:12px" onclick="toggleInline('dfr-approve-${d.id}')">✓ ${t('批准')}</button>
        <button class="btn btn-outline btn-sm" style="font-size:12px;color:#dc2626;border-color:#dc2626" onclick="toggleInline('dfr-reject-${d.id}')">✗ ${t('拒绝')}</button>
      </div>
      <div id="dfr-approve-${d.id}" style="display:none;margin-top:10px;padding:10px;background:#f0fdf4;border:1px solid #86efac;border-radius:6px">
        <div style="font-size:12px;font-weight:600;color:#166534;margin-bottom:6px">✓ ${t('批准缓交(需真人 Passkey)')}</div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:6px">${t('缓交期额度系数(0–1,留空用默认;缓交期内必压低,有下限)')}</div>
        <input id="dfr-approve-factor-${d.id}" type="number" min="0" max="1" step="0.05" placeholder="${t('额度系数(如 0.5)')}" style="width:100%;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;margin-bottom:6px">
        <input id="dfr-approve-grace-${d.id}" type="number" min="0" placeholder="${t('宽限天数(留空用默认)')}" style="width:100%;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;margin-bottom:6px">
        <div style="display:flex;gap:6px">
          <button class="btn btn-outline btn-sm" style="font-size:11px" onclick="toggleInline('dfr-approve-${d.id}')">${t('取消')}</button>
          <button class="btn btn-primary btn-sm" style="font-size:11px" onclick="doApproveDeferralInline('${d.id}')">${t('真人确认批准')}</button>
        </div>
      </div>
      <div id="dfr-reject-${d.id}" style="display:none;margin-top:10px;padding:10px;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px">
        <div style="font-size:12px;font-weight:600;color:#991b1b;margin-bottom:6px">✗ ${t('拒绝缓交(需真人 Passkey)')}</div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-outline btn-sm" style="font-size:11px" onclick="toggleInline('dfr-reject-${d.id}')">${t('取消')}</button>
          <button class="btn btn-sm" style="font-size:11px;background:#dc2626;border-color:#dc2626;color:#fff" onclick="doRejectDeferralInline('${d.id}')">${t('真人确认拒绝')}</button>
        </div>
      </div>
    </div>`).join('') : `<div class="empty"><div class="empty-icon">📥</div><div class="empty-text">${t('暂无待审缓交申请')}</div></div>`
  app.innerHTML = shell(`
    <h1 class="page-title">🪙 ${t('履约保证金缓交审批')}</h1>
    <div style="margin-bottom:12px"><button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#admin')">${t('返回概览')}</button></div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('批准后该卖家可先入场直付、保证金延后交;直付仍需满足全部合规条件,且缓交期内额度被压低。批准/拒绝均需真人 Passkey。')}</div>
    ${list}
  `, 'admin')
}

// 批准:purpose_data 必须与请求体逐字一致(后端绑定 deferral_id + reduced_quota_factor + grace_days)。
window.doApproveDeferralInline = async function (id) {
  const fEl = document.getElementById('dfr-approve-factor-' + id), gEl = document.getElementById('dfr-approve-grace-' + id)
  const body = { deferral_id: id }
  if (fEl && fEl.value !== '') body.reduced_quota_factor = Number(fEl.value)
  if (gEl && gEl.value !== '') body.grace_days = Number(gEl.value)
  const token = await requestPasskeyGate('direct_pay_deferral_approve', body)
  if (!token) { if (typeof toast$ === 'function') toast$(t('需要真人 Passkey 确认'), 'error'); return }
  const r = await POST(`/admin/direct-receive/deferrals/${id}/approve`, { ...body, webauthn_token: token })
  if (!r || r.error) { if (typeof toast$ === 'function') toast$(window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试'), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('缓交已批准'))
  window.renderAdminDirectPayDeferrals(document.getElementById('app'))
}

// 拒绝:purpose_data 绑 deferral_id。
window.doRejectDeferralInline = async function (id) {
  const token = await requestPasskeyGate('direct_pay_deferral_reject', { deferral_id: id })
  if (!token) { if (typeof toast$ === 'function') toast$(t('需要真人 Passkey 确认'), 'error'); return }
  const r = await POST(`/admin/direct-receive/deferrals/${id}/reject`, { deferral_id: id, webauthn_token: token })
  if (!r || r.error) { if (typeof toast$ === 'function') toast$(window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试'), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('缓交申请已拒绝'))
  window.renderAdminDirectPayDeferrals(document.getElementById('app'))
}
