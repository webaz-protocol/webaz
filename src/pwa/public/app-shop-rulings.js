// Public seller-ruling presentation. This is deliberately separate from live disputes.
(() => {
  const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  const tr = (value) => typeof window.t === 'function' ? window.t(value) : value
  const sellerHref = (sellerId, tab = '') => `#shop/${encodeURIComponent(String(sellerId || ''))}${tab ? `?tab=${tab}` : ''}`
  const outcome = (winner) => winner === 'seller' ? tr('卖家胜') : winner === 'buyer' ? tr('买家胜') : tr('部分责任')
  const outcomeClass = (winner) => winner === 'seller' ? 'shop-ruling-row--win' : winner === 'buyer' ? 'shop-ruling-row--loss' : 'shop-ruling-row--split'

  function summaryChip(summary, sellerId) {
    const wins = Math.max(0, Number(summary?.seller_wins) || 0)
    const losses = Math.max(0, Number(summary?.seller_losses) || 0)
    const split = Math.max(0, Number(summary?.split) || 0)
    const decisive = wins + losses
    if (!Number(summary?.total) || !decisive) return split ? `<span class="seller-ruling-split-chip">${esc(tr('部分责任'))} ${split}</span>` : ''
    const winShare = Math.round((wins / decisive) * 100)
    const label = `${tr('公开裁决')}：${tr('卖家胜')} ${wins}，${tr('买家胜')} ${losses}${split ? `，${tr('部分责任')} ${split}` : ''}`
    return `<button type="button" class="seller-rulings-chip${split ? ' seller-rulings-chip--split' : ''}" style="--seller-win-share:${winShare}%" aria-label="${esc(label)}" title="${esc(label)}" onclick="navigate('${sellerHref(sellerId, 'rulings')}')"><span class="seller-rulings-label">⚖ ${esc(tr('裁决'))}</span><span class="seller-rulings-win">${esc(tr('胜'))} ${wins}</span><span class="seller-rulings-loss">${esc(tr('负'))} ${losses}</span>${split ? `<span class="seller-rulings-split">${esc(tr('部分责任'))} ${split}</span>` : ''}</button>`
  }

  function summaryHtml(summary) {
    const total = Math.max(0, Number(summary?.total) || 0)
    if (!total) return ''
    return `<div class="shop-ruling-summary" aria-label="${esc(tr('公开裁决汇总'))}">
      <span class="shop-ruling-stat shop-ruling-stat--win">${esc(tr('卖家胜'))} ${Number(summary.seller_wins) || 0}</span>
      <span class="shop-ruling-stat shop-ruling-stat--loss">${esc(tr('买家胜'))} ${Number(summary.seller_losses) || 0}</span>
      ${Number(summary.split) ? `<span class="shop-ruling-stat shop-ruling-stat--split">${esc(tr('部分责任'))} ${Number(summary.split)}</span>` : ''}
    </div>`
  }

  window.shopRulingsTabsHtml = (seller, activeTab) => `<nav class="shop-section-tabs" aria-label="${esc(tr('店铺内容'))}">
    <button class="shop-section-tab" ${activeTab === 'products' ? 'aria-current="page"' : ''} onclick="navigate('${sellerHref(seller.id)}')">${esc(tr('商品'))}</button>
    <button class="shop-section-tab" ${activeTab === 'rulings' ? 'aria-current="page"' : ''} onclick="navigate('${sellerHref(seller.id, 'rulings')}')">⚖ ${esc(tr('公开裁决'))}</button>
  </nav>`

  window.hydrateShopRulings = async (sellerId) => {
    const root = document.getElementById('shop-rulings-content')
    if (!root) return
    const r = await GET(`/disputes/cases?seller_id=${encodeURIComponent(String(sellerId || ''))}&limit=50`).catch(() => null)
    if (!r || r.error) { root.innerHTML = `<div class="shop-rulings-empty">${esc(tr('公开裁决暂时无法加载'))}</div>`; return }
    const items = Array.isArray(r.items) ? r.items : []
    if (!items.length) { root.innerHTML = `<div class="shop-rulings-empty">⚖ ${esc(tr('该卖家暂无公开裁决'))}</div>`; return }
    root.innerHTML = `${summaryHtml(r.summary)}<div class="shop-ruling-note">${esc(tr('仅展示已公开、已脱敏的终局裁决'))}</div><div class="shop-ruling-list">${items.map(item => `
      <article class="shop-ruling-row ${outcomeClass(item.winner)}">
        <div class="shop-ruling-row-main"><strong>${esc(outcome(item.winner))}</strong><span>${esc(item.product_title || tr('商品'))} · ${esc(item.resolution || '—')}</span></div>
        <time>${typeof fmtTime === 'function' ? esc(fmtTime(item.published_at)) : esc(item.published_at || '')}</time>
      </article>`).join('')}</div>`
  }

  window.publicSellerRulingsHtml = (sellerId) => {
    const id = `seller-public-rulings-${String(sellerId || '').replace(/[^a-zA-Z0-9_-]/g, '')}`
    setTimeout(async () => {
      const slot = document.getElementById(id)
      if (!slot) return
      const r = await GET(`/disputes/cases?seller_id=${encodeURIComponent(String(sellerId || ''))}&limit=5`).catch(() => null)
      if (slot && r?.summary) slot.innerHTML = summaryChip(r.summary, sellerId)
    }, 0)
    return `<span id="${esc(id)}" class="seller-public-rulings" aria-live="polite"></span>`
  }
})()
