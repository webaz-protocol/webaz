// 接单模式+运费模板+询价系列 UI(PR-4;后端 v16-v18 已合)。UI ONLY,边界全在后端。
//   ① 通知模板注册(PR-1..3 的 9 个 key,此前回退中文);② pending_accept 徽标/标签;③ 买单 sheet 收货地区
//   选择+运费预览(自调度 hydrate);④ 订单页接单/询价卡(买家+卖家);⑤ 卖家店铺设置区块(接单模式/模板/询价开关)。
//   中文 t(),英文 i18n.js _EN。
;(function () {
  const S = window._notifSub
  const P = (emoji, titleZh, bodyZh) => (p) => ({ title: emoji + ' ' + t(titleZh), body: S(t(bodyZh), p) })
  Object.assign(window.NOTIF_TEMPLATES, {
    dp_pending_accept_new: P('🛎️', '新直付订单,待你确认接单', '商品「{product}」× {qty},应付 {amount} USDC。请在 {hours} 小时内确认接单(核实可发货/物流),超时订单自动取消;接单后买家才会看到收款方式。'),
    dp_pending_accept_accepted: P('✅', '卖家已确认接单,请付款', '卖家已确认可发货并接单。请在 {hours} 小时内完成风险确认后查看收款方式并付款;逾期未付订单将进入超时流程。'),
    dp_pending_accept_declined: P('❌', '卖家未能接单,订单已取消', '卖家未能确认发货{reason}。订单已无责取消 —— 你尚未付款,无需任何操作;双方信誉均不受影响。'),
    dp_pending_accept_cancelled: P('↩️', '买家已撤单', '买家在你确认接单前撤回了订单。订单已无责取消,库存已恢复。'),
    dp_pending_accept_expired_buyer: P('⏰', '卖家超时未接单,订单已取消', '卖家未在接单窗口内确认,订单已自动取消 —— 你尚未付款,无需任何操作。可换商品或联系卖家后重新下单。'),
    dp_pending_accept_expired_seller: P('⏰', '订单因超时未接单已取消', '你未在接单窗口内确认接单,订单已自动取消,库存已恢复。频繁超时会影响买家体验,可考虑改用自动接单或缩短响应时间。'),
    dp_quote_needed: P('🛎️', '新直付订单(模板外地区),待你报价运费', '商品「{product}」× {qty},货款 {amount} USDC,收货地区 {region} 不在你的运费模板内。请在 {hours} 小时内核实可达并报价(运费+预计时效),买家确认后才进入付款;超时订单自动取消。'),
    dp_quote_submitted: P('📦', '卖家已报价运费,请确认', '卖家确认可发货并报价:运费 {fee} USDC{est} 天。新总额 {total} USDC。请在 {hours} 小时内确认(确认后进入付款环节)或撤单;逾期订单自动取消。'),
    dp_quote_confirmed: P('✅', '买家已确认运费报价', '买家已确认新总额 {total} USDC(含运费 {fee}),订单进入付款窗口。买家完成场外付款并标记后你会收到发货提醒。'),
  })

  // ② 状态徽标/标签(app.js dp 链尾)
  window.dpAcceptBadge = (s) => s === 'pending_accept' ? ['amber', t('待卖家接单')] : null
  window.dpAcceptLabel = (s) => s === 'pending_accept' ? t('等待卖家确认接单') : null

  // ③ 买单 sheet 收货地区(渲染期调用 → 调度 hydrate;无模板商品自动隐藏,零打扰)
  window.shipRegionBlockHtml = (productId) => {
    setTimeout(() => window._shipHydrateRegion(productId), 60)
    return `<div id="ship-region-block" style="display:none;margin-top:10px"></div>`
  }
  window._shipHydrateRegion = async (productId) => {
    const box = document.getElementById('ship-region-block'); if (!box) return
    const o = await GET(`/products/${productId}/shipping-options`).catch(() => null)
    if (!o || !o.region_required) return
    const opts = (o.template || []).map(e => `<option value="${escHtml(e.region)}">${e.region === '*' ? t('其他地区(通用运费)') : escHtml(e.region)} · ${t('运费')} ${e.fee}${e.est_days ? ` · ${escHtml(e.est_days)} ${t('天')}` : ''}</option>`).join('')
    box.innerHTML = `<label class="form-label" style="font-size:12px">📍 ${t('收货国家/地区')} *</label>
      <select class="form-control" id="ship-region-select" style="font-size:13px" onchange="document.getElementById('ship-region-other').style.display = this.value === '__other' ? 'block' : 'none'">
        <option value="">${t('请选择')}</option>${opts}
        ${o.quote_outside_template ? `<option value="__other">${t('其他地区(需卖家报价运费,直付)')}</option>` : ''}
      </select>
      <input class="form-control" id="ship-region-other" maxlength="16" placeholder="${t('地区代码,如 US / JP / DE')}" style="display:none;margin-top:6px;font-size:13px;text-transform:uppercase">
      <div style="font-size:11px;color:#6b7280;margin-top:4px">${o.quote_outside_template ? t('模板内地区运费自动计入总额;其他地区由卖家先报价、你确认后再付款。') : t('运费按所选地区自动计入订单总额。')}</div>`
    box.style.display = 'block'
  }
  window.shipSelectedRegion = () => {
    const sel = document.getElementById('ship-region-select')
    if (!sel) return undefined
    if (sel.value === '__other') return (document.getElementById('ship-region-other')?.value || '').trim().toUpperCase() || undefined
    return sel.value || undefined
  }

  // ④ 订单页接单/询价卡(仅 direct_p2p + pending_accept;买卖双方各自动作;边界在后端,这里只是表单)
  window.dpPendingAcceptCard = (order, isBuyer, isSeller) => {
    if (!order || order.payment_rail !== 'direct_p2p' || order.status !== 'pending_accept' || !(isBuyer || isSeller)) return ''
    const oid = order.id
    const quote = Number(order.shipping_quote_required) === 1
    const quoted = quote && order.shipping_quote_fee != null
    const dl = order.pending_accept_deadline ? `<div style="font-size:11px;color:#92400e;margin-top:6px">⏳ ${t('响应截止')}:${fmtTime(order.pending_accept_deadline)}(${t('超时自动取消,无人担责')})</div>` : ''
    const head = `<div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:4px">🛎️ ${quote ? t('询价接单(模板外地区)') : t('等待卖家确认接单')}</div>`
    let body = ''
    if (isSeller && quote && !quoted) {
      body = `<div style="font-size:12px;color:#374151;margin-bottom:8px">${t('收货地区')} <strong>${escHtml(order.ship_to_region || '-')}</strong> ${t('不在你的运费模板内。请核实物流可达性后报价;买家确认新总额后订单才进入付款。')}</div>
        <div style="display:flex;gap:6px;margin-bottom:6px">
          <input class="form-control" id="dp-qt-fee-${oid}" type="number" min="0" step="0.01" placeholder="${t('运费(USDC)')}" style="flex:1;font-size:12px">
          <input class="form-control" id="dp-qt-est-${oid}" maxlength="20" placeholder="${t('预计时效,如 10-15')}" style="flex:1;font-size:12px">
        </div>
        <input class="form-control" id="dp-qt-note-${oid}" maxlength="200" placeholder="${t('备注(物流方式等,可选,买家可见)')}" style="margin-bottom:8px;font-size:12px">
        <div style="display:flex;gap:8px"><button class="btn btn-primary btn-sm" style="width:auto" onclick="dpQuoteSubmit('${oid}')">${t('提交报价')}</button>
        <button class="btn btn-outline btn-sm" style="width:auto;color:#dc2626;border-color:#fecaca" onclick="dpAcceptDecline('${oid}')">${t('无法配送,谢绝')}</button></div>`
    } else if (isSeller && quote && quoted) {
      body = `<div style="font-size:12px;color:#6b7280;margin-bottom:8px">📦 ${t('你已报价')}:${t('运费')} ${order.shipping_quote_fee} USDC${order.shipping_quote_est_days ? ` · ${escHtml(order.shipping_quote_est_days)} ${t('天')}` : ''}。${t('等待买家确认;确认前可重新报价修正。')}</div>
        <div style="display:flex;gap:6px;margin-bottom:6px"><input class="form-control" id="dp-qt-fee-${oid}" type="number" min="0" step="0.01" placeholder="${t('修正运费(USDC)')}" style="flex:1;font-size:12px"><input class="form-control" id="dp-qt-est-${oid}" maxlength="20" placeholder="${t('预计时效,如 10-15')}" style="flex:1;font-size:12px"></div>
        <div style="display:flex;gap:8px"><button class="btn btn-outline btn-sm" style="width:auto" onclick="dpQuoteSubmit('${oid}')">${t('重新报价')}</button>
        <button class="btn btn-outline btn-sm" style="width:auto;color:#dc2626;border-color:#fecaca" onclick="dpAcceptDecline('${oid}')">${t('无法配送,谢绝')}</button></div>`
    } else if (isSeller) {
      body = `<div style="font-size:12px;color:#374151;margin-bottom:8px">${t('买家已下单(尚未付款)。请核实库存与物流后确认接单;接单后买家才会看到收款方式。')}</div>
        <input class="form-control" id="dp-acc-reason-${oid}" maxlength="200" placeholder="${t('谢绝理由(选填,买家可见)')}" style="margin-bottom:8px;font-size:12px">
        <div style="display:flex;gap:8px"><button class="btn btn-primary btn-sm" style="width:auto" onclick="dpAcceptOk('${oid}')">${t('确认接单')}</button>
        <button class="btn btn-outline btn-sm" style="width:auto;color:#dc2626;border-color:#fecaca" onclick="dpAcceptDecline('${oid}')">${t('无法接单,谢绝')}</button></div>`
    } else if (isBuyer && quote && quoted) {
      const newTotal = Math.round((Number(order.total_amount) + Number(order.shipping_quote_fee)) * 100) / 100
      body = `<div style="font-size:12px;color:#374151;margin-bottom:8px">📦 ${t('卖家已报价')}:${t('运费')} <strong>${order.shipping_quote_fee} USDC</strong>${order.shipping_quote_est_days ? ` · ${t('预计时效')} ${escHtml(order.shipping_quote_est_days)} ${t('天')}` : ''}${order.shipping_quote_note ? `<br>💬 ${escHtml(order.shipping_quote_note)}` : ''}<br>${t('新总额')}:<strong>${newTotal} USDC</strong>(${t('货款')} ${order.total_amount} + ${t('运费')} ${order.shipping_quote_fee})</div>
        <div style="display:flex;gap:8px"><button class="btn btn-primary btn-sm" style="width:auto" onclick="dpQuoteConfirm('${oid}', ${newTotal})">${t('接受报价,进入付款')}</button>
        <button class="btn btn-outline btn-sm" style="width:auto" onclick="dpAcceptWithdraw('${oid}')">${t('不接受,撤单')}</button></div>`
    } else if (isBuyer) {
      body = `<div style="font-size:12px;color:#6b7280;margin-bottom:8px">⏳ ${quote ? t('等待卖家核实物流并报价运费;确认报价前你无需付款。') : t('等待卖家确认接单;接单后你才会看到收款方式并进入付款。')}</div>
        <button class="btn btn-outline btn-sm" style="width:auto" onclick="dpAcceptWithdraw('${oid}')">${t('撤回订单')}</button>`
    }
    return `<div class="card" style="border:1px solid #fde68a;background:linear-gradient(135deg,#fffbeb,#fef3c7)">${head}${body}${dl}</div>`
  }

  const rload = (oid) => renderOrderDetail(document.getElementById('app'), oid)
  window.dpAcceptOk = async (oid) => {
    const r = await POST(`/orders/${oid}/pending-accept/accept`, {})
    if (r.error) return void toast$(r.error, 'error')
    toast$(t('已接单,买家进入付款环节'), 'success'); rload(oid)
  }
  window.dpAcceptDecline = async (oid) => {
    if (typeof confirmModal === 'function' && !(await confirmModal(t('确认谢绝接单?订单将无责取消(买家尚未付款),库存自动恢复。'), t('谢绝接单'), { danger: true }))) return
    const el = document.getElementById('dp-acc-reason-' + oid)
    const r = await POST(`/orders/${oid}/pending-accept/decline`, { reason: (el && el.value || '').trim() })
    if (r.error) return void toast$(r.error, 'error')
    rload(oid)
  }
  window.dpAcceptWithdraw = async (oid) => {
    if (typeof confirmModal === 'function' && !(await confirmModal(t('确认撤回订单?订单将无责取消,你尚未付款,无需任何操作。'), t('撤回订单'), { danger: true }))) return
    const r = await POST(`/orders/${oid}/pending-accept/cancel`, {})
    if (r.error) return void toast$(r.error, 'error')
    rload(oid)
  }
  window.dpQuoteSubmit = async (oid) => {
    const fee = Number(document.getElementById('dp-qt-fee-' + oid)?.value)
    if (!isFinite(fee) || fee < 0) return void toast$(t('请填写合法运费'), 'error')
    const r = await POST(`/orders/${oid}/pending-accept/quote`, { shipping_fee: fee, est_days: (document.getElementById('dp-qt-est-' + oid)?.value || '').trim() || undefined, note: (document.getElementById('dp-qt-note-' + oid)?.value || '').trim() || undefined })
    if (r.error) return void toast$(r.error, 'error')
    toast$(t('已报价,等待买家确认'), 'success'); rload(oid)
  }
  window.dpQuoteConfirm = async (oid, newTotal) => {
    if (typeof confirmModal === 'function' && !(await confirmModal(S(t('确认接受报价?订单总额将变为 {total} USDC(含运费),随后进入付款环节。'), { total: newTotal }), t('接受报价'), {}))) return
    const r = await POST(`/orders/${oid}/pending-accept/confirm-quote`, {})
    if (r.error) return void toast$(r.error, 'error')
    toast$(t('已确认,进入付款环节'), 'success'); rload(oid)
  }

  // ⑤ 卖家店铺设置区块(settings tab 链尾;hydrate 回显)。模板编辑 = 行式文本:每行 "地区 运费 [时效]",* 为兜底。
  window.shipSellerSettingsSection = () => `
    <div class="card" id="ship-settings-card">
      <div style="font-size:14px;font-weight:700;margin-bottom:6px">🛎️ ${t('接单与运费(店铺默认)')}</div>
      <div style="font-size:11px;color:#6b7280;margin-bottom:8px">${t('单品可在接单/运费接口单独覆盖;设置只影响之后的新订单。')}</div>
      <div id="ship-settings-body" style="font-size:12px;color:#6b7280">${loading$()}</div>
    </div>`
  window.shipHydrateSellerSettings = async () => {
    const box = document.getElementById('ship-settings-body'); if (!box) return
    const s = await GET('/seller/shipping-settings').catch(() => null)
    if (!s) { box.textContent = t('加载失败,请刷新'); return }
    const tplText = (s.store_template || []).map(e => `${e.region} ${e.fee}${e.est_days ? ' ' + e.est_days : ''}`).join('\n')
    box.innerHTML = `
      <label class="form-label" style="font-size:12px">${t('接单模式')}</label>
      <select class="form-control" id="ship-set-mode" style="font-size:13px;margin-bottom:8px">
        <option value="" ${s.store_accept_mode == null ? 'selected' : ''}>${t('默认(自动接单)')}</option>
        <option value="auto" ${s.store_accept_mode === 'auto' ? 'selected' : ''}>${t('自动接单(下单/付款后直接进入下一环节)')}</option>
        <option value="manual" ${s.store_accept_mode === 'manual' ? 'selected' : ''}>${t('手动接单(直付:买家付款前须你确认;担保:维持付款后确认)')}</option>
      </select>
      <label class="form-label" style="font-size:12px">${t('运费模板(每行:地区代码 运费 [预计时效];* 为其余地区兜底)')}</label>
      <textarea class="form-control" id="ship-set-tpl" rows="4" placeholder="CN 0 2-4&#10;SG 5 3-5&#10;* 25 10-20" style="font-size:12px;font-family:monospace;margin-bottom:8px">${escHtml(tplText)}</textarea>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#374151;margin-bottom:10px">
        <input type="checkbox" id="ship-set-quote" style="width:16px;height:16px" ${s.store_quote_ok ? 'checked' : ''}>
        ${t('接受模板外地区询价(直付):先报运费/时效,买家确认后再付款')}
      </label>
      <button class="btn btn-primary btn-sm" style="width:auto" onclick="shipSaveSellerSettings()">${t('保存接单与运费设置')}</button>
      <div id="ship-set-msg" style="margin-top:6px;font-size:11px"></div>`
  }
  window.shipSaveSellerSettings = async () => {
    const msg = document.getElementById('ship-set-msg')
    const mode = document.getElementById('ship-set-mode').value || null
    const lines = (document.getElementById('ship-set-tpl').value || '').split('\n').map(l => l.trim()).filter(Boolean)
    const entries = []
    for (const l of lines) {
      const m = l.split(/\s+/)
      if (m.length < 2) { msg.innerHTML = `<span style="color:#dc2626">${t('格式错误')}: ${escHtml(l)}</span>`; return }
      entries.push({ region: m[0], fee: Number(m[1]), ...(m[2] ? { est_days: m[2] } : {}) })
    }
    const r1 = await POST('/seller/accept-mode', { store_accept_mode: mode })
    const r2 = await POST('/seller/shipping-template', { store_template: entries.length ? entries : null, store_quote_ok: !!document.getElementById('ship-set-quote').checked })
    if (r1.error || r2.error) { msg.innerHTML = `<span style="color:#dc2626">${r1.error || r2.error}</span>`; return }
    msg.innerHTML = `<span style="color:#16a34a">✓ ${t('已保存')}</span>`
  }
})()
