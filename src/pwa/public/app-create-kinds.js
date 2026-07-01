// Unified create entry — a small "全新商品 ⇄ 二手闲置" kind chooser shown at the top of BOTH create surfaces
// (the seller new-goods form and the secondhand publish page), so each create flow surfaces the other kind
// instead of being a dead-end. Mirrors UOMA's single Goods-incl.-secondhand create entry, WITHOUT merging the
// two backends: /api/products and /api/secondhand keep their own flows, fee rates and role rules.
//   createKindChooserHtml(current): current ∈ {'new','secondhand'}. The active pill is inert; the other pill
//     navigates — 'new' → goCreateListingFromBuy() (the smart seller entry: handles anon / buyer→seller
//     upgrade / role switch), 'secondhand' → #secondhand/publish (open to any logged-in user).
window.createKindChooserHtml = (current) => {
  const t = window.t || ((s) => s)
  const pill = (active, label, onclick) => active
    ? `<span style="flex:1;text-align:center;padding:7px 0;border-radius:8px;font-size:13px;font-weight:600;background:#111827;color:#fff">${label}</span>`
    : `<button type="button" onclick="${onclick}" style="flex:1;text-align:center;padding:7px 0;border-radius:8px;font-size:13px;font-weight:500;background:#f3f4f6;color:#374151;border:1px solid #e5e7eb;cursor:pointer">${label}</button>`
  return `<div style="display:flex;gap:8px;margin-bottom:16px">`
    + pill(current === 'new', '🆕 ' + t('全新商品'), 'goCreateListingFromBuy()')
    + pill(current === 'secondhand', '♻️ ' + t('二手闲置'), "location.hash='#secondhand/publish'")
    + `</div>`
}
