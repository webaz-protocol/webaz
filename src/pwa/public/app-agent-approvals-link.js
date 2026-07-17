// RFC-026 PR-2 — 审批页深链接(/#agent-approvals/apr_x)。渲染后高亮+滚动到目标卡;
//   找不到 = 明确提示(可能已批准/拒绝/过期),绝不静默。approval_url 由 submit/action-request 响应下发。
;(function () {
  // RFC-026 PR-2:深链接 /#agent-approvals/apr_x —— 渲染后高亮+滚动到目标卡;找不到给明确提示(不静默)。
  window.aaApplyDeepLink = function (box) {
    var target = (location.hash.split('/')[1] || '').trim()
    if (!target || !box) return
    var card = box.querySelector('[data-aa-id="' + ((window.CSS && CSS.escape) ? CSS.escape(target) : target) + '"]')
    if (card) { card.style.outline = '2px solid #4f46e5'; card.style.outlineOffset = '2px'; setTimeout(function () { card.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, 60); return }
    var note = document.createElement('div')
    note.className = 'card'; note.style.cssText = 'padding:12px;margin-bottom:12px;font-size:12px;color:#92400e;background:#fffbeb;border:1px solid #fde68a'
    note.textContent = '🔎 ' + t('链接指向的审批请求不在待处理列表(可能已批准/拒绝/过期)。') + ' ' + target
    box.prepend(note)
  }
})()
