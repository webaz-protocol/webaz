/**
 * cf-origin-guard — reject requests that did NOT arrive through the Cloudflare edge.
 *
 * webaz.xyz is proxied by Cloudflare, but the Railway origin (robust-heart-production.up.railway.app)
 * is ALSO publicly reachable. An attacker hitting the origin directly can forge `CF-Connecting-IP` and
 * bypass every per-IP rate limit keyed on it (/mcp, /oauth/token, /oauth/register — DoS-class, not an
 * auth bypass, but real). This middleware closes that path for the sensitive surfaces by requiring a
 * shared secret that ONLY Cloudflare injects, so a direct-origin request (which never transits CF)
 * cannot present it.
 *
 * Activation (DORMANT until BOTH are configured — while WEBAZ_EDGE_SECRET is unset this is a pure
 * pass-through, zero behavior change, zero lock-out risk):
 *   1. Cloudflare → Rules → Transform Rules → Modify Request Header → "Set static": header
 *      `X-Webaz-Edge` = <secret>, scoped to the webaz.xyz zone. CF adds it origin-bound; it is never
 *      returned to clients.
 *   2. Railway: set WEBAZ_EDGE_SECRET = <the same secret> on robust-heart.
 * Legitimate traffic always transits CF via webaz.xyz (incl. /mcp tool self-callbacks, which use
 * WEBAZ_PUBLIC_URL=https://webaz.xyz), so it carries the header; direct-origin hits do not.
 *
 * Scope: mount on /mcp and /oauth (authorize/approve/token/register). NOT on /.well-known discovery —
 * that metadata is meant to be publicly fetchable and carries no rate-limit-bypass value.
 */
import type { Express, Request, Response, NextFunction } from 'express'
import { timingSafeEqual } from 'node:crypto'

const EDGE_HEADER = 'x-webaz-edge'

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false          // timingSafeEqual throws on length mismatch
  return timingSafeEqual(a, b)
}

/**
 * Express middleware. When WEBAZ_EDGE_SECRET is set, requires the CF-injected `X-Webaz-Edge` header to
 * match it (timing-safe); otherwise 403. When unset, passes through unchanged (dormant).
 */
export function requireEdgeOrigin(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.WEBAZ_EDGE_SECRET?.trim()
  if (!expected) return next()                     // dormant: not configured → no-op
  const provided = String(req.headers[EDGE_HEADER] || '')
  if (provided && secretsMatch(provided, expected)) return next()
  res.status(403).json({
    error: 'forbidden',
    error_description: 'direct origin access is not allowed; reach this API via https://webaz.xyz',
  })
}

/** Mount the guard on the sensitive surfaces (/mcp, /oauth/*). Discovery (/.well-known) stays public. */
export function mountEdgeOriginGuard(app: Express): void {
  app.use('/mcp', requireEdgeOrigin)
  app.use('/oauth', requireEdgeOrigin)
}
