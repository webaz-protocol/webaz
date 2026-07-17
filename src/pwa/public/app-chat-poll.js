// 聊天详情实时轮询。renderChatDetail 只在进入/发消息时拉取消息(无实时推送),对方发来的消息原先停留会话时
//   看不到(只有通知那条独立轮询能提示)。这里每几秒拉一次会话,就地刷新 #chat-msgs:保持"已在底部则贴底"、
//   不碰输入框/快捷面板、查看时把新到消息标记已读。自清理:#chat-msgs 离开 DOM 或路由已不是本会话时立即停;
//   单计时器(window._chatPollTimer),重新进入任一会话先清旧的(不堆叠)。逻辑放独立文件因 app.js 已到 LOC 上限。后台/锁屏暂停,回前台由 app-poll-governor 经 _chatPollNow 补拉。
//   ⚠️ 用【最后一条消息 id】判变化,不能用消息条数——后端默认只返回最近 50 条(滑动窗口),长会话里新消息进来后
//      条数仍是 50,用 length 比较会永远判"无变化"而不刷新/不标已读(长会话恰是最需要 live update 的场景)。
window.startChatPoll = (id, initialMsgs) => {
  if (window._chatPollTimer) { clearInterval(window._chatPollTimer); window._chatPollTimer = null }
  const lastOf = (arr) => (arr && arr.length) ? String(arr[arr.length - 1].id || arr[arr.length - 1].created_at || '') : ''
  let last = lastOf(initialMsgs); const stop = () => { if (window._chatPollTimer) { clearInterval(window._chatPollTimer); window._chatPollTimer = null; window._chatPollNow = null } }
  const tickFn = async () => {
    const box = document.getElementById('chat-msgs')
    if (!box || !location.hash.includes('chat/' + id)) return stop()             // 已离开本会话 → 自清理
    if (document.hidden) return; let rr = null                                   // 后台/锁屏:暂停(定时器保留,回前台恢复)
    try { rr = await GET('/conversations/' + encodeURIComponent(id)) } catch { return }
    if (!rr || rr.error) return
    const msgs = rr.messages || []
    const newLast = lastOf(msgs)
    if (newLast === last) return                                                 // 最后一条没变 → 无新消息
    last = newLast
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
    box.innerHTML = msgs.length === 0
      ? `<div style="text-align:center;color:#9ca3af;padding:30px 0;font-size:12px">${t('开始第一句问候')}</div>`
      : msgs.map(m => window.renderChatBubble(m, state.user.id)).join('')
    if (atBottom) box.scrollTop = box.scrollHeight                               // 原本贴底就继续贴底,否则不打扰阅读位置
    POST('/conversations/' + encodeURIComponent(id) + '/read').catch(() => {})   // fire-and-forget:用 .catch 而非 try/catch(POST 返回 Promise,异步 reject 包不住)
  }
  window._chatPollTimer = setInterval(tickFn, 4000); window._chatPollNow = tickFn; if (!window._chatPollVisBound) { window._chatPollVisBound = true; document.addEventListener('visibilitychange', () => { if (!document.hidden && window._chatPollNow) window._chatPollNow() }) }
}
