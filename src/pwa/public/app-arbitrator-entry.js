// PR-E:仲裁能力入口/按钮跟随后端 can_arbitrate(= active arbitrator_whitelist),不再看 user.role。
//   前端仅 UX 跟随;真正的安全边界在后端(isEligibleArbitrator + assigned/claim + COI)。boot 时拉一次,
//   suspended/revoked/role-only → can_arbitrate=false → 不显示入口/按钮;whitelist-only(role=buyer)→ true。
window.arbEntryHydrate = async () => {
  const before = state.canArbitrate   // PR-F fix:入口不 await(不阻塞 boot),状态回来若首次变 true → 重渲染当前页,让首屏也出现入口
  try { const s = await GET('/arbitrator/status'); state.canArbitrate = !!(s && s.can_arbitrate); state.arbitratorStatus = (s && s.arbitrator_status) || 'none' }
  catch { state.canArbitrate = false; state.arbitratorStatus = 'none' }   // active / suspended / revoked / none
  if (state.canArbitrate && !before && typeof route === 'function') route()   // 仅"变为可仲裁"时重渲染;非仲裁员(恒 false)不触发
}
