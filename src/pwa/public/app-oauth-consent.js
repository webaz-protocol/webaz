// RFC-023 PR-2b — OAuth consent 页(#oauth-consent)。/oauth/authorize 服务端校验通过后 302 到这里;
//   真人核对 client + scope + resource,Passkey 批准(→ mint grant+code → 跳回 redirect_uri)或拒绝。
//   经典脚本,全局函数;globals(state/shell/t/escHtml/navigate/toast$/requestPasskeyGate)调用时解析。
//   安全姿态:approve 走 requestPasskeyGate('oauth_consent_approve', 绑定 client+scope+challenge);
//   服务端全量重校验(SPA 参数不可信),approve/deny 返回 redirect_to 由本页跳转 —— 两端点均拒未注册 redirect_uri。
;(function () {
  // D5 粗粒度 scope → 人话(与服务端 OAUTH_SCOPES 对齐;未知 scope 原样展示,服务端会拒)
  const SCOPE_DESC = {
    'read': () => t('读取公开商品/搜索/你的公开资料(只读)'),
    'order:draft': () => t('起草订单(仅草稿 —— 不下单、不付款,执行永远需要你的 Passkey)'),
    'list:draft': () => t('起草商品上架(仅草稿 —— 发布仍需你的 Passkey)'),
  }

  function q(name) { return (state._urlQuery && typeof state._urlQuery[name] === 'string') ? state._urlQuery[name] : '' }

  function renderOAuthConsent(app) {
    if (!state.user) { app.innerHTML = shell(`<div class="empty">${t('请先登录以审核授权请求')}</div>`, 'me'); return }
    const clientId = q('client_id'), scope = q('scope'), redirectUri = q('redirect_uri'), resource = q('resource')
    if (!clientId || !scope || !redirectUri || !q('code_challenge')) {
      app.innerHTML = shell(`<div class="empty">${t('授权请求参数缺失。请从发起连接的 AI 客户端重新开始。')}</div>`, 'me'); return
    }
    const scopes = scope.split(' ').filter(Boolean)
    app.innerHTML = shell(`
      <div class="page-header"><h2>${t('🔐 授权连接请求')}</h2></div>
      <div style="font-size:12px;color:#6b7280;padding:0 4px 12px;line-height:1.6">${t('一个 AI 客户端请求通过 OAuth 连接你的 WebAZ 账号。它只会拿到下列受限、短期(1小时)、可随时撤销的权限 —— 不是你的账号或密钥;资金/发布/发货等敏感动作永远需要你的 Passkey 逐次批准。')}</div>
      <div class="card" style="padding:16px">
        <div style="font-size:12px;color:#6b7280">${t('请求方 client_id(自称,未验证)')}</div>
        <div style="font-size:16px;font-weight:700;font-family:monospace;margin:2px 0 10px">${escHtml(clientId)}</div>
        <div style="font-size:12px;color:#6b7280">${t('访问目标')}</div>
        <div style="font-size:13px;font-family:monospace;margin:2px 0 10px">${escHtml(resource)}</div>
        <div style="font-size:12px;color:#6b7280;margin-bottom:4px">${t('请求的权限')}</div>
        ${scopes.map(s => `<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-top:1px solid #f3f4f6">
          <code style="font-size:12px;background:#f3f4f6;padding:2px 6px;border-radius:4px;white-space:nowrap">${escHtml(s)}</code>
          <div style="font-size:12px;color:#374151;line-height:1.5">${SCOPE_DESC[s] ? SCOPE_DESC[s]() : t('未知权限(将被服务端拒绝)')}</div>
        </div>`).join('')}
        <div style="font-size:11px;color:#9ca3af;margin-top:10px;line-height:1.6">${t('批准后将跳回:')} <span style="font-family:monospace">${escHtml(redirectUri)}</span></div>
        <button class="btn btn-primary" style="width:100%;margin-top:12px" onclick="oauthConsentApprove(this)">${t('🔐 Passkey 批准连接')}</button>
        <button class="btn btn-outline" style="width:100%;margin-top:8px" onclick="oauthConsentDeny(this)">${t('拒绝')}</button>
      </div>
    `, 'me')
  }
  window.renderOAuthConsent = renderOAuthConsent

  async function oauthPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + state.apiKey },
      body: JSON.stringify(body),
    })
    return res.json().catch(() => ({ error: 'bad response' }))
  }

  window.oauthConsentApprove = async (btn) => {
    btn.disabled = true
    try {
      const token = await requestPasskeyGate('oauth_consent_approve', { client_id: q('client_id'), scope: q('scope'), code_challenge: q('code_challenge') })
      const r = await oauthPost('/oauth/authorize/approve', {
        client_id: q('client_id'), redirect_uri: q('redirect_uri'), scope: q('scope'),
        code_challenge: q('code_challenge'), resource: q('resource'), state: q('state') || undefined,
        webauthn_token: token,
      })
      if (r.error || !r.redirect_to) { toast$(r.error || t('批准失败,请重试'), 'error'); btn.disabled = false; return }
      toast$(t('已批准,正在跳回 AI 客户端…'), 'success')
      window.location.href = r.redirect_to
    } catch (e) { toast$(e.message || t('Passkey 验证未完成'), 'error'); btn.disabled = false }
  }

  window.oauthConsentDeny = async (btn) => {
    btn.disabled = true
    const r = await oauthPost('/oauth/authorize/deny', { client_id: q('client_id'), redirect_uri: q('redirect_uri'), state: q('state') || undefined })
    if (r.error || !r.redirect_to) { toast$(r.error || t('操作失败'), 'error'); btn.disabled = false; return }
    window.location.href = r.redirect_to
  }
})()
