// @ts-nocheck — body 为 ES5 风格运行时脚本(el() 可选参/动态 state),完整类型标注另行任务;语法错误仍会上报。生成器会剥离本行。

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
}export {}
