// Direct Pay (Rail 1) — bilingual UI wiring (PR-4f-b / 5c)。UI ONLY;直付(direct_p2p)可用性 per-seller/product 实时数据驱动(见 GET /api/direct-pay/availability);注:escrow 轨仍模拟 WAZ(独立开关 _wazSimulated,非直付)。
//   WebAZ【不托管本金】、不担保、不退款/维权,也不验证/路由卖家付款方式或币种;不做 USDC/fiat/PSP/链上、不碰
//   wallet/escrow/settlement/refund/订单钱路。真实强制全在后端(#92/#93 两次披露 + 现场真人 Passkey 硬门控;前端只带输入)。
//   只把已合并后端能力(#96 收款说明、#94 建单、#92/#93 ack+Passkey、#98+ 控制面/可用性)接到 PWA。
//   面向用户中文文案走 t(),英文在 i18n.js _EN(双语 parity 由 test-direct-pay-ui.ts 守)。

// ── 错误码 → 双语文案(后端返回的 error_code → 清楚的中英文提示)──────────────────────────────
window.dpErrorText = (code, fallback) => {
  const M = {
    DIRECT_PAY_DISABLED: t('直付当前未开放'),
    DIRECT_PAY_RAIL_BREAKER: t('直付暂停受理(运营维护中),请稍后再试'),
    DIRECT_PAY_REGION_UNSUPPORTED: t('直付在你所在地区暂未开放'),
    DIRECT_PAY_CAP_EXCEEDED: t('超出直付单笔上限(按 WebAZ 记录的订单金额计;不涉及你与卖家场外实际付款金额)'),
    DIRECT_PAY_SELLER_NOT_ELIGIBLE: t('该卖家暂不支持直付'),
    DIRECT_PAY_SELLER_SUSPENDED: t('该卖家直付已被暂停'),
    DISCLOSURE_NOT_ACKED: t('需先完成两次风险披露确认(D1 + D2)'),
    HUMAN_PRESENCE_REQUIRED: t('需现场真人 Passkey 确认'),
    PASSKEY_REQUIRED_FOR_DIRECT_PAY: t('直付需要先注册 Passkey'),
    NO_PAYMENT_INSTRUCTION: t('卖家尚未设置收款说明,暂不可直付'),
    DIRECT_PAY_NOT_AVAILABLE: t('该卖家暂不支持直付'),
    DIRECT_PAY_KYC_REQUIRED: t('该卖家暂不支持直付'),  // 对买家脱敏:不暴露卖家 KYC/制裁具体状态
    ORDER_NOT_DELIVERED: t('订单尚未送达,暂不可确认收货'),
    DIRECT_PAY_SIMPLE_PRODUCT_ONLY: t('直付当前仅支持简单商品(无规格)'),
    DIRECT_PAY_UNSUPPORTED_OPTION: t('直付当前不支持该下单选项'),
  }
  return M[code] || (window.orderErrorLookup && window.orderErrorLookup(code)) || fallback || t('操作失败,请重试')  // 回退查订单错误码表(NOT_ORDER_BUYER 等披露/动作码)
}

// ── 买家结算:支付方式(rail)选择。escrow 默认;direct_p2p 可选,选中先查可用性(见 dpOnRailChange);D1/D2 ack 在建单后用 Passkey 完成。
window.dpRailSelectorHtml = (productId, priceUsdc) => `
  <details style="margin-top:10px" id="dp-rail-block" data-product="${productId || ''}" data-amt="${priceUsdc != null && isFinite(Number(priceUsdc)) ? Number(priceUsdc) : ''}">
    <summary style="font-size:13px;font-weight:600;color:#374151;cursor:pointer">${t('支付方式')}</summary>
    <div style="padding:8px 2px 2px">
      <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;margin-bottom:6px;cursor:pointer">
        <input type="radio" name="dp-rail" value="escrow" ${window._wazSimulated ? '' : 'checked'} onchange="dpOnRailChange('${productId || ''}')">
        <span><b>${window._wazSimulated ? t('托管(Escrow,模拟测试币)') : t('托管(Escrow,默认)')}</b><br><span style="font-size:11px;color:#6b7280">${t('本金由协议托管,确认收货后释放给卖家')}</span></span>
      </label>
      <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;cursor:pointer">
        <input type="radio" name="dp-rail" value="direct_p2p" onchange="dpOnRailChange('${productId || ''}')">
        <span><b>${t('直付(Direct Pay · 非托管)')}</b><br><span style="font-size:11px;color:#6b7280">${t('你直接付款给卖家(场外),本金不经 WebAZ')}</span></span>
      </label>
      <div id="dp-rail-note" style="display:none;margin-top:8px;font-size:11px;line-height:1.6;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px">
        ⚠️ ${t('直付风险提醒:非担保交易 —— WebAZ 不托管本金、无退款能力、不代维权,也不验证卖家的付款方式或币种,仅对卖家有信誉处罚权。下单后需用 Passkey 完成两次风险确认,再标记付款。')}
        <div style="margin-top:6px">${t('需要 Passkey。')}<a href="#me" style="color:#854d0e;font-weight:600;text-decoration:underline">${t('前往「我的 → 安全与存储」注册 →')}</a></div>
      </div>
      <div id="dp-rail-unavailable" style="display:none;margin-top:8px;font-size:11px;line-height:1.6;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 10px"></div><div id="dp-account-picker"></div>
    </div>
  </details>`

// 选直付先查 /direct-pay/availability(与建单门同源):available=true 才展示风险提醒+允许继续;否则用 dpErrorText 显示明确不可用原因(非系统错误/不裸露 JSON)并退回托管轨,阻止进入直付建单。
window.dpOnRailChange = async (productId) => {
  const note = document.getElementById('dp-rail-note'); window._dpDirectAvailable = false  // 进入即 pending:确认前 dpSelectedRail 只输出 escrow(防"选直付后立刻点确认"竞态)
  const un = document.getElementById('dp-rail-unavailable')
  if (note) note.style.display = 'none'
  if (un) un.style.display = 'none'; { const _pk = document.getElementById('dp-account-picker'); if (_pk) _pk.innerHTML = '' }  // D3:切轨/不可用即清空账号选择器
  const _sel = document.querySelector('input[name="dp-rail"]:checked')?.value; if (window.wazEscrowRailNote) window.wazEscrowRailNote(_sel); if (_sel !== 'direct_p2p') return  // [PRELAUNCH-WAZ-SIM] 选 escrow→测试币提醒
  let av = null
  try { av = await GET('/direct-pay/availability?product_id=' + encodeURIComponent(productId || '')) } catch { av = null }
  if (av && av.available === true) { window._dpDirectAvailable = true; if (note && !(state.user && state.user.has_passkey === true)) note.style.display = ''; if (window.dpLoadBuyerAccounts) window.dpLoadBuyerAccounts(productId); return }  // ① 仅无Passkey显软提醒(非D1/D2契约门,后端硬强制,不削弱披露不变量);D3 可用时加载账号
  if (un) { un.textContent = '⚠️ ' + window.dpErrorText(av && av.error_code, av && av.reason) ; un.style.display = '' }  // 不可用:明确原因 + 退回 escrow
  const esc = document.querySelector('input[name="dp-rail"][value="escrow"]')
  if (esc) { esc.checked = true; if (window.wazEscrowRailNote) window.wazEscrowRailNote('escrow') }  // [PRELAUNCH-WAZ-SIM] 直付不可用退回 escrow 时也提醒测试币
}

// 只有 availability 已确认 available:true(window._dpDirectAvailable)才输出 direct_p2p;pending/unavailable → escrow(竞态下确认只会下 escrow 单,绝不发 direct_p2p create)。
window.dpSelectedRail = () => { const c = document.querySelector('input[name="dp-rail"]:checked')?.value; if (c === 'direct_p2p') return window._dpDirectAvailable === true ? 'direct_p2p' : ''; return c === 'escrow' ? 'escrow' : (window._wazSimulated ? '' : 'escrow') }  // #28 直付选中但未确认→''(永不静默回退 escrow,不分模拟);[PRELAUNCH-WAZ-SIM] 模拟期未选→''

// ── 建单成功后(direct_p2p):D1/D2 披露 ack(各一次 Passkey)→ ack 后才展示快照收款说明 → 跳订单页。res=POST /orders 返回;有错则双语提示并停。
window.dpAfterCreate = async (res) => {
  if (!res || res.error || res.error_code) {
    const m = window.dpErrorText(res?.error_code, res?.error)
    if (typeof toast$ === 'function') toast$(m, 'error'); else alert(m)
    return
  }
  const orderId = res.order_id
  // 手动接单(pending_accept):接单前买家零收款信息、不能付款 —— 不弹付款/不做 ack,只提示等待落订单页(接单→direct_pay_window 后才 D1/D2+付款)。
  if (res.status === 'pending_accept') { if (typeof toast$ === 'function') toast$(t('订单已提交,等待卖家接单'), 'info'); return void setTimeout(() => navigate(`#order/${orderId}`), 400) }
  // 边界:必须【先】完成 D1/D2 + Passkey,之后【才】展示卖家收款说明(快照)。未完成则不展示,留到订单页继续。
  const acked = await window.dpEnsureAcks(orderId)
  if (!acked) { if (typeof toast$ === 'function') toast$(t('需完成 D1/D2 Passkey 风险确认后才显示收款说明 · 可在订单页继续'), 'info')
    return void setTimeout(() => navigate(`#order/${orderId}`), 600)
  }
  // 两次披露已 ack —— 收款说明【不】来自 create 响应(后端在 both-acked 前不下发);现在才 GET 订单读取 redaction-gated 快照。
  //   【先落订单页,融合付款弹窗叠在其上】:订单页本身有收款信息+对账卡+自动隐藏倒计时,所以无论用户点按钮、点遮罩还是
  //   按 ESC 关掉弹窗,都留在订单页而非产品页 —— 杜绝"关弹窗后失联→重复下单"(审计:弹窗被 overlay/ESC 关会 strand)。
  const o = await GET(`/orders/${orderId}`)
  navigate(`#order/${orderId}`)
  if (o && o.order && window.dpShowPaymentModal) setTimeout(() => window.dpShowPaymentModal(o.order), 120)   // 等订单页渲染后叠弹窗
}
// ── 确保两次披露都已 ack。两屏文本各自展示确认(证据不减);缺两个 → 一次 Passkey ceremony 覆盖(stage:'both',首单
//    3→2,2026-07-04 决策),缺一个 → 单独 ceremony。会话缓存 _dpAcked:both 过的单热路径(mark_paid/confirm)不再重复 2 GET;
//    后端 requireBothDisclosuresAcked 仍硬门。懒取金额:仅 D2 将展示才 GET 订单。──
window.dpEnsureAcks = async (orderId) => {
  if (window._dpAcked && window._dpAcked[orderId]) return true
  const st = await GET(`/direct-pay/disclosure-acks/${orderId}`)
  if (st.error) { if (typeof toast$ === 'function') toast$(window.dpErrorText(st.error_code, st.error), 'error'); return false }
  const cache = () => { (window._dpAcked = window._dpAcked || {})[orderId] = true; return true }
  if (st.both === true) return cache()
  const disc = st.disclosures || {}
  const missing = ['pre_select', 'pre_confirm'].filter(k => !(st.acked && st.acked[k]))
  let _pay = ''
  if (missing.includes('pre_confirm')) { try { const _od = await GET(`/orders/${orderId}`); if (_od && _od.order) _pay = window.dpPayAmountText(_od.order) } catch {} }
  for (let i = 0; i < missing.length; i++) {
    const key = missing[i], tx = key === 'pre_select' ? disc.pre_select : disc.pre_confirm
    const body = (tx ? (window._lang === 'en' ? tx.en : tx.zh) : t('风险披露')) + (key === 'pre_confirm' && _pay ? `\n\n💸 ${_pay}` : '')
    const go = await confirmModal(`${body}\n\n${t('我已阅读并理解上述风险')}`, i === missing.length - 1 ? t('了解直接付款(需 Passkey)') : t('下一步'), { danger: true })
    if (!go) return false
  }
  const ok = await window.dpDoAck(orderId, missing.length === 2 ? 'both' : missing[0])
  return ok ? cache() : false
}
// Passkey 门失败:仅【确实未注册】(后端 NO_PASSKEY_REGISTERED,由 requestPasskeyGate 透传到 err.code)才引导注册;
//   已注册但取消/设备不支持/超时(含 navigator DOMException,其 .code 是 legacy 数字非本值)→ 仅本地化"请重试",
//   不导注册(修用户反馈:已注册者被重复提醒)、不把英文 DOMException 文案 toast 给中文用户(bilingual)。全部 5 调用点传 err 对象。
window.dpPromptRegisterPasskey = async (err) => {
  if (!(err && typeof err === 'object' && err.code === 'NO_PASSKEY_REGISTERED')) { if (typeof toast$ === 'function') toast$(t('验证未完成,请重试'), 'info'); return }
  if (await confirmModal(t('直付的风险确认与付款标记需要 Passkey。你还没有注册 Passkey,前往「我的 → 安全与存储」注册一个?'), t('前往注册 Passkey'), {})) navigate('#me')
}
// 单次披露 ack:Passkey ceremony(purpose=direct_pay_disclosure_ack,order+stage 绑 purpose_data)→ POST ack。
window.dpDoAck = async (orderId, stage) => {
  let token
  try { token = await requestPasskeyGate('direct_pay_disclosure_ack', { order_id: orderId, stage }) }
  catch (e) { await window.dpPromptRegisterPasskey(e); return false }
  const r = await POST('/direct-pay/disclosure-acks', { order_id: orderId, stage, webauthn_token: token })
  if (r.error) { if (typeof toast$ === 'function') toast$(window.dpErrorText(r.error_code, r.error), 'error'); return false }
  return true
}
// ── 订单详情:direct_p2p 诚实边界始终显示;卖家收款说明快照【不】内联进 HTML,由 dpHydrateOrderDisclosure 在 both-acked 后才另取渲染(未 ack 时 DOM 里也没有快照)。
window.dpOrderDisclosureHtml = (order) => `
  <div class="card" style="border:1px solid #fde68a;background:linear-gradient(135deg,#fffbeb,#fef3c7)">
    <div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:8px">💸 ${t('直付订单(非托管)')}</div>
    <ul style="margin:0 0 8px;padding-left:18px;font-size:12px;line-height:1.7;color:#374151">
      <li>${t('本金不经 WebAZ —— 你直接付款给卖家(场外)')}</li>
      <li>${t('非担保交易:WebAZ 不托管本金、无退款能力,仅对卖家有信誉处罚权')}</li>
      <li>${t('卖家收款说明来自卖家自填,WebAZ 不验证付款方式或币种')}</li>
    </ul>
    <div id="dp-order-instr" data-order-id="${escHtml(String(order && order.id || ''))}">${loading$()}</div>
  </div>`
// ack-gated 收款说明:both-acked → 另取订单快照并展示;否则只显示"先完成 D1/D2 Passkey"的门(快照不入 DOM)。
window.dpHydrateOrderDisclosure = async (orderId) => {
  if (!window.dpInstrBox(orderId)) return
  const st = await GET(`/direct-pay/disclosure-acks/${orderId}`)
  const box = window.dpInstrBox(orderId); if (!box) return   // async 回包后再确认当前页仍是该订单(切页后旧回包不得写 DOM)
  if (st.error) { box.innerHTML = `<div style="font-size:12px;color:#dc2626">${window.dpErrorText(st.error_code, st.error)}</div>`; return }
  if (!st.both) {
    box.innerHTML = `<div style="font-size:12px;color:#92400e;background:#fff;border:1px solid #fde68a;border-radius:8px;padding:8px 10px">
      ${t('需先完成 D1/D2 Passkey 风险确认,确认后才显示卖家收款说明。')}
      <div style="margin-top:6px"><button class="btn btn-outline btn-sm" onclick="dpCompleteAcksThenReveal('${orderId}')">${t('完成风险确认')}</button></div></div>`
    return
  }
  const o = await GET(`/orders/${orderId}`)
  if (window.dpRenderPaymentInfo) window.dpRenderPaymentInfo(box, o && o.order ? o.order : null, orderId)  // PR-2:按订单状态渲染收款信息可见性(待支付=5min 自动窗口 / 其它状态=默认隐藏,需 Passkey 二次验证+风险提示)
}
window.dpCompleteAcksThenReveal = async (orderId) => {
  const ok = await window.dpEnsureAcks(orderId)
  if (ok) window.dpHydrateOrderDisclosure(orderId)
}

// ── 订单动作(mark_paid/confirm/confirm_in_person):前端先确保披露 ack,再取一次性 Passkey token 带进 order-action 端点;后端(#93)仍强制两次披露+Passkey。
window.dpHandleAction = async (orderId, action) => {
  const msgEl = document.getElementById('action-msg')
  const show = (type, m) => { if (msgEl) msgEl.innerHTML = alert$(type, m); else if (typeof toast$ === 'function') toast$(m, type) }
  // mark_paid 前必须两次披露都 ack(confirm/confirm_in_person 通常已在 mark_paid 阶段 ack 过,这里兜底再查)。
  const acked = await window.dpEnsureAcks(orderId)
  if (!acked) { show('error', window.dpErrorText('DISCLOSURE_NOT_ACKED')); return }
  let token
  try { token = await requestPasskeyGate('direct_pay_order_action', { order_id: orderId, action }) }
  catch (e) { await window.dpPromptRegisterPasskey(e); return }
  show('info', `<span class="spinner"></span>${t('处理中...')}`)
  const path = action === 'confirm_in_person' ? `/orders/${orderId}/confirm-in-person` : `/orders/${orderId}/action`
  const body = action === 'confirm_in_person' ? { webauthn_token: token } : { action, webauthn_token: token, ...(action === 'mark_paid' && window.dpReadMemo ? { notes: window.dpReadMemo(orderId) } : {}) }
  const r = await POST(path, body)
  if (r.error) { show('error', window.dpErrorText(r.error_code, r.error)); return }
  show('success', t('操作成功'))
  setTimeout(() => renderOrderDetail(document.getElementById('app'), orderId), 1000)
}

// ── 卖家:收款说明设置(GET / PUT / DELETE,仅展示文本)─────────────────────────────────────────
window.dpSellerInstructionSection = () => `
  <div class="card" style="margin-bottom:12px">
    <div style="font-size:14px;font-weight:700;margin-bottom:6px">💳 ${t('直付收款说明')}</div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('这是你自填的收款展示文本(场外结算用);WebAZ 不验证付款方式或币种,不路由支付,不托管资金。')}</div>
    <div id="dp-instr-box">${loading$()}</div>
  </div>`

window.dpHydrateInstruction = async () => {
  const box = document.getElementById('dp-instr-box')
  if (!box) return
  const r = await GET('/direct-receive/payment-instruction')
  if (r.error) { box.innerHTML = alert$('error', window.dpErrorText(r.error_code, r.error)); return }
  const cur = r.instruction
  box.innerHTML = `
    ${cur ? `<div style="font-size:12px;color:#374151;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;margin-bottom:10px">
      <div style="font-size:11px;color:#9ca3af;margin-bottom:2px">${t('当前生效')}${cur.label ? ` · ${escHtml(cur.label)}` : ''}</div>${escHtml(cur.instruction)}</div>` :
      `<div style="font-size:12px;color:#9ca3af;margin-bottom:10px">${t('尚未设置收款说明')}</div>`}
    <div id="dp-instr-msg"></div>
    <div class="form-group"><label class="form-label">${t('收款说明')} <span style="font-size:11px;color:#9ca3af">${t('(展示给买家,如 PayNow / 银行转账 等)')}</span></label>
      <textarea class="form-control" id="dp-instr-text" rows="3" maxlength="500" placeholder="${t('例:PayNow +65 9xxx(场外结算)')}">${cur ? escHtml(cur.instruction) : ''}</textarea></div>
    <div class="form-group"><label class="form-label">${t('标签(可选)')}</label>
      <input class="form-control" id="dp-instr-label" maxlength="40" value="${cur && cur.label ? escHtml(cur.label) : ''}" placeholder="${t('如 PayNow')}"></div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary btn-sm" onclick="dpSaveInstruction()">${t('保存')}</button>
      ${cur ? `<button class="btn btn-outline btn-sm" style="color:#dc2626;border-color:#dc2626" onclick="dpDeleteInstruction()">${t('停用')}</button>` : ''}
    </div>`
}

window.dpSaveInstruction = async () => {
  const msg = document.getElementById('dp-instr-msg')
  const instruction = document.getElementById('dp-instr-text')?.value?.trim() || ''
  const label = document.getElementById('dp-instr-label')?.value?.trim() || ''
  if (!instruction) { if (msg) msg.innerHTML = alert$('error', t('收款说明不能为空')); return }
  if (msg) msg.innerHTML = `<div class="alert alert-info"><span class="spinner"></span>${t('保存中...')}</div>`
  const r = await PUT('/direct-receive/payment-instruction', { instruction, label })
  if (r.error) { if (msg) msg.innerHTML = alert$('error', window.dpErrorText(r.error_code, r.error)); return }
  if (typeof toast$ === 'function') toast$(t('已保存'), 'success')
  window.dpHydrateInstruction()
}

window.dpDeleteInstruction = async () => {
  const go = await confirmModal(t('停用后买家将无法对你发起直付订单,确定停用?'), t('停用'), { danger: true })
  if (!go) return
  const r = await api('DELETE', '/direct-receive/payment-instruction')
  if (r.error) { if (typeof toast$ === 'function') toast$(window.dpErrorText(r.error_code, r.error), 'error'); return }
  if (typeof toast$ === 'function') toast$(t('已停用'), 'success')
  window.dpHydrateInstruction()
}
