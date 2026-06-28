// Direct Pay (Rail 1) — 店铺认证 UI (PR-⑤b) = 逐品验证的【豁免】路径。UI ONLY。两个面:
//   ① SELLER 自助(seller workbench settings):申领店铺验证码 → 贴到外部店铺页 → 提交店铺链接 → 看状态(含是否已豁免)。
//   ② ADMIN 审核队列(#admin/store-verifications):打开卖家提交的店铺链接手动核对验证码,verify/reject;verify 时可【勾选
//      “免逐品验证”】(per_product_exempt)→ 该卖家所有商品免逐品、可直付。ROOT + 真人 Passkey。
//   诚实:WebAZ 不抓取链接,admin 手动核。不碰 wallet/escrow/settlement/refund;只调既有受门控端点。

window.dpSvCopy = () => ({
  issued:    { icon: '①', text: t('已签发验证码,请贴到你的外部店铺页后提交店铺链接') },
  submitted: { icon: '⏳', text: t('已提交,等待管理员核验') },
  verified:  { icon: '✅', text: t('店铺已通过验证') },
  rejected:  { icon: '🚫', text: t('未通过,请修正后重新申请') },
})

// ══════ SELLER 自助面板 ══════
window.dpSellerStoreVerifySection = () => `
  <div class="card" style="margin-bottom:12px;border:1px solid #e5e7eb">
    <div style="font-size:14px;font-weight:700;margin-bottom:4px">🏬 ${t('店铺认证(可申请免逐品验证)')}</div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('默认每个商品需单独验证才能直付。你也可以申请【店铺认证】:申领验证码 → 贴到你的外部店铺主页 → 提交店铺链接 → 管理员手动核对;通过且管理员勾选豁免后,你【所有商品】免逐品验证即可直付。')}</div>
    <div id="dp-seller-sv">${loading$()}</div>
  </div>`

window.dpHydrateSellerStoreVerify = async () => {
  const box = document.getElementById('dp-seller-sv')
  if (!box) return
  const r = await GET('/direct-receive/store-verification')
  if (!r || r.error) { box.innerHTML = `<div style="font-size:12px;color:#dc2626">${window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试')}</div>`; return }
  const v = r.verification, copy = window.dpSvCopy()
  if (!v || v.status === 'rejected') {
    const prior = v ? `<div style="font-size:12px;color:#6b7280;margin-bottom:8px">${copy.rejected.icon} ${escHtml(copy.rejected.text)}</div>` : ''
    box.innerHTML = prior + `<button onclick="window.dpRequestStoreVerify()" style="padding:8px 16px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">${t('申请店铺认证')}</button>`
    return
  }
  const meta = copy[v.status] || { icon: 'ℹ️', text: v.status }
  const lines = [`<div style="font-size:13px;font-weight:600;color:#374151">${meta.icon} ${escHtml(meta.text)}</div>`]
  if (v.status === 'issued') {
    lines.push(`<div style="font-size:12px;color:#374151;margin:6px 0">${t('验证码')}: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-weight:700">${escHtml(v.code)}</code> · ${t('把它展示在你的外部店铺主页')}</div>`)
    lines.push(`<input id="dp-sv-url" type="url" placeholder="${t('你的外部店铺链接(http/https)')}" style="width:100%;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;margin-bottom:6px">`)
    lines.push(`<button onclick="window.dpSubmitStoreVerify()" style="padding:6px 12px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">${t('提交店铺链接')}</button>`)
  } else if (v.status === 'verified') {
    lines.push(`<div style="font-size:12px;color:${r.exempt ? '#166534' : '#6b7280'};margin-top:4px">${r.exempt ? '✅ ' + t('已豁免逐品验证:你的所有商品可直付') : t('已通过,但未获逐品豁免:商品仍需逐个验证')}</div>`)
  }
  box.innerHTML = `<div style="display:flex;flex-direction:column;gap:2px">${lines.join('')}</div>`
}

window.dpRequestStoreVerify = async () => {
  const r = await POST('/direct-receive/store-verification', {})
  if (!r || r.error) { if (typeof toast$ === 'function') toast$(window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试'), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('验证码已签发'))
  window.dpHydrateSellerStoreVerify()
}

window.dpSubmitStoreVerify = async () => {
  const el = document.getElementById('dp-sv-url')
  const url = el && el.value ? el.value.trim() : ''
  if (!url) { if (typeof toast$ === 'function') toast$(t('请填写你的外部店铺链接'), 'error'); return }
  const r = await PUT('/direct-receive/store-verification', { external_url: url })
  if (!r || r.error) { if (typeof toast$ === 'function') toast$(window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试'), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('已提交,等待管理员核验'))
  window.dpHydrateSellerStoreVerify()
}

// ══════ ADMIN 审核队列 ══════
window.renderAdminStoreVerifications = async function (app) {
  if (!state.user) { renderLogin(); return }
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(loading$(), 'admin')
  const data = await GET('/admin/direct-receive/store-verifications?status=submitted')
  if (!data || data.error) { app.innerHTML = shell(alert$('error', (data && data.error) || t('加载失败')), 'admin'); return }
  const rows = data.verifications || []
  const list = rows.length ? rows.map(v => `
    <div class="card" style="margin-bottom:10px">
      <div style="font-size:11px;color:#9ca3af">${escHtml(v.user_id)} · ${fmtTime(v.created_at)}</div>
      <div style="font-size:13px;margin-top:6px">${t('验证码')}: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-weight:700">${escHtml(v.code)}</code>${v.platform ? ` · ${escHtml(v.platform)}` : ''}</div>
      <div style="font-size:12px;margin-top:4px">${t('店铺链接')}: ${v.external_url ? `<a href="${encodeURI(v.external_url)}" target="_blank" rel="noopener noreferrer nofollow" style="color:#2563eb;text-decoration:underline;word-break:break-all">${escHtml(v.external_url)}</a>` : '—'}</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:4px">${t('请手动打开链接,确认店铺主页展示了上面的验证码,再决定通过/拒绝。')}</div>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;margin-top:8px"><input type="checkbox" id="sv-exempt-${v.id}"> ${t('免逐品验证(通过后该卖家所有商品可直付)')}</label>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn btn-primary btn-sm" style="font-size:12px" onclick="window.doReviewStoreVerify('${v.id}','verified')">✓ ${t('通过(真人 Passkey)')}</button>
        <button class="btn btn-sm" style="font-size:12px;background:#dc2626;border-color:#dc2626;color:#fff" onclick="window.doReviewStoreVerify('${v.id}','rejected')">✗ ${t('拒绝(真人 Passkey)')}</button>
      </div>
    </div>`).join('') : `<div class="empty"><div class="empty-icon">📥</div><div class="empty-text">${t('暂无待核验店铺')}</div></div>`
  app.innerHTML = shell(`
    <h1 class="page-title">🏬 ${t('店铺认证审核')}</h1>
    <div style="margin-bottom:12px"><button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#admin')">${t('返回概览')}</button></div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('打开卖家提交的店铺链接,确认店铺页展示了验证码再通过。勾选“免逐品验证”=该卖家所有商品免逐个验证即可直付(请仅对可信商户勾选)。通过/拒绝均需真人 Passkey。')}</div>
    ${list}
  `, 'admin')
}

// purpose_data 绑 verification_id + decision + per_product_exempt(改任一项一律拒)。
window.doReviewStoreVerify = async function (id, decision) {
  const exempt = decision === 'verified' && !!(document.getElementById('sv-exempt-' + id) || {}).checked
  const body = { verification_id: id, decision, per_product_exempt: exempt }
  const token = await requestPasskeyGate('direct_pay_store_verify', body)
  if (!token) { if (typeof toast$ === 'function') toast$(t('需要真人 Passkey 确认'), 'error'); return }
  const r = await POST(`/admin/direct-receive/store-verifications/${id}/review`, { decision, per_product_exempt: exempt, webauthn_token: token })
  if (!r || r.error) { if (typeof toast$ === 'function') toast$(window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试'), 'error'); return }
  if (typeof toast$ === 'function') toast$(decision === 'verified' ? (r.per_product_exempt ? t('店铺已通过,已豁免逐品验证') : t('店铺已通过')) : t('店铺申请已拒绝'))
  window.renderAdminStoreVerifications(document.getElementById('app'))
}
