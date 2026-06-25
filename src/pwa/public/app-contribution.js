// WebAZ — contribution / admin-intake workflows (classic multi-script split, slice D)
//
// Loaded as a CLASSIC script in this order (index.html):
//   i18n → app-admin → app-contribution → app-ai → app-discover → app-profile → app-account → app-shop → app-listings → app-seller → app.js (source of truth: index.html)
// Top-level function declarations are global; window.* handlers are global; the
// blocks here run only on route/click (after app.js loads), so cross-file globals
// (GET/POST/api/state/escHtml/requestPasskeyGate/render*/toast$/...) resolve at
// call time. No import/export.
//
// NB: `_qT` is declared `var` (not const) here so it is a global property — the
// contribution-facts read surface in app.js also uses _qT, so it must be shared
// cross-file. _qStatusBadge / _ocStatusBadge are used only within this file and
// stay file-local.
//
// Pure relocation: public-ideas intake, task-proposal inbox/draft flow,
// build-task quota request/review, and operator-claim workflow. No money/order/
// payment/wallet/settlement/fund/protocol-param path.

// Wave F-1: 协议指标看板
// 2026-05-25 admin 查看 #welcome 提交：sub-tab 切换 建议 / 邮箱订阅（独立表）
async function renderAdminPublicIdeas(app) {
  if (!state.user) { renderLogin(); return }
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(loading$(), 'admin')
  const tab = state._adminIdeasTab || 'ideas'   // 'ideas' | 'emails'
  const stat = state._adminIdeasStatus || ''
  const showUnsub = !!state._adminIdeasShowUnsub
  const estat = state._adminEmailStatus || ''   // 申请处理状态过滤：pending/contacted/invited/done
  const qs = new URLSearchParams()
  if (stat && tab === 'ideas') qs.set('status', stat)
  if (showUnsub && tab === 'emails') qs.set('include_unsubscribed', '1')
  if (estat && tab === 'emails') qs.set('handle_status', estat)
  const url = tab === 'emails' ? '/admin/email-subscriptions' : '/admin/public-ideas'
  const r = await GET(url + (qs.toString() ? '?' + qs.toString() : ''))
  if (r.error) { app.innerHTML = shell(alert$('error', r.error), 'admin'); return }
  const items = r.items || []
  const c = r.counts || {}

  const chip = (val, label, current, group) =>
    `<button onclick="setAdminIdeasFilter('${group}','${val}')" style="padding:5px 12px;border-radius:99px;font-size:11px;cursor:pointer;border:1px solid ${current===val?'#6366f1':'#e5e7eb'};background:${current===val?'#eef2ff':'#fff'};color:${current===val?'#4338ca':'#6b7280'};font-weight:600">${label}</button>`

  const statusBadge = (s) => {
    const cfg = {
      new:      { bg: '#fef3c7', fg: '#92400e', label: t('新') },
      triaged:  { bg: '#dbeafe', fg: '#1e40af', label: t('已查看') },
      resolved: { bg: '#dcfce7', fg: '#166534', label: t('已处理') },
      spam:     { bg: '#fee2e2', fg: '#991b1b', label: t('Spam') },
    }[s] || { bg: '#f3f4f6', fg: '#6b7280', label: s }
    return `<span style="font-size:10px;background:${cfg.bg};color:${cfg.fg};padding:2px 8px;border-radius:99px;font-weight:600">${cfg.label}</span>`
  }

  const subTab = (k, label, n) =>
    `<button onclick="setAdminIdeasFilter('tab','${k}')" style="flex:1;padding:10px;border:1px solid ${tab===k?'#6366f1':'#e5e7eb'};background:${tab===k?'#eef2ff':'#fff'};color:${tab===k?'#4338ca':'#6b7280'};border-radius:8px;cursor:pointer;font-size:13px;font-weight:600">${label} <span style="color:${tab===k?'#6366f1':'#9ca3af'};font-weight:400">(${n})</span></button>`

  // 计数（两 tab 各显示自身的 counts）
  const counts = tab === 'emails'
    ? [
        { l: t('全部'), v: c.total || 0, color: '#6b7280' },
        { l: t('待处理'), v: c.st_pending || 0, color: '#d97706' },
        { l: t('已联系'), v: c.st_contacted || 0, color: '#1e40af' },
        { l: t('已邀请'), v: c.st_invited || 0, color: '#7c3aed' },
        { l: t('已完成'), v: c.st_done || 0, color: '#16a34a' },
      ]
    : [
        { l: t('全部'), v: c.total || 0, color: '#6b7280' },
        { l: t('待处理'), v: c.st_new || 0, color: '#d97706' },
        { l: t('已查看'), v: c.st_triaged || 0, color: '#1e40af' },
        { l: t('已处理'), v: c.st_resolved || 0, color: '#16a34a' },
        { l: 'Spam', v: c.st_spam || 0, color: '#dc2626' },
      ]

  app.innerHTML = shell(`
    <div style="padding:14px;max-width:920px;margin:0 auto">
      <h1 class="page-title">📨 ${t('Welcome 提交（邮箱订阅 + 留言/建议）')}</h1>
      <div style="font-size:11px;color:#9ca3af;margin-bottom:12px">⚠️ ${t('PII 数据：查看本页将被审计记录。请勿截屏外传。')}</div>

      <div style="display:flex;gap:8px;margin-bottom:14px">
        ${subTab('ideas',  '💬 ' + t('建议'), c.total || 0)}
        ${subTab('emails', '📧 ' + t('邮箱订阅'), 0)}
      </div>

      <div style="display:grid;grid-template-columns:repeat(${counts.length},1fr);gap:8px;margin-bottom:14px">
        ${counts.map(s => `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:10px;text-align:center"><div style="font-size:18px;font-weight:700;color:${s.color}">${s.v}</div><div style="font-size:10px;color:#9ca3af;margin-top:2px">${s.l}</div></div>`).join('')}
      </div>

      ${tab === 'emails' ? `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
          <div style="font-size:11px;color:#6b7280;margin-right:4px">${t('处理状态')}：</div>
          ${chip('',          t('全部'),   estat, 'estatus')}
          ${chip('pending',   t('待处理'), estat, 'estatus')}
          ${chip('contacted', t('已联系'), estat, 'estatus')}
          ${chip('invited',   t('已邀请'), estat, 'estatus')}
          ${chip('done',      t('已完成'), estat, 'estatus')}
        </div>
        <div style="margin-bottom:14px">
          <label style="font-size:12px;color:#6b7280;cursor:pointer">
            <input type="checkbox" ${showUnsub?'checked':''} onchange="setAdminIdeasFilter('show-unsub',this.checked?'1':'')" style="margin-right:6px;vertical-align:middle">
            ${t('显示已退订')}
          </label>
        </div>
      ` : `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
          <div style="font-size:11px;color:#6b7280;align-self:center;margin-right:4px">${t('状态')}：</div>
          ${chip('',         t('全部'), stat, 'status')}
          ${chip('new',      t('待处理'), stat, 'status')}
          ${chip('triaged',  t('已查看'), stat, 'status')}
          ${chip('resolved', t('已处理'), stat, 'status')}
          ${chip('spam',     'Spam',      stat, 'status')}
        </div>
      `}

      ${items.length === 0 ? `<div class="empty" style="padding:40px;text-align:center;color:#9ca3af">${t('暂无记录')}</div>` : tab === 'emails' ? (() => {
        const roleLabel = { buyer: t('买家'), seller: t('卖家'), creator: t('创作者'), verifier: t('审核员'), arbitrator: t('仲裁员'), other: t('其他') }
        const roleColor = { buyer: '#0891b2', seller: '#d97706', creator: '#7c3aed', verifier: '#16a34a', arbitrator: '#dc2626', other: '#6b7280' }
        const ES = {
          pending:   { label: t('待处理'), bg: '#fef3c7', fg: '#92400e' },
          contacted: { label: t('已联系'), bg: '#dbeafe', fg: '#1e40af' },
          invited:   { label: t('已邀请'), bg: '#ede9fe', fg: '#6d28d9' },
          done:      { label: t('已完成'), bg: '#dcfce7', fg: '#166534' },
        }
        const estSwitch = (it) => {
          const cur = it.handle_status || 'pending'
          const btns = ['pending', 'contacted', 'invited', 'done'].map(s => {
            const on = s === cur
            return `<button onclick="setEmailHandleStatus('${it.id}','${s}')" style="padding:3px 9px;border-radius:99px;font-size:10px;cursor:pointer;border:1px solid ${on ? ES[s].fg : '#e5e7eb'};background:${on ? ES[s].bg : '#fff'};color:${on ? ES[s].fg : '#9ca3af'};font-weight:${on ? 600 : 400}">${ES[s].label}</button>`
          }).join('')
          return `<div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid #f3f4f6"><span style="font-size:10px;color:#9ca3af;margin-right:2px">${t('处理')}：</span>${btns}</div>`
        }
        return items.map(it => `
        <div class="card" style="padding:14px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px">
            <div style="flex:1;min-width:0;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <code style="font-size:13px;background:#f3f4f6;padding:3px 8px;border-radius:4px;color:#18181B">${escHtml(it.email)}</code>
              ${it.role_preference ? `<span style="font-size:10px;background:#fff;color:${roleColor[it.role_preference]||'#6b7280'};border:1px solid ${roleColor[it.role_preference]||'#e5e7eb'};padding:2px 8px;border-radius:99px;font-weight:600">${roleLabel[it.role_preference] || it.role_preference}</span>` : `<span style="font-size:10px;color:#9ca3af">${t('未选身份')}</span>`}
              ${it.unsubscribed_at
                ? `<span style="font-size:10px;background:#f3f4f6;color:#9ca3af;padding:2px 8px;border-radius:99px">${t('已退订')}</span>`
                : `<span style="font-size:10px;background:#dcfce7;color:#166534;padding:2px 8px;border-radius:99px;font-weight:600">${t('订阅中')}</span>`}
            </div>
            <button class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 10px;flex-shrink:0" onclick="navigator.clipboard?.writeText('${escAttr(it.email)}').then(()=>toast('${t('已复制')}'))">${t('复制')}</button>
          </div>
          ${it.note ? `<div style="font-size:12px;color:#374151;line-height:1.6;white-space:pre-wrap;word-break:break-word;background:#f9fafb;padding:8px 10px;border-radius:6px;margin-bottom:6px">💬 ${escHtml(it.note)}</div>` : ''}
          <div style="font-size:11px;color:#9ca3af">${it.source} · ${fmtTime(it.consent_at)}${it.user_id ? ' · 👤 ' + it.user_id.slice(0,12) : ''}${it.unsubscribed_at ? ' · ' + t('退订于') + ' ' + fmtTime(it.unsubscribed_at) : ''}</div>
          ${estSwitch(it)}
        </div>`).join('')
      })() : items.map(it => `
          <div class="card" style="padding:14px;margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px">
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                <span style="font-size:11px;background:#ecfeff;color:#0891b2;padding:2px 8px;border-radius:99px;font-weight:600">💬 ${t('建议')}</span>
                ${statusBadge(it.status)}
                <span style="font-size:11px;color:#9ca3af">${fmtTime(it.created_at)}</span>
                ${it.user_id ? `<span style="font-size:11px;color:#6366f1">👤 <a href="#admin/users/${it.user_id}" style="color:inherit">${it.user_id.slice(0,12)}</a></span>` : `<span style="font-size:11px;color:#9ca3af">${t('匿名')}</span>`}
              </div>
            </div>
            <div style="font-size:13px;color:#1f2937;line-height:1.6;white-space:pre-wrap;word-break:break-word;background:#f9fafb;padding:10px 12px;border-radius:6px;margin-bottom:8px">${escHtml(it.content)}</div>
            ${it.contact ? `<div style="font-size:12px;color:#6b7280;margin-bottom:8px">📞 ${t('联系方式')}：<code style="background:#f3f4f6;padding:2px 6px;border-radius:4px">${escHtml(it.contact)}</code></div>` : ''}
            <div style="display:flex;gap:6px;font-size:11px">
              <button class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 10px" onclick="setAdminIdeaStatus('${it.id}','triaged')">${t('标记已查看')}</button>
              <button class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 10px;color:#16a34a;border-color:#bbf7d0" onclick="setAdminIdeaStatus('${it.id}','resolved')">${t('标记已处理')}</button>
              <button class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 10px;color:#dc2626;border-color:#fecaca" onclick="setAdminIdeaStatus('${it.id}','spam')">${t('标 Spam')}</button>
            </div>
          </div>`
      ).join('')}
    </div>
  `, 'admin')
}
window.setAdminIdeasFilter = (group, val) => {
  if (group === 'tab') { state._adminIdeasTab = val; state._adminIdeasStatus = ''; state._adminIdeasShowUnsub = false; state._adminEmailStatus = '' }
  else if (group === 'status') state._adminIdeasStatus = val
  else if (group === 'estatus') state._adminEmailStatus = val
  else if (group === 'show-unsub') state._adminIdeasShowUnsub = !!val
  renderAdminPublicIdeas(document.getElementById('app'))
}
window.setEmailHandleStatus = async (id, status) => {
  const r = await api('PATCH', `/admin/email-subscriptions/${id}/status`, { status })
  if (r?.error) { toast$(r.error, 'error'); return }
  toast$(t('已更新'))
  setTimeout(() => renderAdminPublicIdeas(document.getElementById('app')), 300)
}
window.setAdminIdeaStatus = async (id, status) => {
  const r = await api('PATCH', `/admin/public-ideas/${id}`, { status })
  if (r?.error) { toast(r.error); return }
  toast(t('已更新'))
  setTimeout(() => renderAdminPublicIdeas(document.getElementById('app')), 300)
}

// PR9I — Task Proposal Inbox admin review (maintainer-only). Calls the #331 admin endpoints. A proposal is
// a SUGGESTION, never a contribution fact / reward / participation; "Convert" only records the review
// decision + the proposer→reviewer→ref evidence chain — it does NOT auto-create a build_task.
async function renderAdminTaskProposals(app) {
  if (!state.user) { renderLogin(); return }
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  const en = window._lang === 'en'
  const T = (zh, e) => en && e ? e : zh
  app.innerHTML = shell(loading$(), 'admin')
  const sf = state._proposalStatus || ''   // '' | new | needs_info | rejected | converted
  const [r, dr] = await Promise.all([
    GET('/admin/task-proposals' + (sf ? '?status=' + encodeURIComponent(sf) : '')),
    GET('/admin/build-task-drafts'),
  ])
  if (r.error) { app.innerHTML = shell(alert$('error', r.error), 'admin'); return }
  const proposals = r.proposals || []
  const drafts = (dr && dr.drafts) || []
  const draftedIds = new Set(drafts.map((d) => d.source_proposal_id).filter(Boolean))   // proposals that already have an unpublished draft
  const notice = en ? (r.value_boundary?.notice_en || '') : (r.value_boundary?.notice_zh || '')
  const STATUS = {
    new:        { bg: '#fef3c7', fg: '#92400e', label: T('待审', 'New') },
    needs_info: { bg: '#dbeafe', fg: '#1e40af', label: T('待补充', 'Needs info') },
    rejected:   { bg: '#fee2e2', fg: '#991b1b', label: T('已拒绝', 'Rejected') },
    converted:  { bg: '#dcfce7', fg: '#166534', label: T('已转任务', 'Converted') },
  }
  const badge = (s) => { const c = STATUS[s] || { bg: '#f3f4f6', fg: '#6b7280', label: s }; return `<span style="font-size:10px;background:${c.bg};color:${c.fg};padding:2px 8px;border-radius:99px;font-weight:600">${c.label}</span>` }
  const chip = (val, label) => `<button onclick="setProposalStatusFilter('${val}')" style="padding:5px 12px;border-radius:99px;font-size:11px;cursor:pointer;border:1px solid ${sf === val ? '#6366f1' : '#e5e7eb'};background:${sf === val ? '#eef2ff' : '#fff'};color:${sf === val ? '#4338ca' : '#6b7280'};font-weight:600">${label}</button>`
  const field = (label, val) => val ? `<div style="font-size:12px;color:#374151;margin-top:4px"><b>${label}:</b> ${escHtml(String(val))}</div>` : ''
  // inline "create formal task draft" form (prefilled from the proposal; AI can also prefill it). All list
  // fields are newline-separated. These are the agent-handoff fields the formal task model requires.
  const ta = (id, ph, val, h) => `<textarea id="${id}" placeholder="${ph}" style="width:100%;box-sizing:border-box;min-height:${h || 38}px;padding:6px 8px;border:1px solid #d4d4d8;border-radius:6px;font-size:12px;margin-top:6px">${val ? escHtml(String(val)) : ''}</textarea>`
  const draftForm = (p) => `<div id="df-${escHtml(p.id)}" style="display:none;margin-top:10px;border:1px dashed #c7d2fe;background:#f5f7ff;border-radius:8px;padding:10px">
      <div style="font-size:11px;color:#4338ca;font-weight:600;margin-bottom:2px">${T('建正式任务草稿(未发布)', 'Create formal task draft (unpublished)')}</div>
      <div style="font-size:10px;color:#6b7280;margin-bottom:4px">${T('草稿默认隐藏不可认领;填齐 agent 交接字段后由人工显式「发布」才进任务板。', 'A draft is hidden + unclaimable; only an explicit human “Publish” (after the agent-handoff fields are filled) puts it on the board.')}</div>
      ${ta('df-title-' + escHtml(p.id), T('标题', 'Title'), p.title)}
      ${ta('df-area-' + escHtml(p.id), T('领域(可选)', 'Area (optional)'), p.suggested_area, 30)}
      ${ta('df-source-' + escHtml(p.id), T('来源引用(文件 / RFC / issue,可选)', 'Source ref (file / RFC / issue, optional)'), p.source_ref, 30)}
      ${ta('df-desc-' + escHtml(p.id), T('说明 / 原因', 'Summary / reason'), p.summary, 48)}
      ${ta('df-allowed-' + escHtml(p.id), T('允许路径(每行一条)', 'Allowed paths (one per line)'), '')}
      ${ta('df-fpaths-' + escHtml(p.id), T('禁止路径(每行一条)', 'Forbidden paths (one per line)'), '')}
      ${ta('df-forbidden-' + escHtml(p.id), T('禁止动作(每行一条)', 'Forbidden actions (one per line)'), '')}
      ${ta('df-accept-' + escHtml(p.id), T('验收标准(每行一条)', 'Acceptance criteria (one per line)'), p.expected_outcome)}
      ${ta('df-verify-' + escHtml(p.id), T('验证命令(每行一条)', 'Verification commands (one per line)'), '')}
      ${ta('df-deliver-' + escHtml(p.id), T('交付物(每行一条)', 'Deliverables (one per line)'), '')}
      ${ta('df-dod-' + escHtml(p.id), T('完成定义', 'Definition of done'), '')}
      ${ta('df-expect-' + escHtml(p.id), T('预期结果(留空则用说明)', 'Expected results (blank = use summary)'), '')}
      <button onclick="createTaskDraft('${escHtml(p.id)}')" style="margin-top:8px;padding:7px 14px;border:none;background:#4338ca;color:#fff;border-radius:6px;font-size:12px;cursor:pointer;font-weight:600">${T('保存草稿', 'Save draft')}</button>
    </div>`
  const row = (p) => {
    const terminal = p.status === 'rejected' || p.status === 'converted'
    return `<div class="card" style="padding:14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <div style="font-weight:600;font-size:14px">${escHtml(p.title)}</div>${badge(p.status)}
      </div>
      <div style="font-family:monospace;font-size:11px;color:#6b7280;margin-top:3px">${T('案件 ID', 'Case ID')}: ${escHtml(p.case_id || p.id)}</div>
      <div style="font-size:13px;color:#52525B;line-height:1.5;margin-top:6px;white-space:pre-wrap">${escHtml(p.summary)}</div>
      ${field(T('建议领域', 'Area'), p.suggested_area)}
      ${field(T('预期结果', 'Outcome'), p.expected_outcome)}
      ${field(T('参考', 'Source ref'), p.source_ref)}
      ${field('GitHub', p.proposer_github_login)}
      ${field(T('提交时间', 'Created'), p.created_at)}
      ${field(T('审阅备注', 'Review note'), p.review_note)}
      ${field(T('已关联', 'Converted ref'), p.converted_ref)}
      ${terminal
        ? `<div style="font-size:11px;color:#9ca3af;margin-top:8px">${T('终态,不可再审', 'Terminal — locked')}${p.reviewer_id ? ' · ' + escHtml(String(p.reviewer_id)) : ''}</div>`
        : `<div style="margin-top:10px;border-top:1px solid #f1f1f4;padding-top:10px">
            <textarea id="pr-note-${escHtml(p.id)}" placeholder="${T('审阅备注(可选)', 'Review note (optional)')}" style="width:100%;box-sizing:border-box;min-height:44px;padding:6px 8px;border:1px solid #d4d4d8;border-radius:6px;font-size:12px"></textarea>
            <input id="pr-ref-${escHtml(p.id)}" placeholder="${T('转任务时:关联正式 task / PR / release(可选)', 'On convert: link the real task / PR / release (optional)')}" style="width:100%;box-sizing:border-box;margin-top:6px;padding:6px 8px;border:1px solid #d4d4d8;border-radius:6px;font-size:12px">
            <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
              <button onclick="aiAssistProposal('${escHtml(p.id)}')" style="padding:6px 12px;border:1px solid #8b5cf6;background:#fff;color:#6d28d9;border-radius:6px;font-size:12px;cursor:pointer">🤖 ${T('AI 建议', 'AI suggest')}</button>
              ${draftedIds.has(p.id)
                ? `<span style="padding:6px 10px;font-size:11px;color:#4338ca;background:#eef2ff;border-radius:6px">📝 ${T('已建草稿(在上方草稿区发布;发布即接受)', 'Draft created — publish it in the drafts panel above (publish = accept)')}</span>`
                : `<button onclick="toggleDraftForm('${escHtml(p.id)}')" style="padding:6px 12px;border:1px solid #6366f1;background:#fff;color:#4338ca;border-radius:6px;font-size:12px;cursor:pointer">${T('建任务草稿', 'Create task draft')}</button>
              <button onclick="reviewProposal('${escHtml(p.id)}','needs_info')" style="padding:6px 12px;border:1px solid #3b82f6;background:#fff;color:#1e40af;border-radius:6px;font-size:12px;cursor:pointer">${T('需补充', 'Needs info')}</button>
              <button onclick="reviewProposal('${escHtml(p.id)}','rejected')" style="padding:6px 12px;border:1px solid #ef4444;background:#fff;color:#991b1b;border-radius:6px;font-size:12px;cursor:pointer">${T('拒绝', 'Reject')}</button>
              <button onclick="reviewProposal('${escHtml(p.id)}','converted')" style="padding:6px 12px;border:1px solid #16a34a;background:#fff;color:#166534;border-radius:6px;font-size:12px;cursor:pointer">${T('仅记审阅决定', 'Mark reviewed')}</button>`}
            </div>
            <div id="ai-${escHtml(p.id)}"></div>
            ${draftedIds.has(p.id) ? '' : draftForm(p)}
          </div>`}
    </div>`
  }
  const draftRow = (d) => `<div class="card" style="padding:12px;margin-bottom:8px;border-left:3px solid #6366f1">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <div style="font-weight:600;font-size:13px">${escHtml(d.title)}</div>
        <span style="font-size:10px;background:#eef2ff;color:#4338ca;padding:2px 8px;border-radius:99px;font-weight:600">${T('未发布草稿', 'Unpublished draft')}</span>
      </div>
      ${field(T('风险', 'Risk'), d.risk_level)}${field(T('可自助认领', 'Auto-claimable'), d.auto_claimable === 1 || d.auto_claimable === true ? T('是', 'yes') : T('否(需真人)', 'no (human)'))}
      ${field(T('来源建议', 'Source proposal'), d.source_proposal_id)}${field(T('创建人', 'Created by'), d.created_by)}
      <div id="draft-preview-${escHtml(d.id)}" style="display:none;margin-top:8px;border-top:1px dashed #c7d2fe;padding-top:8px;font-size:12px;color:#52525B;line-height:1.5"></div>
      <div style="font-size:10px;color:#9ca3af;margin-top:6px">${T('发布前会校验交接字段;发布后进入正常任务板,可被参与者 agent 发现 / 认领 / 提交 PR。', 'Publish validates the handoff fields; once published it enters the normal task board — discoverable / claimable / PR-submittable by participant agents.')}</div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center">
        <button onclick="previewDraft('${escHtml(d.id)}')" style="padding:6px 12px;border:1px solid #6366f1;background:#fff;color:#4338ca;border-radius:6px;font-size:12px;cursor:pointer;font-weight:600">👁 ${T('预览将发布内容', 'Preview what will be published')}</button>
        <button id="pub-btn-${escHtml(d.id)}" disabled title="${T('请先预览将发布的存储内容', 'Preview the stored content first')}" onclick="publishDraft('${escHtml(d.id)}')" style="padding:6px 14px;border:none;background:#d1d5db;color:#6b7280;border-radius:6px;font-size:12px;cursor:not-allowed;font-weight:600">${T('发布到任务板', 'Publish to board')}</button>
      </div>
    </div>`
  app.innerHTML = shell(`
    <div style="padding:14px;max-width:920px;margin:0 auto">
      <h1 class="page-title">🛠️ ${T('任务建议收件箱', 'Task Proposal Inbox')}</h1>
      <div style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:10px;font-size:11px;color:#52525B;line-height:1.6;margin-bottom:12px">
        ${T('建议是陌生人 / agent 提交的想法,不是贡献事实 / 奖励 / 正式参与。「转为正式任务」只记录评审决定与证据链(proposer → reviewer → 关联引用),不会自动创建 build_task。', 'A proposal is a stranger / agent suggestion — NOT a contribution fact / reward / participation. “Convert” only records the review decision + the proposer → reviewer → ref evidence chain; it does NOT auto-create a build_task.')}
        ${notice ? `<br>${escHtml(notice)}` : ''}
      </div>
      ${drafts.length ? `<div style="margin-bottom:14px">
        <div style="font-size:12px;font-weight:700;color:#4338ca;margin-bottom:6px">📝 ${T('未发布任务草稿', 'Unpublished task drafts')} (${drafts.length})</div>
        ${drafts.map(draftRow).join('')}
      </div>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        ${chip('', T('全部', 'All'))}${chip('new', STATUS.new.label)}${chip('needs_info', STATUS.needs_info.label)}${chip('rejected', STATUS.rejected.label)}${chip('converted', STATUS.converted.label)}
      </div>
      ${proposals.length === 0 ? `<div style="color:#a1a1aa;text-align:center;padding:30px;font-size:14px">${T('收件箱为空', 'Inbox is empty')}</div>` : proposals.map(row).join('')}
    </div>
  `, 'admin')
}
window.setProposalStatusFilter = (s) => { state._proposalStatus = s; renderAdminTaskProposals(document.getElementById('app')) }
window.reviewProposal = async (id, status) => {
  const note = (document.getElementById('pr-note-' + id)?.value || '').trim()
  const ref = (document.getElementById('pr-ref-' + id)?.value || '').trim()
  const body = { status }
  if (note) body.note = note
  if (status === 'converted' && ref) body.converted_ref = ref
  const r = await POST('/admin/task-proposals/' + encodeURIComponent(id) + '/review', body)
  if (r.error) { toast$(r.error || r.error_code || (window._lang === 'en' ? 'failed' : '操作失败')); return }
  toast$(window._lang === 'en' ? 'Updated' : '已更新')
  renderAdminTaskProposals(document.getElementById('app'))
}
window.toggleDraftForm = (id) => { const el = document.getElementById('df-' + id); if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none' }
// AI-assist is ASSISTANT-ONLY: it renders a suggestion + prefills the draft form; it never publishes/decides.
window.aiAssistProposal = async (id) => {
  const en = window._lang === 'en'
  const box = document.getElementById('ai-' + id); if (box) box.innerHTML = `<div style="font-size:11px;color:#8b5cf6;margin-top:8px">🤖 ${en ? 'thinking…' : '分析中…'}</div>`
  const r = await POST('/admin/task-proposals/' + encodeURIComponent(id) + '/ai-assist', {})
  if (r.error) { if (box) box.innerHTML = ''; toast$(r.error || 'failed'); return }
  const s = r.ai_suggestion || {}
  window._aiSuggest = window._aiSuggest || {}; window._aiSuggest[id] = s.suggested || {}
  const list = (arr) => (arr || []).map(x => '• ' + escHtml(String(x))).join('<br>')
  if (box) box.innerHTML = `<div style="margin-top:8px;border:1px solid #ddd6fe;background:#faf5ff;border-radius:8px;padding:10px">
    <div style="font-size:11px;font-weight:700;color:#6d28d9">🤖 ${en ? 'AI suggestion' : 'AI 建议'} <span style="font-weight:400;color:#9ca3af">(${escHtml(String(r.model || ''))})</span></div>
    <div style="font-size:10px;color:#b45309;margin:2px 0 6px">${escHtml(String(r.ai_notice || ''))}</div>
    <div style="font-size:12px;color:#374151;line-height:1.6">
      <b>${en ? 'Category' : '分类'}:</b> ${escHtml(String(s.category || ''))} · <b>${en ? 'Risk' : '风险'}:</b> ${escHtml(String(s.risk || ''))} · <b>${en ? 'Effort' : '工作量'}:</b> ${escHtml(String(s.effort || ''))} · <b>${en ? 'Duplicate' : '疑似重复'}:</b> ${escHtml(String(s.duplicate_likelihood || ''))}
      ${(s.missing_info && s.missing_info.length) ? `<div style="margin-top:4px"><b>${en ? 'Missing info' : '缺失信息'}:</b><br>${list(s.missing_info)}</div>` : ''}
    </div>
    <button onclick="applyAiToDraft('${id}')" style="margin-top:8px;padding:5px 12px;border:1px solid #8b5cf6;background:#fff;color:#6d28d9;border-radius:6px;font-size:11px;cursor:pointer">${en ? 'Fill draft form with this' : '用此填充草稿表单'}</button>
  </div>`
}
window.applyAiToDraft = (id) => {
  const suggested = (window._aiSuggest && window._aiSuggest[id]) || {}
  document.getElementById('df-' + id).style.display = 'block'
  const set = (sfx, v) => { const el = document.getElementById('df-' + sfx + '-' + id); if (el && v != null && v !== '') el.value = v }
  set('title', suggested.title); set('area', suggested.area); set('desc', suggested.description)
  set('accept', (suggested.acceptance_criteria || []).join('\n')); set('verify', (suggested.verification_commands || []).join('\n'))
  toast$(window._lang === 'en' ? 'Draft prefilled (review before saving)' : '已填充草稿(保存前请人工核对)')
}
window.createTaskDraft = async (id) => {
  const en = window._lang === 'en'
  const v = (sfx) => (document.getElementById('df-' + sfx + '-' + id)?.value || '').trim()
  const lines = (sfx) => v(sfx).split('\n').map(x => x.trim()).filter(Boolean)
  const body = {
    title: v('title'), area: v('area') || null, source_ref: v('source') || null, description: v('desc'),
    allowed_paths: lines('allowed'), forbidden_paths: lines('fpaths'), forbidden_actions: lines('forbidden'),
    acceptance_criteria: lines('accept'), verification_commands: lines('verify'), deliverables: lines('deliver'),
    definition_of_done: v('dod'), expected_results: v('expect'),
  }
  const r = await POST('/admin/task-proposals/' + encodeURIComponent(id) + '/create-task-draft', body)
  if (r && r.error_code === 'RATE_LIMITED') { showRateLimitAffordance(r); return }
  if (r.error) { toast$((r.missing && r.missing.length) ? ((en ? 'Missing: ' : '缺少:') + r.missing.join(', ')) : (r.error || 'failed')); return }
  toast$(en ? 'Draft saved (unpublished)' : '草稿已保存(未发布)')
  renderAdminTaskProposals(document.getElementById('app'))
}
// Pre-publish preview: load the FULL stored draft body so publish is a decision against visible content.
// Opening the preview also un-gates the (initially disabled) Publish button for this draft.
window.previewDraft = async (taskId) => {
  // bilingual helper — T is local to renderAdminTaskProposals, NOT a global, so this top-level fn defines its own
  const T = (zh, en) => (window._lang === 'en' ? en : zh)
  const box = document.getElementById('draft-preview-' + taskId)
  if (!box) return
  box.style.display = ''
  box.innerHTML = t('加载中...')
  const r = await GET('/admin/build-task-drafts/' + encodeURIComponent(taskId)).catch(() => null)
  const d = r && r.draft
  if (!d) { box.innerHTML = `<span style="color:#dc2626">${T('预览加载失败', 'Preview failed to load')}</span>`; return }
  const m = d.agent_metadata || {}
  const li = (arr) => (Array.isArray(arr) && arr.length) ? `<ul style="margin:2px 0 6px 16px;padding:0">${arr.map((x) => `<li>${escHtml(String(x))}</li>`).join('')}</ul>` : `<div style="color:#9ca3af;margin-bottom:6px">—</div>`
  const txtBlock = (s) => `<div style="white-space:pre-wrap;margin-bottom:6px">${escHtml(String(s || '')) || '<span style="color:#9ca3af">—</span>'}</div>`
  const sec = (label, html) => `<div style="margin-top:6px"><div style="font-weight:600;color:#374151">${escHtml(label)}</div>${html}</div>`
  box.innerHTML = `<div style="font-size:11px;color:#6366f1;font-weight:600;margin-bottom:4px">${T('将要发布的存储内容(发布对此生效)', 'Stored content that will be published (publish acts on this)')}</div>`
    + sec(T('说明', 'Description'), txtBlock(d.description))
    + sec(T('验收标准', 'Acceptance criteria'), li(m.acceptance_criteria))
    + sec(T('验证命令', 'Verification commands'), li(m.verification_commands))
    + sec(T('允许路径', 'Allowed paths'), li(m.allowed_paths))
    + sec(T('禁止路径', 'Forbidden paths'), li(m.forbidden_paths))
    + sec(T('禁止动作', 'Forbidden actions'), li(m.prohibited_actions))
    + sec(T('交付物', 'Deliverables'), li(m.deliverables))
    + sec(T('完成定义', 'Definition of done'), txtBlock(m.definition_of_done))
    + sec(T('预期结果', 'Expected results'), txtBlock(m.expected_results))
  const btn = document.getElementById('pub-btn-' + taskId)
  if (btn) { btn.disabled = false; btn.title = ''; btn.style.cssText = 'padding:6px 14px;border:none;background:#16a34a;color:#fff;border-radius:6px;font-size:12px;cursor:pointer;font-weight:600' }
}

window.publishDraft = async (taskId) => {
  const en = window._lang === 'en'
  const r = await POST('/admin/build-task-drafts/' + encodeURIComponent(taskId) + '/publish', {})
  if (r.error) { toast$((r.missing && r.missing.length) ? ((en ? 'Fill before publish: ' : '发布前请填齐:') + r.missing.join(', ')) : (r.error || 'failed')); return }
  toast$(en ? 'Published to task board' : '已发布到任务板')
  renderAdminTaskProposals(document.getElementById('app'))
}

// ── PR #18 build-task quota-increase requests ─────────────────────────────────
var _qT = (zh, en) => (window._lang === 'en' ? en : zh)
const _qStatusBadge = (s) => {
  const map = {
    pending:   ['#fef9c3', '#854d0e', _qT('待审核', 'Pending')],
    approved:  ['#dcfce7', '#166534', _qT('已批准', 'Approved')],
    rejected:  ['#fee2e2', '#991b1b', _qT('已拒绝', 'Rejected')],
    expired:   ['#f3f4f6', '#6b7280', _qT('已过期', 'Expired')],
    exhausted: ['#e0e7ff', '#3730a3', _qT('已用完', 'Exhausted')],
    revoked:   ['#fae8ff', '#86198f', _qT('已撤销', 'Revoked')],
  }
  const [bg, fg, label] = map[s] || ['#f3f4f6', '#6b7280', s]
  return `<span style="font-size:11px;background:${bg};color:${fg};padding:2px 8px;border-radius:99px;font-weight:600">${escHtml(label)}</span>`
}

// RATE_LIMITED affordance — shown when build-task creation is capped (structured 429 response).
window.showRateLimitAffordance = (r) => {
  const limit = (r && r.limit) != null ? r.limit : '?'
  const used = (r && r.used) != null ? r.used : '?'
  document.getElementById('quota-rl-overlay')?.remove()
  const ov = document.createElement('div')
  ov.id = 'quota-rl-overlay'
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px'
  ov.innerHTML = `
    <div style="background:#fff;border-radius:12px;max-width:420px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.2)">
      <div style="font-size:16px;font-weight:700;color:#991b1b;margin-bottom:8px">⚠️ ${_qT('已达每日建任务上限', 'Daily task-creation limit reached')}</div>
      <div style="font-size:13px;color:#374151;line-height:1.6;margin-bottom:14px">
        ${_qT('当前上限', 'Current limit')}: <b>${escHtml(String(limit))}</b> ${_qT('个 / 24 小时', 'tasks / 24h')}　·　${_qT('已用', 'Used')}: <b>${escHtml(String(used))}</b><br>
        ${_qT('需要更多额度需经根管理员批准。', 'More headroom requires root-admin approval.')}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button onclick="document.getElementById('quota-rl-overlay').remove()" style="padding:8px 14px;border:1px solid #d1d5db;background:#fff;color:#374151;border-radius:8px;font-size:13px;cursor:pointer">${_qT('关闭', 'Close')}</button>
        <button onclick="document.getElementById('quota-rl-overlay').remove();navigate('#me/quota-requests')" style="padding:8px 14px;border:none;background:#4338ca;color:#fff;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">${_qT('申请增加额度', 'Request extra quota')}</button>
      </div>
    </div>`
  document.body.appendChild(ov)
}

// Requester view — own quota requests + a new-request form.
async function renderMyQuotaRequests(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'me')
  const r = await GET('/me/quota-requests').catch(() => null)
  if (!r || r.error) { app.innerHTML = shell(alert$('error', (r && r.error) || _qT('加载失败', 'Failed to load')), 'me'); return }
  const reqs = r.requests || []
  const hasPending = reqs.some(x => x.status === 'pending')
  const field = (label, html) => `<div style="margin-bottom:10px"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px">${escHtml(label)}</label>${html}</div>`
  const inputStyle = 'width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;box-sizing:border-box'

  const form = hasPending
    ? `<div class="card" style="padding:14px;margin-bottom:14px;background:#fffbeb;border:1px solid #fde68a">
        <div style="font-size:13px;color:#854d0e">${_qT('你已有一个待审核的申请 — 每种额度类型同时只能有一个待审核申请。', 'You already have a pending request — only one pending request per quota type is allowed.')}</div>
      </div>`
    : `<div class="card" style="padding:16px;margin-bottom:16px">
        <div style="font-size:14px;font-weight:700;margin-bottom:12px">📝 ${_qT('申请增加建任务额度', 'Request extra build-task quota')}</div>
        ${field(_qT('额外任务数(必填,正整数)', 'Extra tasks (required, positive integer)'), `<input id="q-count" type="number" min="1" placeholder="10" style="${inputStyle}">`)}
        ${field(_qT('理由(必填)', 'Reason (required)'), `<textarea id="q-reason" rows="3" placeholder="${_qT('为什么需要更多额度', 'Why you need more quota')}" style="${inputStyle}"></textarea>`)}
        ${field(_qT('关联任务/提案/PR(每行一个,可选)', 'Linked task/proposal/PR refs (one per line, optional)'), `<textarea id="q-refs" rows="2" placeholder="#17\\ntp_..." style="${inputStyle}"></textarea>`)}
        ${field(_qT('紧急程度', 'Urgency'), `<select id="q-urgency" style="${inputStyle}"><option value="normal">${_qT('普通', 'Normal')}</option><option value="low">${_qT('低', 'Low')}</option><option value="high">${_qT('高', 'High')}</option></select>`)}
        ${field(_qT('期望有效期(小时,可选)', 'Requested duration (hours, optional)'), `<input id="q-duration" type="number" min="1" placeholder="72" style="${inputStyle}">`)}
        <button onclick="submitQuotaRequest()" style="margin-top:6px;padding:9px 16px;border:none;background:#4338ca;color:#fff;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">${_qT('提交申请', 'Submit request')}</button>
      </div>`

  const card = (x) => {
    const granted = x.granted_count != null ? x.granted_count : null
    const remaining = x.remaining != null ? x.remaining : null
    return `<div class="card" style="padding:14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
        <div style="font-size:13px;font-weight:600">${escHtml(_qT('额外', 'Extra'))} ${escHtml(String(x.requested_extra_count))} · ${escHtml(x.urgency || 'normal')}</div>
        ${_qStatusBadge(x.status)}
      </div>
      <div style="font-size:12px;color:#374151;margin-top:6px;white-space:pre-wrap">${escHtml(x.reason || '')}</div>
      ${(x.linked_refs && x.linked_refs.length) ? `<div style="font-size:11px;color:#6b7280;margin-top:4px">${_qT('关联', 'Refs')}: ${x.linked_refs.map(escHtml).join(', ')}</div>` : ''}
      ${x.status === 'approved' ? `<div style="font-size:12px;color:#166534;margin-top:6px">${_qT('授权', 'Granted')}: ${escHtml(String(granted))} · ${_qT('剩余', 'Remaining')}: <b>${escHtml(String(remaining))}</b>${x.expires_at ? ` · ${_qT('到期', 'Expires')}: ${escHtml(x.expires_at)}` : ''}</div>` : ''}
      ${x.status === 'exhausted' ? `<div style="font-size:12px;color:#3730a3;margin-top:6px">${_qT('授权已用完', 'Grant fully used')} (${escHtml(String(granted))})</div>` : ''}
      ${x.status === 'rejected' && x.decision_note ? `<div style="font-size:12px;color:#991b1b;margin-top:6px">${_qT('拒绝原因', 'Rejection reason')}: ${escHtml(x.decision_note)}</div>` : ''}
      <div style="font-size:10px;color:#9ca3af;margin-top:6px">${escHtml(x.created_at || '')}</div>
    </div>`
  }

  const body = `
    <div style="max-width:560px;margin:0 auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div style="font-size:18px;font-weight:700">🎟️ ${_qT('我的额度申请', 'My quota requests')}</div>
        <a href="#me" style="font-size:12px;color:#4338ca;text-decoration:none">← ${_qT('返回', 'Back')}</a>
      </div>
      <div class="card" style="padding:12px;margin-bottom:14px;background:linear-gradient(135deg,#eef2ff,#fff)">
        <div style="font-size:12px;color:#6b7280">${_qT('当前可用临时额度', 'Current temporary quota available')}</div>
        <div style="font-size:22px;font-weight:700;color:#4338ca">${escHtml(String(r.remaining_quota || 0))}</div>
      </div>
      ${form}
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">${_qT('历史申请', 'Request history')}</div>
      ${reqs.length ? reqs.map(card).join('') : `<div style="font-size:13px;color:#9ca3af">${_qT('暂无申请', 'No requests yet')}</div>`}
    </div>`
  app.innerHTML = shell(body, 'me')
}

window.submitQuotaRequest = async () => {
  const v = (id) => (document.getElementById(id)?.value || '').trim()
  const count = Number(v('q-count'))
  const reason = v('q-reason')
  if (!count || count <= 0) { toast$(_qT('请填写正整数额外任务数', 'Enter a positive extra-task count')); return }
  if (reason.length < 5) { toast$(_qT('请填写理由(至少 5 字)', 'Reason required (>= 5 chars)')); return }
  const refs = v('q-refs').split('\n').map(s => s.trim()).filter(Boolean)
  const duration = v('q-duration')
  const body = { requested_extra_count: count, reason, linked_refs: refs, urgency: v('q-urgency') || 'normal' }
  if (duration) body.requested_duration_hours = Number(duration)
  const r = await POST('/me/quota-requests', body)
  if (r && r.error) { toast$(r.error_code === 'ALREADY_PENDING' ? _qT('你已有一个待审核申请', 'You already have a pending request') : (r.error || _qT('提交失败', 'Submit failed'))); return }
  toast$(_qT('申请已提交,等待根管理员审核', 'Submitted — awaiting root-admin review'))
  renderMyQuotaRequests(document.getElementById('app'))
}

// ── Admin operator-claim workflow (Phase 2): link an admin SEAT → a personal contributor account ──
function _ocStatusBadge(s) {
  const map = {
    proposed:                ['#fef9c3', '#854d0e', _qT('待贡献人确认', 'Awaiting contributor')],
    confirmed:               ['#dbeafe', '#1e40af', _qT('待 root 审批', 'Awaiting root approval')],
    rejected_by_contributor: ['#fee2e2', '#991b1b', _qT('贡献人已拒绝', 'Rejected by contributor')],
    approved:                ['#dcfce7', '#166534', _qT('已生效', 'Active')],
    rejected_by_root:        ['#fee2e2', '#991b1b', _qT('root 已拒绝', 'Rejected by root')],
    revoked:                 ['#fae8ff', '#86198f', _qT('已撤销', 'Revoked')],
    superseded:              ['#f3f4f6', '#6b7280', _qT('已被取代', 'Superseded')],
  }
  const [bg, fg, label] = map[s] || ['#f3f4f6', '#6b7280', s]
  return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600">${escHtml(label)}</span>`
}

// Page for any user: (a) if admin — their seat + a "link personal contributor account" form;
// (b) for everyone — claims pointing at ME awaiting my accept/reject.
async function renderMyOperatorClaims(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'me')
  const isAdmin = state.user.role === 'admin' || (Array.isArray(state.user.roles) && state.user.roles.includes('admin'))
  const pend = await GET('/me/operator-claim-confirmations').catch(() => null)
  const rel = await GET('/me/operator-claims').catch(() => null)   // ALL relationships pointing at me (active/history)
  const mine = isAdmin ? await GET('/admin/operator-claims/me').catch(() => null) : null
  const inputStyle = 'width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;box-sizing:border-box'
  const field = (label, html) => `<div style="margin-bottom:10px"><label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px">${escHtml(label)}</label>${html}</div>`

  // active approved claim → either an "申请解除" button or a pending-review note. Either PARTY may
  // request unlink (admin-seat owner OR contributor), so both claimRow and relCard reuse this.
  const unlinkAreaFor = (c) => {
    const active = c.status === 'approved' && c.approved
    if (!active) return ''
    return c.unlink_pending
      ? `<div style="font-size:11px;color:#b45309;margin-top:8px">⏳ ${_qT('解除申请审批中(待 root)', 'Unlink request pending root review')}</div>`
      : `<button onclick="requestUnlinkOperatorClaim('${escHtml(c.approved.event_id)}')" style="margin-top:8px;padding:6px 12px;border:1px solid #d1d5db;background:#fff;color:#b91c1c;border-radius:8px;font-size:12px;cursor:pointer">${_qT('申请解除', 'Request unlink')}</button>`
  }

  const claimRow = (c) => `<div class="card" style="padding:12px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div style="font-size:12px;font-weight:600">→ ${escHtml(c.contributor_account_id)}</div>${_ocStatusBadge(c.status)}
      </div>
      <div style="font-size:10px;color:#9ca3af;margin-top:4px">${escHtml(c.proposed_at || '')} · ${escHtml(c.claimed_event_id)}</div>${unlinkAreaFor(c)}
    </div>`

  const adminBlock = isAdmin ? `
    <div class="card" style="padding:16px;margin-bottom:16px">
      <div style="font-size:14px;font-weight:700;margin-bottom:4px">🔗 ${_qT('关联个人贡献账号', 'Link a personal contributor account')}</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:12px">${_qT('把这个管理席位的协调贡献,归属到你的真实个人账号。需对方确认 + 根管理员审批。', 'Attribute this admin seat\'s coordination work to your real personal account. Requires the contributor to accept + root approval.')}</div>
      ${field(_qT('贡献人账号 ID(必填)', 'Contributor account ID (required)'), `<input id="oc-contributor" placeholder="usr_..." style="${inputStyle}">`)}
      ${field(_qT('理由(可选)', 'Rationale (optional)'), `<input id="oc-rationale" placeholder="${_qT('为何关联', 'why')}" style="${inputStyle}">`)}
      <button onclick="submitOperatorClaim()" style="margin-top:4px;padding:9px 16px;border:none;background:#4338ca;color:#fff;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">${_qT('发起关联', 'Propose link')}</button>
      <div style="font-size:13px;font-weight:600;margin:16px 0 8px">${_qT('本席位的关联记录', 'This seat\'s claims')}</div>
      ${(mine && mine.claims && mine.claims.length) ? mine.claims.map(claimRow).join('') : `<div style="font-size:13px;color:#9ca3af">${_qT('暂无', 'None yet')}</div>`}
    </div>` : '' /* adminBlock */

  const pendList = (pend && pend.pending) || []
  const confirmCard = (c) => `<div class="card" style="padding:14px;margin-bottom:10px;background:#fffbeb;border:1px solid #fde68a">
      <div style="font-size:13px">${_qT('管理席位', 'Admin seat')} <b>${escHtml(c.admin_account_id)}</b> ${_qT('请求关联到你的账号作为贡献归属。', 'requests to attribute its coordination work to your account.')}</div>
      <div style="font-size:10px;color:#9ca3af;margin:6px 0">${escHtml(c.claimed_event_id)}</div>
      <div style="display:flex;gap:8px">
        <button onclick="confirmOperatorClaim('${escHtml(c.claimed_event_id)}','accepted')" style="padding:8px 14px;border:none;background:#166534;color:#fff;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">${_qT('接受', 'Accept')}</button>
        <button onclick="confirmOperatorClaim('${escHtml(c.claimed_event_id)}','rejected')" style="padding:8px 14px;border:1px solid #d1d5db;background:#fff;color:#991b1b;border-radius:8px;font-size:13px;cursor:pointer">${_qT('拒绝', 'Reject')}</button>
      </div>
    </div>`

  // 我的贡献归属关系(已生效/历史)+ approved 关系可「申请解除」(不是直接撤销;需 Passkey + root 审批)
  const relList = (rel && rel.relationships) || []
  const relCard = (c) => {
    return `<div class="card" style="padding:12px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div style="font-size:12px;font-weight:600">${escHtml(c.admin_account_id)} → ${escHtml(c.contributor_account_id)}</div>${_ocStatusBadge(c.status)}
      </div>
      <div style="font-size:10px;color:#9ca3af;margin-top:4px">${escHtml(c.proposed_at || '')}</div>${unlinkAreaFor(c)}
    </div>`
  }

  const body = `<div style="max-width:560px;margin:0 auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div style="font-size:18px;font-weight:700">🪪 ${_qT('贡献归属', 'Contribution attribution')}</div>
        <a href="#me" style="font-size:12px;color:#4338ca;text-decoration:none">← ${_qT('返回', 'Back')}</a>
      </div>
      ${adminBlock}
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">${_qT('待我确认的关联', 'Awaiting my confirmation')}</div>
      ${pendList.length ? pendList.map(confirmCard).join('') : `<div style="font-size:13px;color:#9ca3af;margin-bottom:8px">${_qT('没有待确认的关联', 'No pending links')}</div>`}
      <div style="font-size:13px;font-weight:600;margin:16px 0 8px">${_qT('我的贡献归属关系 / 历史', 'My contribution-attribution relationships / history')}</div>
      ${relList.length ? relList.map(relCard).join('') : `<div style="font-size:13px;color:#9ca3af">${_qT('暂无关系', 'No relationships yet')}</div>`}
    </div>`
  app.innerHTML = shell(body, 'me')
}

window.requestUnlinkOperatorClaim = async (approvedEventId) => {
  if (!confirm(_qT('确认申请解除该贡献归属关系?需 Passkey 验证,且最终由 root 审批。', 'Request to unlink this attribution relationship? Requires Passkey, then root approval.'))) return
  let token
  try { token = await requestPasskeyGate('operator_claim_unlink', { approved_event_id: approvedEventId }) }
  catch (e) { toast$(e.message || _qT('Passkey 验证失败', 'Passkey verification failed')); return }
  const reason = (prompt(_qT('解除理由(可选)', 'Reason (optional)')) || '').trim() || undefined
  const r = await POST('/me/operator-claims/' + encodeURIComponent(approvedEventId) + '/request-unlink', { webauthn_token: token, reason })
  if (r && r.error) { toast$(r.message || r.error || _qT('提交失败', 'Failed')); return }
  toast$(_qT('解除申请已提交,等待 root 审批', 'Unlink request submitted — awaiting root review'))
  renderMyOperatorClaims(document.getElementById('app'))
}

window.submitOperatorClaim = async () => {
  const contributor = (document.getElementById('oc-contributor')?.value || '').trim()
  const rationale = (document.getElementById('oc-rationale')?.value || '').trim()
  if (!contributor) { toast$(_qT('请填写贡献人账号 ID', 'Enter contributor account ID')); return }
  const r = await POST('/admin/operator-claims', { contributor_account_id: contributor, rationale })
  if (r && r.error) { toast$(r.message || r.error || _qT('发起失败', 'Failed')); return }
  toast$(_qT('已发起,等待对方确认 + root 审批', 'Proposed — awaiting contributor + root'))
  renderMyOperatorClaims(document.getElementById('app'))
}
window.confirmOperatorClaim = async (claimedEventId, decision) => {
  const r = await POST('/me/operator-claim-confirmations/' + encodeURIComponent(claimedEventId), { decision })
  if (r && r.error) { toast$(r.message || r.error || _qT('操作失败', 'Failed')); return }
  toast$(decision === 'accepted' ? _qT('已接受', 'Accepted') : _qT('已拒绝', 'Rejected'))
  renderMyOperatorClaims(document.getElementById('app'))
}

// ROOT review queue for operator claims.
async function renderAdminOperatorClaims(app, statusFilter) {
  if (!state.user) { renderLogin(); return }
  const isRoot = (state.user.admin_type || 'root') === 'root' && (state.user.role === 'admin' || (Array.isArray(state.user.roles) && state.user.roles.includes('admin')))
  if (!isRoot) { app.innerHTML = shell(`<div class="alert alert-danger">${_qT('仅限根管理员', 'Root admin only')}</div>`, 'admin'); return }
  app.innerHTML = shell(loading$(), 'admin')
  const sf = statusFilter || 'confirmed'
  const r = await GET('/admin/operator-claims' + (sf === 'all' ? '' : '?status=' + encodeURIComponent(sf))).catch(() => null)
  if (!r || r.error) { app.innerHTML = shell(alert$('error', (r && r.error) || _qT('加载失败', 'Failed to load')), 'admin'); return }
  const claims = r.claims || []
  const unlinkRes = await GET('/admin/operator-claims/unlink/requests').catch(() => null)
  const unlinkReqs = (unlinkRes && unlinkRes.requests) || []
  const inputStyle = 'width:100%;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;box-sizing:border-box'
  const filterBtn = (s, label) => `<button onclick="renderAdminOperatorClaims(document.getElementById('app'),'${s}')" style="padding:5px 10px;border:1px solid ${sf === s ? '#4338ca' : '#d1d5db'};background:${sf === s ? '#4338ca' : '#fff'};color:${sf === s ? '#fff' : '#374151'};border-radius:6px;font-size:12px;cursor:pointer">${escHtml(label)}</button>`
  const unlinkCard = (u) => {
    const rid = u.request_event_id
    // When THIS root is a party to the relationship/request (self-or-related), root may still decide it
    // but MUST mark the conflict honestly: approval_kind ∈ {root_approval, founder_bootstrap_override}
    // (never independent_governance) + conflict_disclosure = self_or_related. Mirrors approveClaim.
    const markingForm = u.self_or_related ? `
      <div style="margin-top:8px;padding-top:8px;border-top:1px dashed #fed7aa">
        <div style="font-size:11px;color:#b45309;margin-bottom:6px">⚠️ ${_qT('你是该关系/申请的关联方:必须如实标记(不可 independent_governance)', 'You are a party to this relationship/request: mark honestly (independent_governance not allowed)')}</div>
        <div style="display:flex;gap:6px">
          <select id="uak-${rid}" style="${inputStyle}">
            <option value="root_approval">root_approval</option>
            <option value="founder_bootstrap_override">founder_bootstrap_override</option>
          </select>
          <select id="ucd-${rid}" style="${inputStyle}">
            <option value="self_or_related" selected>self_or_related</option>
          </select>
        </div>
      </div>` : ''
    return `<div class="card" style="padding:12px;margin-bottom:8px;background:#fff7ed;border:1px solid #fed7aa">
      <div style="font-size:12px;font-weight:600">🔓 ${escHtml(u.admin_account_id)} → ${escHtml(u.contributor_account_id)}${u.self_or_related ? ' 🪞' : ''}</div>
      <div style="font-size:11px;color:#6b7280;margin-top:4px">${_qT('申请人', 'Requested by')}: ${escHtml(u.requested_by)} (${escHtml(u.requester_role)})${u.reason ? ' · ' + escHtml(u.reason) : ''}</div>
      ${markingForm}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button onclick="approveUnlinkReq('${escHtml(rid)}')" style="padding:6px 12px;border:none;background:#b91c1c;color:#fff;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">${_qT('批准解除', 'Approve unlink')}</button>
        <button onclick="rejectUnlinkReq('${escHtml(rid)}')" style="padding:6px 12px;border:1px solid #d1d5db;background:#fff;color:#374151;border-radius:8px;font-size:12px;cursor:pointer">${_qT('驳回', 'Reject')}</button>
      </div>
    </div>`
  }

  const card = (c) => {
    const selfLink = c.admin_account_id === c.contributor_account_id
    const id = c.claimed_event_id
    const approveForm = (c.status === 'confirmed' || (selfLink && c.status === 'proposed')) ? `
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid #eee">
        ${selfLink ? `<div style="font-size:11px;color:#b45309;margin-bottom:6px">⚠️ ${_qT('自链(席位=贡献人):必须 founder_bootstrap_override + self_or_related', 'Self-link (seat == contributor): must be founder_bootstrap_override + self_or_related')}</div>` : ''}
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <select id="ak-${id}" style="${inputStyle}">
            ${selfLink ? '' : `<option value="independent_governance">independent_governance</option>`}
            <option value="root_approval">root_approval</option>
            <option value="founder_bootstrap_override">founder_bootstrap_override</option>
          </select>
          <select id="cd-${id}" style="${inputStyle}">
            <option value="none">none</option>
            <option value="self_or_related"${selfLink ? ' selected' : ''}>self_or_related</option>
          </select>
        </div>
        <div style="display:flex;gap:8px">
          <button onclick="approveOperatorClaim('${escHtml(id)}')" style="padding:7px 14px;border:none;background:#166534;color:#fff;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer">${_qT('批准', 'Approve')}</button>
          <button onclick="rejectOperatorClaim('${escHtml(id)}')" style="padding:7px 14px;border:1px solid #d1d5db;background:#fff;color:#991b1b;border-radius:8px;font-size:12px;cursor:pointer">${_qT('拒绝', 'Reject')}</button>
        </div>
      </div>` : ''
    const revokeBtn = (c.status === 'approved' && c.approved) ? `<button onclick="revokeOperatorClaim('${escHtml(c.approved.event_id)}')" style="margin-top:8px;padding:6px 12px;border:1px solid #d1d5db;background:#fff;color:#86198f;border-radius:8px;font-size:12px;cursor:pointer">${_qT('撤销', 'Revoke')}</button>` : ''
    return `<div class="card" style="padding:14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div style="font-size:12px;font-weight:600">${escHtml(c.admin_account_id)} → ${escHtml(c.contributor_account_id)}${selfLink ? ' 🪞' : ''}</div>${_ocStatusBadge(c.status)}
      </div>
      <div style="font-size:11px;color:#6b7280;margin-top:4px">${c.confirmation ? `${_qT('贡献人', 'Contributor')}: ${escHtml(c.confirmation.decision)}` : _qT('未确认', 'not confirmed')} · ${escHtml(c.proposed_at || '')}</div>
      ${approveForm}${revokeBtn}
    </div>`
  }

  const body = `<div style="max-width:620px;margin:0 auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="font-size:18px;font-weight:700">🪪 ${_qT('操作席位关联审批', 'Operator-claim review')}</div>
        <a href="#admin/protocol" style="font-size:12px;color:#4338ca;text-decoration:none">← ${_qT('返回', 'Back')}</a>
      </div>
      ${unlinkReqs.length ? `<div style="font-size:13px;font-weight:700;color:#b91c1c;margin-bottom:8px">🔓 ${_qT('待审批的解除申请', 'Pending unlink requests')} (${unlinkReqs.length})</div>${unlinkReqs.map(unlinkCard).join('')}<div style="height:14px"></div>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
        ${filterBtn('confirmed', _qT('待审批', 'Awaiting approval'))}${filterBtn('proposed', _qT('待确认', 'Proposed'))}${filterBtn('approved', _qT('已生效', 'Active'))}${filterBtn('all', _qT('全部', 'All'))}
      </div>
      ${claims.length ? claims.map(card).join('') : `<div style="font-size:13px;color:#9ca3af">${_qT('暂无', 'None')}</div>`}
    </div>`
  app.innerHTML = shell(body, 'admin')
}

window.approveOperatorClaim = async (id) => {
  const ak = document.getElementById('ak-' + id)?.value
  const cd = document.getElementById('cd-' + id)?.value
  const r = await POST('/admin/operator-claims/' + encodeURIComponent(id) + '/approve', { approval_kind: ak, conflict_disclosure: cd })
  if (r && r.error) { toast$(r.message || r.error || _qT('审批失败', 'Approve failed')); return }
  toast$(_qT('已批准', 'Approved')); renderAdminOperatorClaims(document.getElementById('app'))
}
window.rejectOperatorClaim = async (id) => {
  const r = await POST('/admin/operator-claims/' + encodeURIComponent(id) + '/reject', {})
  if (r && r.error) { toast$(r.message || r.error || _qT('操作失败', 'Failed')); return }
  toast$(_qT('已拒绝', 'Rejected')); renderAdminOperatorClaims(document.getElementById('app'))
}
window.revokeOperatorClaim = async (approvedId) => {
  const r = await POST('/admin/operator-claims/' + encodeURIComponent(approvedId) + '/revoke', {})
  if (r && r.error) { toast$(r.message || r.error || _qT('撤销失败', 'Revoke failed')); return }
  toast$(_qT('已撤销', 'Revoked')); renderAdminOperatorClaims(document.getElementById('app'))
}
window.approveUnlinkReq = async (requestId) => {
  if (!confirm(_qT('批准后将解除该贡献归属关系,确认?', 'Approving will unlink (revoke) this attribution. Confirm?'))) return
  // marking selectors only render when root is self-or-related; pass them through when present.
  const ak = document.getElementById('uak-' + requestId)?.value
  const cd = document.getElementById('ucd-' + requestId)?.value
  const body = ak ? { approval_kind: ak, conflict_disclosure: cd } : {}
  const r = await POST('/admin/operator-claims/unlink/' + encodeURIComponent(requestId) + '/approve', body)
  if (r && r.error) { toast$(r.message || r.error || _qT('操作失败', 'Failed')); return }
  toast$(_qT('已批准解除', 'Unlink approved')); renderAdminOperatorClaims(document.getElementById('app'))
}
window.rejectUnlinkReq = async (requestId) => {
  const ak = document.getElementById('uak-' + requestId)?.value
  const cd = document.getElementById('ucd-' + requestId)?.value
  const body = ak ? { approval_kind: ak, conflict_disclosure: cd } : {}
  const r = await POST('/admin/operator-claims/unlink/' + encodeURIComponent(requestId) + '/reject', body)
  if (r && r.error) { toast$(r.message || r.error || _qT('操作失败', 'Failed')); return }
  toast$(_qT('已驳回,关系仍有效', 'Rejected — relationship stays active')); renderAdminOperatorClaims(document.getElementById('app'))
}

// ROOT admin review page.
async function renderAdminBuildTaskQuota(app, statusFilter) {
  if (!state.user) { renderLogin(); return }
  const isRoot = (state.user.admin_type || 'root') === 'root' && (state.user.role === 'admin' || (Array.isArray(state.user.roles) && state.user.roles.includes('admin')))
  if (!isRoot) { app.innerHTML = shell(`<div class="alert alert-danger">${_qT('仅限根管理员', 'Root admin only')}</div>`, 'admin'); return }
  app.innerHTML = shell(loading$(), 'admin')
  const sf = statusFilter || 'pending'
  const r = await GET('/admin/quota-requests' + (sf === 'all' ? '' : '?status=' + encodeURIComponent(sf))).catch(() => null)
  if (!r || r.error) { app.innerHTML = shell(alert$('error', (r && r.error) || _qT('加载失败', 'Failed to load')), 'admin'); return }
  const reqs = r.requests || []
  const inputStyle = 'width:100%;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;box-sizing:border-box'
  const filterBtn = (s, label) => `<button onclick="renderAdminBuildTaskQuota(document.getElementById('app'),'${s}')" style="padding:5px 10px;border:1px solid ${sf === s ? '#4338ca' : '#d1d5db'};background:${sf === s ? '#4338ca' : '#fff'};color:${sf === s ? '#fff' : '#374151'};border-radius:6px;font-size:12px;cursor:pointer">${escHtml(label)}</button>`

  const card = (x) => {
    const pending = x.status === 'pending'
    return `<div class="card" style="padding:14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
        <div style="font-size:13px;font-weight:600">${escHtml(x.requester_user_id)} · ${_qT('请求', 'Wants')} <b>${escHtml(String(x.requested_extra_count))}</b> · ${escHtml(x.urgency || 'normal')}</div>
        ${_qStatusBadge(x.status)}
      </div>
      <div style="font-size:12px;color:#374151;margin-top:6px;white-space:pre-wrap">${escHtml(x.reason || '')}</div>
      ${(x.linked_refs && x.linked_refs.length) ? `<div style="font-size:11px;color:#6b7280;margin-top:4px">${_qT('关联', 'Refs')}: ${x.linked_refs.map(escHtml).join(', ')}</div>` : ''}
      <div style="font-size:10px;color:#9ca3af;margin-top:4px">${escHtml(x.created_at || '')} · ${escHtml(x.id)}</div>
      <div id="usage-${escHtml(x.id)}" style="font-size:11px;color:#6b7280;margin-top:4px"><button onclick="loadQuotaUsage('${escHtml(x.id)}')" style="padding:3px 8px;border:1px solid #d1d5db;background:#fff;border-radius:6px;font-size:11px;cursor:pointer">${_qT('查看申请人近 24h 用量', 'Load requester 24h usage')}</button></div>
      ${x.status === 'approved' ? `<div style="font-size:12px;color:#166534;margin-top:6px">${_qT('授权', 'Granted')}: ${escHtml(String(x.granted_count))} · ${_qT('剩余', 'Remaining')}: ${escHtml(String(x.remaining))}${x.expires_at ? ` · ${_qT('到期', 'Expires')}: ${escHtml(x.expires_at)}` : ''}
          <button onclick="revokeQuotaReq('${escHtml(x.id)}')" style="margin-left:8px;padding:3px 8px;border:1px solid #c026d3;background:#fff;color:#86198f;border-radius:6px;font-size:11px;cursor:pointer">${_qT('撤销', 'Revoke')}</button></div>` : ''}
      ${(x.decision_note && (x.status === 'rejected' || x.status === 'approved' || x.status === 'revoked')) ? `<div style="font-size:11px;color:#6b7280;margin-top:4px">${_qT('备注', 'Note')}: ${escHtml(x.decision_note)}</div>` : ''}
      ${pending ? `
        <div style="margin-top:10px;border-top:1px solid #f1f1f4;padding-top:10px;display:grid;gap:8px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <input id="ap-count-${escHtml(x.id)}" type="number" min="1" value="${escHtml(String(x.requested_extra_count))}" placeholder="${_qT('授权数', 'Grant count')}" style="${inputStyle}">
            <input id="ap-dur-${escHtml(x.id)}" type="number" min="1" value="${escHtml(String(x.requested_duration_hours || 72))}" placeholder="${_qT('有效期(小时)', 'Duration (h)')}" style="${inputStyle}">
          </div>
          <input id="ap-note-${escHtml(x.id)}" placeholder="${_qT('批准备注(可选)', 'Approval note (optional)')}" style="${inputStyle}">
          <input id="rj-note-${escHtml(x.id)}" placeholder="${_qT('拒绝原因(可选)', 'Rejection note (optional)')}" style="${inputStyle}">
          <div style="display:flex;gap:8px">
            <button onclick="approveQuotaReq('${escHtml(x.id)}')" style="padding:7px 14px;border:none;background:#16a34a;color:#fff;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer">${_qT('批准', 'Approve')}</button>
            <button onclick="rejectQuotaReq('${escHtml(x.id)}')" style="padding:7px 14px;border:1px solid #ef4444;background:#fff;color:#991b1b;border-radius:6px;font-size:12px;cursor:pointer">${_qT('拒绝', 'Reject')}</button>
          </div>
        </div>` : ''}
    </div>`
  }

  const body = `
    <div style="max-width:640px;margin:0 auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div style="font-size:18px;font-weight:700">🎟️ ${_qT('建任务额度审核', 'Build-task quota review')}</div>
        <a href="#admin" style="font-size:12px;color:#4338ca;text-decoration:none">← ${_qT('返回', 'Back')}</a>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">
        ${filterBtn('pending', _qT('待审核', 'Pending'))}${filterBtn('approved', _qT('已批准', 'Approved'))}${filterBtn('rejected', _qT('已拒绝', 'Rejected'))}${filterBtn('all', _qT('全部', 'All'))}
      </div>
      ${reqs.length ? reqs.map(card).join('') : `<div style="font-size:13px;color:#9ca3af">${_qT('暂无申请', 'No requests')}</div>`}
    </div>`
  app.innerHTML = shell(body, 'admin')
}

window.loadQuotaUsage = async (id) => {
  const box = document.getElementById('usage-' + id)
  if (box) box.innerHTML = t('加载中...')
  const r = await GET('/admin/quota-requests/' + encodeURIComponent(id)).catch(() => null)
  if (box) box.innerHTML = (r && !r.error)
    ? `${_qT('申请人近 24h 已建任务', 'Requester tasks in last 24h')}: <b>${escHtml(String(r.requester_usage_24h))}</b>`
    : ((r && r.error) || _qT('加载失败', 'Failed'))
}
window.approveQuotaReq = async (id) => {
  const v = (p) => (document.getElementById(p + '-' + id)?.value || '').trim()
  const body = { extra_count: Number(v('ap-count')) || undefined, duration_hours: Number(v('ap-dur')) || undefined, approval_note: v('ap-note') || undefined }
  const r = await POST('/admin/quota-requests/' + encodeURIComponent(id) + '/approve', body)
  if (r && r.error) { toast$(r.error_code === 'SELF_DECISION' ? _qT('不能审核自己的申请', 'Cannot decide your own request') : (r.error || _qT('批准失败', 'Approve failed'))); return }
  toast$(_qT('已批准', 'Approved'))
  renderAdminBuildTaskQuota(document.getElementById('app'), 'pending')
}
window.rejectQuotaReq = async (id) => {
  const note = (document.getElementById('rj-note-' + id)?.value || '').trim()
  const r = await POST('/admin/quota-requests/' + encodeURIComponent(id) + '/reject', { rejection_note: note || undefined })
  if (r && r.error) { toast$(r.error_code === 'SELF_DECISION' ? _qT('不能审核自己的申请', 'Cannot decide your own request') : (r.error || _qT('拒绝失败', 'Reject failed'))); return }
  toast$(_qT('已拒绝', 'Rejected'))
  renderAdminBuildTaskQuota(document.getElementById('app'), 'pending')
}
window.revokeQuotaReq = async (id) => {
  const r = await POST('/admin/quota-requests/' + encodeURIComponent(id) + '/revoke', {})
  if (r && r.error) { toast$(r.error || _qT('撤销失败', 'Revoke failed')); return }
  toast$(_qT('已撤销', 'Revoked'))
  renderAdminBuildTaskQuota(document.getElementById('app'), 'approved')
}
