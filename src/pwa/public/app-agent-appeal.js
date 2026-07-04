// 被封用户申诉页 + admin strike 审批页(Tina 案补齐 UI)。UI ONLY —— 申诉/裁决边界全在后端;
//   被封状态下只调两个封禁豁免端点(GET /api/me/agents、POST .../strikes/:id/appeal)。
;(function () {
  const SEV = () => ({ warning: t('警告'), suspend_7d: t('暂停 7 天'), permanent: t('永久封禁') })
  const APL = () => ({ none: t('未申诉'), pending: t('申诉审核中'), approved: t('申诉通过(已解封)'), denied: t('申诉被驳回') })

  // ── 被封用户:极简申诉页(登录检测到 AGENT_BLOCKED 时进入;key 已在 state.apiKey)──
  window.renderAgentBlockedAppeal = async (blockMsg) => {
    const app = document.getElementById('app')
    app.innerHTML = `<div style="max-width:560px;margin:40px auto;padding:0 16px">
      <h1 style="font-size:18px;font-weight:700;margin-bottom:8px">🚫 ${t('账号处于暂停期')}</h1>
      <div class="alert alert-error" style="margin-bottom:12px">${escHtml(blockMsg || '')}</div>
      <div id="appeal-box">${loading$()}</div></div>`
    const r = await GET('/me/agents').catch(() => null)
    const box = document.getElementById('appeal-box')
    if (!r || !Array.isArray(r.items)) { box.innerHTML = `<div class="alert alert-error">${t('加载失败,请重试(确认 key 完整)')}</div>`; return }
    const strikes = r.items.flatMap(a => (a.recent_strikes || []))
    const active = strikes.find(s => ['suspend_7d', 'permanent'].includes(s.severity) && s.appeal_status !== 'approved')
    if (!active) { box.innerHTML = `<div class="alert alert-info">${t('未发现生效中的封禁,请重新登录试试')}</div>`; return }
    const S = SEV(); const A = APL()
    box.innerHTML = `
      <div class="card" style="font-size:13px">
        <div><strong>${S[active.severity] || active.severity}</strong> · ${escHtml(active.reason_code)}${active.reason_detail ? `(${escHtml(active.reason_detail)})` : ''}</div>
        <div style="color:#6b7280;margin-top:4px">${t('签发')}:${fmtTime(active.issued_at)}${active.expires_at ? ` · ${t('到期自动解除')}:${fmtTime(active.expires_at)}` : ''}</div>
        <div style="margin-top:4px">${t('申诉状态')}:<strong>${A[active.appeal_status] || active.appeal_status}</strong></div>
      </div>
      ${active.appeal_status === 'none' ? `
      <textarea class="form-control" id="appeal-reason" rows="3" maxlength="500" placeholder="${t('申诉理由(≥10 字;说明误触发原因,如页面挂机轮询/误操作)')}" style="margin:10px 0;font-size:13px"></textarea>
      <button class="btn btn-primary" style="width:100%" onclick="agentAppealSubmit(${active.id})">${t('提交申诉(等待管理员审核)')}</button>`
      : active.appeal_status === 'pending' ? `<div class="alert alert-info" style="margin-top:10px">${t('申诉已提交,等待管理员审核;审核通过后重新登录即可。')}</div>`
      : active.appeal_status === 'denied' ? `<div class="alert alert-error" style="margin-top:10px">${t('申诉被驳回;封禁将按期自动解除。')}</div>` : ''}
      <button class="btn btn-outline btn-sm" style="width:100%;margin-top:10px" onclick="state.apiKey=null;location.reload()">${t('退出(换个账号登录)')}</button>`
  }
  window.agentAppealSubmit = async (strikeId) => {
    const reason = (document.getElementById('appeal-reason')?.value || '').trim()
    if (reason.length < 10) return void toast$(t('申诉理由 ≥10 字'), 'error')
    const r = await POST(`/me/agents/strikes/${strikeId}/appeal`, { reason })
    if (r.error) return void toast$(r.error, 'error')
    toast$(t('申诉已提交'), 'success'); window.renderAgentBlockedAppeal('')
  }

  // ── admin:#admin/agent-strikes 待审队列 + 裁决 + 主动 issue ──
  window.renderAdminAgentStrikes = function (app) {
    if (!state.user) { renderLogin(); return }
    if (typeof isAdmin === 'function' && !isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
    if ((state.user.admin_type || 'root') !== 'root') { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限根管理员')}</div>`, 'admin'); return }
    app.innerHTML = shell(`
      <h1 class="page-title">🚦 ${t('Agent 封禁与申诉')}</h1>
      <div style="font-size:12px;color:#6b7280;margin-bottom:10px">${t('申诉批准=立即解封(60 秒缓存内生效);驳回=按期自动解除。真人(绑 Passkey)已豁免速率封禁,此页主要处理 agent 与历史误封。')}</div>
      <div id="strike-adm-box">${loading$()}</div>
      <h2 style="font-size:14px;font-weight:700;margin:16px 0 8px">${t('主动签发 strike(慎用)')}</h2>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
        <input class="form-control" id="stk-key" placeholder="api_key" style="flex:2;min-width:160px;font-size:12px">
        <input class="form-control" id="stk-reason" placeholder="${t('reason_code(如 spam / fake_shipment)')}" style="flex:1;min-width:120px;font-size:12px">
        <select class="form-control" id="stk-sev" style="width:auto;font-size:12px"><option value="warning">warning</option><option value="suspend_7d">suspend_7d</option><option value="permanent">permanent</option></select>
        <button class="btn btn-outline btn-sm" style="width:auto;font-size:11px" onclick="adminStrikeIssue()">${t('签发')}</button>
      </div>`, 'admin')
    window.adminStrikesHydrate()
  }
  window.adminStrikesHydrate = async () => {
    const box = document.getElementById('strike-adm-box'); if (!box) return
    const r = await GET('/admin/agent-strikes/pending').catch(() => null)
    const items = (r && r.items) || []
    const S = SEV()
    box.innerHTML = items.length === 0 ? `<div class="alert alert-info">${t('暂无待审申诉')}</div>` : items.map(i => `
      <div class="card" style="font-size:12px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div><strong>@${escHtml(i.handle || i.user_id)}</strong> · ${S[i.severity] || i.severity} · ${escHtml(i.reason_code)}</div>
          <div style="color:#6b7280">${fmtTime(i.issued_at)}</div>
        </div>
        ${i.reason_detail ? `<div style="color:#6b7280;margin-top:4px">${t('签发详情')}:${escHtml(i.reason_detail)}</div>` : ''}
        <div style="margin-top:6px;padding:8px;background:#f9fafb;border-radius:6px">💬 ${t('申诉理由')}:${escHtml(i.appeal_reason || '-')}</div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-primary btn-sm" style="width:auto;font-size:11px" onclick="adminStrikeDecide(${i.id},'approved')">${t('批准(立即解封)')}</button>
          <button class="btn btn-outline btn-sm" style="width:auto;font-size:11px;color:#dc2626;border-color:#fecaca" onclick="adminStrikeDecide(${i.id},'denied')">${t('驳回')}</button>
        </div>
      </div>`).join('')
  }
  window.adminStrikeDecide = async (id, decision) => {
    const r = await POST(`/admin/agent-strikes/${id}/decide`, { decision })
    if (r.error) return void toast$(r.error, 'error')
    toast$(decision === 'approved' ? t('已批准,60 秒内解封') : t('已驳回'), 'success'); window.adminStrikesHydrate()
  }
  window.adminStrikeIssue = async () => {
    if (typeof confirmModal === 'function' && !(await confirmModal(t('确认签发 strike?suspend_7d/permanent 将立即阻断该 key 的所有访问。'), t('签发'), { danger: true }))) return
    const r = await POST('/admin/agent-strikes/issue', { api_key: (document.getElementById('stk-key')?.value || '').trim(), reason_code: (document.getElementById('stk-reason')?.value || '').trim(), severity: document.getElementById('stk-sev')?.value })
    if (r.error) return void toast$(r.error, 'error')
    toast$(t('已签发'), 'success')
  }
})()
