let quickActionsIdleTimer = 0
const quickActionsRoot = () => document.getElementById('quick-actions')
const usesQuickActionsDock = () => window.matchMedia('(max-width: 919px)').matches
const setQuickActionsDocked = docked => { const root = quickActionsRoot(); if (root && usesQuickActionsDock()) root.dataset.docked = String(docked) }
const stopQuickActionsIdle = () => { clearTimeout(quickActionsIdleTimer); quickActionsIdleTimer = 0 }
const queueQuickActionsIdle = () => { stopQuickActionsIdle(); if (usesQuickActionsDock()) quickActionsIdleTimer = setTimeout(() => window.closeQuickActions(), 5000) }
window.closeQuickActions = () => {
  const menu = document.getElementById('quick-actions-menu'), trigger = document.getElementById('quick-actions-trigger')
  if (!menu || !trigger) return
  const restoreFocus = menu.contains(document.activeElement)
  menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (restoreFocus) trigger.focus(); stopQuickActionsIdle(); setQuickActionsDocked(true)
}
window.toggleQuickActions = () => {
  const menu = document.getElementById('quick-actions-menu'), trigger = document.getElementById('quick-actions-trigger')
  if (!menu || !trigger) return
  if (trigger.getAttribute('aria-expanded') === 'true') return window.closeQuickActions()
  setQuickActionsDocked(false); menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); queueQuickActionsIdle()
}
window.openQuickActionsAgent = () => { window.closeQuickActions(); window.toggleAgentChat() }
window.openQuickActionsFeedback = () => { window.closeQuickActions(); window.openBuildFeedback() }
document.addEventListener('keydown', event => { if (event.key === 'Escape') window.closeQuickActions() })
document.addEventListener('pointerdown', event => { const root = quickActionsRoot(); if (root && !root.contains(event.target)) window.closeQuickActions() })
document.addEventListener('focusin', event => { if (event.target.closest?.('#quick-actions')) { stopQuickActionsIdle(); setQuickActionsDocked(false) } })
document.addEventListener('focusout', () => setTimeout(() => { const root = quickActionsRoot(), trigger = document.getElementById('quick-actions-trigger'); if (root && trigger?.getAttribute('aria-expanded') === 'false' && !root.contains(document.activeElement)) setQuickActionsDocked(true) }))
