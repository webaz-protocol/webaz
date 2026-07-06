// 跨境税费/进口责任【卖家设置】(S3;S5 起买家披露移至 app-purchase-terms-ui.js)。UI ONLY —— seller-declared,平台不算不收代缴。
//   店铺设置卡追加 DDP/DDU 下拉 + 价内含税行(包装 shipHydrateSellerSettings/Save)。诚实纪律:仅"价内已含"披露,向买家加收税不支持。
;(function () {
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
