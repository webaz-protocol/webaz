// WebAZ — Connected agents domain (RFC-020 PR-D2 / app-agents.js)
//
// Loaded as a CLASSIC script BEFORE app.js (index.html). Top-level functions are
// global; cross-file globals (GET/POST/state/shell/t/escHtml/fmtTime/navigate/
// loading$/alert$/toast) resolve at call time. No import/export.
//
// Human-facing security view: the list of delegation grants the human authorized
// for AI agents (RFC-020). Reads GET /api/agent-grants (scope/status/expiry +
// recent-use from the audit log, PR-D1) and revokes via the existing
// POST /api/agent-grants/:id/revoke. READ + revoke only — no money/order path,
// no grant issuance (that is the Passkey pairing flow), no risk scopes.

async function renderConnectedAgents(app) {
  if (!state.user) { app.innerHTML = shell(`<div class="empty">${t('请先登录')}</div>`, 'me'); return }
  app.innerHTML = shell(loading$(), 'me')
  const r = await GET('/agent-grants')
  if (r.error) { app.innerHTML = shell(alert$('error', r.error), 'me'); return }
  const grants = r.grants || []

  const body = grants.length === 0
    ? `<div class="empty" style="padding:40px 16px;text-align:center">
         <div style="font-size:32px;margin-bottom:8px">🔌</div>
         <div style="font-weight:600;margin-bottom:4px">${t('尚无已连接的 Agent')}</div>
         <div style="color:#9ca3af;font-size:12px">${t('AI agent 通过 webaz_pair 配对、经你 Passkey 批准后出现在这里')}</div>
       </div>`
    : grants.map(g => {
        const revoked = g.status === 'revoked'
        const expired = !revoked && !g.active
        const badge = revoked
          ? `<span style="font-size:11px;color:#6b7280;background:#f3f4f6;padding:2px 8px;border-radius:999px">${t('已撤销')}</span>`
          : expired
            ? `<span style="font-size:11px;color:#b45309;background:#fef3c7;padding:2px 8px;border-radius:999px">${t('已过期')}</span>`
            : `<span style="font-size:11px;color:#16a34a;background:#dcfce7;padding:2px 8px;border-radius:999px">${t('有效')}</span>`
        const caps = (g.capabilities || []).map(c => `<span style="font-size:10px;color:#4f46e5;background:#eef2ff;padding:1px 6px;border-radius:4px;margin-right:4px">${escHtml(String(c.capability || c))}</span>`).join('')
        const lastUsed = g.last_used_at
          ? `${t('最近使用')} ${fmtTime(g.last_used_at)} · ${g.use_count} ${t('次调用')}`
          : t('从未使用')
        return `<div class="card" style="margin-bottom:10px;padding:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div style="font-weight:600">${escHtml(g.agent_label || t('未命名 Agent'))}</div>
            ${badge}
          </div>
          <div style="margin-bottom:6px">${caps || `<span style="font-size:11px;color:#9ca3af">${t('仅安全只读权限')}</span>`}</div>
          <div style="font-size:11px;color:#9ca3af">${t('有效期至')} ${g.expires_at ? fmtTime(g.expires_at) : '—'}</div>
          <div style="font-size:11px;color:#9ca3af">${lastUsed}</div>
          ${revoked || expired ? '' : `<button class="btn btn-sm" style="margin-top:8px;color:#dc2626;border-color:#fecaca" onclick="revokeAgentGrant('${escHtml(g.grant_id)}')">${t('撤销访问')}</button>`}
        </div>`
      }).join('')

  app.innerHTML = shell(`
    <div class="page-header"><h2>${t('🔌 已连接的 Agent')}</h2></div>
    <div style="font-size:12px;color:#6b7280;padding:0 4px 12px">${t('这些是你授权给 AI agent 的委托凭证（作用域受限、短期、可随时撤销）。它们不是你的账号或密钥，永远无法动用资金、投票或改密钥。')}</div>
    ${body}
  `, 'me')
}

async function revokeAgentGrant(grantId) {
  if (!confirm(t('确认撤销此 Agent 的访问权限？该凭证将立即失效。'))) return
  const r = await POST(`/agent-grants/${grantId}/revoke`, {})
  if (r.error) { toast$(r.error, 'error'); return }
  toast$(t('已撤销该 Agent 的访问'))
  renderConnectedAgents(document.getElementById('app'))
}
