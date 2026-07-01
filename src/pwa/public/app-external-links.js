// External source-platform links on the product detail page (renderBuyPage in app.js). UI ONLY.
//   Shows a "前往源平台查看详情" jump button. Verified links only; unverified links are hidden until verified.
//   SECURITY: only http/https URLs are ever made clickable (blocks javascript:/data:/relative); the target
//   domain is shown so the buyer sees where they go; links open with target=_blank rel="noopener noreferrer".
//   Data: GET /api/products/:id/external-links (buyer-facing; NOT owner-gated; returns { links } already
//   filtered to verified + non-revoked). Read-only; no writes.

// Return a URL object only for http/https, else null (blocks javascript:/data:/mailto:/relative).
window.safeExternalUrl = (u) => {
  try { const url = new URL(String(u)); return (url.protocol === 'http:' || url.protocol === 'https:') ? url : null } catch { return null }
}

// Placeholder + self-scheduled hydrate (mirrors productImageGallery's setTimeout pattern in app.js).
window.extLinksBarHtml = (productId) => {
  setTimeout(() => { if (window.hydrateExtLinks) window.hydrateExtLinks(productId) }, 0)
  return `<div id="ext-links-${productId}"></div>`
}

window.hydrateExtLinks = async (productId) => {
  const box = document.getElementById('ext-links-' + productId)
  if (!box) return
  // Buyer-facing endpoint returns { links } = VERIFIED + non-revoked only (server-enforced, public-safe subset).
  const r = await GET(`/products/${productId}/external-links`).catch(() => null)
  const links = (r && r.links) || []
  const rows = links.map(l => {
    const url = window.safeExternalUrl(l.url)
    if (!url) return ''                                  // non-http(s) → never render as a link
    const host = escHtml(url.hostname)
    return `<a href="${escHtml(url.href)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#2563eb;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:6px 10px;text-decoration:none">🔗 ${t('前往源平台查看详情')} · ${host}</a>`
  }).filter(Boolean)
  if (rows.length) box.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0">${rows.join('')}</div>`
}
