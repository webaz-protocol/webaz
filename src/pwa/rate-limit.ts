/**
 * Minimal in-memory sliding-window rate limiter for anonymous/public endpoints (no api_key to key on).
 * `createSlidingWindowLimiter(limit, windowMs)` returns `(key) => boolean`: records the call and returns
 * true while the key has ≤ limit hits in the trailing window, false once it exceeds. Per-process (fine for
 * the current single-host deployment); a multi-replica deployment would back it with a store.
 */
export function createSlidingWindowLimiter(limit: number, windowMs: number): (key: string) => boolean {
  const hits = new Map<string, number[]>()
  return (key: string): boolean => {
    const now = Date.now()
    const recent = (hits.get(key) ?? []).filter(t => now - t < windowMs)
    recent.push(now)
    hits.set(key, recent)
    // opportunistic prune so the map doesn't grow unbounded across many distinct keys
    if (hits.size > 10_000) for (const [k, v] of hits) { if (v.every(t => now - t >= windowMs)) hits.delete(k) }
    return recent.length <= limit
  }
}
