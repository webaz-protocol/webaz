// [PRELAUNCH-WAZ-SIM] 预发布期 escrow 模拟币提醒。预发布期 escrow 用模拟 WAZ(非真钱),
//   为防买家把测试币当真实价值,做三件事 —— 全部门控在 window._wazSimulated:
//     1) 支付方式不再默认预选 escrow(app-direct-pay.js: dpRailSelectorHtml 的 checked + dpSelectedRail 兜底)
//     2) 买家切到 escrow 时内联提醒(wazEscrowRailNote 注入 #dp-rail-block,app-direct-pay.js 无需扩容)
//     3) 生成的 escrow 订单在买家端订单详情顶部强提醒(wazEscrowOrderBanner,app.js renderOrderDetail 调用)
//   真实结算上线时:把下面 _wazSimulated 置 false(一处)→ 全部 no-op、escrow 预选行为恢复。
//   彻底移除:grep '[PRELAUNCH-WAZ-SIM]' / '_wazSimulated'(本文件 + app.js + app-direct-pay.js + index.html
//     + package.json check:pwa-syntax + .github/workflows/ci.yml + complexity-ratchet-guard.ts + i18n.js)。
//   UI-only:不碰 wallet/escrow/settlement/订单钱路;纯展示 + 一个"必须显式选 rail"的前端门(后端不变)。
window._wazSimulated = true

// 内联提醒文案(单一真相,两处复用)。
const WAZ_SIM_NOTE = () => '⚠️ ' + t('测试模式:WAZ 为模拟货币,不代表真实价值。此为预发布演示,你"托管"的并非真实资金,确认收货后释放的也是测试币。')

// 买家在"支付方式"里选中 Escrow 时的内联提醒。selectedRail = 当前选中的 rail 值('escrow' / 'direct_p2p' / undefined)。
//   注入到 #dp-rail-block 内,避免扩容 app-direct-pay.js(其已到 LOC 上限)。非模拟期直接 no-op。
window.wazEscrowRailNote = (selectedRail) => {
  if (!window._wazSimulated) return
  const block = document.getElementById('dp-rail-block'); if (!block) return
  const host = block.querySelector('div') || block
  let el = document.getElementById('dp-rail-escrow-sim')
  if (selectedRail !== 'escrow') { if (el) el.style.display = 'none'; return }
  if (!el) {
    el = document.createElement('div'); el.id = 'dp-rail-escrow-sim'
    el.style.cssText = 'margin-top:8px;font-size:11px;line-height:1.6;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px'
    host.appendChild(el)
  }
  el.textContent = WAZ_SIM_NOTE()
  el.style.display = ''
}

// 生成 escrow 订单后,买家端订单详情顶部的强提醒横幅。非 escrow / 非买家 / 非模拟 → 空串(不渲染)。
window.wazEscrowOrderBanner = (order, isBuyer) => {
  if (!window._wazSimulated || !isBuyer || !order || order.payment_rail === 'direct_p2p') return ''
  return `<div style="border:1px solid #fde68a;background:linear-gradient(135deg,#fffbeb,#fef3c7);border-radius:12px;padding:12px 14px;margin-bottom:10px">
    <div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:4px">🧪 ${t('测试托管订单')}</div>
    <div style="font-size:12px;line-height:1.6;color:#374151">${t('本单为预发布演示:WAZ 是模拟货币,不代表真实价值,本协议尚未进行真实资金结算。请勿据此向任何人支付真实款项。')}</div>
  </div>`
}

// 模拟期要求买家形成【有效 rail】:按 dpSelectedRail() 是否为空判断,不能只看"radio 选中"——direct_p2p 选中但 availability 未确认(_dpDirectAvailable!==true)时 dpSelectedRail 返 '',radio 却是选中的,空 payment_rail 会被后端静默落成 escrow。
window.wazRequireRailChoice = () => !!window._wazSimulated && !(window.dpSelectedRail && window.dpSelectedRail())
