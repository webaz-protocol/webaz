// 保证金条款 + 多币种账户选择 UI(Lock B 放行配套)。UI ONLY —— 条款版本/账户校验在后端(428 TERMS_NOT_AGREED)。
;(function () {
  // 账户单选(多币种;admin 在 #admin/platform-receive 维护)。选中项凭据/币种由后端按账户推导。
  window.bondAccountSelector = (s) => {
    const accs = s.payment_accounts || []
    if (!accs.length) return t('暂无收款方式,请联系平台')
    return accs.map((a, i) => `<label style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px;cursor:pointer">
      <input type="radio" name="bond-acc" value="${escHtml(a.id)}" ${i === 0 ? 'checked' : ''} style="margin-top:3px">
      <span style="font-size:12px"><strong>${escHtml(a.label || a.method || '')}</strong> · ${escHtml(a.currency || '')}<br><span style="color:#6b7280">${escHtml(a.instruction || '')}</span></span>
    </label>`).join('')
  }
  // 条款(折叠展示全文)+ 强制勾选;版本存全局供提交带上(后端精确匹配)
  window.bondTermsBlock = (s) => {
    if (!s.terms) return ''
    window._bondTermsVersion = s.terms.version
    const text = (window._lang === 'en' ? s.terms.en : s.terms.zh) || s.terms.zh
    return `<details style="margin-bottom:8px"><summary style="cursor:pointer;font-size:12px;font-weight:600">📜 ${t('保证金条款')}(${escHtml(s.terms.version)})</summary>
      <div style="font-size:11px;color:#4b5563;white-space:pre-wrap;line-height:1.7;padding:8px;background:#f9fafb;border-radius:8px;margin-top:6px">${escHtml(text)}</div></details>
    <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#374151;margin-bottom:8px;cursor:pointer">
      <input type="checkbox" id="bond-terms-agree" style="width:16px;height:16px">${t('我已阅读并同意当前版本保证金条款(缴纳前必须同意)')}
    </label>`
  }
})()
