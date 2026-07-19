/**
 * RFC-023 PR-1 — OAuth discovery metadata (foundation, NO token issuance yet).
 *
 * Serves the two documents a compliant MCP client reads to find the Authorization Server:
 *   GET /.well-known/oauth-protected-resource   (RFC 9728) — the resource + which AS protects it
 *   GET /.well-known/oauth-authorization-server  (RFC 8414) — AS endpoints + capabilities
 *
 * Locked decisions surfaced here (RFC-023 §6):
 *   - PKCE S256 ONLY (I-4): code_challenge_methods_supported = ["S256"]
 *   - public clients, no secret (D4): token_endpoint_auth_methods_supported = ["none"]
 *   - authorization_code + refresh_token (PR-1 refresh): grant_types_supported advertises both
 *   - audience-bound resource (I-3): resource = https://webaz.xyz/mcp
 *   - coarse SAFE scopes (D5)
 *
 * Fail-closed: mounted only when WEBAZ_OAUTH=1 (and never under sandbox). This PR advertises that an
 * AS exists + its shape; the /authorize and /token endpoints (PR-2/PR-3) are not built yet, so the
 * advertised URLs will 404 until then — acceptable because the flag stays OFF until PR-5 ships.
 */
import type { Express, Request, Response } from 'express'

const BASE = 'https://webaz.xyz'
export const OAUTH_RESOURCE = `${BASE}/mcp`
// v1 coarse SAFE scopes (D5) — mapped onto capability-matrix SAFE actions in PR-2/PR-4.
export const OAUTH_SCOPES = ['read', 'order:draft', 'list:draft', 'chat:context', 'address', 'aftersales:request'] as const   // RFC-026 PR-5:address = masked 读 + 变更【请求】(写永远要 Passkey)   // RFC-026 PR-4:上下文绑定聊天(仅订单参与方,无自由私信)

export function oauthEnabled(): boolean {
  return process.env.WEBAZ_OAUTH === '1' && process.env.WEBAZ_MODE !== 'sandbox'
}

export function registerOAuthDiscoveryRoutes(app: Express): void {
  if (process.env.WEBAZ_OAUTH !== '1') return                 // fail-closed
  if (process.env.WEBAZ_MODE === 'sandbox') {
    console.error('[oauth] REFUSING to mount: WEBAZ_MODE=sandbox must never expose OAuth')
    return
  }

  // RFC 9728 — Protected Resource Metadata.
  // Served at BOTH the root and the path-suffixed URI (RFC 9728 §3.1: a resource whose identifier
  // carries a path — here /mcp — is discovered at /.well-known/oauth-protected-resource/mcp). A
  // strict MCP client derives the suffixed form; without it the request falls through to the SPA.
  const protectedResource = (_req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json({
      resource: OAUTH_RESOURCE,
      authorization_servers: [BASE],
      bearer_methods_supported: ['header'],
      resource_documentation: `${BASE}/docs/REMOTE-MCP.md`,
    })
  }
  app.get('/.well-known/oauth-protected-resource', protectedResource)
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource)

  // RFC 8414 — Authorization Server Metadata
  app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      revocation_endpoint: `${BASE}/oauth/revoke`,            // RFC 7009 — clients revoke (disconnect) their token
      registration_endpoint: `${BASE}/oauth/register`,        // RFC-024 DCR (RFC 7591) — clients self-register
      scopes_supported: [...OAUTH_SCOPES],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],   // PR-1: rotating refresh tokens
      code_challenge_methods_supported: ['S256'],              // PKCE S256 only (I-4)
      token_endpoint_auth_methods_supported: ['none'],         // public clients, PKCE (D4)
      resource_indicators_supported: true,                     // RFC 8707 (I-3)
    })
  })
}
