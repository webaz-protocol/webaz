// Direct Pay (Rail 1) — 卖家多收款账号 + 收款二维码 管理 UI (Phase C2)。UI ONLY。
//   接 Phase C1 后端 /api/direct-receive/accounts(list / add / update / deactivate + /:id/qr upload·preview)。
//   写操作(add/update/deactivate/qr)均需现场真人 Passkey(purpose direct_receive_account_manage,
//   action[+account_id] 绑 purpose_data);QR 预览走 Authorization header fetch→blob(<img src> 带不了 header)。
//   WebAZ 只存储/展示卖家自填内容与二维码字节,绝不验证/路由/托管资金,也不解析二维码。双语 parity 由 test-direct-pay-ui.ts 守。

// 账号相关 error_code → 双语文案;未命中回落到 dpErrorText(直付通用码)。
window.draAccountErrorText = (code, fallback) => {
  const M = {
    SELLER_ONLY: t('仅卖家可管理收款账号'),
    ACCOUNT_NOT_FOUND: t('账号不存在'),
    ACCOUNT_INPUT_INVALID: t('账号信息不合法'),
    QR_INVALID: t('二维码图片不合法(仅支持 PNG/WebP,解码后 ≤ 64KB)'),
    HUMAN_PRESENCE_REQUIRED: t('需现场真人 Passkey 确认'),
    PASSKEY_REQUIRED: t('需先注册 Passkey'),
  }
  return M[code] || (window.dpErrorText ? window.dpErrorText(code, fallback) : (fallback || t('操作失败,请重试')))
}

// ── 卖家设置:多收款账号面板(section + hydrate)──────────────────────────────────────────────
window.draAccountsSection = () => `
  <div class="card" style="margin-bottom:12px">
    <div style="font-size:14px;font-weight:700;margin-bottom:6px">🧾 ${t('直付收款账号')}</div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('你可维护多个收款账号(各自币种、可选二维码),买家直付时自选其一。WebAZ 只存储与展示,不验证付款方式或币种,不路由/托管资金,也不解析二维码。')}</div>
    <div id="dra-accounts-box">${loading$()}</div>
  </div>`

window.draHydrateAccounts = async () => {
  const box = document.getElementById('dra-accounts-box')
  if (!box) return
  const r = await GET('/direct-receive/accounts')
  if (r.error) { box.innerHTML = alert$('error', window.draAccountErrorText(r.error_code, r.error)); return }
  const accounts = r.accounts || []
  box.innerHTML = `
    <div id="dra-msg"></div>
    ${accounts.length ? accounts.map(a => window.draAccountCard(a)).join('') : `<div style="font-size:12px;color:#9ca3af;margin-bottom:10px">${t('尚未添加收款账号')}</div>`}
    <details style="margin-top:8px"><summary style="font-size:13px;font-weight:600;color:#2563eb;cursor:pointer">＋ ${t('新增收款账号')}</summary>
      <div style="padding:8px 2px 2px">${window.draAccountForm('new')}</div></details>`
  window.draLoadQrThumbs(accounts)
}

window.draAccountCard = (a) => {
  const inactive = a.status !== 'active'
  return `<div style="border:1px solid ${inactive ? '#e5e7eb' : '#d1fae5'};background:${inactive ? '#f9fafb' : '#f0fdf4'};border-radius:10px;padding:10px 12px;margin-bottom:8px;opacity:${inactive ? '0.6' : '1'}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <div style="min-width:0">
        <div style="font-size:13px;font-weight:700;color:#111827">${a.label ? escHtml(a.label) : (a.method ? escHtml(a.method) : t('收款账号'))}${inactive ? ` · <span style="color:#9ca3af;font-weight:400">${t('已停用')}</span>` : ''}</div>
        <div style="font-size:11px;color:#6b7280;margin:2px 0 4px">${a.method ? escHtml(a.method) : ''}${a.method && a.currency ? ' · ' : ''}${a.currency ? escHtml(a.currency) : ''}</div>
        <div style="font-size:12px;color:#374151;white-space:pre-wrap;word-break:break-word">${escHtml(a.instruction)}</div>
      </div>
      <div id="dra-qr-${a.id}" style="flex:0 0 auto;width:72px;height:72px;display:flex;align-items:center;justify-content:center;border:1px dashed #d1d5db;border-radius:8px;font-size:10px;color:#9ca3af;text-align:center">${a.qr_image_ref ? loading$() : t('无二维码')}</div>
    </div>
    ${inactive ? '' : `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">
      <details style="flex:0 0 auto"><summary style="font-size:12px;color:#2563eb;cursor:pointer">${t('编辑')}</summary><div style="padding:8px 2px 2px">${window.draAccountForm(a.id, a)}</div></details>
      <label class="btn btn-outline btn-sm" style="cursor:pointer;margin:0">${a.qr_image_ref ? t('更换二维码') : t('上传二维码')}<input type="file" accept="image/png,image/webp" style="display:none" onchange="draUploadQr('${a.id}', this)"></label>
      <button class="btn btn-outline btn-sm" style="color:#dc2626;border-color:#dc2626" onclick="draDeactivateAccount('${a.id}')">${t('停用')}</button>
    </div>`}
  </div>`
}

// 文本字段表单(id='new' 为新增;否则为该账号编辑)。QR 不在此处改 —— 由文件上传单独走 /:id/qr。
window.draAccountForm = (id, a) => {
  const p = id === 'new' ? 'new' : id
  return `
    <div class="form-group"><label class="form-label">${t('收款说明')} <span style="font-size:11px;color:#9ca3af">${t('(展示给买家,如 PayNow / 银行转账 等)')}</span></label>
      <textarea class="form-control" id="dra-instr-${p}" rows="3" maxlength="500" placeholder="${t('例:PayNow +65 9xxx(场外结算)')}">${a ? escHtml(a.instruction) : ''}</textarea></div>
    <div style="display:flex;gap:8px">
      <div class="form-group" style="flex:1"><label class="form-label">${t('收款方式')}</label><input class="form-control" id="dra-method-${p}" maxlength="40" value="${a && a.method ? escHtml(a.method) : ''}" placeholder="${t('如 PayNow')}"></div>
      <div class="form-group" style="flex:1"><label class="form-label">${t('币种')}</label><input class="form-control" id="dra-currency-${p}" maxlength="8" value="${a && a.currency ? escHtml(a.currency) : ''}" placeholder="${t('如 SGD / USDC')}"></div>
    </div>
    <div class="form-group"><label class="form-label">${t('标签(可选)')}</label><input class="form-control" id="dra-label-${p}" maxlength="40" value="${a && a.label ? escHtml(a.label) : ''}" placeholder="${t('如 PayNow')}"></div>
    <button class="btn btn-primary btn-sm" onclick="${id === 'new' ? 'draAddAccount()' : `draUpdateAccount('${id}')`}">${t('保存')}</button>`
}

window.draReadForm = (p) => ({
  instruction: document.getElementById(`dra-instr-${p}`)?.value?.trim() || '',
  method: document.getElementById(`dra-method-${p}`)?.value?.trim() || '',
  currency: document.getElementById(`dra-currency-${p}`)?.value?.trim() || '',
  label: document.getElementById(`dra-label-${p}`)?.value?.trim() || '',
})

// 现场真人 Passkey token;失败(无 Passkey / 取消 / 不支持)→ 提示注册入口并返回 null。
window.draGate = async (action, accountId) => {
  try { return await requestPasskeyGate('direct_receive_account_manage', accountId ? { action, account_id: accountId } : { action }) }
  catch (e) { if (window.dpPromptRegisterPasskey) await window.dpPromptRegisterPasskey(e); return null }
}

window.draAddAccount = async () => {
  const f = window.draReadForm('new')
  if (!f.instruction) { if (typeof toast$ === 'function') toast$(t('收款说明不能为空'), 'error'); return }
  const token = await window.draGate('add'); if (!token) return
  const r = await POST('/direct-receive/accounts', { ...f, webauthn_token: token })
  if (r.error) { if (typeof toast$ === 'function') toast$(window.draAccountErrorText(r.error_code, r.error), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('已保存'), 'success'); window.draHydrateAccounts()
}

window.draUpdateAccount = async (id) => {
  const f = window.draReadForm(id)
  if (!f.instruction) { if (typeof toast$ === 'function') toast$(t('收款说明不能为空'), 'error'); return }
  const token = await window.draGate('update', id); if (!token) return
  const r = await PUT('/direct-receive/accounts/' + id, { ...f, webauthn_token: token })
  if (r.error) { if (typeof toast$ === 'function') toast$(window.draAccountErrorText(r.error_code, r.error), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('已保存'), 'success'); window.draHydrateAccounts()
}

window.draDeactivateAccount = async (id) => {
  const go = await confirmModal(t('停用后买家将无法选择该收款账号,确定停用?'), t('停用'), { danger: true })
  if (!go) return
  const token = await window.draGate('deactivate', id); if (!token) return
  const r = await api('DELETE', '/direct-receive/accounts/' + id, { webauthn_token: token })
  if (r.error) { if (typeof toast$ === 'function') toast$(window.draAccountErrorText(r.error_code, r.error), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('已停用'), 'success'); window.draHydrateAccounts()
}

// 上传/更换二维码:客户端先卡类型(png|webp)+大小(≤64KB)→ 读为 data URI → Passkey → PUT。后端仍严格复核。
window.draUploadQr = async (id, input) => {
  const file = input && input.files && input.files[0]; if (input) input.value = ''
  if (!file) return
  if (file.type !== 'image/png' && file.type !== 'image/webp') { if (typeof toast$ === 'function') toast$(t('二维码仅支持 PNG 或 WebP 图片'), 'error'); return }
  if (file.size > 64 * 1024) { if (typeof toast$ === 'function') toast$(t('二维码图片过大(需 ≤ 64KB)'), 'error'); return }
  let dataUri
  try { dataUri = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file) }) }
  catch { if (typeof toast$ === 'function') toast$(t('二维码读取失败'), 'error'); return }
  const token = await window.draGate('qr', id); if (!token) return
  const r = await PUT('/direct-receive/accounts/' + id + '/qr', { qr_data_uri: dataUri, webauthn_token: token })
  if (r.error) { if (typeof toast$ === 'function') toast$(window.draAccountErrorText(r.error_code, r.error), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('二维码已上传'), 'success'); window.draHydrateAccounts()
}

// 二维码缩略图:owner-only 端点需 Authorization header,<img src> 带不了 → fetch→blob→objectURL。
window.draLoadQrThumbs = (accounts) => {
  (accounts || []).filter(a => a.qr_image_ref).forEach(a => setTimeout(async () => {
    const el = document.getElementById('dra-qr-' + a.id); if (!el) return
    try {
      const resp = await fetch('/api/direct-receive/accounts/' + a.id + '/qr', { headers: { Authorization: 'Bearer ' + state.apiKey } })
      if (!resp.ok) { el.textContent = '❌'; return }
      const url = URL.createObjectURL(await resp.blob())
      el.innerHTML = `<img src="${url}" alt="${t('收款二维码')}" style="width:72px;height:72px;object-fit:contain;border-radius:6px">`
    } catch { el.textContent = '❌' }
  }, 0))
}
