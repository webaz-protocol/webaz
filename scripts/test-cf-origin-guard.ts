#!/usr/bin/env tsx
/**
 * Guard for the Cloudflare-only origin guard (src/pwa/cf-origin-guard.ts). 用法:npm run test:cf-origin-guard
 *
 * Safety-critical invariants (a wrong enforce = full site lockout):
 *  - default OFF (no env) → always allows, even without the header.
 *  - observe → logs but ALLOWS (never blocks during rollout).
 *  - enforce → 403 without/with wrong secret; allows with the correct secret.
 *  - enforce WITHOUT a configured secret → fails OPEN (never a lockout).
 *  - exempt paths (health) → always allowed, even enforce + no header.
 *  - secret compare is length-safe (no crash on mismatched lengths).
 */
import { createCfOriginGuard, CF_ORIGIN_HEADER } from '../src/pwa/cf-origin-guard.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
// minimal req/res/next doubles
function run(env: Record<string, string>, headers: Record<string, string>, path = '/api/products') {
  const req: any = { path, method: 'GET', ip: '1.2.3.4', get: (h: string) => headers[h.toLowerCase()] }
  let status = 0, body: any = null, nexted = false
  const res: any = { status: (s: number) => { status = s; return res }, json: (b: any) => { body = b; return res } }
  const next = () => { nexted = true }
  createCfOriginGuard(env as any)(req, res, next)
  return { nexted, status, body }
}
const SECRET = 'a'.repeat(64)

// default OFF
ok('off (no env): allows without header', run({}, {}).nexted === true)

// observe: logs but allows
{ const r = run({ CF_ORIGIN_GUARD_MODE: 'observe', CF_ORIGIN_SHARED_SECRET: SECRET }, {})
  ok('observe: no header → ALLOWED (not blocked)', r.nexted === true && r.status === 0) }

// enforce
{ const r = run({ CF_ORIGIN_GUARD_MODE: 'enforce', CF_ORIGIN_SHARED_SECRET: SECRET }, {})
  ok('enforce: no header → 403 blocked', r.nexted === false && r.status === 403 && r.body?.error_code === 'CF_ORIGIN_ONLY') }
{ const r = run({ CF_ORIGIN_GUARD_MODE: 'enforce', CF_ORIGIN_SHARED_SECRET: SECRET }, { [CF_ORIGIN_HEADER]: 'wrong' })
  ok('enforce: wrong secret → 403 blocked', r.nexted === false && r.status === 403) }
{ const r = run({ CF_ORIGIN_GUARD_MODE: 'enforce', CF_ORIGIN_SHARED_SECRET: SECRET }, { [CF_ORIGIN_HEADER]: SECRET })
  ok('enforce: correct secret (via Cloudflare) → allowed', r.nexted === true && r.status === 0) }

// fail-open: enforce but no secret configured
{ const r = run({ CF_ORIGIN_GUARD_MODE: 'enforce' }, {})
  ok('enforce + empty secret → fails OPEN (no lockout)', r.nexted === true && r.status === 0) }

// exempt health path
{ const r = run({ CF_ORIGIN_GUARD_MODE: 'enforce', CF_ORIGIN_SHARED_SECRET: SECRET }, {}, '/api/health')
  ok('enforce: exempt health path → allowed without header', r.nexted === true && r.status === 0) }

// length-mismatch secret must not throw
{ let threw = false; try { run({ CF_ORIGIN_GUARD_MODE: 'enforce', CF_ORIGIN_SHARED_SECRET: SECRET }, { [CF_ORIGIN_HEADER]: 'short' }) } catch { threw = true }
  ok('mismatched-length secret compare does not throw', threw === false) }

if (fail === 0) {
  console.log(`\n✅ cf-origin-guard: off=no-op; observe=log-only allow; enforce blocks (403 CF_ORIGIN_ONLY) without/with-wrong secret + allows with correct; enforce-without-secret fails OPEN; health exempt; length-safe compare\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
} else {
  console.error(`\n❌ cf-origin-guard FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
  process.exit(1)
}
