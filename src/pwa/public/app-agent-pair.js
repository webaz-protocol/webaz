// RFC-020 — Agent 配对授权页(#pair)。真人登录后审核 agent 的委托请求,Passkey 批准 / 拒绝。
//   经典脚本,全局函数;globals(GET/POST/state/shell/t/escHtml/fmtTime/navigate/loading$/toast$/requestPasskeyGate)调用时解析。
//   安全姿态:配对只授 SAFE scope(只读/草稿,可撤销,短期,永不碰钱/投票/仲裁/密钥)。
//   反钓鱼:口令(user_code)是【必须核对】的安全值 —— 大号显示 + 强制"与 agent 屏幕一致"确认才解锁批准;label/reason 是 agent 自称,标注未验证。
//   未登录由 app.js 路由守卫拦截并存 webaz_intended_hash(含 ?code=),登录后跳回本页 —— 不丢 code。
;(function () {
  let _code = null

  function renderAgentPair(app) {
    if (!state.user) { app.innerHTML = shell(`<div class="empty">${t('请先登录以审核 agent 授权请求')}</div>`, 'me'); return }
    _code = (state._urlQuery && typeof state._urlQuery.code === 'string') ? state._urlQuery.code.trim().toUpperCase().slice(0, 32) : ''
    app.innerHTML = shell(`
      <div class="page-header"><h2>${t('🔗 授权 AI Agent')}</h2></div>
      <div style="font-size:12px;color:#6b7280;padding:0 4px 12px;line-height:1.6">${t('一个 AI agent 请求代表你执行【安全只读/草稿】操作。它拿到的是作用域受限、短期、可随时撤销的委托凭证 —— 不是你的账号或密钥,永远动不了资金、投票、仲裁或改密钥。')}</div>
      <div id="pair-body">${loading$()}</div>
    `, 'me')
    setTimeout(dpairHydrate, 30)
  }
  window.renderAgentPair = renderAgentPair

  async function dpairHydrate() {
    const box = document.getElementById('pair-body'); if (!box) return
    if (!_code || _code.length < 4) {   // 无 code / 手动输入路径(抗钓鱼正路:人对着 agent 屏幕输口令)
      box.innerHTML = `<div class="card" style="padding:16px">
        <div style="font-size:13px;margin-bottom:8px">${t('请输入你的 agent 屏幕上显示的配对口令:')}</div>
        <input id="pair-code-input" maxlength="32" placeholder="${t('配对口令')}" style="width:100%;font-size:16px;letter-spacing:2px;text-transform:uppercase;padding:10px;border:1px solid #d1d5db;border-radius:8px;text-align:center;font-family:monospace">
        <button class="btn btn-primary" style="width:100%;margin-top:10px" onclick="dpairSubmitCode()">${t('查看授权请求')}</button>
        <div style="font-size:11px;color:#9ca3af;margin-top:8px;line-height:1.6">${t('只输入你自己的 agent 显示给你的口令。不要输入别人发来的口令。')}</div>
      </div>`
      return
    }
    const r = await GET('/agent-grants/pair/' + encodeURIComponent(_code)).catch(() => null)
    if (!r || r.error) return void dpairShowError(r && (r.error_code || r.error))
    dpairRenderConsent(r.consent || {})
  }

  window.dpairSubmitCode = () => {
    const v = (document.getElementById('pair-code-input')?.value || '').trim().toUpperCase()
    if (v.length < 4) { toast$(t('请输入有效口令'), 'error'); return }
    _code = v; dpairHydrate()
  }

  function dpairShowError(codeOrMsg) {
    const box = document.getElementById('pair-body'); if (!box) return
    const map = {
      pairing_not_found: t('配对口令无效或不存在。请核对你的 agent 显示的口令。'),
      pairing_not_pending_or_expired: t('该配对请求已过期、已被处理或已失效。请让你的 agent 重新发起配对。'),
      pairing_not_pending: t('该配对请求已被处理或已失效。'),
    }
    const msg = map[codeOrMsg] || t('无法读取该配对请求,请重试。')
    box.innerHTML = `<div class="card" style="padding:16px;border:1px solid #fecaca;background:#fef2f2">
      <div style="font-size:14px;font-weight:600;color:#991b1b;margin-bottom:6px">⚠️ ${t('无法授权')}</div>
      <div style="font-size:13px;color:#7f1d1d;line-height:1.6">${escHtml(msg)}</div>
      <button class="btn btn-sm" style="margin-top:10px" onclick="navigate('#pair')">${t('手动输入口令')}</button>
    </div>`
  }

  function dpairRenderConsent(c) {
    const box = document.getElementById('pair-body'); if (!box) return
    const caps = Array.isArray(c.capabilities) ? c.capabilities : []
    const capHtml = caps.length
      ? caps.map(cap => `<span style="display:inline-block;font-size:11px;color:#4f46e5;background:#eef2ff;padding:2px 8px;border-radius:4px;margin:2px 4px 2px 0">${escHtml(String(cap.capability || cap))}</span>`).join('')
      : `<span style="font-size:12px;color:#9ca3af">${t('(无 —— 仅基础只读)')}</span>`
    box.innerHTML = `
      <div class="card" style="padding:16px;border:2px solid #c7d2fe;margin-bottom:12px">
        <div style="text-align:center;margin-bottom:12px">
          <div style="font-size:11px;color:#6b7280;margin-bottom:4px">${t('配对口令 —— 请核对与你的 agent 屏幕一致')}</div>
          <div style="font-size:28px;font-weight:800;letter-spacing:4px;font-family:monospace;color:#4338ca">${escHtml(String(_code))}</div>
        </div>
        <div style="font-size:12px;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px;line-height:1.6;margin-bottom:12px">
          ⚠️ <strong>${t('只在这个口令与你的 agent 屏幕显示的一致、且是你主动发起时才批准。')}</strong> ${t('如果这是别人发给你的链接,或你并没有在配对 agent —— 请拒绝。')}
        </div>
        <div style="font-size:13px;line-height:1.9">
          <div><span style="color:#6b7280">${t('Agent 自称')}:</span> <strong>${escHtml(c.agent_label || t('未命名'))}</strong> <span style="font-size:10px;color:#9ca3af">(${t('未验证')})</span></div>
          ${c.reason ? `<div><span style="color:#6b7280">${t('用途(agent 自述)')}:</span> ${escHtml(c.reason)} <span style="font-size:10px;color:#9ca3af">(${t('未验证')})</span></div>` : ''}
          <div style="margin-top:6px"><span style="color:#6b7280">${t('请求的权限')}:</span><div style="margin-top:4px">${capHtml}</div></div>
          <div style="font-size:11px;color:#9ca3af;margin-top:6px">${t('有效期至')} ${c.expires_at ? fmtTime(c.expires_at) : '—'}</div>
        </div>
        <label style="display:flex;align-items:flex-start;gap:8px;margin:14px 0 4px;font-size:12px;color:#374151;cursor:pointer">
          <input type="checkbox" id="pair-confirm" onchange="document.getElementById('pair-approve-btn').disabled=!this.checked" style="margin-top:2px">
          <span>${t('我确认这个口令与我的 agent 显示一致,且这是我本人主动发起的配对。')}</span>
        </label>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-outline" style="flex:1;color:#dc2626;border-color:#fecaca" onclick="dpairReject()">${t('拒绝')}</button>
          <button class="btn btn-primary" id="pair-approve-btn" disabled style="flex:2" onclick="dpairApprove()">🔑 ${t('用 Passkey 批准')}</button>
        </div>
      </div>`
  }

  window.dpairApprove = async () => {
    const btn = document.getElementById('pair-approve-btn'); if (btn) btn.disabled = true
    let token
    try { token = await requestPasskeyGate('agent_pair_approve', { user_code: _code }) }
    catch (e) { if (window.dpPromptRegisterPasskey && e && e.code === 'NO_PASSKEY_REGISTERED') { await window.dpPromptRegisterPasskey(e) } else { toast$((e && e.message) || t('Passkey 验证已取消'), 'error') } if (btn) btn.disabled = false; return }
    const r = await POST('/agent-grants/pair/' + encodeURIComponent(_code) + '/approve', { webauthn_token: token }).catch(() => null)
    if (!r || r.error) { toast$((r && r.error) || t('批准失败,请重试'), 'error'); if (btn) btn.disabled = false; return }
    dpairShowResult('approved', r)
  }

  window.dpairReject = async () => {
    if (!confirm(t('确认拒绝这个 agent 配对请求?'))) return
    const r = await POST('/agent-grants/pair/' + encodeURIComponent(_code) + '/reject', {}).catch(() => null)
    if (!r || r.error) { toast$((r && r.error) || t('操作失败'), 'error'); return }
    dpairShowResult('rejected', r)
  }

  function dpairShowResult(kind, r) {
    const box = document.getElementById('pair-body'); if (!box) return
    if (kind === 'approved') {
      const caps = Array.isArray(r.capabilities) ? r.capabilities : []
      box.innerHTML = `<div class="card" style="padding:20px;text-align:center;border:1px solid #bbf7d0;background:#f0fdf4">
        <div style="font-size:36px;margin-bottom:8px">✅</div>
        <div style="font-size:16px;font-weight:700;color:#166534;margin-bottom:6px">${t('已授权')}</div>
        <div style="font-size:12px;color:#374151;margin-bottom:10px">${t('该 agent 现在可用你批准的作用域了(短期、可随时撤销)。回到你的 agent 完成配对即可。')}</div>
        <div style="margin-bottom:12px">${caps.map(cap => `<span style="display:inline-block;font-size:11px;color:#4f46e5;background:#eef2ff;padding:2px 8px;border-radius:4px;margin:2px">${escHtml(String(cap.capability || cap))}</span>`).join('') || `<span style="font-size:11px;color:#9ca3af">${t('基础只读')}</span>`}</div>
        <button class="btn btn-primary" onclick="navigate('#agents')">${t('查看 / 撤销已连接的 Agent')}</button>
      </div>`
    } else {
      box.innerHTML = `<div class="card" style="padding:20px;text-align:center;border:1px solid #e5e7eb">
        <div style="font-size:36px;margin-bottom:8px">🚫</div>
        <div style="font-size:16px;font-weight:700;color:#374151;margin-bottom:6px">${t('已拒绝')}</div>
        <div style="font-size:12px;color:#6b7280;margin-bottom:12px">${t('该配对请求已被拒绝,不会签发任何凭证。')}</div>
        <button class="btn btn-outline btn-sm" onclick="navigate('#agents')">${t('已连接的 Agent')}</button>
      </div>`
    }
  }
})()
