// 聊天详情实时轮询。renderChatDetail 只在进入/发消息时拉取消息(无实时推送),所以对方发来的消息
//   原先停留在会话里时看不到(只有通知那条独立轮询能提示)。这里每几秒拉一次会话,就地刷新 #chat-msgs:
//   保持"已在底部则继续贴底"、绝不触碰输入框/快捷面板、在查看时把新到消息标记已读。
//   自清理:#chat-msgs 离开 DOM 或路由已不是本会话时,计时器立即停止。单计时器(window._chatPollTimer),
//   重新进入任一会话都会先清掉旧的(不堆叠)。逻辑放独立文件因 app.js 已到 LOC 上限(净零纪律)。
window.startChatPoll = (id, initialCount) => {
  if (window._chatPollTimer) { clearInterval(window._chatPollTimer); window._chatPollTimer = null }
  let count = Number(initialCount) || 0
  const stop = () => { if (window._chatPollTimer) { clearInterval(window._chatPollTimer); window._chatPollTimer = null } }
  window._chatPollTimer = setInterval(async () => {
    const box = document.getElementById('chat-msgs')
    if (!box || !location.hash.includes('chat/' + id)) return stop()        // 已离开本会话 → 自清理
    let rr = null
    try { rr = await GET('/conversations/' + encodeURIComponent(id)) } catch { return }
    if (!rr || rr.error) return
    const msgs = rr.messages || []
    if (msgs.length === count) return                                       // 没有新消息
    count = msgs.length
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
    box.innerHTML = msgs.length === 0
      ? `<div style="text-align:center;color:#9ca3af;padding:30px 0;font-size:12px">${t('开始第一句问候')}</div>`
      : msgs.map(m => window.renderChatBubble(m, state.user.id)).join('')
    if (atBottom) box.scrollTop = box.scrollHeight                          // 原本贴底就继续贴底,否则不打扰用户阅读位置
    try { POST('/conversations/' + encodeURIComponent(id) + '/read') } catch {}
  }, 4000)
}
