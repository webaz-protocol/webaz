#!/usr/bin/env tsx
/**
 * Admin create-rate-limit exemption (engine/store only; no API/MCP/PWA).
 *   用法:npm run test:admin-ratelimit-exempt
 *
 * Proves createBuildTask's per-user anti-spam cap (CREATE_RATE_PER_DAY = 10) is bypassed for admin
 * accounts (users.role = 'admin') while remaining ENFORCED for everyone else — and that the bypass is
 * fail-closed: an unknown creator, or a missing users table, keeps the cap applied (no accidental
 * global bypass / no test-behavior regression).
 */
import Database from 'better-sqlite3'
import { initBuildTasksSchema, createBuildTask } from '../src/layer2-business/L2-9-contribution/build-tasks-engine.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
function dbWithUsers(): any {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, api_key TEXT)`)
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_admin','Admin','admin','ka')`).run()
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_member','Member','member','km')`).run()
  initBuildTasksSchema(db)
  return db
}

const isRateLimited = (r: any): boolean => !!r && 'error' in r && r.error_code === 'RATE_LIMITED'
const created = (r: any): boolean => !!r && !('error' in r)

// helper: create N tasks for a creator, return how many succeeded before the first RATE_LIMITED
function createN(db: any, creatorId: string, n: number): { okCount: number; firstLimitAt: number | null } {
  let okCount = 0, firstLimitAt: number | null = null
  for (let i = 0; i < n; i++) {
    const r: any = createBuildTask(db, { creatorId, title: `task ${creatorId} #${i}`, area: 'docs' })
    if (created(r)) okCount++
    else if (isRateLimited(r) && firstLimitAt === null) firstLimitAt = i
  }
  return { okCount, firstLimitAt }
}

async function main() {
  // 1) non-admin (role='member') hits the cap: 10 succeed, the 11th is RATE_LIMITED
  {
    const db = dbWithUsers()
    const r = createN(db, 'usr_member', 13)
    ok('member: first 10 creates succeed', r.okCount === 10, `okCount=${r.okCount}`)
    ok('member: 11th create is RATE_LIMITED', r.firstLimitAt === 10, `firstLimitAt=${r.firstLimitAt}`)
  }

  // 2) admin (role='admin') is exempt: well past the cap, every create succeeds, never RATE_LIMITED
  {
    const db = dbWithUsers()
    const r = createN(db, 'usr_admin', 25)
    ok('admin: all 25 creates succeed (cap bypassed)', r.okCount === 25, `okCount=${r.okCount}`)
    ok('admin: never RATE_LIMITED', r.firstLimitAt === null, `firstLimitAt=${r.firstLimitAt}`)
  }

  // 3) fail-closed — creator not present in users table → treated as non-admin → cap still applies
  {
    const db = dbWithUsers()
    const r = createN(db, 'usr_ghost', 13)
    ok('unknown creator: cap still enforced (10 then RATE_LIMITED)', r.okCount === 10 && r.firstLimitAt === 10, `okCount=${r.okCount} firstLimitAt=${r.firstLimitAt}`)
  }

  // 4) fail-closed — no users table at all (lookup throws) → cap still applies (no global bypass)
  {
    const db = new Database(':memory:')
    initBuildTasksSchema(db)
    const r = createN(db, 'usr_admin', 13)
    ok('no users table: lookup fails safe → cap still enforced', r.okCount === 10 && r.firstLimitAt === 10, `okCount=${r.okCount} firstLimitAt=${r.firstLimitAt}`)
  }

  console.log('\ntest:admin-ratelimit-exempt')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ admin (role=admin) bypasses the create rate cap; non-admin + unknown creator + missing users table all stay capped (fail-closed)\n')
}

main()
