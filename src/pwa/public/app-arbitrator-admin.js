// PR-F:仲裁员管理 admin UI(最小)。唯一授权源 = active arbitrator_whitelist;所有变更 = ROOT + 现场真人 Passkey + 后端审计。
//   grant:输入 user_id/@handle → /admin/users/lookup 解析 → requestPasskeyGate('arbitrator_grant',{user_id}) → POST。
//   目标须真人 + 已注册 Passkey + 非当事人 + 非 agent/system(后端 grantArbitrator 校验,前端只带输入)。中文 t(),英文 i18n.js。
window.renderAdminArbitrators = async function (app) {
  if (!state.user) { renderLogin(); return }
  if ((state.user.admin_type || 'root') !== 'root') { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限根管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(`
    <h1 class="page-title">⚖ ${t('仲裁员管理')}</h1>
    <div style="margin-bottom:8px"><button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#admin')">${t('← 返回')}</button></div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('授权真人仲裁员(唯一授权源=active 白名单)。目标须已注册 Passkey、非本案当事人、非 agent/系统账号。授权/暂停/撤销均需你现场 Passkey,后端留痕。')}</div>
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:13px;font-weight:700;margin-bottom:6px">${t('授权新仲裁员')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input class="form-control" id="arb-grant-q" placeholder="${t('user_id 或 @handle')}" style="flex:1;min-width:200px">
        <button class="btn btn-primary btn-sm" style="width:auto" onclick="arbAdminGrant()">${t('授权(真人 Passkey)')}</button>
      </div>
      <div id="arb-grant-msg" style="margin-top:8px"></div>
    </div>
    <div id="arb-roster">${loading$()}</div>
  `, 'admin')
  window.arbAdminHydrate()
}

window.arbAdminHydrate = async () => {
  const box = document.getElementById('arb-roster'); if (!box) return
  const r = await GET('/admin/arbitrators')
  if (r.error) { box.innerHTML = alert$('error', r.error || t('加载失败')); return }
  const rows = r.arbitrators || []
  box.innerHTML = `<div style="font-size:13px;font-weight:700;margin-bottom:6px">${t('仲裁员名册')}（${rows.length}）</div>` +
    (rows.length ? rows.map(x => window.arbAdminCard(x)).join('') : `<div style="font-size:12px;color:#9ca3af">${t('暂无仲裁员')}</div>`)
}

window.arbAdminCard = (r) => {
  const badge = r.status === 'active' ? 'background:#dcfce7;color:#166534' : r.status === 'suspended' ? 'background:#fef9c3;color:#854d0e' : 'background:#fee2e2;color:#991b1b'
  const label = r.status === 'active' ? t('在岗') : r.status === 'suspended' ? t('已暂停') : t('已撤销')
  return `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin-bottom:8px" data-arb="${escHtml(r.user_id)}">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
      <code style="font-size:12px">${escHtml(r.user_id)}</code>
      <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap;${badge}">${label}</span>
    </div>
    <div style="font-size:11px;color:#9ca3af;margin:2px 0 6px">${r.is_system ? t('内部账号(is_system)') + ' · ' : ''}${escHtml(r.note || '')}${r.suspended_at ? ' · ' + t('暂停于') + ' ' + escHtml(r.suspended_at) : ''}${r.revoked_at ? ' · ' + t('撤销于') + ' ' + escHtml(r.revoked_at) : ''}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${r.status === 'active' ? `<button class="btn btn-outline btn-sm" style="width:auto" onclick="arbAdminMutate('${escHtml(r.user_id)}','suspend')">${t('暂停')}</button>` : ''}
      ${r.status === 'suspended' ? `<button class="btn btn-primary btn-sm" style="width:auto" onclick="arbAdminMutate('${escHtml(r.user_id)}','reinstate')">${t('恢复')}</button>` : ''}
      ${r.status !== 'revoked' ? `<button class="btn btn-outline btn-sm" style="width:auto;color:#dc2626;border-color:#dc2626" onclick="arbAdminMutate('${escHtml(r.user_id)}','revoke')">${t('撤销（终态）')}</button>` : `<span style="font-size:11px;color:#9ca3af">${t('已永久撤销,不可再授权')}</span>`}
    </div>
  </div>`
}

window.arbAdminGrant = async () => {
  const q = (document.getElementById('arb-grant-q')?.value || '').trim()
  const msg = document.getElementById('arb-grant-msg')
  const show = (type, m) => { if (msg) msg.innerHTML = alert$(type, m) }
  if (!q) return show('error', t('请输入 user_id 或 @handle'))
  const look = await GET('/admin/users/lookup?q=' + encodeURIComponent(q))
  if (look.error || !look.user) return show('error', look.error || t('用户不存在'))
  const userId = look.user.id
  let token
  try { token = await requestPasskeyGate('arbitrator_grant', { user_id: userId }) }
  catch (e) { return show('error', (e && e.message ? e.message + ' — ' : '') + t('需先注册 Passkey')) }
  const res = await POST('/admin/arbitrators/grant', { user_id: userId, webauthn_token: token })
  if (res.error) return show('error', res.error)   // 后端已给清晰中文(NOT_HUMAN / PASSKEY_REQUIRED / REVOKED_TERMINAL 等)
  show('success', t('已授权') + '：' + escHtml(look.user.name || userId))
  window.arbAdminHydrate()
}

// PR-F:whitelist-only 仲裁员(role≠arbitrator,如被授权的买家)在个人页看不到"仲裁台"入口 —— 补一张跟随
//   can_arbitrate 的入口卡(纯 UI;#disputes 本就可达,后端 can_arbitrate/COI/assign 才是边界)。
window.arbTaishCard = () => `
  <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">⚖ ${t('仲裁工作')}</div>
  <div style="margin-bottom:10px">
    <div class="card" onclick="location.hash='#disputes'" style="padding:14px;cursor:pointer;display:flex;align-items:center;gap:10px;min-height:64px">
      <div style="font-size:22px">⚖</div>
      <div><div style="font-weight:600;font-size:14px">${t('仲裁台')}</div><div style="font-size:12px;color:#6b7280">${t('待响应 / 仲裁中 / 已结')}</div></div>
    </div>
  </div>`

window.arbAdminMutate = async (userId, action) => {
  if (action === 'revoke' && !(await confirmModal(t('撤销是终态,不可再授权该用户。确定撤销?'), t('撤销'), { danger: true }))) return
  let token
  try { token = await requestPasskeyGate('arbitrator_' + action, { user_id: userId }) }
  catch (e) { if (typeof toast$ === 'function') toast$((e && e.message ? e.message + ' — ' : '') + t('需先注册 Passkey'), 'error'); return }
  const res = await POST('/admin/arbitrators/' + userId + '/' + action, { webauthn_token: token })
  if (res.error) { if (typeof toast$ === 'function') toast$(res.error, 'error'); return }
  if (typeof toast$ === 'function') toast$(t('操作成功'), 'success')
  window.arbAdminHydrate()
}
