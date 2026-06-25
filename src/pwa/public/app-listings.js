// WebAZ — Listings (multi-seller follow-sell) read-only display (classic split, slice J / app-listings.js)
//
// Loaded as a CLASSIC script in this order (index.html):
//   … -> app-account.js -> app-shop.js -> app-listings.js -> app.js
// Top-level functions / window.* handlers are global; pages run on route/click
// (after app.js loads), so cross-file globals (GET/state/shell/escHtml/navigate/t/
// productCardHtml/LISTING_CATEGORY_NAMES/LISTING_TAG_DEFS/FULFILLMENT_LABELS/...) resolve
// at call time. No import/export.
//
// READ-ONLY display surfaces only — all GET /listings*: renderListingsHome,
// renderListingsMine, renderListingDetail, + LISTING_SORT_CHIPS/URGENCY_CHIPS
// (display-only chips) and setListingUrgency/setListingSort (re-render toggles).
//
// INTENTIONALLY LEFT in app.js (money/stake/order path — never moved here): listings
// create/follow + offer handlers LOCK or RELEASE wallet stake (listings.ts requires
// + locks stake on POST /listings; offers.ts releases stake) — renderListingCreate/
// submitListingCreate, renderListingFollow/submitFollowListing, refreshOfferFreshness
// (POST /offers/:id/refresh). They are reached cross-file via the onclick handlers
// that these read-only pages render. No UI/behavior change.

async function renderListingsHome(app) {
  app.innerHTML = `
    <div style="padding:14px;max-width:760px;margin:0 auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h2 style="font-size:18px;font-weight:700;margin:0">${t('多商家跟卖')}</h2>
        <button class="btn btn-primary btn-sm" onclick="location.hash='#listings/new'">+ ${t('创建商品身份')}</button>
      </div>
      <div style="margin-bottom:10px">
        <input id="lst-q" placeholder="${t('搜索：型号 / 关键词')}" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px">
      </div>
      <div id="lst-list">${loading$()}</div>
    </div>
  `
  const load = async () => {
    const q = document.getElementById('lst-q').value.trim()
    const list = document.getElementById('lst-list')
    list.innerHTML = loading$()
    const r = await GET('/listings' + (q ? '?q=' + encodeURIComponent(q) : ''))
    const items = r?.items || []
    if (!items.length) {
      list.innerHTML = `<div style="text-align:center;color:#9ca3af;padding:40px 0">${t('暂无商品身份，创建第一个')}</div>`
      return
    }
    list.innerHTML = items.map(it => `
      <div class="card" style="padding:12px;margin-bottom:10px;cursor:pointer" onclick="location.hash='#listings/${it.id}'">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:14px;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(it.title)}</div>
            <div style="font-size:11px;color:#6b7280">
              ${t(LISTING_CATEGORY_NAMES[it.category] || it.category)}
              ${it.external_id ? ' · ' + escHtml(it.external_id) : ''}
              · ${it.offer_count || 0} ${t('个卖家')}
            </div>
          </div>
          <div style="text-align:right">
            ${it.min_price != null ? `<div style="color:#dc2626;font-weight:700;font-size:15px">${Number(it.min_price).toFixed(2)} <span style="font-size:11px;color:#9ca3af">WAZ</span></div><div style="font-size:10px;color:#9ca3af">${t('起')}</div>` : `<div style="font-size:11px;color:#9ca3af">${t('暂无报价')}</div>`}
          </div>
        </div>
      </div>
    `).join('')
  }
  document.getElementById('lst-q').addEventListener('input', () => { clearTimeout(window._lstTimer); window._lstTimer = setTimeout(load, 300) })
  load()
}

// 我的跟卖 — 卖家查看自己在哪些 listings 已上架，含价格竞争位
async function renderListingsMine(app) {
  if (!state.user) { location.hash = '#login'; return }
  if (state.user.role !== 'seller') {
    app.innerHTML = shell(`<div style="padding:24px">${alert$('warn', t('仅卖家可查看我的跟卖'))}</div>`, 'me')
    return
  }
  app.innerHTML = shell(`
    <div style="padding:14px;max-width:760px;margin:0 auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h2 style="font-size:18px;font-weight:700;margin:0">📋 ${t('我的跟卖')}</h2>
        <button class="btn btn-outline btn-sm" onclick="location.hash='#listings'">${t('去找新款 →')}</button>
      </div>
      <div id="mine-list">${loading$()}</div>
    </div>
  `, 'me')
  const r = await GET('/listings/mine').catch(() => ({ items: [] }))
  const items = r?.items || []
  const list = document.getElementById('mine-list')
  if (!items.length) {
    list.innerHTML = `<div style="text-align:center;color:#9ca3af;padding:40px 16px;line-height:1.7">
      <div style="font-size:48px;margin-bottom:10px">🏬</div>
      <div>${t('还没有跟卖任何商品')}</div>
      <a href="#listings" style="display:inline-block;margin-top:14px;color:#4f46e5;font-size:13px">${t('去 listings 板块挑款 →')}</a>
    </div>`
    return
  }
  list.innerHTML = items.map(it => {
    const myMin = Number(it.my_min_price || 0)
    const globalMin = Number(it.global_min_price || 0)
    const isCheapest = myMin > 0 && globalMin > 0 && Math.abs(myMin - globalMin) < 0.001
    const diff = myMin > 0 && globalMin > 0 ? myMin - globalMin : 0
    const positionBadge = isCheapest
      ? `<span style="background:#dcfce7;color:#166534;font-size:10px;padding:2px 7px;border-radius:99px;font-weight:600">🏆 ${t('全网最低')}</span>`
      : (diff > 0 ? `<span style="background:#fef3c7;color:#92400e;font-size:10px;padding:2px 7px;border-radius:99px;font-weight:600">+${diff.toFixed(2)} ${t('高于最低')}</span>` : '')
    const creatorBadge = it.is_creator ? `<span style="background:#ede9fe;color:#5b21b6;font-size:10px;padding:2px 7px;border-radius:99px;font-weight:600;margin-left:4px">${t('我创建')}</span>` : ''
    return `
      <div class="card" style="padding:12px;margin-bottom:10px;cursor:pointer" onclick="location.hash='#listings/${it.id}'">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(it.title)}${creatorBadge}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:3px">
              ${t(LISTING_CATEGORY_NAMES[it.category] || it.category)}
              ${it.external_id ? ' · ' + escHtml(it.external_id) : ''}
              · ${t('全网')} ${it.total_offer_count} ${t('个卖家')}
            </div>
          </div>
          ${positionBadge}
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding-top:8px;border-top:1px solid #f3f4f6">
          <div style="font-size:11px;color:#6b7280">
            ${t('我的报价')} <strong style="color:#374151">${myMin.toFixed(2)} WAZ</strong>
            <span style="color:#9ca3af">· ${it.my_offer_count} ${t('个规格')}</span>
          </div>
          <div style="font-size:11px;color:#6b7280">
            ${t('全网最低')} <strong style="color:#dc2626">${globalMin.toFixed(2)} WAZ</strong>
          </div>
        </div>
      </div>
    `
  }).join('')
}

// P2: 排序 chip + urgency selector state（per listing detail view）
const LISTING_SORT_CHIPS = [
  { key: 'smart',     emoji: '✨', label: '综合' },
  { key: 'cheapest',  emoji: '💰', label: '最便宜' },
  { key: 'fastest',   emoji: '⚡', label: '最快' },
  { key: 'trusted',   emoji: '🛡', label: '最可靠' },
  { key: 'nearest',   emoji: '📍', label: '最近' },
  { key: 'clearance', emoji: '🔥', label: '清仓' },
]
const URGENCY_CHIPS = [
  { key: 'now',   emoji: '⚡', label: '急要' },
  { key: 'today', emoji: '📅', label: '今天' },
  { key: 'flex',  emoji: '🌊', label: '宽松' },
]

async function renderListingDetail(app, id) {
  // 读取状态（带默认）
  const urgency = state._listingUrgency || 'flex'
  const sort = state._listingSort || 'smart'

  app.innerHTML = `<div style="padding:14px;max-width:760px;margin:0 auto" id="lst-detail">${loading$()}</div>`
  const qs = new URLSearchParams({ urgency, sort })
  if (state.user?.region) qs.set('buyer_region', state.user.region)
  const r = await GET('/listings/' + encodeURIComponent(id) + '?' + qs.toString())
  if (r?.error) { document.getElementById('lst-detail').innerHTML = alert$('error', r.error); return }
  const l = r.listing
  const offers = r.offers || []
  const isSeller = state.user?.role === 'seller'
  const myId = state.user?.id

  const chipBtn = (chip, active, isUrgency) => `
    <button onclick="${isUrgency ? `setListingUrgency('${chip.key}','${id}')` : `setListingSort('${chip.key}','${id}')`}"
      style="display:inline-flex;align-items:center;gap:3px;padding:5px 10px;border-radius:99px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid ${active?'#4f46e5':'#e5e7eb'};background:${active?'#eef2ff':'#fff'};color:${active?'#4338ca':'#6b7280'};white-space:nowrap">
      ${chip.emoji} ${t(chip.label)}
    </button>`

  document.getElementById('lst-detail').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
      <div style="flex:1">
        <div style="font-size:11px;color:#9ca3af;margin-bottom:2px">${t(LISTING_CATEGORY_NAMES[l.category] || l.category)}${l.external_id ? ' · ' + escHtml(l.external_id) : ''}</div>
        <h2 style="font-size:18px;font-weight:700;margin:0 0 4px">${escHtml(l.title)}</h2>
        ${l.description ? `<div style="font-size:12px;color:#6b7280;margin-top:6px;white-space:pre-wrap">${escHtml(l.description)}</div>` : ''}
      </div>
      <button class="btn btn-sm" onclick="location.hash='#listings'" style="background:#f3f4f6">←</button>
    </div>

    <div style="margin:10px 0">
      <div style="font-size:11px;color:#6b7280;margin-bottom:4px">${t('紧急程度')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
        ${URGENCY_CHIPS.map(c => chipBtn(c, urgency === c.key, true)).join('')}
      </div>
      <div style="font-size:11px;color:#6b7280;margin-bottom:4px">${t('排序')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;overflow-x:auto">
        ${LISTING_SORT_CHIPS.map(c => chipBtn(c, sort === c.key, false)).join('')}
      </div>
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0 10px">
      <div style="font-size:13px;font-weight:600">${offers.length} ${t('个卖家在卖')}</div>
      <div style="display:flex;gap:6px">
        ${state.user && state.user.id !== l.created_by ? `<button class="btn btn-sm" style="background:#eef2ff;color:#4338ca;font-size:11px;padding:5px 12px" onclick="openChatForContext('listing_qa','${l.id}','${l.created_by}')">💬 ${t('问商家')}</button>` : ''}
        ${isSeller ? `<button class="btn btn-primary btn-sm" onclick="location.hash='#listings/${l.id}/follow'">+ ${t('我也卖（跟卖）')}</button>` : ''}
      </div>
    </div>

    ${offers.length === 0 ? `<div style="text-align:center;color:#9ca3af;padding:30px 0">${t('暂无卖家')}</div>` : offers.map(o => {
      const isMine = myId && o.seller_id === myId
      const isStale = (o.tags || []).includes('stale')
      const isColdStart = Number(o.cold_start_remaining || 0) > 0
      return `
      <div class="card" style="padding:12px;margin-bottom:8px${isStale ? ';border-left:3px solid #f59e0b' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
          <div style="flex:1;min-width:0">
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
              ${(o.tags || []).filter(tg => tg !== 'stale').map(tg => {
                const def = LISTING_TAG_DEFS[tg]
                return def ? `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;background:${def.color}1a;color:${def.color};padding:2px 8px;border-radius:99px;font-weight:600">${def.emoji} ${t(def.label)}</span>` : ''
              }).join('')}
              ${isStale ? `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:99px;font-weight:600">⚠ ${t('备货')}</span>` : ''}
              ${isColdStart ? `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;background:#e0e7ff;color:#3730a3;padding:2px 8px;border-radius:99px;font-weight:600">❄ ${t('新卖家')}</span>` : ''}
            </div>
            <div style="font-size:12px;color:#374151;margin-bottom:3px">@${escHtml(o.seller_handle || o.seller_id.slice(0,8))} · ${o.seller_region ? regionLabel(o.seller_region) : '-'} · ${o.seller_sales || 0} ${t('单成交')}</div>
            <div style="font-size:11px;color:#6b7280">${t(FULFILLMENT_LABELS[o.fulfillment_type] || o.fulfillment_type)}${o.eta_hours != null ? ' · ETA ' + o.eta_hours + 'h' : ''}</div>
            ${isMine ? `<div style="margin-top:6px"><button class="btn btn-outline btn-sm" style="padding:3px 8px;font-size:10px;color:#4f46e5;border-color:#c7d2fe" onclick="refreshOfferFreshness('${o.id}','${id}')">🔄 ${t('现货确认')}</button></div>` : ''}
          </div>
          <div style="text-align:right">
            <div style="color:#dc2626;font-weight:700;font-size:16px">${Number(o.price).toFixed(2)} <span style="font-size:11px;color:#9ca3af">WAZ</span></div>
            <div style="font-size:10px;color:#9ca3af">${t('库存')} ${o.stock}</div>
            ${state.user?.role === 'buyer' && o.stock > 0 ? `<button class="btn btn-primary btn-sm" style="margin-top:6px;padding:4px 12px;font-size:11px" onclick="location.hash='#order-product/${o.id}'">${t('购买')}</button>` : ''}
          </div>
        </div>
      </div>`
    }).join('')}
  `
}

window.setListingUrgency = (key, id) => { state._listingUrgency = key; renderListingDetail(document.getElementById('app'), id) }
window.setListingSort    = (key, id) => { state._listingSort = key;    renderListingDetail(document.getElementById('app'), id) }
