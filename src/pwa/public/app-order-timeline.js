// 订单时间线渲染域(2026-07 从 app.js 抽出,复杂度 ratchet):
//   orderStageTimeline  — 顶部横向 stepper;异常/处置型 completed 走 banner(绝不画满格成功)
//   orderTrackingTimeline — 竖直物流追踪;direct_p2p 轨节点按真实事件序映射
// 依赖全局:t / escHtml / fmtTime / fmtCountdown / trackingEvidenceLine / window.dp*Label(app-order-labels.js)。
// classic script:顶层 function 声明即全局,app.js 渲染时直接调用。
function orderStageTimeline(order, history) {
  const STAGES = [
    { key: 'created',    label: t('下单'),  icon: '📝' },
    { key: 'paid',       label: t('付款'),  icon: '💳' },
    { key: 'accepted',   label: t('接单'),  icon: '✋' },
    { key: 'shipped',    label: t('发货'),  icon: '📦' },
    { key: 'delivered',  label: t('送达'),  icon: '🚚' },
    { key: 'completed',  label: t('完成'),  icon: '✓' },
  ]
  // 异常状态：单独 banner，不画时间线（防误导）
  const ANOMALY = ['disputed', 'payment_query', 'cancelled', 'fault_seller', 'fault_buyer', 'fault_logistics', 'refunded_partial', 'refunded_full', 'dispute_dismissed', 'expired', 'delivery_failed', 'return_pending', 'declined_nofault', 'resolved_for_seller']
  // completed 被重载:判责/无责拒单/退货默认退款等处置也终于 completed。用 completed 事件的 from_status
  // 还原真实终局(只有 confirmed→completed 是成功交易),处置型 completed 一律走异常 banner,绝不画满格成功。
  const completedRow = (history || []).find(h => h.to_status === 'completed')
  const disposalFrom = (order.status === 'completed' && completedRow && completedRow.from_status !== 'confirmed') ? completedRow.from_status : null
  if (ANOMALY.includes(order.status) || disposalFrom) {
    const bannerStatus = disposalFrom || order.status
    const colorMap = {
      disputed: '#f59e0b', payment_query: '#f59e0b', cancelled: '#6b7280',
      fault_seller: '#dc2626', fault_buyer: '#dc2626', fault_logistics: '#dc2626',
      refunded_full: '#16a34a', refunded_partial: '#3b82f6', dispute_dismissed: '#6b7280', expired: '#9ca3af',
      delivery_failed: '#f59e0b', return_pending: '#f59e0b', declined_nofault: '#6b7280', resolved_for_seller: '#16a34a',
    }
    const labelMap = {
      disputed: t('订单进入争议'), cancelled: t('订单已取消'),
      fault_seller: t('卖家违约'), fault_buyer: t('买家违约'), fault_logistics: t('物流违约'),
      refunded_full: t('已全额退款'), refunded_partial: t('部分退款'),
      dispute_dismissed: t('争议已驳回'), expired: t('订单已超时'),
      delivery_failed: t('未派送成功待处理'), return_pending: t('等待退货确认'),
      declined_nofault: t('卖家无责拒单'), resolved_for_seller: t('卖家胜诉'),
    }
    // 处置来源专用标签:banner 描述的是「经由该状态收口」的终局,不是当前活跃状态 ——
    // disputed→completed 是仲裁结案(不是"进入争议"),return_pending→completed 是退货已结算(不是"等待确认")。
    const disposalLabelMap = { disputed: t('仲裁结案'), return_pending: t('退货流程已结算') }
    const c = colorMap[bannerStatus] || '#6b7280'
    const sub = disposalFrom ? t('系统已按协议处置并关闭订单') : t('查看下方时间线了解流转详情')
    return `<div style="background:#fff;border:0.5px solid #e5e7eb;border-radius:12px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:10px">
      <div style="width:8px;height:8px;border-radius:50%;background:${c};flex-shrink:0"></div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:600;color:#1f2937">${(disposalFrom && disposalLabelMap[disposalFrom]) || (order.payment_rail === 'direct_p2p' && ((window.dpTerminalLabel && window.dpTerminalLabel(bannerStatus)) || (window.dpNegotiationLabel && window.dpNegotiationLabel(bannerStatus)) || (window.dpAcceptLabel && window.dpAcceptLabel(bannerStatus)))) || labelMap[bannerStatus] || bannerStatus}${disposalFrom ? ` · ${t('已关单')}` : ''}</div>
        <div style="font-size:11px;color:#8e8e93;margin-top:2px">${sub}</div>
      </div>
    </div>`
  }
  // 正常流：用 history 找每个阶段的完成时间
  // shipped 涵盖 shipped/picked_up/in_transit；delivered 是 delivered；completed = confirmed/completed
  const histByStatus = {}
  for (const h of (history || [])) {
    if (!histByStatus[h.to_status]) histByStatus[h.to_status] = h.created_at
  }
  const completedAt = (stageKey) => {
    if (stageKey === 'created')   return order.created_at
    // direct_p2p 轨没有 paid 事件:买家标记付款落在 accepted 事件上;卖家接单落在 direct_pay_window 事件上
    if (stageKey === 'paid')      return order.payment_rail === 'direct_p2p' ? histByStatus['accepted'] : histByStatus['paid']
    if (stageKey === 'accepted')  return order.payment_rail === 'direct_p2p' ? (histByStatus['direct_pay_window'] || histByStatus['accepted']) : histByStatus['accepted']
    if (stageKey === 'shipped')   return histByStatus['shipped'] || histByStatus['picked_up'] || histByStatus['in_transit']
    if (stageKey === 'completed') return histByStatus['completed'] || histByStatus['confirmed']
    return histByStatus[stageKey]
  }
  // "当前" = 正在等待的下一阶段（不是已完成的最后阶段）
  // created → 等付款；paid → 等接单；accepted → 等发货；shipped/in_transit → 等送达；
  // delivered → 等买家确认；confirmed/completed → 全部完成
  const statusToIdx = { created: 1, direct_pay_window: 1, direct_expired_unconfirmed: 1, paid: 2, accepted: 3, shipped: 4, picked_up: 4, in_transit: 4, delivered: 5, confirmed: 6, completed: 6 }
  let currentIdx = statusToIdx[order.status] ?? 0

  const dot = (s, i) => {
    const done = i < currentIdx
    const active = i === currentIdx
    const future = i > currentIdx
    const bg = done ? '#16a34a' : active ? '#007aff' : '#e5e7eb'
    const fg = done || active ? '#fff' : '#9ca3af'
    const ts = completedAt(s.key)
    return `<div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:0;position:relative">
      <div style="width:28px;height:28px;border-radius:50%;background:${bg};color:${fg};display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;${active ? 'box-shadow:0 0 0 4px rgba(0,122,255,0.2);' : ''}z-index:1">${done ? '✓' : s.icon}</div>
      <div style="font-size:11px;color:${done || active ? '#1f2937' : '#9ca3af'};font-weight:${active ? '600' : '500'};margin-top:4px;text-align:center;white-space:nowrap">${s.label}</div>
      ${ts ? `<div style="font-size:9px;color:#9ca3af;margin-top:1px">${new Date(ts).toLocaleString(window._lang === 'en' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>` : ''}
    </div>`
  }
  const connector = (i) => {
    const c = i < currentIdx ? '#16a34a' : '#e5e7eb'
    return `<div style="flex:0 0 auto;height:2px;background:${c};align-self:flex-start;margin-top:14px;min-width:8px;flex:1;max-width:40px"></div>`
  }
  const cells = []
  STAGES.forEach((s, i) => {
    cells.push(dot(s, i))
    if (i < STAGES.length - 1) cells.push(connector(i))
  })
  return `<div style="background:#fff;border:0.5px solid #e5e7eb;border-radius:12px;padding:14px 12px;margin-bottom:10px;overflow-x:auto">
    <div style="display:flex;align-items:flex-start;min-width:fit-content">${cells.join('')}</div>
  </div>`
}

// 2026-05-22 物流追踪时间轴 — 竖直 timeline，含 history + 未来截止提示
// 与顶部紧凑 stepper 互补：stepper 给总览，timeline 给细节
function orderTrackingTimeline(order, history, trackingInfo, STATUS_ZH) {
  // 异常订单不显示物流时间线（争议/取消等）— 由顶部 stepper 异常 banner 兜底
  const ANOMALY = ['disputed', 'payment_query', 'cancelled', 'fault_seller', 'fault_buyer', 'fault_logistics', 'refunded_partial', 'refunded_full', 'dispute_dismissed', 'expired', 'delivery_failed', 'return_pending', 'declined_nofault', 'resolved_for_seller', 'direct_expired_unconfirmed']
  if (ANOMALY.includes(order.status)) return ''
  // completed 被重载:判责/退款处置也终于 completed。只有 confirmed→completed 才是"买家确认过"的成功交易;
  // 其他来源(fault_*/declined_nofault/return_pending/disputed 直达)一律按异常处理,交顶部 banner 说明,绝不画成功时间线。
  const completedRow = (history || []).find(h => h.to_status === 'completed')
  if (order.status === 'completed' && completedRow && completedRow.from_status !== 'confirmed') return ''

  // 已完成节点 lookup
  const histByStatus = {}
  const actorByStatus = {}
  for (const h of history) {
    if (!histByStatus[h.to_status]) {
      histByStatus[h.to_status] = h.created_at
      actorByStatus[h.to_status] = { name: h.actor_name, role: h.actor_role, notes: h.notes, evidence: h.evidence_items || [] }
    }
  }
  // 节点定义（buyer 视角友好）— direct_p2p 轨的真实事件序是 接单(direct_pay_window)→买家标记付款(accepted),
  // 沿用 escrow 节点会把「卖家接单」错标到买家标记付款的事件上(人/时间全错),所以按轨分表。
  const isDirectRail = order.payment_rail === 'direct_p2p'
  const NODES = isDirectRail ? [
    { key: 'direct_pay_window', icon: '✋', label: t('卖家接单'), deadline: order.pending_accept_deadline },
    { key: 'accepted',   icon: '💳', label: t('已付款'),     deadline: order.direct_pay_window_deadline },
    { key: 'shipped',    icon: '📦', label: t('卖家发货'),   deadline: order.ship_deadline },
    { key: 'picked_up',  icon: '🚛', label: t('物流揽收'),   deadline: order.pickup_deadline },
    { key: 'in_transit', icon: '🛣',  label: t('运输中'),     deadline: null },
    { key: 'delivered',  icon: '📬', label: t('已送达'),     deadline: order.delivery_deadline },
    { key: 'confirmed',  icon: '✓',  label: t('买家确认'),   deadline: order.confirm_deadline },
  ] : [
    { key: 'paid',       icon: '💳', label: t('已付款'),     deadline: null },
    { key: 'accepted',   icon: '✋', label: t('卖家接单'),   deadline: order.accept_deadline },
    { key: 'shipped',    icon: '📦', label: t('卖家发货'),   deadline: order.ship_deadline },
    { key: 'picked_up',  icon: '🚛', label: t('物流揽收'),   deadline: order.pickup_deadline },
    { key: 'in_transit', icon: '🛣',  label: t('运输中'),     deadline: null },   // 中间态，无独立 deadline
    { key: 'delivered',  icon: '📬', label: t('已送达'),     deadline: order.delivery_deadline },
    { key: 'confirmed',  icon: '✓',  label: t('买家确认'),   deadline: order.confirm_deadline },
  ]
  const statusToIdx = isDirectRail
    ? { created: -1, pending_accept: -1, direct_pay_window: 0, accepted: 1, shipped: 2, picked_up: 3, in_transit: 4, delivered: 5, confirmed: 6, completed: 6 }
    : { created: -1, paid: 0, accepted: 1, shipped: 2, picked_up: 3, in_transit: 4, delivered: 5, confirmed: 6, completed: 6 }
  const currentIdx = statusToIdx[order.status] ?? -1
  const now = Date.now()

  const rows = NODES.map((n, i) => {
    // 「买家确认」只认 confirmed 事件或 confirmed→completed 的正常收口;fault→completed 已在上方拦截
    const done = histByStatus[n.key] || (n.key === 'confirmed' && (histByStatus.confirmed || (completedRow && completedRow.from_status === 'confirmed' && completedRow.created_at)))
    const isCurrent = i === currentIdx + 1 && !done  // 下一个待办
    const isOverdue = !done && n.deadline && new Date(n.deadline).getTime() < now

    // dot 颜色
    let dotBg, dotFg, dotInner
    if (done) {
      dotBg = '#16a34a'; dotFg = '#fff'; dotInner = '✓'
    } else if (isOverdue) {
      dotBg = '#dc2626'; dotFg = '#fff'; dotInner = '!'
    } else if (isCurrent) {
      dotBg = '#007aff'; dotFg = '#fff'; dotInner = n.icon
    } else {
      dotBg = '#e5e7eb'; dotFg = '#9ca3af'; dotInner = n.icon
    }

    // 右侧文案
    let sub = ''
    if (done) {
      const actor = actorByStatus[n.key]
      sub = `<div style="font-size:11px;color:#6b7280;margin-top:2px">${fmtTime(done)}${actor?.name ? ' · ' + escHtml(actor.name) : ''}</div>`
      if (actor?.notes) sub += `<div style="font-size:11px;color:#6b7280;margin-top:2px">💬 ${escHtml(actor.notes)}</div>`
      // 物流证据（快递单号等）
      const ev = trackingInfo.find(ti => ti.status === n.key)
      if (ev && ev.evidence && ev.evidence.length > 0) {
        sub += (ev.evidence || []).map(e => {
          const label = (n.key === 'picked_up' && !e.startsWith('快递单号：')) ? `快递单号：${e}` : e
          return trackingEvidenceLine(label)
        }).join('')
      }
    } else if (isOverdue) {
      sub = `<div style="font-size:11px;color:#dc2626;font-weight:600;margin-top:2px">⚠ ${t('已超时')} · ${fmtTime(n.deadline)}</div>`
    } else if (isCurrent && n.deadline) {
      sub = `<div style="font-size:11px;color:#007aff;margin-top:2px">⏳ ${fmtCountdown(n.deadline)}</div>`
    } else if (isCurrent) {
      sub = `<div style="font-size:11px;color:#007aff;margin-top:2px">⏳ ${t('进行中')}</div>`
    } else if (n.deadline) {
      sub = `<div style="font-size:11px;color:#9ca3af;margin-top:2px">${t('预计')} ${fmtTime(n.deadline)}</div>`
    }

    // 连接线（除最后一个节点都有）
    const lineColor = done ? '#16a34a' : '#e5e7eb'
    const connector = i < NODES.length - 1
      ? `<div style="position:absolute;left:13px;top:28px;width:2px;height:calc(100% - 4px);background:${lineColor}"></div>`
      : ''

    return `<div style="position:relative;padding-left:38px;padding-bottom:14px">
      ${connector}
      <div style="position:absolute;left:0;top:0;width:28px;height:28px;border-radius:50%;background:${dotBg};color:${dotFg};display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;${isCurrent ? 'box-shadow:0 0 0 4px rgba(0,122,255,0.2)' : ''}">${dotInner}</div>
      <div style="font-size:13px;color:${done ? '#1f2937' : isOverdue ? '#dc2626' : isCurrent ? '#1f2937' : '#9ca3af'};font-weight:${isCurrent || done ? '600' : '500'}">${n.label}</div>
      ${sub}
    </div>`
  }).join('')

  return `<div class="card">
    <div class="action-title">🚚 ${t('物流追踪')}</div>
    <div style="padding:8px 4px 0">${rows}</div>
  </div>`
}
