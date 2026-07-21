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
  // F3(Round1 UI hotfix):统一 ETA formatter —— 商品卡/报价卡/时间线共用,永不显示原始 JSON。
  //   入参可为 number / 数字串 / 范围串("3-5") / 范围对象 / 区域→天数 map({"SG":12,"all":12}) / promised_eta v1 / null。
  //   优先目的区域 → all/default → 首个数值;输出「约12天」「3–5天」「暂未提供预计配送时间」;绝不伪造具体日期。
  function etaDisplay(v, region){
    if(v==null) return '暂未提供预计配送时间'
    if(typeof v==='number'){ return isFinite(v)?('约'+v+'天'):'暂未提供预计配送时间' }
    if(typeof v==='string'){ var t=v.trim(); if(!t) return '暂未提供预计配送时间'
      if(/^\\d+$/.test(t)) return '约'+t+'天'
      if(/^\\d+\\s*[-–~]\\s*\\d+$/.test(t)) return t.replace(/\\s*[-–~]\\s*/,'–')+'天'
      return t }
    if(typeof v==='object'){
      if(v.legacy_missing) return '下单时未记录预计配送时间'
      var lo=(v.estimated_min_days!=null)?v.estimated_min_days:v.min, hi=(v.estimated_max_days!=null)?v.estimated_max_days:v.max
      if(lo!=null&&hi!=null) return (lo===hi)?('约'+lo+'天'):(lo+'–'+hi+'天')
      if(v.estimated_days_text!=null){ var et=String(v.estimated_days_text).trim(); return et?('约'+et+'天'):'暂未提供预计配送时间' }
      var r=(region!=null)?String(region).toUpperCase():null, pick=null
      if(r&&v[r]!=null) pick=v[r]; else if(v.all!=null) pick=v.all; else if(v.default!=null) pick=v.default
      else { for(var k in v){ if(v[k]!=null&&(typeof v[k]==='number'||/^\\d+$/.test(String(v[k])))){ pick=v[k]; break } } }
      if(pick!=null){ return (typeof pick==='number'||/^\\d+$/.test(String(pick)))?('约'+pick+'天'):String(pick) }
      return '暂未提供预计配送时间'
    }
    return '暂未提供预计配送时间'
  }
  // F4(Round1 UI hotfix):统一工具调用 —— legacy(window.openai.callTool)与标准桥 facade.callTool 都返回 promise,
  //   单一 consume 路径就地消费 structuredContent(不依赖宿主重挂载/重渲染)。归一 {ok,structuredContent,error,timeout,sourceBridge};
  //   15s 超时;调用期 __inlineConsuming>0 抑制标准桥 tool-result 通知的重复渲染(同一结果只渲染一次)。正常路径【绝不】 sendFollowUp。
  var __inlineConsuming=0
  function webazConsume(r){ return (r&&typeof r==='object'&&r.structuredContent)?r.structuredContent:r }
  function callWebazTool(oai, name, args){
    if(!oai||typeof oai.callTool!=='function'){ return Promise.resolve({ok:false,error:'HOST_COMPONENT_TOOL_CALL_UNAVAILABLE',sourceBridge:'none'}) }
    var bridge=(oai._webazBridge==='standard')?'standard':'legacy'
    __inlineConsuming++
    var settled=false
    function done(v){ if(!settled){ settled=true; setTimeout(function(){ if(__inlineConsuming>0)__inlineConsuming-- },0) } return v }
    var to=new Promise(function(res){ setTimeout(function(){ res(done({ok:false,error:'TIMEOUT',timeout:true,sourceBridge:bridge})) }, 15000) })
    var call
    try{ call=Promise.resolve(oai.callTool(name,args)).then(function(r){ var sc=webazConsume(r); return done({ok:!!sc&&!sc.error,structuredContent:sc,error:(sc&&sc.error)||null,sourceBridge:bridge}) },function(e){ return done({ok:false,error:(e&&(e.message||e.code))||'CALL_REJECTED',sourceBridge:bridge}) }) }
    catch(e){ return Promise.resolve(done({ok:false,error:'CALL_THREW',sourceBridge:bridge})) }
    return Promise.race([call,to])
  }
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
  // F4:按钮就地消费(callWebazTool)期间 __inlineConsuming>0 → 跳过 tool-result 通知,避免同一结果被 promise 和通知渲染两次。
  function __onToolResult(r){ if(__inlineConsuming>0) return; if(r&&r.structuredContent) renderBody(__facade, r.structuredContent) }
  var __br=makeStandardBridge(__onToolResult)
  __br.connect(600).then(function(){
    __facade={
      _webazBridge:'standard',   // callWebazTool 据此标注 sourceBridge(仅日志/诊断)
      // 双路径统一(Round1 F4):CARD 工具结果既可经 ui/notifications/tool-result 渲染,也可由按钮 callWebazTool 就地消费
      //   本返回 promise;__inlineConsuming 去重保证同一结果只渲染一次(见 __onToolResult)。card-LESS 工具就地消费返回值。
      callTool:function(n,a){ var p=__br.callTool(n,a); try{ p.catch(function(){}) }catch(e){} return p },
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
.card.rec{border:2px solid #4f46e5;box-shadow:0 0 0 1px #4f46e5}
.recbadge{align-self:flex-start;font-size:10px;font-weight:600;color:#fff;background:#4f46e5;border-radius:6px;padding:1px 7px}
.recreason{font-size:11px;color:var(--ink);line-height:1.5}
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
.hint{margin-top:10px;font-size:12px;color:var(--warnbox-ink);background:var(--warnbox-bg);border:1px solid var(--warnbox-line);border-radius:10px;padding:8px 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;line-height:1.5}
button.mini{border:1px solid var(--accent-line);background:var(--accent-bg);color:var(--accent-ink);border-radius:8px;padding:3px 8px;font-size:11px;cursor:pointer;white-space:nowrap}
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
      m.appendChild(el('div',null,p.description||'')); if(p.description_truncated) m.appendChild(el('div','meta','…(描述截断)'))
      if(p.specs){ try{ Object.keys(p.specs).forEach(function(k){ m.appendChild(el('div','meta',k+': '+p.specs[k])) }) }catch(e){} }
      if(p.specs_truncated) m.appendChild(el('div','meta','规格较多,已省略 —— 点「查看完整条款」获取完整规格'))
      if(p.return_condition) m.appendChild(el('div','meta','退货条件: '+p.return_condition+(p.return_condition_truncated?' …(截断)':'')))
      if(p.ship_regions) m.appendChild(el('div','meta','配送区域: '+p.ship_regions+(p.ship_regions_truncated?' …(截断)':'')))
      m.appendChild(el('div','meta','退货 '+(p.return_days!=null?p.return_days+'天':'—')+' · 保修 '+(p.warranty_days!=null?p.warranty_days+'天':'—')+' · 发货 '+(p.handling_hours!=null?p.handling_hours+'h':'—')+(p.has_variants?' · 有多规格':'')))
      // BUG-01:关键条款被截断 → 一键取全(webaz_search full_terms=true);宿主不支持一键则给可复制指引,绝不静默丢失条款。
      if(p.terms_complete===false){
        if(p.full_terms_fetch&&p.full_terms_fetch.args&&typeof oai.callTool==='function'){
          var ftb=el('button','mini','查看完整条款'); ftb.addEventListener('click',onceGuard(function(){ try{ oai.callTool('webaz_search',p.full_terms_fetch.args) }catch(e){} })); m.appendChild(ftb)
        } else { m.appendChild(el('div','meta','完整条款:让我用 webaz_search(full_terms=true)取该商品完整规格/退货/配送条款')) }
      }
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
      rec.catalog_sample.forEach(function(p){ var c=el('div','card'); c.appendChild(el('b',null,p.title||p.id))
        // 防御:price 可能是对象 { display, amount_minor }(Model Projection),绝不让它 toString 成 [object Object]。
        var pd=p.price_display || (p.price&&typeof p.price==='object' ? (p.price.display||(p.price.amount_minor!=null?(p.price.amount_minor/1000000)+' USDC':'')) : (p.price!=null?p.price+' USDC':''))
        c.appendChild(el('div','price',pd)); g0.appendChild(c) })
      root.appendChild(g0)
    }
    return
  }

  // ①搜索页
  __lastSearch = out   // B1:缓存供详情页【返回列表】原地回退
  var sellers=out.sellers||{}
  var state={sort:'default',selected:{},open:{},hint:null}
  // fail-visible:widget→host 回调(callTool/sendFollowUp)在部分宿主(如 ChatGPT)可能静默不生效
  // (点了详情/准备下单没反应或永久卡)。铁律:任何这类动作都 ①永不永久卡 loading ②始终留一条可见的
  // 手动路径 —— 展示一句可【复制发给模型】的话,让用户在任何宿主上都能继续。绝不假装成功、绝不碰钱路。
  // 复制诚实化(Codex R1):writeText 异步,只有 resolve 才显示「已复制」;reject/无 clipboard → 提示手动选择。
  //   兜底真相是:phrase 永远以文字显示在提示里,复制失败也能手选,fail-visible 不依赖 clipboard。
  function doCopy(text,btn){
    try{ var nav=(typeof navigator!=='undefined')?navigator:null
      if(nav&&nav.clipboard&&nav.clipboard.writeText){ btn.textContent='复制中…'; nav.clipboard.writeText(String(text)).then(function(){ btn.textContent='已复制✓' },function(){ btn.textContent='复制失败,请手选' }); return }
    }catch(e){}
    btn.textContent='请手动选择上面文字'
  }
  // F4(Round1 UI hotfix):准备下单 = 结构化直调 webaz_quote_order → 【就地消费】结果,把商品卡切到报价态(§四.A)。
  //   single-flight:进行中再点无效;成功→报价面板(真实金额/ETA/到期)+「创建草稿并提交审批」继续键;失败/超时→卡内错误 + 可复制手动路径。
  //   宿主无 callTool → 唯一允许的 sendFollowUp 降级(§三:正常路径绝不 sendFollowUp)。绝不假装成功、绝不直达钱路(建单仍在 Passkey)。
  function prepareOrder(pid,title){
    var phrase='为「'+(title||pid)+'」准备下单(product_id='+pid+')'
    if(typeof oai.callTool!=='function'){   // 宿主不支持组件直调 → fail-visible NL 降级(仅此情形)
      try{ console.warn('[webaz-widget] prepare_order fallback_reason=HOST_COMPONENT_TOOL_CALL_UNAVAILABLE') }catch(e){}
      try{ sendFollowUpCompat(oai,'请为该商品准备下单:webaz_quote_order 报价(数量 1)→ webaz_order_draft 建草稿 → webaz_submit_order_request 提交审批,最终由我 Passkey 批准。product_id='+pid) }catch(e){}
      state.hint={ text:'此宿主不支持一键操作;请把这句话复制发给我:', phrase:phrase }; render(); return
    }
    if(state.busy) return   // single-flight:整个 promise 周期内二次点击不产生请求
    state.busy=true; state.hint={ text:'正在获取报价…', phrase:null }; render()
    callWebazTool(oai,'webaz_quote_order',{product_id:pid,quantity:1}).then(function(res){
      state.busy=false
      if(res.ok&&res.structuredContent){ state.quote={ pid:pid, title:title, sc:res.structuredContent }; state.hint=null; render(); return }
      state.hint={ text:(res.timeout?'获取报价超时,请重试或把这句话复制发给我:':'获取报价失败('+String(res.error||'')+'),请重试或把这句话复制发给我:'), phrase:phrase }; render()
    })
  }
  // 报价→草稿→提交 链(就地消费,single-flight);正式建单永远在 webaz.xyz 的 Passkey。绝不复用 token,幂等键由服务端兜底。
  function continueToApproval(q){
    if(state.busy) return; state.busy=true
    var qsc=q.sc, qt=qsc&&qsc.quote_token
    if(!qt){ state.busy=false; state.hint={ text:'报价缺少 quote_token,无法继续;请把这句话复制发给我:', phrase:'为「'+(q.title||q.pid)+'」准备下单(product_id='+q.pid+')' }; state.quote=null; render(); return }
    state.stage='正在创建订单草稿…'; render()
    callWebazTool(oai,'webaz_order_draft',{action:'create',quote_token:qt}).then(function(dr){
      if(!dr.ok||!dr.structuredContent||!dr.structuredContent.draft_id){ state.busy=false; state.stage=null; state.hint={ text:(dr.timeout?'创建草稿超时':'创建草稿失败('+String(dr.error||'')+'')+',请重试或把这句话复制发给我:', phrase:'用这个报价创建订单草稿(quote_token='+String(qt)+')' }; render(); return }
      var did=dr.structuredContent.draft_id
      state.stage='正在提交 Passkey 审批…'; render()
      callWebazTool(oai,'webaz_submit_order_request',{draft_id:did}).then(function(sr){
        state.busy=false; state.stage=null
        if(sr.ok&&sr.structuredContent&&sr.structuredContent.request_id){ state.approval=sr.structuredContent; state.quote=null; render(); return }
        state.hint={ text:(sr.timeout?'提交超时':'提交失败('+String(sr.error||'')+'')+',请重试或把这句话复制发给我:', phrase:'提交这个草稿去 Passkey 审批(draft_id='+String(did)+')' }; render()
      })
    })
  }
  function openDetail(pid,title){
    var fired=false
    if(out.result_handle&&typeof oai.callTool==='function'){ try{ oai.callTool('webaz_search',{result_handle:out.result_handle,selected_ids:[pid]}); fired=true }catch(e){} }
    state.hint={ text:(fired?'正在载入详情…若卡片没有更新为详情页,请把这句话复制发给我:':'此宿主不支持一键操作;请把这句话复制发给我:'), phrase:'看「'+(title||pid)+'」的完整详情(product_id='+pid+')' }
    render()
  }
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
    // F5(Round1 UI hotfix):卡片显式标注真实展示数 —— 卡片只展示严格匹配命中,绝不虚构;模型叙述的"找到N款/推荐"可能来自更广候选集(discover),两者口径不同。
    var __shown=products.length, __total=(out.count!=null?out.count:__shown)
    root.appendChild(el('div','note','精确匹配 · 本卡展示 '+__shown+' 款'+((__total>__shown)?('(共 '+__total+' 命中,翻页查看更多)'):'')+' —— 模型文字里的"找到/推荐 N 款"可能来自更广候选集,以本卡商品为准'))
    var list=products.slice()
    var priceOf=function(p){ return (p.price&&p.price.amount_minor)||0 }
    if(state.sort==='price_asc') list.sort(function(a,b){return priceOf(a)-priceOf(b)})
    if(state.sort==='price_desc') list.sort(function(a,b){return priceOf(b)-priceOf(a)})
    var g=el('div','grid')
    list.forEach(function(p){
      var isOpen=!!state.open[p.id]
      // B3/§15:模型推荐【透传】—— 高亮该卡(边框+🌟角标+理由),标注【AI 推荐】非 WebAZ 推荐;纯展示,不改事实/排序/价格。
      var isRec=out.recommendation&&out.recommendation.product_id===p.id
      var c=el('div','card'+(isOpen?' open':'')+(isRec?' rec':''))
      c.setAttribute('data-pid', String(p.id))
      if(isRec){ c.appendChild(el('div','recbadge','🌟 AI 推荐')) }
      var __ti=el('b',null,p.title||p.id); __ti.style.cursor='pointer'
      __ti.addEventListener('click',function(){ toggleOpen(p.id) })   // B1:基本信息可点击展开/收起
      c.appendChild(__ti)
      if(isRec&&out.recommendation.reason){ c.appendChild(el('div','recreason','“'+out.recommendation.reason+'”')) }
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
      m.appendChild(el('div','meta','退货 '+(p.return_days!=null?p.return_days+'天':'—')+' · 保修 '+(p.warranty_days!=null?p.warranty_days+'天':'—')+' · 发货 '+(p.handling_hours!=null?p.handling_hours+'h':'—')+' · 预计送达 '+etaDisplay(p.estimated_days,(out.dest_region||(out.destination&&out.destination.region)))))   // F3:统一 formatter,不再 String(对象)
      c.appendChild(m)
      var row=el('div','row')
      var ex=el('button',null,isOpen?'收起':'展开')
      ex.addEventListener('click',function(){ toggleOpen(p.id) })   // B1:展开/收起(状态持久,render 后恢复)
      row.appendChild(ex)
      if(out.result_handle){   // 详情走 openDetail:试 callTool 拉取,同时永远给可复制的手动路径(宿主不回渲也不卡)
        var dt=el('button',null,'详情')
        dt.addEventListener('click',onceGuard(function(){ openDetail(p.id,p.title) }))
        row.appendChild(dt)
      }
      // B2:主按钮【准备下单】—— 一键发起 报价→草稿→提交审批,终点你 Passkey 批准。
      //   走 follow-up 让模型编排:webaz_quote_order 是 model-only(app 直调会被标准 host 拒绝并吞掉→按钮永久卡死),
      //   故 widget 绝不 callTool 它;发结构化 follow-up(携准确 product_id)由模型跑 报价→草稿→提交,正式建单永远在人类
      //   Passkey 路径。widget 绝不直达钱路/不建单/不动资金。点击即 disabled 防误触;幂等由服务端 intent_hash 唯一索引兜底。
      var pd=el('button','primary','准备下单')
      if(state.busy) pd.disabled=true   // F4 single-flight:进行中禁用,防重复报价
      pd.addEventListener('click',onceGuard(function(){ prepareOrder(p.id,p.title) }))   // 就地消费报价;失败留可复制手动路径
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
      ;['商品','价格','退货','保修','发货','已售','下单'].forEach(function(h){ head.appendChild(el('th',null,h)) })
      t.appendChild(head)
      chosen.forEach(function(p){
        var tr=document.createElement('tr')
        ;[p.title,(p.price&&p.price.display)||'',p.return_days!=null?p.return_days+'天':'—',p.warranty_days!=null?p.warranty_days+'天':'—',p.handling_hours!=null?p.handling_hours+'h':'—',p.sales_count||0].forEach(function(v){ tr.appendChild(el('td',null,v)) })
        var actTd=document.createElement('td'); var buyBtn=el('button','mini','准备下单')   // 比较完直接选它下单(走硬化后的 prepareOrder)
        buyBtn.addEventListener('click',onceGuard(function(){ prepareOrder(p.id,p.title) }))
        actTd.appendChild(buyBtn); tr.appendChild(actTd)
        t.appendChild(tr)
      })
      cmp.appendChild(t); root.appendChild(cmp)
    }
    if(state.quote){   // F4:报价就地态 —— 真实金额/ETA/到期 + 继续键(草稿→提交),不再"正在获取报价"永久卡
      var qp=el('div','hint'); var qs=state.quote.sc||{}
      qp.appendChild(el('span',null,'✓ 已获取报价:'+(state.quote.title||'')))
      qp.appendChild(el('div','recreason',((qs.price&&qs.price.display)||'')+' · 预计送达 '+etaDisplay(qs.shipping&&qs.shipping.estimated_days,(qs.destination&&qs.destination.region))+(qs.expires_at?(' · 到期 '+String(qs.expires_at)):'')))
      if(state.stage){ qp.appendChild(el('div','meta',state.stage)) }
      else { var cb=el('button','mini','创建草稿并提交审批'); cb.addEventListener('click',function(){ continueToApproval(state.quote) }); qp.appendChild(cb) }
      qp.appendChild(el('div','meta','报价不扣款 · 草稿不锁库存 · 正式建单需你在 webaz.xyz 用 Passkey 批准'))
      root.appendChild(qp)
    }
    if(state.approval){   // F4:提交成功态 —— request_id + 可复制审批链接(去 webaz.xyz Passkey);ProductResults 无 openExternal,链接以文字给出
      var ap=el('div','hint'); var asc=state.approval
      ap.appendChild(el('span',null,'✓ 已提交审批(request_id='+String(asc.request_id||'').slice(0,12)+'…)。去 webaz.xyz 用 Passkey 批准:'))
      var aurl='https://webaz.xyz/'+String(asc.approval_url||'').replace(/^\\//,'')
      ap.appendChild(el('span','recreason',aurl))
      var acp=el('button','mini','复制审批链接'); acp.addEventListener('click',function(){ doCopy(aurl,acp) }); ap.appendChild(acp)
      root.appendChild(ap)
    }
    if(state.hint){   // fail-visible 手动路径:一句可复制发给模型的话 —— 任何宿主上按钮不生效都能继续
      var hb=el('div','hint'); hb.appendChild(el('span',null,state.hint.text))
      if(state.hint.phrase){
        hb.appendChild(el('span','recreason','“'+state.hint.phrase+'”'))
        var cp=el('button','mini','复制'); cp.addEventListener('click',function(){ doCopy(state.hint.phrase,cp) }); hb.appendChild(cp)
      }
      root.appendChild(hb)
    }
    root.appendChild(el('div','note','报价不会扣款 · 草稿不锁库存 · 正式下单需你在 webaz.xyz 用 Passkey 批准 · ≈ 法币换算仅显示参考,非结算'))
    try{ window.scrollTo(0, __sy) }catch(e){}   // B1:render 后恢复滚动位置(排序/比较/收起不跳顶)
  }
  render()
}`

// ─── QuoteAndApproval ─────────────────────────────────────────────────────────────────────────
// 渲染 quote / draft / approval 三形态(webaz.order_quote|order_draft|order_approval .model — v1 旧卡 + BUG-06 v2 均兼容)。
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

export const QUOTE_APPROVAL_BODY_JS = `
function renderBody(oai, out){
  oai = oai || {}
  var root = document.getElementById('root')
  function el(t,c,x){ var n=document.createElement(t); if(c)n.className=c; if(x!=null)n.textContent=String(x); return n }
  function row(box,k,v){ var r=el('div','row'); r.appendChild(el('span',null,k)); r.appendChild(el('span',null,v)); box.appendChild(r) }
  function toggler(box,label,build){ var tg=el('span','toggle',label); var body=el('div','sec hide'); build(body); tg.addEventListener('click',function(){ body.classList.toggle('hide') }); box.appendChild(tg); box.appendChild(body) }
  function fiatLine(box,fe){ if(!fe)return; var f=el('div','fiat',fe.display+(fe.stale?'(近似汇率)':'')); box.appendChild(f) }
  function disclosures(box,list){ var d=el('div','disc',(list||[]).join(' · ')); box.appendChild(d) }
  // fail-visible(B7,同 ProductResults):widget→host 回调(callTool/sendFollowUp)在部分宿主(ChatGPT)可能静默不生效。
  //   任何按钮点击都①永不永久卡 ②追加一条可复制的手动指令,让"点按钮"在任何宿主上都能推进,不必用户精确打字。
  function copyText(t){ try{ var n=(typeof navigator!=='undefined')?navigator:null; if(n&&n.clipboard&&n.clipboard.writeText){ n.clipboard.writeText(String(t)); return true } }catch(e){} return false }
  function actHint(phrase, sent, lead){
    var h=el('div','disc'); h.appendChild(el('span',null,(lead||(sent?'已发送。若卡片没有刷新,复制发我:':'此宿主不支持一键,复制发我:'))))
    h.appendChild(el('span','ok',' “'+phrase+'” '))
    var cp=el('button','toggle','复制'); cp.addEventListener('click',function(){ cp.textContent=copyText(phrase)?'已复制✓':'复制' }); h.appendChild(cp); root.appendChild(h)
  }
  function reenable(btn){ try{ setTimeout(function(){ try{ btn.disabled=false }catch(e){} },4000) }catch(e){} }
  root.textContent=''
  if(!out||!out.schema_version){ root.textContent='WebAZ: no structured payload visible to this widget.'; return }
  var box=el('div','box'); root.appendChild(box)
  var sv=String(out.schema_version)
  // BUG-06 — normalize status ONCE at entry: v1 carried a bare string, v2 an object {code,label,label_en}.
  //   stLabel = display text (v1 string shows the raw code, unchanged; v2 shows the localized label).
  //   stCode  = canonical machine code for branch/button gating (never inferred from the label).
  //   qtyText = display-only positive integer (the charged amount is price.amount_minor, not this).
  function stLabel(s){ return (s&&typeof s==='object')?String(s.label||s.label_en||s.code||''):String(s||'') }
  function stCode(s){ return (s&&typeof s==='object')?String(s.code||''):String(s||'') }
  // BUG-06 quantity safety: an invalid/corrupt quantity is NEVER shown as ×1. qtyOk = strict positive
  //   safe integer (number OR a pure-digit string); qtyBad = server said invalid (quantity_valid===false)
  //   OR the value fails the local check (covers old v1 cards with no diagnostic field). A bad quantity
  //   shows 数量数据异常 and disables every quantity-dependent transaction button (no tool call fires).
  function qtyOk(q){ if(typeof q==='number'){ return isFinite(q)&&Math.floor(q)===q&&q>0&&q<=9007199254740991 } if(typeof q==='string'){ var t=q.trim(); if(!/^\\d+$/.test(t)) return false; var n=Number(t); return n>0&&n<=9007199254740991 } return false }
  function qtyBad(out){ return out.quantity_valid===false || !qtyOk(out.quantity) }
  function qtyDisp(q){ return typeof q==='number'?q:Number(String(q).trim()) }
  function qtyErr(out){ return String(out.quantity_error||(out.quantity_valid===false?'invalid':'invalid')) }
  // BUG-08:客户端 nonce(独立购买实例 / 每步 idempotency_key)—— [A-Za-z0-9_-],≤64;服务端仍再校验格式。
  function nonce(){ return (Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8)) }
  function consume(r){ return (r&&typeof r==='object'&&r.structuredContent)?r.structuredContent:r }
  // BUG-08 §二:零 PII 追踪标识(组件生成,格式即 nonce();服务端再校验+封顶)。widget_session 每次渲染一个;
  //   bridge_type 区分标准桥(oai.callTool)/legacy 桥;每个写动作带 trace/interaction/operation_attempt。
  var __wsid='ws_'+nonce()
  function bridgeType(){ return (typeof oai.callTool==='function')?'standard':'legacy' }
  function traceArgs(iid){ return { trace_id:'tr_'+nonce(), interaction_id:iid||('ix_'+nonce()), operation_attempt_id:'op_'+nonce(), widget_session_id:__wsid, bridge_type:bridgeType() } }
  function withTrace(a,iid){ var t=traceArgs(iid); for(var k in t){ a[k]=t[k] } return a }

  if(sv==='webaz.order_quote.model.v1'||sv==='webaz.order_quote.model.v2'){
    box.appendChild(el('div','h','报价 · '+((out.product&&out.product.title)||'')+(qtyBad(out)?' · 数量数据异常':' ×'+qtyDisp(out.quantity))))
    box.appendChild(el('div','price',(out.price&&out.price.display)||''))
    fiatLine(box,out.fiat_estimate)
    var a=out.amounts||{}
    toggler(box,'展开费用明细',function(b){ row(b,'商品金额',(a.item/1000000).toFixed(2)+' USDC'); row(b,'运费',(a.shipping/1000000).toFixed(2)+' USDC'); row(b,'其他费用',(a.other/1000000).toFixed(2)+' USDC'); row(b,'总价',(out.price.amount_minor/1000000).toFixed(2)+' USDC') })
    var s=out.shipping||{}
    row(box,'配送',(out.destination&&out.destination.summary)||'')
    row(box,'发货时限',s.handling_hours!=null?s.handling_hours+'h':'—')
    row(box,'预计送达',etaDisplay(s.estimated_days,(out.destination&&out.destination.region)))   // F3:统一 formatter,不再 String(对象)
    toggler(box,'展开退货与保修',function(b){ row(b,'退货期',out.return_days!=null?out.return_days+'天':'—'); row(b,'保修',out.warranty_days!=null?out.warranty_days+'天':'—') })
    row(box,'支付轨道',String(out.payment_rail||'escrow'))
    toggler(box,'展开风险与轨道说明',function(b){ b.appendChild(el('div','meta',out.rail_note||'')) })
    if(out.fiat_estimate) toggler(box,'查看汇率时间',function(b){ b.appendChild(el('div','meta','1 USD ≈ '+out.fiat_estimate.rate+' '+out.fiat_estimate.currency+' @ '+(out.fiat_estimate.as_of||'')+(out.fiat_estimate.stale?'(近似)':''))) })
    row(box,'报价到期',String(out.expires_at||''))
    row(box,'库存','未锁定(下单时重新校验)')
    if(out.quote_token&&typeof oai.callTool==='function'){
      var b1=el('button','btn','创建订单草稿(不扣款)')
      if(qtyBad(out)){ b1.disabled=true; box.appendChild(b1); box.appendChild(el('div','warn','数量数据异常,无法创建草稿(quantity_error='+qtyErr(out)+')')) }   // BUG-06: never initiate a draft call on invalid quantity
      else { b1.addEventListener('click',onceGuard(function(){ b1.disabled=true   // F4:就地消费结果 → 渲染草稿卡(同 widget renderBody 处理 draft schema);失败留可复制手动路径
        callWebazTool(oai,'webaz_order_draft',{action:'create',quote_token:out.quote_token}).then(function(res){
          if(res.ok&&res.structuredContent){ renderBody(oai,res.structuredContent); return }
          b1.disabled=false; actHint('用这个报价创建订单草稿(quote_token='+String(out.quote_token)+')', false, (res.timeout?'创建草稿超时':'创建草稿失败('+String(res.error||'')+''))+',请重试或复制发我:')
        })
      })); box.appendChild(b1) }
    }
    disclosures(box,out.disclosures)
  } else if(sv==='webaz.order_draft.model.v1'||sv==='webaz.order_draft.model.v2'){
    if(Array.isArray(out.drafts)){ box.appendChild(el('div','h','订单草稿列表')); out.drafts.forEach(function(d){ row(box,String(d.draft_id).slice(0,10)+'…',stLabel(d.status)+' · '+((d.price&&d.price.display)||'')) }); return }
    box.appendChild(el('div','h','订单草稿 · '+String(out.draft_id||'').slice(0,10)+'…'))
    row(box,'状态',stLabel(out.status))
    row(box,'商品',((out.product&&out.product.title)||'')+(qtyBad(out)?' · 数量数据异常':' ×'+qtyDisp(out.quantity)))
    box.appendChild(el('div','price',(out.price&&out.price.display)||''))
    fiatLine(box,out.fiat_estimate)
    row(box,'配送',(out.destination&&out.destination.summary)||'')
    row(box,'支付轨道',String(out.payment_rail||''))
    toggler(box,'展开轨道说明',function(b){ b.appendChild(el('div','meta',out.rail_note||'')) })
    row(box,'过期时间',String(out.expires_at||''))
    if(stCode(out.status)==='draft'&&typeof oai.callTool==='function'){
      var b2=el('button','btn','提交 Passkey 审批(不会直接执行)')
      if(qtyBad(out)){ b2.disabled=true; box.appendChild(b2); box.appendChild(el('div','warn','数量数据异常,无法提交审批(quantity_error='+qtyErr(out)+')')) }   // BUG-06: never initiate a submit call on invalid quantity
      else { b2.addEventListener('click',onceGuard(function(){ b2.disabled=true   // F4:就地消费结果 → 渲染审批卡(approval schema);money 参数 withTrace 不变,仅新增结果消费
        callWebazTool(oai,'webaz_submit_order_request',withTrace({draft_id:out.draft_id})).then(function(res){
          if(res.ok&&res.structuredContent){ renderBody(oai,res.structuredContent); return }
          b2.disabled=false; actHint('提交这个草稿去 Passkey 审批(draft_id='+String(out.draft_id)+')', false, (res.timeout?'提交超时':'提交失败('+String(res.error||'')+''))+',请重试或复制发我:')
        })
      })); box.appendChild(b2) }
    }
    disclosures(box,out.disclosures)
  } else if(sv==='webaz.order_approval.model.v1'||sv==='webaz.order_approval.model.v2'){
    box.appendChild(el('div','h','待 Passkey 审批'))
    row(box,'请求',String(out.request_id||''))
    row(box,'操作','创建正式订单')
    row(box,'批准后','创建唯一正式订单(Passkey 必需)');
    box.appendChild(el('div','meta',String(out.on_approval||'资金行为随所披露的支付轨道:托管=建单时钱包→托管;直付=WebAZ 不托管本金')))
    row(box,'状态',(out.status&&typeof out.status==='object')?(stLabel(out.status)||'待批准'):'待批准')   // v2 status 对象用本地化 label;v1 裸字符串('pending')回退到 '待批准'(提交态恒为 pending),不显英文 code
    // BUG-08:按 duplicate_reason 显示精确文案(绝不统一"检测到重复");旧卡只有 duplicate_warning 时回退其 note。
    var dupReason=String(out.duplicate_reason||'')
    var DUP_TEXT={SAME_DRAFT_REPLAY:'同一草稿重复提交 —— 已复用原审批请求,未创建第二个',SAME_IDEMPOTENCY_KEY:'重试命中相同操作键 —— 返回同一结果,未创建第二个',ACTIVE_INTENT_REUSED:'你已有一个等价的待审批购买 —— 可打开它,或明确「再买一份」创建独立购买',DATABASE_UNIQUE_RACE:'并发提交竞争 —— 已复用先创建的审批,未创建第二个',RESPONSE_LOSS_RECONCILED:'上次响应可能丢失 —— 已恢复原审批请求,未重复创建'}
    if(out.duplicate||out.duplicate_warning){
      var w=el('div','warn'); w.appendChild(el('b',null,DUP_TEXT[dupReason]||(out.duplicate_warning&&out.duplicate_warning.note)||'检测到重复购买保护 —— 已复用现有审批'))
      var dupOf=out.duplicate_of||out.existing_request_id||(out.duplicate_warning&&out.duplicate_warning.existing_request_id)
      if(dupOf) w.appendChild(el('div','meta','已有请求:'+String(dupOf)))
      box.appendChild(w)
    }
    var openBtn=el('button','btn','打开审批页面(webaz.xyz · Passkey)')
    openBtn.addEventListener('click',onceGuard(function(){
      // approval_url = 服务端权威字段;openWebaz 内部做 origin 校验。fail-visible(Codex R2 High):openExternal 存在
      //   即返回 true 但宿主可能静默丢弃、或 openExternal 抛错 —— 故 try/catch + 【无条件】追加可复制审批页 URL,永不静默死。
      var href='https://webaz.xyz/'+String(out.approval_url||'').replace(/^\\//,'')
      var opened=false; try{ opened=openWebaz(oai,href) }catch(e){ opened=false }
      actHint(href, opened, (opened?'已尝试打开审批页;若没弹出':'此宿主未能打开')+',复制到浏览器用 Passkey 批准:')
    }))
    box.appendChild(openBtn)
    // BUG-08 §五/§八:活跃意图复用时给三个明确动作 —— 打开已有审批(上方)/ 取消本次 / 再买一份。
    //   全部结构化按钮,绝不靠自然语言推断;再买一份 = 显式独立购买(服务端 new_purchase_intent,仍需 Passkey)。
    var wantSecond=(dupReason==='ACTIVE_INTENT_REUSED')||(Array.isArray(out.available_actions)&&out.available_actions.indexOf('create_second_purchase')>=0)
    if(wantSecond){
      var cancelBtn=el('button','toggle','取消本次')
      cancelBtn.addEventListener('click',onceGuard(function(){ cancelBtn.disabled=true; box.appendChild(el('div','meta ok','已取消本次尝试 —— 原有待审批购买不受影响')) }))
      box.appendChild(cancelBtn)
      var againBtn=el('button','btn','再买一份(独立购买)')
      var stageLine=el('div','meta')
      // BUG-08 §一:再买一份 = 确定性 DIRECT_TOOL 链(报价→草稿→提交),全程不发自然语言、不调模型。
      //   同一 purchase_intent_instance 贯穿整条新链;每个写步骤用独立 idempotency_key;失败即停并给重试入口;
      //   绝不复用原 quote_token/draft/审批;价格/库存/地址/区域由服务器在报价与执行期重校验。手动 single-flight。
      var againRunning=false
      againBtn.addEventListener('click',function(){
        if(againRunning) return; // §一.11:快速双击只启动一条流程
        var ro=out.reorder||{}
        if(typeof oai.callTool!=='function'){ actHint('再买一份需在支持组件直调的宿主中进行;或在 WebAZ PWA 重新购买该商品(会作为独立购买处理)。', false, ''); return }
        if(!ro.product_id){ box.appendChild(el('div','warn','无法自动再买一份(此卡缺少商品信息)—— 请在 WebAZ PWA 重新购买')); return }
        againRunning=true; againBtn.disabled=true
        if(stageLine.parentNode!==box) box.appendChild(stageLine)
        var instance='pii_'+nonce()   // §一.3:全链一致
        var chainIid='ix_'+nonce()    // §二.6:整条新购买链共享一个 interaction_id(可关联原 duplicate 事件)
        try{ console.log('[webaz-widget] explicit_second_purchase start instance='+instance) }catch(e){}
        function fail(stage,msg){ againRunning=false; againBtn.disabled=false
          stageLine.textContent='再买一份失败(步骤:'+stage+'):'+String(msg||'请重试')+' —— 未创建任何订单。可再次点击「再买一份」重试(会用全新实例)。' }
        stageLine.textContent='再买一份 · 步骤1/3 重新报价(服务器重算价格/库存/区域)…'
        try{
          Promise.resolve(oai.callTool('webaz_quote_order',{product_id:String(ro.product_id),quantity:Number(ro.quantity)||1,idempotency_key:'q_'+instance})).then(function(qr){
            var q=consume(qr); if(!q||q.error||!q.quote_token){ return fail('报价', (q&&(q.error||q.error_code))||'报价未返回可用 quote_token(可能已下架/区域不支持/涨价需重报)') }
            stageLine.textContent='再买一份 · 步骤2/3 新建独立草稿…'
            return Promise.resolve(oai.callTool('webaz_order_draft',{action:'create',quote_token:q.quote_token,idempotency_key:'d_'+instance})).then(function(dr){
              var d=consume(dr); if(!d||d.error||!d.draft_id){ return fail('建草稿', (d&&(d.error||d.error_code))||'未返回 draft_id') }
              stageLine.textContent='再买一份 · 步骤3/3 提交独立购买(new_purchase_intent)…'
              return Promise.resolve(oai.callTool('webaz_submit_order_request',withTrace({draft_id:d.draft_id,new_purchase_intent:true,purchase_intent_instance:instance,idempotency_key:'s_'+instance},chainIid))).then(function(sr){
                var s=consume(sr); if(!s||s.error||!s.request_id){ return fail('提交', (s&&(s.error||s.error_code))||'未返回 request_id') }
                againRunning=false
                stageLine.textContent='再买一份成功 —— 已创建独立审批(仍需 Passkey)。原审批入口保留在上方,互不影响。'
                box.appendChild(el('div','meta ok','新请求:'+String(s.request_id)))
                var newOpen=el('button','btn','打开新审批(webaz.xyz · Passkey)')
                newOpen.addEventListener('click',onceGuard(function(){ var href='https://webaz.xyz/'+String(s.approval_url||'').replace(/^\\//,''); var op=false; try{op=openWebaz(oai,href)}catch(e){op=false} actHint(href,op,(op?'已尝试打开新审批;若没弹出':'此宿主未能打开')+',复制到浏览器用 Passkey 批准:') }))
                box.appendChild(newOpen)
              },function(){ fail('提交','宿主未回传提交结果') })
            },function(){ fail('建草稿','宿主未回传草稿结果') })
          },function(){ fail('报价','宿主未回传报价结果') })
        }catch(e){ fail('启动','无法发起报价') }
      })
      box.appendChild(againBtn)
    }
    // §IV DIRECT_TOOL:「🔄 查看最新状态」结构化直调 webaz_approval_requests(action=get, request_id),就地消费结果更新状态;
    //   不发自然语言、不需模型选工具。executed 且有 order_id → 结构化「查看订单」DIRECT_TOOL(callTool buyer_orders)。
    //   宿主不支持组件直调 → fail-visible + fallback_reason=HOST_COMPONENT_TOOL_CALL_UNAVAILABLE(不静默)。
    var statusLine=el('div','meta','状态:待批准(点「🔄 查看最新状态」刷新)'); box.appendChild(statusLine)
    var orderSlot=el('div'); box.appendChild(orderSlot)
    function applyApprovalStatus(r){
      var d=(r&&r.structuredContent)?r.structuredContent:r; if(!d){ statusLine.textContent='状态:未获取到,请重试'; return }
      var st=d.status||(d.request&&d.request.status)||''
      var oid=d.executed_order_id||(d.request&&d.request.executed_order_id)||''
      statusLine.textContent='状态:'+(stLabel(st)||'未知'); orderSlot.textContent=''   // BUG-06: live read may carry a string OR a v2 object — normalize both
      if(stCode(st)==='executed'&&oid&&typeof oai.callTool==='function'){
        var vo=el('button','btn','查看订单 '+String(oid).slice(0,10)+'…')
        vo.addEventListener('click',onceGuard(function(){   // F4:此卡渲染 approval;订单时间线属另一卡 → 打开 webaz.xyz 订单页(fail-visible),不发丢弃的 callTool
          var href='https://webaz.xyz/#order/'+encodeURIComponent(String(oid)); var op=false; try{ op=openWebaz(oai,href) }catch(e){ op=false }
          actHint(href, op, (op?'已尝试打开订单页;若没弹出':'此宿主未能打开')+',复制到浏览器查看订单:')
        }))
        orderSlot.appendChild(vo)
      }
    }
    var refBtn=el('button','btn','🔄 查看最新状态')
    refBtn.addEventListener('click',onceGuard(function(){
      refBtn.disabled=true; reenable(refBtn); var rid=String(out.request_id||'')
      if(typeof oai.callTool==='function'){
        statusLine.textContent='状态:查询中…'
        try{ var p=oai.callTool('webaz_approval_requests',{action:'get',request_id:rid})
          if(p&&typeof p.then==='function'){ p.then(function(r){ applyApprovalStatus(r) },function(){ statusLine.textContent='状态:查询失败,请重试' }) }
          else { statusLine.textContent='状态:已请求(等待宿主回传)' }
        }catch(e){ statusLine.textContent='状态:查询失败,请重试' }
        return
      }
      try{ console.warn('[webaz-widget] view_status fallback_reason=HOST_COMPONENT_TOOL_CALL_UNAVAILABLE') }catch(e){}
      var sent=false; try{ sent=sendFollowUpCompat(oai,'请用 webaz_approval_requests(action=get, request_id='+rid+')查这笔审批最新状态') }catch(e){}
      actHint('查这笔审批/订单的最新状态(request_id='+rid+')', sent)
    }))
    box.appendChild(refBtn)
    box.appendChild(el('div','meta','此卡为提交时快照;批准在 webaz.xyz 完成后,点「🔄 查看最新状态」直调查询 —— 本卡不会自动更新'))
    box.appendChild(el('div','meta ok','批准成功后:唯一正式订单号可经 webaz_approval_requests 查询(executed_order_id)'))
    disclosures(box,out.disclosures)
  } else {
    box.textContent='不支持此旧卡片版本(schema_version='+sv+')。请在 WebAZ PWA 查看最新状态。'
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
.meta{font-size:11px;color:var(--sub)}
.chatpanel{margin-top:10px;border-top:1px dashed var(--line);padding-top:8px}
.chatmsgs{max-height:160px;overflow-y:auto;font-size:12px;color:var(--row-ink)}
.chatinput{width:100%;box-sizing:border-box;margin-top:8px;border:1px solid var(--line);border-radius:8px;padding:6px;font-size:12px;background:var(--bg);color:var(--ink)}
.chatpanel .btn{display:block;width:100%;margin-top:8px;border:1px solid var(--accent-line);background:var(--accent-bg);border-radius:10px;padding:6px;font-size:12px;font-weight:600;cursor:pointer;color:var(--accent-ink)}`

export const ORDER_TIMELINE_BODY_JS = `
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

  if(sv!=='webaz.order_timeline.model.v1'&&sv!=='webaz.order_timeline.model.v2'){ box.textContent='不支持此旧卡片版本(schema_version='+sv+')。请在 WebAZ PWA 查看最新状态。'; return }
  box.appendChild(el('div','h',(out.product&&out.product.title)||String(out.order_id||'')))
  box.appendChild(el('div','price',(out.price&&out.price.display)||''))
  if(out.fiat_estimate) box.appendChild(el('div','fiat',out.fiat_estimate.display+(out.fiat_estimate.stale?'(近似汇率)':'')))
  box.appendChild(el('div','badge',String(out.rail_badge||'')))
  box.appendChild(el('div','st',(out.status&&out.status.label)||''))
  if(out.next_actor) row(box,'下一责任方',String(out.next_actor))
  if(out.deadline&&out.deadline.iso) row(box,'截止时间',localTime(out.deadline.iso))
  var lg=out.logistics||{}
  // BUG-02:三种配送时间分列 —— ①下单时预计配送(promised_eta,冻结承诺)②当前物流预计(shipping_est_days,运费模板;非承诺)③物流追踪。
  //   两种 ETA 绝不合成一个标签;旧单无承诺快照 → "下单时未记录预计配送时间";只显示"约N天/范围",不伪造确定日期。
  var pe=lg.promised_eta
  function etaText(e){ if(!e) return null; if(e.legacy_missing) return '下单时未记录预计配送时间'; if(e.estimated_days_text==null) return '无配送估计'; var lo=e.estimated_min_days, hi=e.estimated_max_days; if(lo!=null&&hi!=null) return (lo===hi?('约'+lo+'天'):(lo+'–'+hi+'天')); return String(e.estimated_days_text)+'天' }
  var petxt=etaText(pe); if(petxt) row(box,'下单时预计配送',petxt)
  if(lg.shipping_est_days!=null) row(box,'当前物流预计',String(lg.shipping_est_days)+'天')
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
  if(out.order_id){
    // §V DIRECT_TOOL:「联系商家」= 读会话(order_chat list)+ 发消息(order_chat send)结构化直调,零自然语言、零模型选工具。
    //   会话就地渲染;发送正文由用户在输入框明确输入,明确标注「发给订单对方」;single-flight + 稳定幂等键;无 alert/confirm。
    //   宿主不支持组件直调 → fail-visible + fallback_reason,不把正文自动发给模型。参与者/反诈/block/限频/幂等校验全在服务端不变。
    function shash(s){ var h=5381; for(var i=0;i<s.length;i++){ h=((h<<5)+h+s.charCodeAt(i))>>>0 } return h.toString(36) }
    var chatBtn=el('button',null,'联系商家')
    var chatPanel=el('div','chatpanel'); chatPanel.style.display='none'
    var chatMsgs=el('div','chatmsgs'); chatPanel.appendChild(chatMsgs)
    function renderChat(r){
      var d=(r&&r.structuredContent)?r.structuredContent:r; chatMsgs.textContent=''
      var msgs=(d&&(d.messages||d.conversation||d.items))||[]
      if(!msgs.length){ chatMsgs.appendChild(el('div','meta','暂无消息')); return }
      msgs.forEach(function(m){ var who=(m.sender||m.from||''); chatMsgs.appendChild(el('div','meta',(who?who+': ':'')+String(m.body||m.text||''))) })
    }
    function loadChat(){
      if(typeof oai.callTool!=='function') return false
      chatMsgs.textContent='读取中…'
      try{ var p=oai.callTool('webaz_order_chat',{action:'list',order_id:out.order_id}); if(p&&typeof p.then==='function'){ p.then(renderChat,function(){ chatMsgs.textContent='读取失败,请重试' }) } else { chatMsgs.textContent='已请求(等待宿主回传)' } }catch(e){ chatMsgs.textContent='读取失败' }
      return true
    }
    var inp=document.createElement('textarea'); inp.className='chatinput'; inp.setAttribute('rows','2'); inp.setAttribute('maxlength','2000'); inp.setAttribute('placeholder','给订单对方的消息(将发送给对方)')
    var sendBtn=el('button','btn','发送给订单对方'); var sending=false
    sendBtn.addEventListener('click',function(){
      if(sending) return
      var body=String(inp.value||'').trim()
      if(!body){ chatMsgs.appendChild(el('div','meta','请输入消息内容')); return }
      if(body.length>2000){ chatMsgs.appendChild(el('div','meta','消息过长(≤2000)')); return }
      if(typeof oai.callTool!=='function'){ try{ console.warn('[webaz-widget] chat_send fallback_reason=HOST_COMPONENT_TOOL_CALL_UNAVAILABLE') }catch(e){} chatMsgs.appendChild(el('div','meta','此宿主不支持组件发送;请在 webaz.xyz 订单页联系商家')); return }
      sending=true; sendBtn.disabled=true
      var idem='wgt_'+shash(String(out.order_id)+'|'+body)   // 稳定幂等键:同内容重试复用(服务端幂等兜底);改内容=新键
      try{ var p=oai.callTool('webaz_order_chat',{action:'send',order_id:out.order_id,body:body,idempotency_key:idem})
        if(p&&typeof p.then==='function'){ p.then(function(){ inp.value=''; sending=false; sendBtn.disabled=false; loadChat() },function(){ sending=false; sendBtn.disabled=false; chatMsgs.appendChild(el('div','meta','发送失败,请重试(同内容重试不会重复发送)')) }) }
        else { sending=false; sendBtn.disabled=false; chatMsgs.appendChild(el('div','meta','已请求发送(等待宿主回传);同内容重试不会重复发送')) }
      }catch(e){ sending=false; sendBtn.disabled=false }
    })
    chatPanel.appendChild(inp); chatPanel.appendChild(sendBtn)
    chatPanel.appendChild(el('div','meta','消息将发送给订单对方 · 请勿在消息中填写地址/支付凭据/验证码/密钥'))
    chatBtn.addEventListener('click',onceGuard(function(){
      if(chatPanel.style.display==='none'){ chatPanel.style.display='block'; if(!loadChat()){ try{ console.warn('[webaz-widget] chat_list fallback_reason=HOST_COMPONENT_TOOL_CALL_UNAVAILABLE') }catch(e){} chatMsgs.textContent=''; chatMsgs.appendChild(el('div','meta','此宿主不支持组件读取;请在 webaz.xyz 订单页查看会话')) } }
      else { chatPanel.style.display='none' }
    },1500))
    btns.appendChild(chatBtn); box.appendChild(chatPanel)
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
