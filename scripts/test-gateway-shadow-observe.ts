#!/usr/bin/env tsx
/**
 * RFC-028 S2b-2b: shadow-mode observation helper. Proves the live-path contract — flag-gated no-op,
 * fire-and-forget (store hits fire but the request is never blocked), would-deny logging, and it NEVER
 * throws regardless of body shape or store outage.
 *
 * Usage: npm run test:gateway-shadow-observe
 */
const { observeGatewayLimitsShadow } = await import('../src/pwa/routes/mcp-remote.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 10))
const mkStore = (ret: number): { hits: string[]; store: { hit: (k: string) => Promise<number> } } => {
  const hits: string[] = []
  return { hits, store: { hit: async (k: string) => { hits.push(k); return ret } } }
}

const warns: string[] = []
const origWarn = console.warn
console.warn = (...a: unknown[]): void => { warns.push(a.map(String).join(' ')) }

try {
  // 1. flag off → pure no-op (store never touched)
  delete process.env.WEBAZ_AGENT_GATEWAY_LIMITS_MODE
  const s1 = mkStore(1)
  observeGatewayLimitsShadow(s1.store, { method: 'tools/list' }, '1.2.3.4')
  await flush()
  ok('1 flag off → store not called (no-op)', s1.hits.length === 0)

  process.env.WEBAZ_AGENT_GATEWAY_LIMITS_MODE = 'shadow'

  // 2. undefined store → no-op, no throw
  let threw = false
  try { observeGatewayLimitsShadow(undefined, { method: 'tools/list' }, '1.2.3.4') } catch { threw = true }
  ok('2 undefined store → no throw', threw === false)

  // 3. shadow + store → hits fire synchronously for present dims (public_low: ip + global)
  const s3 = mkStore(1)
  observeGatewayLimitsShadow(s3.store, { method: 'tools/list' }, '1.2.3.4')
  ok('3 shadow: store.hit fired for ip + global', s3.hits.length === 2)

  // 4. would-deny logged when over-limit; silent when allowed
  warns.length = 0
  observeGatewayLimitsShadow(mkStore(10_000_000).store, { method: 'tools/call', params: { name: 'webaz_place_order' } }, '1.2.3.4')
  await flush()
  ok('4a over-limit → would-deny logged (no raw ip in message)', warns.some(w => w.includes('would-deny') && w.includes('economic') && !w.includes('1.2.3.4')))
  warns.length = 0
  observeGatewayLimitsShadow(mkStore(1).store, { method: 'tools/list' }, '1.2.3.4')
  await flush()
  ok('4b under-limit → nothing logged', warns.length === 0)

  // 5. any body shape → never throws (extraction is fully guarded)
  for (const bad of [null, undefined, 42, 'x', { method: 123 }, { method: 'tools/call' }, { method: 'tools/call', params: { name: 42 } }]) {
    let t = false
    try { observeGatewayLimitsShadow(mkStore(1).store, bad, 'garbage-ip') } catch { t = true }
    ok('5 garbage body no throw: ' + JSON.stringify(bad), t === false)
  }
  await flush()

  // 6. store outage is swallowed — fire-and-forget never surfaces the rejection
  let t6 = false
  try { observeGatewayLimitsShadow({ hit: async () => { throw new Error('pg down') } }, { method: 'tools/list' }, '1.2.3.4'); await flush() } catch { t6 = true }
  ok('6 store outage swallowed (no unhandled throw)', t6 === false)

  console.warn = origWarn
  if (fail) { console.error(`\n❌ gateway-shadow-observe FAILED\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ gateway-shadow-observe (S2b-2b): flag-gated no-op · fire-and-forget · would-deny logging · never throws\n  ✅ pass ${pass}`)
} catch (e) {
  console.warn = origWarn
  console.error('❌ test error:', (e as Error).message); process.exit(1)
}
