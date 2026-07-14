// Cart selection is a transaction intent: totals, deletes and checkout share this one source.
(function () {
  let cartBusy = false
  function selectedCartRows() { return [...document.querySelectorAll('.cart-item-check')].filter(cb => cb.checked) }
  function selectedProductIds() { return selectedCartRows().map(cb => cb.dataset.pid).filter(Boolean) }
  function selectedCheckoutItems() { return selectedCartRows().map(cb => ({ product_id: cb.dataset.pid, qty: Number(cb.dataset.qty), unit_price: Number(cb.dataset.unitPrice) })) }

  function setBusy(busy) {
    cartBusy = busy
    document.querySelectorAll('.cart-item-check, #cart-select-all, #cart-remove-selected, #cart-checkout, .cart-mutation-control')
      .forEach(el => { el.disabled = busy })
    const msg = document.getElementById('cart-msg')
    if (msg) msg.setAttribute('aria-busy', busy ? 'true' : 'false')
  }

  window.cartToggleAll = (checked) => {
    if (cartBusy) return
    document.querySelectorAll('.cart-item-check').forEach(cb => { cb.checked = checked })
    window.cartRecalcTotal()
  }

  window.cartRecalcTotal = () => {
    let total = 0
    const checks = [...document.querySelectorAll('.cart-item-check')]
    checks.forEach(cb => { if (cb.checked) total += Number(cb.dataset.subtotal || 0) })
    const totalEl = document.getElementById('cart-checked-total')
    if (totalEl) totalEl.innerText = total.toFixed(2) + ' WAZ'

    const selectedCount = checks.filter(cb => cb.checked).length
    const selectAll = document.getElementById('cart-select-all')
    if (selectAll) {
      selectAll.checked = checks.length > 0 && selectedCount === checks.length
      selectAll.indeterminate = selectedCount > 0 && selectedCount < checks.length
    }
    const removeBtn = document.getElementById('cart-remove-selected')
    const checkoutBtn = document.getElementById('cart-checkout')
    if (removeBtn) removeBtn.disabled = selectedCount === 0
    if (checkoutBtn) checkoutBtn.disabled = selectedCount === 0
  }

  window.cartRemoveChecked = async () => {
    if (cartBusy) return
    const ids = selectedProductIds()
    if (ids.length === 0) return alert(t('未选中任何商品'))
    if (!confirm(t('确认删除选中的 ') + ids.length + t(' 个商品？'))) return
    setBusy(true)
    try {
      let removed = 0
      const failed = []
      for (const pid of ids) {
        try {
          const result = await DELETE(`/cart/${encodeURIComponent(pid)}`)
          if (result?.error) failed.push(pid)
          else removed++
        } catch (_) { failed.push(pid) }
      }
      await renderCart(document.getElementById('app'))
      await refreshCartBadge()
      const summary = t('已删除') + ' ' + removed + (failed.length ? ' · ' + t('失败 ') + failed.length : '')
      if (failed.length) alert(summary); else toast$(summary)
    } catch (_) {
      alert(t('操作失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  window.cartChangeQty = async (productId, qty) => {
    if (cartBusy) return
    if (qty < 1) return window.cartRemove(productId)
    if (qty > 99) return
    setBusy(true)
    try {
      const result = await PATCH(`/cart/${productId}`, { qty })
      if (result.error) return alert(result.error)
      await renderCart(document.getElementById('app'))
      await refreshCartBadge()
    } finally { setBusy(false) }
  }

  window.cartRemove = async (productId) => {
    if (cartBusy) return
    setBusy(true)
    try {
      await DELETE(`/cart/${productId}`)
      await renderCart(document.getElementById('app'))
      await refreshCartBadge()
    } finally { setBusy(false) }
  }

  window.cartCheckout = async () => {
    if (cartBusy) return
    const addr = document.getElementById('cart-addr').value.trim()
    const msg = document.getElementById('cart-msg')
    if (!addr) { msg.innerHTML = alert$('error', t('请填写收货地址')); return }
    const items = selectedCheckoutItems()
    if (items.length === 0) { msg.innerHTML = alert$('error', t('未选中任何商品')); return }
    setBusy(true)
    msg.innerHTML = loading$()
    let result
    try {
      result = await POST('/cart/checkout', { shipping_address: addr, items })
    } catch (_) {
      setBusy(false)
      msg.innerHTML = alert$('error', t('操作失败，请重试'))
      return
    }
    if (result.error) {
      setBusy(false)
      msg.innerHTML = alert$('error', result.error + (result.skipped?.length ? ` · ${t('跳过')} ${result.skipped.length}` : ''))
      return
    }
    let html = `<div class="alert alert-success">${t('成功下单')} ${result.orders_created} ${t('单')} · ${t('共支付')} ${Number(result.total_paid || 0).toFixed(2)} WAZ</div>`
    if ((result.skipped || []).length > 0) {
      html += `<div class="alert alert-warn" style="font-size:11px">${t('跳过')}: ${result.skipped.map(item => item.product_id.slice(0, 10) + '… (' + escHtml(item.reason) + ')').join('；')}</div>`
    }
    msg.innerHTML = html
    refreshCartBadge()
    setTimeout(() => { setBusy(false); navigate('#orders') }, 1500)
  }
})()
