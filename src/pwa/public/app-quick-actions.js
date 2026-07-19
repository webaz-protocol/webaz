// Compact shell actions keep secondary help controls off the primary mobile chrome.
window.closeQuickActions = () => {
  const menu = document.getElementById('quick-actions-menu')
  const trigger = document.getElementById('quick-actions-trigger')
  if (!menu || !trigger) return
  const restoreFocus = menu.contains(document.activeElement)
  menu.hidden = true
  trigger.setAttribute('aria-expanded', 'false')
  if (restoreFocus) trigger.focus()
}
window.toggleQuickActions = () => {
  const menu = document.getElementById('quick-actions-menu')
  const trigger = document.getElementById('quick-actions-trigger')
  if (!menu || !trigger) return
  const open = trigger.getAttribute('aria-expanded') === 'true'
  menu.hidden = open
  trigger.setAttribute('aria-expanded', String(!open))
}
window.openQuickActionsAgent = () => {
  window.closeQuickActions()
  window.toggleAgentChat()
}
window.openQuickActionsFeedback = () => {
  window.closeQuickActions()
  window.openBuildFeedback()
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.closeQuickActions()
})
