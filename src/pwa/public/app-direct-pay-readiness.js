// Direct Pay (Rail 1) — SELLER de-identified readiness panel (PR readiness-seller-ui)。UI ONLY。
//   只渲染【卖家可行动 / 脱敏状态】项(收款说明 / Passkey / 履约保证金 / 商户审核 / 暂停 / 平台开放)。
//   数据来自 GET /api/direct-receive/readiness(后端已脱敏:绝不下发 raw blocker、也绝不暴露 KYB/制裁/AML 分项)。
//   前端只做 code→卖家可读双语文案 的映射,绝不展示原始内部判定码。Direct Pay 仍 non-launchable / fail-closed。
//   不碰 wallet/escrow/settlement/refund/钱路;不开真实 rail;不声称已上线。买家侧不展示本面板。

// 内部 code → 卖家安全双语文案(ok / 未达成 两态 + 可行动入口)。绝不出现 KYB/sanctions/AML 字样。
window.dpSellerReadinessCopy = () => ({
  PLATFORM_OPEN: { ok: t('平台侧直付已开放'), no: t('直付平台侧暂未开放(无需你操作)') },
  PAYMENT_INSTRUCTION: { ok: t('已设置收款说明'), no: t('未设置收款说明'), action: t('去设置收款说明'), href: '#seller/settings' },
  PASSKEY: { ok: t('已注册 Passkey'), no: t('未注册 Passkey'), action: t('去注册 Passkey'), href: '#me' },
  BASE_BOND: { ok: t('履约保证金已完成'), no: t('履约保证金未完成') },
  COMPLIANCE_REVIEW: { ok: t('商户审核已通过'), no: t('商户审核进行中或未通过') },
  NOT_SUSPENDED: { ok: t('直付资格正常'), no: t('直付资格已被暂停') },
})

window.dpSellerReadinessSection = () => `
  <div class="card" style="margin-bottom:12px;border:1px solid #e5e7eb">
    <div style="font-size:14px;font-weight:700;margin-bottom:4px">🧭 ${t('直付开通进度(仅你可见)')}</div>
    <div style="font-size:12px;color:#6b7280;line-height:1.6;margin-bottom:10px">${t('以上为你的直付开通进度;直付按轨道分阶段开放,完成可行动项不代表立即可用。')}</div>
    <div id="dp-seller-readiness">${loading$()}</div>
  </div>`

window.dpHydrateSellerReadiness = async () => {
  const box = document.getElementById('dp-seller-readiness')
  if (!box) return
  const r = await GET('/direct-receive/readiness')
  if (!r || r.error) { box.innerHTML = `<div style="font-size:12px;color:#dc2626">${window.dpErrorText ? window.dpErrorText(r && r.error_code, r && r.error) : t('操作失败,请重试')}</div>`; return }
  const copy = window.dpSellerReadinessCopy()
  const rows = (r.items || []).map(it => {
    const c = copy[it.code]; if (!c) return ''
    const icon = it.ok ? '✅' : (it.actionable ? '⚠️' : '⏳')
    const text = it.ok ? c.ok : c.no
    const act = (!it.ok && it.actionable && c.action) ? ` · <a href="${c.href}" style="color:#2563eb;font-weight:600;text-decoration:underline">${c.action}</a>` : ''
    return `<li style="display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.7;color:#374151"><span>${icon}</span><span>${escHtml(text)}${act}</span></li>`
  }).join('')
  box.innerHTML = `<ul style="margin:0;padding-left:2px;list-style:none">${rows}</ul>`
}
