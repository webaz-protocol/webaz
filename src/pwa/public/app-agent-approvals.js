// RFC-020 — Agent 授权请求审批页(#agent-approvals)。一个已连接的 agent 请求【更多 SAFE 作用域 / 一个能力包】,
//   真人在这里审核并用 Passkey 批准或拒绝。批准 = 扩展该 agent 已有的委托凭证(仍只 SAFE、可撤销、按时长)。
//   经典脚本,全局函数;globals(GET/POST/state/shell/t/escHtml/fmtTime/navigate/loading$/toast$/requestPasskeyGate)调用时解析。
//   商家视角:不需要懂 scope/complete/verify —— 只看【哪个 agent · 要做什么 · 风险 · 多久】。批准需 Passkey(扩权=提权)。
;(function () {
  const RISK = {
    low:    { label: '低风险', color: '#16a34a', bg: '#dcfce7' },
    medium: { label: '中风险', color: '#b45309', bg: '#fef3c7' },
    high:   { label: '高风险', color: '#dc2626', bg: '#fee2e2' },
  }

  // Lightweight badge: fill #aa-pending-badge with a pending count (called from the account/settings page).
  async function hydrateAgentApprovalsBadge() {
    const el = document.getElementById('aa-pending-badge'); if (!el || !state.user) return
    const r = await GET('/agent-grants/permission-requests').catch(() => null)
    const n = (r && Array.isArray(r.requests)) ? r.requests.length : 0
    el.innerHTML = n > 0 ? `<span style="display:inline-block;min-width:16px;height:16px;line-height:16px;text-align:center;font-size:10px;color:#fff;background:#dc2626;border-radius:999px;padding:0 5px;margin-left:4px">${n}</span>` : ''
  }
  window.hydrateAgentApprovalsBadge = hydrateAgentApprovalsBadge

  function renderAgentApprovals(app) {
    if (!state.user) { app.innerHTML = shell(`<div class="empty">${t('请先登录以审核 agent 授权请求')}</div>`, 'me'); return }
    app.innerHTML = shell(`
      <div class="page-header"><h2>${t('🔔 Agent 授权请求')}</h2></div>
      <div style="font-size:12px;color:#6b7280;padding:0 4px 12px;line-height:1.6">${t('一个已连接的 AI agent 请求更多【安全只读/草稿】权限。批准只会扩展它已有的委托凭证 —— 仍然作用域受限、可随时撤销,永远动不了资金、投票、仲裁或改密钥。')}</div>
      <div id="aa-body">${loading$()}</div>
    `, 'me')
    setTimeout(aaHydrate, 30)
  }
  window.renderAgentApprovals = renderAgentApprovals

  async function aaHydrate() {
    const box = document.getElementById('aa-body'); if (!box) return
    const r = await GET('/agent-grants/permission-requests').catch(() => null)
    if (!r || r.error) { box.innerHTML = `<div class="card" style="padding:16px;color:#991b1b">${escHtml((r && r.error) || t('无法读取授权请求,请重试。'))}</div>`; return }
    const reqs = Array.isArray(r.requests) ? r.requests : []
    if (reqs.length === 0) {
      box.innerHTML = `<div class="empty" style="padding:40px 16px;text-align:center">
        <div style="font-size:32px;margin-bottom:8px">✅</div>
        <div style="font-weight:600;margin-bottom:4px">${t('暂无待处理的授权请求')}</div>
        <div style="color:#9ca3af;font-size:12px">${t('当你的 agent 请求更多权限时,会出现在这里等你批准。')}</div>
      </div>`
      return
    }
    box.innerHTML = reqs.map(aaCard).join('')
  }

  function aaCard(r) {
    const risk = RISK[r.risk_level] || RISK.low
    const scopes = Array.isArray(r.requested_scopes) ? r.requested_scopes : []
    // Prefer the human-readable bundle summary; otherwise show the individual safe-scope chips.
    const what = r.kind === 'order_action' ? (window.aaOrderWhat ? window.aaOrderWhat(r) : '') : r.kind === 'order_submit' ? (window.aaOrderSubmitWhat ? window.aaOrderSubmitWhat(r) : '') : r.human_summary
      ? `<div style="font-size:13px;color:#374151;line-height:1.7">${escHtml(r.human_summary)}</div>`
      : `<div style="margin-top:2px">${scopes.map(s => `<span style="display:inline-block;font-size:11px;color:#4f46e5;background:#eef2ff;padding:2px 8px;border-radius:4px;margin:2px 4px 2px 0">${escHtml(String(s))}</span>`).join('') || `<span style="font-size:12px;color:#9ca3af">${t('(无 —— 仅基础只读)')}</span>`}</div>`
    return `<div class="card" style="margin-bottom:12px;padding:16px;border:1px solid #e5e7eb" data-aa-id="${escHtml(String(r.id))}" data-aa-order-id="${escHtml(String(r.order_id||''))}" data-aa-action="${escHtml(String(r.order_action||''))}" data-aa-hash="${escHtml(String(r.params_hash||''))}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-weight:600">${escHtml(r.agent_label || t('未命名 Agent'))} <span style="font-size:10px;color:#9ca3af">(${t('未验证')})</span></div>
        <span style="font-size:11px;color:${risk.color};background:${risk.bg};padding:2px 8px;border-radius:999px">${t(risk.label)}</span>
      </div>
      <div style="font-size:11px;color:#6b7280;margin-bottom:2px">${t('它想做什么')}:</div>
      ${what}
      ${r.reason ? `<div style="font-size:12px;color:#6b7280;margin-top:8px">${t('用途(agent 自述)')}: ${escHtml(r.reason)} <span style="font-size:10px;color:#9ca3af">(${t('未验证')})</span></div>` : ''}
      ${window.grantDurationSelect(r.allowed_durations, r.duration, 'aa-dur-' + escHtml(String(r.id)))}
      <div style="font-size:11px;color:#9ca3af;margin-top:6px">${t('请求于')} ${r.created_at ? fmtTime(r.created_at) : '—'}</div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-outline" style="flex:1;color:#dc2626;border-color:#fecaca" onclick="aaReject('${escHtml(String(r.id))}')">${t('拒绝')}</button>
        <button class="btn btn-primary" style="flex:2" onclick="aaApprove('${escHtml(String(r.id))}')">🔑 ${t('用 Passkey 批准')}</button>
      </div>
    </div>`
  }

  window.aaApprove = async (id) => {
    const card = document.querySelector(`[data-aa-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`)
    const btn = card ? card.querySelector('.btn-primary') : null; if (btn) btn.disabled = true
    let token
    // Passkey bound to THIS request (a token minted for request A can't approve B — server re-validates).
    try { token = await requestPasskeyGate('agent_permission_approve', { request_id: id, order_id: (card && card.dataset.aaOrderId) || undefined, action: (card && card.dataset.aaAction) || undefined, params_hash: (card && card.dataset.aaHash) || undefined }) }
    catch (e) { if (window.dpPromptRegisterPasskey && e && e.code === 'NO_PASSKEY_REGISTERED') { await window.dpPromptRegisterPasskey(e) } else { toast$((e && e.message) || t('Passkey 验证已取消'), 'error') } if (btn) btn.disabled = false; return }
    const r = await POST('/agent-grants/permission-requests/' + encodeURIComponent(id) + '/approve', { webauthn_token: token, duration: window.grantDurationValue('aa-dur-' + id) }).catch(() => null)
    if (!r || r.error) { toast$((r && r.error) || t('批准失败,请重试'), 'error'); if (btn) btn.disabled = false; return }
    toast$(t('已批准 —— 该 agent 的权限已扩展'))
    aaHydrate(); hydrateAgentApprovalsBadge()
  }

  window.aaReject = async (id) => {
    if (!confirm(t('确认拒绝这个授权请求?'))) return
    const r = await POST('/agent-grants/permission-requests/' + encodeURIComponent(id) + '/reject', {}).catch(() => null)
    if (!r || r.error) { toast$((r && r.error) || t('操作失败'), 'error'); return }
    toast$(t('已拒绝该授权请求'))
    aaHydrate(); hydrateAgentApprovalsBadge()
  }
})()
