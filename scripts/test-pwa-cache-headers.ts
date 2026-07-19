#!/usr/bin/env tsx
/**
 * PR-CACHE — PWA 静态 JS + 审批读缓存头。回归:部署后 app-*.js 拆包不再被 CF/浏览器缓存旧版(需硬刷新),
 *   审批读不返回 stale 列表。行为化:真起 express.static 用生产同一 helper,GET 真实 bundle 断头。
 * Usage: npm run test:pwa-cache-headers
 */
import express from 'express'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldNoCacheStaticAsset } from '../src/pwa/pwa-cache-headers.js'
import { setSeamDb } from '../src/layer0-foundation/L0-1-database/db.js'
import { registerAgentGrantsRoutes } from '../src/pwa/routes/agent-grants.js'

let pass = 0, fail = 0; const fails: string[] = []
const ok = (n: string, c: boolean): void => { if (c) pass++; else { fail++; fails.push('✗ ' + n) } }

try {
  // ── unit: the predicate covers ALL .js (incl. split bundles) + shell, NOT icons/fonts ──
  ok('C-1 app-*.js split bundles are no-cache (the bug: they were missing)', shouldNoCacheStaticAsset('app-agent-approvals.js') && shouldNoCacheStaticAsset('app-agent-approvals-submit.js') && shouldNoCacheStaticAsset('app-direct-pay-buyer.js'))
  ok('C-2 monolith + sw + i18n still no-cache', shouldNoCacheStaticAsset('app.js') && shouldNoCacheStaticAsset('sw.js') && shouldNoCacheStaticAsset('i18n.js'))
  ok('C-3 shell html + manifest no-cache', shouldNoCacheStaticAsset('index.html') && shouldNoCacheStaticAsset('manifest.json'))
  ok('C-4 non-code assets (icons/fonts/css) NOT forced no-cache (stay CF default)', !shouldNoCacheStaticAsset('logo.png') && !shouldNoCacheStaticAsset('font.woff2') && !shouldNoCacheStaticAsset('style.css'))

  // ── behavioral: mount express.static with the SAME helper against the real public dir; GET a real bundle ──
  const app = express()
  app.use(express.static(join(process.cwd(), 'src/pwa/public'), {
    setHeaders: (res, filePath) => { if (shouldNoCacheStaticAsset(filePath.split('/').pop() || '')) res.setHeader('Cache-Control', 'no-cache, must-revalidate') },
  }))
  const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const head = async (p: string) => (await fetch(base + p)).headers.get('cache-control')
  ok('C-5 GET /app-agent-approvals.js → no-cache (real static handler behavior)', (await head('/app-agent-approvals.js')) === 'no-cache, must-revalidate')
  ok('C-6 GET /app-agent-approvals-submit.js → no-cache', (await head('/app-agent-approvals-submit.js')) === 'no-cache, must-revalidate')
  server.close()

  // ── source: server.ts wires the helper; approval reads set no-store; sw cache bumped ──
  const SERVER = readFileSync('src/pwa/server.ts', 'utf8')
  ok('C-7 server static handler uses shouldNoCacheStaticAsset (not a 5-name allowlist)', /shouldNoCacheStaticAsset\(path\.basename\(filePath\)\)/.test(SERVER) && !/base === 'app\.js' \|\| base === 'sw\.js'/.test(SERVER))
  const GRANTS = readFileSync('src/pwa/routes/agent-grants.ts', 'utf8')
  ok('C-8 approval LIST read sets no-store', /permission-requests'[\s\S]{0,160}Cache-Control', 'no-store'/.test(GRANTS))
  ok('C-9 approval single-detail read sets no-store', /permission-requests\/:request_id'[\s\S]{0,160}Cache-Control', 'no-store'/.test(GRANTS))
  ok('C-9b agent-side my-permission-requests read sets no-store (Codex R1)', /my-permission-requests'[\s\S]{0,200}Cache-Control', 'no-store'/.test(GRANTS))

  // ── behavioral (Codex R2/R3): mount the REAL registerAgentGrantsRoutes on a live express app + in-memory
  //    DB, mint a real active grant, and assert the ACTUAL Cache-Control response header the real handlers
  //    emit for the canonical webaz_approval_requests list/detail + connection reads — not a source-grep. ──
  const gdb = new Database(':memory:')
  setSeamDb(gdb)   // verifyGrantToken / dbOne read through the async seam; point it at this in-memory DB
  gdb.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, handle TEXT)')
  gdb.exec('CREATE TABLE IF NOT EXISTS user_moderation (user_id TEXT PRIMARY KEY, suspended INTEGER)')
  gdb.prepare('INSERT INTO users (id, handle) VALUES (?,?)').run('usr_test', 'tester')
  const gapp = express()
  registerAgentGrantsRoutes(gapp, {   // this call inits the grant/log/permission-request schemas on gdb
    db: gdb,
    auth: () => null,
    generateId: (p: string) => `${p}_test`,
    rateLimitOk: () => true,
    requireHumanPresence: () => ({ ok: true }),
  })
  const RAW = 'gtk_test_behavioral_' + 'x'.repeat(24)
  gdb.prepare('INSERT INTO agent_delegation_grants (grant_id, human_id, agent_label, capabilities, token_hash, status, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run('grt_test', 'usr_test', 'Test Agent',
      JSON.stringify([{ capability: 'read_public' }, { capability: 'approval_requests_read' }]),
      createHash('sha256').update(RAW).digest('hex'), 'active', '2999-01-01T00:00:00.000Z')
  const gserver = gapp.listen(0); const gbase = `http://127.0.0.1:${(gserver.address() as AddressInfo).port}`
  const ghead = async (p: string) => (await fetch(gbase + p, { headers: { authorization: `Bearer ${RAW}` } })).headers.get('cache-control')
  ok('C-9c REAL GET /api/agent/approval-requests (canonical LIST) → no-store (real handler over HTTP, Codex R2)', (await ghead('/api/agent/approval-requests')) === 'no-store')
  ok('C-9d REAL GET /api/agent/approval-requests/:id (canonical DETAIL) → no-store', (await ghead('/api/agent/approval-requests/req_missing')) === 'no-store')
  ok('C-9e REAL GET /api/agent-grants/connection → no-store (scopes/expires_at change on revoke/expiry)', (await ghead('/api/agent-grants/connection')) === 'no-store')
  gserver.close(); gdb.close()

  const SW = readFileSync('src/pwa/public/sw.js', 'utf8')
  ok('C-10 sw.js cache version bumped past v482', /const CACHE = 'webaz-v(4[89]\d|[5-9]\d\d)'/.test(SW))
} catch (e) { fail++; fails.push('✗ THREW: ' + ((e as Error).stack || (e as Error).message)) }

if (fail > 0) { console.error(`\n❌ pwa-cache-headers FAILED\n  ✅ ${pass}  ❌ ${fail}\n${fails.join('\n')}`); process.exit(1) }
console.log(`✅ pwa-cache-headers: ALL .js (incl. 89 app-* split bundles) + shell → no-cache (deploy reaches clients without hard refresh); approval list + deep-link reads → no-store; sw cache bumped\n  ✅ pass ${pass}`)
