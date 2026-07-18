// WebAZ — Shop Utilities / Storefront domain (classic multi-script split, slice I / app-shop.js)
//
// Loaded as a CLASSIC script in this order (index.html):
//   i18n → app-admin → app-contribution → app-ai → app-discover → app-profile → app-account → app-shop → app-listings → app-seller → app.js (source of truth: index.html)
// Top-level functions / window.* handlers are global; pages run on route/click
// (after app.js loads), so cross-file globals (GET/POST/PATCH/DELETE/state/shell/
// escHtml/navigate/t/toast$/skeleton$/productCardHtml/card/pageHeader/
// refreshAnnouncementsBadge/...) resolve at call time. No import/export.
//
// Pure relocation of low-risk storefront utilities: announcements, wishlist,
// waitlist, address book, my-coupons, push settings, daily check-in/task claim,
// for-you + product compare, public shop page + shop-edit, editor-picks (public +
// admin mgmt), and flash-sale (modal/submit/live).
//
// Flash-sale create/list only write pricing config (flash-sales.ts); the only
// order/wallet coupling lives server-side in orders-create.ts (at purchase time),
// not in these moved handlers — so they are storefront utilities, not the
// order/settlement/inventory state machine.
//
// INTENTIONALLY LEFT in app.js:
//   - group-buy (renderGroupBuysLive/renderGroupBuyDetail/openJoinGroupBuy/
//     submitJoinGroupBuy/leaveGroupBuy): join/leave touch escrow/order/refund
//     (group-buys.ts creates a paid order + wallet escrow on join, refunds on
//     leave) — a money/order/status path, NOT a plain shop utility. Defer to a
//     dedicated group-buy / money-path PR.
//   - cart/orders/order-detail/payment/wallet/dispute/return/status, auth boot/
//     login/register/recover, the seller workbench (renderSeller/renderEditProduct)
//     incl. renderSellerFlashSales, and the non-listed renderReviewsFeed/
//     renderAnchorEntry/lookupAnchorAction + refreshAnnouncementsBadge (core-nav
//     badge). No UI/behavior change.

async function renderAnnouncements(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'me')
  await refreshAnnouncementsBadge()
  const items = state.announcements || []
  const severityStyle = {
    info:     { bg:'#eef2ff', border:'#c7d2fe', color:'#3730a3', icon:'ℹ️' },
    warning:  { bg:'#fef3c7', border:'#fbbf24', color:'#92400e', icon:'⚠️' },
    critical: { bg:'#fef2f2', border:'#fecaca', color:'#991b1b', icon:'🚨' },
  }
  const html = items.length === 0
    ? `<div style="text-align:center;padding:40px;color:#9ca3af"><div style="font-size:42px;margin-bottom:8px">📢</div><div style="font-size:13px">${t('暂无公告')}</div></div>`
    : items.map(a => {
        const st = severityStyle[a.severity] || severityStyle.info
        return `
          <div class="card" style="padding:12px;margin-bottom:8px;background:${st.bg};border-color:${st.border}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
              <div style="flex:1;min-width:0">
                <div style="font-size:14px;font-weight:700;color:${st.color}">${st.icon} ${escHtml(a.title)}</div>
                <div style="font-size:12px;color:${st.color};opacity:0.85;margin-top:4px;white-space:pre-wrap;line-height:1.5">${escHtml(a.body)}</div>
                <div style="font-size:10px;color:${st.color};opacity:0.65;margin-top:4px">${fmtTime(a.created_at)}</div>
              </div>
              ${!a.is_read ? `<button class="btn btn-sm" style="background:rgba(255,255,255,0.6);color:${st.color};border:1px solid ${st.border};font-size:10px;padding:4px 8px;white-space:nowrap" onclick="markAnnouncementRead('${a.id}', this)">${t('知道了')}</button>` : `<span style="font-size:10px;color:${st.color};opacity:0.6;padding:4px 8px">✓ ${t('已读')}</span>`}
            </div>
          </div>`
      }).join('')
  app.innerHTML = shell(`
    <h1 class="page-title">📢 ${t('平台公告')}</h1>
    <div style="font-size:12px;color:#6b7280;margin-bottom:14px">${t('admin 发布的平台规则 / 活动 / 风险提醒')}</div>
    ${html}
  `, 'me')
}

window.markAnnouncementRead = async (id, btn) => {
  await POST(`/announcements/${id}/read`, {})
  if (btn) {
    btn.outerHTML = `<span style="font-size:10px;opacity:0.6;padding:4px 8px">✓ ${t('已读')}</span>`
  }
  if (state.announcementsUnread > 0) state.announcementsUnread--
  if (typeof updateAggregateChatsBadge === 'function') updateAggregateChatsBadge()
}

// Wave A-1 wishlist helpers
window.toggleWishlist = async (productId, btn) => {
  const inWl = btn.getAttribute('data-in-wl') === '1'
  btn.disabled = true
  const res = inWl
    ? await fetch('/api/wishlist/' + productId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + state.apiKey } }).then(r => r.json())
    : await POST(`/wishlist/${productId}`, {})
  btn.disabled = false
  if (res.error) { alert(res.error); return }
  if (inWl) {
    btn.setAttribute('data-in-wl', '0')
    btn.innerHTML = '❤ ' + t('加入心愿单')
    btn.style.color = ''; btn.style.borderColor = ''
  } else {
    btn.setAttribute('data-in-wl', '1')
    btn.innerHTML = '💗 ' + t('已在心愿单')
    btn.style.color = '#dc2626'; btn.style.borderColor = '#fecaca'
  }
}

async function renderWishlist(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'me')
  const r = await GET('/wishlist')
  const items = r?.items || []
  const rows = items.length === 0
    ? `<div style="text-align:center;padding:40px;color:#9ca3af"><div style="font-size:48px;margin-bottom:8px">❤</div><div style="font-size:13px">${t('心愿单为空 — 在商品页点 ❤ 加入')}</div></div>`
    : items.map(it => {
        const cur = Number(it.current_price), delta = Number(it.price_delta || 0), pct = Number(it.price_delta_pct || 0)
        const priceTag = delta < 0
          ? `<span style="color:#dc2626;font-weight:700">${window.fmtPrice(cur)} <span style="font-size:11px;background:#fef2f2;color:#991b1b;padding:1px 6px;border-radius:99px;font-weight:600;margin-left:4px">↓${Math.abs(pct).toFixed(0)}%</span></span>`
          : delta > 0
            ? `<span style="color:#374151;font-weight:600">${window.fmtPrice(cur)} <span style="font-size:11px;color:#9ca3af">(${t('已涨')} ${pct.toFixed(0)}%)</span></span>`
            : `<span style="color:#374151;font-weight:600">${window.fmtPrice(cur)}</span>`
        const stockTag = Number(it.stock) === 0
          ? `<span style="background:#f3f4f6;color:#6b7280;font-size:10px;padding:1px 6px;border-radius:4px">${t('缺货')}</span>`
          : ''
        const claimTag = Number(it.claim_loss_count) > 0
          ? `<span style="background:#fef2f2;color:#991b1b;font-size:10px;padding:1px 6px;border-radius:4px">⚠ ${it.claim_loss_count}</span>`
          : ''
        return `
          <div class="card" style="padding:10px 12px;margin-bottom:8px;display:flex;gap:10px;align-items:center;cursor:pointer" onclick="location.hash='#order-product/${it.product_id}'">
            <div style="font-size:32px">${getCategoryIcon(it.category) || '📦'}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(it.title)}</div>
              <div style="display:flex;gap:6px;align-items:center;margin-top:4px;font-size:12px">${priceTag} ${stockTag} ${claimTag}</div>
              ${it.note ? `<div style="font-size:11px;color:#9ca3af;margin-top:2px">📝 ${escHtml(it.note)}</div>` : ''}
              <div style="font-size:10px;color:#9ca3af;margin-top:2px">@${escHtml(it.seller_handle || '')} · ${t('收藏于')} ${fmtTime(it.created_at)}</div>
            </div>
            <button class="btn btn-sm" style="background:none;border:none;color:#dc2626;font-size:16px" onclick="event.stopPropagation(); removeFromWishlist('${it.product_id}', this)" title="${t('移除')}">×</button>
          </div>`
      }).join('')
  app.innerHTML = shell(`
    <h1 class="page-title">❤ ${t('我的心愿单')} <span style="font-size:13px;color:#9ca3af;font-weight:400">(${items.length})</span></h1>
    <div style="font-size:12px;color:#6b7280;margin-bottom:14px">${t('收藏感兴趣的商品 — 价格变动 / 重新有货时会通知你')}</div>
    ${rows}
  `, 'me')
}

window.removeFromWishlist = async (productId, btn) => {
  if (!confirm(t('从心愿单移除？'))) return
  const res = await fetch('/api/wishlist/' + productId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + state.apiKey } }).then(r => r.json())
  if (res.error) { alert(res.error); return }
  btn.closest('.card').remove()
}

// Wave B-2 waitlist helpers
window.toggleWaitlist = async (productId, btn) => {
  const inWait = btn.getAttribute('data-in-wait') === '1'
  btn.disabled = true
  const res = inWait
    ? await fetch('/api/products/' + productId + '/waitlist', { method: 'DELETE', headers: { Authorization: 'Bearer ' + state.apiKey } }).then(r => r.json())
    : await POST(`/products/${productId}/waitlist`, {})
  btn.disabled = false
  if (res.error) { alert(res.error); return }
  if (inWait) {
    btn.setAttribute('data-in-wait', '0')
    btn.innerHTML = '⏰ ' + t('到货通知我')
    btn.style.color = ''; btn.style.borderColor = ''
  } else {
    btn.setAttribute('data-in-wait', '1')
    btn.innerHTML = '⏰ ' + t('已加入补货提醒')
    btn.style.color = '#0369a1'; btn.style.borderColor = '#bae6fd'
  }
}

async function renderWaitlist(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'me')
  const r = await GET('/waitlist')
  const items = r?.items || []
  const rows = items.length === 0
    ? `<div style="text-align:center;padding:40px;color:#9ca3af"><div style="font-size:48px;margin-bottom:8px">⏰</div><div style="font-size:13px">${t('补货提醒列表为空 — 在缺货商品页点「到货通知我」加入')}</div></div>`
    : items.map(it => {
        const inStock = Number(it.stock) > 0
        const stockTag = inStock
          ? `<span style="background:#dcfce7;color:#15803d;font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600">${t('已到货')} · ${it.stock}</span>`
          : `<span style="background:#f3f4f6;color:#6b7280;font-size:10px;padding:1px 6px;border-radius:4px">${t('仍缺货')}</span>`
        const notifiedTag = it.notified_at
          ? `<span style="background:#dbeafe;color:#1e40af;font-size:10px;padding:1px 6px;border-radius:4px">✓ ${t('已通知')}</span>`
          : ''
        return `
          <div class="card" style="padding:10px 12px;margin-bottom:8px;display:flex;gap:10px;align-items:center;cursor:pointer" onclick="location.hash='#order-product/${it.product_id}'">
            <div style="font-size:32px">${getCategoryIcon(it.category) || '📦'}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(it.title)}</div>
              <div style="display:flex;gap:6px;align-items:center;margin-top:4px;font-size:12px">
                <span style="color:#374151;font-weight:600">${window.fmtPrice(it.price)}</span>
                ${stockTag}
                ${notifiedTag}
              </div>
              <div style="font-size:10px;color:#9ca3af;margin-top:2px">@${escHtml(it.seller_handle || '')} · ${t('加入于')} ${fmtTime(it.created_at)}</div>
            </div>
            <button class="btn btn-sm" style="background:none;border:none;color:#dc2626;font-size:16px" onclick="event.stopPropagation(); removeFromWaitlist('${it.product_id}', this)" title="${t('移除')}">×</button>
          </div>`
      }).join('')
  app.innerHTML = shell(`
    <h1 class="page-title">⏰ ${t('补货提醒')} <span style="font-size:13px;color:#9ca3af;font-weight:400">(${items.length})</span></h1>
    <div style="font-size:12px;color:#6b7280;margin-bottom:14px">${t('排队等缺货商品回归 — 卖家补货时第一时间通知你')}</div>
    ${rows}
  `, 'me')
}

window.removeFromWaitlist = async (productId, btn) => {
  if (!confirm(t('从补货提醒移除？'))) return
  const res = await fetch('/api/products/' + productId + '/waitlist', { method: 'DELETE', headers: { Authorization: 'Bearer ' + state.apiKey } }).then(r => r.json())
  if (res.error) { alert(res.error); return }
  btn.closest('.card').remove()
}

// Wave C-2: 收货地址簿
async function renderAddresses(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'me')
  const r = await GET('/addresses')
  const items = r?.items || []
  const rows = items.length === 0
    ? `<div style="text-align:center;padding:40px;color:#9ca3af"><div style="font-size:48px;margin-bottom:8px">📍</div><div style="font-size:13px">${t('地址簿为空 — 添加常用地址，下单更省事')}</div></div>`
    : items.map(it => `
        <div class="card" style="padding:12px;margin-bottom:8px${it.is_default ? ';border:1px solid #6366f1;background:#eef2ff' : ''}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div style="display:flex;gap:6px;align-items:center">
              <span style="font-size:13px;font-weight:600">${escHtml(it.label)}</span>
              ${it.is_default ? `<span style="font-size:10px;background:#6366f1;color:#fff;padding:1px 6px;border-radius:99px;font-weight:600">${t('默认')}</span>` : ''}
            </div>
            <div style="display:flex;gap:4px">
              ${!it.is_default ? `<button class="btn btn-outline btn-sm" style="font-size:10px;padding:3px 8px" onclick="setDefaultAddress('${it.id}')">${t('设为默认')}</button>` : ''}
              <button class="btn btn-outline btn-sm" style="font-size:10px;padding:3px 8px" onclick="openAddressModal('${it.id}')">${t('编辑')}</button>
              <button class="btn btn-sm" style="background:none;border:none;color:#dc2626;font-size:14px" onclick="deleteAddress('${it.id}')" title="${t('删除')}">×</button>
            </div>
          </div>
          <div style="font-size:13px;color:#374151">${escHtml(it.recipient)}${it.phone ? ` · ${escHtml(it.phone)}` : ''}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px">${it.region ? escHtml(it.region) + ' · ' : ''}${escHtml(it.detail)}</div>
        </div>`).join('')
  app.innerHTML = shell(`
    <h1 class="page-title">📍 ${t('收货地址簿')} <span style="font-size:13px;color:#9ca3af;font-weight:400">(${items.length}/20)</span></h1>
    <div style="font-size:12px;color:#6b7280;margin-bottom:14px">${t('保存常用地址，下单时一键选择')}</div>
    <button class="btn btn-primary btn-sm" style="margin-bottom:12px" onclick="openAddressModal()">+ ${t('添加地址')}</button>
    ${rows}
  `, 'me')
}

window.openAddressModal = async (id) => {
  let cur = { label: '', recipient: '', phone: '', region: 'SG', detail: '', is_default: false }
  if (id) {
    const r = await GET('/addresses')
    cur = (r?.items || []).find(x => x.id === id) || cur
  }
  const html = `
    <div class="js-modal" style="background:rgba(0,0,0,0.6);position:fixed;inset:0;z-index:1000;display:flex;align-items:flex-end;justify-content:center" onclick="this.remove()">
      <div style="background:#fff;width:100%;max-width:560px;border-radius:16px 16px 0 0;padding:20px;max-height:80vh;overflow-y:auto" onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h2 style="font-size:16px;font-weight:700;margin:0">📍 ${id ? t('编辑地址') : t('添加地址')}</h2>
          <button type="button" aria-label="${t('关闭')}" onclick="this.closest('.js-modal').remove()" style="background:none;border:none;font-size:22px;line-height:1;color:#9ca3af;cursor:pointer;padding:4px 8px">×</button>
        </div>
        <div class="form-group"><label class="form-label">${t('标签')} *</label><input class="form-control" id="adr-label" maxlength="30" value="${escHtml(cur.label)}" placeholder="${t('家 / 公司 / 父母家')}"></div>
        <div class="form-group"><label class="form-label">${t('收件人')} *</label><input class="form-control" id="adr-recipient" maxlength="60" value="${escHtml(cur.recipient)}"></div>
        <div class="form-group"><label class="form-label">${t('电话')}</label><input class="form-control" id="adr-phone" maxlength="30" value="${escHtml(cur.phone || '')}"></div>
        <div class="form-group"><label class="form-label">${t('国家/地区')}</label><input class="form-control" id="adr-region" maxlength="60" value="${escHtml(cur.region || 'SG')}" placeholder="${t('如：SG / CN / US')}"></div>
        <div class="form-group"><label class="form-label">${t('详细地址')} *</label><input class="form-control" id="adr-detail" maxlength="200" value="${escHtml(cur.detail)}" placeholder="${t('街道、楼栋、单元号、邮编')}"></div>
        ${!id ? `<label style="font-size:12px;color:#6b7280;display:flex;align-items:center;gap:4px;margin-bottom:8px"><input type="checkbox" id="adr-default" ${cur.is_default ? 'checked' : ''}> ${t('设为默认地址')}</label>` : ''}
        <div id="adr-msg" style="margin:8px 0"></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-gray" style="flex:1" onclick="this.closest('[style*=position]').remove()">${t('取消')}</button>
          <button class="btn btn-primary" style="flex:1" onclick="submitAddress('${id || ''}')">${t('保存')}</button>
        </div>
      </div>
    </div>
  `
  const div = document.createElement('div')
  div.innerHTML = html
  document.body.appendChild(div.firstElementChild)
}

window.submitAddress = async (id) => {
  const saveBtn = document.querySelector('.js-modal button.btn-primary')
  if (saveBtn?.disabled) return                                // 防双击 / 防 modal 残留时再次点击
  if (saveBtn) saveBtn.disabled = true
  const body = {
    label: document.getElementById('adr-label').value.trim(),
    recipient: document.getElementById('adr-recipient').value.trim(),
    phone: document.getElementById('adr-phone').value.trim(),
    region: document.getElementById('adr-region').value.trim(),
    detail: document.getElementById('adr-detail').value.trim(),
  }
  if (!body.label || !body.recipient || !body.detail) {
    document.getElementById('adr-msg').innerHTML = alert$('error', t('标签 / 收件人 / 详细地址必填'))
    if (saveBtn) saveBtn.disabled = false
    return
  }
  if (!id) body.is_default = document.getElementById('adr-default')?.checked || false
  const res = id
    ? await fetch('/api/addresses/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.apiKey }, body: JSON.stringify(body) }).then(r => r.json())
    : await POST('/addresses', body)
  if (res.error) {
    document.getElementById('adr-msg').innerHTML = alert$('error', res.error)
    if (saveBtn) saveBtn.disabled = false
    return
  }
  document.querySelector('.js-modal')?.remove()
  toast$(t('已保存'))
  // 不同上下文复用同一个 modal：根据当前路由决定刷新方式
  const h = location.hash || ''
  if (h.startsWith('#order-product/')) {
    // 下单页：仅刷新地址数据 + 重渲染本页（保持折叠态）
    try {
      const r = await GET('/addresses'); state._addresses = r?.items || []
      const pid = h.split('/')[1]; if (pid) renderBuyPage(document.getElementById('app'), pid)
    } catch {}
  } else if (h.startsWith('#cart')) {
    try { const r = await GET('/addresses'); state._addresses = r?.items || []; renderCart(document.getElementById('app')) } catch {}
  } else if (h.startsWith('#addresses') || !h) {
    renderAddresses(document.getElementById('app'))
  } else {
    // 其他页面（如 profile）— 仅刷新地址数据，避免改变用户当前位置
    try { const r = await GET('/addresses'); state._addresses = r?.items || [] } catch {}
  }
}

window.setDefaultAddress = async (id) => {
  const res = await fetch('/api/addresses/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.apiKey }, body: JSON.stringify({ is_default: true }) }).then(r => r.json())
  if (res.error) { alert(res.error); return }
  renderAddresses(document.getElementById('app'))
}

window.deleteAddress = async (id) => {
  if (!confirm(t('删除该地址？'))) return
  const res = await fetch('/api/addresses/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + state.apiKey } }).then(r => r.json())
  if (res.error) { alert(res.error); return }
  renderAddresses(document.getElementById('app'))
}

// Wave C-4: 我的优惠券
async function renderMyCoupons(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'me')
  const r = await GET('/coupons/available')
  const available = r?.available || []
  const history = r?.history || []
  const fmtDiscount = (c) => c.discount_type === 'percentage'
    ? `${(Number(c.discount_value) * 100).toFixed(0)}% OFF`
    : `-${c.discount_value} WAZ`
  const scopeLabel = (c) => c.scope === 'all'
    ? `🌐 ${t('全平台')}`
    : c.scope === 'shop'
      ? `🏪 @${escHtml(c.seller_handle || '')}`
      : `📦 ${escHtml(c.product_title || '')}`
  const expiry = (c) => c.expires_at
    ? `<span style="color:#d97706">${t('截止')} ${fmtTime(c.expires_at)}</span>`
    : `<span style="color:#16a34a">${t('长期有效')}</span>`
  const usesLeft = (c) => c.max_uses > 0
    ? `<span style="color:#6b7280">${t('剩')} ${Math.max(0, c.max_uses - c.uses_count)} / ${c.max_uses} ${t('次')}</span>`
    : `<span style="color:#6b7280">${t('无限')}</span>`
  const availRows = available.length === 0
    ? `<div style="text-align:center;padding:30px;color:#9ca3af"><div style="font-size:36px">🎟️</div><div style="font-size:13px;margin-top:6px">${t('暂无可用优惠券')}</div></div>`
    : available.map(c => `
        <div class="card" style="padding:12px;margin-bottom:8px;border-left:3px solid #6366f1">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div style="font-size:18px;font-weight:700;color:#4f46e5">${fmtDiscount(c)}</div>
            <button class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 10px" onclick="copyCouponCode('${escHtml(c.code).replace(/'/g,"&#39;")}')">📋 ${t('复制')}</button>
          </div>
          <div style="font-family:monospace;font-size:14px;font-weight:700;color:#374151;margin-top:4px">${escHtml(c.code)}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px">${scopeLabel(c)}</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:4px;display:flex;justify-content:space-between">
            <span>${expiry(c)} · ${usesLeft(c)}</span>
            ${Number(c.min_order_amount) > 0 ? `<span>${t('满')} ${c.min_order_amount} WAZ ${t('可用')}</span>` : ''}
          </div>
        </div>
      `).join('')
  const histRows = history.length === 0
    ? `<div style="text-align:center;padding:20px;color:#9ca3af;font-size:12px">${t('暂无使用记录')}</div>`
    : history.map(h => `
        <div class="card" style="padding:10px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;cursor:pointer" onclick="location.hash='#order/${h.order_id}'">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(h.product_title)}</div>
            <div style="font-size:11px;color:#9ca3af">${fmtTime(h.created_at)} · <span style="color:#16a34a">-${h.coupon_discount} WAZ</span></div>
          </div>
          <div style="font-family:monospace;font-size:11px;color:#6b7280">${escHtml(h.code)}</div>
        </div>
      `).join('')
  app.innerHTML = shell(`
    <h1 class="page-title">🎟️ ${t('我的优惠券')}</h1>
    <div style="font-size:12px;color:#6b7280;margin-bottom:14px">${t('点复制后在下单页粘贴优惠码即可使用')}</div>
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:8px 0 6px">${t('可用优惠')} (${available.length})</div>
    ${availRows}
    <div style="font-size:12px;color:#6b7280;font-weight:600;margin:14px 0 6px">${t('使用历史')} (${history.length})</div>
    ${histRows}
  `, 'me')
}

window.copyCouponCode = async (code) => {
  try { await navigator.clipboard.writeText(code); toast$(t('已复制') + ': ' + code) }
  catch { toast$(t('复制失败'), 'error') }
}

// Wave E-5: PWA Push 订阅设置
async function renderPushSettings(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'me')
  const supported = 'serviceWorker' in navigator && 'PushManager' in window
  const permission = supported ? Notification.permission : 'denied'
  const status = await GET('/push/status').catch(() => ({ subscribed: false, vapid_configured: false }))
  const reg = supported ? await navigator.serviceWorker.getRegistration().catch(() => null) : null
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null
  const localSubscribed = !!sub

  const supportNote = !supported
    ? `<div style="background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;padding:10px;border-radius:6px;font-size:12px">⚠ ${t('当前浏览器不支持推送通知')}</div>`
    : !status.vapid_configured
      ? `<div style="background:#fef3c7;border:1px solid #fcd34d;color:#92400e;padding:10px;border-radius:6px;font-size:12px">⚠ ${t('管理员尚未配置 VAPID 密钥，推送功能未启用')}</div>`
      : permission === 'denied'
        ? `<div style="background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;padding:10px;border-radius:6px;font-size:12px">⚠ ${t('浏览器已禁用通知 — 需在设置中手动启用')}</div>`
        : ''

  const canSubscribe = supported && status.vapid_configured && permission !== 'denied'

  const toggle = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:14px;background:#fff;border-radius:8px;border:1px solid #e5e7eb">
      <div>
        <div style="font-size:14px;font-weight:600">📲 ${t('启用推送通知')}</div>
        <div style="font-size:11px;color:#6b7280;margin-top:2px">${t('订单更新 / 评价回复 / 心愿单降价 等会在浏览器关闭时也能收到')}</div>
      </div>
      ${localSubscribed
        ? `<button class="btn btn-gray btn-sm" onclick="unsubscribePush()">${t('取消订阅')}</button>`
        : `<button class="btn btn-primary btn-sm" ${canSubscribe ? '' : 'disabled'} onclick="subscribePush()">${t('开启')}</button>`
      }
    </div>
  `

  app.innerHTML = shell(`
    <button class="btn btn-gray btn-sm" style="width:auto;margin-bottom:10px" onclick="history.back()">${t('← 返回')}</button>
    <h1 class="page-title">🔔 ${t('推送通知设置')}</h1>
    ${supportNote}
    <div style="margin-top:12px">${toggle}</div>
    <div style="margin-top:14px;padding:10px;background:#f9fafb;border-radius:6px;font-size:11px;color:#6b7280;line-height:1.6">
      <div><strong>${t('订阅状态')}</strong>: ${localSubscribed ? '✓ ' + t('已订阅') : t('未订阅')}</div>
      <div><strong>${t('浏览器权限')}</strong>: ${permission}</div>
      <div><strong>${t('当前订阅数')}</strong>: ${status.count || 0} ${t('个设备')}</div>
    </div>
  `, 'me')
}

// urlBase64ToUint8Array — VAPID 公钥编码转换
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - base64.length % 4) % 4)
  const base64Std = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64Std)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

window.subscribePush = async () => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert(t('当前浏览器不支持推送通知')); return
  }
  // 申请权限
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    alert(t('需要授权通知权限才能订阅')); return
  }
  // 拿 VAPID 公钥
  const vapidRes = await GET('/push/vapid-public-key')
  if (vapidRes.error) { alert(vapidRes.error); return }
  // 拿 SW registration + subscribe
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidRes.key),
  }).catch(e => { alert(t('订阅失败') + ': ' + e.message); return null })
  if (!sub) return
  // 发到服务端
  const json = sub.toJSON()
  const res = await POST('/push/subscribe', {
    endpoint: json.endpoint,
    keys: json.keys,
    user_agent: navigator.userAgent.slice(0, 200),
  })
  if (res.error) { alert(res.error); return }
  toast$(t('推送已开启'))
  renderPushSettings(document.getElementById('app'))
}

window.unsubscribePush = async () => {
  if (!confirm(t('确认取消推送订阅？'))) return
  const reg = await navigator.serviceWorker.getRegistration().catch(() => null)
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null
  if (sub) {
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.apiKey },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {})
    await sub.unsubscribe().catch(() => {})
  }
  toast$(t('已取消订阅'))
  renderPushSettings(document.getElementById('app'))
}

// Wave E-4: 签到 / 每日任务
const TASK_LABEL = () => ({
  first_order: t('首次完成订单'),
  five_orders: t('完成 5 单'),
  first_rating: t('首次提交评价'),
  follow_three: t('关注 3 个卖家'),
  first_review_received: t('收到首条评价'),
})

async function renderCheckin(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'me')
  // P0-1: 把客户端本地日期传给服务端，避免 UTC 错位
  const localDate = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()
  const r = await GET(`/checkin/status?local_date=${localDate}`)
  if (r.error) { app.innerHTML = shell(alert$('error', r.error), 'me'); return }
  const labels = TASK_LABEL()
  // 签到卡
  const streakDots = [...Array(7)].map((_, i) => {
    const day = i + 1
    const active = r.current_streak >= day || (r.today_checked_in && r.current_streak >= day)
    return `<div style="flex:1;text-align:center">
      <div style="width:24px;height:24px;border-radius:50%;background:${active ? '#fbbf24' : '#f3f4f6'};color:${active ? '#fff' : '#9ca3af'};font-size:11px;font-weight:600;line-height:24px;margin:0 auto">${day}</div>
      <div style="font-size:9px;color:#9ca3af;margin-top:2px">${day === 7 ? '+5' : '+0.5'}</div>
    </div>`
  }).join('')
  const checkinBtn = r.today_checked_in
    ? `<button class="btn btn-gray" disabled style="width:100%">✓ ${t('今日已签到')} (+${r.today_reward} WAZ)</button>`
    : `<button class="btn btn-primary" style="width:100%" onclick="doCheckin()">📅 ${t('签到')} (+${r.next_reward} WAZ)</button>`

  // 任务列表
  const taskCards = (r.tasks || []).map(task => {
    const pct = Math.min(100, (task.progress / task.goal) * 100)
    const claimed = !!task.claimed_at
    const canClaim = task.eligible && !claimed
    return `
      <div class="card" style="padding:10px 12px;margin-bottom:6px;${claimed ? 'opacity:0.6' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <div style="font-size:13px;font-weight:600">${labels[task.key] || task.key}</div>
          ${claimed
            ? `<span style="font-size:11px;color:#16a34a">✓ ${t('已领取')}</span>`
            : canClaim
              ? `<button class="btn btn-primary btn-sm" style="font-size:11px;padding:4px 10px" onclick="claimTask('${task.key}')">${t('领取')} +${task.reward} WAZ</button>`
              : `<span style="font-size:11px;color:#9ca3af">+${task.reward} WAZ</span>`
          }
        </div>
        <div style="height:4px;background:#f3f4f6;border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${pct >= 100 ? '#16a34a' : '#6366f1'};transition:width 0.3s"></div>
        </div>
        <div style="font-size:10px;color:#9ca3af;margin-top:2px">${task.progress} / ${task.goal}</div>
      </div>`
  }).join('')

  app.innerHTML = shell(`
    <h1 class="page-title">🎁 ${t('签到 / 任务')}</h1>
    <div class="card" style="background:linear-gradient(135deg,#fef3c7,#fde68a);padding:16px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-size:14px;font-weight:700;color:#92400e">${t('连续签到')} <span style="font-size:20px">${r.current_streak}</span> ${t('天')}</div>
        <div style="font-size:11px;color:#92400e">${t('每日 +0.5 WAZ · 7 天里程碑额外 +5')}</div>
      </div>
      <div style="display:flex;gap:4px;margin:10px 0">${streakDots}</div>
      ${checkinBtn}
    </div>

    <div style="font-size:13px;font-weight:600;margin:14px 0 8px">📋 ${t('成长任务')}</div>
    ${taskCards}
  `, 'me')
}

window.doCheckin = async () => {
  // P0-1: 客户端本地日期
  const d = new Date()
  const local_date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const res = await POST('/checkin', { local_date })
  if (res.error) { alert(res.error); return }
  const bonus = res.milestone_bonus > 0 ? ` (${t('里程碑')} +${res.milestone_bonus})` : ''
  toast$(`✨ ${t('签到成功')} +${res.reward} WAZ${bonus}`)
  renderCheckin(document.getElementById('app'))
}

window.claimTask = async (key) => {
  const res = await POST(`/tasks/${key}/claim`, {})
  if (res.error) { alert(res.error); return }
  toast$(`🎁 +${res.reward} WAZ`)
  renderCheckin(document.getElementById('app'))
}

// Wave E-3: 为你推荐
async function renderForYou(app) {
  if (!state.user) { renderLogin(); return }
  app.innerHTML = shell(loading$(), 'discover')
  const r = await GET('/recommendations/me')
  if (r.error) { app.innerHTML = shell(alert$('error', r.error), 'discover'); return }
  const items = r?.items || []
  const sig = r?.signals || {}
  const BUCKET_LABEL = () => ({
    followed: { icon: '👀', label: t('你关注的卖家'), color: '#6366f1' },
    category: { icon: '🎯', label: t('基于你的心愿单'), color: '#dc2626' },
    past_seller: { icon: '🔁', label: t('已购卖家其它商品'), color: '#16a34a' },
    trending: { icon: '🔥', label: t('热门兜底'), color: '#d97706' },
  })
  const labels = BUCKET_LABEL()
  // 按 bucket 分组
  const grouped = {}
  for (const it of items) {
    const b = it._bucket || 'trending'
    if (!grouped[b]) grouped[b] = []
    grouped[b].push(it)
  }
  const order = ['followed', 'category', 'past_seller', 'trending']
  const sections = order.filter(b => grouped[b]?.length > 0).map(b => {
    const meta = labels[b]
    const cards = grouped[b].map(p => {
      let imageUrl = ''
      imageUrl = window.productThumbSrc(p.images) || imageUrl
      return `
        <div class="card" style="padding:8px 10px;margin-bottom:6px;cursor:pointer" onclick="location.hash='#order-product/${p.id}'">
          <div style="display:flex;gap:10px;align-items:center">
            <div style="font-size:24px;flex-shrink:0">${imageUrl ? `<img src="${escHtml(imageUrl)}" onerror="this.outerHTML='📦'" style="width:42px;height:42px;border-radius:6px;object-fit:cover">` : getCategoryIcon(p.category) || '📦'}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.title)}</div>
              <div style="font-size:12px;color:#4f46e5;font-weight:600">${window.fmtPrice(p.price)} <span style="font-size:10px;color:#9ca3af;font-weight:400">· @${escHtml(p.seller_handle || '')}${p.sales_count > 0 ? ' · 🛒 ' + p.sales_count : ''}</span></div>
            </div>
          </div>
        </div>`
    }).join('')
    return `
      <div style="margin-bottom:14px">
        <div style="font-size:12px;color:${meta.color};font-weight:600;margin-bottom:6px">${meta.icon} ${meta.label} (${grouped[b].length})</div>
        ${cards}
      </div>
    `
  }).join('')
  const signalSummary = `<div style="font-size:11px;color:#9ca3af;margin-bottom:12px">📡 ${t('信号')}: ${t('心愿单类目')} ${sig.wishlist_categories?.length || 0} · ${t('关注卖家')} ${sig.followed_sellers || 0} · ${t('历史购买')} ${sig.past_purchases || 0}</div>`
  app.innerHTML = shell(`
    <h1 class="page-title">✨ ${t('为你推荐')}</h1>
    ${signalSummary}
    ${items.length === 0 ? emptyState('✨', t('暂无推荐 — 浏览商品后系统会学习你的喜好'), { label: t('去逛逛'), hash: '#discover' }) : sections}
  `, 'discover')
}

// Wave E-2: 商品对比 — buyer 选 2-4 件并排对比
function getCompareList() {
  try { return JSON.parse(localStorage.getItem('webaz_compare') || '[]') } catch { return [] }
}
function setCompareList(arr) {
  try { localStorage.setItem('webaz_compare', JSON.stringify(arr.slice(0, 4))) } catch {}
  refreshCompareBadge()
}
function refreshCompareBadge() {
  const list = getCompareList()
  const badge = document.getElementById('compare-fab')
  if (!badge) return
  if (list.length === 0) { badge.style.display = 'none'; return }
  badge.style.display = 'flex'
  badge.innerHTML = `📊 ${t('对比')} (${list.length})`
}

window.toggleCompare = (productId, btn) => {
  const list = getCompareList()
  const idx = list.indexOf(productId)
  if (idx >= 0) {
    list.splice(idx, 1)
    setCompareList(list)
    if (btn) { btn.innerHTML = '📊 ' + t('加入对比'); btn.dataset.added = '0'; btn.style.color = ''; btn.style.borderColor = '' }
  } else {
    if (list.length >= 4) { toast$(t('最多对比 4 件商品')); return }
    list.push(productId)
    setCompareList(list)
    if (btn) { btn.innerHTML = '✓ ' + t('已加入对比'); btn.dataset.added = '1'; btn.style.color = '#4f46e5'; btn.style.borderColor = '#c7d2fe' }
    toast$(t('已加入对比') + ` (${list.length}/4)`)
  }
}

window.openCompare = () => {
  const list = getCompareList()
  if (list.length === 0) { toast$(t('请先加入商品到对比')); return }
  if (list.length === 1) { toast$(t('至少 2 件商品才能对比')); return }
  navigate('#compare/' + list.join(','))
}

window.clearCompare = () => {
  setCompareList([])
  navigate('#discover')
}

async function renderCompare(app, ids) {
  const idList = (ids || '').split(',').filter(Boolean).slice(0, 4)
  if (idList.length < 2) { app.innerHTML = shell(`<div class="empty">${t('至少 2 件商品才能对比')}</div>`, 'discover'); return }
  app.innerHTML = shell(loading$(), 'discover')
  // 逐件直查详情端点,不扫 jitter+limit 的列表(openBuySheet 同根因);可见性口径=商品详情页(per-id)
  const items = (await Promise.all(idList.map(id => GET(`/products/${id}`).catch(() => null))))
    .filter(p => p && !p.error && p.id)
  if (items.length < 2) { app.innerHTML = shell(alert$('error', t('部分商品不存在或已下架')), 'discover'); return }
  const ratings = await Promise.all(items.map(p => GET(`/products/${p.id}/ratings?limit=1`).catch(() => ({ agg: null }))))
  const flashes = await Promise.all(items.map(p => GET(`/products/${p.id}/flash-sale`).catch(() => ({ sale: null }))))

  const rows = [
    { label: t('商品'), render: (p) => `<a href="#order-product/${p.id}" style="font-size:13px;font-weight:600;color:#374151;display:block;overflow:hidden;text-overflow:ellipsis">${escHtml(p.title)}</a>` },
    { label: t('价格'), render: (p, i) => {
        const sale = flashes[i]?.sale
        if (sale) return `<span style="color:#dc2626;font-weight:700">${window.fmtPrice(sale.sale_price)}</span><br><span style="font-size:10px;color:#9ca3af;text-decoration:line-through">${p.price} USDC</span>`
        return `<span style="color:#4f46e5;font-weight:700">${window.fmtPrice(p.price)}</span>`
      } },
    { label: t('库存'), render: (p) => `<span style="color:${Number(p.stock) === 0 ? '#dc2626' : Number(p.stock) <= 3 ? '#d97706' : '#374151'}">${p.stock}</span>` },
    { label: t('卖家'), render: (p) => `<a href="#shop/${p.seller_id}" style="font-size:11px;color:#6366f1">@${escHtml(p.seller_name || '')}</a>` },
    { label: t('评价'), render: (p, i) => {
        const agg = ratings[i]?.agg
        if (!agg || Number(agg.cnt) === 0) return `<span style="color:#9ca3af">—</span>`
        return `${Number(agg.avg_stars).toFixed(1)} ⭐<br><span style="font-size:10px;color:#9ca3af">(${agg.cnt})</span>`
      } },
    { label: t('类目'), render: (p) => `<span style="font-size:11px;color:#6b7280">${escHtml(p.category || '—')}</span>` },
    { label: t('退货天数'), render: (p) => Number(p.return_days || 0) > 0 ? `${p.return_days} ${t('天')}` : `<span style="color:#9ca3af">${t('不支持')}</span>` },
    { label: t('发货时效'), render: (p) => Number(p.handling_hours || 0) > 0 ? `${p.handling_hours}h` : '—' },
    { label: t('质保'), render: (p) => Number(p.warranty_days || 0) > 0 ? `${p.warranty_days} ${t('天')}` : '—' },
    { label: t('规格'), render: (p) => Number(p.has_variants) === 1 ? `✓ ${t('多规格')}` : `—` },
    { label: t('佣金'), render: (p) => Number(p.commission_rate) > 0 ? `${(Number(p.commission_rate) * 100).toFixed(0)}%` : '—' },
  ]

  const colCount = items.length
  const colWidth = `${Math.floor(100 / (colCount + 1))}%`
  const tableHtml = `
    <div style="overflow-x:auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb">
      <table style="width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed">
        <thead>
          <tr style="background:#f9fafb;border-bottom:1px solid #e5e7eb">
            <th style="padding:8px;text-align:left;width:${colWidth};font-weight:600;color:#6b7280">${t('属性')}</th>
            ${items.map(p => `<th style="padding:8px;text-align:left;width:${colWidth};border-left:1px solid #e5e7eb">
              <button onclick="removeFromCompare('${p.id}')" style="background:none;border:none;color:#9ca3af;font-size:14px;float:right;cursor:pointer" title="${t('移除')}">×</button>
            </th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr style="border-bottom:1px solid #f3f4f6">
              <td style="padding:8px;color:#6b7280;font-weight:600">${r.label}</td>
              ${items.map((p, i) => `<td style="padding:8px;border-left:1px solid #f3f4f6;word-wrap:break-word">${r.render(p, i)}</td>`).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `

  app.innerHTML = shell(`
    <button class="btn btn-gray btn-sm" style="width:auto;margin-bottom:10px" onclick="history.back()">${t('← 返回')}</button>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <h1 class="page-title" style="margin:0">📊 ${t('商品对比')}</h1>
      <div style="display:flex;gap:6px">
        <button class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 10px" onclick="shareCompareUrl('${idList.join(',')}')">🔗 ${t('分享对比')}</button>
        <button class="btn btn-outline btn-sm" style="font-size:11px;padding:4px 10px;color:#dc2626" onclick="clearCompare()">${t('清空')}</button>
      </div>
    </div>
    ${tableHtml}
  `, 'discover')
}

window.removeFromCompare = (productId) => {
  const list = getCompareList().filter(id => id !== productId)
  setCompareList(list)
  if (list.length < 2) { toast$(t('至少 2 件商品')); navigate('#discover'); return }
  navigate('#compare/' + list.join(','))
}

window.shareCompareUrl = async (ids) => {
  const url = `${location.origin}/#compare/${ids}`
  try { await navigator.clipboard.writeText(url); toast$(t('链接已复制')) }
  catch { toast$(t('复制失败'), 'error') }
}

async function renderShopPage(app, identifier) {
  if (!identifier) { navigate('#discover'); return }
  app.innerHTML = shell(loading$(), 'discover')
  const r = await GET(`/shops/${encodeURIComponent(identifier)}`)
  if (r.error) { app.innerHTML = shell(alert$('error', r.error), 'discover'); return }
  const { seller, stats, products, recent_ratings, is_following } = r
  const requestedTab = String(state._urlQuery?.tab || '')
  const shopTab = requestedTab === 'rulings' || requestedTab === 'disputes' ? 'rulings' : 'products'
  const isOwnShop = state.user?.id === seller.id
  const ratingDisplay = stats.rating_avg != null
    ? `⭐ ${Number(stats.rating_avg).toFixed(1)} <span style="font-size:11px;color:#64748b">(${stats.rating_count})</span>`
    : `<span style="font-size:11px;color:#9ca3af">${t('暂无评价')}</span>`
  const banner = seller.shop_banner_url
    ? `<div style="height:140px;background:url('${escHtml(seller.shop_banner_url)}') center/cover;border-radius:8px;margin-bottom:12px"></div>`
    : `<div style="height:80px;background:linear-gradient(135deg,#7c2d12,#9a3412);border-radius:8px;margin-bottom:12px"></div>`
  const followBtn = state.user && !isOwnShop && state.user.role === 'buyer'
    ? `<button class="btn btn-${is_following ? 'gray' : 'primary'} btn-sm" style="width:auto" id="shop-follow-btn" data-following="${is_following ? '1' : '0'}" onclick="toggleShopFollow('${seller.id}', this)">${is_following ? '✓ ' + t('已关注') : '+ ' + t('关注')}</button>`
    : ''
  const shopReferralBtn = state.user?.permanent_code
    ? `<button class="btn btn-outline btn-sm" style="width:auto;font-size:11px" title="${t('店铺推荐只锚定推荐关系;只有你真实成交过的同款商品,后续成交才可能形成商品推荐关系')}" onclick="copyShopReferralLink('${seller.id}')">🔗 ${t('推荐店铺')}</button>`
    : ''
  const productCards = products.length === 0
    ? `<div style="text-align:center;padding:30px;color:#9ca3af;font-size:13px">${t('该卖家暂无商品')}</div>`
    : products.map(p => {
        let imageUrl = ''
        imageUrl = window.productThumbSrc(p.images) || imageUrl
        return `
          <div class="card" style="padding:10px 12px;cursor:pointer" onclick="location.hash='#order-product/${p.id}'">
            <div style="display:flex;gap:10px;align-items:center">
              <div style="font-size:28px;flex-shrink:0">${imageUrl ? `<img src="${escHtml(imageUrl)}" onerror="this.outerHTML='📦'" style="width:42px;height:42px;border-radius:6px;object-fit:cover">` : getCategoryIcon(p.category) || '📦'}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.title)}</div>
                <div style="font-size:12px;color:#4f46e5;font-weight:600">${window.fmtPrice(p.price)} <span style="font-size:10px;color:#9ca3af;font-weight:400">· ${stockBadgeHtml(p)}${p.sales_count > 0 ? ' · 🛒 ' + p.sales_count : ''}</span></div>
              </div>
            </div>
          </div>`
      }).join('')
  const ratingItems = recent_ratings.length === 0
    ? ''
    : `<details style="margin-top:14px;background:#fff;border:1px solid #e5e7eb;border-radius:8px">
        <summary style="padding:10px 12px;font-size:13px;font-weight:600;cursor:pointer">⭐ ${t('最近评价')} (${recent_ratings.length})</summary>
        <div style="padding:0 12px 12px">
          ${recent_ratings.map(rr => `
            <div style="padding:8px 0;border-bottom:1px solid #f3f4f6">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px">
                <span style="font-size:13px">${'⭐'.repeat(Number(rr.stars))}${'☆'.repeat(5 - Number(rr.stars))}</span>
                <span style="font-size:11px;color:#9ca3af">${fmtTime(rr.created_at)}</span>
              </div>
              <div style="font-size:11px;color:#9ca3af;margin-bottom:2px">${escHtml(rr.product_title)} · @${escHtml(rr.buyer_handle || '')}</div>
              ${rr.comment ? `<div style="font-size:12px;color:#374151">${escHtml(rr.comment)}</div>` : ''}
            </div>`).join('')}
        </div>
      </details>`
  app.innerHTML = shell(`
    <button class="btn btn-gray btn-sm" style="width:auto;margin-bottom:10px" onclick="history.back()">${t('← 返回')}</button>
    ${banner}
    <div class="card" style="padding:14px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="font-size:18px;font-weight:700">${escHtml(seller.name || seller.handle)}</div>
          <div style="font-size:12px;color:#6b7280">@${escHtml(seller.handle || '')} · ${ratingDisplay}</div>
          <a href="#u/${seller.id}" style="font-size:12px;color:#4338ca;text-decoration:none;display:inline-block;margin-top:4px">${t('完整主页 · 笔记 / 测评 / 二手 / 拍卖')} →</a>
          ${seller.bio ? `<div style="font-size:13px;color:#374151;margin-top:6px">${escHtml(seller.bio)}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
          ${followBtn}
          ${shopReferralBtn}
          ${isOwnShop ? `<a href="#shop-edit" style="font-size:11px;color:#6366f1">${t('编辑店铺')} →</a>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:12px;margin-top:10px;padding-top:10px;border-top:1px solid #f3f4f6;font-size:11px;color:#6b7280">
        <span><strong style="color:#374151">${stats.products}</strong> ${t('商品')}</span>
        <span><strong style="color:#374151">${stats.followers}</strong> ${t('关注者')}</span>
        <span><strong style="color:#374151">${stats.completed_orders}</strong> ${t('已成交')}</span>
      </div>
    </div>
    ${seller.shop_intro ? `<div class="card" style="padding:12px;margin-bottom:12px;font-size:13px;color:#374151;white-space:pre-wrap">${escHtml(seller.shop_intro)}</div>` : ''}
    ${window.shopRulingsTabsHtml ? window.shopRulingsTabsHtml(seller, shopTab) : ''}
    ${shopTab === 'rulings' ? `<div id="shop-rulings-content">${loading$()}</div>` : `<div style="font-size:13px;font-weight:600;margin:14px 0 8px">📦 ${t('店内商品')}</div><div style="display:grid;gap:6px">${productCards}</div>${ratingItems}`}
  `, 'discover')
  if (shopTab === 'rulings') window.hydrateShopRulings?.(seller.id)
}

// 复制店铺推荐链接 — /?ref=CODE#shop/<seller>(target URL 形态:ref 在 query,目标页在 hash,服务端可见 ref)。
// 只用 permanent_code,绝不用 usr_xxx;诚实文案:不暗示"分享店铺即可获得全店佣金"。
window.copyShopReferralLink = (sellerId) => {
  const code = state.user?.permanent_code
  if (!code) return alert(t('邀请码暂不可用，请刷新或联系支持'))
  const link = `${location.origin}/?ref=${code}#shop/${sellerId}`
  copyText(link).then(ok => toast$(ok
    ? t('店铺推荐链接已复制 — 商品分润仍需你真实成交过同款并 opt-in')
    : t('复制失败，请手动复制'), ok ? 'success' : 'error'))
}

window.toggleShopFollow = async (sellerId, btn) => {
  const following = btn.dataset.following === '1'
  btn.disabled = true
  const res = following
    ? await fetch('/api/follows/' + sellerId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + state.apiKey } }).then(r => r.json())
    : await POST(`/follows/${sellerId}`, {})
  btn.disabled = false
  if (res.error) { alert(res.error); return }
  if (following) {
    btn.dataset.following = '0'; btn.className = 'btn btn-primary btn-sm'
    btn.innerHTML = '+ ' + t('关注'); btn.style.width = 'auto'
  } else {
    btn.dataset.following = '1'; btn.className = 'btn btn-gray btn-sm'
    btn.innerHTML = '✓ ' + t('已关注'); btn.style.width = 'auto'
  }
}

// 卖家编辑自己店铺
async function renderShopEdit(app) {
  if (!state.user || state.user.role !== 'seller') { app.innerHTML = shell(`<div class="empty">${t('仅卖家可访问')}</div>`, 'me'); return }
  app.innerHTML = shell(loading$(), 'me')
  const r = await GET(`/shops/@${state.user.handle}`)
  if (r.error) { app.innerHTML = shell(alert$('error', r.error), 'me'); return }
  const s = r.seller
  app.innerHTML = shell(`
    <button class="btn btn-gray btn-sm" style="width:auto;margin-bottom:10px" onclick="history.back()">${t('← 返回')}</button>
    <h1 class="page-title">🏪 ${t('编辑店铺')}</h1>
    <div class="card">
      <div class="form-group">
        <label class="form-label">${t('一句话简介')} <span style="font-size:10px;color:#9ca3af">(bio · ${t('最多 200 字')})</span></label>
        <input class="form-control" id="shop-bio" maxlength="200" value="${escHtml(s.bio || '')}" placeholder="${t('告诉买家你是谁，卖什么')}">
      </div>
      <div class="form-group">
        <label class="form-label">${t('店铺横幅图片 URL')} <span style="font-size:10px;color:#9ca3af">(${t('可选')})</span></label>
        <input class="form-control" id="shop-banner" maxlength="500" value="${escHtml(s.shop_banner_url || '')}" placeholder="https://...">
        <div style="font-size:10px;color:#9ca3af;margin-top:2px">${t('建议比例 16:9，宽度 ≥ 600px')}</div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('详细店铺介绍')} <span style="font-size:10px;color:#9ca3af">(${t('多段，最多 2000 字')})</span></label>
        <textarea class="form-control" id="shop-intro" maxlength="2000" rows="6" placeholder="${t('品牌故事 / 履约承诺 / 退换说明...')}">${escHtml(s.shop_intro || '')}</textarea>
      </div>
      <div id="shop-msg" style="margin:8px 0"></div>
      <button class="btn btn-primary" onclick="submitShopEdit()">${t('保存')}</button>
    </div>
    <div style="margin-top:10px;font-size:11px;color:#9ca3af;text-align:center">
      ${t('店铺主页公开链接')}: <a href="#shop/@${state.user.handle}" style="color:#6366f1">#shop/@${state.user.handle}</a>
    </div>
  `, 'me')
}

window.submitShopEdit = async () => {
  const bio = document.getElementById('shop-bio').value.trim()
  const shop_banner_url = document.getElementById('shop-banner').value.trim()
  const shop_intro = document.getElementById('shop-intro').value.trim()
  const msg = document.getElementById('shop-msg')
  msg.innerHTML = loading$()
  const res = await fetch('/api/shops/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.apiKey },
    body: JSON.stringify({ bio, shop_banner_url, shop_intro }),
  }).then(r => r.json())
  if (res.error) { msg.innerHTML = alert$('error', res.error); return }
  msg.innerHTML = alert$('success', t('已保存'))
  setTimeout(() => navigate(`#shop/@${state.user.handle}`), 800)
}

// B-4: 编辑精选 — 公开
async function renderEditorPicks(app) {
  app.innerHTML = shell(loading$(), 'discover')
  const r = await GET('/editor-picks')
  const products = r?.products || []
  const sellers = r?.sellers || []
  const productCards = products.map(p => {
    let imageUrl = ''
    imageUrl = window.productThumbSrc(p.images) || imageUrl
    return `
      <div class="card" style="padding:12px;margin-bottom:8px;cursor:pointer;border-left:3px solid #d97706" onclick="location.hash='#order-product/${p.target_id}'">
        ${p.title ? `<div style="font-size:11px;color:#d97706;font-weight:600;margin-bottom:4px">📌 ${escHtml(p.title)}</div>` : ''}
        <div style="display:flex;gap:10px;align-items:center">
          <div style="font-size:32px;flex-shrink:0">${imageUrl ? `<img src="${escHtml(imageUrl)}" onerror="this.outerHTML='📦'" style="width:48px;height:48px;border-radius:6px;object-fit:cover">` : getCategoryIcon(p.category) || '📦'}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.product_title)}</div>
            <div style="font-size:12px;color:#4f46e5;font-weight:600">${window.fmtPrice(p.price)} · @${escHtml(p.seller_handle || '')}</div>
          </div>
        </div>
        ${p.note ? `<div style="font-size:11px;color:#374151;margin-top:6px;padding:6px 8px;background:#fef3c7;border-radius:6px">${escHtml(p.note)}</div>` : ''}
      </div>`
  }).join('')
  const sellerCards = sellers.map(s => `
    <div class="card" style="padding:12px;margin-bottom:8px;cursor:pointer;border-left:3px solid #6366f1" onclick="location.hash='#shop/${s.target_id}'">
      ${s.title ? `<div style="font-size:11px;color:#6366f1;font-weight:600;margin-bottom:4px">⭐ ${escHtml(s.title)}</div>` : ''}
      <div style="font-size:13px;font-weight:600">@${escHtml(s.handle || '')}</div>
      ${s.bio ? `<div style="font-size:12px;color:#6b7280;margin-top:2px">${escHtml(s.bio)}</div>` : ''}
      ${s.note ? `<div style="font-size:11px;color:#374151;margin-top:6px;padding:6px 8px;background:#eef2ff;border-radius:6px">${escHtml(s.note)}</div>` : ''}
    </div>
  `).join('')

  app.innerHTML = shell(`
    <h1 class="page-title">📌 ${t('每周精选')}</h1>
    <div style="font-size:12px;color:#6b7280;margin-bottom:14px">${t('编辑团手挑 · 好物 / 优秀卖家')}</div>
    ${products.length === 0 && sellers.length === 0 ? `<div style="text-align:center;padding:40px;color:#9ca3af"><div style="font-size:48px">📌</div><div style="font-size:13px;margin-top:8px">${t('本期暂无精选')}</div></div>` : ''}
    ${products.length > 0 ? `<div style="font-size:13px;font-weight:600;margin:14px 0 8px">📦 ${t('精选商品')}</div>${productCards}` : ''}
    ${sellers.length > 0 ? `<div style="font-size:13px;font-weight:600;margin:14px 0 8px">🏪 ${t('精选卖家')}</div>${sellerCards}` : ''}
  `, 'discover')
}

// B-4: admin 管理精选
async function renderAdminEditorPicks(app) {
  if (!isAdmin()) { app.innerHTML = shell(`<div class="alert alert-info">${t('仅限管理员')}</div>`, 'admin'); return }
  app.innerHTML = shell(loading$(), 'admin')
  const r = await GET('/admin/editor-picks')
  const items = r?.items || []
  const rows = items.length === 0
    ? `<div style="color:#9ca3af;text-align:center;padding:30px">${t('暂无精选记录')}</div>`
    : items.map(it => {
        const active = new Date(it.starts_at) <= new Date() && new Date(it.ends_at) > new Date()
        return `
          <div class="card" style="padding:10px 12px;margin-bottom:6px;${active ? 'border-left:3px solid #16a34a' : ''}">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
              <div style="font-size:13px;font-weight:600">${it.kind === 'product' ? '📦' : '🏪'} ${escHtml(it.title || it.target_id)}</div>
              <button class="btn btn-sm" style="background:none;border:none;color:#dc2626;font-size:14px" onclick="deleteEditorPick('${it.id}')" title="${t('删除')}">×</button>
            </div>
            <div style="font-size:11px;color:#9ca3af">${it.kind} · ${it.target_id.slice(0, 12)}… · sort ${it.sort_order} · ${fmtTime(it.starts_at)} → ${fmtTime(it.ends_at)}</div>
            ${it.note ? `<div style="font-size:11px;color:#374151;margin-top:4px">${escHtml(it.note)}</div>` : ''}
          </div>`
      }).join('')
  app.innerHTML = shell(`
    <button class="btn btn-gray btn-sm" style="width:auto;margin-bottom:10px" onclick="history.back()">${t('← 返回')}</button>
    <h1 class="page-title">📌 ${t('编辑精选管理')}</h1>
    <button class="btn btn-primary btn-sm" style="margin-bottom:12px" onclick="openAddEditorPick()">+ ${t('添加精选')}</button>
    ${rows}
  `, 'admin')
}

window.openAddEditorPick = () => {
  const now = new Date()
  const defaultEnd = new Date(now.getTime() + 7 * 86400_000).toISOString().slice(0, 16)
  const defaultStart = now.toISOString().slice(0, 16)
  const html = `
    <div class="js-modal" style="background:rgba(0,0,0,0.6);position:fixed;inset:0;z-index:1000;display:flex;align-items:flex-end;justify-content:center" onclick="this.remove()">
      <div style="background:#fff;width:100%;max-width:560px;border-radius:16px 16px 0 0;padding:20px;max-height:80vh;overflow-y:auto" onclick="event.stopPropagation()">
        <h2 style="font-size:16px;font-weight:700;margin-bottom:12px">📌 ${t('添加精选')}</h2>
        <div class="form-group">
          <label class="form-label">${t('类型')} *</label>
          <select class="form-control" id="ep-kind">
            <option value="product">📦 ${t('商品')}</option>
            <option value="seller">🏪 ${t('卖家')}</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">${t('目标 ID')} *</label><input class="form-control" id="ep-target" placeholder="p_xxx 或 u_xxx"></div>
        <div class="form-group"><label class="form-label">${t('推荐语')}</label><input class="form-control" id="ep-title" maxlength="100"></div>
        <div class="form-group"><label class="form-label">${t('详细说明')}</label><textarea class="form-control" id="ep-note" rows="2" maxlength="500"></textarea></div>
        <div class="form-group"><label class="form-label">${t('开始时间')}</label><input class="form-control" id="ep-start" type="datetime-local" value="${defaultStart}"></div>
        <div class="form-group"><label class="form-label">${t('结束时间')}</label><input class="form-control" id="ep-end" type="datetime-local" value="${defaultEnd}"></div>
        <div class="form-group"><label class="form-label">${t('排序值')} <span style="font-size:10px;color:#9ca3af">${t('小的在前')}</span></label><input class="form-control" id="ep-sort" type="number" value="0"></div>
        <div id="ep-msg" style="margin:8px 0"></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-gray" style="flex:1" onclick="this.closest('[style*=position]').remove()">${t('取消')}</button>
          <button class="btn btn-primary" style="flex:1" onclick="submitEditorPick()">${t('保存')}</button>
        </div>
      </div>
    </div>
  `
  const div = document.createElement('div')
  div.innerHTML = html
  document.body.appendChild(div.firstElementChild)
}

window.submitEditorPick = async () => {
  const body = {
    kind: document.getElementById('ep-kind').value,
    target_id: document.getElementById('ep-target').value.trim(),
    title: document.getElementById('ep-title').value.trim(),
    note: document.getElementById('ep-note').value.trim(),
    starts_at: new Date(document.getElementById('ep-start').value).toISOString(),
    ends_at: new Date(document.getElementById('ep-end').value).toISOString(),
    sort_order: Number(document.getElementById('ep-sort').value) || 0,
  }
  if (!body.target_id) { document.getElementById('ep-msg').innerHTML = alert$('error', t('目标 ID 必填')); return }
  const res = await POST('/admin/editor-picks', body)
  if (res.error) { document.getElementById('ep-msg').innerHTML = alert$('error', res.error); return }
  document.querySelector('.js-modal')?.remove()
  toast$(t('已添加'))
  renderAdminEditorPicks(document.getElementById('app'))
}

window.deleteEditorPick = async (id) => {
  if (!confirm(t('删除该精选？'))) return
  const res = await fetch('/api/admin/editor-picks/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + state.apiKey } }).then(r => r.json())
  if (res.error) { alert(res.error); return }
  toast$(t('已删除'))
  renderAdminEditorPicks(document.getElementById('app'))
}


// Wave D-4: 限时促销 — 卖家创建 modal
window.openFlashSaleModal = (productId, basePrice) => {
  const now = new Date()
  const defaultStart = new Date(now.getTime() + 60000).toISOString().slice(0, 16)
  const defaultEnd = new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 16)
  const html = `
    <div class="js-modal" style="background:rgba(0,0,0,0.6);position:fixed;inset:0;z-index:1000;display:flex;align-items:flex-end;justify-content:center" onclick="this.remove()">
      <div style="background:#fff;width:100%;max-width:560px;border-radius:16px 16px 0 0;padding:20px;max-height:80vh;overflow-y:auto" onclick="event.stopPropagation()">
        <h2 style="font-size:16px;font-weight:700;margin-bottom:8px">⚡ ${t('创建限时促销')}</h2>
        <div style="font-size:12px;color:#6b7280;margin-bottom:12px">${t('原价')} ${basePrice} WAZ · ${t('单次促销最多 30 天')}</div>
        <div class="form-group">
          <label class="form-label">${t('促销价')} (WAZ) *</label>
          <input class="form-control" id="fls-price" type="number" min="0.01" step="0.01" max="${basePrice - 0.01}" placeholder="${t('必须低于原价')}">
        </div>
        <div class="form-group">
          <label class="form-label">${t('开始时间')} *</label>
          <input class="form-control" id="fls-start" type="datetime-local" value="${defaultStart}">
        </div>
        <div class="form-group">
          <label class="form-label">${t('结束时间')} *</label>
          <input class="form-control" id="fls-end" type="datetime-local" value="${defaultEnd}">
        </div>
        <div class="form-group">
          <label class="form-label">${t('数量限制')} <span style="font-size:10px;color:#9ca3af">(${t('可选 · 0 = 不限')})</span></label>
          <input class="form-control" id="fls-qty" type="number" min="0" value="0" placeholder="0">
        </div>
        <div id="fls-msg" style="margin:8px 0"></div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-gray" style="flex:1" onclick="this.closest('[style*=position]').remove()">${t('取消')}</button>
          <button class="btn btn-primary" style="flex:1" onclick="submitFlashSale('${productId}', ${basePrice})">${t('创建')}</button>
        </div>
      </div>
    </div>
  `
  const div = document.createElement('div')
  div.innerHTML = html
  document.body.appendChild(div.firstElementChild)
}

window.submitFlashSale = async (productId, basePrice) => {
  const sale_price = Number(document.getElementById('fls-price').value)
  const starts_at = document.getElementById('fls-start').value
  const ends_at = document.getElementById('fls-end').value
  const max_qty = Number(document.getElementById('fls-qty').value) || 0
  const msg = document.getElementById('fls-msg')
  if (!sale_price || sale_price <= 0 || sale_price >= basePrice) {
    msg.innerHTML = alert$('error', t('促销价必须低于原价')); return
  }
  if (!starts_at || !ends_at) { msg.innerHTML = alert$('error', t('请填写起止时间')); return }
  msg.innerHTML = loading$()
  const res = await POST(`/products/${productId}/flash-sale`, {
    sale_price, starts_at: new Date(starts_at).toISOString(), ends_at: new Date(ends_at).toISOString(), max_qty,
  })
  if (res.error) { msg.innerHTML = alert$('error', res.error); return }
  document.querySelector('.js-modal')?.remove()
  toast$(t('已创建'))
}

// buyer 视角：全平台正在进行的促销
async function renderFlashSalesLive(app) {
  app.innerHTML = shell(loading$(), 'discover')
  const r = await GET('/flash-sales/live')
  const items = r?.items || []
  const rows = items.length === 0
    ? `<div style="text-align:center;padding:40px;color:#9ca3af"><div style="font-size:48px">⚡</div><div style="font-size:13px;margin-top:8px">${t('暂无进行中的限时促销')}</div></div>`
    : items.map(it => {
        let imageUrl = ''
        imageUrl = window.productThumbSrc(it.images) || imageUrl
        const save = (Number(it.original_price) - Number(it.sale_price)).toFixed(2)
        const pct = ((1 - Number(it.sale_price) / Number(it.original_price)) * 100).toFixed(0)
        return `
          <div class="card" style="padding:10px 12px;margin-bottom:8px;cursor:pointer;border-left:3px solid #dc2626" onclick="location.hash='#order-product/${it.product_id}'">
            <div style="display:flex;gap:10px;align-items:center">
              <div style="font-size:32px;flex-shrink:0">${imageUrl ? `<img src="${escHtml(imageUrl)}" onerror="this.outerHTML='📦'" style="width:48px;height:48px;border-radius:6px;object-fit:cover">` : getCategoryIcon(it.category) || '📦'}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(it.title)}</div>
                <div style="font-size:12px;margin-top:2px">
                  <span style="color:#dc2626;font-weight:700">${window.fmtPrice(it.sale_price)}</span>
                  <span style="font-size:11px;color:#9ca3af;text-decoration:line-through;margin-left:4px">${it.original_price} USDC</span>
                  <span style="font-size:10px;color:#dc2626;background:#fee2e2;padding:1px 5px;border-radius:99px;margin-left:4px;font-weight:600">-${pct}%</span>
                </div>
                <div style="font-size:10px;color:#9ca3af;margin-top:2px">@${escHtml(it.seller_handle || '')} · ${t('截止')} ${fmtTime(it.ends_at)}${it.max_qty > 0 ? ' · ' + t('限') + ' ' + it.max_qty + ' / ' + t('已售') + ' ' + it.sold_count : ''}</div>
              </div>
            </div>
          </div>`
      }).join('')
  app.innerHTML = shell(`
    <h1 class="page-title">⚡ ${t('限时促销')} <span style="font-size:13px;color:#9ca3af;font-weight:400">(${items.length})</span></h1>
    <div style="font-size:12px;color:#6b7280;margin-bottom:14px">${t('限时降价 — 先到先得')}</div>
    ${rows}
  `, 'discover')
}
