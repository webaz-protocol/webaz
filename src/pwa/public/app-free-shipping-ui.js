// 满额免邮 UI(营销域,S2 返工)。UI ONLY —— 校验/判免全在后端(free-shipping.ts,建单 gate 应用)。入口:卖家后台「营销」tab 卡(app.js 净零 hook);点开就地 sheet 配店铺阈值,单品覆盖走 API。语义:促销非运费结构,券后货款≥阈值运费商家承担;供应商报价期规则不搬家。
;(function () {
  window.freeShippingMarketingCard = () => `
      <div onclick="fsOpenSheet()" class="card" style="padding:14px;cursor:pointer;background:linear-gradient(135deg,#ecfeff,#cffafe);border-color:#67e8f9">
        <div style="font-size:24px">🚚</div>
        <div style="font-weight:600;font-size:13px;color:#155e75;margin-top:6px">${t('满额免邮')}</div>
        <div style="font-size:10px;color:#0e7490;margin-top:2px">${t('拉客单价 · 运费你承担')}</div>
      </div>`
  window.fsOpenSheet = async () => {
    const s = await GET('/seller/shipping-settings').catch(() => null)
    const cur = s && s.store_free_shipping_threshold
    const html = `
      <div style="font-size:14px;font-weight:700;margin-bottom:6px">🚚 ${t('满额免邮(店铺默认)')}</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:10px">${t('买家券后货款(不含保险/捐赠)达到阈值时,本单运费免收、由你承担。人工询价订单不适用;单品可经接口单独覆盖;只影响之后的新订单。')}</div>
      <input class="form-control" id="fs-threshold" type="number" min="0" step="0.01" placeholder="${t('阈值金额(留空=关闭)')}" value="${cur ?? ''}" style="margin-bottom:10px">
      <button class="btn btn-primary btn-sm" style="width:auto" onclick="fsSave()">${t('保存免邮设置')}</button>
      <div id="fs-msg" style="margin-top:6px;font-size:11px"></div>`
    if (typeof openSheet === 'function') openSheet(html)
    else { const d = document.createElement('div'); d.className = 'card js-sheet'; d.style.cssText = 'position:fixed;left:50%;top:20%;transform:translateX(-50%);z-index:120;max-width:360px;width:92%'; d.innerHTML = html + `<button class="btn btn-outline btn-sm" style="width:auto;margin-top:8px" onclick="this.closest('.js-sheet').remove()">${t('关闭')}</button>`; document.body.appendChild(d) }
  }
  window.fsSave = async () => {
    const raw = (document.getElementById('fs-threshold')?.value || '').trim()
    const msg = document.getElementById('fs-msg')
    if (raw !== '' && !(Number.isFinite(Number(raw)) && Number(raw) > 0)) { if (msg) msg.innerHTML = `<span style="color:#dc2626">${t('阈值必须是正数')}</span>`; return }   // 审计 P3:1e999→Infinity→JSON null→静默清除,前端就地拒
    const r = await POST('/seller/shipping-template', { store_free_shipping_threshold: raw === '' ? null : Number(raw) })
    if (r.error) { if (msg) msg.innerHTML = `<span style="color:#dc2626">${escHtml(r.error)}</span>`; return }
    if (msg) msg.innerHTML = `<span style="color:#16a34a">✓ ${t('已保存')}${raw === '' ? ' · ' + t('已关闭') : ''}</span>`
  }
})()
