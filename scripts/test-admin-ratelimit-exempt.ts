#!/usr/bin/env tsx
/**
 * Root-admin create-rate-limit exemption (engine/store only; no API/MCP/PWA).
 *   用法:npm run test:admin-ratelimit-exempt
 *
 * Proves createBuildTask's per-user anti-spam cap (CREATE_RATE_PER_DAY = 10) is bypassed ONLY for
 * root admin accounts (users.role = 'admin' AND users.admin_type = 'root') and stays ENFORCED for
 * regional/non-root admins and everyone else — and that the bypass is fail-closed: a regional admin,
 * a member, an unknown creator, a missing users table, or a missing admin_type column all keep the
 * cap applied (no accidental global bypass / no test-behavior regression).
 */
import Database from 'better-sqlite3'
import { initBuildTasksSchema, createBuildTask } from '../src/layer2-business/L2-9-contribution/build-tasks-engine.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) pass++; else { fail++; fails.push(`✗ ${name}${detail ? `\n    ${detail}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
// users table WITH the admin_type column (mirrors prod after the boot migration)
function dbWithUsers(): any {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, admin_type TEXT, api_key TEXT)`)
  db.prepare(`INSERT INTO users (id,name,role,admin_type,api_key) VALUES ('usr_root','Root','admin','root','kr')`).run()
  db.prepare(`INSERT INTO users (id,name,role,admin_type,api_key) VALUES ('usr_regional','Regional','admin','regional','kg')`).run()
  db.prepare(`INSERT INTO users (id,name,role,admin_type,api_key) VALUES ('usr_member','Member','member',NULL,'km')`).run()
  initBuildTasksSchema(db)
  return db
}

// legacy users table WITHOUT the admin_type column → the lookup must fail closed
function dbWithoutAdminTypeColumn(): any {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, api_key TEXT)`)
  db.prepare(`INSERT INTO users (id,name,role,api_key) VALUES ('usr_root','Root','admin','kr')`).run()
  initBuildTasksSchema(db)
  return db
}

const isRateLimited = (r: any): boolean => !!r && 'error' in r && r.error_code === 'RATE_LIMITED'
const created = (r: any): boolean => !!r && !('error' in r)

// create N tasks for a creator; report how many succeeded and where the first RATE_LIMITED hit
function createN(db: any, creatorId: string, n: number): { okCount: number; firstLimitAt: number | null } {
  let okCount = 0, firstLimitAt: number | null = null
  for (let i = 0; i < n; i++) {
    const r: any = createBuildTask(db, { creatorId, title: `task ${creatorId} #${i}`, area: 'docs' })
    if (created(r)) okCount++
    else if (isRateLimited(r) && firstLimitAt === null) firstLimitAt = i
  }
  return { okCount, firstLimitAt }
}

const cappedAt10 = (label: string, db: any, creator: string) => {
  const r = createN(db, creator, 13)
  ok(`${label}: capped — 10 succeed then RATE_LIMITED`, r.okCount === 10 && r.firstLimitAt === 10, `okCount=${r.okCount} firstLimitAt=${r.firstLimitAt}`)
}

async function main() {
  // 1) ROOT admin (role=admin, admin_type=root) is exempt: well past the cap, every create succeeds
  {
    const db = dbWithUsers()
    const r = createN(db, 'usr_root', 25)
    ok('root admin: all 25 creates succeed (cap bypassed)', r.okCount === 25, `okCount=${r.okCount}`)
    ok('root admin: never RATE_LIMITED', r.firstLimitAt === null, `firstLimitAt=${r.firstLimitAt}`)
  }

  // 2) REGIONAL (non-root) admin (role=admin, admin_type=regional) → still capped
  cappedAt10('regional admin', dbWithUsers(), 'usr_regional')

  // 3) member (role=member) → still capped
  cappedAt10('member', dbWithUsers(), 'usr_member')

  // 4) unknown creator (no row) → fail-closed → capped
  cappedAt10('unknown creator', dbWithUsers(), 'usr_ghost')

  // 5) fail-closed — users table WITHOUT admin_type column → lookup throws → capped (even for role=admin)
  cappedAt10('missing admin_type column (role=admin)', dbWithoutAdminTypeColumn(), 'usr_root')

  // 6) fail-closed — no users table at all → lookup throws → capped
  {
    const db = new Database(':memory:')
    initBuildTasksSchema(db)
    cappedAt10('no users table', db, 'usr_root')
  }

  console.log('\ntest:admin-ratelimit-exempt')
  console.log('────────────────────────────────────')
  console.log(`  ✅ pass  ${pass}`)
  console.log(`  ❌ fail  ${fail}\n`)
  if (fails.length) { for (const f of fails) console.error(f); console.error(''); process.exit(1) }
  console.log('✅ ROOT admin (role=admin + admin_type=root) bypasses the create cap; regional/non-root admin + member + unknown creator + missing users table + missing admin_type column all stay capped (fail-closed)\n')
}

main()
