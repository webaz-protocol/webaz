// 订单详情轻量轮询:停留在 #order/:id 时,后台状态/历史变化后自动刷新当前订单页。
// 只读 GET /orders/:id;隐藏标签页暂停;离开订单页自清理。刷新整页是刻意选择:订单 action 区高度依赖状态。
window.startOrderDetailPoll = (id, order, history) => {
  if (window._orderPollTimer) { clearInterval(window._orderPollTimer); window._orderPollTimer = null }
  const sigOf = (o, h) => [o?.status, o?.updated_at, o?.activeDeadline?.deadline, o?.decline_contested, o?.decline_objective_pending, (h || []).length, (h || []).at?.(-1)?.id || (h || []).at?.(-1)?.created_at || ''].join('|')
  let sig = sigOf(order, history)
  const stop = () => { if (window._orderPollTimer) { clearInterval(window._orderPollTimer); window._orderPollTimer = null; window._orderPollNow = null } }
  const tickFn = async () => {
    if (!location.hash.includes('order/' + id)) return stop()
    if (document.hidden || document.querySelector('.js-modal')) return
    let rr = null; try { rr = await GET('/orders/' + encodeURIComponent(id)) } catch { return }
    if (!rr || rr.error) return
    const next = sigOf({ ...rr.order, activeDeadline: rr.activeDeadline }, rr.history || [])
    if (next === sig) return
    sig = next
    renderOrderDetail(document.getElementById('app'), id)
  }
  window._orderPollTimer = setInterval(tickFn, 5000); window._orderPollNow = tickFn
}
