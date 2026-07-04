// Direct Pay (Rail 1) — 融合付款弹窗。UI ONLY;不碰钱路(mark_paid 仍走 dpHandleAction 的 Passkey 门)。
//   两次风险披露完成后弹出:把【收款账号/说明 · 应付金额 · 付款附言(参考号)】三要素融合展示,每项一键复制
//   (买家直接抄进银行/收款App),付款后就地点"我已付款"→ dpHandleAction('mark_paid')(不新增 Passkey 次数,
//   省掉"回订单页找按钮"一步)。也可"稍后处理"→ 订单页(同样能标记付款)。中文 t(),英文 i18n.js _EN。
window.dpPayModalAmount = (order) => {
  let amt = String(order.total_amount) + ' USDC'
  try { const s = JSON.parse(order.direct_pay_account_snapshot || '{}'); if (Number.isFinite(Number(s.payable_approx)) && s.payable_currency) amt = s.payable_currency + ' ' + Number(s.payable_approx).toFixed(2) } catch {}
  return amt
}
window.dpShowPaymentModal = (order) => {
  if (!order || !order.id) return
  const oid = order.id
  const instr = order.direct_pay_instruction_snapshot || ''
  const amt = window.dpPayModalAmount(order)
  const ref = window.dpPayRef ? window.dpPayRef(oid) : ''
  const row = (label, valueHtml, copyText) => `<div style="margin-bottom:10px">
    <div style="font-size:11px;color:#6b7280;margin-bottom:3px">${label}${copyText != null && window.dpCopyBtn ? window.dpCopyBtn(copyText) : ''}</div>
    <div style="font-size:13px;color:#111827;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;white-space:pre-wrap;word-break:break-word">${valueHtml}</div></div>`
  window._openModal(`
    <h2 style="font-size:16px;font-weight:700;margin:0 0 4px">💸 ${t('请按以下信息付款')}</h2>
    <div style="font-size:12px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px;margin-bottom:12px">${t('风险确认已完成。这是卖家收款信息(下单时快照,WebAZ 不验证也不经手)。请【场外】完成付款后回来标记。')}</div>
    ${instr ? row(t('收款账号 / 说明'), escHtml(instr), instr) : ''}
    ${row(t('应付金额'), escHtml(amt), amt)}
    ${row(t('付款附言(务必填写,用于卖家核对)'), '<b>' + escHtml(ref) + '</b>', ref)}
    <div style="font-size:11px;color:#9ca3af;margin:6px 0 12px">${t('付款时请在银行/收款App的附言/备注里填入上面的参考号;完成付款后点下方按钮(需 Passkey)。')}</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-outline" style="flex:1" onclick="dpPayModalLater('${escHtml(oid)}')">${t('稍后在订单页处理')}</button>
      <button class="btn btn-primary" style="flex:1;background:#16a34a;border-color:#16a34a" onclick="dpPayModalMarkPaid('${escHtml(oid)}')">${t('我已付款')}</button>
    </div>`)
}
window.dpPayModalLater = (oid) => { if (typeof closeModal === 'function') closeModal(); navigate('#order/' + oid) }
window.dpPayModalMarkPaid = async (oid) => { if (typeof closeModal === 'function') closeModal(); await window.dpHandleAction(oid, 'mark_paid') }  // mark_paid 自带 Passkey 门 + 成功后跳订单页
