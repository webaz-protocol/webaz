// @ts-nocheck — body 为 ES5 风格运行时脚本(el() 可选参/动态 state),完整类型标注另行任务;语法错误仍会上报。生成器会剥离本行。

var __lastSearch=null   // B1:缓存上一次搜索页 out —— 供详情页【← 返回列表】原地回退,不再固定住
var __autoFillAttempts=0   // 审计F1:跨渲染尝试上限 —— 终止性不再依赖服务端隐式不变量
// i18n:ETA/到期择取 —— zh 用服务端 display_*(逐字不变);en 用客户端双语 etaDisplay + 到期后缀英化。
function __i18nExp(disp, iso){ var d=String(disp||iso||''); if(!d) return ''; return webazLocale()==='en' ? d.replace('(新加坡时间)',' (SGT)') : d }
function renderBody(oai, out){
  oai = oai || {}
  var root = document.getElementById('root')
  function el(tag, cls, text){ var n=document.createElement(tag); if(cls)n.className=cls; if(text!=null)n.textContent=String(text); return n }
  if(!out){ root.textContent='WebAZ: no structured payload visible to this widget.'; return }
  // 审计F2:本渲染器只认 product 系模型 —— 晚到的 draft/approval 通知(超时后宿主回灌)绝不允许把卡
  //   砸成"0 命中"或覆盖审批面板;非 product 模型直接忽略,保留当前 DOM。
  if(out.schema_version&&String(out.schema_version).indexOf('webaz.product_')!==0){ return }

  // ③详情形态 —— 完整描述/规格(卡内不可得,按需经 tool 拉取);顶部【← 返回列表】回到搜索页(修"固定住/回不去")。
  if(out.schema_version==='webaz.product_detail.model.v1'){
    root.textContent=''
    if(__lastSearch){ var back=el('button',null,L('← 返回列表','← Back to list')); back.addEventListener('click',function(){ renderBody(oai, __lastSearch) }); root.appendChild(back) }
    else if(typeof oai.callTool==='function'&&(out.products||[]).length){   // A3-6:本实例没渲染过列表(详情覆盖/独立详情卡)→ 按精确标题就地重搜回列表,买家永远回得去
      var back2=el('button',null,L('← 返回商品列表','← Back to products'))
      back2.addEventListener('click',onceGuard(function(){
        back2.textContent=L('载入列表中…','Loading list…')
        callWebazTool(oai,'webaz_search',{query:String((out.products[0]||{}).title||'')}).then(function(res){
          var sc=res.structuredContent
          if(res.ok&&sc&&sc.schema_version==='webaz.product_search.model.v1'&&(sc.products||[]).length){ renderBody(oai,sc); return }
          back2.textContent=L('← 返回商品列表(载入失败,可让我重新搜索)','← Back to products (load failed — ask me to search again)')
        })
      },3000))
      root.appendChild(back2)
    }
    var dg=el('div','grid')
    var __multiDetail=((out.products||[]).length>1)   // A2.1(Holden):批量详情【默认不平铺】——明确点击才展示全文
    ;(out.products||[]).forEach(function(p){
      var c=el('div','card open')
      c.appendChild(el('b',null,p.title||p.id))
      c.appendChild(el('div','price',(p.price&&p.price.display)||''))
      var m=el('div','more'); m.style.display=__multiDetail?'none':'block'
      m.appendChild(el('div',null,p.description||'')); if(p.description_truncated) m.appendChild(el('div','meta',L('…(描述截断)','…(description truncated)')))
      if(p.specs){ try{ var __ks=Object.keys(p.specs)   // A2.1:规格超 6 行折叠(本地开合,零调用)—— 详情不再一屏全文平铺
        __ks.slice(0,6).forEach(function(k){ m.appendChild(el('div','meta',k+': '+p.specs[k])) })
        if(__ks.length>6){ var __rest=el('div',null); __rest.style.display='none'
          __ks.slice(6).forEach(function(k){ __rest.appendChild(el('div','meta',k+': '+p.specs[k])) })
          var __tg=el('button','mini',L('展开全部规格(','Show all specs (')+(__ks.length-6)+')')
          __tg.addEventListener('click',function(){ var on=__rest.style.display==='none'; __rest.style.display=on?'block':'none'; __tg.textContent=on?L('收起规格','Hide specs'):L('展开全部规格(','Show all specs (')+(__ks.length-6)+')' })
          m.appendChild(__tg); m.appendChild(__rest) }
      }catch(e){} }
      if(p.specs_truncated) m.appendChild(el('div','meta',L('规格较多,已省略 —— 点「查看完整条款」获取完整规格','More specs omitted — tap "Full terms" for the complete spec')))
      if(p.return_condition) m.appendChild(el('div','meta',L('退货条件: ','Return policy: ')+p.return_condition+(p.return_condition_truncated?L(' …(截断)',' …(truncated)'):'')))
      if(p.ship_regions) m.appendChild(el('div','meta',L('配送区域: ','Ships to: ')+p.ship_regions+(p.ship_regions_truncated?L(' …(截断)',' …(truncated)'):'')))
      m.appendChild(el('div','meta',L('退货 ','Return ')+(p.return_days!=null?p.return_days+L('天',' days'):'—')+L(' · 保修 ',' · Warranty ')+(p.warranty_days!=null?p.warranty_days+L('天',' days'):'—')+L(' · 发货 ',' · Dispatch ')+(p.handling_hours!=null?p.handling_hours+'h':'—')+(p.has_variants?L(' · 有多规格',' · has variants'):'')))
      // BUG-01:关键条款被截断 → 一键取全(webaz_search full_terms=true);宿主不支持一键则给可复制指引,绝不静默丢失条款。
      if(p.terms_complete===false){
        if(p.full_terms_fetch&&p.full_terms_fetch.args&&typeof oai.callTool==='function'){
          var ftb=el('button','mini',L('查看完整条款','Full terms')); ftb.addEventListener('click',onceGuard(function(){   // 审计F1:真·最后一颗裸调 → consume 化
            ftb.textContent=L('载入条款中…','Loading terms…')
            callWebazTool(oai,'webaz_search',p.full_terms_fetch.args).then(function(res){
              var sc=res.structuredContent
              if(res.ok&&sc&&sc.schema_version==='webaz.product_detail.model.v1'){ renderBody(oai,sc); return }
              ftb.textContent=L('查看完整条款(载入失败,可重试)','Full terms (load failed — retry)')
            })
          },16000)); m.appendChild(ftb)
        } else { m.appendChild(el('div','meta',L('完整条款:让我用 webaz_search(full_terms=true)取该商品完整规格/退货/配送条款','Full terms: let me run webaz_search(full_terms=true) for the complete spec/returns/shipping'))) }
      }
      if(__multiDetail){ var __dt=el('button','mini',L('展开详情','Expand'))
        __dt.addEventListener('click',function(){ var on=m.style.display==='none'; m.style.display=on?'block':'none'; __dt.textContent=on?L('收起详情','Collapse'):L('展开详情','Expand') })
        c.appendChild(__dt) }
      c.appendChild(m)
      // A2.1:详情卡可操作 —— 就地报价(与列表 prepareOrder 同 consume 纪律);无 callTool 宿主给可复制短语。
      var __ph=L('为「','Prepare order for "')+(p.title||p.id)+L('」准备下单(product_id=','" (product_id=')+p.id+')'
      var __act=el('div','row')
      if(typeof oai.callTool==='function'){
        var __pd=el('button','primary',L('准备下单','Prepare order'))
        __pd.addEventListener('click',onceGuard(function(){
          var __h=el('div','hint',null); __h.textContent=L('正在获取报价…若无更新请把这句话发给我:','Getting quote… if nothing updates, send me this:')+__ph; c.appendChild(__h)
          callWebazTool(oai,'webaz_quote_order',{product_id:p.id,quantity:1}).then(function(res){
            var qs=res.structuredContent||{}
            if(res.ok){ __h.textContent=L('✓ 报价 ','✓ Quote ')+((qs.price&&qs.price.display)||'')+L(' · 预计送达 ',' · ETA ')+(webazLocale()==='en'?etaDisplay(qs.shipping&&qs.shipping.estimated_days,(qs.destination&&qs.destination.region)):(qs.display_eta||''))+L(' · 到期 ',' · expires ')+__i18nExp(qs.display_expires_at,qs.expires_at)+L(' —— 继续下单请把上面这句话发给我(报价不扣款,建单需 Passkey)',' — to continue, send me the line above (quotes never charge; ordering needs Passkey)') }
            else { __h.textContent=(res.timeout?L('获取报价超时','Quote timed out'):L('获取报价失败','Quote failed'))+L(',请把这句话发给我:',', send me this:')+__ph }
          })
        },3000))
        __act.appendChild(__pd)
      } else { __act.appendChild(el('div','meta',L('下单:把这句话发给我 —— ','To order, send me: ')+__ph)) }
      c.appendChild(__act); dg.appendChild(c)
    })
    if(out.unavailable_ids&&out.unavailable_ids.length) dg.appendChild(el('div','meta',L('已不可购: ','No longer available: ')+out.unavailable_ids.join(', ')))
    root.appendChild(dg); return
  }

  var products=(out.products||[]).slice()
  // ②0 命中
  if(!products.length){
    root.textContent=''
    var rec=out.recovery||{}
    if(rec.related_products&&rec.related_products.length){   // A3-10:相关商品(标题含词)以完整交互页渲染 + 诚实横幅;strict 0 事实保留在横幅里
      renderBody(oai,{ schema_version:'webaz.product_search.model.v1', products:rec.related_products, sellers:rec.related_sellers||{}, count:rec.related_products.length, total_count:rec.related_products.length, __related_note:L('精确匹配 0 命中 —— 以下是标题包含「','0 exact matches — related products with the term "')+String(rec.related_query||'')+L('」的相关商品(非精确命中)','" in the title (related, not exact)') })
      return
    }
    root.appendChild(el('div',null,L('精确匹配 0 命中(WebAZ 搜索是协议级严格匹配)。','0 exact matches (WebAZ search is strict).')))
    if(rec.catalog_sample&&rec.catalog_sample.length){
      root.appendChild(el('div','note',L('以下是目录样本(非搜索结果):','Catalog sample (not search results):')))
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
  var state={sort:'default',selected:{},open:{},hint:null,approval:null,chainBusy:false}
  // A3-6:宿主 widgetState 恢复(ChatGPT 持久化每条消息的组件态)—— 刷新/重挂载后报价/审批面板不丢。
  try{ var __ws=oai.widgetState; if(__ws&&typeof __ws==='object'){ if(__ws.q&&__ws.q.pid) state.quote=__ws.q; if(__ws.a&&__ws.a.request_id) state.approval=__ws.a } }catch(e){}
  function persist(){ try{ if(typeof oai.setWidgetState==='function') oai.setWidgetState({ q: state.quote, a: state.approval }) }catch(e){} }
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
    var phrase=L('为「','Prepare order for "')+(title||pid)+L('」准备下单(product_id=','" (product_id=')+pid+')'
    if(typeof oai.callTool!=='function'){   // 宿主不支持组件直调 → fail-visible NL 降级(仅此情形)
      try{ console.warn('[webaz-widget] prepare_order fallback_reason=HOST_COMPONENT_TOOL_CALL_UNAVAILABLE') }catch(e){}
      try{ sendFollowUpCompat(oai,L('请为该商品准备下单:webaz_quote_order 报价(数量 1)→ webaz_order_draft 建草稿 → webaz_submit_order_request 提交审批,最终由我 Passkey 批准。product_id=','Prepare this order: webaz_quote_order (qty 1) → webaz_order_draft → webaz_submit_order_request, then I approve with Passkey. product_id=')+pid) }catch(e){}
      state.hint={ text:L('此宿主不支持一键操作;请把这句话复制发给我:','This host lacks one-tap; copy this to me:'), phrase:phrase }; render(); return
    }
    if(state.busy) return   // single-flight:整个 promise 周期内二次点击不产生请求
    // B4 不变量:点击即【同步】fail-visible —— 载入提示携带精确 product_id 短语 + 复制键(永不静默/永不卡死);成功后被报价面板替换。
    state.busy=true; state.hint={ text:L('正在获取报价…若卡片未更新为报价,复制发我:','Getting quote… if the card does not update, copy this to me:'), phrase:phrase }; render()
    callWebazTool(oai,'webaz_quote_order',{product_id:pid,quantity:1}).then(function(res){
      state.busy=false
      if(res.ok&&res.structuredContent){ state.quote={ pid:pid, title:title, sc:res.structuredContent }; state.hint=null; persist(); render(); return }
      state.hint={ text:(res.timeout?L('获取报价超时,请重试或把这句话复制发给我:','Quote timed out — retry or copy this to me:'):L('获取报价失败(','Quote failed (')+String(res.error||'')+L('),请重试或把这句话复制发给我:','), retry or copy this to me:')), phrase:phrase }; render()
    })
  }
  // ProductResults 自包含锁(零外链词元):不在此卡内跑 草稿→提交→审批(那会引入 webaz.xyz 完整链接)。
  //   报价就地展示后,继续下单交给可复制的一句话(模型编排 draft→submit → QuoteAndApproval 卡,链接与 Passkey 在那张卡处理)。
  function openDetail(pid,title){
    var phrase=L('看「','View "')+(title||pid)+L('」的完整详情(product_id=','" full detail (product_id=')+pid+')'
    if(!out.result_handle||typeof oai.callTool!=='function'){ state.hint={ text:L('此宿主不支持一键操作;请把这句话复制发给我:','This host lacks one-tap; copy this to me:'), phrase:phrase }; render(); return }
    // R2-1(A2):就地消费详情结果 —— 与 prepareOrder 同一 consume 纪律,绝不 fire-and-forget;失败/超时留可复制手动路径。
    state.hint={ text:L('正在载入详情…若卡片没有更新为详情页,请把这句话复制发给我:','Loading detail… if the detail page does not open, copy this to me:'), phrase:phrase }; render()
    callWebazTool(oai,'webaz_search',{result_handle:out.result_handle,selected_ids:[pid]}).then(function(res){
      var sc=res.structuredContent
      if(res.ok&&sc&&sc.schema_version==='webaz.product_detail.model.v1'){ state.hint=null; renderBody(oai,sc); return }
      state.hint={ text:(res.timeout?L('载入详情超时,请重试或把这句话复制发给我:','Detail load timed out — retry or copy this to me:'):L('载入详情失败,请重试或把这句话复制发给我:','Detail load failed — retry or copy this to me:')), phrase:phrase }; render()
    })
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
    ;[['default',L('默认','Default')],['price_asc',L('价格↑','Price ↑')],['price_desc',L('价格↓','Price ↓')]].forEach(function(s){
      var b=el('button',state.sort===s[0]?'on':null,s[1])
      b.addEventListener('click',function(){ state.sort=s[0]; render() })   // 本地排序,零模型调用
      bar.appendChild(b)
    })
    root.appendChild(bar)
    // F5(Round1 UI hotfix):卡片显式标注真实展示数 —— 卡片只展示严格匹配命中,绝不虚构;模型叙述的"找到N款/推荐"可能来自更广候选集(discover),两者口径不同。
    var __shown=products.length, __total=(out.total_count!=null?out.total_count:(out.count!=null?out.count:__shown))   // A2.2:优先服务端总命中数
    root.appendChild(el('div','note',out.__related_note?String(out.__related_note):(L('精确匹配 · 本卡展示 ','Exact match · showing ')+__shown+L(' 款',' ')+((__total>__shown)?(L('(共 ','(')+__total+L(' 命中)',' total)')):'')+L(' —— 模型文字里的"找到/推荐 N 款"可能来自更广候选集,以本卡商品为准',' — the model text "found/recommended N" may draw from a wider set; this card is authoritative'))))
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
      if(isRec){ c.appendChild(el('div','recbadge',L('🌟 AI 推荐','🌟 AI pick'))) }
      var __ti=el('b',null,p.title||p.id); __ti.style.cursor='pointer'
      __ti.addEventListener('click',function(){ toggleOpen(p.id) })   // B1:基本信息可点击展开/收起
      c.appendChild(__ti)
      if(isRec&&out.recommendation.reason){ c.appendChild(el('div','recreason','“'+out.recommendation.reason+'”')) }
      c.appendChild(el('div','price',(p.price&&p.price.display)||''))
      var fx=out.fx&&out.fx.rates
      if(fx&&p.price&&p.price.amount_minor!=null){
        var usd=p.price.amount_minor/1000000, approx=[]
        if(fx.SGD) approx.push('S$'+(usd*fx.SGD).toFixed(2))   // 买家本地法币(现阶段商品仅配送 SG);Holden:绝不显示人民币
        if(approx.length) c.appendChild(el('div','meta','≈ '+approx.join(' · ')+(out.fx.stale?L('(近似汇率)','(approx. rate)'):'')))
      }
      var chips=el('div','chips')
      var stockChip=(p.stock_status&&p.stock_status!=='in_stock')?(p.stock_status==='low_stock'?L('库存少','Low stock'):L('缺货','Out of stock')):null
      if(stockChip) chips.appendChild(el('span','chip warn',stockChip))
      ;(p.decision_flags||[]).forEach(function(f){ var lb=(webazLocale()==='en'&&f.label_en)?f.label_en:(f.label||f.code); if(stockChip&&lb===stockChip) return; chips.appendChild(el('span','chip'+(f.severity==='warning'?' warn':''),lb)) })   // i18n:en 用 label_en   // R2-3:同义徽标只渲染一次
      c.appendChild(chips)
      var seller=sellers[p.seller_ref]||{}
      c.appendChild(el('div','meta',(seller.name||'')+L(' · 已售 ',' · sold ')+(p.sales_count||0)))
      var m=el('div','more')
      m.appendChild(el('div',null,p.summary||''))
      m.appendChild(el('div','meta',L('退货 ','Return ')+(p.return_days!=null?p.return_days+L('天',' days'):'—')+L(' · 保修 ',' · Warranty ')+(p.warranty_days!=null?p.warranty_days+L('天',' days'):'—')+L(' · 发货 ',' · Dispatch ')+(p.handling_hours!=null?p.handling_hours+'h':'—')+L(' · 预计送达 ',' · ETA ')+(webazLocale()==='en'?etaDisplay(p.estimated_days,(out.dest_region||(out.destination&&out.destination.region))):(p.display_eta||etaDisplay(p.estimated_days,(out.dest_region||(out.destination&&out.destination.region)))))))   // F3:统一 formatter,不再 String(对象)
      c.appendChild(m)
      var row=el('div','row')
      var ex=el('button',null,isOpen?L('收起','Collapse'):L('展开','Expand'))
      ex.addEventListener('click',function(){ toggleOpen(p.id) })   // B1:展开/收起(状态持久,render 后恢复)
      row.appendChild(ex)
      if(out.result_handle){   // 详情走 openDetail:试 callTool 拉取,同时永远给可复制的手动路径(宿主不回渲也不卡)
        var dt=el('button',null,L('详情','Detail'))
        dt.addEventListener('click',onceGuard(function(){ openDetail(p.id,p.title) }))
        row.appendChild(dt)
      }
      // B2:主按钮【准备下单】—— 一键发起 报价→草稿→提交审批,终点你 Passkey 批准。
      //   走 follow-up 让模型编排:webaz_quote_order 是 model-only(app 直调会被标准 host 拒绝并吞掉→按钮永久卡死),
      //   故 widget 绝不 callTool 它;发结构化 follow-up(携准确 product_id)由模型跑 报价→草稿→提交,正式建单永远在人类
      //   Passkey 路径。widget 绝不直达钱路/不建单/不动资金。点击即 disabled 防误触;幂等由服务端 intent_hash 唯一索引兜底。
      var pd=el('button','primary',L('准备下单','Prepare order'))
      if(state.busy) pd.disabled=true   // F4 single-flight:进行中禁用,防重复报价
      pd.addEventListener('click',onceGuard(function(){ prepareOrder(p.id,p.title) }))   // 就地消费报价;失败留可复制手动路径
      row.appendChild(pd)
      var sel=el('button',null,state.selected[p.id]?L('已选✓','Selected ✓'):L('比较','Compare'))
      sel.addEventListener('click',function(){ state.selected[p.id]=!state.selected[p.id]; render() })   // 本地选择
      row.appendChild(sel)
      c.appendChild(row)
      g.appendChild(c)
    })
    if(out.more_url&&__total>__shown){   // A4:第 6 格 = 前往 WebAZ 查看更多(不翻页,宁缺毋滥)
      var mc=el('div','card'); mc.appendChild(el('b',null,L('还有 ','Plus ')+(__total-__shown)+L(' 款',' ')))
      var mUrl=el('div','recreason',String(out.more_url)); mUrl.style.display='none'
      var mb=el('button','primary',L('前往 WebAZ 查看更多','See more on WebAZ'))
      mb.addEventListener('click',onceGuard(function(){ var op=false; try{ op=openWebaz(oai,String(out.more_url)) }catch(e){ op=false } if(!op){ mUrl.style.display='block'; doCopy(String(out.more_url),mb,mUrl) } }))
      var mr=el('div','row'); mr.appendChild(mb); mc.appendChild(mr); mc.appendChild(mUrl)
      g.appendChild(mc)
    }
    root.appendChild(g)
    var chosen=list.filter(function(p){return state.selected[p.id]})
    if(chosen.length>=2){
      var cmp=el('div','cmp'); cmp.style.display='block'
      var t=document.createElement('table')
      var head=document.createElement('tr')
      ;[L('商品','Item'),L('价格','Price'),L('退货','Return'),L('保修','Warranty'),L('发货','Dispatch'),L('已售','Sold'),L('下单','Order')].forEach(function(h){ head.appendChild(el('th',null,h)) })
      t.appendChild(head)
      chosen.forEach(function(p){
        var tr=document.createElement('tr')
        ;[p.title,(p.price&&p.price.display)||'',p.return_days!=null?p.return_days+L('天',' days'):'—',p.warranty_days!=null?p.warranty_days+L('天',' days'):'—',p.handling_hours!=null?p.handling_hours+'h':'—',p.sales_count||0].forEach(function(v){ tr.appendChild(el('td',null,v)) })
        var actTd=document.createElement('td'); var buyBtn=el('button','mini',L('准备下单','Prepare order'))   // 比较完直接选它下单(走硬化后的 prepareOrder)
        buyBtn.addEventListener('click',onceGuard(function(){ prepareOrder(p.id,p.title) }))
        actTd.appendChild(buyBtn); tr.appendChild(actTd)
        t.appendChild(tr)
      })
      cmp.appendChild(t); root.appendChild(cmp)
    }
    if(state.quote){   // F4:报价就地态 —— 真实金额/ETA/到期,不再"正在获取报价"永久卡。继续下单=可复制一句话(模型编排 draft→submit → 下单卡),本卡保持零 URL 自包含。
      var qp=el('div','hint'); var qs=state.quote.sc||{}
      qp.appendChild(el('span',null,L('✓ 已获取报价:','✓ Quote ready: ')+(state.quote.title||'')))
      qp.appendChild(el('div','recreason',((qs.price&&qs.price.display)||'')+L(' · 预计送达 ',' · ETA ')+(webazLocale()==='en'?etaDisplay(qs.shipping&&qs.shipping.estimated_days,(qs.destination&&qs.destination.region)):(qs.display_eta||etaDisplay(qs.shipping&&qs.shipping.estimated_days,(qs.destination&&qs.destination.region))))+((qs.display_expires_at||qs.expires_at)?(L(' · 到期 ',' · expires ')+__i18nExp(qs.display_expires_at,qs.expires_at)):'')))
      var qphrase=L('用这个报价创建订单草稿并提交 Passkey 审批(product_id=','Create an order draft from this quote and submit for Passkey approval (product_id=')+state.quote.pid+')'
      var qpe=el('div','recreason','“'+qphrase+'”'); qp.appendChild(qpe)
      // A3-2:卡内直调链 —— 草稿→提交审批就地完成(sendFollowUp 被宿主静默丢弃已实锤,模型移出关键路径;
      //   弱模型与强模型同体验)。fail-stop:任一步失败/超时留可复制短语;成功渲染审批引导(approval_url 是
      //   服务端返回的数据,textContent 展示,不触零 URL 源码锁)。仍不建单、不扣款:正式建单只在 webaz.xyz Passkey。
      if(typeof oai.callTool==='function'&&qs.quote_token){
        var qgo=el('button','mini',L('继续下单','Continue'))
        qgo.addEventListener('click',onceGuard(function(){
          if(state.chainBusy) return
          state.chainBusy=true; qgo.disabled=true; qgo.textContent=L('创建草稿中…','Creating draft…')
          callWebazTool(oai,'webaz_order_draft',{action:'create',quote_token:qs.quote_token}).then(function(dr){
            var ds=dr.structuredContent||{}
            if(!dr.ok||!ds.draft_id){ state.chainBusy=false; state.hint={ text:(dr.timeout?L('创建草稿超时','Draft creation timed out'):L('创建草稿失败(','Draft creation failed (')+String(ds.error_code||dr.error||'')+')')+L(',请把这句话复制发给我:',', copy this to me:'), phrase:qphrase }; render(); return }   // 审计F3:优先精确 error_code(如 QUOTE_ALREADY_CONSUMED)
            qgo.textContent=L('提交审批中…','Submitting…')
            callWebazTool(oai,'webaz_submit_order_request',{draft_id:String(ds.draft_id)}).then(function(sr){
              state.chainBusy=false
              var ss=sr.structuredContent||{}
              if(!sr.ok||!ss.request_id){ state.hint={ text:(sr.timeout?L('提交审批超时','Submission timed out'):L('提交审批失败(','Submission failed (')+String(ss.error_code||sr.error||'')+')')+L(',请把这句话复制发给我:',', copy this to me:'), phrase:L('提交订单审批(draft_id=','Submit order approval (draft_id=')+String(ds.draft_id)+')' }; render(); return }
              state.approval={ request_id:String(ss.request_id), url:String(ss.approval_url||''), duplicate:!!(ss.duplicate||ss.duplicate_warning) }   // 审计F1:投影已拍平为顶层 duplicate/duplicate_warning
              state.quote=null; state.hint=null; persist(); render()
            })
          })
        },3000))
        qp.appendChild(qgo)
      }
      var qcp=el('button','mini',L('复制继续','Copy to continue')); qcp.addEventListener('click',function(){ doCopy(qphrase,qcp,qpe) }); qp.appendChild(qcp)
      // A3-2b(Holden):取消 = 纯本地关面板(不调工具;报价不扣款不锁库存,服务端自然过期)—— 买家可改选其他商品。
      var qx=el('button','mini',L('取消','Cancel')); qx.addEventListener('click',function(){ if(state.chainBusy) return; state.quote=null; state.hint=null; persist(); render() }); qp.appendChild(qx)
      qp.appendChild(el('div','meta',L('报价不扣款 · 草稿/提交/Passkey 在下单卡完成 · 正式建单需你在 webaz.xyz 用 Passkey 批准','Quotes never charge · draft/submit/Passkey on the order card · real orders need Passkey on webaz.xyz')))
      root.appendChild(qp)
    }
    if(state.approval){   // A3-7(Holden):默认极简一行 —— 长 ID/完整 URL 收进「详情」;复制失败自动展开供手选(fail-visible 不打折)。
      var ap=el('div','hint')
      var __apDet=el('div',null,null); __apDet.style.display='none'
      function __openDet(){ __apDet.style.display='block'; return __apDet }
      ap.appendChild(el('span',null,(state.approval.duplicate?L('♻️ 已有同参数审批待批准','♻️ An identical approval is already pending'):L('✅ 审批已提交','✅ Approval submitted'))+L(' · 待你 Passkey 批准(批准前不扣款、不锁库存)',' · awaiting your Passkey (no charge / no stock hold before approval)')))
      if(state.approval.url){
        var ao=el('button','mini',L('打开审批页','Open approval page'))
        ao.addEventListener('click',onceGuard(function(){ var op=false; try{ op=openWebaz(oai,state.approval.url) }catch(e){ op=false } ao.textContent=op?L('已尝试打开 ↗','Opened ↗'):L('打开失败,请复制','Open failed — copy instead') }))
        ap.appendChild(ao)
        var ac=el('button','mini',L('复制链接','Copy link')); var __ae=el('div','recreason',state.approval.url)
        ac.addEventListener('click',function(){ doCopy(state.approval.url,ac,__openDet()&&__ae) }); ap.appendChild(ac)
      }
      var __dt7=el('button','mini',L('详情','Detail'))
      __dt7.addEventListener('click',function(){ var on=__apDet.style.display==='none'; __apDet.style.display=on?'block':'none'; __dt7.textContent=on?L('收起','Collapse'):L('详情','Detail') })
      ap.appendChild(__dt7)
      __apDet.appendChild(el('div','meta',L('审批号:','Approval id: ')+state.approval.request_id))
      if(state.approval.url){ __apDet.appendChild(__ae) }
      if(typeof oai.callTool==='function'){
        var ast=el('div','meta',null)
        var aslot=el('div',null,null)
        var arf=el('button','mini',L('查看最新状态','Check status'))
        arf.addEventListener('click',onceGuard(function(){
          ast.textContent=L('查询中…','Checking…')
          callWebazTool(oai,'webaz_approval_requests',{action:'get',request_id:state.approval.request_id}).then(function(res){
            var d=res.structuredContent||{}
            if(!d.display_status&&!d.status&&!d.error&&d.content&&d.content.length){ try{ var __t=d.content[0]&&d.content[0].text; if(__t&&__t.charAt(0)==='{'){ var __j=JSON.parse(__t); if(__j&&(__j.display_status||__j.status||__j.error)) d=__j } }catch(e){} }
            if(!d.display_status&&!d.status&&res&&res.structuredContent===undefined){ ast.textContent=L('查询失败,稍后重试或打开审批页查看','Check failed — retry later or open the approval page'); return }
            if(d.error){ ast.textContent=L('查询失败(','Check failed (')+String(d.error_code||d.error).slice(0,40)+L('),可打开审批页查看','), open the approval page'); return }
            var st;if(webazLocale()==='en'){var __ac={pending:'Pending approval',approved:'Approved (executing)',executed:'Executed — real order created',needs_reconcile:'Outcome pending (re-approve with Passkey to reconcile safely)',execution_failed:'Execution incomplete (re-approve to retry)',approved_retryable:'Execution incomplete (re-approve to retry)',failed:'Failed (terms drifted / draft unavailable)',rejected:'Rejected',expired:'Expired'};st=(d.status&&d.status.label_en)?d.status.label_en:(typeof d.status==='string'&&__ac[d.status])?__ac[d.status]:(d.display_status||((d.status&&typeof d.status==='object')?(d.status.label||d.status.code):String(d.status||'')))}else{st=(d.display_status||((d.status&&typeof d.status==='object')?(d.status.label||d.status.code):String(d.status||'')))}
            ast.textContent=L('状态:','Status: ')+(st||L('未知 —— 可打开审批页查看','unknown — open the approval page'))
            aslot.textContent=''
            if(d.order_url){
              var oue=el('div','recreason',String(d.order_url)); oue.style.display='none'
              var vo=el('button','mini',L('打开订单页','Open order page'))
              vo.addEventListener('click',onceGuard(function(){ var op=false; try{ op=openWebaz(oai,String(d.order_url)) }catch(e){ op=false } if(!op){ oue.style.display='block'; doCopy(String(d.order_url),vo,oue) } }))
              aslot.appendChild(vo); aslot.appendChild(oue)
            }
          })
        },16000))   // 审计F2:单飞窗 ≥ callWebazTool 15s 超时
        ap.appendChild(arf); ap.appendChild(ast); ap.appendChild(aslot)
      }
      ap.appendChild(__apDet)
      root.appendChild(ap)
    }
    if(state.hint){   // fail-visible 手动路径:一句可复制发给模型的话 —— 任何宿主上按钮不生效都能继续
      var hb=el('div','hint'); hb.appendChild(el('span',null,state.hint.text))
      if(state.hint.phrase){
        var phe=el('span','recreason','“'+state.hint.phrase+'”'); hb.appendChild(phe)
        var cp=el('button','mini',L('复制','Copy')); cp.addEventListener('click',function(){ doCopy(state.hint.phrase,cp,phe) }); hb.appendChild(cp)
      }
      root.appendChild(hb)
    }
    root.appendChild(el('div','note',L('报价不会扣款 · 草稿不锁库存 · 正式下单需你在 webaz.xyz 用 Passkey 批准 · ≈ 法币换算仅显示参考,非结算','Quotes never charge · drafts do not hold stock · ordering needs Passkey on webaz.xyz · ≈ fiat is display-only, not settlement')))
    try{ window.scrollTo(0, __sy) }catch(e){}   // B1:render 后恢复滚动位置(排序/比较/收起不跳顶)
  }
  render()
}export {}
