
  export function safeWebazHref(h){ try{ var u=new URL(String(h)); if(u.protocol==='https:'&&u.hostname==='webaz.xyz'&&u.port===''&&u.username===''&&u.password==='') return u.href }catch(e){} return null }
  export function openWebaz(oai,href){ var h=safeWebazHref(href); if(!h) return false; if(oai&&typeof oai.openExternal==='function'){ oai.openExternal({href:h}); return true } return false }
