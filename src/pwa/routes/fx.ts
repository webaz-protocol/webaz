/**
 * FX rates route (DISPLAY-ONLY) — public buyer-facing USDC→local-currency conversion rates.
 *
 * GET /api/fx/rates → { base:'USD', rates:{USD,CNY,EUR,INR,SGD}, as_of, stale, currencies }
 *   Public no-auth (a price hint anyone browsing needs), rate-limited (it is external-API-backed), short
 *   HTTP cache. NEVER a settlement path — the returned rates only drive an informational "≈ local" display;
 *   the USDC amount owed is unaffected. See src/fx-rates.ts for the peg/cache/fallback semantics.
 */
import type { Application } from 'express'
import { getUsdRates, SUPPORTED_CURRENCIES } from '../../fx-rates.js'

export interface FxDeps {
  rateLimitOk: (key: string, max?: number, windowMs?: number) => boolean
}

export function registerFxRoutes(app: Application, deps: FxDeps): void {
  const { rateLimitOk } = deps

  app.get('/api/fx/rates', async (req, res) => {
    const ip = req.ip || 'unknown'
    if (!rateLimitOk(`fx:${ip}`, 60, 60_000)) return void res.status(429).json({ error: 'rate-limited' })
    const snap = await getUsdRates()
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json({ ...snap, currencies: SUPPORTED_CURRENCIES })
  })
}
