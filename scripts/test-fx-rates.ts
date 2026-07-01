#!/usr/bin/env tsx
/**
 * FX rates (display-only) — USDC→local conversion for buyer price display.
 *
 * Verifies the DISPLAY-ONLY contract: region→currency mapping, USDC≈USD conversion math, live-fetch parsing,
 * the cache, and the never-break fallback (stale flag). Behavioral: getUsdRates runs against an INJECTED fake
 * fetch (hermetic — no real network), and the endpoint smoke primes the cache first so CI never hits the API.
 *
 * Usage: npm run test:fx-rates
 */
import express from 'express'
import type { AddressInfo } from 'node:net'
import {
  regionToCurrency, convertUsdcToLocal, parseUsdRates, getUsdRates,
  FALLBACK_USD_RATES, SUPPORTED_CURRENCIES, __resetFxCacheForTest,
} from '../src/fx-rates.js'
import { registerFxRoutes } from '../src/pwa/routes/fx.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}`) } }

const okRates = { rates: { USD: 1, CNY: 7.2, EUR: 0.92, INR: 83, SGD: 1.35, JPY: 150 } }
const fakeFetch = (payload: unknown, okFlag = true): typeof fetch =>
  (async () => ({ ok: okFlag, status: okFlag ? 200 : 500, json: async () => payload })) as unknown as typeof fetch
const throwFetch: typeof fetch = (async () => { throw new Error('network down') }) as unknown as typeof fetch

// 1. region → local currency
ok('1a. china→CNY', regionToCurrency('china') === 'CNY')
ok('1b. singapore→SGD', regionToCurrency('singapore') === 'SGD')
ok('1c. us→USD', regionToCurrency('us') === 'USD')
ok('1d. unknown/null/global → USD', regionToCurrency('mars') === 'USD' && regionToCurrency(null) === 'USD' && regionToCurrency('global') === 'USD')

// 2. conversion math (display-only, USDC≈USD)
ok('2a. 30 USDC × 7.2 = 216 CNY', convertUsdcToLocal(30, 'CNY', okRates.rates as never) === 216)
ok('2b. USD is identity', convertUsdcToLocal(49.99, 'USD', okRates.rates as never) === 49.99)
ok('2c. bad rate/amount → NaN', Number.isNaN(convertUsdcToLocal(30, 'CNY', { CNY: 0 } as never)) && Number.isNaN(convertUsdcToLocal(NaN, 'USD', okRates.rates as never)))

// 3. parse — subset only, strict
ok('3a. parses supported subset', JSON.stringify(parseUsdRates(okRates)) === JSON.stringify({ USD: 1, CNY: 7.2, EUR: 0.92, INR: 83, SGD: 1.35 }))
ok('3b. conversion_rates alt key works', parseUsdRates({ conversion_rates: okRates.rates }).SGD === 1.35)
ok('3c. missing a supported rate → throws', (() => { try { parseUsdRates({ rates: { USD: 1 } }); return false } catch { return true } })())
ok('3d. non-object → throws', (() => { try { parseUsdRates(null); return false } catch { return true } })())

// 4. getUsdRates — live, cache, fallback (behavioral, injected fetch + now)
{
  __resetFxCacheForTest()
  const live = await getUsdRates(fakeFetch(okRates), 1_000_000)
  ok('4a. live fetch → stale:false + real rates', live.stale === false && live.rates.CNY === 7.2 && live.base === 'USD')
  // within TTL → cached even if fetch would now throw
  const cached = await getUsdRates(throwFetch, 1_000_000 + 60_000)
  ok('4b. within TTL returns cache (no re-fetch)', cached.stale === false && cached.rates.CNY === 7.2)
  // past TTL + fetch fails → serve last-known, flagged stale
  const stale = await getUsdRates(throwFetch, 1_000_000 + 60 * 60 * 1000)
  ok('4c. past TTL + failure → last-known, stale:true', stale.stale === true && stale.rates.CNY === 7.2)
}
{
  __resetFxCacheForTest()
  const fb = await getUsdRates(throwFetch, 2_000_000)
  ok('4d. failure with NO cache → fallback table, stale:true', fb.stale === true && fb.rates.CNY === FALLBACK_USD_RATES.CNY)
}
{
  __resetFxCacheForTest()
  const bad = await getUsdRates(fakeFetch(okRates, false), 3_000_000)   // http 500
  ok('4e. non-ok HTTP → fallback, stale:true', bad.stale === true && bad.rates.USD === 1)
}

// 5. fallback table completeness
ok('5a. fallback covers every supported currency', SUPPORTED_CURRENCIES.every(c => Number(FALLBACK_USD_RATES[c]) > 0))

// 6. endpoint smoke — prime cache first so the route returns cached (no real network in CI)
{
  __resetFxCacheForTest()
  await getUsdRates(fakeFetch(okRates), Date.now())   // prime fresh cache
  const app = express()
  registerFxRoutes(app, { rateLimitOk: () => true })
  const server = app.listen(0)
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const r = await fetch(`${base}/api/fx/rates`)
    const body = await r.json() as { base: string; rates: Record<string, number>; currencies: string[]; stale: boolean }
    ok('6a. GET /api/fx/rates → 200', r.status === 200)
    ok('6b. returns base USD + rates + currencies', body.base === 'USD' && body.rates.CNY === 7.2 && Array.isArray(body.currencies) && body.currencies.includes('SGD'))
    // rate-limit path
    const app2 = express(); registerFxRoutes(app2, { rateLimitOk: () => false })
    const s2 = app2.listen(0)
    const base2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`
    const rl = await fetch(`${base2}/api/fx/rates`)
    ok('6c. rate-limited → 429', rl.status === 429)
    s2.close()
  } finally { server.close() }
}

if (fail > 0) { console.error(`\n❌ fx-rates FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ fx-rates (display-only): region→currency + USDC≈USD convert + live/cache/fallback(stale) + endpoint\n  ✅ pass ${pass}`)
