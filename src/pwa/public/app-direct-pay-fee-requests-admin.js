// 平台服务费预充值申请 —— admin(ROOT)审核队列。核对真实到账 → 确认入账(Passkey,唯一动钱)/ 驳回。
//   approve 的 Passkey 绑定 {request_id, seller_id, amount_units, method}(把入账金额/对象钉进 token,防替换);reject 绑 request_id。
//   每条显示【申请 id(fpr_…)】便于和卖家对齐管理。面向管理员中文走 t()。

window.afprStatus = (s) => ({ pending: t('待审核'), approved: t('已入账'), rejected: t('已驳回'), cancelled: t('已撤销') }[s] || s)

window.renderAdminFeePrepayRequests = function (app) {
  if (!state.user) { renderLogin(); return }
  if (typeof isAdmin === 'function' && !isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  if ((state.user.admin_type || 'root') !== 'root') { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限根管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(`
    <h1 class="page-title">🧾 ${t('平台服务费预充值申请')}</h1>
    <div style="margin-bottom:8px"><button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#admin/dp-ops')">${t('返回 Direct Pay 商户运营')}</button></div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('卖家发起的平台服务费预充值申请。请【核对凭证号对应的真实到账】后再确认入账;确认即为该商家记一笔预充值(真人 Passkey,唯一动钱步)。')}</div>
    <div id="afpr-box">${loading$()}</div>
  `, 'admin')
  window.afprHydrate()
}

window.afprHydrate = async () => {
  const box = document.getElementById('afpr-box'); if (!box) return
  const r = await GET('/admin/direct-receive/fee-prepay-requests?status=pending')
  if (r.error) { box.innerHTML = alert$('error', r.error || t('加载失败')); return }
  const reqs = r.requests || []
  box.innerHTML = `
    <div id="afpr-msg"></div>
    ${reqs.length ? reqs.map(x => window.afprCard(x)).join('') : `<div style="font-size:12px;color:#9ca3af">${t('暂无待审核申请')}</div>`}`
}

window.afprCard = (r) => `
  <div style="border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin-bottom:10px" data-req="${escHtml(r.id)}">
    <div style="font-size:15px;font-weight:800">${(r.amount_units / 1e6).toFixed(2)} <span style="font-size:12px;color:#6b7280">${escHtml(r.currency || 'USDC')}</span></div>
    <div style="font-size:11px;color:#9ca3af;margin:2px 0 6px">${t('申请 id')}: <code>${escHtml(r.id)}</code></div>
    <div style="font-size:12px;color:#374151;line-height:1.7">
      <div>${t('卖家')}: <code>${escHtml(r.seller_id)}</code></div>
      <div>${t('付给平台账户')}: <code>${escHtml(r.platform_account_id || '-')}</code></div>
      <div>${t('付款凭证号')}: <b>${escHtml(r.evidence_ref)}</b>${r.evidence_note ? ` · ${escHtml(r.evidence_note)}` : ''}</div>
      <div style="color:#9ca3af">${escHtml(r.created_at || '')}</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
      <select id="afpr-method-${r.id}" style="padding:6px;border:1px solid #d1d5db;border-radius:6px;font-size:12px"><option value="usdc">USDC</option><option value="fiat">${t('法币 fiat')}</option></select>
      <button class="btn btn-primary btn-sm" onclick="afprApprove('${r.id}')">${t('确认到账并入账(真人 Passkey)')}</button>
      <button class="btn btn-outline btn-sm" style="color:#dc2626;border-color:#dc2626" onclick="afprReject('${r.id}')">${t('驳回(真人 Passkey)')}</button>
    </div>
  </div>`

window.afprApprove = async (id) => {
  const card = document.querySelector(`[data-req="${id}"]`); if (!card) return
  const r = await GET('/admin/direct-receive/fee-prepay-requests?status=pending')
  const req = ((r && r.requests) || []).find(x => x.id === id)
  if (!req) { if (typeof toast$ === 'function') toast$(t('该申请已不在待审核队列'), 'error'); window.afprHydrate(); return }
  const method = document.getElementById('afpr-method-' + id)?.value || 'usdc'
  let token
  try { token = await requestPasskeyGate('direct_pay_fee_prepay_record', { request_id: id, seller_id: req.seller_id, amount_units: req.amount_units, method }) }
  catch (e) { if (typeof toast$ === 'function') toast$((e && e.message ? e.message + ' — ' : '') + t('需先注册 Passkey'), 'error'); return }
  const res = await POST('/admin/direct-receive/fee-prepay-requests/' + id + '/approve', { method, note: null, webauthn_token: token })
  if (res.error) { if (typeof toast$ === 'function') toast$(res.error || t('入账失败'), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('已确认入账'), 'success'); window.afprHydrate()
}

window.afprReject = async (id) => {
  const note = await confirmModal(t('确定驳回这条申请?(将通知卖家未通过)'), t('驳回'), { danger: true })
  if (!note) return
  let token
  try { token = await requestPasskeyGate('direct_pay_fee_prepay_reject', { request_id: id }) }
  catch (e) { if (typeof toast$ === 'function') toast$((e && e.message ? e.message + ' — ' : '') + t('需先注册 Passkey'), 'error'); return }
  const res = await POST('/admin/direct-receive/fee-prepay-requests/' + id + '/reject', { note: null, webauthn_token: token })
  if (res.error) { if (typeof toast$ === 'function') toast$(res.error || t('驳回失败'), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('已驳回'), 'success'); window.afprHydrate()
}
