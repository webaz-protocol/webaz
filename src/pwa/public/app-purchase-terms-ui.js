// 买家下单前【购买条款聚合】(S5)。UI ONLY,只读聚合 S1-S4 已存字段(GET /products/:id/shipping-options?ship_to_region)。
//   一处呈现:目的地是否可售 / 运费覆盖·费用·时效 or 需询价 / 满额免邮 / 目的区价内含税 / DDU-DDP / 平台不代收税声明。
//   不动订单金额、不收税。收货地区变更由运费选择器调 _purchaseTermsRefresh 重拉。诚实披露:税费/进口责任均卖家声明。
;(function () {
  window.purchaseTermsBlockHtml = (productId) => { window._ptPid = productId; setTimeout(() => window._ptHydrate(productId), 70); return `<div id="purchase-terms-block" style="display:none;margin-top:10px"></div>` }
  window._purchaseTermsRefresh = () => window._ptHydrate(window._ptPid, window.shipSelectedRegion ? window.shipSelectedRegion() : undefined)
  window._ptHydrate = async (productId, region) => {
    const box = document.getElementById('purchase-terms-block'); if (!box) return
    const o = await GET(`/products/${productId}/shipping-options${region ? '?ship_to_region=' + encodeURIComponent(region) : ''}`).catch(() => null); if (!o) return
    box.style.display = 'none'
    const rows = []
    // 可售裁定(最优先;不可售醒目红条)
    const sell = o.sellable || { ok: true, reason: 'ok' }
    if (!sell.ok && region) {
      const msg = sell.reason === 'product_restricted' ? t('平台合规限制:该商品暂不支持销售到所选地区。')
        : sell.reason === 'region_not_for_sale' ? t('卖家未将所选地区设为可售范围,该地区暂不可下单。')
        : t('该商品设有可售地区限制,请选择收货地区确认。')
      box.innerHTML = `<div class="card" style="border:1px solid #fca5a5;background:#fef2f2;padding:10px 12px;font-size:12px;color:#991b1b;line-height:1.6">🚫 <strong>${t('该地区不可售')}</strong> — ${msg}</div>`
      box.style.display = 'block'; return
    }
    // 运费裁定(有模板+选了区)
    const rs = o.resolved_shipping
    if (rs) rows.push(rs.covered
      ? `<div style="color:#374151">📦 ${t('运费')}:${rs.fee === 0 ? t('免运费') : rs.fee}${rs.est_days ? ` · ${t('约')} ${escHtml(String(rs.est_days))} ${t('天')}` : ''}</div>`
      : rs.quote_required ? `<div style="color:#92400e">📦 ${t('该地区需卖家先报运费,确认后再付款(直付)。')}</div>`
      : `<div style="color:#991b1b">📦 ${t('卖家暂不配送到该地区。')}</div>`)
    if (o.free_shipping_threshold) rows.push(`<div style="color:#166534">🚚 ${t('满')} ${o.free_shipping_threshold} ${t('免运费')}</div>`)
    // 进口责任 DDU/DDP
    const duty = o.import_duty_terms
    if (duty === 'ddu') rows.push(`<div style="color:#92400e">🛃 <strong>${t('进口关税/税:到境自付(DDU)')}</strong> — ${t('本商品价格不含目的国进口关税/税;跨境到货时可能由承运人向你收取,金额由海关核定,与卖家/平台无关。')}</div>`)
    else if (duty === 'ddp') rows.push(`<div style="color:#166534">🛃 <strong>${t('进口关税/税:卖家已含(DDP)')}</strong> — ${t('卖家声明价格已包含目的国进口关税/税,正常到货应无额外费用。')}</div>`)
    // 价内含税
    const lines = Array.isArray(o.tax_included_lines) ? o.tax_included_lines : []
    for (const l of lines) rows.push(`<div style="color:#374151">🧾 ${t('价内已含')}:${escHtml(l.label)}${l.rate_pct != null ? ' ' + l.rate_pct + '%' : ''}${l.region && l.region !== '*' ? ' (' + escHtml(l.region) + ')' : ''}${l.note ? ' · ' + escHtml(l.note) : ''}</div>`)
    if (rows.length === 0) return   // 无任何条款 → 不臆造
    const hasTaxOrDuty = duty || lines.length > 0
    box.innerHTML = `<div class="card" style="border:1px solid #e5e7eb;background:#fafafa;padding:10px 12px;font-size:12px;line-height:1.7">
      <div style="font-weight:600;color:#6b7280;margin-bottom:4px">🌍 ${t('购买条款')}${region ? '(' + t('发往') + ' ' + escHtml(region) + ')' : ''}</div>${rows.join('')}
      ${hasTaxOrDuty ? `<div style="color:#9ca3af;font-size:11px;margin-top:4px">${t('税费与进口责任为卖家自行声明,平台不代收代缴税费(直付非托管)。')}</div>` : ''}</div>`
    box.style.display = 'block'
  }
})()
