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
    setTimeout(aaHydrate, 30)
  }
  window.renderAgentApprovals = renderAgentApprovals

  // P0-A A3 — 显式状态机错误卡。spinner 在任何路径都被替换(绝不永久 loading);错误卡给可行的下一步。
  function aaErrorCard(opts) {
    const actions = (opts.actions || []).map(a => `<button class="btn ${a.primary ? 'btn-primary' : 'btn-outline'}" style="margin-top:8px;margin-right:8px" onclick="${a.onclick}">${escHtml(t(a.label))}</button>`).join('')
    return `<div class="card" style="padding:16px;border:1px solid #fde68a;background:#fffbeb">
      <div style="font-size:14px;font-weight:600;color:#92400e;margin-bottom:4px">${escHtml(opts.title)}</div>
      <div style="font-size:12px;color:#6b7280;line-height:1.7">${escHtml(opts.detail || '')}</div>
      <div>${actions}</div>
    </div>`
  }
  const AA_RETRY = { label: '重试', onclick: 'aaHydrate()' }
  const AA_BACK = { label: '返回审批中心', onclick: "location.hash='#agent-approvals';aaHydrate()" }
  const AA_LOGIN = { label: '重新登录', onclick: "navigate('me')" }
  // Map a READ result (apiRead) to an explicit error state, or null if it's a usable success.
  function aaReadError(res) {
    if (res.ok) return null
    if (res.timedOut) return aaErrorCard({ title: t('加载超时'), detail: t('服务器暂时没有响应。请重试;不会重复创建任何请求或订单。'), actions: [{ ...AA_RETRY, primary: true }, AA_BACK] })
    if (res.networkError || res.status === 0) return aaErrorCard({ title: t('网络异常'), detail: t('无法连接服务器。请检查网络后重试。'), actions: [{ ...AA_RETRY, primary: true }] })
    if (res.status === 401) return aaErrorCard({ title: t('登录已失效'), detail: t('请重新登录后再查看审批请求。'), actions: [{ ...AA_LOGIN, primary: true }] })
    return aaErrorCard({ title: t('无法读取授权请求'), detail: (res.data && res.data.error) || ('HTTP ' + res.status), actions: [{ ...AA_RETRY, primary: true }, AA_BACK] })
  }

  async function aaHydrate() {
    const box = document.getElementById('aa-body'); if (!box) return
    box.innerHTML = loading$()   // A3:每次进入都回到 loading,任一分支落地都会替换它
    const deepId = (location.hash.split('/')[1] || '').trim()
    // 列表读(带超时);深链接目标即使不在 actionable 列表,也用单条端点补齐终态,绝不停在 spinner。
    const res = await apiRead('/agent-grants/permission-requests')
    const err = aaReadError(res)
    if (err) { box.innerHTML = err; return }
    const reqs = Array.isArray(res.data.requests) ? res.data.requests : []
    if (reqs.length === 0) {
      // 深链接但列表空 → 该请求可能已终结,用单条端点给精确终态(而非泛泛"暂无")。
      if (deepId) { await aaRenderDeepTerminal(box, deepId); return }
      box.innerHTML = `<div class="empty" style="padding:40px 16px;text-align:center">
        <div style="font-size:32px;margin-bottom:8px">✅</div>
        <div style="font-weight:600;margin-bottom:4px">${t('暂无待处理的授权请求')}</div>
        <div style="color:#9ca3af;font-size:12px">${t('当你的 agent 请求更多权限时,会出现在这里等你批准。')}</div>
      </div>`
      return
    }
    try { if (window.aaMarkSimilarSubmits) window.aaMarkSimilarSubmits(reqs) } catch (e) { /* A3:辅助逻辑绝不阻断主渲染 */ }
    box.innerHTML = reqs.map(aaCard).join('')
    // 深链接目标若不在 actionable 列表,单条端点补精确终态卡在顶部(替代旧的泛泛提示)。
    if (deepId && !reqs.some(r => String(r.id) === deepId)) { await aaRenderDeepTerminal(box, deepId, true) }
    else { try { if (window.aaApplyDeepLink) window.aaApplyDeepLink(box) } catch (e) { /* 高亮失败不影响主体 */ } }
  }
  window.aaHydrate = aaHydrate

  // A1 单条端点(agent 投影 shape:status/executed_order_id)用于精确终态展示 —— 深链接指向的请求已执行/拒绝/过期。
  async function aaRenderDeepTerminal(box, id, prepend) {
    const res = await apiRead('/agent-grants/permission-requests/' + encodeURIComponent(id))
    let html
    if (res.status === 404) html = aaErrorCard({ title: t('审批请求未找到'), detail: t('该请求不存在,或不属于你。'), actions: [AA_BACK] })
    else if (!res.ok) { const e = aaReadError(res); html = e || aaErrorCard({ title: t('无法读取该审批请求'), actions: [{ ...AA_RETRY, primary: true }, AA_BACK] }) }
    else {
      const d = res.data, s = String(d.status || '')
      if (s === 'executed') html = aaErrorCard({ title: '✅ ' + t('该审批已执行'), detail: t('正式订单已创建') + (d.executed_order_id ? ' · ' + d.executed_order_id : '') + '。', actions: [d.executed_order_id ? { label: '查看订单', onclick: `navigate('order-detail','${escHtml(String(d.executed_order_id))}')`, primary: true } : null, AA_BACK].filter(Boolean) })
      else if (s === 'rejected') html = aaErrorCard({ title: t('该审批已被拒绝'), detail: t('如需继续,请让 agent 重新发起请求。'), actions: [AA_BACK] })
      else if (s === 'expired') html = aaErrorCard({ title: t('该审批已过期'), detail: t('请让 agent 重新报价并提交。'), actions: [AA_BACK] })
      else html = aaErrorCard({ title: t('该审批请求当前不可操作'), detail: t('状态') + ': ' + escHtml(s || '—'), actions: [{ ...AA_RETRY, primary: true }, AA_BACK] })
    }
    if (prepend) { const wrap = document.createElement('div'); wrap.innerHTML = html; box.prepend(wrap.firstElementChild) } else { box.innerHTML = html }
  }

  function aaCard(r) {
    const risk = RISK[r.risk_level] || RISK.low
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
      ${r.kind === 'order_submit' && r.summary_unavailable ? `<div style="font-size:12px;line-height:1.7;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 10px;margin-top:8px">⚠️ <b>${t('经济信息暂时不完整')}</b>。${t('无法安全批准 —— 商品金额/币种/支付轨道未能读取。请稍后重试,或让 agent 重新报价并建草稿。')}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-outline" style="flex:1;color:#dc2626;border-color:#fecaca" onclick="aaReject('${escHtml(String(r.id))}')">${t('拒绝')}</button>
        <button class="btn btn-primary" style="flex:2" onclick="aaApprove('${escHtml(String(r.id))}')"${(r.kind === 'order_submit' && r.summary_unavailable) ? ' disabled title="' + t('经济信息不完整,暂不可批准') + '"' : ''}>🔑 ${t('用 Passkey 批准')}</button>
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
    // A4:批准是钱路相邻写 —— 前端超时 ≠ 服务端未执行。超时/网络中断绝不盲目重试(可能已建单),改查原请求状态和解。
    const w = await apiWriteIdempotent('POST', '/agent-grants/permission-requests/' + encodeURIComponent(id) + '/approve', { webauthn_token: token, duration: window.grantDurationValue('aa-dur-' + id) })
    if (w.unknownOutcome) {
      toast$(t('请求结果暂时未知,正在核对原请求状态…'))
      const chk = await apiRead('/agent-grants/permission-requests/' + encodeURIComponent(id))
      if (chk.ok && chk.data && String(chk.data.status) === 'executed') { toast$(t('已批准 —— 订单已创建') + (chk.data.executed_order_id ? ' ' + chk.data.executed_order_id : '')); aaHydrate(); hydrateAgentApprovalsBadge(); return }
      // 未执行 → 服务端对同一请求的再次 Passkey 批准是幂等的(需和解路径,绝不重复建单),故可安全再批。
      toast$(chk.ok ? t('订单尚未创建 —— 可安全地再次用 Passkey 批准,不会重复下单。') : t('暂时无法核对结果,请稍后在审批中心查看。'), 'error')
      if (btn) btn.disabled = false; aaHydrate(); return
    }
    if (!w.ok || (w.data && w.data.error)) { toast$((w.data && w.data.error) || t('批准失败,请重试'), 'error'); if (btn) btn.disabled = false; return }
    const r = w.data || {}
    toast$(r.kind === 'order_submit' ? t('已批准 —— 订单已创建') + (r.order_id ? ' ' + r.order_id : '') : t('已批准 —— 该 agent 的权限已扩展'))
    aaHydrate(); hydrateAgentApprovalsBadge()
  }

  window.aaReject = async (id) => {
    if (!confirm(t('确认拒绝这个授权请求?'))) return
    const w = await apiWriteIdempotent('POST', '/agent-grants/permission-requests/' + encodeURIComponent(id) + '/reject', {})
    if (w.unknownOutcome) { toast$(t('结果未知,正在核对…')); aaHydrate(); return }   // 拒绝幂等;重读列表即为真相,不盲重试
    if (!w.ok || (w.data && w.data.error)) { toast$((w.data && w.data.error) || t('操作失败'), 'error'); return }
    toast$(t('已拒绝该授权请求'))
    aaHydrate(); hydrateAgentApprovalsBadge()
  }
})()
