
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
export {}
