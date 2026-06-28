// Direct Pay (Rail 1) — 按产品认证 UI (PR-④b)。UI ONLY。两个面:
//   ① SELLER 自助(seller workbench settings):逐产品申领验证码 → 贴到外部商品页 → 提交该产品外链 → 看逐产品状态。
//   ② ADMIN 审核队列(#admin/product-verifications):打开卖家提交的外链手动核对验证码,verify/reject(ROOT + 真人 Passkey)。
//   硬门:每个产品都须【单独】被 admin 核验才可直付;一次验证绝不放行所有产品。诚实:WebAZ 不抓取链接,admin 手动核。
//   不碰 wallet/escrow/settlement/refund;只调既有受门控端点。

// ── 状态 → 双语文案 ──
window.dpPvCopy = () => ({
  issued:    { icon: '①', text: t('已签发验证码,请贴到该商品的外部页面后提交链接') },
  submitted: { icon: '⏳', text: t('已提交,等待管理员核验') },
  verified:  { icon: '✅', text: t('已通过验证,可直付') },
  rejected:  { icon: '🚫', text: t('未通过,请修正后重新申请') },
})

// ══════ SELLER 自助面板 ══════
window.dpSellerProductVerifySection = () => `
  <div class="card" style="margin-bottom:12px;border:1px solid #e5e7eb">
    <div style="font-size:14px;font-weight:700;margin-bottom:4px">🔖 ${t('逐产品直付验证(仅你可见)')}</div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('每个走直付收款的商品都需【单独】通过平台人工验证(防作弊):申领验证码 → 贴到该商品的外部平台页面 → 回来提交该商品链接 → 管理员手动核对。未验证的商品只能用托管交易。')}</div>
    <div id="dp-seller-pv">${loading$()}</div>
  </div>`

window.dpHydrateSellerProductVerify = async () => {
  const box = document.getElementById('dp-seller-pv')
  if (!box) return
  const [products, vres] = await Promise.all([GET('/my-products'), GET('/direct-receive/product-verifications')])
  if (!Array.isArray(products) || !vres || vres.error) { box.innerHTML = `<div style="font-size:12px;color:#dc2626">${window.dpErrorText ? window.dpErrorText(vres && vres.error_code, vres && vres.error) : t('操作失败,请重试')}</div>`; return }
  const byProduct = {}; for (const v of (vres.verifications || [])) { if (!byProduct[v.product_id]) byProduct[v.product_id] = v }  // 最新在前
  const copy = window.dpPvCopy()
  if (!products.length) { box.innerHTML = `<div style="font-size:12px;color:#9ca3af">${t('你还没有商品')}</div>`; return }
  box.innerHTML = products.map(p => {
    const v = byProduct[p.id]
    const meta = v ? (copy[v.status] || { icon: 'ℹ️', text: v.status }) : null
    let action = ''
    if (!v || v.status === 'rejected') {
      action = `<button onclick="window.dpRequestProductVerify('${p.id}')" style="padding:6px 12px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">${t('申请验证')}</button>`
    } else if (v.status === 'issued') {
      action = `
        <div style="font-size:12px;color:#374151;margin-bottom:6px">${t('验证码')}: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-weight:700">${escHtml(v.code)}</code> · ${t('把它展示在该商品的外部页面')}</div>
        <input id="dp-pv-url-${p.id}" type="url" placeholder="${t('该商品的外部链接(http/https)')}" style="width:100%;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;margin-bottom:6px">
        <button onclick="window.dpSubmitProductVerify('${p.id}')" style="padding:6px 12px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">${t('提交链接')}</button>`
    }
    return `<div style="padding:8px 0;border-top:1px solid #f3f4f6">
      <div style="font-size:13px;font-weight:600;color:#374151">${escHtml(p.title || p.id)}</div>
      ${meta ? `<div style="font-size:12px;color:#6b7280;margin:4px 0">${meta.icon} ${escHtml(meta.text)}</div>` : ''}
      ${action}
    </div>`
  }).join('')
}

window.dpRequestProductVerify = async (productId) => {
  const r = await POST('/direct-receive/product-verification', { product_id: productId })
  if (!r || r.error) { if (typeof toast$ === 'function') toast$(window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试'), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('验证码已签发'))
  window.dpHydrateSellerProductVerify()
}

window.dpSubmitProductVerify = async (productId) => {
  const el = document.getElementById('dp-pv-url-' + productId)
  const url = el && el.value ? el.value.trim() : ''
  if (!url) { if (typeof toast$ === 'function') toast$(t('请填写该商品的外部链接'), 'error'); return }
  const r = await PUT('/direct-receive/product-verification', { product_id: productId, external_url: url })
  if (!r || r.error) { if (typeof toast$ === 'function') toast$(window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试'), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('已提交,等待管理员核验'))
  window.dpHydrateSellerProductVerify()
}

// ══════ ADMIN 审核队列 ══════
window.renderAdminProductVerifications = async function (app) {
  if (!state.user) { renderLogin(); return }
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(loading$(), 'admin')
  const data = await GET('/admin/direct-receive/product-verifications?status=submitted')
  if (!data || data.error) { app.innerHTML = shell(alert$('error', (data && data.error) || t('加载失败')), 'admin'); return }
  const rows = data.verifications || []
  const list = rows.length ? rows.map(v => `
    <div class="card" style="margin-bottom:10px">
      <div style="font-size:11px;color:#9ca3af">${escHtml(v.seller_id)} · ${escHtml(v.product_id)} · ${fmtTime(v.created_at)}</div>
      <div style="font-size:13px;margin-top:6px">${t('验证码')}: <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-weight:700">${escHtml(v.code)}</code>${v.platform ? ` · ${escHtml(v.platform)}` : ''}</div>
      <div style="font-size:12px;margin-top:4px">${t('外部链接')}: ${v.external_url ? `<a href="${encodeURI(v.external_url)}" target="_blank" rel="noopener noreferrer nofollow" style="color:#2563eb;text-decoration:underline;word-break:break-all">${escHtml(v.external_url)}</a>` : '—'}</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:4px">${t('请手动打开链接,确认该商品页面上展示了上面的验证码,再决定通过/拒绝。')}</div>
      <div style="display:flex;gap:6px;margin-top:10px">
        <button class="btn btn-primary btn-sm" style="font-size:12px" onclick="window.doReviewProductVerify('${v.id}','verified')">✓ ${t('通过(真人 Passkey)')}</button>
        <button class="btn btn-sm" style="font-size:12px;background:#dc2626;border-color:#dc2626;color:#fff" onclick="window.doReviewProductVerify('${v.id}','rejected')">✗ ${t('拒绝(真人 Passkey)')}</button>
      </div>
    </div>`).join('') : `<div class="empty"><div class="empty-icon">📥</div><div class="empty-text">${t('暂无待核验商品')}</div></div>`
  app.innerHTML = shell(`
    <h1 class="page-title">🔖 ${t('逐产品直付验证审核')}</h1>
    <div style="margin-bottom:12px"><button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#admin')">${t('返回概览')}</button></div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('每个商品需单独核验:打开卖家提交的外部链接,确认页面展示了验证码再通过。通过=该商品可直付(逐品,绝不放行全部)。通过/拒绝均需真人 Passkey。')}</div>
    ${list}
  `, 'admin')
}

// purpose_data 绑 verification_id + decision(签 A 用 B / 改结论一律拒)。
window.doReviewProductVerify = async function (id, decision) {
  const token = await requestPasskeyGate('direct_pay_product_verify', { verification_id: id, decision })
  if (!token) { if (typeof toast$ === 'function') toast$(t('需要真人 Passkey 确认'), 'error'); return }
  const r = await POST(`/admin/direct-receive/product-verifications/${id}/review`, { decision, webauthn_token: token })
  if (!r || r.error) { if (typeof toast$ === 'function') toast$(window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试'), 'error'); return }
  if (typeof toast$ === 'function') toast$(decision === 'verified' ? t('该商品已通过验证') : t('该商品已拒绝'))
  window.renderAdminProductVerifications(document.getElementById('app'))
}
