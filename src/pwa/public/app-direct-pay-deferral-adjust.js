// Direct Pay (Rail 1) — ADMIN 已批准缓交的【配额系数调整】(补齐"批后无调额入口"运营缺口)。UI ONLY。
//   列 granted 缓交 + 内联调额;调整是 RISK 动作 → 真人 Passkey(purpose direct_pay_deferral_adjust,
//   purpose_data 绑 deferral_id + reduced_quota_factor 逐字一致)。只调既有受门控端点
//   POST /api/admin/direct-receive/deferrals/:id/adjust-quota;不碰 wallet/escrow/settlement/refund。
window.dpGrantedDeferralsSection = function (grantedRows) {
  const cards = (grantedRows && grantedRows.length) ? grantedRows.map(d => `
    <div class="card" style="margin-bottom:10px">
      <div style="font-size:11px;color:#9ca3af">${escHtml(d.user_id)}</div>
      <div style="font-size:12px;margin-top:6px">${t('额度系数')}: <strong>${d.reduced_quota_factor}</strong> · ${t('缓交到期')}: ${d.expires_at ? fmtTime(d.expires_at) : '-'} · ${t('宽限至')}: ${d.grace_until ? fmtTime(d.grace_until) : '-'}</div>
      <div style="margin-top:8px"><button class="btn btn-outline btn-sm" style="font-size:12px" onclick="toggleInline('dfr-adjust-${d.id}')">⚙ ${t('调整配额系数')}</button></div>
      <div id="dfr-adjust-${d.id}" style="display:none;margin-top:10px;padding:10px;background:#eff6ff;border:1px solid #93c5fd;border-radius:6px">
        <div style="font-size:12px;font-weight:600;color:#1e40af;margin-bottom:6px">⚙ ${t('调整缓交配额系数(需真人 Passkey)')}</div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:6px">${t('缓交期内必压低、有上下限;只改系数,不动到期/宽限')}</div>
        <input id="dfr-adjust-factor-${d.id}" type="number" min="0" max="1" step="0.05" placeholder="${t('新额度系数(如 0.9)')}" style="width:100%;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;margin-bottom:6px">
        <div style="display:flex;gap:6px">
          <button class="btn btn-outline btn-sm" style="font-size:11px" onclick="toggleInline('dfr-adjust-${d.id}')">${t('取消')}</button>
          <button class="btn btn-primary btn-sm" style="font-size:11px" onclick="doAdjustDeferralQuotaInline('${d.id}')">${t('真人确认调整')}</button>
        </div>
      </div>
    </div>`).join('') : `<div class="empty" style="padding:16px"><div class="empty-text" style="font-size:12px">${t('暂无已批准的缓交')}</div></div>`
  return `<div style="font-size:13px;font-weight:600;margin:18px 0 8px">${t('已批准(可调整配额系数)')}</div>${cards}`
}

// 调整已 granted 缓交的配额系数:purpose_data 绑 deferral_id + reduced_quota_factor(逐字一致)。
window.doAdjustDeferralQuotaInline = async function (id) {
  const fEl = document.getElementById('dfr-adjust-factor-' + id)
  if (!fEl || fEl.value === '') { if (typeof toast$ === 'function') toast$(t('请填写新额度系数'), 'error'); return }
  const body = { deferral_id: id, reduced_quota_factor: Number(fEl.value) }
  const token = await requestPasskeyGate('direct_pay_deferral_adjust', body)
  if (!token) { if (typeof toast$ === 'function') toast$(t('需要真人 Passkey 确认'), 'error'); return }
  const r = await POST(`/admin/direct-receive/deferrals/${id}/adjust-quota`, { ...body, webauthn_token: token })
  if (!r || r.error) { if (typeof toast$ === 'function') toast$(window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试'), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('配额系数已调整'))
  window.renderAdminDirectPayDeferrals(document.getElementById('app'))
}
