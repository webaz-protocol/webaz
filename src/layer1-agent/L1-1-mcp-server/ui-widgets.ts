/**
 * MCP UI PR-4 — MCP App widgets(ChatGPT Apps 渐进增强;Claude/纯文本宿主走 structuredContent+摘要降级)。
 *
 * 纪律(spike 定稿):自包含单文件(宿主 CSP 内零外联);一切文本经 textContent(卖家可控标题,
 * 绝不 innerHTML);本地交互(展开/排序/选择/比较)零模型调用;跨 MCP 的动作只走宿主提供的
 * window.openai.callTool / sendFollowupTurn 且逐个能力探测,缺失即优雅降级为提示文案;
 * 经济动作(报价→草稿→提交)永远回到会话流(最终 Passkey 在 webaz.xyz),widget 绝不直达钱路。
 * v1 无商品图(widget CSP 对外源图片未验证;图片面待 UI Projection 层)。
 */

// ProductResults:渲染 webaz_search 的三种 structuredContent 形态
//   ①搜索/浏览页(webaz.product_search.model.v1:products+sellers+next_cursor+result_handle)
//   ②0 命中(found:0 + recovery.catalog_sample)③按需详情(webaz.product_detail.model.v1)。
export const PRODUCT_RESULTS_WIDGET_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--line:#d6dae2;--ink:#1c2330;--sub:#5b6472;--ok:#0a7d4f;--warn:#a15c00;--bg:#fff}
body{font-family:system-ui,sans-serif;margin:0;padding:10px;color:var(--ink);background:transparent}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.bar button{border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer}
.bar button.on{background:#eef2ff;border-color:#93a3f5}
.grid{display:flex;gap:10px;flex-wrap:wrap}
.card{border:1px solid var(--line);border-radius:12px;padding:12px 14px;width:210px;background:var(--bg);display:flex;flex-direction:column;gap:6px}
.card b{font-size:13px;line-height:1.35;display:block;min-height:2.6em}
.price{color:var(--ok);font-weight:700;font-size:15px}
.chips{display:flex;gap:4px;flex-wrap:wrap}
.chip{font-size:10px;border-radius:6px;padding:1px 6px;background:#eef1f6;color:var(--sub)}
.chip.warn{background:#fff3e0;color:var(--warn)}
.meta{font-size:11px;color:var(--sub)}
.card .more{font-size:11px;color:var(--sub);display:none;border-top:1px dashed var(--line);padding-top:6px}
.card.open .more{display:block}
.row{display:flex;gap:6px;margin-top:auto}
.row button{flex:1;border:1px solid var(--line);background:#f7f8fa;border-radius:8px;padding:4px 6px;font-size:11px;cursor:pointer}
.cmp{margin-top:12px;border-top:1px solid var(--line);padding-top:8px;font-size:12px;display:none}
.cmp table{border-collapse:collapse;width:100%}
.cmp td,.cmp th{border:1px solid var(--line);padding:3px 6px;text-align:left;font-size:11px}
.note{font-size:11px;color:var(--sub);margin-top:10px}
</style></head><body>
<div id="root">WebAZ ProductResults — loading…</div>
<script>
(function(){
  'use strict'
  var oai = window.openai || {}
  var out = oai.toolOutput || null
  var root = document.getElementById('root')
  function el(tag, cls, text){ var n=document.createElement(tag); if(cls)n.className=cls; if(text!=null)n.textContent=String(text); return n }
  if(!out){ root.textContent='WebAZ: no structured payload visible to this widget.'; return }

  // ③详情形态
  if(out.schema_version==='webaz.product_detail.model.v1'){
    root.textContent=''
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
      rec.catalog_sample.forEach(function(p){ var c=el('div','card'); c.appendChild(el('b',null,p.title||p.id)); c.appendChild(el('div','price',(p.price!=null?p.price+' WAZ':''))); g0.appendChild(c) })
      root.appendChild(g0)
    }
    return
  }

  // ①搜索页
  var sellers=out.sellers||{}
  var state={sort:'default',selected:{}}
  function render(){
    root.textContent=''
    var bar=el('div','bar')
    ;[['default','默认'],['price_asc','价格↑'],['price_desc','价格↓']].forEach(function(s){
      var b=el('button',state.sort===s[0]?'on':null,s[1])
      b.addEventListener('click',function(){ state.sort=s[0]; render() })   // 本地排序,零模型调用
      bar.appendChild(b)
    })
    if(out.next_cursor&&typeof oai.callTool==='function'){
      var more=el('button',null,'下一页')
      more.addEventListener('click',function(){ oai.callTool('webaz_search',{cursor:out.next_cursor,limit:5}) })
      bar.appendChild(more)
    }
    root.appendChild(bar)
    var list=products.slice()
    var priceOf=function(p){ return (p.price&&p.price.amount_minor)||0 }
    if(state.sort==='price_asc') list.sort(function(a,b){return priceOf(a)-priceOf(b)})
    if(state.sort==='price_desc') list.sort(function(a,b){return priceOf(b)-priceOf(a)})
    var g=el('div','grid')
    list.forEach(function(p){
      var c=el('div','card')
      c.appendChild(el('b',null,p.title||p.id))
      c.appendChild(el('div','price',(p.price&&p.price.display)||''))
      var chips=el('div','chips')
      if(p.stock_status&&p.stock_status!=='in_stock') chips.appendChild(el('span','chip warn',p.stock_status==='low_stock'?'库存少':'缺货'))
      ;(p.decision_flags||[]).forEach(function(f){ chips.appendChild(el('span','chip'+(f.severity==='warning'?' warn':''),f.label||f.code)) })
      c.appendChild(chips)
      var seller=sellers[p.seller_ref]||{}
      c.appendChild(el('div','meta',(seller.name||'')+' · 已售 '+(p.sales_count||0)))
      var m=el('div','more')
      m.appendChild(el('div',null,p.summary||''))
      m.appendChild(el('div','meta','退货 '+(p.return_days!=null?p.return_days+'天':'—')+' · 保修 '+(p.warranty_days!=null?p.warranty_days+'天':'—')+' · 发货 '+(p.handling_hours!=null?p.handling_hours+'h':'—')))
      c.appendChild(m)
      var row=el('div','row')
      var ex=el('button',null,'展开')
      ex.addEventListener('click',function(){ c.classList.toggle('open') })   // 本地展开
      row.appendChild(ex)
      if(out.result_handle&&typeof oai.callTool==='function'){
        var dt=el('button',null,'详情')
        dt.addEventListener('click',function(){ oai.callTool('webaz_search',{result_handle:out.result_handle,selected_ids:[p.id]}) })
        row.appendChild(dt)
      }
      var q=el('button',null,'报价')
      q.addEventListener('click',function(){
        // 经济链路回会话流:报价→草稿→提交→Passkey(widget 绝不直达钱路)
        if(typeof oai.sendFollowupTurn==='function') oai.sendFollowupTurn({prompt:'请用 webaz_quote_order 给商品 '+p.id+' 报价'})
        else alert('请在对话里说:给 '+p.id+' 报价')
      })
      row.appendChild(q)
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
    root.appendChild(el('div','note','报价不会扣款 · 草稿不锁库存 · 正式下单需你在 webaz.xyz 用 Passkey 批准'))
  }
  render()
})();
</script></body></html>`
