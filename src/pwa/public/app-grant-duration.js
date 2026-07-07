// RFC-020 — shared grant-duration picker (used by #pair initial pairing + #agent-approvals expansion).
//   Classic script, loaded before the pages that use it. Globals (t / escHtml) resolve at call time.
//   The human chooses the grant lifetime; safe scopes → up to 30d. Kept in one place so both approval
//   surfaces stay identical and the pinned page files don't grow.
;(function () {
  const LABEL = { once: '一次性', '1h': '1 小时', '24h': '24 小时', '7d': '7 天', '30d': '30 天' }

  // Render a <select id=selectId> of `allowed` durations, pre-selecting `suggested`. Falls back to a safe set.
  window.grantDurationSelect = function (allowed, suggested, selectId) {
    const opts = (Array.isArray(allowed) && allowed.length) ? allowed : ['1h', '24h', '7d', '30d']
    const sel = suggested || '7d'
    return `<div style="margin-top:10px"><span style="font-size:12px;color:#6b7280">${t('授权时长')}(${t('你可以改')}):</span>`
      + `<select id="${escHtml(String(selectId))}" style="width:100%;margin-top:4px;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:14px">`
      + opts.map(d => `<option value="${escHtml(String(d))}" ${d === sel ? 'selected' : ''}>${escHtml(t(LABEL[d] || String(d)))}</option>`).join('')
      + `</select></div>`
  }

  // Read the human's chosen duration from a rendered selector (undefined if absent → backend uses its default).
  window.grantDurationValue = function (selectId) { const el = document.getElementById(selectId); return (el && el.value) || undefined }
})()
