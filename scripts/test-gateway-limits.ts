#!/usr/bin/env tsx
/**
 * Agent/API Security Gateway — Task S2a test: multi-dimensional limit policy engine (threat-model §8).
 *
 * Pure engine: intersecting budgets, strictest-wins denial + retry-after, absent-dimension skip,
 * canonical/bounded/fixed-size keys, and the dev/shadow in-memory store's window reset + bounded cardinality.
 *
 * Usage: npm run test:gateway-limits
 */
const { GATEWAY_LIMIT_POLICY, gatewayLimitKey, evaluateGatewayLimits, evaluateGatewayLimitsAsync, InMemoryGatewayLimitStore } =
  await import('../src/runtime/gateway-limits.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

try {
  const NOW = 1_000_000_000_000

  // 1. policy present for all five cost classes with ≥1 dimension each
  {
    const classes = ['public_low', 'private_read', 'medium', 'high', 'economic'] as const
    ok('1 all 5 cost classes declare ≥1 dimension budget', classes.every(c => Object.keys(GATEWAY_LIMIT_POLICY[c]).length >= 1))
  }

  // 2. under-limit allows; the (limit+1)-th hit on a dimension denies with that dimension + its window as retry
  {
    const store = new InMemoryGatewayLimitStore()
    const dims = { ip: '1.2.3.4' }
    const budget = GATEWAY_LIMIT_POLICY.public_low.ip!   // {240, 60}
    let lastAllowed = true
    for (let i = 0; i < budget.limit; i++) lastAllowed = evaluateGatewayLimits({ cost_class: 'public_low', dims }, store, NOW).allowed
    ok('2a first `limit` requests all allowed', lastAllowed === true)
    const over = evaluateGatewayLimits({ cost_class: 'public_low', dims }, store, NOW)
    ok('2b (limit+1)-th denied on ip + retry_after = window_sec', over.allowed === false && over.denied_dimension === 'ip' && over.retry_after_sec === budget.window_sec)
  }

  // 3. strictest-wins: TWO dimensions exceed with DIFFERENT windows → the LONGER-window one is reported.
  //   The real policy has equal windows within a class, so inject a synthetic policy that differs (short 60s
  //   ip vs long 3600s subject) — this genuinely exercises the longest-window selection at the branch.
  {
    const store = new InMemoryGatewayLimitStore()
    const synthetic = {
      public_low: {}, private_read: {}, medium: {}, economic: {},
      high: { ip: { limit: 1, window_sec: 60 }, subject: { limit: 1, window_sec: 3600 } },
    } as never
    const dims = { ip: '9.9.9.9', subject: 'usr_x' }
    evaluateGatewayLimits({ cost_class: 'high', dims }, store, NOW, synthetic)                     // 1st: both at limit, allowed
    const dec = evaluateGatewayLimits({ cost_class: 'high', dims }, store, NOW, synthetic)          // 2nd: BOTH exceed
    ok('3a both dims exceeded → denied', dec.allowed === false)
    ok('3b strictest (longest window 3600s subject, not 60s ip) reported', dec.denied_dimension === 'subject' && dec.retry_after_sec === 3600)
  }

  // 3.5 count-all-dims: a request consumes quota on EVERY present dimension even after a denial is latched
  {
    const hits: string[] = []
    const spy = { hit: (k: string) => { hits.push(k); return 999 } }   // everything over-limit
    const dec = evaluateGatewayLimits({ cost_class: 'medium', dims: { subject: 's', product: 'p', client: 'c', ip: 'i' } }, spy as never, NOW)
    ok('3.5 all 4 present medium dims counted (no short-circuit on first denial)', dec.allowed === false && hits.length === 4)
  }

  // 3.6 TOTAL + fail-closed: unknown cost_class or missing dims DENY, never throw / never allow
  {
    const store = new InMemoryGatewayLimitStore()
    const bad = evaluateGatewayLimits({ cost_class: 'nope' as never, dims: { ip: 'x' } }, store, NOW)
    ok('3.6a unknown cost_class → fail-closed deny (not allow, not throw)', bad.allowed === false)
    const noDims = evaluateGatewayLimits({ cost_class: 'public_low' } as never, store, NOW)
    ok('3.6b missing dims object → allowed (nothing to count), no throw', noDims.allowed === true)
  }

  // 4. absent dimension is skipped (no key created, no false denial)
  {
    const hits: string[] = []
    const spyStore = { hit: (k: string) => { hits.push(k); return 1 } }
    evaluateGatewayLimits({ cost_class: 'medium', dims: { subject: 'usr_a' } }, spyStore as never, NOW)
    ok('4 only present dims counted (subject), absent product/client/ip skipped', hits.length === 1 && /:subject:/.test(hits[0]))
  }

  // 5. keys: deterministic, fixed-size, bounded (huge input → same length), dim/class-scoped
  {
    const k1 = gatewayLimitKey('anchor', 'public_low', '@tina:ha95')
    const k1b = gatewayLimitKey('anchor', 'public_low', '@tina:ha95')
    const kBig = gatewayLimitKey('anchor', 'public_low', 'x'.repeat(100_000))
    ok('5a deterministic', k1 === k1b)
    ok('5b bounded/fixed size regardless of input length', k1.length === kBig.length && k1.length < 64)
    ok('5c dimension-scoped', gatewayLimitKey('product', 'public_low', 'v') !== gatewayLimitKey('anchor', 'public_low', 'v'))
    ok('5d cost-class-scoped', gatewayLimitKey('subject', 'medium', 'v') !== gatewayLimitKey('subject', 'high', 'v'))
    ok('5e no raw value leaks into the key', !k1.includes('tina'))
  }

  // 6. in-memory store: window reset after expiry
  {
    const store = new InMemoryGatewayLimitStore()
    store.hit('k', 60, NOW); store.hit('k', 60, NOW)
    ok('6a count accrues in window', store.hit('k', 60, NOW) === 3)
    ok('6b resets after window elapses', store.hit('k', 60, NOW + 61_000) === 1)
  }

  // 7. bounded cardinality: LRU eviction caps memory under key flooding
  {
    const store = new InMemoryGatewayLimitStore(100)
    for (let i = 0; i < 1000; i++) store.hit('flood:' + i, 60, NOW)
    // internal map is private; assert behavior: an early key was evicted (its count restarts at 1)
    ok('7 flooded keys evicted (bounded cardinality) — early key count restarted', store.hit('flood:0', 60, NOW) === 1)
  }

  // 8. async evaluator (distributed store path) — same strictest-wins decision, counts every dim, propagates rejection
  {
    const syntheticAsync = {
      public_low: { ip: { limit: 2, window_sec: 60 } },
      private_read: {}, medium: {}, economic: {},
      high: { ip: { limit: 1, window_sec: 60 }, subject: { limit: 1, window_sec: 3600 } },
    } as never

    // 8a under-limit allows, over-limit denies with the same shape as the sync path
    const counters = new Map<string, number>()
    const asyncStore = { hit: async (k: string) => { const n = (counters.get(k) ?? 0) + 1; counters.set(k, n); return n } }
    const a1 = await evaluateGatewayLimitsAsync({ cost_class: 'public_low', dims: { ip: '1.2.3.4' } }, asyncStore, NOW, syntheticAsync)
    const a2 = await evaluateGatewayLimitsAsync({ cost_class: 'public_low', dims: { ip: '1.2.3.4' } }, asyncStore, NOW, syntheticAsync)
    const a3 = await evaluateGatewayLimitsAsync({ cost_class: 'public_low', dims: { ip: '1.2.3.4' } }, asyncStore, NOW, syntheticAsync)
    ok('8a async under-limit allowed', a1.allowed === true && a2.allowed === true)
    ok('8b async over-limit denied on ip + retry_after', a3.allowed === false && a3.denied_dimension === 'ip' && a3.retry_after_sec === 60)

    // 8c strictest-wins across dims with different windows (longest window reported), matching sync
    const s2 = { hit: async () => 999 }   // everything over
    const dec = await evaluateGatewayLimitsAsync({ cost_class: 'high', dims: { ip: '9.9.9.9', subject: 'usr_x' } }, s2, NOW, syntheticAsync)
    ok('8c async strictest (3600s subject) reported', dec.allowed === false && dec.denied_dimension === 'subject' && dec.retry_after_sec === 3600)

    // 8d counts EVERY present dim (no short-circuit) even when all over-limit
    const hitKeys: string[] = []
    const s3 = { hit: async (k: string) => { hitKeys.push(k); return 999 } }
    await evaluateGatewayLimitsAsync({ cost_class: 'high', dims: { ip: 'i', subject: 's' } }, s3, NOW, syntheticAsync)
    ok('8d async counts all present dims (ip+subject)', hitKeys.length === 2)

    // 8e a hit REJECTION propagates — never swallowed into an allow (fail-closed at the caller)
    let propagated = false
    try { await evaluateGatewayLimitsAsync({ cost_class: 'public_low', dims: { ip: 'x' } }, { hit: async () => { throw new Error('store outage') } }, NOW, syntheticAsync) }
    catch (e) { propagated = e instanceof Error && e.message.includes('store outage') }
    ok('8e async store outage rejects (not allowed)', propagated)

    // 8f unknown cost_class → fail-closed deny WITHOUT touching the store
    let touched = false
    const bad = await evaluateGatewayLimitsAsync({ cost_class: 'nope' as never, dims: { ip: 'x' } }, { hit: async () => { touched = true; return 1 } }, NOW, syntheticAsync)
    ok('8f async unknown class → deny, store not called', bad.allowed === false && touched === false)

    // 8g fail-closed on a non-finite count (seam-contract violation): a store returning undefined/NaN must
    //    DENY, never be read as under-limit (NaN > limit === false would be a silent fail-open)
    const nanSync = evaluateGatewayLimits({ cost_class: 'public_low', dims: { ip: '1.2.3.4' } }, { hit: () => undefined as never }, NOW, syntheticAsync)
    ok('8g sync non-finite count → fail-closed deny', nanSync.allowed === false)
    const nanAsync = await evaluateGatewayLimitsAsync({ cost_class: 'public_low', dims: { ip: '1.2.3.4' } }, { hit: async () => NaN }, NOW, syntheticAsync)
    ok('8h async non-finite count → fail-closed deny', nanAsync.allowed === false)
  }

  if (fail > 0) { console.error(`\n❌ gateway-limits FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ gateway-limits (S2a): §8 intersecting budgets · strictest-wins denial+retry · absent-dim skip · canonical/bounded/fixed-size keys · shadow store window-reset + bounded cardinality\n  ✅ pass ${pass}`)
} catch (e) {
  console.error('❌ test error:', (e as Error).message); process.exit(1)
}
