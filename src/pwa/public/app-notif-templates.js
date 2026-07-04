// 通知 i18n 模板注册表(N1,审计项 B)。UI ONLY。
//   服务端落库 template_key + params(JSON);此处按 viewer 当前 locale 用 t() 渲染整句(占位符 {k} 替换)。
//   旧行/未知 key/解析失败 → 一律回退存量中文 title/body(notifRender 返回原 n,向后兼容零迁移)。
//   新模板加这里 + i18n.js 双语句对;title 约定「emoji+空格」开头(列表把前 2 字符当图标)。
window._notifSub = (s, p) => String(s).replace(/\{(\w+)\}/g, (_, k) => (p && p[k] != null) ? String(p[k]) : '')
window.NOTIF_TEMPLATES = {
  dp_new_order: (p) => ({ title: '🛒 ' + t('新直付订单,等买家付款'), body: window._notifSub(t('商品「{product}」× {qty},应付 {amount} USDC。买家完成场外付款并标记后你会收到发货提醒。'), p) }),
  dp_marked_paid: (p) => ({ title: '💰 ' + t('买家已标记付款,请核对后发货'), body: window._notifSub(t('{detail}。请核对银行/收款App流水后再发货;未收到请点"未收到货款"。'), p) }),
  dp_window_expired: (p) => ({ title: '⏰ ' + t('直付付款窗口已过期'), body: window._notifSub(t('若你已付款:请在 {graceHours} 小时宽限期内到订单页提交付款凭证发起争议;未付款可直接关闭订单,否则宽限期满将自动取消。'), p) }),
  dp_grace_cancelled_buyer: () => ({ title: '🚫 ' + t('直付订单已自动取消'), body: t('付款窗口与宽限期均已过且未收到你的付款标记/凭证,订单已关闭。若你确已付款,请通过订单页联系卖家协商。') }),
  dp_grace_cancelled_seller: () => ({ title: '🚫 ' + t('直付订单已自动取消(买家未付款)'), body: t('买家未在付款窗口+宽限期内付款,订单已自动关闭,库存已恢复。') }),
}
// 单条通知 → 本地化渲染(不可变:返回带覆盖 title/body 的浅拷贝或原对象)。
window.notifRender = (n) => {
  try {
    const f = n && n.template_key && window.NOTIF_TEMPLATES[n.template_key]
    if (!f) return n
    const p = typeof n.params === 'string' ? JSON.parse(n.params || '{}') : (n.params || {})
    const r = f(p) || {}
    return { ...n, title: r.title || n.title, body: r.body || n.body }
  } catch { return n }
}
