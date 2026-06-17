/**
 * Cloudflare-only origin guard (defense-in-depth against direct-to-origin bypass).
 *
 * webaz.xyz is proxied by Cloudflare, but the Railway origin can also be reachable directly
 * (via the generated `*.up.railway.app` domain) — a direct hit skips Cloudflare's WAF,
 * rate-limiting, DDoS protection, and traffic analytics. This guard rejects requests that did
 * NOT arrive through Cloudflare.
 *
 * Mechanism: a Cloudflare Transform Rule injects a shared-secret header on every proxied
 * request; a request lacking a valid secret came straight to the origin.
 *
 * SAFE BY DEFAULT — adding this code changes nothing until configured:
 *   CF_ORIGIN_GUARD_MODE = off (default) | observe | enforce
 *     off     — no-op
 *     observe — LOG would-be-blocked requests but ALLOW them (roll this out first to verify config)
 *     enforce — 403 requests without a valid secret header
 *   CF_ORIGIN_SHARED_SECRET — the shared secret (also set in the CF Transform Rule). High-entropy.
 *   CF_ORIGIN_GUARD_EXEMPT  — comma-separated paths that legitimately reach the origin without CF
 *                             (uptime/health probes). Default: /api/health,/healthz
 *
 * Fail-safe: never enforces without a configured secret (fails OPEN — never a full lockout).
 * Rollout: set secret + observe → confirm logs show legit traffic carries the header → flip enforce.
 */
import type { Request, Response, NextFunction } from 'express'
import { timingSafeEqual } from 'node:crypto'

export const CF_ORIGIN_HEADER = 'x-cf-origin-secret'
type Mode = 'off' | 'observe' | 'enforce'

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function createCfOriginGuard(env: NodeJS.ProcessEnv = process.env) {
  const mode = (env.CF_ORIGIN_GUARD_MODE || 'off').toLowerCase() as Mode
  const secret = env.CF_ORIGIN_SHARED_SECRET || ''
  const exempt = new Set(
    (env.CF_ORIGIN_GUARD_EXEMPT || '/api/health,/healthz')
      .split(',').map(s => s.trim()).filter(Boolean),
  )
  return function cfOriginGuard(req: Request, res: Response, next: NextFunction): void {
    if (mode === 'off') return next()
    if (exempt.has(req.path)) return next()
    if (!secret) {
      if (mode === 'enforce') {
        console.error('[cf-origin-guard] enforce set but CF_ORIGIN_SHARED_SECRET is empty — failing OPEN (no block)')
      }
      return next()
    }
    const got = req.get(CF_ORIGIN_HEADER) || ''
    if (got && safeEqual(got, secret)) return next()   // arrived via Cloudflare
    if (mode === 'observe') {
      console.warn(`[cf-origin-guard] observe: would block direct-origin ${req.method} ${req.path} ip=${req.ip}`)
      return next()
    }
    res.status(403).json({ error: 'direct origin access not allowed; use the public endpoint', error_code: 'CF_ORIGIN_ONLY' })
  }
}
