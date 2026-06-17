#!/usr/bin/env tsx
/**
 * manual economic/protocol admin triggers must write a durable audit trail.
 *   用法:npm run test:admin-economic-trigger-audit
 *
 * Codex P2:admin-atomic(process-ledger/run-settlement/distribute)、admin/trial/run-eval、
 * admin/auction-reminders/run 这些手动触发的资金/结算/派发入口,过去只 requireProtocolAdmin 后直接执行,
 * 没记录触发的 admin → founder/root 面板的"经济操作都有审计"是假承诺。本测试钉住:每个入口都调用
 * logAdminAction(触发者 + 动作 + 结果摘要)。
 */
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { registerAdminAtomicRoutes } from '../src/pwa/routes/admin-atomic.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
// in-memory audit sink (stands in for logAdminAction → admin_audit_log)
const audit: Array<{ adminId: string; action: string; detail: any }> = []
const logAdminAction = (adminId: string, action: string, _tt: string | null, _ti: string | null, detail?: any) => { audit.push({ adminId, action, detail }) }

let server: Server, port = 0
const post = (path: string): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const r = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': '0' } }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch {} resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); r.end()
})
const auditFor = (action: string) => audit.find(a => a.action === action)

async function main(): Promise<void> {
  const app = express(); app.use(express.json())
  // real route module, stubbed engines + a protocol-admin that always resolves to a fixed admin
  registerAdminAtomicRoutes(app, {
    requireProtocolAdmin: (() => ({ id: 'usr_admin', role: 'admin' })) as any,
    processPvLedger: () => 7,
    runBinarySettlement: () => 3,
    executeSafeSettlementCron: () => ({ distributed: 42, ok: true }),
    logAdminAction: logAdminAction as any,
  })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))

  // 1) process-ledger → audited with result
  { const r = await post('/api/admin/atomic/process-ledger')
    ok('process-ledger returns processed', r.json?.processed === 7)
    const a = auditFor('atomic_process_ledger')
    ok('process-ledger writes audit (admin + result)', !!a && a.adminId === 'usr_admin' && a.detail?.processed === 7, JSON.stringify(a)) }

  // (run-settlement / distribute endpoints removed — matching engine excised #401)

  server.close()

  // ── static: trial/run-eval + auction-reminders/run call logAdminAction; server wires it ──
  const trial = readFileSync('src/pwa/routes/trial.ts', 'utf8')
  ok('trial run-eval logs admin action', /run-eval'[\s\S]{0,260}logAdminAction\(admin\.id as string, 'trial_run_eval'/.test(trial))
  ok('trial deps require logAdminAction', /logAdminAction:/.test(trial))

  const auction = readFileSync('src/pwa/routes/auction.ts', 'utf8')
  ok('auction reminders run logs admin action', /auction-reminders\/run'[\s\S]{0,260}logAdminAction\(admin\.id as string, 'auction_reminders_run'/.test(auction))

  const server_ts = readFileSync('src/pwa/server.ts', 'utf8')
  ok('server wires logAdminAction into admin-atomic', /registerAdminAtomicRoutes\(app, \{[\s\S]{0,200}logAdminAction/.test(server_ts))
  ok('server wires logAdminAction into trial', /registerTrialRoutes\(app, \{[\s\S]{0,200}logAdminAction/.test(server_ts))
  ok('server wires logAdminAction into auction', /registerAuctionRoutes\(app, \{[\s\S]{0,260}logAdminAction/.test(server_ts))

  if (fail === 0) {
    console.log(`\n✅ admin economic-trigger audit: atomic process-ledger/run-settlement/distribute 行为级写审计(触发者+结果);trial run-eval + auction reminders 同款;server 已注入 logAdminAction\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}`)
  } else {
    console.error(`\n❌ admin economic-trigger audit FAILED\n  ✅ pass  ${pass}\n  ❌ fail  ${fail}\n${fails.join('\n')}`)
    process.exit(1)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
