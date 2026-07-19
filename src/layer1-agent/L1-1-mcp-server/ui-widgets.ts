/**
 * MCP UI PR-4..6 + PR-A — MCP App widgets(双轨:ChatGPT legacy skybridge + 标准 MCP Apps)。
 *
 * 纪律(spike 定稿 + PR-A):自包含单文件(宿主 CSP 内零外联);一切文本经 textContent(卖家可控标题,
 * 绝不 innerHTML);本地交互(展开/排序/选择/比较)零模型调用;跨 MCP 动作只走宿主桥且逐个能力探测,
 * 缺失即优雅降级为提示文案;经济动作(报价→草稿→提交)只提交审批请求,正式建单永远发生在
 * webaz.xyz 的 Passkey(widget 绝不直达钱路)。v1 无商品图(CSP deny-by-default,图片面另开任务)。
 *
 * PR-A 双轨(capability-driven,零 host 名判断):
 *   - legacy HTML(*.html,text/html+skybridge):window.openai 直连 —— 与 PR-4..6 生产行为一致,
 *     仅两处外科变更:①sendFollowUpCompat(sendFollowUpMessage 优先、sendFollowupTurn 降级、单发)
 *     ②openWebaz(URL 解析后 https + 精确主机 webaz.xyz + 默认端口 + 无 userinfo 才放行)。
 *   - standard HTML(*-mcp.html,text/html;profile=mcp-app):标准 ui/* postMessage JSON-RPC 桥
 *     (SEP-1865 spec 2026-01-26:ui/initialize 三步握手 → ui/notifications/tool-result 携带
 *     CallToolResult 渲染;tools/call / ui/open-link {url} / ui/message {role:'user',content});
 *     握手超时则降级 window.openai(覆盖"宿主用标准键指到本资源但只提供 openai 桥"的过渡态),
 *     两者皆无 → 只读渲染。单桥原则:握手成败一次定桥,绝不双桥同听。
 *   - 两个资源共享同一 render 体(同一份组件业务代码),只有 boot 不同。
 */

// ─── 共享主题 tokens(PR-0 深色修复)──────────────────────────────────────────────────────────
// 生产事故(2026-07-18 截图):ChatGPT 深色主题下 UA 把 form 控件按 color-scheme:dark 渲染成浅色字,
// 而我们只写了浅色背景没写字色 → 排序按钮白底白字不可见;.note/.meta 深灰字打在深色页面上不可辨。
// 修法:全部颜色 token 化 + 三层主题信号(prefers-color-scheme 媒体查询为默认;宿主可经
// window.openai.theme / 标准桥宿主上下文盖 data-theme,两方向都赢);按钮显式 color 永不依赖 UA。
const WIDGET_THEME_CSS = `
:root{color-scheme:light dark;
 --bg:#fff;--line:#d6dae2;--ink:#1c2330;--sub:#5b6472;--ok:#0a7d4f;--warn:#a15c00;--price:#0a7d4f;
 --chip-bg:#eef1f6;--chip-warn-bg:#fff3e0;--btn-bg:#f7f8fa;--btn-ink:#1c2330;
 --accent-bg:#eef2ff;--accent-line:#93a3f5;--accent-ink:#2b3a8f;
 --warnbox-bg:#fff7e0;--warnbox-line:#e5c268;--warnbox-ink:#7a5200;--row-ink:#374151}
@media (prefers-color-scheme: dark){:root{
 --bg:#1d232e;--line:#3a4150;--ink:#e8ebf0;--sub:#a3adbb;--ok:#4cc38a;--warn:#e0a458;--price:#4cc38a;
 --chip-bg:#2a3140;--chip-warn-bg:#3d3322;--btn-bg:#262d3a;--btn-ink:#e8ebf0;
 --accent-bg:#232b45;--accent-line:#5b6bd6;--accent-ink:#aab6ff;
 --warnbox-bg:#332b18;--warnbox-line:#6b5a2a;--warnbox-ink:#e5c268;--row-ink:#c6cdd8}}
:root[data-theme="dark"]{
 --bg:#1d232e;--line:#3a4150;--ink:#e8ebf0;--sub:#a3adbb;--ok:#4cc38a;--warn:#e0a458;--price:#4cc38a;
 --chip-bg:#2a3140;--chip-warn-bg:#3d3322;--btn-bg:#262d3a;--btn-ink:#e8ebf0;
 --accent-bg:#232b45;--accent-line:#5b6bd6;--accent-ink:#aab6ff;
 --warnbox-bg:#332b18;--warnbox-line:#6b5a2a;--warnbox-ink:#e5c268;--row-ink:#c6cdd8}
:root[data-theme="light"]{
 --bg:#fff;--line:#d6dae2;--ink:#1c2330;--sub:#5b6472;--ok:#0a7d4f;--warn:#a15c00;--price:#0a7d4f;
 --chip-bg:#eef1f6;--chip-warn-bg:#fff3e0;--btn-bg:#f7f8fa;--btn-ink:#1c2330;
 --accent-bg:#eef2ff;--accent-line:#93a3f5;--accent-ink:#2b3a8f;
 --warnbox-bg:#fff7e0;--warnbox-line:#e5c268;--warnbox-ink:#7a5200;--row-ink:#374151}
button{color:var(--btn-ink)}
`
// 宿主主题探测(能力探测,零 host 名):ChatGPT 暴露只读 window.openai.theme('light'|'dark')。
const WIDGET_THEME_JS = `
  try{ var __th = window.openai && window.openai.theme; if(__th==='dark'||__th==='light') document.documentElement.setAttribute('data-theme', __th) }catch(e){}
`

// ─── 共享运行时片段(注入两轨)────────────────────────────────────────────────────────────────

// compat 分两片按需注入:CORE(会话流兼容 + 防重)所有组件都要;LINK(deep-link 安全)只给有
// openExternal 面的组件 —— ProductResults 保持"零 URL/零 href 词元"的最强自包含锁不被稀释。
const WIDGET_COMPAT_CORE_JS = `
  function canFollowUp(oai){ return !!oai&&(typeof oai.sendFollowUpMessage==='function'||typeof oai.sendFollowupTurn==='function') }
  function sendFollowUpCompat(oai,text){
    if(!oai) return false
    if(typeof oai.sendFollowUpMessage==='function'){ oai.sendFollowUpMessage({prompt:text}); return true }
    if(typeof oai.sendFollowupTurn==='function'){ oai.sendFollowupTurn({prompt:text}); return true }
    return false
  }
  function onceGuard(fn,ms){ var busy=false; return function(){ if(busy)return; busy=true; try{ fn.apply(null,arguments) }finally{ setTimeout(function(){busy=false},ms||1500) } } }
`
// openExternal 安全:仅放行 https + 精确主机 webaz.xyz + 默认端口 + 无 userinfo(URL 解析后逐字段
// 比较,拒 javascript:/data:/协议相对/用户名注入);deep link 只由调用点从服务端权威字段构造。
const WIDGET_COMPAT_LINK_JS = `
  function safeWebazHref(h){ try{ var u=new URL(String(h)); if(u.protocol==='https:'&&u.hostname==='webaz.xyz'&&u.port===''&&u.username===''&&u.password==='') return u.href }catch(e){} return null }
  function openWebaz(oai,href){ var h=safeWebazHref(href); if(!h) return false; if(oai&&typeof oai.openExternal==='function'){ oai.openExternal({href:h}); return true } return false }
`

// legacy boot:与 PR-4..6 生产行为逐语义一致(window.openai 同步读 toolOutput)。
const WIDGET_BOOT_LEGACY_JS = `
  var __oai = window.openai || {}
  renderBody(__oai, __oai.toolOutput || null)
`

// standard boot:SEP-1865 ui/* 桥。握手成功 → 标准 facade(oai 形状兼容 render 体);
// 超时/失败 → window.openai;再无 → 只读(空 facade,能力探测全 false)。
const WIDGET_BRIDGE_STANDARD_JS = `
  function makeStandardBridge(onToolResult){
    var pending={}, seq=0, hostOrigin=null, closed=false
    function post(msg){ try{ window.parent.postMessage(msg, hostOrigin||'*') }catch(e){} }
    function onMsg(e){
      if(closed) return
      if(e.source!==window.parent) return
      var m=e.data
      if(!m||typeof m!=='object'||m.jsonrpc!=='2.0') return
      if(hostOrigin===null) hostOrigin=e.origin
      else if(e.origin!==hostOrigin) return
      if(m.id!=null&&pending[m.id]){ var p=pending[m.id]; delete pending[m.id]; if(m.error)p.rej(m.error); else p.res(m.result); return }
      if(m.method==='ui/notifications/tool-result'&&m.params) onToolResult(m.params)
    }
    function request(method,params){ return new Promise(function(res,rej){ var id=++seq; pending[id]={res:res,rej:rej}; post({jsonrpc:'2.0',id:id,method:method,params:params}) }) }
    window.addEventListener('message',onMsg)
    return {
      connect:function(timeoutMs){
        var to=new Promise(function(_,rej){ setTimeout(function(){ rej(new Error('bridge timeout')) },timeoutMs) })
        return Promise.race([request('ui/initialize',{appInfo:{name:'webaz-widget',version:'1.0'},appCapabilities:{},protocolVersion:'2026-01-26'}),to])
          .then(function(r){ post({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}}); return r })
          .catch(function(err){ closed=true; window.removeEventListener('message',onMsg); throw err })
      },
      callTool:function(n,a){ return request('tools/call',{name:n,arguments:a||{}}) },
      openLink:function(url){ return request('ui/open-link',{url:url}) },
      sendMessage:function(text){ return request('ui/message',{role:'user',content:{type:'text',text:String(text)}}) },   // 2026-01-26 冻结版:content = 单 ContentBlock(Codex R1-1)
    }
  }
`
const WIDGET_BOOT_STANDARD_JS = `
  var __facade=null
  function __onToolResult(r){ if(r&&r.structuredContent) renderBody(__facade, r.structuredContent) }
  var __br=makeStandardBridge(__onToolResult)
  __br.connect(600).then(function(){
    __facade={
      // 单渲染源(Codex R1-2):规范要求宿主对【一切】完成的工具执行统一发 ui/notifications/tool-result
      // (含 view 发起的),渲染只走通知路径 —— response 不重复渲染,消除双渲染/乱序覆盖。
      callTool:function(n,a){ __br.callTool(n,a).catch(function(){}) },
      openExternal:function(o){ var u=o&&o.href; var h=(typeof safeWebazHref==='function')?safeWebazHref(u):null; if(h) __br.openLink(h).catch(function(){}) },
      sendFollowUpMessage:function(o){ __br.sendMessage((o&&o.prompt)||'').catch(function(){}) },
    }
    // 初始数据经 ui/notifications/tool-result 到达(握手完成前宿主不得发送)—— 保持 loading 文案等待。
  }).catch(function(){
    var w=window.openai
    if(w){ __facade=w; renderBody(w, w.toolOutput||null) }
    else { renderBody({}, null) }
  })
`

function buildWidgetHtml(opts: { style: string; loading: string; bodyJs: string; standard: boolean; link: boolean }): string {
  const compat = WIDGET_COMPAT_CORE_JS + (opts.link ? WIDGET_COMPAT_LINK_JS : '')
  const bridge = opts.standard ? WIDGET_BRIDGE_STANDARD_JS : ''
  const boot = opts.standard ? WIDGET_BOOT_STANDARD_JS : WIDGET_BOOT_LEGACY_JS
  return `<!doctype html><html><head><meta charset="utf-8"><style>${WIDGET_THEME_CSS}${opts.style}</style></head><body>
<div id="root">${opts.loading}</div>
<script>
(function(){
  'use strict'
${WIDGET_THEME_JS}
${compat}
${bridge}
${opts.bodyJs}
${boot}
})();
</script></body></html>`
}

// ─── ProductResults ───────────────────────────────────────────────────────────────────────────
// 渲染 webaz_search 的三种 structuredContent 形态:①搜索/浏览页(webaz.product_search.model.v1:
// products+sellers+next_cursor+result_handle)②0 命中(found:0 + recovery.catalog_sample)
// ③按需详情(webaz.product_detail.model.v1)。

const PRODUCT_RESULTS_STYLE = `
body{font-family:system-ui,sans-serif;margin:0;padding:10px;color:var(--ink);background:transparent}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.bar button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer}
.bar button.on{background:var(--accent-bg);border-color:var(--accent-line);color:var(--accent-ink)}
.grid{display:flex;gap:10px;flex-wrap:wrap}
.card{border:1px solid var(--line);border-radius:12px;padding:12px 14px;width:210px;background:var(--bg);display:flex;flex-direction:column;gap:6px}
.card b{font-size:13px;line-height:1.35;display:block;min-height:2.6em}
.price{color:var(--price);font-weight:700;font-size:15px}
.chips{display:flex;gap:4px;flex-wrap:wrap}
.chip{font-size:10px;border-radius:6px;padding:1px 6px;background:var(--chip-bg);color:var(--sub)}
.chip.warn{background:var(--chip-warn-bg);color:var(--warn)}
.meta{font-size:11px;color:var(--sub)}
.card .more{font-size:11px;color:var(--sub);display:none;border-top:1px dashed var(--line);padding-top:6px}
.card.open .more{display:block}
.row{display:flex;gap:6px;margin-top:auto}
.row button{flex:1;border:1px solid var(--line);background:var(--btn-bg);color:var(--btn-ink);border-radius:8px;padding:4px 6px;font-size:11px;cursor:pointer}
.row button.primary{background:#4f46e5;color:#fff;border-color:transparent;font-weight:600}
.row button:disabled{opacity:.6;cursor:default}
.cmp{margin-top:12px;border-top:1px solid var(--line);padding-top:8px;font-size:12px;display:none}
.cmp table{border-collapse:collapse;width:100%}
.cmp td,.cmp th{border:1px solid var(--line);padding:3px 6px;text-align:left;font-size:11px}
.note{font-size:11px;color:var(--sub);margin-top:10px}`

export const PRODUCT_RESULTS_BODY_JS = `
var __lastSearch=null   // B1:缓存上一次搜索页 out —— 供详情页【← 返回列表】原地回退,不再固定住
function renderBody(oai, out){
  oai = oai || {}
  var root = document.getElementById('root')
  function el(tag, cls, text){ var n=document.createElement(tag); if(cls)n.className=cls; if(text!=null)n.textContent=String(text); return n }
  if(!out){ root.textContent='WebAZ: no structured payload visible to this widget.'; return }

  // ③详情形态 —— 完整描述/规格(卡内不可得,按需经 tool 拉取);顶部【← 返回列表】回到搜索页(修"固定住/回不去")。
  if(out.schema_version==='webaz.product_detail.model.v1'){
    root.textContent=''
    if(__lastSearch){ var back=el('button',null,'← 返回列表'); back.addEventListener('click',function(){ renderBody(oai, __lastSearch) }); root.appendChild(back) }
    var dg=el('div','grid')
    ;(out.products||[]).forEach(function(p){
      var c=el('div','card open')
      c.appendChild(el('b',null,p.title||p.id))
      c.appendChild(el('div','price',(p.price&&p.price.display)||''))
      var m=el('div','more'); m.style.display='block'
      m.appendChild(el('div',null,p.description||'')); if(p.description_truncated) m.appendChild(el('div','meta','…(截断,完整描述见商品页)'))
      if(p.specs){ try{ Object.keys(p.specs).forEach(function(k){ m.appendChild(el('div','meta',k+': '+p.specs[k])) }) }catch(e){} }
      m.appendChild(el('div','meta','退货 '+(p.return_days!=null?p.return_days+'天':'—')+' · 保修 '+(p.warranty_days!=null?p.warranty_days+'天':'—')+' · 发货 '+(p.handling_hours!=null?p.handling_hours+'h':'—')))
      c.appendChild(m); dg.appendChild(c)
    })
    if(out.unavailable_ids&&out.unavailable_ids.length) dg.appendChild(el('div','meta','已不可购: '+out.unavailable_ids.join(', ')))
    root.appendChild(dg); return
  }

  var products=(out.products||[]).slice()
  // ②0 命中
  if(!products.length){
    root.textContent=''
    root.appendChild(el('div',null,'精确匹配 0 命中(WebAZ 搜索是协议级严格匹配)。'))
    var rec=out.recovery||{}
    if(rec.catalog_sample&&rec.catalog_sample.length){
      root.appendChild(el('div','note','以下是目录样本(非搜索结果):'))
      var g0=el('div','grid')
      rec.catalog_sample.forEach(function(p){ var c=el('div','card'); c.appendChild(el('b',null,p.title||p.id)); c.appendChild(el('div','price',p.price_display||(p.price!=null?p.price+' USDC':''))); g0.appendChild(c) })
      root.appendChild(g0)
    }
    return
  }

  // ①搜索页
  __lastSearch = out   // B1:缓存供详情页【返回列表】原地回退
  var sellers=out.sellers||{}
  var state={sort:'default',selected:{},open:{}}
  function toggleOpen(id){
    var wasOpen=!!state.open[id]
    if(!wasOpen && (window.innerWidth||999)<640){ state.open={} }   // B1:手机端一次只展开一张
    state.open[id]=!wasOpen; render()
    if(state.open[id]){ try{ var tn=root.querySelector('[data-pid="'+String(id).replace(/[^a-zA-Z0-9_.:-]/g,'')+'"]'); if(tn) tn.scrollIntoView({behavior:'smooth',block:'start'}) }catch(e){} }   // B1:点开滚到卡顶
  }
  function render(){
    var __sy=(window.pageYOffset||0)
    root.textContent=''
    var bar=el('div','bar')
    ;[['default','默认'],['price_asc','价格↑'],['price_desc','价格↓']].forEach(function(s){
      var b=el('button',state.sort===s[0]?'on':null,s[1])
      b.addEventListener('click',function(){ state.sort=s[0]; render() })   // 本地排序,零模型调用
      bar.appendChild(b)
    })
    if(out.next_cursor&&typeof oai.callTool==='function'){
      var more=el('button',null,'下一页')
      more.addEventListener('click',onceGuard(function(){ oai.callTool('webaz_search',{cursor:out.next_cursor,limit:5}) }))
      bar.appendChild(more)
    }
    root.appendChild(bar)
    var list=products.slice()
    var priceOf=function(p){ return (p.price&&p.price.amount_minor)||0 }
    if(state.sort==='price_asc') list.sort(function(a,b){return priceOf(a)-priceOf(b)})
    if(state.sort==='price_desc') list.sort(function(a,b){return priceOf(b)-priceOf(a)})
    var g=el('div','grid')
    list.forEach(function(p){
      var isOpen=!!state.open[p.id]
      var c=el('div','card'+(isOpen?' open':''))
      c.setAttribute('data-pid', String(p.id))
      var __ti=el('b',null,p.title||p.id); __ti.style.cursor='pointer'
      __ti.addEventListener('click',function(){ toggleOpen(p.id) })   // B1:基本信息可点击展开/收起
      c.appendChild(__ti)
      c.appendChild(el('div','price',(p.price&&p.price.display)||''))
      var fx=out.fx&&out.fx.rates
      if(fx&&p.price&&p.price.amount_minor!=null){
        var usd=p.price.amount_minor/1000000, approx=[]
        if(fx.SGD) approx.push('S$'+(usd*fx.SGD).toFixed(2))
        if(fx.CNY) approx.push('¥'+(usd*fx.CNY).toFixed(2))
        if(approx.length) c.appendChild(el('div','meta','≈ '+approx.join(' · ')+(out.fx.stale?'(近似汇率)':'')))
      }
      var chips=el('div','chips')
      if(p.stock_status&&p.stock_status!=='in_stock') chips.appendChild(el('span','chip warn',p.stock_status==='low_stock'?'库存少':'缺货'))
      ;(p.decision_flags||[]).forEach(function(f){ chips.appendChild(el('span','chip'+(f.severity==='warning'?' warn':''),f.label||f.code)) })
      c.appendChild(chips)
      var seller=sellers[p.seller_ref]||{}
      c.appendChild(el('div','meta',(seller.name||'')+' · 已售 '+(p.sales_count||0)))
      var m=el('div','more')
      m.appendChild(el('div',null,p.summary||''))
      m.appendChild(el('div','meta','退货 '+(p.return_days!=null?p.return_days+'天':'—')+' · 保修 '+(p.warranty_days!=null?p.warranty_days+'天':'—')+' · 发货 '+(p.handling_hours!=null?p.handling_hours+'h':'—')+' · 预计送达 '+(p.estimated_days!=null?String(p.estimated_days):'—')))
      c.appendChild(m)
      var row=el('div','row')
      var ex=el('button',null,isOpen?'收起':'展开')
      ex.addEventListener('click',function(){ toggleOpen(p.id) })   // B1:展开/收起(状态持久,render 后恢复)
      row.appendChild(ex)
      if(out.result_handle&&typeof oai.callTool==='function'){
        var dt=el('button',null,'详情')
        dt.addEventListener('click',onceGuard(function(){ oai.callTool('webaz_search',{result_handle:out.result_handle,selected_ids:[p.id]}) }))
        row.appendChild(dt)
      }
      // B2:主按钮【准备下单】—— 一键发起 报价→草稿→提交审批,终点你 Passkey 批准。
      //   widget 绝不直达钱路/不建正式订单/不动资金:webaz_quote_order 只读(不扣款/不锁库存),草稿与提交仍在会话流+服务端,
      //   正式建单永远发生在人类 Passkey 批准路径。点击即 disabled 防误触;幂等由服务端 intent_hash 唯一索引兜底(重复 submit 返原请求)。
      var pd=el('button','primary','准备下单')
      pd.addEventListener('click',onceGuard(function(){
        pd.disabled=true; pd.textContent='准备中…(报价→草稿→审批)'
        if(typeof oai.callTool==='function'){ oai.callTool('webaz_quote_order',{product_id:p.id,quantity:1}) }
        else if(!sendFollowUpCompat(oai,'请为该商品准备下单(数量 1):webaz_quote_order→webaz_order_draft→webaz_submit_order_request,最终由我 Passkey 批准。product_id='+p.id)){ pd.textContent='请在对话里说:为 '+p.id+' 准备下单'; pd.disabled=false }
      }))
      row.appendChild(pd)
      var sel=el('button',null,state.selected[p.id]?'已选✓':'比较')
      sel.addEventListener('click',function(){ state.selected[p.id]=!state.selected[p.id]; render() })   // 本地选择
      row.appendChild(sel)
      c.appendChild(row)
      g.appendChild(c)
    })
    root.appendChild(g)
    var chosen=list.filter(function(p){return state.selected[p.id]})
    if(chosen.length>=2){
      var cmp=el('div','cmp'); cmp.style.display='block'
      var t=document.createElement('table')
      var head=document.createElement('tr')
      ;['商品','价格','退货','保修','发货','已售'].forEach(function(h){ head.appendChild(el('th',null,h)) })
      t.appendChild(head)
      chosen.forEach(function(p){
        var tr=document.createElement('tr')
        ;[p.title,(p.price&&p.price.display)||'',p.return_days!=null?p.return_days+'天':'—',p.warranty_days!=null?p.warranty_days+'天':'—',p.handling_hours!=null?p.handling_hours+'h':'—',p.sales_count||0].forEach(function(v){ tr.appendChild(el('td',null,v)) })
        t.appendChild(tr)
      })
      cmp.appendChild(t); root.appendChild(cmp)
    }
    root.appendChild(el('div','note','报价不会扣款 · 草稿不锁库存 · 正式下单需你在 webaz.xyz 用 Passkey 批准 · ≈ 法币换算仅显示参考,非结算'))
    try{ window.scrollTo(0, __sy) }catch(e){}   // B1:render 后恢复滚动位置(排序/比较/收起不跳顶)
  }
  render()
}`

// ─── QuoteAndApproval ─────────────────────────────────────────────────────────────────────────
// 渲染 quote / draft / approval 三形态(webaz.order_quote|order_draft|order_approval .model.v1)。
// 创建草稿与提交审批 = callTool(不扣款/不锁库存/幂等 + 重复购买保护);正式建单只发生在 webaz.xyz
// 的 Passkey 批准。duplicate_warning 渲染为显式警告卡,绝不静默二次创建。

const QUOTE_APPROVAL_STYLE = `
body{font-family:system-ui,sans-serif;margin:0;padding:12px;color:var(--ink);background:transparent}
.box{border:1px solid var(--line);border-radius:12px;padding:14px 16px;max-width:420px;background:var(--bg)}
.h{font-size:14px;font-weight:700;margin-bottom:8px}
.price{color:var(--price);font-weight:800;font-size:20px}
.fiat{color:var(--sub);font-size:13px}
.row{display:flex;justify-content:space-between;font-size:12px;padding:2px 0;color:var(--row-ink)}
.sec{border-top:1px dashed var(--line);margin-top:8px;padding-top:8px}
.meta{font-size:11px;color:var(--sub)}
.warn{background:var(--warnbox-bg);border:1px solid var(--warnbox-line);border-radius:10px;padding:10px 12px;font-size:12px;color:var(--warnbox-ink);margin-top:10px}
.btn{display:block;width:100%;margin-top:10px;border:1px solid var(--accent-line);background:var(--accent-bg);border-radius:10px;padding:8px;font-size:13px;font-weight:600;cursor:pointer;color:var(--accent-ink)}
.toggle{font-size:11px;color:var(--sub);cursor:pointer;text-decoration:underline;margin-top:6px;display:inline-block}
.hide{display:none}
.disc{font-size:11px;color:var(--warnbox-ink);margin-top:10px;line-height:1.5}
.ok{color:var(--ok)}`

const QUOTE_APPROVAL_BODY_JS = `
function renderBody(oai, out){
  oai = oai || {}
  var root = document.getElementById('root')
  function el(t,c,x){ var n=document.createElement(t); if(c)n.className=c; if(x!=null)n.textContent=String(x); return n }
  function row(box,k,v){ var r=el('div','row'); r.appendChild(el('span',null,k)); r.appendChild(el('span',null,v)); box.appendChild(r) }
  function toggler(box,label,build){ var tg=el('span','toggle',label); var body=el('div','sec hide'); build(body); tg.addEventListener('click',function(){ body.classList.toggle('hide') }); box.appendChild(tg); box.appendChild(body) }
  function fiatLine(box,fe){ if(!fe)return; var f=el('div','fiat',fe.display+(fe.stale?'(近似汇率)':'')); box.appendChild(f) }
  function disclosures(box,list){ var d=el('div','disc',(list||[]).join(' · ')); box.appendChild(d) }
  root.textContent=''
  if(!out||!out.schema_version){ root.textContent='WebAZ: no structured payload visible to this widget.'; return }
  var box=el('div','box'); root.appendChild(box)
  var sv=String(out.schema_version)

  if(sv==='webaz.order_quote.model.v1'){
    box.appendChild(el('div','h','报价 · '+((out.product&&out.product.title)||'')+' ×'+(out.quantity||1)))
    box.appendChild(el('div','price',(out.price&&out.price.display)||''))
    fiatLine(box,out.fiat_estimate)
    var a=out.amounts||{}
    toggler(box,'展开费用明细',function(b){ row(b,'商品金额',(a.item/1000000).toFixed(2)+' USDC'); row(b,'运费',(a.shipping/1000000).toFixed(2)+' USDC'); row(b,'其他费用',(a.other/1000000).toFixed(2)+' USDC'); row(b,'总价',(out.price.amount_minor/1000000).toFixed(2)+' USDC') })
    var s=out.shipping||{}
    row(box,'配送',(out.destination&&out.destination.summary)||'')
    row(box,'发货时限',s.handling_hours!=null?s.handling_hours+'h':'—')
    row(box,'预计送达',s.estimated_days!=null?String(s.estimated_days):'—')
    toggler(box,'展开退货与保修',function(b){ row(b,'退货期',out.return_days!=null?out.return_days+'天':'—'); row(b,'保修',out.warranty_days!=null?out.warranty_days+'天':'—') })
    row(box,'支付轨道',String(out.payment_rail||'escrow'))
    toggler(box,'展开风险与轨道说明',function(b){ b.appendChild(el('div','meta',out.rail_note||'')) })
    if(out.fiat_estimate) toggler(box,'查看汇率时间',function(b){ b.appendChild(el('div','meta','1 USD ≈ '+out.fiat_estimate.rate+' '+out.fiat_estimate.currency+' @ '+(out.fiat_estimate.as_of||'')+(out.fiat_estimate.stale?'(近似)':''))) })
    row(box,'报价到期',String(out.expires_at||''))
    row(box,'库存','未锁定(下单时重新校验)')
    if(out.quote_token&&typeof oai.callTool==='function'){
      var b1=el('button','btn','创建订单草稿(不扣款)')
      b1.addEventListener('click',onceGuard(function(){ b1.disabled=true; oai.callTool('webaz_order_draft',{action:'create',quote_token:out.quote_token}) }))
      box.appendChild(b1)
    }
    disclosures(box,out.disclosures)
  } else if(sv==='webaz.order_draft.model.v1'){
    if(Array.isArray(out.drafts)){ box.appendChild(el('div','h','订单草稿列表')); out.drafts.forEach(function(d){ row(box,String(d.draft_id).slice(0,10)+'…',d.status+' · '+((d.price&&d.price.display)||'')) }); return }
    box.appendChild(el('div','h','订单草稿 · '+String(out.draft_id||'').slice(0,10)+'…'))
    row(box,'状态',String(out.status||''))
    row(box,'商品',((out.product&&out.product.title)||'')+' ×'+(out.quantity||1))
    box.appendChild(el('div','price',(out.price&&out.price.display)||''))
    fiatLine(box,out.fiat_estimate)
    row(box,'配送',(out.destination&&out.destination.summary)||'')
    row(box,'支付轨道',String(out.payment_rail||''))
    toggler(box,'展开轨道说明',function(b){ b.appendChild(el('div','meta',out.rail_note||'')) })
    row(box,'过期时间',String(out.expires_at||''))
    if(String(out.status)==='draft'&&typeof oai.callTool==='function'){
      var b2=el('button','btn','提交 Passkey 审批(不会直接执行)')
      b2.addEventListener('click',onceGuard(function(){ b2.disabled=true; oai.callTool('webaz_submit_order_request',{draft_id:out.draft_id}) }))
      box.appendChild(b2)
    }
    disclosures(box,out.disclosures)
  } else if(sv==='webaz.order_approval.model.v1'){
    box.appendChild(el('div','h','待 Passkey 审批'))
    row(box,'请求',String(out.request_id||''))
    row(box,'操作','创建正式订单')
    row(box,'批准后','创建唯一正式订单(Passkey 必需)');
    box.appendChild(el('div','meta',String(out.on_approval||'资金行为随所披露的支付轨道:托管=建单时钱包→托管;直付=WebAZ 不托管本金')))
    row(box,'状态','待批准')
    if(out.duplicate_warning){
      var w=el('div','warn'); w.appendChild(el('b',null,'检测到相似购买请求'))
      w.appendChild(el('div',null,out.duplicate_warning.note||''))
      ;(out.duplicate_warning.options||[]).forEach(function(o){ w.appendChild(el('div','meta','· '+o)) })
      box.appendChild(w)
    }
    var openBtn=el('button','btn','打开审批页面(webaz.xyz · Passkey)')
    openBtn.addEventListener('click',onceGuard(function(){
      // approval_url = 服务端权威字段;openWebaz 内部做 origin 校验
      if(!openWebaz(oai,'https://webaz.xyz/'+String(out.approval_url||'').replace(/^\\//,''))) sendFollowUpCompat(oai,'请给我审批页面链接')
    }))
    box.appendChild(openBtn)
    box.appendChild(el('div','meta ok','批准成功后:唯一正式订单号可经 webaz_approval_requests 查询(executed_order_id)'))
    disclosures(box,out.disclosures)
  } else {
    box.textContent='未知投影版本:'+sv
  }
}`

// ─── OrderTimeline ────────────────────────────────────────────────────────────────────────────
// 渲染 webaz.order_timeline.model.v1(单订单履约时间线)与 webaz.order_status.model.v1(列表/最小单/
// up_to_date)。deadline 在组件端按【观看者本地时区】渲染;刷新走 callTool;联系商家回会话流(上下文
// 绑定订单聊天,无自由私信;无订单上下文不启用);高风险动作回订单页。

const ORDER_TIMELINE_STYLE = `
body{font-family:system-ui,sans-serif;margin:0;padding:12px;color:var(--ink);background:transparent}
.box{border:1px solid var(--line);border-radius:12px;padding:14px 16px;max-width:430px;background:var(--bg)}
.h{font-size:14px;font-weight:700;margin-bottom:4px}
.price{color:var(--price);font-weight:800;font-size:18px}
.fiat{color:var(--sub);font-size:12px}
.badge{display:inline-block;font-size:10px;border-radius:99px;padding:2px 8px;background:var(--chip-warn-bg);color:var(--warn);margin:6px 0}
.st{font-size:13px;font-weight:700;color:var(--accent-ink)}
.row{display:flex;justify-content:space-between;font-size:12px;padding:2px 0;color:var(--row-ink)}
.tl{border-left:2px solid var(--line);margin:10px 0 4px 6px;padding-left:12px}
.tl div{font-size:11px;color:var(--sub);padding:3px 0;position:relative}
.tl div:before{content:'';position:absolute;left:-17px;top:8px;width:8px;height:8px;border-radius:99px;background:var(--accent-line)}
.warn{background:var(--warnbox-bg);border:1px solid var(--warnbox-line);border-radius:10px;padding:8px 10px;font-size:11px;color:var(--warnbox-ink);margin-top:8px}
.rowbtn{display:flex;gap:6px;margin-top:10px}
.rowbtn button{flex:1;border:1px solid var(--accent-line);background:var(--accent-bg);border-radius:10px;padding:6px;font-size:12px;font-weight:600;cursor:pointer;color:var(--accent-ink)}
.meta{font-size:11px;color:var(--sub)}`

const ORDER_TIMELINE_BODY_JS = `
function renderBody(oai, out){
  oai = oai || {}
  var root = document.getElementById('root')
  function el(t,c,x){ var n=document.createElement(t); if(c)n.className=c; if(x!=null)n.textContent=String(x); return n }
  function row(box,k,v){ var r=el('div','row'); r.appendChild(el('span',null,k)); r.appendChild(el('span',null,v)); box.appendChild(r) }
  function localTime(iso){ try { return new Date(String(iso).replace(' ','T')+(String(iso).includes('Z')||String(iso).includes('+')?'':'Z')).toLocaleString() } catch(e){ return String(iso) } }
  root.textContent=''
  if(!out||!out.schema_version){ root.textContent='WebAZ: no structured payload visible to this widget.'; return }
  var box=el('div','box'); root.appendChild(box)
  var sv=String(out.schema_version)

  if(sv==='webaz.order_status.model.v1'){
    if(out.up_to_date){ box.appendChild(el('div','h','订单 '+out.order_id+' 无新变化')); box.appendChild(el('div','meta','状态:'+(out.status||'')+' · 增量刷新:自 updated_since 起无存储态变化')); return }
    if(out.order){
      var mo=out.order
      box.appendChild(el('div','h','订单 '+String(mo.order_id||'')))
      row(box,'状态',String(mo.status||''))
      if(mo.next_actor) row(box,'下一责任方',String(mo.next_actor))
      if(mo.deadline) row(box,'截止时间',localTime(mo.deadline))
      if(typeof oai.callTool==='function'){
        var mb=el('div','rowbtn'); var mf=el('button',null,'查看完整时间线')
        mf.addEventListener('click',onceGuard(function(){ oai.callTool('webaz_buyer_orders',{order_id:mo.order_id,full:true}) }))
        mb.appendChild(mf); box.appendChild(mb)
      }
      return
    }
    box.appendChild(el('div','h','买家订单'))
    var s=out.summary||{}
    box.appendChild(el('div','meta','共 '+(s.total||0)+' 单 · 活跃 '+(s.active||0)+' · 争议 '+(s.disputed||0)))
    ;(out.orders||[]).forEach(function(o){
      var r=el('div','row'); r.appendChild(el('span',null,String(o.order_id).slice(0,12)+'…')); r.appendChild(el('span',null,String(o.status)))
      if(typeof oai.callTool==='function'){ r.style.cursor='pointer'; r.addEventListener('click',onceGuard(function(){ oai.callTool('webaz_buyer_orders',{order_id:o.order_id,full:true}) })) }
      box.appendChild(r)
    })
    return
  }

  if(sv!=='webaz.order_timeline.model.v1'){ box.textContent='未知投影版本:'+sv; return }
  box.appendChild(el('div','h',(out.product&&out.product.title)||String(out.order_id||'')))
  box.appendChild(el('div','price',(out.price&&out.price.display)||''))
  if(out.fiat_estimate) box.appendChild(el('div','fiat',out.fiat_estimate.display+(out.fiat_estimate.stale?'(近似汇率)':'')))
  box.appendChild(el('div','badge',String(out.rail_badge||'')))
  box.appendChild(el('div','st',(out.status&&out.status.label)||''))
  if(out.next_actor) row(box,'下一责任方',String(out.next_actor))
  if(out.deadline&&out.deadline.iso) row(box,'截止时间',localTime(out.deadline.iso))
  var lg=out.logistics||{}
  if(lg.tracking) row(box,'物流单号',String(lg.tracking))
  var tl=el('div','tl')
  ;(out.timeline||[]).forEach(function(t){ tl.appendChild(el('div',null,localTime(t.at)+' · '+((t.to_status&&t.to_status.label)||'')+(t.actor?'('+t.actor+')':''))) })
  box.appendChild(tl)
  if(out.refund){
    var w=el('div','warn')
    w.appendChild(el('b',null,'退款/退货'))
    ;(out.refund.requests||[]).forEach(function(x){ w.appendChild(el('div',null,String(x.status)+' · '+((x.amount&&x.amount.display)||'')+' · '+String(x.created_at||''))) })
    w.appendChild(el('div','meta',String(out.refund.note||'')))
    box.appendChild(w)
  }
  var btns=el('div','rowbtn')
  if(typeof oai.callTool==='function'){
    var rf=el('button',null,'刷新')
    rf.addEventListener('click',onceGuard(function(){ oai.callTool('webaz_buyer_orders',{order_id:out.order_id,full:true}) }))   // 增量语义在服务端 updated_since;此处全读保证动作面新鲜
    btns.appendChild(rf)
  }
  if(out.order_id&&canFollowUp(oai)){
    var chat=el('button',null,'联系商家')
    chat.addEventListener('click',onceGuard(function(){ sendFollowUpCompat(oai,'请用 webaz_order_chat 读取订单 '+out.order_id+' 的对话') },2000))
    btns.appendChild(chat)
  }
  var open=el('button',null,'订单页(webaz.xyz)')
  open.addEventListener('click',onceGuard(function(){ openWebaz(oai,'https://webaz.xyz/#order/'+encodeURIComponent(String(out.order_id||''))) }))
  btns.appendChild(open)
  box.appendChild(btns)
  box.appendChild(el('div','meta',String(out.actions_note||'')))
}`

// ─── 导出:每组件 legacy(skybridge)+ standard(profile=mcp-app)双 HTML,共享同一 render 体 ──

export const PRODUCT_RESULTS_WIDGET_HTML = buildWidgetHtml({ style: PRODUCT_RESULTS_STYLE, loading: 'WebAZ ProductResults — loading…', bodyJs: PRODUCT_RESULTS_BODY_JS, standard: false, link: false })
export const PRODUCT_RESULTS_WIDGET_MCP_HTML = buildWidgetHtml({ style: PRODUCT_RESULTS_STYLE, loading: 'WebAZ ProductResults — loading…', bodyJs: PRODUCT_RESULTS_BODY_JS, standard: true, link: false })

export const QUOTE_APPROVAL_WIDGET_HTML = buildWidgetHtml({ style: QUOTE_APPROVAL_STYLE, loading: 'WebAZ QuoteAndApproval — loading…', bodyJs: QUOTE_APPROVAL_BODY_JS, standard: false, link: true })
export const QUOTE_APPROVAL_WIDGET_MCP_HTML = buildWidgetHtml({ style: QUOTE_APPROVAL_STYLE, loading: 'WebAZ QuoteAndApproval — loading…', bodyJs: QUOTE_APPROVAL_BODY_JS, standard: true, link: true })

export const ORDER_TIMELINE_WIDGET_HTML = buildWidgetHtml({ style: ORDER_TIMELINE_STYLE, loading: 'WebAZ OrderTimeline — loading…', bodyJs: ORDER_TIMELINE_BODY_JS, standard: false, link: true })
export const ORDER_TIMELINE_WIDGET_MCP_HTML = buildWidgetHtml({ style: ORDER_TIMELINE_STYLE, loading: 'WebAZ OrderTimeline — loading…', bodyJs: ORDER_TIMELINE_BODY_JS, standard: true, link: true })

// 测试专用导出(scripts/test-mcp-apps-standard.ts 在 node:vm 里驱动真实桥逻辑)—— 非运行时 API。
export const __WIDGET_COMPAT_JS = WIDGET_COMPAT_CORE_JS + WIDGET_COMPAT_LINK_JS
export const __WIDGET_BRIDGE_STANDARD_JS = WIDGET_BRIDGE_STANDARD_JS
export const __WIDGET_BOOT_STANDARD_JS = WIDGET_BOOT_STANDARD_JS
