// 可售区域 UI(跨境 S1)。UI ONLY —— 判定/校验全在后端(gate 在建单,REGION_NOT_FOR_SALE 硬拒不询价)。
//   注入:包装 shipHydrateSellerSettings / shipSaveSellerSettings(接单与运费卡尾部追加,capped 文件净零)。
//   语义:与运费模板分层 —— 这里是"卖不卖",运费模板是"多少钱";平台合规名单商家不可放宽。
;(function () {
  const _origHydrate = window.shipHydrateSellerSettings
  window.shipHydrateSellerSettings = async () => {
    await _origHydrate()
    const box = document.getElementById('ship-settings-body'); if (!box || document.getElementById('sr-mode')) return
    const s = await GET('/seller/shipping-settings').catch(() => null)
    const rule = (s && s.store_sale_regions) || null
    const codes = rule ? (rule.mode === 'list' ? (rule.include || []) : (rule.exclude || [])) : []
    box.insertAdjacentHTML('beforeend', `
      <div style="border-top:1px dashed #e5e7eb;margin:10px 0;padding-top:10px">
        <label class="form-label" style="font-size:12px">${t('可售区域(店铺默认;与运费无关 —— 这里是"卖不卖",运费模板是"多少钱")')}</label>
        <select class="form-control" id="sr-mode" style="font-size:13px;margin-bottom:6px" onchange="document.getElementById('sr-codes-row').style.display = this.value ? '' : 'none'">
          <option value="" ${!rule ? 'selected' : ''}>${t('不限(全球可下单)')}</option>
          <option value="list" ${rule && rule.mode === 'list' ? 'selected' : ''}>${t('仅允许这些地区')}</option>
          <option value="all" ${rule && rule.mode === 'all' ? 'selected' : ''}>${t('全球可卖,但排除这些地区')}</option>
        </select>
        <div id="sr-codes-row" style="${rule ? '' : 'display:none'}">
          <input class="form-control" id="sr-codes" placeholder="${t('地区代码,空格分隔,如:SG MY CN')}" value="${escHtml(codes.join(' '))}" style="font-size:12px;font-family:monospace;margin-bottom:6px">
        </div>
        <div style="font-size:11px;color:#9ca3af">${t('不可售地区的买家下单会被直接拒绝(不走询价);设置只影响之后的新订单,单品可在接口单独覆盖。')}</div>
      </div>`)
  }
  const _origSave = window.shipSaveSellerSettings
  window.shipSaveSellerSettings = async () => {
    await _origSave()
    const modeEl = document.getElementById('sr-mode'); if (!modeEl) return
    const mode = modeEl.value
    const codes = (document.getElementById('sr-codes')?.value || '').trim().split(/\s+/).filter(Boolean)
    const body = !mode ? { store_sale_regions: null }
      : { store_sale_regions: { mode, ...(mode === 'list' ? { include: codes } : { exclude: codes }) } }
    const r = await POST('/seller/shipping-template', body)
    const msg = document.getElementById('ship-set-msg')
    if (r.error && msg) msg.innerHTML = `<span style="color:#dc2626">${escHtml(r.error)}</span>`
  }
})()
