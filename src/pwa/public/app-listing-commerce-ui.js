// 单链接商务覆盖(S4)—— 上架/编辑表单里按【单个商品】覆盖店铺默认:接单/运费/询价/可售区/满额免邮/税费进口责任/清关字段。
//   UI ONLY,写全部复用已验证端点(POST /seller/accept-mode + /seller/shipping-template + PUT /products/:id)。
//   "留空=继承店铺默认"(值 null 清除该商品覆盖);编辑态从已取到的 product 行(formatProductForAgent 透传各覆盖列)回填。
//   app.js 净零:add/edit 表单各注入一个 section hook + 保存时调 window.listingCommerceSave(productId)。
;(function () {
  const J = (x) => { try { return typeof x === 'string' ? JSON.parse(x) : (x || null) } catch { return null } }
  const tplText = (arr) => (Array.isArray(arr) ? arr : []).map(e => `${e.region} ${e.fee}${e.est_days ? ' ' + e.est_days : ''}`).join('\n')
  const taxText = (arr) => (Array.isArray(arr) ? arr : []).map(l => `${l.region} ${l.label}${l.rate_pct != null ? ' ' + l.rate_pct : ''}`).join('\n')
  const srCodes = (r) => r ? (r.mode === 'list' ? (r.include || []) : (r.exclude || [])).join(' ') : ''

  // p = 商品对象(编辑)或 null(新建)。所有字段 id 前缀 lc-。
  window.listingCommerceSectionHtml = (p) => {
    p = p || {}
    const sr = J(p.sale_regions)
    const sel = (id, cur, opts) => `<select class="form-control" id="${id}" style="font-size:13px">${opts.map(([v, lbl]) => `<option value="${v}" ${String(cur ?? '') === v ? 'selected' : ''}>${lbl}</option>`).join('')}</select>`
    return `<details style="margin-bottom:16px">
      <summary style="font-size:13px;color:#6b7280;cursor:pointer;padding:4px 0">🌍 ${t('本商品:接单 / 运费 / 可售区 / 税费(留空=用店铺默认)')}</summary>
      <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px">
        <div><label class="form-label" style="font-size:12px">${t('接单模式')}</label>${sel('lc-accept', p.accept_mode, [['', t('继承店铺默认')], ['auto', t('自动接单')], ['manual', t('手动接单')]])}</div>
        <div><label class="form-label" style="font-size:12px">${t('运费模板(每行:地区码 运费 [时效];* 兜底;留空=继承)')}</label><textarea class="form-control" id="lc-tpl" rows="2" style="font-size:12px;font-family:monospace" placeholder="SG 5 3-5&#10;* 25 10-20">${escHtml(tplText(J(p.shipping_template)))}</textarea></div>
        <div><label class="form-label" style="font-size:12px">${t('模板外地区询价(直付)')}</label>${sel('lc-quote', p.shipping_quote_ok == null ? '' : (Number(p.shipping_quote_ok) === 1 ? '1' : '0'), [['', t('继承店铺默认')], ['1', t('开')], ['0', t('关')]])}</div>
        <div style="display:flex;gap:8px">
          <div style="flex:1"><label class="form-label" style="font-size:12px">${t('可售区域')}</label>${sel('lc-sr-mode', sr ? sr.mode : '', [['', t('继承/不限')], ['list', t('仅允许')], ['all', t('全球除外')]])}</div>
          <div style="flex:1"><label class="form-label" style="font-size:12px">${t('地区码(空格分隔)')}</label><input class="form-control" id="lc-sr-codes" style="font-size:12px;font-family:monospace" value="${escHtml(srCodes(sr))}"></div>
        </div>
        <div style="display:flex;gap:8px">
          <div style="flex:1"><label class="form-label" style="font-size:12px">${t('满额免邮阈值')}</label><input class="form-control" id="lc-free" type="number" min="0" step="0.01" placeholder="${t('继承')}" value="${p.free_shipping_threshold ?? ''}"></div>
          <div style="flex:1"><label class="form-label" style="font-size:12px">${t('进口责任')}</label>${sel('lc-duty', p.import_duty_terms, [['', t('继承/不声明')], ['ddu', 'DDU'], ['ddp', 'DDP']])}</div>
        </div>
        <div><label class="form-label" style="font-size:12px">${t('价内已含税(每行:地区码 税名 [税率%];留空=继承)')}</label><textarea class="form-control" id="lc-tax" rows="2" style="font-size:12px;font-family:monospace" placeholder="SG GST 9">${escHtml(taxText(J(p.tax_lines)))}</textarea></div>
        <div style="border-top:1px dashed #e5e7eb;padding-top:8px;font-size:11px;color:#9ca3af">${t('跨境清关字段(证据用,可选)')}</div>
        <div style="display:flex;gap:8px">
          <input class="form-control" id="lc-weight" type="number" min="0" step="0.01" placeholder="${t('重量 kg')}" value="${p.weight_kg ?? ''}" style="font-size:12px">
          <input class="form-control" id="lc-pkg" placeholder="${t('尺寸 长x宽x高cm')}" value="${escHtml(p.package_size || '')}" style="font-size:12px">
        </div>
        <div style="display:flex;gap:8px">
          <input class="form-control" id="lc-origin" placeholder="${t('发货国码')}" value="${escHtml(p.origin_country || '')}" style="font-size:12px;text-transform:uppercase">
          <input class="form-control" id="lc-coo" placeholder="${t('原产国码')}" value="${escHtml(p.country_of_origin || '')}" style="font-size:12px;text-transform:uppercase">
          <input class="form-control" id="lc-hs" placeholder="${t('HS 编码')}" value="${escHtml(p.hs_code || '')}" style="font-size:12px">
        </div>
        <input class="form-control" id="lc-customs-desc" placeholder="${t('报关英文品名')}" value="${escHtml(p.customs_description || '')}" style="font-size:12px">
      </div></details>`
  }

  const LC_FIELDS = ['lc-accept', 'lc-tpl', 'lc-quote', 'lc-sr-mode', 'lc-free', 'lc-duty', 'lc-tax', 'lc-weight', 'lc-pkg', 'lc-origin', 'lc-coo', 'lc-hs', 'lc-customs-desc']
  window.listingCommerceHasOverrides = () => LC_FIELDS.some(id => ((document.getElementById(id)?.value) || '').trim() !== '')   // 新建时据此决定"仓库优先"(有覆盖→先落仓库,全落定再激活)
  // 收集并保存(新建/编辑同用;productId 必须已存在)。留空=null=清除该商品覆盖。复用已验证端点,任一报错即冒泡。opts.activate=全成功后激活(仓库优先新品的收尾)。
  window.listingCommerceSave = async (productId, opts) => {
    if (!productId || !document.getElementById('lc-accept')) return { ok: true }   // section 未渲染 → 跳过
    const v = (id) => (document.getElementById(id)?.value || '').trim()
    const parseTpl = (txt) => txt.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const m = l.split(/\s+/); const est = m.slice(2).join(' '); return { region: m[0], fee: Number(m[1]), ...(est ? { est_days: est } : {}) } })
    const parseTax = (txt) => txt.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const m = l.split(/\s+/); const region = m[0]; const last = m[m.length - 1]; const hasRate = m.length > 2 && /^[0-9.]+$/.test(last); const label = m.slice(1, hasRate ? -1 : undefined).join(' '); return { region, label, ...(hasRate ? { rate_pct: Number(last) } : {}), kind: 'included' } })   // 空格安全:label 可含空格(如 Sales Tax);末 token 为数字才当税率
    const srMode = v('lc-sr-mode'); const srCodesArr = v('lc-sr-codes').split(/\s+/).filter(Boolean)
    const tplTxt = v('lc-tpl'); const taxTxt = v('lc-tax'); const q = v('lc-quote'); const fr = v('lc-free')
    const steps = [   // 顺序 fail-fast:校验最重的运费/税费 body 先行 → 它被拒时接单/清关都还没写,避免部分保存(各字段独立无跨字段不变量)
      () => POST('/seller/shipping-template', {
        product_id: productId,
        template: tplTxt ? parseTpl(tplTxt) : null,
        quote_ok: q === '' ? null : q === '1',
        sale_regions: srMode ? { mode: srMode, ...(srMode === 'list' ? { include: srCodesArr } : { exclude: srCodesArr }) } : null,
        free_shipping_threshold: fr === '' ? null : Number(fr),
        import_duty_terms: v('lc-duty') || null,
        tax_lines: taxTxt ? parseTax(taxTxt) : null,
      }),
      () => POST('/seller/accept-mode', { product_id: productId, accept_mode: v('lc-accept') || null }),
      () => PUT(`/products/${productId}`, { weight_kg: v('lc-weight') ? Number(v('lc-weight')) : null, package_size: v('lc-pkg') || null, origin_country: v('lc-origin') || null, country_of_origin: v('lc-coo') || null, customs_description: v('lc-customs-desc') || null, hs_code: v('lc-hs') || null }),
    ]
    for (const step of steps) { const r = await step(); if (r && r.error) return { ok: false, error: r.error } }
    if (opts && opts.activate) { const a = await PATCH(`/products/${productId}/status`, { status: 'active' }); if (a && a.error) return { ok: false, error: a.error } }   // 仓库优先新品:覆盖全落定 → 激活;激活失败也算失败(商品留仓库=不可售,安全)
    return { ok: true }
  }
})()
