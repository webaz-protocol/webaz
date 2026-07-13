// Detail-gallery image helpers (paired with app-product-media.js productThumbSrc + the public thumb endpoint).
//   resolveGalleryUrls(hashes, byHash): per-hash display URL — own IDB blob (object URL) → this product's
//     manifest thumbnail (by-product lookup) → shared by-hash /thumb fallback. The fallback exists because
//     manifest.related_product_id only points at the product that FIRST registered the hash, so a listing
//     reusing an image registered under another product misses the by-product lookup although the public
//     /api/manifests/:hash/thumb endpoint serves it (cards already resolve this way via productThumbSrc).
//     null → gallery shows the unavailable notice; a /thumb 404 (truly unregistered hash) degrades via
//     the main <img> onerror → galleryMainImgFail.
window.resolveGalleryUrls = async (hashes, byHash) => {
  const urls = []
  for (const h of hashes) {
    let url = null
    try {
      const row = await p2pGetContent(h)
      if (row?.blob) url = URL.createObjectURL(row.blob)
    } catch {}
    if (!url) url = byHash[h]?.thumbnail_data_uri || null
    if (!url) url = window.productThumbSrc([h]) || null
    urls.push(url)
  }
  return urls
}

// 主图加载失败（如 /thumb 404：hash 从未注册 manifest）→ 降级为不可达提示，与 hydrate 的无图分支同文案
window.galleryMainImgFail = (pid) => {
  const main = document.getElementById('pg-' + pid + '-main')
  const loading = document.getElementById('pg-' + pid + '-loading')
  if (main) main.style.display = 'none'
  if (loading) { loading.style.display = ''; loading.textContent = '🌐 ' + t('图片暂不可达（卖家节点离线）') }
}
