// 跨境税费/进口责任(S3)。UI ONLY —— 卖家 seller-declared,平台不算不收代缴。买家侧:下单前披露 DDP/DDU + 价内已含税(按收货地区筛,GET /products/:id/shipping-options?ship_to_region)。卖家侧:店铺设置卡追加 DDP/DDU + 价内含税行(包装 shipHydrateSellerSettings/Save)。
//   诚实披露纪律(调研):DDU 付款前明示"关税/税到境自付";DDP 明示"已含";价内含税据实列且只列目的区适用项。
;(function () {
  // ── 买家下单前披露 ──
  window.tradeTaxBlockHtml = (productId) => { window._tradeTaxPid = productId; setTimeout(() => window._tradeTaxHydrate(productId), 70); return `<div id="trade-tax-block" style="display:none;margin-top:10px"></div>` }
  window._tradeTaxRefresh = () => window._tradeTaxHydrate(window._tradeTaxPid, window.shipSelectedRegion ? window.shipSelectedRegion() : undefined)   // 收货地区变更后由运费选择器调用:税费披露随目的区重筛
  window._tradeTaxHydrate = async (productId, region) => {
    const box = document.getElementById('trade-tax-block'); if (!box) return
    const o = await GET(`/products/${productId}/shipping-options${region ? '?ship_to_region=' + encodeURIComponent(region) : ''}`).catch(() => null); if (!o) return
    box.style.display = 'none'   // 重筛可能清空(换到无该区税的目的地)→ 先隐藏,有内容再显
    const duty = o.import_duty_terms; const lines = Array.isArray(o.tax_included_lines) ? o.tax_included_lines : []
    if (!duty && lines.length === 0) return   // 卖家未声明 → 不臆造
    const dutyRow = duty === 'ddu'
      ? `<div style="color:#92400e">🛃 <strong>${t('进口关税/税:到境自付(DDU)')}</strong> — ${t('本商品价格不含目的国进口关税/税;跨境到货时可能由承运人向你收取,金额由海关核定,与卖家/平台无关。')}</div>`
      : duty === 'ddp' ? `<div style="color:#166534">🛃 <strong>${t('进口关税/税:卖家已含(DDP)')}</strong> — ${t('卖家声明价格已包含目的国进口关税/税,正常到货应无额外费用。')}</div>` : ''
    const taxRows = lines.map(l => `<div style="color:#374151">🧾 ${t('价内已含')}:${escHtml(l.label)}${l.rate_pct != null ? ' ' + l.rate_pct + '%' : ''}${l.region && l.region !== '*' ? ' (' + escHtml(l.region) + ')' : ''}${l.note ? ' · ' + escHtml(l.note) : ''}</div>`).join('')
    box.innerHTML = `<div class="card" style="border:1px solid #e5e7eb;background:#fafafa;padding:10px 12px;font-size:12px;line-height:1.7">
      <div style="font-weight:600;color:#6b7280;margin-bottom:4px">${t('税费与进口责任(卖家声明)')}</div>${dutyRow}${taxRows}
      <div style="color:#9ca3af;font-size:11px;margin-top:4px">${t('以上为卖家自行声明,平台不代收代缴税费。')}</div></div>`
    box.style.display = 'block'
  }

  // ── 卖家店铺设置(包装既有运费设置卡)──
  const _origHydrate = window.shipHydrateSellerSettings
  window.shipHydrateSellerSettings = async () => {
    await _origHydrate()
    const box = document.getElementById('ship-settings-body'); if (!box || document.getElementById('tt-duty')) return
    const s = await GET('/seller/shipping-settings').catch(() => null)
    const duty = s && s.store_import_duty_terms; const lines = (s && s.store_tax_lines) || []
    const tplText = lines.map(l => `${l.region} ${l.label}${l.rate_pct != null ? ' ' + l.rate_pct : ''}`).join('\n')
    box.insertAdjacentHTML('beforeend', `
      <div style="border-top:1px dashed #e5e7eb;margin:10px 0;padding-top:10px">
        <label class="form-label" style="font-size:12px">${t('跨境进口责任(店铺默认;卖家声明,平台不代收税)')}</label>
        <select class="form-control" id="tt-duty" style="font-size:13px;margin-bottom:8px">
          <option value="" ${!duty ? 'selected' : ''}>${t('不声明(默认)')}</option>
          <option value="ddu" ${duty === 'ddu' ? 'selected' : ''}>${t('DDU — 买家到境自付关税/税')}</option>
          <option value="ddp" ${duty === 'ddp' ? 'selected' : ''}>${t('DDP — 卖家已含关税/税')}</option>
        </select>
        <label class="form-label" style="font-size:12px">${t('价内已含税声明(每行:地区码 税名 [税率%];* 为通用;如 SG GST 9)')}</label>
        <textarea class="form-control" id="tt-tax" rows="2" placeholder="SG GST 9&#10;* VAT" style="font-size:12px;font-family:monospace">${escHtml(tplText)}</textarea>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px">${t('仅"价内已含"披露;向买家加收的税暂不支持(平台不代收)。设置只影响之后的新订单。')}</div>
      </div>`)
  }
  const _origSave = window.shipSaveSellerSettings
  window.shipSaveSellerSettings = async () => {
    await _origSave()
    const dutyEl = document.getElementById('tt-duty'); if (!dutyEl) return
    const lines = (document.getElementById('tt-tax')?.value || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const m = l.split(/\s+/); return { region: m[0], label: m[1] || '', ...(m[2] ? { rate_pct: Number(m[2]) } : {}), kind: 'included' } })
    const r = await POST('/seller/shipping-template', { store_import_duty_terms: dutyEl.value || null, store_tax_lines: lines.length ? lines : null })
    const msg = document.getElementById('ship-set-msg'); if (r.error && msg) msg.innerHTML = `<span style="color:#dc2626">${escHtml(r.error)}</span>`
  }
})()
