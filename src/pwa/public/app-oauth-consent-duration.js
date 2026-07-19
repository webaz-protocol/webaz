// RFC-023 PR-2 — OAuth consent 连接时长选择器(从 app-oauth-consent.js 抽出以守 complexity ratchet)。
//   值域固定为 SAFE scope 允许的 1h/24h/7d/30d(服务端 durationAllowedForScopes 权威再校验),默认 30d。
//   经典脚本,全局 window.*;t() 在调用时解析。
;(function () {
  window.oauthDurationBlockHtml = function () {
    return `<div style="margin-top:12px">
      <label for="oauth-duration" style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px">${t('连接保持时长')}</label>
      <select id="oauth-duration" class="input" style="width:100%">
        <option value="1h">${t('1 小时')}</option>
        <option value="24h">${t('1 天')}</option>
        <option value="7d">${t('7 天')}</option>
        <option value="30d" selected>${t('30 天(推荐)')}</option>
      </select>
      <div style="font-size:11px;color:#9ca3af;margin-top:4px;line-height:1.5">${t('到期后需重新授权;你也可随时在「已连接的应用」中撤销。')}</div>
    </div>`
  }
  // 读取当前选择;缺省 30d(与服务端 OAUTH_DEFAULT_DURATION 一致)。同步读,可安全多次调用。
  window.oauthReadDuration = function () {
    const el = document.getElementById('oauth-duration')
    return (el && el.value) || '30d'
  }
})()
