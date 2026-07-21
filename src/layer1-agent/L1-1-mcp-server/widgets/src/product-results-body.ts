// @ts-nocheck — A1 冻结期:body 源码字节级冻结(内容 hash 不变),语义标注留给 A2;语法错误仍会上报。生成器会剥离本行。

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
  function doCopy(text,btn,selEl){ webazCopy(text,btn,selEl) }   // B-4:统一降级(clipboard→execCommand→自动选中→手选)
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
    // B4 不变量:点击即【同步】fail-visible —— 载入提示携带精确 product_id 短语 + 复制键(永不静默/永不卡死);成功后被报价面板替换。
    state.busy=true; state.hint={ text:'正在获取报价…若卡片未更新为报价,复制发我:', phrase:phrase }; render()
    callWebazTool(oai,'webaz_quote_order',{product_id:pid,quantity:1}).then(function(res){
      state.busy=false
      if(res.ok&&res.structuredContent){ state.quote={ pid:pid, title:title, sc:res.structuredContent }; state.hint=null; render(); return }
      state.hint={ text:(res.timeout?'获取报价超时,请重试或把这句话复制发给我:':'获取报价失败('+String(res.error||'')+'),请重试或把这句话复制发给我:'), phrase:phrase }; render()
    })
  }
  // ProductResults 自包含锁(零外链词元):不在此卡内跑 草稿→提交→审批(那会引入 webaz.xyz 完整链接)。
  //   报价就地展示后,继续下单交给可复制的一句话(模型编排 draft→submit → QuoteAndApproval 卡,链接与 Passkey 在那张卡处理)。
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
    if(state.quote){   // F4:报价就地态 —— 真实金额/ETA/到期,不再"正在获取报价"永久卡。继续下单=可复制一句话(模型编排 draft→submit → 下单卡),本卡保持零 URL 自包含。
      var qp=el('div','hint'); var qs=state.quote.sc||{}
      qp.appendChild(el('span',null,'✓ 已获取报价:'+(state.quote.title||'')))
      qp.appendChild(el('div','recreason',((qs.price&&qs.price.display)||'')+' · 预计送达 '+etaDisplay(qs.shipping&&qs.shipping.estimated_days,(qs.destination&&qs.destination.region))+(qs.expires_at?(' · 到期 '+String(qs.expires_at)):'')))
      var qphrase='用这个报价创建订单草稿并提交 Passkey 审批(product_id='+state.quote.pid+')'
      var qpe=el('div','recreason','“'+qphrase+'”'); qp.appendChild(qpe)
      var qcp=el('button','mini','复制继续'); qcp.addEventListener('click',function(){ doCopy(qphrase,qcp,qpe) }); qp.appendChild(qcp)
      qp.appendChild(el('div','meta','报价不扣款 · 草稿/提交/Passkey 在下单卡完成 · 正式建单需你在 webaz.xyz 用 Passkey 批准'))
      root.appendChild(qp)
    }
    if(state.hint){   // fail-visible 手动路径:一句可复制发给模型的话 —— 任何宿主上按钮不生效都能继续
      var hb=el('div','hint'); hb.appendChild(el('span',null,state.hint.text))
      if(state.hint.phrase){
        var phe=el('span','recreason','“'+state.hint.phrase+'”'); hb.appendChild(phe)
        var cp=el('button','mini','复制'); cp.addEventListener('click',function(){ doCopy(state.hint.phrase,cp,phe) }); hb.appendChild(cp)
      }
      root.appendChild(hb)
    }
    root.appendChild(el('div','note','报价不会扣款 · 草稿不锁库存 · 正式下单需你在 webaz.xyz 用 Passkey 批准 · ≈ 法币换算仅显示参考,非结算'))
    try{ window.scrollTo(0, __sy) }catch(e){}   // B1:render 后恢复滚动位置(排序/比较/收起不跳顶)
  }
  render()
}export {}
