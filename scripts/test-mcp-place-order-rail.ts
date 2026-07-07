#!/usr/bin/env tsx
/**
 * PR-3 — MCP conforms to the PWA direct-pay purchase rail (no parallel money model). webaz_place_order:
 *   only escrow (legacy) + direct_p2p (live) are selectable; onchain_full_stake / psp → PAYMENT_RAIL_DISABLED.
 *   payment_rail + direct_receive_account_id are forwarded VERBATIM to the SAME /api/orders route (which runs
 *   all the PWA gates); default (no rail) stays the existing escrow behavior. No product currency field is added.
 * Usage: npm run test:mcp-place-order-rail
 */
import { readFileSync } from 'node:fs'
import express from 'express'; import type { AddressInfo } from 'node:net'

process.env.WEBAZ_MODE = 'network'                 // place_order forwards to /api/orders in network mode
process.env.WEBAZ_API_KEY = 'k_test_buyer'
// Ephemeral "PWA" that just echoes the received body — proves the MCP forwards params, without re-implementing gates.
const app = express(); app.use(express.json())
let lastBody: Record<string, unknown> = {}
app.post('/api/orders', (req, res) => { lastBody = req.body; res.json({ ok: true, _received: req.body }) })
const server = app.listen(0); const port = (server.address() as AddressInfo).port
process.env.WEBAZ_API_URL = `http://127.0.0.1:${port}`

const mcp = await import('../src/layer1-agent/L1-1-mcp-server/server.js')
const SRC = readFileSync('src/layer1-agent/L1-1-mcp-server/server.ts', 'utf8')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

try {
  // ── disabled rails → PAYMENT_RAIL_DISABLED (refused in the MCP, never forwarded / downgraded) ──
  const onchain = await mcp.handlePlaceOrder({ product_id: 'p1', payment_rail: 'onchain_full_stake', api_key: 'k' })
  ok('onchain_full_stake → PAYMENT_RAIL_DISABLED', onchain.error_code === 'PAYMENT_RAIL_DISABLED')
  const psp = await mcp.handlePlaceOrder({ product_id: 'p1', payment_rail: 'psp', api_key: 'k' })
  ok('psp → PAYMENT_RAIL_DISABLED', psp.error_code === 'PAYMENT_RAIL_DISABLED')
  const bogus = await mcp.handlePlaceOrder({ product_id: 'p1', payment_rail: 'bank_transfer', api_key: 'k' })
  ok('any non-live rail → PAYMENT_RAIL_DISABLED', bogus.error_code === 'PAYMENT_RAIL_DISABLED')

  // ── default (no payment_rail) → existing escrow behavior; nothing rail-related forwarded ──
  lastBody = {}
  await mcp.handlePlaceOrder({ product_id: 'p1', quantity: 2, api_key: 'k' })
  ok('no payment_rail → forwards to /api/orders without payment_rail (escrow compat)', lastBody.product_id === 'p1' && lastBody.quantity === 2 && lastBody.payment_rail === undefined && lastBody.direct_receive_account_id === undefined)

  // ── direct_p2p → payment_rail + direct_receive_account_id forwarded VERBATIM to the same route ──
  lastBody = {}
  await mcp.handlePlaceOrder({ product_id: 'p1', payment_rail: 'direct_p2p', direct_receive_account_id: 'dra_99', api_key: 'k' })
  ok('direct_p2p → forwards payment_rail + direct_receive_account_id to /api/orders (server gates it)', lastBody.payment_rail === 'direct_p2p' && lastBody.direct_receive_account_id === 'dra_99')

  // ── escrow explicit → forwarded (route treats it as the legacy path) ──
  lastBody = {}
  await mcp.handlePlaceOrder({ product_id: 'p1', payment_rail: 'escrow', api_key: 'k' })
  ok('explicit escrow → forwarded (still the legacy custodial path)', lastBody.payment_rail === 'escrow')

  // (The runtime forwarding tests above already prove the MCP hands off to /api/orders and lets the route gate.)
  // ── schema conformance (static): only live rails selectable; product listings add NO currency field ──
  ok('place_order payment_rail enum = [escrow, direct_p2p] only (onchain/psp NOT selectable)', /payment_rail:\s*\{\s*type:\s*'string',\s*enum:\s*\['escrow',\s*'direct_p2p'\]/.test(SRC))
  ok('place_order exposes direct_receive_account_id', /direct_receive_account_id:\s*\{\s*type:\s*'string'/.test(SRC))
  ok('list_product price wording aligned to PWA (not "Price in WAZ")', /Listing amount \(protocol unit/.test(SRC))
  ok('no invented parallel currency field on any product listing tool', !/settlement_currency|price_currency/.test(SRC))
} finally { server.close() }

if (fail > 0) { console.error(`\n❌ mcp-place-order-rail FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ MCP place_order rail conformance: only escrow/direct_p2p selectable (onchain/psp → PAYMENT_RAIL_DISABLED); payment_rail + direct_receive_account_id forwarded verbatim to the same /api/orders route (server gates, MCP doesn't); default = escrow compat; no product currency field / no "Price in WAZ"\n  ✅ pass ${pass}`)
