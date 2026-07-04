// 轮询节流治理(第一刀,UI-only,零服务端改动)。治"手机挂后台整夜打接口"(Tina 案根因之一):
//   ① 信令按需化:无 P2P 活动时 3s → 60s(间隔仍 3s,gate 每 20 拍放行一次);收到信令/主动发 offer → 恢复 3s 快节奏 2 分钟。
//   ② 页面不可见(锁屏/切后台)→ 所有轮询暂停(信令/心跳/聊天各自查 gate 或 document.hidden);
//   ③ 回到前台 → 立即补拉一次信令+当前会话,并先快 30s 消化积压。
//   fail-open:app.js 侧写成 !window.pollGate || pollGate(...) —— 本文件没加载时一切维持旧 3s 行为。
;(function () {
  let fastUntil = 0, tick = 0
  const FAST_MS = 120_000, IDLE_EVERY = 20   // 3s × 20 = 60s 空闲节奏
  window.pollBoost = (ms) => { fastUntil = Date.now() + (ms || FAST_MS) }
  window.pollActivity = (kind, n) => { if (n > 0) window.pollBoost() }
  window.pollGate = (kind) => {
    if (document.hidden) return false                       // 后台/锁屏:暂停
    tick++
    return Date.now() < fastUntil || tick % IDLE_EVERY === 0
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    window.pollBoost(30_000)
    try { if (window._p2pSigTick) window._p2pSigTick() } catch {}     // 补拉信令
    try { if (window._chatPollNow) window._chatPollNow() } catch {}   // 补拉当前会话
  })
})()
