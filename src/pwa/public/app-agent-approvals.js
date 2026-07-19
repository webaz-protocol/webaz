// RFC-020 — Agent 授权请求审批页(#agent-approvals)。一个已连接的 agent 请求【更多 SAFE 作用域 / 一个能力包】,
//   真人在这里审核并用 Passkey 批准或拒绝。批准 = 扩展该 agent 已有的委托凭证(仍只 SAFE、可撤销、按时长)。
//   经典脚本,全局函数;globals(GET/apiRead/state/shell/t/escHtml/fmtTime/loading$/grantDurationSelect)调用时解析。
//   本文件 = 渲染壳(壳/卡);状态机 + 交互(hydrate/approve/reject/错误态/reconcile)在 app-agent-approvals-state.js
//   (P0-A A2:ratchet 上限,新代码禁回塞本文件)。商家视角:只看【哪个 agent · 要做什么 · 风险 · 多久】。批准需 Passkey。
;(function () {
  const RISK = {
    low:    { label: '低风险', color: '#16a34a', bg: '#dcfce7' },
    medium: { label: '中风险', color: '#b45309', bg: '#fef3c7' },
    high:   { label: '高风险', color: '#dc2626', bg: '#fee2e2' },
  }

  // Lightweight badge: fill #aa-pending-badge with a pending count (called from the account/settings page).
  async function hydrateAgentApprovalsBadge() {
    const el = document.getElementById('aa-pending-badge'); if (!el || !state.user) return
    const res = await apiRead('/agent-grants/permission-requests')   // A4:带超时,徽章读绝不挂死
    const r = res.ok ? res.data : null
    const n = (r && Array.isArray(r.requests)) ? r.requests.length : 0
    el.innerHTML = n > 0 ? `<span style="display:inline-block;min-width:16px;height:16px;line-height:16px;text-align:center;font-size:10px;color:#fff;background:#dc2626;border-radius:999px;padding:0 5px;margin-left:4px">${n}</span>` : ''
  }
  window.hydrateAgentApprovalsBadge = hydrateAgentApprovalsBadge

  function renderAgentApprovals(app) {
    if (!state.user) { app.innerHTML = shell(`<div class="empty">${t('请先登录以审核 agent 授权请求')}</div>`, 'me'); return }
    app.innerHTML = shell(`
      <div class="page-header"><h2>${t('🔔 Agent 授权请求')}</h2></div>
      <div style="font-size:12px;color:#6b7280;padding:0 4px 12px;line-height:1.6">${t('一个已连接的 AI agent 在请求授权。【扩权请求】只扩展受限、可撤销的只读/草稿凭证,不动资金;【订单提交】批准会创建真实订单 —— 托管轨将从你的钱包扣款入托管(卡片列出全部条款,任何变化服务端拒绝执行)。投票/仲裁/改密钥永不可委托。')}</div>
      <div id="aa-body">${loading$()}</div>
    `, 'me')
    setTimeout(() => window.aaHydrate(), 30)   // aaHydrate 在 -state.js
  }
  window.renderAgentApprovals = renderAgentApprovals

  // 单卡渲染(状态机在 -state.js 调用 window.aaCard);批准门 = window.aaEconomicIncomplete(fail-closed)。
  function aaCard(r) {
    const risk = RISK[r.risk_level] || RISK.low
    const econIncomplete = window.aaEconomicIncomplete ? window.aaEconomicIncomplete(r) : false
    const scopes = Array.isArray(r.requested_scopes) ? r.requested_scopes : []
    // Prefer the human-readable bundle summary; otherwise show the individual safe-scope chips.
    const what = r.kind === 'order_action' ? (window.aaOrderWhat ? window.aaOrderWhat(r) : '') : r.kind === 'order_submit' ? (window.aaOrderSubmitWhat ? window.aaOrderSubmitWhat(r) : '') : r.kind === 'address_change' ? (window.aaAddressWhat ? window.aaAddressWhat(r) : '') : r.kind === 'buyer_action' ? (window.aaBuyerActionWhat ? window.aaBuyerActionWhat(r) : '') : r.human_summary
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
      ${econIncomplete ? `<div style="font-size:12px;line-height:1.7;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 10px;margin-top:8px">⚠️ <b>${t('经济信息暂时不完整')}</b>。${t('无法安全批准 —— 商品金额/币种/支付轨道未能读取。请稍后重试,或让 agent 重新报价并建草稿。')}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-outline" style="flex:1;color:#dc2626;border-color:#fecaca" onclick="aaReject('${escHtml(String(r.id))}')">${t('拒绝')}</button>
        <button class="btn btn-primary" style="flex:2" onclick="aaApprove('${escHtml(String(r.id))}')"${econIncomplete ? ' disabled title="' + t('经济信息不完整,暂不可批准') + '"' : ''}>🔑 ${t('用 Passkey 批准')}</button>
      </div>
    </div>`
  }
  window.aaCard = aaCard
})()
