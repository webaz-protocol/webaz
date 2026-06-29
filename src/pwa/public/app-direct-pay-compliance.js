// Direct Pay (Rail 1) — ADMIN 商户合规录入 (PR-⑧)。UI ONLY。
//   录入【每个卖家】的 KYB 复核结论 + 制裁筛查结论(直付入场硬门:必须 KYB approved + sanctions clear)。
//   后端已有受门控端点(admin-direct-receive-deposits):POST /api/admin/direct-receive/kyb-reviews · /sanctions-screenings,
//   均 ROOT + 真人 Passkey(purpose direct_pay_kyb_ingress / direct_pay_sanctions_ingress;purpose_data 绑
//   user_id+status+provider_ref+expires_at,签 A 写 B 拒)。本屏只接线,不碰资金/状态机。
//   ⚠️ 仅【记录你已实际完成的尽调结论】——不代替真实 KYB/制裁筛查。

window.renderAdminDirectReceiveCompliance = async function (app) {
  if (!state.user) { renderLogin(); return }
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  const sel = (id, opts) => `<select id="${id}" style="width:100%;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">${opts.map(o => `<option value="${o[0]}">${o[1]}</option>`).join('')}</select>`
  const inp = (id, ph) => `<input id="${id}" placeholder="${ph}" style="width:100%;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">`
  app.innerHTML = shell(`
    <h1 class="page-title">🧾 ${t('商户合规录入')}</h1>
    <div style="margin-bottom:12px"><button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#admin')">${t('返回概览')}</button></div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('录入卖家的 KYB / 制裁筛查结论(直付入场硬门)。仅记录你【已实际完成】的尽调结论,不代替真实筛查;均需真人 Passkey。')}</div>
    <div class="card" style="margin-bottom:12px;border:1px solid #e5e7eb">
      <div style="font-size:13px;font-weight:700;margin-bottom:8px">${t('卖家用户 ID')}</div>
      ${inp('cmp-user', t('卖家用户 ID(seller user id)'))}
    </div>
    <div class="card" style="margin-bottom:12px;border:1px solid #e5e7eb">
      <div style="font-size:13px;font-weight:700;margin-bottom:8px">🪪 ${t('KYB 复核结论')}</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${sel('cmp-kyb-status', [['approved', t('通过 approved')], ['pending', t('待定 pending')], ['rejected', t('拒绝 rejected')]])}
        ${inp('cmp-kyb-ref', t('凭证号 / provider_ref(选填)'))}
        ${inp('cmp-kyb-exp', t('有效期 expires_at(选填,如 2027-01-01)'))}
        <button class="btn btn-primary btn-sm" style="align-self:flex-start;font-size:12px" onclick="window.doIngestKyb()">${t('记录 KYB(真人 Passkey)')}</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:12px;border:1px solid #e5e7eb">
      <div style="font-size:13px;font-weight:700;margin-bottom:8px">🛡️ ${t('制裁筛查结论')}</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${sel('cmp-sanc-status', [['clear', t('通过 clear')], ['pending', t('待定 pending')], ['flagged', t('命中 flagged')]])}
        ${inp('cmp-sanc-ref', t('凭证号 / provider_ref(选填)'))}
        ${inp('cmp-sanc-exp', t('有效期 expires_at(选填)'))}
        <button class="btn btn-primary btn-sm" style="align-self:flex-start;font-size:12px" onclick="window.doIngestSanctions()">${t('记录制裁筛查(真人 Passkey)')}</button>
      </div>
    </div>
    <div style="font-size:12px;color:#6b7280">${t('录入后用就绪报告核对:')} <code>npm run direct-pay:readiness</code></div>
  `, 'admin')
}

// 通用:取卖家 id + 组装 body(provider_ref/expires_at 仅在非空时带);purpose_data 必须与请求体逐字一致。
function _dpComplianceBody(statusId, refId, expId) {
  const get = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : '' }
  const user_id = get('cmp-user')
  if (!user_id) return null
  const body = { user_id, status: get(statusId) }
  const ref = get(refId), exp = get(expId)
  if (ref) body.provider_ref = ref
  if (exp) body.expires_at = exp
  return body
}

async function _dpComplianceIngest(purpose, path, statusId, refId, expId, okMsg) {
  const body = _dpComplianceBody(statusId, refId, expId)
  if (!body) { if (typeof toast$ === 'function') toast$(t('请填写卖家用户 ID'), 'error'); return }
  const token = await requestPasskeyGate(purpose, body)   // purpose_data = body(逐字绑定)
  if (!token) { if (typeof toast$ === 'function') toast$(t('需要真人 Passkey 确认'), 'error'); return }
  const r = await POST(path, { ...body, webauthn_token: token })
  if (!r || r.error) { if (typeof toast$ === 'function') toast$(window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试'), 'error'); return }
  if (typeof toast$ === 'function') toast$(okMsg)
}

window.doIngestKyb = () => _dpComplianceIngest('direct_pay_kyb_ingress', '/admin/direct-receive/kyb-reviews', 'cmp-kyb-status', 'cmp-kyb-ref', 'cmp-kyb-exp', t('KYB 结论已记录'))
window.doIngestSanctions = () => _dpComplianceIngest('direct_pay_sanctions_ingress', '/admin/direct-receive/sanctions-screenings', 'cmp-sanc-status', 'cmp-sanc-ref', 'cmp-sanc-exp', t('制裁筛查结论已记录'))
