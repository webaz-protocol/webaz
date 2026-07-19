// Mobile-only right-edge docking and drag behavior for the shared quick-actions shell.
const QUICK_ACTIONS_TOP_KEY = 'webaz_quick_actions_top'
let dragState = null
let suppressTriggerClickUntil = 0
let positionFrame = 0

function usesDockedQuickActions() {
  return window.matchMedia('(max-width: 919px)').matches
}

function readSavedQuickActionsTop() {
  try {
    const saved = localStorage.getItem(QUICK_ACTIONS_TOP_KEY)
    return saved === null || saved === '' ? NaN : Number(saved)
  } catch { return NaN }
}

function quickActionsBounds() {
  const trigger = document.getElementById('quick-actions-trigger')
  if (!trigger) return null
  const navBottom = document.querySelector('.navbar')?.getBoundingClientRect().bottom || 0
  const tabbar = document.querySelector('.tabbar')
  const measuredTabbarTop = tabbar && getComputedStyle(tabbar).display !== 'none'
    ? tabbar.getBoundingClientRect().top
    : 0
  const min = Math.ceil(navBottom + 12)
  // During the first shell paint a fixed tabbar can transiently report top=0.
  // Ignore that incomplete geometry instead of pinning the helper below the header.
  const tabbarTop = measuredTabbarTop > min ? measuredTabbarTop : window.innerHeight
  const max = Math.max(min, Math.floor(Math.min(window.innerHeight - trigger.offsetHeight - 16, tabbarTop - trigger.offsetHeight - 12)))
  return { min, max }
}

function placeQuickActions(top = readSavedQuickActionsTop()) {
  cancelAnimationFrame(positionFrame)
  positionFrame = requestAnimationFrame(() => {
    const root = document.getElementById('quick-actions')
    if (!root || !usesDockedQuickActions()) return
    const bounds = quickActionsBounds()
    if (!bounds) return
    const fallback = Math.round(window.innerHeight * .56)
    const next = Math.max(bounds.min, Math.min(Number.isFinite(top) ? top : fallback, bounds.max))
    root.style.setProperty('--quick-actions-top', `${next}px`)
  })
}

function saveQuickActionsTop(top) {
  try { localStorage.setItem(QUICK_ACTIONS_TOP_KEY, String(Math.round(top))) } catch {}
}

function onQuickActionsPointerDown(event) {
  const trigger = event.target.closest?.('#quick-actions-trigger')
  if (!trigger || !usesDockedQuickActions()) return
  const root = document.getElementById('quick-actions')
  if (!root) return; root.dataset.docked = 'false'; const menu = document.getElementById('quick-actions-menu'); if (menu) menu.hidden = true; trigger.setAttribute('aria-expanded', 'false')
  dragState = { pointerId: event.pointerId, trigger, startY: event.clientY, startTop: root.getBoundingClientRect().top, moved: false }
  trigger.setPointerCapture?.(event.pointerId)
}

function onQuickActionsPointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return
  const delta = event.clientY - dragState.startY
  if (Math.abs(delta) < 6 && !dragState.moved) return
  dragState.moved = true
  event.preventDefault()
  const menu = document.getElementById('quick-actions-menu'); if (menu) menu.hidden = true; dragState.trigger.setAttribute('aria-expanded', 'false')
  placeQuickActions(dragState.startTop + delta)
}

function onQuickActionsPointerEnd(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return
  const state = dragState
  dragState = null
  state.trigger.releasePointerCapture?.(event.pointerId)
  if (!state.moved) return
  suppressTriggerClickUntil = performance.now() + 300
  requestAnimationFrame(() => { const root = document.getElementById('quick-actions'); if (root) saveQuickActionsTop(root.getBoundingClientRect().top); setTimeout(() => { if (document.getElementById('quick-actions-trigger')?.getAttribute('aria-expanded') === 'false') window.closeQuickActions() }, 1200) })
}

document.addEventListener('pointerdown', onQuickActionsPointerDown)
document.addEventListener('pointermove', onQuickActionsPointerMove, { passive: false })
document.addEventListener('pointerup', onQuickActionsPointerEnd)
document.addEventListener('pointercancel', onQuickActionsPointerEnd)
document.addEventListener('click', event => {
  if (performance.now() < suppressTriggerClickUntil && event.target.closest?.('#quick-actions-trigger')) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
}, true)
window.addEventListener('resize', () => placeQuickActions())
const appRoot = document.getElementById('app')
if (appRoot) new MutationObserver(() => placeQuickActions()).observe(appRoot, { childList: true, subtree: true })
