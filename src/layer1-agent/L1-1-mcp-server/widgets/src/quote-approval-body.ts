// @ts-nocheck — A1 冻结期:body 源码字节级冻结(内容 hash 不变),语义标注留给 A2;语法错误仍会上报。生成器会剥离本行。

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
  function actHint(phrase, sent, lead){
    var h=el('div','disc'); h.appendChild(el('span',null,(lead||(sent?'已发送。若卡片没有刷新,复制发我:':'此宿主不支持一键,复制发我:'))))
    var pe=el('span','ok',' “'+phrase+'” '); h.appendChild(pe)
    var cp=el('button','toggle','复制'); cp.addEventListener('click',function(){ webazCopy(phrase,cp,pe) }); h.appendChild(cp); root.appendChild(h)   // B-4:降级复制(clipboard→execCommand→自动选中)
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
  function qtyOk(q){ if(typeof q==='number'){ return isFinite(q)&&Math.floor(q)===q&&q>0&&q<=9007199254740991 } if(typeof q==='string'){ var t=q.trim(); if(!/^\d+$/.test(t)) return false; var n=Number(t); return n>0&&n<=9007199254740991 } return false }
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
      else { b1.addEventListener('click',onceGuard(function(){ b1.disabled=true
        actHint('用这个报价创建订单草稿(quote_token='+String(out.quote_token)+')', true, '正在创建订单草稿…若卡片未更新为草稿,复制发我:')   // 同步 fail-visible:立即留可复制手动路径,永不静默/永不卡死
        callWebazTool(oai,'webaz_order_draft',{action:'create',quote_token:out.quote_token}).then(function(res){   // F4:就地消费结果 → 渲染草稿卡(替换上方 hint);失败/超时保留手动路径并可重试
          if(res.ok&&res.structuredContent){ renderBody(oai,res.structuredContent); return }
          b1.disabled=false
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
      else { b2.addEventListener('click',onceGuard(function(){ b2.disabled=true
        actHint('提交这个草稿去 Passkey 审批(draft_id='+String(out.draft_id)+')', true, '正在提交 Passkey 审批…若卡片未更新为审批,复制发我:')   // 同步 fail-visible:立即留可复制手动路径
        callWebazTool(oai,'webaz_submit_order_request',withTrace({draft_id:out.draft_id})).then(function(res){   // F4:就地消费 → 渲染审批卡;money 参数 withTrace 不变,仅新增结果消费;失败/超时保留手动路径
          if(res.ok&&res.structuredContent){ renderBody(oai,res.structuredContent); return }
          b2.disabled=false
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
      var href='https://webaz.xyz/'+String(out.approval_url||'').replace(/^\//,'')
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
                newOpen.addEventListener('click',onceGuard(function(){ var href='https://webaz.xyz/'+String(s.approval_url||'').replace(/^\//,''); var op=false; try{op=openWebaz(oai,href)}catch(e){op=false} actHint(href,op,(op?'已尝试打开新审批;若没弹出':'此宿主未能打开')+',复制到浏览器用 Passkey 批准:') }))
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
}export {}
