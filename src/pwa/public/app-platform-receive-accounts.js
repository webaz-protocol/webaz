// 平台(WebAZ)收款方式 —— admin(ROOT)管理 UI。卖家申请充值平台服务费时看到这些方式并据此付款。
//   写操作(新增/编辑/停用/传码)均需 ROOT + 现场真人 Passkey(purpose platform_receive_account_manage,action[+account_id] 绑)。
//   qr 内联 data-uri:前端先卡 png/webp≤64KB,后端 validateQrDataUri 再校验;预览直接 <img src=data-uri>(我方已校验、栅格图,安全)。
//   面向用户中文走 t(),英文在 i18n.js。双语 parity 由 test-direct-pay-ui.ts 守。

window.praErrText = (code, fallback) => ({
  PLATFORM_ACCOUNT_INPUT_INVALID: t('收款方式信息不合法'),
  PLATFORM_ACCOUNT_NOT_FOUND: t('平台收款方式不存在'),
  HUMAN_PRESENCE_REQUIRED: t('需现场真人 Passkey 确认'),
  PASSKEY_REQUIRED: t('需先注册 Passkey'),
}[code] || fallback || t('操作失败,请重试'))

window.renderAdminPlatformReceiveAccounts = function (app) {
  if (!state.user) { renderLogin(); return }
  if (typeof isAdmin === 'function' && !isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  if ((state.user.admin_type || 'root') !== 'root') { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限根管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(`
    <h1 class="page-title">🏦 ${t('平台收款方式')}</h1>
    <div style="margin-bottom:8px"><button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#admin/dp-ops')">${t('返回 Direct Pay 商户运营')}</button></div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('这些是 WebAZ 收取【平台服务费预充值】的收款方式。卖家申请充值时会看到 active 的方式并据此线下付款;可维护多个。改动 = 改平台收款流向,需真人 Passkey。')}</div>
    <div id="pra-box">${loading$()}</div>
  `, 'admin')
  window.praHydrate()
}

window.praHydrate = async () => {
  const box = document.getElementById('pra-box'); if (!box) return
  const r = await GET('/admin/platform-receive-accounts')
  if (r.error) { box.innerHTML = alert$('error', window.praErrText(r.error_code, r.error)); return }
  const accounts = r.accounts || []
  box.innerHTML = `
    <div id="pra-msg"></div>
    ${accounts.length ? accounts.map(a => window.praCard(a)).join('') : `<div style="font-size:12px;color:#9ca3af;margin-bottom:10px">${t('尚未添加平台收款方式')}</div>`}
    <details style="margin-top:8px"><summary style="font-size:13px;font-weight:600;color:#2563eb;cursor:pointer">＋ ${t('新增平台收款方式')}</summary>
      <div style="padding:8px 2px 2px">${window.praForm('new')}</div></details>`
}

window.praCard = (a) => {
  const inactive = a.status !== 'active'
  return `<div style="border:1px solid ${inactive ? '#e5e7eb' : '#c7d2fe'};background:${inactive ? '#f9fafb' : '#eef2ff'};border-radius:10px;padding:10px 12px;margin-bottom:8px;opacity:${inactive ? '0.6' : '1'}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <div style="min-width:0">
        <div style="font-size:13px;font-weight:700;color:#111827">${a.label ? escHtml(a.label) : (a.method ? escHtml(a.method) : t('平台收款方式'))}${inactive ? ` · <span style="color:#9ca3af;font-weight:400">${t('已停用')}</span>` : ''}</div>
        <div style="font-size:11px;color:#6b7280;margin:2px 0 4px">${a.method ? escHtml(a.method) : ''}${a.method && a.currency ? ' · ' : ''}${a.currency ? escHtml(a.currency) : ''}</div>
        <div style="font-size:12px;color:#374151;white-space:pre-wrap;word-break:break-word">${escHtml(a.instruction)}</div>
      </div>
      <div style="flex:0 0 auto;width:72px;height:72px;display:flex;align-items:center;justify-content:center;border:1px dashed #d1d5db;border-radius:8px;font-size:10px;color:#9ca3af;text-align:center">${a.qr_data_uri ? `<img src="${a.qr_data_uri}" alt="${t('收款二维码')}" style="width:72px;height:72px;object-fit:contain;border-radius:6px">` : t('无二维码')}</div>
    </div>
    ${inactive ? '' : `<details style="margin-top:8px"><summary style="font-size:12px;color:#2563eb;cursor:pointer">${t('编辑')}</summary><div style="padding:8px 2px 2px">${window.praForm(a.id, a)}</div></details>
      <button class="btn btn-outline btn-sm" style="margin-top:6px;color:#dc2626;border-color:#dc2626" onclick="praDeactivate('${a.id}')">${t('停用')}</button>`}
  </div>`
}

window.praForm = (id, a) => {
  const p = id === 'new' ? 'new' : id
  return `
    <div class="form-group"><label class="form-label">${t('平台收款明细')} <span style="font-size:11px;color:#9ca3af">${t('(展示给卖家,如 PayNow 账号 / 银行账户 / USDC 地址)')}</span></label>
      <textarea class="form-control" id="pra-instr-${p}" rows="3" maxlength="500" placeholder="${t('例:PayNow UEN 202xxxxx(备注填你的卖家 ID)')}">${a ? escHtml(a.instruction) : ''}</textarea></div>
    <div style="display:flex;gap:8px">
      <div class="form-group" style="flex:1"><label class="form-label">${t('收款方式')}</label><input class="form-control" id="pra-method-${p}" maxlength="40" value="${a && a.method ? escHtml(a.method) : ''}" placeholder="${t('如 PayNow')}"></div>
      <div class="form-group" style="flex:1"><label class="form-label">${t('币种')}</label><input class="form-control" id="pra-currency-${p}" maxlength="8" value="${a && a.currency ? escHtml(a.currency) : ''}" placeholder="${t('如 SGD / USDC')}"></div>
    </div>
    <div class="form-group"><label class="form-label">${t('标签(可选)')}</label><input class="form-control" id="pra-label-${p}" maxlength="40" value="${a && a.label ? escHtml(a.label) : ''}" placeholder="${t('如 PayNow-主')}"></div>
    <div class="form-group"><label class="form-label">${t('收款二维码(可选,PNG/WebP ≤64KB)')}</label>
      <input type="file" accept="image/png,image/webp" id="pra-qr-${p}" style="font-size:12px">
      ${a && a.qr_data_uri ? `<label style="display:block;font-size:12px;color:#b45309;margin-top:4px;cursor:pointer"><input type="checkbox" id="pra-qrremove-${p}"> ${t('移除现有二维码')}</label>` : ''}</div>
    <button class="btn btn-primary btn-sm" onclick="${id === 'new' ? 'praAdd()' : `praUpdate('${id}')`}">${t('保存')}</button>`
}

window.praReadText = (p) => ({
  instruction: document.getElementById(`pra-instr-${p}`)?.value?.trim() || '',
  method: document.getElementById(`pra-method-${p}`)?.value?.trim() || '',
  currency: document.getElementById(`pra-currency-${p}`)?.value?.trim() || '',
  label: document.getElementById(`pra-label-${p}`)?.value?.trim() || '',
})

// 读 QR 输入 → 'keep'(不改) | ''(移除) | data-uri(新图,前端先卡 png/webp≤64KB)。异常抛错。
window.praReadQr = async (p) => {
  const f = document.getElementById(`pra-qr-${p}`)?.files?.[0]
  if (f) {
    if (f.type !== 'image/png' && f.type !== 'image/webp') throw new Error(t('二维码仅支持 PNG 或 WebP 图片'))
    if (f.size > 64 * 1024) throw new Error(t('二维码图片过大(需 ≤ 64KB)'))
    return await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(f) })
  }
  if (document.getElementById(`pra-qrremove-${p}`)?.checked) return ''
  return 'keep'
}

window.praGate = async (action, accountId) => {
  try { return await requestPasskeyGate('platform_receive_account_manage', accountId ? { action, account_id: accountId } : { action }) }
  catch (e) { if (typeof toast$ === 'function') toast$((e && e.message ? e.message + ' — ' : '') + t('需先注册 Passkey'), 'error'); return null }
}

window.praAdd = async () => {
  const f = window.praReadText('new')
  if (!f.instruction) { if (typeof toast$ === 'function') toast$(t('平台收款明细不能为空'), 'error'); return }
  let qr; try { qr = await window.praReadQr('new') } catch (e) { if (typeof toast$ === 'function') toast$(e.message, 'error'); return }
  const token = await window.praGate('add'); if (!token) return
  const body = { ...f, webauthn_token: token }; if (qr !== 'keep') body.qr_data_uri = qr
  const r = await POST('/admin/platform-receive-accounts', body)
  if (r.error) { if (typeof toast$ === 'function') toast$(window.praErrText(r.error_code, r.error), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('已保存'), 'success'); window.praHydrate()
}

window.praUpdate = async (id) => {
  const f = window.praReadText(id)
  if (!f.instruction) { if (typeof toast$ === 'function') toast$(t('平台收款明细不能为空'), 'error'); return }
  let qr; try { qr = await window.praReadQr(id) } catch (e) { if (typeof toast$ === 'function') toast$(e.message, 'error'); return }
  const token = await window.praGate('update', id); if (!token) return
  const body = { ...f, webauthn_token: token }; if (qr !== 'keep') body.qr_data_uri = qr
  const r = await PUT('/admin/platform-receive-accounts/' + id, body)
  if (r.error) { if (typeof toast$ === 'function') toast$(window.praErrText(r.error_code, r.error), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('已保存'), 'success'); window.praHydrate()
}

window.praDeactivate = async (id) => {
  const go = await confirmModal(t('停用后卖家将不再看到此平台收款方式,确定停用?'), t('停用'), { danger: true })
  if (!go) return
  const token = await window.praGate('deactivate', id); if (!token) return
  const r = await api('DELETE', '/admin/platform-receive-accounts/' + id, { webauthn_token: token })
  if (r.error) { if (typeof toast$ === 'function') toast$(window.praErrText(r.error_code, r.error), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('已停用'), 'success'); window.praHydrate()
}
