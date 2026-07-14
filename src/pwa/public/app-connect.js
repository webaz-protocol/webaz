// #connect — one-click "Connect WebAZ to any AI agent" onboarding page (P0 Distribution).
// Public (no login). Lowers the adoption barrier: the Remote MCP URL + copy-paste connect steps
// per client (Claude Code / Claude connector / ChatGPT / MCP Inspector / any SDK) + the STDIO
// alternative + anonymous-vs-Bearer. Self-contained (own copy helper); bilingual via t().
window.renderConnect = (app) => {
  const en = window._lang === 'en'
  const T = (zh, e) => (en ? e : zh)
  const MCP = 'https://webaz.xyz/mcp'
  const copy = (id, val) => `<div style="display:flex;gap:8px;align-items:stretch;margin:6px 0">
      <code id="${id}" style="flex:1;min-width:0;overflow-x:auto;white-space:nowrap;background:#0d1117;color:#e6edf3;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.5">${escHtml(val)}</code>
      <button onclick="connectCopy('${id}',this)" style="flex-shrink:0;background:#6366f1;color:#fff;border:none;border-radius:8px;padding:0 14px;font-size:12px;font-weight:600;cursor:pointer">${T('复制','Copy')}</button>
    </div>`
  const card = (icon, title, body) => `<div class="card" style="padding:14px;margin-bottom:12px">
      <div style="font-size:14px;font-weight:700;color:#18181b;margin-bottom:6px">${icon} ${title}</div>${body}</div>`

  app.innerHTML = shell(`
    <div style="max-width:640px;margin:0 auto;padding:8px 4px 40px">
      <div style="text-align:center;margin-bottom:20px">
        <div style="font-size:44px">🔌</div>
        <h1 style="font-size:clamp(24px,5vw,32px);font-weight:800;color:#18181b;margin:6px 0 4px">${T('把 WebAZ 接入任何 AI Agent','Connect WebAZ to any AI agent')}</h1>
        <p style="color:#71717a;font-size:14px;line-height:1.6;margin:0">${T('一个端点,任何 Agent。匿名即可浏览/搜索;写操作用 api_key。','One endpoint, every agent. Anonymous to browse/search; api_key for writes.')}</p>
      </div>

      <div class="card" style="padding:16px;margin-bottom:16px;background:linear-gradient(135deg,#eef2ff,#faf5ff);border-color:#c7d2fe">
        <div style="font-size:11px;font-weight:700;color:#4338ca;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:4px">${T('远程 MCP 连接地址','Remote MCP endpoint')}</div>
        ${copy('mcp-url', MCP)}
        <div style="font-size:11px;color:#6366f1;line-height:1.5">${T('Streamable HTTP · 无本地运行时的 Agent(ChatGPT / Claude 手机端 / 云端)直接连。','Streamable HTTP · agents with no local runtime (ChatGPT / Claude mobile / cloud) connect directly.')}</div>
      </div>

      ${card('⌨️', T('Claude Code(最快)','Claude Code (fastest)'), copy('cc', 'claude mcp add --transport http webaz https://webaz.xyz/mcp') + `<div style="font-size:12px;color:#71717a;line-height:1.5">${T('跑完对 Claude 说 “browse WebAZ products”。','Then tell Claude “browse WebAZ products”.')}</div>`)}
      ${card('🖥️', T('Claude 桌面 / 手机','Claude Desktop / mobile'), `<div style="font-size:12px;color:#3f3f46;line-height:1.7">${T('设置 → Connectors → 添加自定义连接器 → 粘贴上面的地址(鉴权留空 = 匿名浏览)。','Settings → Connectors → Add custom connector → paste the URL above (leave auth empty = anonymous browse).')}</div>`)}

      ${card('🤖', T('ChatGPT','ChatGPT'), `<div style="font-size:12px;color:#3f3f46;line-height:1.7">${T('设置 → Connectors →（开发者模式）添加自定义连接器 → 粘贴地址。','Settings → Connectors → (developer mode) Add custom connector → paste the URL.')}<br><span style="color:#b45309">${T('注意:需支持自定义连接器的套餐;连接器管理通常在网页/桌面端,手机 App 一般不暴露入口。','Note: needs a plan that allows custom connectors; connector management is usually web/desktop — the mobile app typically does not expose it.')}</span></div>`)}

      ${card('🔍', T('MCP Inspector(任意第三方测试)','MCP Inspector (any third-party test)'), copy('insp', 'npx @modelcontextprotocol/inspector') + `<div style="font-size:12px;color:#71717a;line-height:1.6">${T('Transport = Streamable HTTP · URL = 上面地址 · Auth = None。','Transport = Streamable HTTP · URL = the URL above · Auth = None.')}</div>`)}
      ${card('🐍', T('Python','Python'), copy('py', 'pip install webaz') + `<div style="font-size:12px;color:#71717a;line-height:1.6"><code style="background:#f4f4f5;padding:1px 5px;border-radius:4px;font-size:11px">async with WebAZ() as wz: await wz.browse()</code> ${T('· 匿名默认,api_key 交易。','· anonymous by default, api_key for writes.')}</div>`)}

      ${card('📦', T('本地 STDIO(需要本地进程时)','Local STDIO (when you run a local process)'), copy('stdio', 'npx -y @seasonkoh/webaz') + `<div style="font-size:12px;color:#71717a;line-height:1.5">${T('与远程同一套 42 个工具面。','Same 42-tool surface as remote.')}</div>`)}

      <div class="card" style="padding:14px;margin-bottom:12px;background:#f0fdf4;border-color:#bbf7d0">
        <div style="font-size:13px;font-weight:700;color:#166534;margin-bottom:4px">🔓 ${T('匿名试一下(无需登录)','Try it anonymously (no login)')}</div>
        ${copy('curl', `curl -s ${MCP} -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`)}
      </div>

      <div style="font-size:12px;color:#71717a;line-height:1.7;text-align:center;margin-top:8px">
        ${T('写操作(下单/上架)加请求头','For writes (order/list) add')} <code style="background:#f4f4f5;padding:1px 6px;border-radius:4px;font-size:11px">Authorization: Bearer &lt;api_key&gt;</code> · <a href="${window._invited ? '#me' : '#welcome'}" style="color:#6366f1;text-decoration:underline">${T('申请邀请获取 api_key','Request an invite for an api_key')}</a><br>
        <a href="/docs/REMOTE-MCP.md" style="color:#6366f1;text-decoration:underline">${T('完整接入文档','Full connect docs')} →</a>
      </div>
    </div>
  `, 'discover', { hideTabbar: false })
}

window.connectCopy = (id, btn) => {
  const el = document.getElementById(id)
  if (!el) return
  const txt = el.textContent || ''
  navigator.clipboard?.writeText(txt).then(() => {
    const o = btn.textContent; btn.textContent = '✓'; setTimeout(() => { btn.textContent = o }, 1200)
  }).catch(() => {})
}
