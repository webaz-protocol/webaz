// Checkout address-book helpers shared by product buy sheet and cart checkout.
function buildAddrString(a) {
  if (!a) return ''
  const parts = []
  if (a.region) parts.push(a.region)
  parts.push(a.detail)
  parts.push(a.recipient)
  if (a.phone) parts.push(a.phone)
  return parts.join(' · ')
}

window.openAddressPicker = (target = 'order') => {
  const items = state._addresses || []
  const rows = items.map(it => `
    <div class="card" style="padding:10px 12px;margin-bottom:6px;cursor:pointer${it.is_default ? ';border:1px solid #6366f1;background:#eef2ff' : ''}" onclick="pickAddress('${it.id}', '${target}')">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <div style="font-size:13px;font-weight:600">${escHtml(it.label)}${it.is_default ? ` <span style="font-size:10px;color:#6366f1">${t('默认')}</span>` : ''}</div>
        <div style="font-size:11px;color:#9ca3af">${escHtml(it.recipient)}${it.phone ? ' · ' + escHtml(it.phone) : ''}</div>
      </div>
      <div style="font-size:12px;color:#6b7280">${it.region ? escHtml(it.region) + ' · ' : ''}${escHtml(it.detail)}</div>
    </div>
  `).join('')
  const div = document.createElement('div')
  div.innerHTML = `<div class="js-modal" style="background:rgba(0,0,0,0.6);position:fixed;inset:0;z-index:1000;display:flex;align-items:flex-end;justify-content:center" onclick="this.remove()"><div style="background:#fff;width:100%;max-width:560px;border-radius:16px 16px 0 0;padding:16px;max-height:70vh;overflow-y:auto" onclick="event.stopPropagation()"><h2 style="font-size:15px;font-weight:700;margin-bottom:10px">📍 ${t('选择收货地址')}</h2>${rows}<a href="#addresses" style="display:block;text-align:center;padding:10px;font-size:12px;color:#6366f1">+ ${t('管理地址簿')}</a></div></div>`
  document.body.appendChild(div.firstElementChild)
}

window.pickAddress = (id, target = 'order') => {
  const a = (state._addresses || []).find(x => x.id === id)
  if (!a) return
  const txt = buildAddrString(a)
  const inp = document.getElementById(target === 'cart' ? 'cart-addr' : 'inp-addr')
  const hidden = document.getElementById(target === 'cart' ? 'cart-address-id' : 'inp-address-id')
  if (inp) inp.value = txt
  if (hidden) hidden.value = id
  const summary = document.getElementById(target === 'cart' ? 'cart-addr-summary-text' : 'addr-summary-text')
  if (summary) { summary.textContent = txt; summary.title = txt }
  if (target === 'cart' && typeof cartRecalcTotal === 'function') cartRecalcTotal()
  if (target !== 'cart') toggleOrderAddrEdit(false)
  document.querySelector('.js-modal')?.remove()
}

window.orderAddressManualEdit = () => {
  const hidden = document.getElementById('inp-address-id')
  if (hidden) hidden.value = ''
}

window.cartAddressManualEdit = () => {
  const hidden = document.getElementById('cart-address-id')
  if (hidden) hidden.value = ''
  const summary = document.getElementById('cart-addr-summary-text')
  const inp = document.getElementById('cart-addr')
  if (summary && inp) { summary.textContent = inp.value.trim() || t('手动填写地址'); summary.title = inp.value.trim() }
}
