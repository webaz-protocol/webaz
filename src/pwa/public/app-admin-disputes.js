// admin 争议查看/管理 —— 可【区分】(状态 / 直付-托管 / 进度 / 是否已指派 / 如何结案 / 紧急度)+ 可【管理】(状态过滤 + 钻取查看)。
//   admin 只读监督(后端 disputes-read 允许 admin 查详情);裁定/驳回等【动作】仍须 active 白名单仲裁员(COI+指派)。中文 t(),英文 i18n.js。
window.renderAdminDisputes = async function (app, opts = {}) {
  if (!state.user) { renderLogin(); return }
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(loading$(), 'admin')
  const status = opts.status || ''
  const data = await GET('/admin/disputes' + (status ? `?status=${encodeURIComponent(status)}` : ''))
  if (data.error) { app.innerHTML = shell(alert$('error', data.error), 'admin'); return }
  const c = data.counts || {}
  const STATUS_META = { open: ['#fef3c7', '#92400e', t('待响应')], in_review: ['#fde68a', '#b45309', t('仲裁中')], resolved: ['#dcfce7', '#166534', t('已裁定')], dismissed: ['#e5e7eb', '#374151', t('已驳回')] }
  const tabs = [['', t('全部'), data.total || 0], ['open', t('待响应'), c.open || 0], ['in_review', t('仲裁中'), c.in_review || 0], ['resolved', t('已裁定'), c.resolved || 0], ['dismissed', t('已驳回'), c.dismissed || 0]]
  const tabHtml = tabs.map(([val, label, n]) => `<button class="btn btn-sm" style="width:auto;font-size:12px;background:${status === val ? '#4f46e5' : '#fff'};color:${status === val ? '#fff' : '#374151'};border:1px solid ${status === val ? '#4f46e5' : '#e5e7eb'}" onclick="renderAdminDisputes(document.getElementById('app'),{status:'${val}'})">${label} ${n}</button>`).join('')
  const railBadge = (rail) => rail === 'direct_p2p'
    ? `<span style="font-size:10px;background:#eff6ff;color:#1e40af;padding:1px 7px;border-radius:99px">${t('直付')}</span>`
    : `<span style="font-size:10px;background:#f0fdf4;color:#166534;padding:1px 7px;border-radius:99px">${t('托管')}</span>`
  const urgencyChip = (d) => {
    if (d.status !== 'open' && d.status !== 'in_review') return ''
    const dl = d.status === 'open' ? d.respond_deadline : d.arbitrate_deadline
    if (!dl) return ''
    const overdue = new Date(dl) < new Date()
    return `<span style="font-size:10px;background:${overdue ? '#fee2e2' : '#fff7ed'};color:${overdue ? '#991b1b' : '#9a3412'};padding:1px 7px;border-radius:99px">${overdue ? '⏰ ' + t('已超时') : '⏳ ' + fmtTime(dl)}</span>`
  }
  const assignChip = (d) => {
    let n = 0; try { n = (JSON.parse(d.assigned_arbitrators || '[]') || []).length } catch {}
    return `<span style="font-size:10px;background:${n ? '#ede9fe' : '#f3f4f6'};color:${n ? '#5b21b6' : '#9ca3af'};padding:1px 7px;border-radius:99px">${n ? '⚖ ' + t('已指派') : t('未指派')}</span>`
  }
  const verdictChip = (d) => (d.status === 'resolved' || d.status === 'dismissed') && d.ruling_type
    ? `<span style="font-size:10px;background:#f5f3ff;color:#6d28d9;padding:1px 7px;border-radius:99px">${(window.dpRulingLabel && window.dpRulingLabel(d.ruling_type)) || t(d.ruling_type)}</span>` : ''
  const list = (data.disputes || []).map(d => {
    const [bg, fg, lbl] = STATUS_META[d.status] || ['#e5e7eb', '#374151', d.status]
    return `<div class="card" style="margin-bottom:10px;font-size:13px;cursor:pointer" onclick="navigate('#dispute/${escHtml(d.id)}')">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(d.product_title || '—')}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml((d.reason || '').slice(0, 60))}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:6px">${t('原告')}: ${escHtml(d.initiator_name || '—')} → ${t('被告')}: ${escHtml(d.defendant_name || '—')}</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px">${railBadge(d.payment_rail)}${assignChip(d)}${urgencyChip(d)}${verdictChip(d)}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(d.id)} · ${fmtTime(d.created_at)}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0">
          <span style="background:${bg};color:${fg};padding:2px 8px;border-radius:8px;font-size:11px;white-space:nowrap">${lbl}</span>
          ${d.total_amount ? `<div style="font-size:12px;color:#374151;white-space:nowrap">${d.total_amount} WAZ</div>` : ''}
        </div>
      </div>
    </div>`
  }).join('') || `<div class="empty"><div class="empty-icon">⚖️</div><div class="empty-text">${t('暂无争议')}</div></div>`
  app.innerHTML = shell(`
    <h1 class="page-title">⚖️ ${t('争议查看')}</h1>
    <div style="margin-bottom:12px"><button class="btn btn-outline btn-sm" style="width:auto" onclick="navigate('#admin')">${t('返回概览')}</button></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${tabHtml}</div>
    <div style="font-size:11px;color:#9ca3af;margin-bottom:8px">${t('点卡片查看争议详情(只读监督;裁定须仲裁员)')}</div>
    ${list}
  `, 'admin')
}
