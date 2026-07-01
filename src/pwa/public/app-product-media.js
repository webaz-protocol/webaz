// Shared product-image resolver for cards / lists (paired with the public thumb endpoint).
//   productThumbSrc(images): a stored image ref → a loadable <img src>. A 64-hex content hash → the public
//     thumbnail endpoint /api/manifests/<hash>/thumb; an already-usable data:/http(s)/root-relative URL →
//     passthrough; anything else / empty → '' (no image). `images` may be a JSON-array string, a real array,
//     or a legacy CSV string. Card <img>s pair this with onerror="this.outerHTML='📦'" for the 404 (missing
//     thumbnail manifest) fallback, so a bad ref degrades to the icon instead of a broken image.
window.productThumbSrc = (images) => {
  let arr = images
  if (typeof images === 'string') { try { arr = JSON.parse(images) } catch { arr = images.split(',') } }
  const first = (Array.isArray(arr) ? arr : []).map(s => String(s).trim()).filter(Boolean)[0] || ''
  if (!first) return ''
  if (/^[0-9a-f]{64}$/i.test(first)) return '/api/manifests/' + first + '/thumb'
  if (/^(https?:|data:|\/)/i.test(first)) return first
  return ''
}
