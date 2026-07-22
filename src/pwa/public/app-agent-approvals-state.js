// P0-A A2/A3/A4 — 审批页状态机 + 交互(从 app-agent-approvals.js 拆出:ratchet 上限)。
//   显式状态:loading→ready/empty/timeout/network_error/unauthorized/not_found/terminal;spinner 任何路径必清。
//   读经 apiRead(超时可安全重试);写经 apiWriteIdempotent(超时→reconcile 重读状态,绝不盲重试)。
//   globals(window.aaCard/apiRead/apiWriteIdempotent/hydrateAgentApprovalsBadge/loading$/escHtml/t/toast$/
//   navigate/requestPasskeyGate/grantDurationValue/state)调用时解析。
;(function () {
  // A3 — 显式状态机错误卡。spinner 在任何路径都被替换(绝不永久 loading);错误卡给可行的下一步。
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

  // A4/Codex-R1(fail-closed):order_submit 必须有【完整】经济摘要才可批准 —— 金额/币种/轨道任一缺失即禁批,
  //   不只依赖服务端 summary_unavailable 标记(部分部署/响应变形/坏缓存可能两者都无)。绝不 fail-open。
  window.aaEconomicIncomplete = function (r) {
    if (r.kind !== 'order_submit') return false
    if (r.summary_unavailable) return true
    const s = r.submit_summary
    return !s || typeof s !== 'object' || s.payable_units == null || !s.currency || !s.payment_rail || s.payment_rail === 'deferred' || (s.payment_rail === 'direct_p2p' && s.direct_pay_destination_resolvable === false)   // RFC-029 Design A:'deferred'(尚未选支付方式)= 经济不完整 → 禁批,直到确认页选定
  }

  async function aaHydrate() {
    const box = document.getElementById('aa-body'); if (!box) return
    box.innerHTML = loading$()   // A3:每次进入都回到 loading,任一分支落地都会替换它
    // A3(Codex R1 HIGH):整个 hydrate 包 try/catch —— 任何意外抛出(如 200+空/坏 JSON body 的 .requests 解引用)
    //   都必须落到明确错误态,绝不让 spinner 永留。这是本 PR 的核心不变量。
    try { await aaHydrateInner(box) }
    catch (e) { box.innerHTML = aaErrorCard({ title: t('无法读取授权请求'), detail: (e && e.message) || '', actions: [{ ...AA_RETRY, primary: true }, AA_BACK] }) }
  }
  window.aaHydrate = aaHydrate

  async function aaHydrateInner(box) {
    const deepId = (location.hash.split('/')[1] || '').trim()
    const res = await apiRead('/agent-grants/permission-requests')   // 列表读(带超时)
    const err = aaReadError(res)
    if (err) { box.innerHTML = err; return }
    if (!res.data || typeof res.data !== 'object') { box.innerHTML = aaErrorCard({ title: t('无法读取授权请求'), detail: t('服务器返回了无法解析的内容。'), actions: [{ ...AA_RETRY, primary: true }, AA_BACK] }); return }   // 200 但空/坏体 → 明确错误,不解引用 null
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
    box.innerHTML = reqs.map(window.aaCard).join(''); if (window.aaLoadDeferredPay) window.aaLoadDeferredPay(box)   // RFC-029 Design A:载入 deferred 卡的支付方式选择器
    // 深链接目标若不在 actionable 列表,单条端点补精确终态卡在顶部(替代旧的泛泛提示)。
    if (deepId && !reqs.some(r => String(r.id) === deepId)) { await aaRenderDeepTerminal(box, deepId, true) }
    else { try { if (window.aaApplyDeepLink) window.aaApplyDeepLink(box) } catch (e) { /* 高亮失败不影响主体 */ } }
  }

  // A1 单条端点(agent 投影 shape:status/executed_order_id)用于精确终态展示 —— 深链接指向的请求已执行/拒绝/过期。
  async function aaRenderDeepTerminal(box, id, prepend) {
    const res = await apiRead('/agent-grants/permission-requests/' + encodeURIComponent(id))
    let html
    if (res.status === 404) html = aaErrorCard({ title: t('审批请求未找到'), detail: t('该请求不存在,或不属于你。'), actions: [AA_BACK] })
    else if (!res.ok) { const e = aaReadError(res); html = e || aaErrorCard({ title: t('无法读取该审批请求'), actions: [{ ...AA_RETRY, primary: true }, AA_BACK] }) }
    else {
      const d = res.data, s = String(d.status || '')
      if (s === 'executed') html = aaErrorCard({ title: '✅ ' + t('该审批已执行'), detail: t('正式订单已创建') + (d.executed_order_id ? ' · ' + d.executed_order_id : '') + '。', actions: [d.executed_order_id ? { label: '查看订单', onclick: `navigate('#order/${escHtml(String(d.executed_order_id))}')`, primary: true } : null, AA_BACK].filter(Boolean) })
      else if (s === 'rejected') html = aaErrorCard({ title: t('该审批已被拒绝'), detail: t('如需继续,请让 agent 重新发起请求。'), actions: [AA_BACK] })
      else if (s === 'expired') html = aaErrorCard({ title: t('该审批已过期'), detail: t('请让 agent 重新报价并提交。'), actions: [AA_BACK] })
      else html = aaErrorCard({ title: t('该审批请求当前不可操作'), detail: t('状态') + ': ' + escHtml(s || '—'), actions: [{ ...AA_RETRY, primary: true }, AA_BACK] })
    }
    if (prepend) { const wrap = document.createElement('div'); wrap.innerHTML = html; box.prepend(wrap.firstElementChild) } else { box.innerHTML = html }
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
      if (chk.ok && chk.data && String(chk.data.status) === 'executed') { toast$(t('已批准 —— 订单已创建') + (chk.data.executed_order_id ? ' ' + chk.data.executed_order_id : '')); aaHydrate(); window.hydrateAgentApprovalsBadge(); return }
      // 未执行 → 服务端对同一请求的再次 Passkey 批准是幂等的(需和解路径,绝不重复建单),故可安全再批。
      toast$(chk.ok ? t('订单尚未创建 —— 可安全地再次用 Passkey 批准,不会重复下单。') : t('暂时无法核对结果,请稍后在审批中心查看。'), 'error')
      if (btn) btn.disabled = false; aaHydrate(); return
    }
    if (!w.ok || (w.data && w.data.error)) { toast$((w.data && w.data.error) || t('批准失败,请重试'), 'error'); if (btn) btn.disabled = false; return }
    const r = w.data || {}
    toast$(r.kind === 'order_submit' ? t('已批准 —— 订单已创建') + (r.order_id ? ' ' + r.order_id : '') : t('已批准 —— 该 agent 的权限已扩展'))
    aaHydrate(); window.hydrateAgentApprovalsBadge()
  }

  window.aaReject = async (id) => {
    if (!confirm(t('确认拒绝这个授权请求?'))) return
    const w = await apiWriteIdempotent('POST', '/agent-grants/permission-requests/' + encodeURIComponent(id) + '/reject', {})
    if (w.unknownOutcome) { toast$(t('结果未知,正在核对…')); aaHydrate(); return }   // 拒绝幂等;重读列表即为真相,不盲重试
    if (!w.ok || (w.data && w.data.error)) { toast$((w.data && w.data.error) || t('操作失败'), 'error'); return }
    toast$(t('已拒绝该授权请求'))
    aaHydrate(); window.hydrateAgentApprovalsBadge()
  }
})()
