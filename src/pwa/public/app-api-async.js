// P0-A A4 — 读/写分离超时助手(从 app.js 拆出:ratchet 上限,新代码禁回塞 app.js)。永不永久 loading。
//   经典脚本全局:window.apiRead / window.apiWriteIdempotent;globals(state/window._lang)调用时解析。
;(function () {
  // READ:带 AbortSignal.timeout(超时 = 明确失败态,可安全重试,读幂等)。返回判别态,调用方据此渲染
  //   loading→ready/timeout/network_error/unauthorized,而不是把 promise 挂死。
  window.apiRead = async function (path, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 12000
    const headers = { 'Content-Type': 'application/json', 'Accept-Language': window._lang === 'en' ? 'en' : 'zh', ...(state.apiKey ? { Authorization: `Bearer ${state.apiKey}` } : {}) }
    try {
      const res = await fetch('/api' + path, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })
      const data = await res.json().catch(() => ({}))
      return { ok: res.ok, status: res.status, data, timedOut: false, networkError: false }
    } catch (e) {
      const timedOut = !!(e && (e.name === 'TimeoutError' || e.name === 'AbortError'))
      return { ok: false, status: 0, data: null, timedOut, networkError: !timedOut }   // 0 = 未收到响应(超时/网络);绝不永久等待
    }
  }
  // WRITE(幂等):前端 timeout ≠ 服务端未执行。超时/网络中断 → unknownOutcome=true,调用方必须【查询原请求状态和解】,
  //   【绝不盲目重试】—— 重试可能造成重复审批/重复订单/重复扣款。
  window.apiWriteIdempotent = async function (method, path, body, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 15000
    const headers = { 'Content-Type': 'application/json', 'Accept-Language': window._lang === 'en' ? 'en' : 'zh', ...(state.apiKey ? { Authorization: `Bearer ${state.apiKey}` } : {}), ...((opts && opts.headers) || {}) }
    try {
      const res = await fetch('/api' + path, { method, headers, signal: AbortSignal.timeout(timeoutMs), ...(body != null ? { body: JSON.stringify(body) } : {}) })
      const data = await res.json().catch(() => ({}))
      return { ok: res.ok, status: res.status, data, unknownOutcome: false }
    } catch (e) {
      const timedOut = !!(e && (e.name === 'TimeoutError' || e.name === 'AbortError'))
      return { ok: false, status: 0, data: null, unknownOutcome: true, timedOut, networkError: !timedOut }   // 结果未知 → 调用方 reconcile,不盲重试
    }
  }
})()
