// 平台服务费预充值申请 —— 状态筛选 tab + 已处理(历史)只读卡。补齐"申请入账成功后在管理页不可查"的缺口:
//   pending 走 afprCard(可操作),approved/rejected/cancelled 走 afprHistoryCard(只读,显审核人/时间/备注/入账流水)。
//   backend GET /admin/direct-receive/fee-prepay-requests?status=X(无 status = 全部,最多 200 条)已支持,本文件仅补前端 UI。
//   面向管理员中文走 t(),英文 i18n.js _EN。
window.afprStatusFilter = 'pending'

// 状态筛选 tab 条。点击切换 → afprHydrate(status)(重拉 + 高亮)。
window.afprTabs = () => {
  const tabs = [['pending', t('待审核')], ['approved', t('已入账')], ['rejected', t('已驳回')], ['all', t('全部')]]
  return `<div id="afpr-tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${tabs.map(([s, label]) =>
    `<button class="btn btn-sm" data-afpr-tab="${s}" style="width:auto;padding:4px 12px;${s === window.afprStatusFilter ? 'background:#111827;color:#fff' : 'background:#f3f4f6;color:#374151'}" onclick="afprHydrate('${s}')">${label}</button>`).join('')}</div>`
}

// 高亮当前 tab(afprHydrate 拉数据后调用;同时记住当前筛选,供 approve/reject 后原地重拉)。
window.afprSetActiveTab = (status) => {
  window.afprStatusFilter = status
  document.querySelectorAll('[data-afpr-tab]').forEach(b => {
    const on = b.getAttribute('data-afpr-tab') === status
    b.style.background = on ? '#111827' : '#f3f4f6'; b.style.color = on ? '#fff' : '#374151'
  })
}

// 已处理申请只读卡(不给 approve/reject 按钮;显状态徽章 + 审核人/时间/备注 + 入账流水 id)。
window.afprHistoryCard = (r) => `
  <div style="border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;margin-bottom:10px;background:#fafafa" data-req="${escHtml(r.id)}">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
      <div style="font-size:15px;font-weight:800">${(r.amount_units / 1e6).toFixed(2)} <span style="font-size:12px;color:#6b7280">${escHtml(r.currency || 'USDC')}</span></div>
      <span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap;${r.status === 'approved' ? 'background:#dcfce7;color:#166534' : r.status === 'rejected' ? 'background:#fee2e2;color:#991b1b' : 'background:#e5e7eb;color:#4b5563'}">${window.afprStatus ? window.afprStatus(r.status) : escHtml(r.status)}</span>
    </div>
    <div style="font-size:11px;color:#9ca3af;margin:2px 0 6px">${t('申请 id')}: <code>${escHtml(r.id)}</code></div>
    <div style="font-size:12px;color:#374151;line-height:1.7">
      <div>${t('卖家')}: <code>${escHtml(r.seller_id)}</code></div>
      <div>${t('付款凭证号')}: <b>${escHtml(r.evidence_ref)}</b>${r.evidence_note ? ` · ${escHtml(r.evidence_note)}` : ''}</div>
      <div>${t('申请时间')}: <span style="color:#6b7280">${escHtml(r.created_at || '-')}</span></div>
      <div>${t('审核人')}: <code>${escHtml(r.reviewed_by || '-')}</code> · ${t('审核时间')}: <span style="color:#6b7280">${escHtml(r.reviewed_at || '-')}</span></div>
      ${r.review_note ? `<div>${t('审核备注')}: ${escHtml(r.review_note)}</div>` : ''}
      ${r.resulting_payment_id ? `<div>${t('入账流水')}: <code>${escHtml(r.resulting_payment_id)}</code></div>` : ''}
    </div>
  </div>`
