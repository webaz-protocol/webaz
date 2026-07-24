// GMV 按支付轨拆分小注(卖家仪表盘共用)。UI ONLY。
//   托管(escrow)=WAZ 模拟托管收入;链上担保(usdc_escrow)=真实 USDC 存入 Base 链合约、平台不经手本金;直接收款(direct_p2p)=场外收款。
//   三者性质不同不该混成一个 GMV。B6b-1:补第三桶 —— 此前 usdc_escrow 完成单两个桶都不进,在拆分里凭空蒸发。
;(function () {
  window.gmvRailSplitHtml = (escrow, directPay, usdcEscrow, fmt) => {
    const d = Number(directPay) || 0, u = Number(usdcEscrow) || 0
    if (d <= 0 && u <= 0) return ''                          // 纯 WAZ 托管卖家 → 不显示,GMV 就是纯托管
    const e = Number(escrow) || 0
    const f = typeof fmt === 'function' ? fmt : (n) => Number(n || 0).toFixed(0)
    return `<div style="font-size:10px;color:#6b7280;margin-top:3px;line-height:1.5" title="${t('托管=平台托管收入;链上担保=USDC 存入链上合约,平台不经手本金;直接收款=场外收款,平台不经手')}">🏦 ${t('托管')} ${f(e)}${u > 0 ? ` · ⛓️ ${t('链上担保')} ${f(u)}` : ''}${d > 0 ? ` · 🤝 ${t('直接收款')} ${f(d)}` : ''}</div>`
  }
})()
