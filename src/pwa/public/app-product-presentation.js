// Buyer-facing product identity and seller-ruling presentation.
// A product keeps one canonical seller title; each surface chooses an appropriate density.
(() => {
  const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  const tr = (value) => typeof window.t === 'function' ? window.t(value) : value
  const text = (value) => typeof value === 'string' ? value.trim() : ''
  const norm = (value) => text(value).toLocaleLowerCase()

  function specTokens(value) {
    let specs = value
    if (typeof specs === 'string') {
      try { specs = JSON.parse(specs) } catch { return [] }
    }
    if (Array.isArray(specs)) return specs.map(text).filter(Boolean)
    if (!specs || typeof specs !== 'object') return []
    return Object.entries(specs)
      .flatMap(([key, item]) => Array.isArray(item) ? item.map(v => `${key} ${String(v ?? '').trim()}`) : [`${key} ${String(item ?? '').trim()}`])
      .map(text).filter(Boolean)
  }

  function identityTokens(product, limit) {
    const title = norm(product?.title)
    const candidates = [text(product?.brand), text(product?.model), ...specTokens(product?.specs)]
    const seen = new Set()
    return candidates.filter((value) => {
      const key = norm(value)
      if (!key || seen.has(key) || title.includes(key)) return false
      seen.add(key)
      return true
    }).slice(0, limit)
  }

  window.productCardTitleHtml = (product) => {
    const title = text(product?.title) || tr('未命名商品')
    return `<span class="product-card-title-text" title="${esc(title)}">${esc(title)}</span>`
  }

  window.productCardMetaHtml = (product) => {
    const tokens = identityTokens(product, 2)
    return tokens.length ? `<div class="product-card-meta" aria-label="${esc(tr('商品信息'))}">${tokens.map(value => `<span>${esc(value)}</span>`).join('')}</div>` : ''
  }

  window.productDetailIdentityHtml = (product) => {
    const title = text(product?.title) || tr('未命名商品')
    const brand = text(product?.brand)
    const tokens = identityTokens(product, 5)
    const productType = { wholesale: '批发', service: '服务', digital: '数字' }[product?.product_type]
    return `<div class="buyer-product-identity">
      ${brand ? `<div class="buyer-product-brand">${esc(brand)}</div>` : ''}
      <h2 class="buyer-product-title">${esc(title)}</h2>
      ${(tokens.length || productType) ? `<div class="buyer-product-meta">${tokens.map(value => `<span>${esc(value)}</span>`).join('')}${productType ? `<span>${esc(tr(productType))}</span>` : ''}</div>` : ''}
    </div>`
  }

  window.sellerRulingsHtml = (metrics, sellerId) => {
    const wins = Math.max(0, Number(metrics?.dispute_won_count) || 0)
    const losses = Math.max(0, Number(metrics?.dispute_lost_count) || 0)
    const open = Math.max(0, Number(metrics?.open_dispute_count) || 0)
    const total = wins + losses
    const href = `#shop/${encodeURIComponent(String(sellerId || ''))}?tab=disputes`
    const parts = []
    if (total) {
      const winShare = Math.round((wins / total) * 100)
      const label = `${tr('卖家裁决')}：${tr('胜')} ${wins}，${tr('负')} ${losses}`
      parts.push(`<button type="button" class="seller-rulings-chip" style="--seller-win-share:${winShare}%" data-ruling-wins="${wins}" data-ruling-losses="${losses}" aria-label="${esc(label)}" title="${esc(label)}" onclick="navigate('${href}')"><span class="seller-rulings-label">⚖ ${esc(tr('裁决'))}</span><span class="seller-rulings-win">${esc(tr('胜'))} ${wins}</span><span class="seller-rulings-loss">${esc(tr('负'))} ${losses}</span></button>`)
    }
    if (open) parts.push(`<span class="seller-open-dispute-chip" title="${esc(tr('近 90 天仍在处理的争议'))}">⏳ ${esc(tr('处理中'))} ${open}</span>`)
    return parts.join('')
  }
})()
