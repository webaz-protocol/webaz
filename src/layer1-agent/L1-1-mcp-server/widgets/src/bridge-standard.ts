
  export function makeStandardBridge(onToolResult){
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
