// GMV 按支付轨拆分小注(卖家仪表盘共用)。UI ONLY。
//   托管(escrow)= 平台真实托管收入;直接收款(direct_p2p)= 场外收款,平台不经手 —— 二者不同性质,不该混成一个 GMV。
//   仅当【有直接收款】时显示(纯托管卖家不打扰);金额沿用调用方的计价显示。
;(function () {
  window.gmvRailSplitHtml = (escrow, directPay, fmt) => {
    const d = Number(directPay) || 0
    if (d <= 0) return ''                                   // 无直接收款 → 不显示,GMV 就是纯托管
    const e = Number(escrow) || 0
    const f = typeof fmt === 'function' ? fmt : (n) => Number(n || 0).toFixed(0)
    return `<div style="font-size:10px;color:#6b7280;margin-top:3px;line-height:1.5" title="${t('托管=平台托管收入;直接收款=场外收款,平台不经手')}">🏦 ${t('托管')} ${f(e)} · 🤝 ${t('直接收款')} ${f(d)}</div>`
  }
})()
