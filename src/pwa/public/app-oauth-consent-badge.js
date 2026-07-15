// RFC-024 — verified-connector ✓ badge for the OAuth consent screen (#oauth-consent).
// Split out of app-oauth-consent.js to respect that file's LOC ceiling.
//
// Upgrades #oauth-client-block to a green ✓ + canonical vendor name ONLY when the SERVER confirms the
// client is a verified connector — i.e. every one of its registered redirect_uris is an official vendor
// host (see oauth-verified-connectors.ts). Fetched by client_id from /oauth/authorize/client-info; the
// SPA NEVER trusts a URL param for "verified" (an attacker could craft a consent URL with verified=1 to
// fake a ✓). On any failure or for an unverified client we leave the default "self-declared, unverified"
// block untouched — introducing no new impersonation surface.
;(function () {
  window.loadOAuthClientBadge = async function loadOAuthClientBadge(clientId, redirectUri) {
    let info
    try {
      const qs = 'client_id=' + encodeURIComponent(clientId) + '&redirect_uri=' + encodeURIComponent(redirectUri || '')
      const res = await fetch('/oauth/authorize/client-info?' + qs)
      if (!res.ok) return
      info = await res.json()
    } catch (e) { return }
    if (!info || !info.found || !info.verified || !info.verified_label) return
    const block = document.getElementById('oauth-client-block')
    if (!block) return
    block.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#059669;font-weight:600">
        <span aria-hidden="true">✓</span><span>${t('已验证的连接方')}</span>
      </div>
      <div style="font-size:17px;font-weight:700;margin:2px 0 4px">${escHtml(info.verified_label)}</div>
      <div style="font-size:11px;color:#9ca3af;font-family:monospace;margin-bottom:10px">${escHtml(clientId)}</div>`
  }
})()
