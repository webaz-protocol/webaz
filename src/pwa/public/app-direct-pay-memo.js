// Direct Pay — 可验证付款附言(参考号)。UI ONLY;不碰钱路。
//   每单从订单号派生【确定性唯一参考号】,提示买家付款时填入收款附言/备注 → mark_paid 的 note 回填订单时间线
//   (买卖双方可见),相同金额也能靠参考号区分付款方。协议不验证,仅辅助对账。
//   参考号【只读 + 一键复制】:锁定派生值买家不可改 —— 防"两单复用同一参考号"骗卖家重复确认;中文 t()/英文 i18n.js _EN。
window.dpPayRef = (orderId) => 'WAZ-' + String(orderId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase()
window.dpMemoInputHtml = (orderId) => {
  const ref = window.dpPayRef(orderId)
  return `<div style="margin-top:8px;border-top:1px dashed #fde68a;padding-top:8px">
    <div style="font-size:11px;color:#92400e;font-weight:600;margin-bottom:3px">${t('付款时请在附言/备注填入(便于卖家核对)')}</div>
    <div style="display:flex;align-items:center;gap:6px"><code id="dp-buyer-memo" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:13px;font-weight:700;letter-spacing:0.5px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 8px">${escHtml(ref)}</code>${window.dpCopyBtn ? window.dpCopyBtn(ref) : ''}</div>
    <div style="font-size:10px;color:#9ca3af;margin-top:2px">${t('此参考号系统生成、不可修改;相同金额时卖家靠它区分付款方,标记"我已付款"时自动记入订单流程。')}</div></div>`
}
// "我已付款"时:note 恒为【派生参考号】(不再读可改输入框)—— 卖家对账口径唯一,买家无法用别单参考号冒充。
window.dpReadMemo = (orderId) => `${t('付款参考')}: ${window.dpPayRef(orderId)}`
