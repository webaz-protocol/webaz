// Product-image interactive UI helpers (pairs with app-product-media.js resolver + app-product-gallery.js).
//   productCardImg(p): inner HTML for a `.product-img` grid cell — real thumbnail via the shared
//     productThumbSrc resolver (same idiom as shop/discover feed cards, incl. onerror → 📦 degrade),
//     falling back to the category icon when the product has no resolvable image.
//   gallery swipe nav: touch left/right on the detail-gallery main image switches photos.
//     galleryStep uses wrap.dataset.galIdx (maintained by switchGalleryImage) and wraps around.
window.productCardImg = (p) => {
  const src = window.productThumbSrc(p && p.images)
  if (!src) return getCategoryIcon(p && p.category)
  // escAttr 必须:productThumbSrc 透传 https:/data:/相对 URL,而 P2P 商品的 images 存卖家可控 URI —— 不转义可从 src 逃逸(XSS)
  return `<img src="${escAttr(src)}" onerror="this.outerHTML='📦'" style="width:100%;height:100%;object-fit:cover" loading="lazy">`
}

let _galTouchX = null, _galTouchY = null
window.galleryTouchStart = (ev) => {
  const t = ev.touches && ev.touches[0]
  if (t) { _galTouchX = t.clientX; _galTouchY = t.clientY }
}
window.galleryTouchEnd = (pid, ev) => {
  if (_galTouchX == null) return
  const t = ev.changedTouches && ev.changedTouches[0]
  const dx = t ? t.clientX - _galTouchX : 0
  const dy = t ? t.clientY - _galTouchY : 0
  _galTouchX = _galTouchY = null
  // 垂直滚动/轻点不误触：位移要够大且以横向为主
  if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.2) return
  window.galleryStep(pid, dx < 0 ? 1 : -1)
}
window.galleryStep = (pid, d) => {
  const wrap = document.getElementById('pg-' + pid)
  const thumbs = wrap ? wrap.querySelectorAll('img[data-gal-idx]') : []
  if (thumbs.length < 2) return
  const cur = Number(wrap.dataset.galIdx || 0)
  window.switchGalleryImage(pid, (cur + d + thumbs.length) % thumbs.length)
}
