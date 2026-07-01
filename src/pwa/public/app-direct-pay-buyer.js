// Direct Pay (Rail 1) — 买家侧收款账号选择 + 分账号 FX + ack 门后收款码展示 (Phase D3)。UI ONLY。
//   接 D1(GET /api/direct-receive/selectable-accounts 只读元数据)+ D2(建单带 direct_receive_account_id、
//   GET /api/orders/:id/direct-pay-qr ack 门后取图)。选账号在【下单前】(与建单契约一致);收款目标(instruction 原文 +
//   QR 图)仍只在 D1/D2 both-acked 后经订单快照 / QR 端点展示。WebAZ 不验证/路由/托管,FX 纯展示。双语 parity 由 test-direct-pay-ui.ts 守。

// USDC 金额 → 任意币种展示串(用于"卖家按 <币种> 收款 ≈ X");无 rate/币种不支持 → 仅币种码。
window.dpFxInCurrency = (usdc, currency) => {
  const cur = String(currency || '').toUpperCase()
  const r = window._fxRates
  const n = Number(usdc)
  const sym = { CNY: '¥', EUR: '€', INR: '₹', SGD: 'S$', USD: '$', IDR: 'Rp', MYR: 'RM', PHP: '₱', VND: '₫', THB: '฿' }
  if (!cur) return ''
  if (cur === 'USDC' || cur === 'USD') return Number.isFinite(n) ? `${sym.USD}${n >= 100 ? Math.round(n) : n.toFixed(2)}` : ''
  const rate = r && r.rates ? Number(r.rates[cur]) : NaN
  if (!(rate > 0) || !Number.isFinite(n)) return cur   // 币种不在 FX 表:只显示币种码,不臆造换算
  const local = n * rate
  return `${sym[cur] || (cur + ' ')}${local >= 100 ? Math.round(local) : local.toFixed(2)}`
}

// 选直付且可用时加载卖家可选收款账号(元数据 only)。0 个 → 清空(legacy 单条说明,无需选);≥1 → 单选列表(默认首个)。
window.dpLoadBuyerAccounts = async (productId) => {
  const box = document.getElementById('dp-account-picker')
  if (!box) return
  let r
  try { r = await GET('/direct-receive/selectable-accounts?product_id=' + encodeURIComponent(productId || '')) } catch { r = null }
  const opts = (r && r.options) || []
  if (!opts.length) { box.innerHTML = ''; return }   // legacy-only 卖家:无多账号,走单条说明,不显示选择器
  box.innerHTML = `
    <div style="font-size:12px;font-weight:600;color:#374151;margin:8px 0 4px">${t('选择卖家收款方式')}</div>
    ${opts.map((o, i) => {
      const title = o.label ? escHtml(o.label) : (o.method ? escHtml(o.method) : t('收款账号'))
      const sub = [o.method ? escHtml(o.method) : '', o.currency ? escHtml(o.currency) : ''].filter(Boolean).join(' · ')
      return `<label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;padding:6px 2px;cursor:pointer">
        <input type="radio" name="dp-account" value="${escHtml(o.account_id)}" ${i === 0 ? 'checked' : ''}>
        <span><b>${title}</b>${sub ? ` <span style="color:#6b7280;font-size:11px">${sub}</span>` : ''}<span data-dp-fx-cur="${o.currency ? escHtml(o.currency) : ''}" style="display:block;color:#6b7280;font-size:11px"></span></span>
      </label>`
    }).join('')}
    <div style="font-size:11px;color:#9ca3af;margin-top:2px">${t('收款明细与二维码将在完成风险确认后显示')}</div>`
  window.dpRenderAccountFx()   // 按【当前订单总额 = 单价 × 数量】渲染分账号 FX(数量后续变化由 qtyStep/qtyClamp 再刷新)
}

// 当前直付订单总额(USDC)= 单价(data-amt)×【当前数量】(#inp-qty);直付买家场外付这个数,绝不能只按单价显示。
window.dpAccountTotalUsdc = () => {
  const unit = Number(document.getElementById('dp-rail-block')?.getAttribute('data-amt') || '')
  const q = document.getElementById('inp-qty')
  const qty = q ? Math.max(1, Math.floor(Number(q.value) || 1)) : 1
  return Number.isFinite(unit) ? unit * qty : NaN
}
// 用【当前订单总额】渲染/刷新分账号 FX 金额(数量改变后由 qtyStep/qtyClamp 调用)。无该币种汇率 → dpFxInCurrency 回落币种码。
window.dpRenderAccountFx = () => {
  const total = window.dpAccountTotalUsdc()
  document.querySelectorAll('#dp-account-picker [data-dp-fx-cur]').forEach((el) => {
    const cur = el.getAttribute('data-dp-fx-cur')
    const fx = (cur && Number.isFinite(total)) ? window.dpFxInCurrency(total, cur) : ''
    el.innerHTML = fx ? `${t('卖家按此收款')} ≈ ${fx}` : ''
  })
}

// 当前选中的收款账号 id(供建单带上);无选择器(legacy)/未选 → '' → 建单省略该字段,后端回落单条说明。
window.dpSelectedAccountId = () => document.querySelector('input[name="dp-account"]:checked')?.value || ''

// ack 门后:取订单收款二维码(owner+both-acked 才 200;Authorization header 走 fetch→blob,<img src> 带不了头)。
window.dpLoadOrderQr = async (orderId) => {
  const box = document.getElementById('dp-order-qr')
  if (!box) return
  try {
    const resp = await fetch('/api/orders/' + encodeURIComponent(orderId) + '/direct-pay-qr', { headers: { Authorization: 'Bearer ' + (window.state && window.state.apiKey) } })
    if (!resp.ok) { box.innerHTML = ''; return }   // 无 QR / 未 ack:静默不显(instruction 文本已单独展示)
    const url = URL.createObjectURL(await resp.blob())
    box.innerHTML = `<div style="font-size:11px;color:#9ca3af;margin:6px 0 2px">${t('收款二维码')}</div><img src="${url}" alt="${t('收款二维码')}" style="width:150px;height:150px;object-fit:contain;border:1px solid #e5e7eb;border-radius:8px">`
  } catch { box.innerHTML = '' }
}
