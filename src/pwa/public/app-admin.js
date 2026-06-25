// WebAZ — admin monitoring pages (classic multi-script split, first slice)
//
// Loaded as a CLASSIC script BEFORE app.js (see index.html order):
//   i18n.js -> app-admin.js -> app.js
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
