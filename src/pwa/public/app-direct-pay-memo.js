// Direct Pay — 可验证付款附言(参考号)。UI ONLY;不碰钱路。
//   每单从订单号派生【确定性唯一参考号】,提示买家付款时填入收款附言/备注;买家在"我已付款"时确认/补充,作为
//   mark_paid 的 note 回填订单时间线(买卖双方可见)—— 相同金额也能靠参考号区分付款方。协议不验证,仅辅助对账。
//   面向用户中文走 t(),英文在 i18n.js _EN(双语 parity 由 test-direct-pay-ui.ts 守)。
window.dpPayRef = (orderId) => 'WAZ-' + String(orderId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase()
window.dpMemoInputHtml = (orderId) => {
  const ref = window.dpPayRef(orderId)
  return `<div style="margin-top:8px;border-top:1px dashed #fde68a;padding-top:8px">
    <div style="font-size:11px;color:#92400e;font-weight:600;margin-bottom:3px">${t('付款时请在附言/备注填入(便于卖家核对)')}</div>
    <input id="dp-buyer-memo" value="${escHtml(ref)}" maxlength="60" style="width:100%;box-sizing:border-box;font-size:12px;padding:5px 8px;border:1px solid #d1d5db;border-radius:6px">
    <div style="font-size:10px;color:#9ca3af;margin-top:2px">${t('相同金额时卖家靠此附言区分付款方;标记"我已付款"时会记入订单流程。')}</div></div>`
}
// "我已付款"时读取买家填写的附言(空则回落参考号)→ 作为 mark_paid note 回填时间线。
window.dpReadMemo = (orderId) => { const v = String(document.getElementById('dp-buyer-memo')?.value || window.dpPayRef(orderId)).trim().slice(0, 60); return v ? `${t('付款参考')}: ${v}` : '' }
