// WebAZ — admin monitoring pages (classic multi-script split, first slice)
//
// Loaded as a CLASSIC script BEFORE app.js (see index.html order):
//   i18n → app-admin → app-contribution → app-ai → app-discover → app-profile → app-account → app-shop → app-listings → app-seller → app.js (source of truth: index.html)
// These are top-level function declarations → global, callable from app.js's
// router (render() dispatches #admin/health|errors|events here). They only run
// on route/click, by which point app.js has finished loading and all shared
// globals (state, GET/POST, isAdmin, shell, loading$, alert$, escHtml, fmtTime,
// renderEventRow, pageHeader, t) are defined. No import/export — cross-file
// access is via the global scope only.
//
// Read-only monitoring pages only (no payment/order/wallet/mutation).

// A-4: 系统健康监控
async function renderAdminHealth(app) {
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(loading$(), 'admin')
  const r = await GET('/admin/health')
  if (r.error) { app.innerHTML = shell(alert$('error', r.error), 'admin'); return }
  const fmtUptime = (s) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
    return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`
  }
  const tableRows = Object.entries(r.db.tables).map(([t, c]) => `
    <tr style="border-bottom:1px solid #f3f4f6;font-size:11px">
      <td style="padding:4px 8px;font-family:monospace">${t}</td>
      <td style="padding:4px 8px;text-align:right;${c === -1 ? 'color:#9ca3af' : ''}">${c === -1 ? '（无表）' : c.toLocaleString()}</td>
    </tr>
  `).join('')
  const rpcColor = !r.rpc.ok ? '#dc2626' : r.rpc.latency_ms > 2000 ? '#dc2626' : r.rpc.latency_ms > 500 ? '#d97706' : '#16a34a'
  app.innerHTML = shell(`
    <button class="btn btn-gray btn-sm" style="width:auto;margin-bottom:10px" onclick="history.back()">${t('← 返回')}</button>
    <h1 class="page-title">🩺 ${t('系统健康')}</h1>

    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">📌 ${t('运行时')}</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;font-size:12px">
        <div><div style="color:#9ca3af">${t('启动时长')}</div><div style="font-weight:700">${fmtUptime(r.uptime_sec)}</div></div>
        <div><div style="color:#9ca3af">${t('环境')}</div><div style="font-weight:700">${r.node_env} / ${r.network}</div></div>
        <div><div style="color:#9ca3af">${t('RSS 内存')}</div><div style="font-weight:700">${r.memory.rss_mb} MB</div></div>
        <div><div style="color:#9ca3af">${t('Heap 已用')}</div><div style="font-weight:700">${r.memory.heap_used_mb} / ${r.memory.heap_total_mb} MB</div></div>
      </div>
    </div>

    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">⛓ ${t('链上 RPC')}</div>
      <div style="font-size:11px;color:#9ca3af;font-family:monospace;margin-bottom:4px">${escHtml(r.rpc.url)}</div>
      <div style="font-size:18px;font-weight:700;color:${rpcColor}">${r.rpc.ok ? r.rpc.latency_ms + ' ms' : '✗ ' + t('不可达')}</div>
    </div>

    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">💾 ${t('数据库')} ${r.db.size_mb ? '· ' + r.db.size_mb + ' MB' : ''}</div>
      <table style="width:100%;border-collapse:collapse">${tableRows}</table>
    </div>

    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">🧠 ${t('内存缓冲')}</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;font-size:11px">
        ${Object.entries(r.in_memory_buffers).map(([k, v]) => `<div><div style="color:#9ca3af">${k}</div><div style="font-weight:700">${v}</div></div>`).join('')}
      </div>
    </div>
  `, 'admin')
}

// Tier 1 #5: 错误监控聚合 view（24h trend + burst alert + top errors）
async function renderAdminErrors(app) {
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(loading$(), 'admin')
  const [agg, rawRes] = await Promise.all([
    GET('/admin/errors/aggregate').catch(() => ({ totals: { total_24h: 0, total_1h: 0, total_10m: 0 }, by_source: [], top_messages: [], burst: [], thresholds: {} })),
    GET('/admin/errors?limit=20').catch(() => ({ items: [] })),
  ])
  const totals = agg.totals || { total_24h: 0, total_1h: 0, total_10m: 0 }
  const bySource = agg.by_source || []
  const topMsgs = agg.top_messages || []
  const burst = agg.burst || []
  const rawItems = rawRes.items || []
  const fmtTime = (s) => { try { return new Date(s.replace(' ', 'T') + 'Z').toLocaleString() } catch { return s } }
  const sevColor = (n) => n > 100 ? '#dc2626' : n > 10 ? '#d97706' : '#16a34a'

  app.innerHTML = shell(`
    <button class="btn btn-gray btn-sm" style="width:auto;margin-bottom:10px" onclick="history.back()">${t('← 返回')}</button>
    <h1 class="page-title">🛑 ${t('错误监控')}</h1>
    <div style="font-size:11px;color:#6b7280;margin-bottom:14px">${t('过去 24 小时所有 server / 客户端错误聚合。burst 阈值：1h > ')}${agg.thresholds?.burst_1h || 50} ${t('或 10min > ')}${agg.thresholds?.burst_10m || 20}</div>

    ${burst.length > 0 ? `
      <div class="alert" style="background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:12px;border-radius:8px;margin-bottom:14px;font-size:13px;line-height:1.6">
        <div style="font-weight:700;margin-bottom:4px">🚨 ${t('Burst 告警')} — ${burst.length} ${t('个 source 异常')}</div>
        ${burst.map(b => `<div>· <strong>${escHtml(b.source)}</strong> · ${escHtml(b.reason)}</div>`).join('')}
      </div>` : ''}

    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600;margin-bottom:10px">📊 ${t('总计（24h 窗口）')}</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;font-size:12px">
        <div style="text-align:center"><div style="font-size:22px;font-weight:800;color:${sevColor(totals.total_24h)}">${totals.total_24h || 0}</div><div style="color:#9ca3af;margin-top:2px">${t('24h 总数')}</div></div>
        <div style="text-align:center"><div style="font-size:22px;font-weight:800;color:${sevColor(totals.total_1h)}">${totals.total_1h || 0}</div><div style="color:#9ca3af;margin-top:2px">${t('1h 总数')}</div></div>
        <div style="text-align:center"><div style="font-size:22px;font-weight:800;color:${sevColor(totals.total_10m)}">${totals.total_10m || 0}</div><div style="color:#9ca3af;margin-top:2px">${t('10min 总数')}</div></div>
      </div>
    </div>

    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600;margin-bottom:10px">📡 ${t('按 source 分组')}</div>
      ${bySource.length === 0 ? `<div style="font-size:12px;color:#9ca3af;text-align:center;padding:20px">${t('过去 24h 无错误 🎉')}</div>` : `
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead style="background:#f9fafb">
          <tr>
            <th style="text-align:left;padding:6px 8px;color:#6b7280;font-weight:600">source</th>
            <th style="text-align:right;padding:6px 8px;color:#6b7280;font-weight:600">24h</th>
            <th style="text-align:right;padding:6px 8px;color:#6b7280;font-weight:600">1h</th>
            <th style="text-align:right;padding:6px 8px;color:#6b7280;font-weight:600">10min</th>
            <th style="text-align:left;padding:6px 8px;color:#6b7280;font-weight:600">last_seen</th>
          </tr>
        </thead>
        <tbody>
          ${bySource.map(r => `
            <tr style="border-top:1px solid #f3f4f6">
              <td style="padding:6px 8px;font-family:monospace">${escHtml(r.source)}</td>
              <td style="padding:6px 8px;text-align:right;color:${sevColor(r.cnt_24h)};font-weight:600">${r.cnt_24h}</td>
              <td style="padding:6px 8px;text-align:right;color:${sevColor(r.cnt_1h)}">${r.cnt_1h}</td>
              <td style="padding:6px 8px;text-align:right;color:${sevColor(r.cnt_10m)}">${r.cnt_10m}</td>
              <td style="padding:6px 8px;color:#6b7280;font-size:11px">${fmtTime(r.last_seen)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`}
    </div>

    ${topMsgs.length > 0 ? `
    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600;margin-bottom:10px">🔁 ${t('top 10 高频错误（前 100 字符 hash）')}</div>
      ${topMsgs.map(m => `
        <div style="padding:8px 0;border-top:1px solid #f3f4f6;font-size:12px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div style="flex:1;min-width:0">
              <div style="font-family:monospace;color:#374151;word-break:break-all;line-height:1.4">${escHtml(m.msg)}</div>
              <div style="font-size:10px;color:#9ca3af;margin-top:3px">${escHtml(m.source)} · ${fmtTime(m.last_seen)}</div>
            </div>
            <div style="font-size:14px;font-weight:800;color:${sevColor(m.cnt)};flex-shrink:0">${m.cnt}</div>
          </div>
        </div>`).join('')}
    </div>` : ''}

    <div class="card" style="padding:14px">
      <div style="font-size:13px;font-weight:600;margin-bottom:10px">📜 ${t('最近 20 条原始记录')}</div>
      ${rawItems.length === 0 ? `<div style="font-size:12px;color:#9ca3af;text-align:center;padding:20px">${t('暂无')}</div>` : rawItems.map(it => `
        <details style="padding:8px 0;border-top:1px solid #f3f4f6;font-size:12px">
          <summary style="cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
            <span style="flex:1;min-width:0"><span style="font-family:monospace;color:#dc2626">${escHtml(it.source)}</span> · <span style="color:#374151">${escHtml((it.message || '').slice(0, 80))}</span></span>
            <span style="font-size:10px;color:#9ca3af;flex-shrink:0">${fmtTime(it.created_at)}</span>
          </summary>
          <div style="padding:8px 0 0;font-size:11px;color:#6b7280;line-height:1.5">
            ${it.stack ? `<div style="margin-bottom:6px"><div style="color:#9ca3af;font-size:10px">stack</div><pre style="font-family:monospace;white-space:pre-wrap;word-break:break-all;background:#f9fafb;padding:6px;border-radius:4px;font-size:10px;margin:2px 0">${escHtml(it.stack)}</pre></div>` : ''}
            ${it.url ? `<div><span style="color:#9ca3af">URL: </span>${escHtml(it.url)}</div>` : ''}
            ${it.user_id ? `<div><span style="color:#9ca3af">user: </span>${escHtml(it.user_id)}</div>` : ''}
            ${it.user_agent ? `<div><span style="color:#9ca3af">UA: </span>${escHtml(it.user_agent)}</div>` : ''}
          </div>
        </details>
      `).join('')}
    </div>
  `, 'admin')
}

// Wave F-5: 实时事件 stream
let _adminEventSource = null
async function renderAdminEvents(app) {
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(loading$(), 'admin')
  const r = await GET('/admin/events/recent?limit=100')
  if (r.error) { app.innerHTML = shell(alert$('error', r.error), 'admin'); return }
  const items = r?.items || []
  app.innerHTML = shell(`
    <button class="btn btn-gray btn-sm" style="width:auto;margin-bottom:10px" onclick="closeAdminEvents()">${t('← 返回')}</button>
    <h1 class="page-title">📡 ${t('实时事件 stream')}</h1>
    <div id="evt-status" style="font-size:11px;color:#9ca3af;margin-bottom:8px">${t('已连接')} · ${t('显示最近')} ${items.length} ${t('条')}</div>
    <div id="evt-list" style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;max-height:70vh;overflow-y:auto">
      ${items.map(e => renderEventRow(e)).join('')}
    </div>
  `, 'admin')
  // 启动 SSE — P0-1: 先用 api_key 换一次性 ticket，再用 ticket 建连接
  if (_adminEventSource) { try { _adminEventSource.close() } catch {} }
  const ticketRes = await POST('/admin/events/ticket', {})
  if (ticketRes.error || !ticketRes.ticket) {
    const s = document.getElementById('evt-status')
    if (s) s.innerHTML = `<span style="color:#dc2626">⚠ ${t('鉴权失败')}: ${ticketRes.error || '—'}</span>`
    return
  }
  _adminEventSource = new EventSource(`/api/admin/events/stream?ticket=${encodeURIComponent(ticketRes.ticket)}`)
  _adminEventSource.onmessage = (ev) => {
    try {
      const evt = JSON.parse(ev.data)
      if (evt.type === 'hello') return
      const list = document.getElementById('evt-list')
      if (!list) return
      const wrap = document.createElement('div')
      wrap.innerHTML = renderEventRow(evt)
      list.prepend(wrap.firstElementChild)
      // 限制 DOM 100 条
      while (list.children.length > 100) list.lastElementChild.remove()
    } catch {}
  }
  _adminEventSource.onerror = () => {
    const s = document.getElementById('evt-status')
    if (s) s.innerHTML = `<span style="color:#dc2626">⚠ ${t('连接中断')}</span>`
  }
}

window.closeAdminEvents = () => {
  if (_adminEventSource) { try { _adminEventSource.close() } catch {}; _adminEventSource = null }
  history.back()
}

// ─── admin read-only hubs + helpers (classic split, slice B) ───
// adminPageHeader/adminLinkCard are shared admin helpers; render* are read-only
// hub/audit pages. Same global-scope rules as the rest of this file.

// 向后兼容 — 老 admin 代码用 adminPageHeader
function adminPageHeader(icon, title, subtitle) { return pageHeader(icon, title, subtitle, 'admin') }
// admin 通用卡片网格 helper
function adminLinkCard(icon, label, sub, hash, badge) {
  return `<div onclick="location.hash='${hash}'" class="card" style="padding:14px;cursor:pointer;display:flex;align-items:center;gap:10px;min-height:64px;position:relative;transition:transform 0.1s" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">
    <div style="font-size:24px;flex-shrink:0">${icon}</div>
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;font-size:14px">${label}</div>
      ${sub ? `<div style="font-size:11px;color:#9ca3af;margin-top:2px">${sub}</div>` : ''}
    </div>
    ${badge != null && badge !== '' ? `<div style="background:#dc2626;color:#fff;border-radius:99px;font-size:10px;padding:2px 7px;min-width:18px;text-align:center;flex-shrink:0;font-weight:600">${badge}</div>` : ''}
  </div>`
}

// === #admin/content 内容管理 hub ===
async function renderAdminContent(app) {
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin-content'); return }
  app.innerHTML = shell(loading$(), 'admin-content')
  const [dash, reportsRes] = await Promise.all([
    GET('/admin/dashboard').catch(() => ({})),
    GET('/admin/wish-reports?status=pending').catch(() => ({ items: [] })),
  ])
  const pendingReports = reportsRes?.items?.length || 0
  app.innerHTML = shell(`
    ${adminPageHeader('📦', t('内容管理'), t('商品 / 订单 / 慈善举报 集中处理'))}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      ${adminLinkCard('📦', t('商品管理'), t('强制下架 / 批量'), '#admin/products')}
      ${adminLinkCard('🧾', t('订单只读'), t('全平台监控'), '#admin/orders')}
      ${adminLinkCard('🌸', t('慈善举报'), pendingReports > 0 ? t('待处理 ') + pendingReports : t('无待处理'), '#admin/wish-reports', pendingReports || '')}
      ${adminLinkCard('🚫', t('用户黑名单'), t('封号 / 警告记录'), '#admin/users')}
    </div>
  `, 'admin-content')
}

// === #admin/arbitration 仲裁与审核 hub ===
async function renderAdminArbitration(app) {
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin-arbitration'); return }
  app.innerHTML = shell(loading$(), 'admin-arbitration')
  const dash = await GET('/admin/dashboard').catch(() => ({}))
  app.innerHTML = shell(`
    ${adminPageHeader('⚖', t('仲裁与审核'), t('争议案件 / 验证任务 / 仲裁员监管'))}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      ${adminLinkCard('⚖️', t('争议监控'), t('全平台仲裁案件'), '#admin/disputes', dash.disputes_open || '')}
      ${adminLinkCard('🔎', t('验证任务'), t('claim 任务监控'), '#admin/tasks', dash.verify_tasks_open || '')}
    </div>
  `, 'admin-arbitration')
}

async function renderAdminAudit(app) {
  if (!state.user) { renderLogin(); return }
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin-audit'); return }
  app.innerHTML = shell(loading$(), 'admin-audit')
  const data = await GET('/admin/audit-log')
  if (data.error) { app.innerHTML = shell(alert$('error', data.error), 'admin-audit'); return }
  const items = data.entries.length
    ? data.entries.map(e => `
        <div class="card" style="margin-bottom:10px;font-size:13px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div style="flex:1;min-width:0">
              <div><strong>${e.action}</strong> · <span style="color:#6b7280">${escHtml(e.admin_name || e.admin_id)}</span></div>
              ${e.target_id ? `<div style="font-size:11px;color:#6b7280;margin-top:2px">${e.target_type || ''}: ${e.target_id}</div>` : ''}
              ${e.detail && Object.keys(e.detail).length ? `<pre style="font-size:11px;background:#f9fafb;padding:6px;border-radius:4px;margin-top:6px;overflow:auto;white-space:pre-wrap">${escHtml(JSON.stringify(e.detail))}</pre>` : ''}
            </div>
            <div style="font-size:11px;color:#9ca3af;white-space:nowrap">${fmtTime(e.created_at)}</div>
          </div>
        </div>`).join('')
    : `<div class="empty"><div class="empty-icon">📜</div><div class="empty-text">${t('暂无操作记录')}</div></div>`
  app.innerHTML = shell(`
    <h1 class="page-title">📜 ${t('操作审计')}</h1>
    <div style="font-size:12px;color:#6b7280;margin-bottom:12px">${t('最近 50 条 admin 操作记录')}</div>
    ${items}
  `, 'admin-audit')
}

// ─── admin overview / metrics / security (read-only; classic split, slice C) ───
// kpiGrid / pageHeader / adminPageHeader stay in app.js / app-admin.js as shared
// globals; these read-only pages resolve them at call time (route/click).

async function renderAdminKPI(app) {
  if (!state.user) { renderLogin(); return }
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(loading$(), 'admin')
  const r = await GET('/admin/protocol-kpi')
  if (r.error) { app.innerHTML = shell(alert$('error', r.error), 'admin'); return }

  const fmt = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
  const fmt2 = (n) => Number(n || 0).toFixed(2)
  const pct = (n) => (Number(n || 0) * 100).toFixed(2) + '%'

  // Activity 卡片
  const activityCard = `
    <div class="card" style="padding:14px;margin-bottom:10px;background:linear-gradient(135deg,#eef2ff,#fff)">
      <div style="font-size:14px;font-weight:700;margin-bottom:8px">📊 ${t('活跃度')}</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;text-align:center">
        <div><div style="font-size:24px;font-weight:700;color:#4f46e5">${fmt(r.activity.dau_proxy)}</div><div style="font-size:10px;color:#6b7280">${t('DAU')} (${t('近似')})</div></div>
        <div><div style="font-size:24px;font-weight:700;color:#7c3aed">${fmt(r.activity.mau_proxy)}</div><div style="font-size:10px;color:#6b7280">${t('MAU')} (${t('近似')})</div></div>
      </div>
    </div>
  `

  // 多窗口订单/GMV 表
  const windowRows = r.activity.windows.map(w => `
    <tr style="border-bottom:1px solid #f3f4f6;font-size:12px">
      <td style="padding:8px;font-weight:600">${w.label}</td>
      <td style="padding:8px;text-align:right">${fmt(w.orders)}</td>
      <td style="padding:8px;text-align:right">${fmt(w.completed)}</td>
      <td style="padding:8px;text-align:right;color:#4f46e5;font-weight:600">${fmt2(w.gmv)}</td>
      <td style="padding:8px;text-align:right;color:${w.dispute_rate > 0.05 ? '#dc2626' : '#374151'}">${pct(w.dispute_rate)}</td>
      <td style="padding:8px;text-align:right;color:${w.refund_rate > 0.05 ? '#dc2626' : '#374151'}">${pct(w.refund_rate)}</td>
      <td style="padding:8px;text-align:right;color:#16a34a">${fmt(w.new_users)}</td>
    </tr>
  `).join('')
  const windowsCard = `
    <div class="card" style="padding:0;margin-bottom:10px;overflow-x:auto">
      <div style="padding:12px;font-size:13px;font-weight:600;background:#f9fafb;border-bottom:1px solid #e5e7eb">📈 ${t('多窗口对比')}</div>
      <table style="width:100%;border-collapse:collapse;font-size:11px;min-width:480px">
        <thead><tr style="background:#fff;border-bottom:2px solid #e5e7eb;font-size:10px;color:#6b7280;text-transform:uppercase">
          <th style="padding:8px;text-align:left">${t('窗口')}</th>
          <th style="padding:8px;text-align:right">${t('订单')}</th>
          <th style="padding:8px;text-align:right">${t('完成')}</th>
          <th style="padding:8px;text-align:right">GMV</th>
          <th style="padding:8px;text-align:right">${t('争议率')}</th>
          <th style="padding:8px;text-align:right">${t('退款率')}</th>
          <th style="padding:8px;text-align:right">${t('新用户')}</th>
        </tr></thead>
        <tbody>${windowRows}</tbody>
      </table>
    </div>
  `

  // 用户分布
  const u = r.users
  const userCard = `
    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">👥 ${t('用户构成')} (${fmt(u.total)})</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:11px;text-align:center">
        <div><div style="font-weight:700;color:#1e40af">${fmt(u.buyers)}</div><div style="color:#9ca3af">${t('买家')}</div></div>
        <div><div style="font-weight:700;color:#9a3412">${fmt(u.sellers)}</div><div style="color:#9ca3af">${t('卖家')}</div></div>
        <div><div style="font-weight:700;color:#166534">${fmt(u.logistics)}</div><div style="color:#9ca3af">${t('物流')}</div></div>
        <div><div style="font-weight:700;color:#365314">${fmt(u.verifiers)}</div><div style="color:#9ca3af">${t('审核员')}</div></div>
        <div><div style="font-weight:700;color:#9d174d">${fmt(u.arbitrators)}</div><div style="color:#9ca3af">${t('仲裁员')}</div></div>
        <div><div style="font-weight:700;color:#991b1b">${fmt(u.admins)}</div><div style="color:#9ca3af">${t('管理员')}</div></div>
      </div>
    </div>
  `

  // 财务
  const f = r.finance
  const financeCard = `
    <div class="card" style="padding:14px;margin-bottom:10px;background:linear-gradient(135deg,#ecfdf5,#fff)">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">💰 ${t('财务')}</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;font-size:11px">
        <div><div style="color:#9ca3af">${t('sys_protocol 余额')}</div><div style="font-size:14px;font-weight:700;color:${f.sys_protocol_balance < 0 ? '#dc2626' : '#16a34a'}">${fmt2(f.sys_protocol_balance)} WAZ</div></div>
        <div><div style="color:#9ca3af">${t('已托管资金')}</div><div style="font-size:14px;font-weight:700;color:#4f46e5">${fmt2(f.total_escrowed)} WAZ</div></div>
        <div><div style="color:#9ca3af">${t('总质押')}</div><div style="font-size:14px;font-weight:700;color:#7c3aed">${fmt2(f.total_staked)} WAZ</div></div>
        <div><div style="color:#9ca3af">${t('平台拨付累计')}</div><div style="font-size:14px;font-weight:700;color:#d97706">${fmt2(f.platform_rewards_cumulative)} WAZ</div></div>
      </div>
      <div style="font-size:10px;color:#6b7280;margin-top:8px">${t('今日拨付')}: ${fmt2(f.platform_rewards_today)} WAZ</div>
    </div>
  `

  // 内容
  const c = r.content
  const contentCard = `
    <div class="card" style="padding:14px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">📦 ${t('内容生态')}</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;font-size:11px;text-align:center">
        <div><div style="font-size:14px;font-weight:700">${fmt(c.products_active)}/${fmt(c.products_total)}</div><div style="color:#9ca3af">${t('商品 active/total')}</div></div>
        <div><div style="font-size:14px;font-weight:700">${fmt(c.ratings_total)}</div><div style="color:#9ca3af">${t('累计评价')}</div></div>
        <div><div style="font-size:14px;font-weight:700">${fmt(c.push_subscriptions)}</div><div style="color:#9ca3af">${t('推送订阅')}</div></div>
      </div>
    </div>
  `

  // 信任
  const tr = r.trust_open
  const trustCard = `
    <div class="card" style="padding:14px;margin-bottom:10px;border-left:3px solid ${(tr.disputes_open + tr.feedback_open + tr.returns_pending) > 0 ? '#dc2626' : '#16a34a'}">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">🚨 ${t('待处理事项')}</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:11px;text-align:center">
        <div><div style="font-size:16px;font-weight:700;color:${tr.disputes_open > 0 ? '#dc2626' : '#374151'}">${fmt(tr.disputes_open)}</div><div style="color:#9ca3af">${t('未结争议')}</div></div>
        <div><div style="font-size:16px;font-weight:700;color:${tr.feedback_open > 0 ? '#d97706' : '#374151'}">${fmt(tr.feedback_open)}</div><div style="color:#9ca3af">${t('未受理反馈')}</div></div>
        <div><div style="font-size:16px;font-weight:700;color:${tr.returns_pending > 0 ? '#d97706' : '#374151'}">${fmt(tr.returns_pending)}</div><div style="color:#9ca3af">${t('待处理退货')}</div></div>
      </div>
    </div>
  `

  app.innerHTML = shell(`
    <button class="btn btn-gray btn-sm" style="width:auto;margin-bottom:10px" onclick="history.back()">${t('← 返回')}</button>
    <h1 class="page-title">📊 ${t('协议指标看板')}</h1>
    ${activityCard}
    ${windowsCard}
    ${trustCard}
    ${financeCard}
    ${userCard}
    ${contentCard}
  `, 'admin')
}

async function renderAdminDashboard(app) {
  if (!state.user) { renderLogin(); return }
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(loading$(), 'admin')
  const data = await GET('/admin/dashboard')
  if (data.error) { app.innerHTML = shell(alert$('error', data.error), 'admin'); return }
  const kpi1 = kpiGrid([
    { label: t('用户总数'), value: data.users },
    { label: t('卖家数'),   value: data.sellers },
    { label: t('在售商品'), value: data.products_active },
  ])
  const kpi2 = kpiGrid([
    { label: t('24h 订单'),  value: data.orders_24h },
    { label: t('24h GMV'),  value: Number(data.gmv_24h || 0).toFixed(2), unit: 'WAZ' },
    { label: t('系统锁仓'),  value: Number(data.total_locked || 0).toFixed(2), unit: 'WAZ' },
  ])
  const kpi3 = kpiGrid([
    { label: t('待处理争议'),   value: data.disputes_open },
    { label: t('待审验证任务'), value: data.verify_tasks_open },
    { label: t('已暂停账户'),   value: data.users_suspended },
  ])
  const kpi4 = kpiGrid([
    { label: t('待审申请'),     value: data.verifier_apps_pending ?? 0 },
    { label: t('待审申诉'),     value: data.verifier_appeals_pending ?? 0 },
    { label: t('活跃审核员'),   value: data.active_verifiers ?? 0 },
  ])
  const kpi5 = kpiGrid([
    { label: t('扩容申请'),     value: data.quota_apps_pending ?? 0 },
    { label: t('暂停发新品'),   value: data.listing_paused_count ?? 0 },
    { label: '—',               value: '—' },
  ])
  const tk = data.tokenomics || {}
  const kpiTokenomics1 = kpiGrid([
    { label: t('累计分享分润'),value: Number(tk.commission_total || 0).toFixed(2), unit: 'WAZ' },
    { label: t('PV 待处理'),   value: tk.ledger_pending ?? 0 },
    { label: t('参与记录用户'), value: tk.dirty_users ?? 0 },
  ])
  const kpiTokenomics2 = ''
  // 异常告警 banner — 多条件聚合
  const alerts = []
  if ((data.active_verifiers ?? 0) < 5) alerts.push({ icon: '⚠️', color: '#dc2626', text: t('活跃审核员不足 5 人 — 请尽快批准申请'), href: '#admin/verifier-applications' })
  if ((data.disputes_open ?? 0) > 10) alerts.push({ icon: '⚖️', color: '#dc2626', text: t('待处理争议') + ' > 10：' + data.disputes_open, href: '#admin/disputes' })
  if ((data.verifier_apps_pending ?? 0) > 5) alerts.push({ icon: '📥', color: '#d97706', text: t('待审申请积压') + ': ' + data.verifier_apps_pending, href: '#admin/verifier-applications' })
  if ((data.users_suspended ?? 0) > (data.users ?? 0) * 0.05) alerts.push({ icon: '⛔', color: '#d97706', text: t('暂停账户占比 > 5%') + ': ' + data.users_suspended, href: '#admin/users' })
  const lowVerifierWarn = alerts.length > 0 ? `
    <div style="margin-bottom:14px">
      <div style="font-size:11px;color:#6b7280;margin-bottom:4px;font-weight:600">🚨 ${t('需要关注')} (${alerts.length})</div>
      ${alerts.map(a => `<a href="${a.href}" style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:${a.color === '#dc2626' ? '#fef2f2' : '#fef3c7'};border:1px solid ${a.color === '#dc2626' ? '#fecaca' : '#fde68a'};color:${a.color};border-radius:8px;font-size:12px;margin-bottom:6px;text-decoration:none;font-weight:600"><span>${a.icon} ${a.text}</span><span>→</span></a>`).join('')}
    </div>
  ` : ''
  const quickAction = (href, icon, label) =>
    `<a href="${href}" style="text-decoration:none;color:inherit">
       <div class="card" style="text-align:center;cursor:pointer;padding:18px 8px">
         <div style="font-size:28px;margin-bottom:6px">${icon}</div>
         <div style="font-size:13px;font-weight:600">${label}</div>
       </div>
     </a>`
  const quickGrid = `
    <div style="font-size:13px;color:#6b7280;margin:16px 0 8px">${t('数据查看')}</div>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px">
      ${quickAction('#admin/products', '📦', t('商品管理'))}
      ${quickAction('#admin/orders',   '🧾', t('订单查看'))}
      ${quickAction('#admin/disputes', '⚖️', t('争议查看'))}
      ${quickAction('#admin/tasks',    '🔍', t('验证任务'))}
    </div>
    <div style="font-size:13px;color:#6b7280;margin:16px 0 8px">${t('审核员管理')}</div>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px">
      ${quickAction('#admin/verifier-applications', '📥', t('待审申请') + (data.verifier_apps_pending > 0 ? ` (${data.verifier_apps_pending})` : ''))}
      ${quickAction('#admin/verifier-appeals',      '📩', t('待审申诉') + (data.verifier_appeals_pending > 0 ? ` (${data.verifier_appeals_pending})` : ''))}
    </div>
    <div style="font-size:13px;color:#6b7280;margin:16px 0 8px">${t('卖家配额')}</div>
    <div style="display:grid;grid-template-columns:repeat(1,1fr);gap:10px;margin-bottom:16px">
      ${quickAction('#admin/quota-applications', '📥', t('扩容申请') + (data.quota_apps_pending > 0 ? ` (${data.quota_apps_pending})` : ''))}
    </div>
    <div style="font-size:13px;color:#6b7280;margin:16px 0 8px">⚛ ${t('Tokenomics')}</div>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px">
      ${quickAction('#admin/tokenomics', '⚙', t('协议运营 / 注册门控 / 佣金榜'))}
    </div>
    <div style="font-size:13px;color:#6b7280;margin:16px 0 8px">🔐 ${t('安全与审计')}</div>
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px">
      ${quickAction('#admin/security', '🪪', t('我的管理身份与权限'))}
      ${quickAction('#admin/audit',    '📜', t('审计日志'))}
    </div>`

  // A5 重设：渐变标题 + 分区标题 + 颜色块分组
  const sectionTitle = (icon, title, color) => `
    <div style="display:flex;align-items:center;gap:6px;margin:16px 0 6px">
      <div style="width:3px;height:14px;background:${color};border-radius:2px"></div>
      <div style="font-size:12px;color:#374151;font-weight:600">${icon} ${title}</div>
    </div>
  `
  app.innerHTML = shell(`
    ${adminPageHeader('🛡', t('管理员概览'), t('全平台 KPI · 异常告警 · 快捷操作'))}
    ${lowVerifierWarn}
    ${sectionTitle('👥', t('用户与商品'), '#3b82f6')}
    ${kpi1}
    ${sectionTitle('💰', t('交易与资金'), '#16a34a')}
    ${kpi2}
    ${sectionTitle('🚨', t('运营关注项'), '#dc2626')}
    ${kpi3}
    ${sectionTitle('🔍', t('审核员系统'), '#0891b2')}
    ${kpi4}
    ${sectionTitle('📥', t('卖家配额'), '#d97706')}
    ${kpi5}
    ${sectionTitle('⚙', t('协议运营'), '#9333ea')}
    ${kpiTokenomics1}
    ${kpiTokenomics2}
    ${sectionTitle('⚡', t('快捷操作'), '#4f46e5')}
    ${quickGrid}
  `, 'admin')
}

// 管理身份与权限自查面板(只读)。回答"我正在以什么身份/级别/权限操作?",
// Passkey 责任绑定状态 + GitHub 关联 + 普通 admin vs root/破玻璃 + 经济操作审计须知。
// 纯前端:数据来自 /me(state.user)+ 只读 /contribution-identity/github/me;无新后端、无经济动作。
async function renderAdminSecurity(app) {
  if (!state.user) { renderLogin(); return }
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(loading$(), 'admin')
  const u = state.user
  const gid = await GET('/contribution-identity/github/me').catch(() => null)
  const bindings = (gid && !gid.error && Array.isArray(gid.bindings)) ? gid.bindings : []

  const adminType = u.admin_type || 'root'
  const isRoot = adminType === 'root'
  const scope = u.admin_scope || 'global'
  let perms = []
  try { perms = isRoot ? ['all'] : JSON.parse(u.admin_permissions || '[]') } catch { perms = [] }
  const hasPasskey = !!u.has_passkey

  const PERM_LABEL = () => ({ all: t('全部'), users: t('用户'), content: t('内容'), arbitration: t('仲裁'), protocol: t('协议 / 经济'), verifier_mgmt: t('审核员管理'), support: t('支持') })
  const permChips = (perms.length === 0)
    ? `<span style="font-size:12px;color:#dc2626">${t('无任何权限（请联系 root 配置）')}</span>`
    : perms.map(p => `<span style="display:inline-block;background:#eef2ff;color:#3730a3;font-size:11px;padding:2px 8px;border-radius:99px;margin:0 4px 4px 0">${PERM_LABEL()[p] || p}</span>`).join('')

  const row = (label, value) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid #f3f4f6"><span style="font-size:12px;color:#6b7280">${label}</span><span style="font-size:12px;color:#111827;text-align:right;word-break:break-all">${value}</span></div>`

  const passkeyRow = hasPasskey
    ? `<span style="color:#16a34a;font-weight:600">✓ ${t('已绑定')}</span>`
    : `<span style="color:#dc2626;font-weight:600">⚠ ${t('未绑定')}</span> <a href="#me/settings" style="color:#6366f1;font-size:11px">${t('去绑定')} →</a>`
  const githubRow = bindings.length > 0
    ? bindings.map(b => `<code style="font-size:11px">github:${escHtml(String(b.github_actor_id))}</code>`).join(' ')
    : `<span style="color:#9ca3af">${t('未关联')}</span> <a href="#my-contributions" style="color:#6366f1;font-size:11px">${t('去认领')} →</a>`

  app.innerHTML = shell(`
    ${adminPageHeader('🪪', t('我的管理身份与权限'), t('你正在以此身份操作 · 只读自查'))}

    ${isRoot ? `
    <div class="card" style="padding:12px;background:#fffbeb;border:1px solid #fcd34d;margin-bottom:10px">
      <div style="font-size:13px;font-weight:700;color:#92400e">🚧 ${t('创始人 / 引导管理员（Founder Admin · Bootstrap Operator）')}</div>
      <div style="font-size:12px;color:#78350f;margin-top:4px;line-height:1.6">${t('这是当前的【过渡治理模式】:更广的只读可见性 + 有限的应急写权限 —— 不是日常全能账号。')}</div>
      <div style="font-size:11px;color:#78350f;margin-top:6px;line-height:1.6">${t('设计目标:把创始人权力持续拆成更窄的角色 —— maintainer / support operator / arbitrator / finance reviewer / security admin(用 regional admin + 权限位逐步收窄)。')}</div>
    </div>` : ''}

    <div class="card" style="padding:14px">
      <div style="font-size:13px;font-weight:700;margin-bottom:8px">👤 ${t('账户')}</div>
      ${row(t('名称'), escHtml(u.name || ''))}
      ${row(t('用户名'), '@' + escHtml(u.handle || ''))}
      ${row(t('账户 ID'), `<code style="font-size:11px">${escHtml(u.id || '')}</code>`)}
    </div>

    <div class="card" style="padding:14px">
      <div style="font-size:13px;font-weight:700;margin-bottom:8px">🛡 ${t('角色与级别')}</div>
      ${row(t('角色'), t('管理员'))}
      ${row(t('级别'), isRoot
        ? `<span style="color:#b91c1c;font-weight:700">ROOT</span> · <span style="font-size:11px;color:#6b7280">${t('破玻璃 / 系统操作员')}</span>`
        : `<span style="color:#0369a1;font-weight:700">REGIONAL</span>`)}
      ${row(t('范围'), `<code style="font-size:11px">${escHtml(scope)}</code>`)}
      <div style="font-size:12px;color:#6b7280;margin-top:8px;margin-bottom:4px">${t('有效权限')}</div>
      <div>${permChips}</div>
    </div>

    <div class="card" style="padding:14px">
      <div style="font-size:13px;font-weight:700;margin-bottom:8px">🔐 ${t('问责绑定')}</div>
      ${row('Passkey', passkeyRow)}
      ${row(t('GitHub 关联'), githubRow)}
      <div style="font-size:11px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;margin-top:8px;line-height:1.6">
        ${t('管理身份应绑定 Passkey（真人问责）。个人 GitHub 账号用于提交 PR;仓库所有权 / 设置由组织/管理身份治理 —— 独立审阅不应由同一人用另一账号假冒。')}
      </div>
    </div>

    <div class="card" style="padding:14px">
      <div style="font-size:13px;font-weight:700;margin-bottom:8px">⚠️ ${t('操作安全须知')}</div>
      <div style="font-size:12px;color:#374151;line-height:1.8">
        • ${t('普通 admin 与 root / 破玻璃 不同:经济 / 协议级操作需 protocol 权限;按治理铁律须记入审计日志 —— 部分手动结算 / 评估入口的审计仍在补齐中。')}<br>
        • ${t('危险操作（封禁 / 角色 / 资金 / 协议参数）须带原因,且不可绕过争议 / 仲裁规则。')}<br>
        • ${t('不要在公共设备暴露 API Key;管理操作均可追溯到你的账户。')}
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <a href="#admin/audit" style="text-decoration:none"><button class="btn btn-outline btn-sm" style="font-size:12px">📜 ${t('查看审计日志')}</button></a>
        ${isRoot ? `<a href="#admin/manage-admins" style="text-decoration:none"><button class="btn btn-outline btn-sm" style="font-size:12px">👥 ${t('管理管理员')}</button></a>` : ''}
      </div>
    </div>
  `, 'admin')
}
