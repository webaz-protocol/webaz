// 商品编辑页图片编辑器（补 renderEditProduct 缺失的加图/换图 UI）。app.js 已到 LOC 天花板冻结（禁回塞），
// 故独立成文件、运行时注入:包裹 window.renderEditProduct 在原渲染后插入图片区;加图/删图即时保存
// （p2pPublishContent 注册 manifest+缩略图 → PUT image_hashes 写 product.images,全图 blob 留卖家节点）。
// index.html 中于 app.js 之后加载。依赖全局 GET/state/t/toast$/compress*/sha256Hex/p2pPublishContent。
;(function () {
  if (typeof window.renderEditProduct !== 'function') return
  const _origRenderEditProduct = window.renderEditProduct

  window.renderEditProduct = async function (app, productId) {
    await _origRenderEditProduct.call(this, app, productId)
    try { await injectImageSection(productId) } catch (e) { console.warn('[edit-image inject]', e) }
  }

  async function injectImageSection(productId) {
    const descEl = document.getElementById('ep-desc')
    const descGroup = descEl && descEl.closest('.form-group')
    if (!descGroup || document.getElementById('ep-img-grid')) return   // 非编辑页 / 已注入
    // 现有图 hash（p.images: JSON 数组 / 数组 / 逗号）
    let existing = []
    try {
      const p = await GET('/products/' + productId)
      let arr = p && p.images
      if (typeof arr === 'string') { try { arr = JSON.parse(arr) } catch { arr = arr.split(',') } }
      existing = (Array.isArray(arr) ? arr : []).map(function (s) { return String(s).trim() }).filter(function (h) { return /^[0-9a-f]{64}$/i.test(h) })
    } catch (e) { /* 取不到图就当无图 */ }
    window._editProductPid = productId
    window._editProductImgs = existing.map(function (h) { return { hash: h, existing: true, thumbSrc: '/api/manifests/' + h + '/thumb' } })

    const sec = document.createElement('div')
    sec.className = 'form-group'
    sec.innerHTML =
      '<label class="form-label">' + t('商品图片') + '<span style="font-size:11px;color:#9ca3af;font-weight:400;margin-left:6px">' + t('（最多 9 张 · 自动压缩到 800px · 第一张为封面 · blob 留在你的节点，平台只存哈希）') + '</span></label>' +
      '<input type="file" id="ep-img-input" accept="image/*" multiple style="display:none" onchange="onEditAddProductImages(event)">' +
      '<div id="ep-img-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:8px;margin-top:6px"></div>' +
      '<div id="ep-img-msg" style="font-size:11px;color:#6b7280;margin-top:4px;min-height:14px"></div>' +
      '<button type="button" onclick="document.getElementById(\'ep-img-input\').click()" style="margin-top:8px;background:#fff;border:1px dashed #d1d5db;border-radius:8px;padding:10px 14px;font-size:12px;color:#6b7280;cursor:pointer;width:100%">📷 ' + t('添加图片') + '</button>'
    descGroup.after(sec)
    renderGrid()
  }

  function renderGrid() {
    const grid = document.getElementById('ep-img-grid')
    if (!grid) return
    grid.innerHTML = (window._editProductImgs || []).map(function (it, i) {
      return '<div style="position:relative;aspect-ratio:1;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb' + (i === 0 ? ';outline:2px solid #4f46e5;outline-offset:-2px' : '') + '">' +
        '<img src="' + (it.existing ? it.thumbSrc : it.blobUrl) + '" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.style.opacity=\'0.25\'">' +
        (i === 0 ? '<div style="position:absolute;top:2px;left:2px;background:#4f46e5;color:#fff;font-size:9px;padding:1px 5px;border-radius:99px;font-weight:600">' + t('封面') + '</div>' : '') +
        '<button onclick="removeEditProductImage(' + i + ')" style="position:absolute;top:2px;right:2px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,0.6);color:#fff;border:none;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1">×</button>' +
      '</div>'
    }).join('')
  }

  // 即时保存:新图发 manifest（带缩略图）→ PUT image_hashes 写 product.images（部分更新,不动其它字段）
  async function persist() {
    const imgs = window._editProductImgs || []
    const msg = document.getElementById('ep-img-msg')
    if (msg) msg.textContent = t('保存中...')
    // 新图任一 manifest 发布失败 → 中止本次保存,不把无 active manifest 的 hash PUT 上去(否则 /thumb 404 却显示已保存;失败图留待重试)
    let failed = 0
    for (const it of imgs.filter(function (x) { return !x.existing && x.blob })) {
      try {
        await p2pPublishContent({ blob: it.blob, content_type: it.contentType, description: '', related_product_id: window._editProductPid, thumbnail_data_uri: it.thumb })
        it.existing = true
      } catch (e) { console.warn('[edit image manifest publish]', e); failed++ }
    }
    if (failed > 0) { if (msg) msg.textContent = '⚠️ ' + failed + ' ' + t('图片处理失败'); return }
    let res
    try {
      res = await fetch('/api/products/' + window._editProductPid, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + state.apiKey },
        body: JSON.stringify({ image_hashes: imgs.map(function (x) { return x.hash }) }),
      }).then(function (r) { return r.json() })
    } catch (e) { res = { error: String(e) } }
    if (msg) msg.textContent = (res && res.error) ? ('⚠️ ' + res.error) : (t('已保存') + ' ✓')
  }

  window.onEditAddProductImages = async function (e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    window._editProductImgs = window._editProductImgs || []
    const remaining = 9 - window._editProductImgs.length
    if (remaining <= 0) { toast$(t('最多 9 张图片'), 'error'); return }
    for (const f of files.slice(0, remaining)) {
      if (!f.type.startsWith('image/')) continue
      if (f.size > 12 * 1024 * 1024) { toast$(f.name + ': ' + t('文件过大（>12MB）'), 'error'); continue }
      try {
        const mime = f.type === 'image/png' ? 'image/png' : 'image/jpeg'
        const fullBlob = await compressImageToBlob(f, 800, 0.82, mime)
        const thumb = await compressImageToDataURL(f, 200, 0.7)
        const hash = await sha256Hex(fullBlob)
        const blobUrl = URL.createObjectURL(fullBlob)
        window._editProductImgs.push({ blob: fullBlob, hash: hash, thumb: thumb, contentType: mime, blobUrl: blobUrl, existing: false })
      } catch (e2) { toast$(f.name + ': ' + t('图片处理失败'), 'error') }
    }
    renderGrid()
    await persist()
  }

  window.removeEditProductImage = async function (i) {
    try { const it = window._editProductImgs[i]; if (it && it.blobUrl) URL.revokeObjectURL(it.blobUrl) } catch (e) {}
    window._editProductImgs.splice(i, 1)
    renderGrid()
    await persist()
  }
})()
