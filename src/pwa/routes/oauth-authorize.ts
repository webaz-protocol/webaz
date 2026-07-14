/**
 * RFC-023 PR-2a — OAuth /authorize request validation + endpoint (mints NOTHING yet).
 *
 * `GET /oauth/authorize` validates the incoming Authorization-Code+PKCE request, then hands off to
 * the SPA consent view (PR-2b) which runs the Passkey ceremony and POSTs to /oauth/authorize/approve
 * (also PR-2b) to actually mint a grant + single-use code. This file is the pure security surface:
 * no grant, no code, no token issued here.
 *
 * Security decisions enforced (RFC-023 §4/§6):
 *   T4/I-4  PKCE S256 REQUIRED — reject missing `code_challenge` or `code_challenge_method!=S256`
 *   T5      redirect_uri EXACT-match against the client allowlist; on mismatch NEVER redirect
 *   T8      scope must be a subset of the coarse SAFE scopes (D5) — no RISK scope reachable here
 *   I-3     resource must equal https://webaz.xyz/mcp (RFC 8707 audience binding)
 *   D3      clients come from a static allowlist (CIMD/DCR deferred)
 *   D4      public clients — no client secret is read
 *
 * Open-redirect safety: a `redirect_uri` is only ever used as a redirect target AFTER it exact-matched
 * an allowlisted client's registered URIs. invalid_client / redirect mismatch render an error page and
 * never redirect (a redirect there would be an open redirector to an attacker-chosen URL).
 */
import type { Express, Request, Response } from 'express'
import { OAUTH_RESOURCE, OAUTH_SCOPES } from './oauth-discovery.js'
import { dbAll } from '../../layer0-foundation/L0-1-database/db.js'

export interface OAuthClient {
  client_id: string
  name: string
  redirect_uris: readonly string[]
  verified?: boolean   // RFC-024: DCR clients are self-declared/unverified until curated (fast-follow)
}

// A local dev client is available ONLY when WEBAZ_OAUTH_DEV_CLIENT=1 (tests / local flows) — never prod.
const DEV_CLIENT: OAuthClient = {
  client_id: 'webaz-dev-client',
  name: 'WebAZ Dev Client (local only)',
  redirect_uris: ['http://localhost:8787/callback', 'http://127.0.0.1:8787/callback'],
  verified: true,
}

// RFC-024: the client allowlist is now the oauth_clients table (populated by Dynamic Client
// Registration, POST /oauth/register), unioned with the dev client under the flag. Async because it
// reads the DB via the RFC-016 seam; every caller already runs inside an async route handler.
export async function oauthClients(): Promise<OAuthClient[]> {
  const rows = await dbAll<{ client_id: string; name: string; redirect_uris: string; verified: number | null }>(
    "SELECT client_id, name, redirect_uris, verified FROM oauth_clients WHERE status = 'active'",
  )
  const clients: OAuthClient[] = rows.map(r => ({
    client_id: r.client_id,
    name: r.name,
    redirect_uris: (() => { try { const v = JSON.parse(r.redirect_uris); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [] } catch { return [] } })(),
    verified: r.verified === 1,
  }))
  if (process.env.WEBAZ_OAUTH_DEV_CLIENT === '1') clients.push(DEV_CLIENT)
  return clients
}

// RFC-024 T3 — redirect_uri policy: https OR loopback (any port); reject wildcards, fragments,
// userinfo, non-http(s) schemes. Same rule at registration AND (via exact-match) at /authorize.
// A syntactically valid host: DNS name (letters/digits/dot/hyphen), IPv4, or bracketed IPv6.
// Rejects wildcards (`*.evil`), spaces, and other junk Node's URL leaves in `hostname` (Codex P2).
const HOST_RE = /^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)$/
export function isRegisterableRedirectUri(uri: unknown): boolean {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2000) return false
  // Require printable-ASCII ONLY, BEFORE parsing (Codex round-2/3). A valid redirect_uri is always
  //   ASCII per RFC 3986 (unicode domains are punycode xn--, unicode paths are %-encoded). The WHATWG
  //   URL parser strips/IDNA-ignores many chars before u.hostname is read — raw C0 controls, DEL, and
  //   also non-ASCII like U+FEFF / U+200B / U+00AD / U+2060 / U+FE0F — any of which would normalize a
  //   junk string to a clean host and slip past HOST_RE. Rejecting everything outside 0x21..0x7e closes
  //   the whole class in one rule (no per-code-point blacklist to chase).
  if (!/^[\x21-\x7e]+$/.test(uri)) return false
  // The authority (host[:port]) must not be percent-encoded (Codex round-4): the URL parser decodes
  //   host %-escapes before u.hostname is read, so `https://%65xample.com` → `example.com` would pass
  //   HOST_RE. A host/port is never legitimately %-encoded. With ASCII-only + no host-%, the parsed
  //   host is a pure-ASCII, un-encoded string Node cannot rewrite (beyond case) → HOST_RE is reliable.
  const rawAuthority = /^https?:\/\/([^/?#]*)/i.exec(uri)?.[1] ?? ''
  if (rawAuthority.includes('%')) return false
  let u: URL
  try { u = new URL(uri) } catch { return false }
  if (u.hash || u.username || u.password) return false                       // no fragment / userinfo
  if (!HOST_RE.test(u.hostname)) return false                                // no wildcard / malformed host
  if (u.protocol === 'https:') return true
  if (u.protocol === 'http:') return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1'
  return false                                                               // no custom / non-http(s) schemes (v1)
}

// S256 code_challenge = base64url(SHA-256(verifier)) → 43 chars, base64url alphabet, no padding.
// Allow 43..128 to tolerate non-standard-but-valid verifiers without accepting junk.
const CODE_CHALLENGE_RE = /^[A-Za-z0-9\-_]{43,128}$/

type OAuthError =
  | 'invalid_client' | 'invalid_request' | 'unsupported_response_type'
  | 'invalid_scope' | 'invalid_target'

export type AuthorizeValidation =
  | { ok: true; client: OAuthClient; redirect_uri: string; scopes: string[]; code_challenge: string; resource: string; state?: string }
  | { ok: false; redirectable: false; error: OAuthError; error_description: string }
  | { ok: false; redirectable: true; redirect_uri: string; state?: string; error: OAuthError; error_description: string }

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Pure validation of an /authorize request. `clients` is the resolved allowlist (injected so tests
 * don't depend on env). Ordering matters for security: identify the client and pin the redirect_uri
 * FIRST — every later error is only redirectable because we've proven redirect_uri is allowlisted.
 */
export function validateAuthorizeRequest(q: Record<string, unknown>, clients: OAuthClient[]): AuthorizeValidation {
  const clientId = asStr(q.client_id)
  const client = clientId ? clients.find(c => c.client_id === clientId) : undefined
  if (!client) return { ok: false, redirectable: false, error: 'invalid_client', error_description: 'unknown or missing client_id' }

  const redirectUri = asStr(q.redirect_uri)
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    // NEVER redirect — an unregistered redirect_uri is exactly the open-redirect attack we must refuse.
    return { ok: false, redirectable: false, error: 'invalid_request', error_description: 'redirect_uri is not registered for this client' }
  }

  const state = asStr(q.state)
  const fail = (error: OAuthError, error_description: string): AuthorizeValidation =>
    ({ ok: false, redirectable: true, redirect_uri: redirectUri, state, error, error_description })

  if (asStr(q.response_type) !== 'code') return fail('unsupported_response_type', 'only response_type=code is supported')

  const challenge = asStr(q.code_challenge)
  if (asStr(q.code_challenge_method) !== 'S256' || !challenge || !CODE_CHALLENGE_RE.test(challenge)) {
    return fail('invalid_request', 'PKCE required: code_challenge_method must be S256 with a valid code_challenge')
  }

  if (asStr(q.resource) !== OAUTH_RESOURCE) return fail('invalid_target', `resource must be ${OAUTH_RESOURCE}`)

  const scopeRaw = asStr(q.scope)
  const scopes = scopeRaw ? scopeRaw.split(/\s+/).filter(Boolean) : []
  const allowed = new Set<string>(OAUTH_SCOPES as readonly string[])
  if (scopes.length === 0 || !scopes.every(s => allowed.has(s))) {
    return fail('invalid_scope', `scope must be a non-empty subset of: ${(OAUTH_SCOPES as readonly string[]).join(' ')}`)
  }

  return { ok: true, client, redirect_uri: redirectUri, scopes, code_challenge: challenge, resource: OAUTH_RESOURCE, state }
}

function appendQuery(url: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v)
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}${qs.toString()}`
}

function errorPage(error: string, description: string): string {
  const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Authorization error — webaz</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a1a;line-height:1.5}h1{font-size:1.25rem}code{background:#f2f2f2;padding:.1rem .35rem;border-radius:.25rem}a{color:#0a58ca}</style>
</head><body><main><h1>⚠️ Authorization request rejected</h1>
<p>This connection could not be authorized: <code>${esc(error)}</code>.</p>
<p>${esc(description)}</p>
<p><a href="/">← Back to webaz</a></p></main></body></html>`
}

export function registerOAuthAuthorizeRoutes(app: Express): void {
  if (process.env.WEBAZ_OAUTH !== '1') return                 // fail-closed
  if (process.env.WEBAZ_MODE === 'sandbox') {
    console.error('[oauth] REFUSING to mount /oauth/authorize: WEBAZ_MODE=sandbox must never expose OAuth')
    return
  }

  app.get('/oauth/authorize', async (req: Request, res: Response) => {
    const v = validateAuthorizeRequest(req.query as Record<string, unknown>, await oauthClients())
    res.setHeader('Cache-Control', 'no-store')

    if (v.ok) {
      // Hand off to the SPA consent view (PR-2b). Carry the VALIDATED params; approve re-validates.
      return void res.redirect(302, appendQuery('/#oauth-consent', {
        client_id: v.client.client_id,
        scope: v.scopes.join(' '),
        redirect_uri: v.redirect_uri,
        code_challenge: v.code_challenge,
        resource: v.resource,
        state: v.state,
      }))
    }
    if (v.redirectable) {
      // Safe: redirect_uri already proven allowlisted. Return the error to the client per OAuth.
      return void res.redirect(302, appendQuery(v.redirect_uri, { error: v.error, error_description: v.error_description, state: v.state }))
    }
    // Non-redirectable (bad client / unregistered redirect_uri) — render an error page, never redirect.
    return void res.status(400).setHeader('content-type', 'text/html; charset=utf-8').send(errorPage(v.error, v.error_description))
  })
}
