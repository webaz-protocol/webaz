// Direct Pay (Rail 1) — 收款信息可见性生命周期 (PR-2)。UI ONLY。
//   模型:待支付(direct_pay_window)→ 自动展示卖家收款说明+QR 一个【5 分钟窗口】,超时自动隐藏,可【轻量】重新显示(重置窗口);
//   其它所有状态(已付/完成/取消/过期/争议/退款…)→ 默认隐藏,需【二次验证:现场 Passkey + 风险提示】才临时展示(同样 5 分钟窗口)。
//   金额(应付)非敏感,任何状态都常显。
//   诚实边界:这是【客户端展示/同意】控制 —— 防误付空单 + 不长留敏感收款信息在屏 + 现场在场二次同意;
//   【并非】新的服务器机密边界(收款目标对 both-acked 的订单买家经订单 API 仍可得,后端授权门仍是 both-acked 归属)。
window._dpRevealTimers = window._dpRevealTimers || {}
window.DP_REVEAL_MS = 5 * 60 * 1000

// 终态/无效单(不应再付款)——重看时给强风险提示。
window.dpIsVoidOrder = (status) => ['cancelled', 'expired', 'direct_expired_unconfirmed', 'disputed', 'dispute_dismissed', 'refunded_full', 'refunded_partial', 'fault_seller', 'fault_buyer', 'fault_logistics'].includes(status)

window.dpClearRevealTimer = (orderId) => { const tmr = window._dpRevealTimers[orderId]; if (tmr) { clearTimeout(tmr.to); clearInterval(tmr.iv); delete window._dpRevealTimers[orderId] } }

// 收款说明+QR 展示块(含倒计时);到点 → 隐藏。lightweight=true:重新显示无需 Passkey(待支付轨)。
window.dpShowPaymentInfo = (order, orderId, lightweight) => {
  const box = document.getElementById('dp-order-instr'); if (!box) return
  window.dpClearRevealTimer(orderId)
  const snap = order && order.direct_pay_instruction_snapshot ? order.direct_pay_instruction_snapshot : ''
  const pay = window.dpPayAmountText ? window.dpPayAmountText(order) : ''
  if (!snap) { box.innerHTML = `<div style="font-size:12px;color:#9ca3af">${t('卖家尚未设置收款说明,暂不可直付')}</div>`; return }
  box.innerHTML = `<div style="font-size:12px;color:#374151;background:#fff;border:1px solid #fde68a;border-radius:8px;padding:8px 10px">
    ${pay ? `<div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:4px">💸 ${escHtml(pay)}</div>` : ''}
    <div style="font-size:11px;color:#9ca3af;margin-bottom:2px">${t('卖家收款说明(下单时快照)')}</div>${escHtml(snap)}<div id="dp-order-qr"></div>
    <div style="font-size:10px;color:#9ca3af;margin-top:6px">${t('自动隐藏倒计时')}: <span id="dp-reveal-countdown">5:00</span></div></div>`
  if (window.dpLoadOrderQr) window.dpLoadOrderQr(orderId)
  const end = Date.now() + window.DP_REVEAL_MS
  const tick = () => { const el = document.getElementById('dp-reveal-countdown'); if (!el) return; const s = Math.max(0, Math.round((end - Date.now()) / 1000)); el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
  tick()
  window._dpRevealTimers[orderId] = { iv: setInterval(tick, 1000), to: setTimeout(() => window.dpHidePaymentInfo(order, orderId, lightweight), window.DP_REVEAL_MS) }
}

// 隐藏收款信息 → 显示重看入口。lightweight:待支付轨点一下即可;否则需 Passkey+风险提示。
window.dpHidePaymentInfo = (order, orderId, lightweight) => {
  const box = document.getElementById('dp-order-instr'); if (!box) return
  window.dpClearRevealTimer(orderId)
  const pay = window.dpPayAmountText ? window.dpPayAmountText(order) : ''
  const hint = lightweight ? t('为保护你的收款信息,已隐藏。') : t('订单已不在待支付阶段,收款信息默认隐藏。')
  const btn = lightweight
    ? `<button class="btn btn-outline btn-sm" onclick="dpReShowPaymentInfo('${orderId}')">${t('重新显示')}</button>`
    : `<button class="btn btn-outline btn-sm" onclick="dpGatedRevealPaymentInfo('${orderId}')">${t('查看收款信息(需 Passkey 验证)')}</button>`
  box.innerHTML = `<div style="font-size:12px;color:#374151;background:#fff;border:1px solid #fde68a;border-radius:8px;padding:8px 10px">
    ${pay ? `<div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:4px">💸 ${escHtml(pay)}</div>` : ''}
    <div style="font-size:11px;color:#9ca3af;margin-bottom:6px">${escHtml(hint)}</div>${btn}</div>`
}

// 待支付轨:轻量重新显示(无 Passkey,重置窗口)。
window.dpReShowPaymentInfo = async (orderId) => {
  const o = await GET(`/orders/${orderId}`); const ord = o && o.order ? o.order : null
  if (ord) window.dpShowPaymentInfo(ord, orderId, true)
}

// 非待支付:二次验证(风险提示 + 现场 Passkey)后临时展示一个 5 分钟窗口。
window.dpGatedRevealPaymentInfo = async (orderId) => {
  const o = await GET(`/orders/${orderId}`); const ord = o && o.order ? o.order : null
  if (!ord) return
  const warn = window.dpIsVoidOrder(ord.status)
    ? t('⚠️ 此订单已取消/终止,请【勿再付款】。收款信息仅供对账/存证查看。')
    : t('⚠️ 你已完成付款。收款信息仅供对账/维权查看,请勿重复付款。')
  const go = await confirmModal(`${warn}\n\n${t('继续查看需现场 Passkey 验证。')}`, t('继续(需 Passkey)'), { danger: true })
  if (!go) return
  try { await requestPasskeyGate('direct_pay_payment_info_reveal', { order_id: orderId }) }
  catch (e) { if (window.dpPromptRegisterPasskey) await window.dpPromptRegisterPasskey(e && e.message); return }
  window.dpShowPaymentInfo(ord, orderId, false)
}

// 订单详情:按状态渲染收款信息可见性。待支付→自动窗口;其它→默认隐藏(需二次验证)。both-acked 由调用方(dpHydrateOrderDisclosure)先保证。
window.dpRenderPaymentInfo = (box, order, orderId) => {
  if (!box || !order) return
  if (order.payment_rail === 'direct_p2p' && order.status === 'direct_pay_window') window.dpShowPaymentInfo(order, orderId, true)
  else window.dpHidePaymentInfo(order, orderId, false)
}
