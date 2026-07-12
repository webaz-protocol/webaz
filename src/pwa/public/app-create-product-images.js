// 新建商品页图片缩略图修复。app.js 的 onAddProductImages 用 compressImageToDataURL 生成缩略图,PNG 输入→PNG 输出;
// 照片存 PNG 时缩略图超 9KB manifest 硬限、注册失败(只有 JPEG 能过 → 用户报"只有个别成功")。app.js 已到 LOC
// 天花板冻结(禁回塞),故独立成文件、运行时覆写 window.onAddProductImages:缩略图【强制 JPEG】+ 逐级压到 ≤9KB。
// index.html 中 app.js 之后加载,依赖全局 state/compressImageToBlob/sha256Hex/toast$/t/renderAddProductImageGrid。
// 注:与 app-edit-product-images.js 的缩略图逻辑刻意重复(编辑页文件已到天花板冻结、且已部署,不为去重去动它)。
;(function () {
  if (typeof window.onAddProductImages !== 'function') return
  window.onAddProductImages = async function (e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    const remaining = 9 - state._addProductImgs.length
    if (remaining <= 0) { toast$(t('最多 9 张图片'), 'error'); return }
    for (const f of files.slice(0, remaining)) {
      if (!f.type.startsWith('image/')) continue
      if (f.size > 12 * 1024 * 1024) { toast$(f.name + ': ' + t('文件过大（>12MB）'), 'error'); continue }
      try {
        const mime = f.type === 'image/png' ? 'image/png' : 'image/jpeg'
        const fullBlob = await compressImageToBlob(f, 800, 0.82, mime)
        const _jt = (px, q) => compressImageToBlob(f, px, q, 'image/jpeg').then(function (b) { return new Promise(function (r) { const R = new FileReader(); R.onload = function () { r(R.result) }; R.readAsDataURL(b) }) })
        let thumb = await _jt(200, 0.7); for (const c of [[160, 0.5], [120, 0.42], [96, 0.38], [72, 0.34]]) { if (thumb.length <= 11800) break; thumb = await _jt(c[0], c[1]) }  // 缩略图强制 JPEG + 逐级压到 ≤9KB(PNG 照片缩略图会超 manifest 硬限)
        const hash = await sha256Hex(fullBlob)
        const blobUrl = URL.createObjectURL(fullBlob)
        state._addProductImgs.push({ blob: fullBlob, hash: hash, thumb: thumb, contentType: mime, blobUrl: blobUrl })
      } catch (e2) { toast$(f.name + ': ' + t('图片处理失败'), 'error') }
    }
    renderAddProductImageGrid()
  }
})()
