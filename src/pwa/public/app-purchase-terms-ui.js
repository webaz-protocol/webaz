// 买家下单前【购买条款聚合 + 收货地区入口】(S5)。UI ONLY,只读聚合 S1-S4 已存字段(GET /products/:id/shipping-options?ship_to_region)。
//   ① 地区入口 _shipRegionInputHtml:运费模板→下拉;无模板但可售区=白名单→按白名单下拉;无模板+排除式/仅平台限制→自由输入(否则 region_required 却无入口=卡单)。
//   ② 条款卡 _ptHydrate:可售裁定 / 运费覆盖·费用·时效 or 需询价 / 满额免邮 / 目的区价内含税 / DDU-DDP / 平台不代收税声明。
//   不动订单金额、不收税。收货地区变更由地区入口调 _purchaseTermsRefresh 重拉。诚实披露:税费/进口责任均卖家声明。
;(function () {
  // ① 收货地区输入(app-order-accept-ui 的地区块委托到此,便于随 shipping-options 字段演进;shipSelectedRegion 读 select/自由输入两态)
  window._shipRegionInputHtml = (o) => {
    const tpl = Array.isArray(o.template) ? o.template : []
    const sr = o.sale_regions   // {mode, include?, exclude?} | null
    const listRegions = (!tpl.length && sr && sr.mode === 'list' && Array.isArray(sr.include)) ? sr.include : []
    const label = `<label class="form-label" style="font-size:12px">📍 ${t('收货国家/地区')} *</label>`
    const refresh = 'window._purchaseTermsRefresh && window._purchaseTermsRefresh()'
    const opts = tpl.length
      ? tpl.map(e => `<option value="${escHtml(e.region)}">${e.region === '*' ? t('其他地区(通用运费)') : escHtml(e.region)} · ${t('运费')} ${e.fee}${e.est_days ? ` · ${escHtml(e.est_days)} ${t('天')}` : ''}</option>`).join('')
      : listRegions.map(r => `<option value="${escHtml(r)}">${escHtml(r)}</option>`).join('')
    if (!opts && !o.quote_outside_template)   // 无任何可选项且无询价 → 自由输入(排除式可售区 / 仅平台限制 / 配置异常)
      return `${label}<input class="form-control" id="ship-region-other" maxlength="16" placeholder="${t('地区代码,如 US / JP / DE')}" oninput="${refresh}" style="font-size:13px;text-transform:uppercase">
        <div style="font-size:11px;color:#6b7280;margin-top:4px">${t('该商品设有可售地区限制,请填写收货地区以确认可否下单。')}</div>`
    return `${label}
      <select class="form-control" id="ship-region-select" style="font-size:13px" onchange="document.getElementById('ship-region-other').style.display = this.value === '__other' ? 'block' : 'none'; ${refresh}">
        <option value="">${t('请选择')}</option>${opts}
        ${o.quote_outside_template ? `<option value="__other">${t('其他地区(需卖家报价运费,直付)')}</option>` : ''}
      </select>
      <input class="form-control" id="ship-region-other" maxlength="16" placeholder="${t('地区代码,如 US / JP / DE')}" oninput="${refresh}" style="display:none;margin-top:6px;font-size:13px;text-transform:uppercase">
      <div style="font-size:11px;color:#6b7280;margin-top:4px">${o.quote_outside_template ? t('模板内地区运费自动计入总额;其他地区由卖家先报价、你确认后再付款。') : (tpl.length ? t('运费按所选地区自动计入订单总额。') : t('该商品按可售地区下单,运费以卖家约定为准。'))}</div>`
  }

  // ② 条款聚合卡
  window.purchaseTermsBlockHtml = (productId) => { window._ptPid = productId; setTimeout(() => window._ptHydrate(productId), 70); return `<div id="purchase-terms-block" style="display:none;margin-top:10px"></div>` }
  window._purchaseTermsRefresh = () => window._ptHydrate(window._ptPid, window.shipSelectedRegion ? window.shipSelectedRegion() : undefined)
  window._ptHydrate = async (productId, region) => {
    const box = document.getElementById('purchase-terms-block'); if (!box) return
    const o = await GET(`/products/${productId}/shipping-options${region ? '?ship_to_region=' + encodeURIComponent(region) : ''}`).catch(() => null); if (!o) return
    box.style.display = 'none'
    const rows = []
    // 可售裁定(最优先;配置异常无论是否选区都醒目红条,不诱导买家提交后才 503;其余不可售需选区后才判)
    const sell = o.sellable || { ok: true, reason: 'ok' }
    if (!sell.ok && (region || sell.reason === 'platform_policy_invalid')) {
      const invalid = sell.reason === 'platform_policy_invalid'
      const msg = invalid ? t('平台合规配置异常,该商品暂时无法下单,请稍后再试。')
        : sell.reason === 'product_restricted' ? t('平台合规限制:该商品暂不支持销售到所选地区。')
        : sell.reason === 'region_not_for_sale' ? t('卖家未将所选地区设为可售范围,该地区暂不可下单。')
        : t('该商品设有可售地区限制,请选择收货地区确认。')
      box.innerHTML = `<div class="card" style="border:1px solid #fca5a5;background:#fef2f2;padding:10px 12px;font-size:12px;color:#991b1b;line-height:1.6">🚫 <strong>${invalid ? t('暂时无法下单') : t('该地区不可售')}</strong> — ${msg}</div>`
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
