
  // i18n(批0):跨 agent 语言探测(能力探测瀑布,一次缓存;与 theme 探测同款 try/catch 绝不抛)。
  //   window.openai.locale(ChatGPT)→ navigator.language(任何 iframe 宿主兜底)→ 默认 zh;en 前缀→'en' 否则 'zh'。
  var __webazLoc=null
  export function webazLocale(){
    if(__webazLoc) return __webazLoc
    var lc=''
    try{ if(window.openai&&typeof window.openai.locale==='string') lc=window.openai.locale }catch(e){}
    try{ if(!lc&&typeof navigator!=='undefined'&&navigator.language) lc=navigator.language }catch(e){}
    __webazLoc=(/^en/i.test(String(lc||''))) ? 'en' : 'zh'
    return __webazLoc
  }
  export function L(zh, en){ return webazLocale()==='en' ? en : zh }
  // rail honesty note, rendered client-side from the canonical payment_rail (keeps the model-context
  // projection lean — server sends only the zh rail_note + machine payment_rail, not a display _en sibling).
  export function railNoteText(rail, zhFallback){
    if(webazLocale()!=='en') return zhFallback||''
    if(String(rail)==='deferred') return 'Payment method not chosen yet — you will choose from the seller\'s supported methods on the confirm page before approval'   // RFC-029 Design A:deferred 绝不显示成模拟托管
    if(String(rail)==='direct_p2p') return 'You pay the seller directly; WebAZ holds no principal; the actual method and currency are shown on the confirm page'
    // B6b-1:usdc_escrow = REAL on-chain custody. Explicit branch; the DEFAULT keeps the legacy
    //   simulated-escrow wording (fail-closed — an unknown future rail is never called real custody).
    // B6b-2 B1: do NOT claim "WebAZ never touches the principal" — the contract deducts a platform fee
    //   (feeBps) from the escrowed amount, and the arbiter key can flag+resolve a Funded escrow. Defensible
    //   claim instead: the platform cannot send the funds to an arbitrary address.
    if(String(rail)==='usdc_escrow') return 'Payment rail: on-chain escrow — your USDC is held by the WebAZ escrow contract on Base and released to the seller on delivery confirmation (or after the no-dispute timeout). The contract can only pay the buyer, the seller, or the platform fee (deducted from the escrowed amount) — WebAZ cannot move the funds to any other address; in a dispute the platform arbiter key decides the split'
    return 'Payment rail: simulated escrow test — this flow is not real USDC or fiat settlement'
  }
  // Localized payment-rail LABEL. Only 'deferred' is special-cased (shown as pending) — escrow/direct_p2p
  // keep their existing raw display to avoid churning non-deferred cards.
  // Only 'deferred' is special-cased (shown as pending); every other value passes through RAW (incl. null →
  // '') so each call site keeps its OWN fallback and non-deferred cards stay byte-identical.
  export function railDisplay(rail){
    return String(rail)==='deferred' ? L('待选(确认时选择)','Not chosen yet (choose at confirm)') : String(rail||'')
  }
  // webaz_approval_requests 'get' returns status as a bare machine code + a zh display_status (no _en
  // sibling — the model-context projection stays lean). Localize it client-side here so every card's
  // live status refresh renders the right language instead of the raw code. `s` may also be a v2 object
  // {code,label,label_en} (quote/draft submit) — handled first. Single source so the two call sites can't drift.
  export function apprStatusText(s, displayZh){
    if(s&&typeof s==='object') return webazLocale()==='en' ? String(s.label_en||s.label||s.code||'') : String(s.label||s.code||'')
    var code=String(s||'')
    if(webazLocale()!=='en') return String(displayZh||code)
    var m={pending:'Pending approval',approved:'Approved (executing)',executed:'Executed — real order created',needs_reconcile:'Outcome pending (re-approve with Passkey to reconcile safely)',execution_failed:'Execution incomplete (re-approve to retry)',approved_retryable:'Execution incomplete (re-approve to retry)',failed:'Failed (terms drifted / draft unavailable)',rejected:'Rejected',expired:'Expired'}
    return m[code]||String(displayZh||code)
  }

  export function canFollowUp(oai){ return !!oai&&(typeof oai.sendFollowUpMessage==='function'||typeof oai.sendFollowupTurn==='function') }
  export function sendFollowUpCompat(oai,text){
    if(!oai) return false
    if(typeof oai.sendFollowUpMessage==='function'){ oai.sendFollowUpMessage({prompt:text}); return true }
    if(typeof oai.sendFollowupTurn==='function'){ oai.sendFollowupTurn({prompt:text}); return true }
    return false
  }
  export function onceGuard(fn,ms){ var busy=false; return function(){ if(busy)return; busy=true; try{ fn.apply(null,arguments) }finally{ setTimeout(function(){busy=false},ms||1500) } } }
  // F3(Round1 UI hotfix):统一 ETA formatter —— 商品卡/报价卡/时间线共用,永不显示原始 JSON。
  //   入参可为 number / 数字串 / 范围串("3-5") / 范围对象 / 区域→天数 map({"SG":12,"all":12}) / promised_eta v1 / null。
  //   优先目的区域 → all/default → 首个数值;输出「约12天」「3–5天」「暂未提供预计配送时间」;绝不伪造具体日期。
  export function etaDisplay(v, region){
    if(v==null) return L('暂未提供预计配送时间','delivery estimate unavailable')
    if(typeof v==='number'){ return isFinite(v)?L('约'+v+'天','~'+v+' days'):L('暂未提供预计配送时间','delivery estimate unavailable') }
    if(typeof v==='string'){ var t=v.trim(); if(!t) return L('暂未提供预计配送时间','delivery estimate unavailable')
      if(/^\d+$/.test(t)) return L('约'+t+'天','~'+t+' days')
      if(/^\d+\s*[-–~]\s*\d+$/.test(t)) return t.replace(/\s*[-–~]\s*/,'–')+L('天',' days')
      if(t.charAt(0)==='{'||t.charAt(0)==='['){ try{ return etaDisplay(JSON.parse(t), region) }catch(e){} }   // B-1(Round1b):JSON 字符串区域 map(如报价投影传来的 '{"SG":12,"all":12}')→ 解析后递归;解析失败安全回退原串
      return t }
    if(typeof v==='object'){
      if(v.legacy_missing) return L('下单时未记录预计配送时间','delivery time not recorded at order')
      var lo=(v.estimated_min_days!=null)?v.estimated_min_days:v.min, hi=(v.estimated_max_days!=null)?v.estimated_max_days:v.max
      if(lo!=null&&hi!=null) return (lo===hi)?L('约'+lo+'天','~'+lo+' days'):(lo+'–'+hi+L('天',' days'))
      if(v.estimated_days_text!=null){ var et=String(v.estimated_days_text).trim(); return et?L('约'+et+'天','~'+et+' days'):L('暂未提供预计配送时间','delivery estimate unavailable') }
      var r=(region!=null)?String(region).toUpperCase():null, pick=null
      if(r&&v[r]!=null) pick=v[r]; else if(v.all!=null) pick=v.all; else if(v.default!=null) pick=v.default
      else { for(var k in v){ if(v[k]!=null&&(typeof v[k]==='number'||/^\d+$/.test(String(v[k])))){ pick=v[k]; break } } }
      if(pick!=null){ return (typeof pick==='number'||/^\d+$/.test(String(pick)))?L('约'+pick+'天','~'+pick+' days'):String(pick) }
      return L('暂未提供预计配送时间','delivery estimate unavailable')
    }
    return L('暂未提供预计配送时间','delivery estimate unavailable')
  }
  // F4(Round1 UI hotfix):统一工具调用 —— legacy(window.openai.callTool)与标准桥 facade.callTool 都返回 promise,
  //   单一 consume 路径就地消费 structuredContent(不依赖宿主重挂载/重渲染)。归一 {ok,structuredContent,error,timeout,sourceBridge};
  //   15s 超时;调用期 __inlineConsuming>0 抑制标准桥 tool-result 通知的重复渲染(同一结果只渲染一次)。正常路径【绝不】 sendFollowUp。
  var __inlineConsuming=0
  export function webazConsume(r){ return (r&&typeof r==='object'&&r.structuredContent)?r.structuredContent:r }
  export function callWebazTool(oai, name, args){
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
  // B-4(Round1b):卡内复制降级 —— 主路 clipboard.writeText;失败→点击事件内 execCommand('copy');再失败→自动选中文本(Cmd/Ctrl+C);最后才手选。
  //   任何分支都【绝不】触发报价/下单/工具调用。用词避开 widget SINK 守卫(execCommand/value/select 均不在禁用表)。
  export function webazExecCopy(text){ try{ var ta=document.createElement('textarea'); ta.value=String(text); ta.setAttribute('readonly',''); ta.style.position='fixed'; ta.style.top='-1000px'; document.body.appendChild(ta); ta.focus(); ta.select(); var okc=false; try{ okc=document.execCommand('copy') }catch(e){ okc=false } document.body.removeChild(ta); return okc }catch(e){ return false } }
  export function webazSelect(el){ try{ if(!el||typeof document==='undefined'||!document.createRange) return false; var r=document.createRange(); r.selectNodeContents(el); var s=window.getSelection(); s.removeAllRanges(); s.addRange(r); return true }catch(e){ return false } }
  export function webazCopy(text, btn, selEl){
    var s=String(text)
    function afterFail(){ if(webazExecCopy(s)){ if(btn) btn.textContent=L('已复制✓','Copied ✓'); return } if(webazSelect(selEl)){ if(btn) btn.textContent=L('已选中,按 Cmd/Ctrl+C 复制','Selected — press Cmd/Ctrl+C'); return } if(btn) btn.textContent=L('请手动选择上面文字','Select the text above manually') }
    try{ var nav=(typeof navigator!=='undefined')?navigator:null
      if(nav&&nav.clipboard&&nav.clipboard.writeText){ if(btn) btn.textContent=L('复制中…','Copying…'); nav.clipboard.writeText(s).then(function(){ if(btn) btn.textContent=L('已复制✓','Copied ✓') }, afterFail); return }
    }catch(e){}
    afterFail()
  }
