#!/usr/bin/env tsx
/**
 * Follow-up C Slice 2a — reputation/decay must write an admin_audit_log row.
 *   用法:npm run test:admin-reputation-decay-audit
 *
 * reputation/decay 是管理员触发的全局声誉变更,此前无任何留痕(applyDecayIfDue 不接收 admin id)。
 * 本切片:记触发的 admin + force 入参 + 结果。additive,不改声誉逻辑、不改 schema、gate 不变。
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { registerAdminOpsRoutes } from '../src/pwa/routes/admin-ops.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
const audit: Array<{ adminId: string; action: string; targetType: string | null; detail: any }> = []
const logAdminAction = (adminId: string, action: string, targetType: string | null, _ti: string | null, detail?: any) => { audit.push({ adminId, action, targetType, detail }) }
let authUser: any = { id: 'usr_admin', role: 'admin' }
const noop = () => {}

let server: Server, port = 0
const post = (path: string, body?: any): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const p = body ? JSON.stringify(body) : ''
  const r = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(p) } }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); if (p) r.write(p); r.end()
})

async function main(): Promise<void> {
  const app = express(); app.use(express.json())
  registerAdminOpsRoutes(app, {
    db,
    auth: (() => authUser) as any,
    requireUsersAdmin: (() => authUser) as any,
    hasAdminPermission: (() => true) as any,
    INTERNAL_AUDITOR_ID: 'usr_iaudit', ADMIN_EXPORT_LIMIT: 5000, csvEscapeAdmin: ((v: unknown) => String(v)) as any,
    anthropic: null,
    applyDecayIfDue: ((_db: any, opts: any) => ({ applied: true, affected: 5, rate: 0.1, force: !!opts?.force })) as any,
    computeValueBadges: (() => ({ categories: 0, total_products: 0, badged: 0, skipped_small: 0 })) as any,
    logAdminAction: logAdminAction as any,
  })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))

  // 1) admin + force → audit row (admin id + action + force + result)
  audit.length = 0; authUser = { id: 'usr_admin', role: 'admin' }
  { const r = await post('/api/admin/reputation/decay', { force: true })
    ok('decay returns result', r.json?.applied === true && r.json?.affected === 5, JSON.stringify(r.json))
    const a = audit.find(x => x.action === 'reputation_decay')
    ok('decay writes audit (admin id + force + result)', !!a && a.adminId === 'usr_admin' && a.targetType === 'protocol' && a.detail?.force === true && a.detail?.applied === true && a.detail?.affected === 5, JSON.stringify(a)) }

  // 2) non-admin → 403, NO audit
  audit.length = 0; authUser = { id: 'usr_buyer', role: 'buyer' }
  { const r = await post('/api/admin/reputation/decay', { force: true })
    ok('non-admin → 403', r.status === 403, JSON.stringify(r.json))
    ok('non-admin → no audit row', audit.find(x => x.action === 'reputation_decay') === undefined, JSON.stringify(audit)) }

  server.close()

  if (fail === 0) {
    console.log(`\n✅ reputation/decay audit: 管理员触发 → 记 admin id + force + 结果(admin_audit_log);非 admin 403 不留痕;additive,gate 不变\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ reputation/decay audit FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
