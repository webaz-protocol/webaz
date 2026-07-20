#!/usr/bin/env tsx
/**
 * Ops Passkey-in-flow — Task 3 test: approval-window domain(mint / consume-CAS / revoke).
 *
 * Real fresh DB (in-memory) + real schema. Proves: mint creates a bounded window; bad/T3 tier rejected;
 * max_uses/ttl clamped (no throw on out-of-range); consume CAS decrements remaining and refuses over-consume,
 * expired, revoked, cross-tier, and nonexistent windows; mint keeps at most ONE active window per (owner,tier);
 * revoke is idempotent; a real db failure is sanitized (no raw SQL leaks); and this module does NOT import the
 * executor (I1 zero-exec — a window only AUTHORIZES; it never acts).
 *
 * Usage: npm run test:approval-window
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const Database = (await import('better-sqlite3')).default
const { initProductActionApprovalSchema } = await import('../src/runtime/webaz-schema-helpers.js')
const { mintWindow, consumeWindow, revokeWindow } = await import('../src/pwa/approval-window.js')

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

const db = new Database(':memory:')
initProductActionApprovalSchema(db)
let seq = 0
const generateId = (p: string) => `${p}_${++seq}`
const alice = 'usr_alice', bob = 'usr_bob'
const activeCount = (owner: string, tier: string) =>
  (db.prepare("SELECT COUNT(*) AS c FROM action_approval_windows WHERE owner_id=? AND tier=? AND revoked_at IS NULL AND expires_at > ?")
    .get(owner, tier, new Date().toISOString()) as { c: number }).c

try {
  // 1. mint T1 → bounded window row
  {
    const r = mintWindow(db, { ownerId: alice, tier: 'T1', generateId })
    ok('1a mint T1 → ok + window_id aw_ + max_uses 20', r.ok === true && String(r.window_id).startsWith('aw_') && r.max_uses === 20)
    const row = db.prepare('SELECT uses, max_uses, revoked_at, expires_at FROM action_approval_windows WHERE id=?').get(r.window_id) as { uses: number; max_uses: number; revoked_at: string | null; expires_at: string }
    ok('1b row uses=0 max=20 not revoked, expires in future', row.uses === 0 && row.max_uses === 20 && row.revoked_at === null && row.expires_at > new Date().toISOString())
  }
  // 2. bad tier + T3 rejected at mint (never opens a window)
  ok('2a mint bad tier → BAD_TIER 400', (() => { const r = mintWindow(db, { ownerId: alice, tier: 'T9', generateId }); return r.ok === false && r.error_code === 'BAD_TIER' && r.http === 400 })())
  ok('2b mint T3 → BAD_TIER (T3 order/funds never opens a window)', (() => { const r = mintWindow(db, { ownerId: alice, tier: 'T3', generateId }); return r.ok === false && r.error_code === 'BAD_TIER' })())

  // 3. clamp: out-of-range max_uses does NOT throw the schema CHECK — clamped to [1,20]
  {
    const hi = mintWindow(db, { ownerId: bob, tier: 'T1', generateId, maxUses: 999 })
    ok('3a maxUses 999 → clamped to 20 (no throw)', hi.ok === true && hi.max_uses === 20)
    const lo = mintWindow(db, { ownerId: bob, tier: 'T2', generateId, maxUses: 0 })
    ok('3b maxUses 0 → clamped to 1', lo.ok === true && lo.max_uses === 1)
  }

  // 4. consume decrements remaining
  {
    const m = mintWindow(db, { ownerId: alice, tier: 'T2', generateId, maxUses: 3 })
    const c1 = consumeWindow(db, { ownerId: alice, tier: 'T2' })
    ok('4a first consume → ok, remaining 2', c1.ok === true && c1.remaining === 2 && c1.window_id === m.window_id)
    const c2 = consumeWindow(db, { ownerId: alice, tier: 'T2' })
    ok('4b second consume → ok, remaining 1', c2.ok === true && c2.remaining === 1)
  }

  // 5. CAS refuses over-consume: exactly max_uses successes, no more (this is the core budget guarantee)
  {
    const m = mintWindow(db, { ownerId: alice, tier: 'T1', generateId, maxUses: 3 })   // also revokes alice's T1 from test 1
    ok('5a mint replaces prior T1 (at most one active)', activeCount(alice, 'T1') === 1)
    let good = 0, denied = 0
    for (let i = 0; i < 5; i++) { const r = consumeWindow(db, { ownerId: alice, tier: 'T1' }); if (r.ok) good++; else { ok('5 denial carries NO_ACTIVE_WINDOW', r.error_code === 'NO_ACTIVE_WINDOW'); denied++ } }
    ok('5b exactly 3 consumed, 2 denied (no over-consume beyond max_uses)', good === 3 && denied === 2)
    ok('5c row uses capped at max_uses (never exceeded)', (db.prepare('SELECT uses, max_uses FROM action_approval_windows WHERE id=?').get(m.window_id) as { uses: number; max_uses: number }).uses === 3)
  }

  // 6. nonexistent / cross-tier / cross-owner isolation
  ok('6a consume where no window → NO_ACTIVE_WINDOW', consumeWindow(db, { ownerId: 'usr_ghost', tier: 'T1' }).error_code === 'NO_ACTIVE_WINDOW')
  {
    mintWindow(db, { ownerId: 'usr_carol', tier: 'T1', generateId })   // carol has ONLY T1
    ok('6b T1 window does NOT satisfy a T2 consume (tier-scoped)', consumeWindow(db, { ownerId: 'usr_carol', tier: 'T2' }).ok === false)
    ok('6c another owner cannot consume carol\'s window', consumeWindow(db, { ownerId: 'usr_dave', tier: 'T1' }).ok === false)
  }
  ok('6d consume with bad tier → NO_ACTIVE_WINDOW (no window can match)', consumeWindow(db, { ownerId: alice, tier: 'T7' }).error_code === 'NO_ACTIVE_WINDOW')

  // 7. expired window is not consumable (insert directly with a past expires_at — no time travel needed)
  {
    db.prepare("INSERT INTO action_approval_windows (id, owner_id, tier, uses, max_uses, expires_at) VALUES ('aw_expired','usr_erin','T1',0,20,?)")
      .run(new Date(Date.now() - 60_000).toISOString())
    ok('7 expired window → NO_ACTIVE_WINDOW (TTL enforced in CAS WHERE)', consumeWindow(db, { ownerId: 'usr_erin', tier: 'T1' }).error_code === 'NO_ACTIVE_WINDOW')
  }

  // 8. revoke kills the window; consume then fails; revoke is idempotent
  {
    mintWindow(db, { ownerId: 'usr_frank', tier: 'T2', generateId, maxUses: 10 })
    const rv = revokeWindow(db, { ownerId: 'usr_frank', tier: 'T2' })
    ok('8a revoke → ok, revoked 1', rv.ok === true && rv.revoked === 1)
    ok('8b consume after revoke → NO_ACTIVE_WINDOW', consumeWindow(db, { ownerId: 'usr_frank', tier: 'T2' }).ok === false)
    ok('8c revoke again → idempotent 0', revokeWindow(db, { ownerId: 'usr_frank', tier: 'T2' }).revoked === 0)
  }

  // 9. at-most-one-active across repeated mints (prior active windows are revoked, not accumulated)
  {
    const g = 'usr_grace'
    mintWindow(db, { ownerId: g, tier: 'T1', generateId })
    mintWindow(db, { ownerId: g, tier: 'T1', generateId })
    const m3 = mintWindow(db, { ownerId: g, tier: 'T1', generateId })
    ok('9a three mints → exactly one active window', activeCount(g, 'T1') === 1)
    ok('9b consume lands on the newest window', consumeWindow(db, { ownerId: g, tier: 'T1' }).window_id === m3.window_id)
  }

  // 10. real db failure → sanitized, no raw SQL/table text escapes (Codex-style: exercise an ACTUAL failure)
  {
    const bare = new Database(':memory:')   // action_approval_windows deliberately absent → every op throws
    const rm = mintWindow(bare, { ownerId: 'u', tier: 'T1', generateId })
    ok('10a mint on missing table → WINDOW_OP_FAILED (no throw escapes)', rm.ok === false && rm.error_code === 'WINDOW_OP_FAILED')
    ok('10b mint error sanitized (no SQL/table/constraint text)', !/SQLITE|no such table|action_approval_windows|constraint/i.test(String(rm.error)))
    const rc = consumeWindow(bare, { ownerId: 'u', tier: 'T1' })
    ok('10c consume on missing table → WINDOW_OP_FAILED (not silent NO_ACTIVE_WINDOW)', rc.ok === false && rc.error_code === 'WINDOW_OP_FAILED')
    bare.close()
  }

  // 11. NEGATIVE import guard (I1): a window AUTHORIZES; it must never reach the executor
  {
    const src = readFileSync(join(process.cwd(), 'src/pwa/approval-window.ts'), 'utf8')
    const imports = src.split('\n').filter(l => /^\s*import\b/.test(l)).join('\n')
    ok('11 approval-window does NOT import product-action-exec (I1 zero-exec)', !/product-action-exec/.test(imports))
  }

  if (fail > 0) { console.error(`\n❌ approval-window FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
  console.log(`✅ approval-window (Task 3): mint(bounded·clamp·T3-excluded) · consume-CAS(no over-consume·expiry·revoke·tier/owner-scoped) · revoke(idempotent) · at-most-one-active · sanitized failure · zero-exec\n  ✅ pass ${pass}`)
} finally {
  db.close()
}
