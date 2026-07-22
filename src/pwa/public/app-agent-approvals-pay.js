// RFC-029 Design A PR-4 — confirm-page payment-method selector. For a DEFERRED order_submit request the
//   human picks a payment method here; on confirm we POST choose-payment (sets the rail + rehashes
//   params_hash), update the card's bound hash, then run the normal Passkey approve (aaApprove). New file:
//   the approval-card files are at their LOC ceilings, and no new code may be back-loaded there.
;(function () {
  // Post-render sweep (called net-zero from aaHydrate): load an option menu into every deferred pay-slot.
  window.aaLoadDeferredPay = function (box) {
    var slots = (box || document).querySelectorAll('[data-aa-pay-req]')
    for (var i = 0; i < slots.length; i++) window.aaLoadPay(slots[i].getAttribute('data-aa-pay-req'))
  }

  window.aaLoadPay = async function (id) {
    var slot = document.getElementById('aa-pay-' + id); if (!slot) return
    slot.innerHTML = '<div style="font-size:12px;color:#6b7280">' + t('正在载入支付方式…') + '</div>'
    var res = await apiRead('/agent-grants/permission-requests/' + encodeURIComponent(id) + '/payment-options')
    if (!res.ok || !res.data) { slot.innerHTML = '<div style="font-size:12px;color:#dc2626">' + t('支付方式载入失败,请刷新重试') + '</div>'; return }
    if (res.data.rail_chosen) { slot.innerHTML = ''; return }   // 已选(并发)→ 走普通批准流,选择器隐藏
    var opts = Array.isArray(res.data.options) ? res.data.options : []
    if (!opts.length) { slot.innerHTML = '<div style="font-size:12px;color:#991b1b">' + t('该卖家当前无可用支付方式') + '</div>'; return }
    var recIdx = 0; for (var k = 0; k < opts.length; k++) { if (opts[k].recommended) { recIdx = k; break } }
    var rows = opts.map(function (o, i) {
      var head = o.rail === 'escrow'
        ? t('托管(模拟测试轨)')
        : (t('直付') + (o.method ? ' · ' + escHtml(String(o.method)) : '') + (o.recipient_label ? ' · ' + escHtml(String(o.recipient_label)) : ''))
      return '<label style="display:flex;gap:8px;align-items:flex-start;padding:8px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:6px;cursor:pointer">' +
        '<input type="radio" name="aapay-' + id + '" value="' + escHtml(String(o.option_id)) + '"' + (i === recIdx ? ' checked' : '') + '>' +
        '<span style="flex:1"><span style="font-size:13px;color:#111827;font-weight:500">' + head + (o.recommended ? ' <span style="font-size:10px;color:#4f46e5">· ' + t('推荐支付方式') + '</span>' : '') + '</span>' +
        '<span style="display:block;font-size:11px;color:#6b7280;margin-top:2px;line-height:1.5">' + escHtml(String(o.settlement_note || '')) + '</span></span></label>'
    }).join('')
    slot.innerHTML = '<div style="font-size:12px;color:#374151;margin-bottom:6px">' + t('选择支付方式(将在你 Passkey 批准时确定)') + '</div>' + rows +
      '<button class="btn btn-primary" style="width:100%;margin-top:4px" onclick="aaChoosePayAndApprove(\'' + id + '\')">🔑 ' + t('确定支付方式并用 Passkey 批准') + '</button>'
  }

  // choose-payment(设轨道 + 重算 params_hash)→ 更新卡片绑定 hash → 走原 Passkey 批准(aaApprove 绑新 hash)。
  window.aaChoosePayAndApprove = async function (id) {
    var sel = document.querySelector('input[name="aapay-' + id + '"]:checked')
    if (!sel) { toast$(t('请先选择一种支付方式'), 'error'); return }
    var res = await apiWriteIdempotent('POST', '/agent-grants/permission-requests/' + encodeURIComponent(id) + '/choose-payment', { option_id: sel.value })
    if (res.unknownOutcome || !res.ok || !res.data || !res.data.success) { toast$((res.data && res.data.error) || t('支付方式选择失败,请刷新重试'), 'error'); return }
    var card = document.querySelector('[data-aa-id="' + ((window.CSS && CSS.escape) ? CSS.escape(id) : id) + '"]')
    if (card && res.data.params_hash) card.dataset.aaHash = res.data.params_hash   // Passkey 将绑定新 hash(选择前铸的旧 token 已失效)
    await window.aaApprove(id)
  }
})()
