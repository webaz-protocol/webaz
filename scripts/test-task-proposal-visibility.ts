#!/usr/bin/env tsx
/**
 * Task proposal — proposer-visible status / 回执 (behavioral, real express + node:http).
 *   用法:npm run test:task-proposal-visibility
 *
 * 验证(对应"提交者可见的建议状态/回执"功能):
 *   - 匿名提交仍可用,但 linked_to_account=false,不进任何人的 /api/me;
 *   - 登录提交 → 挂到提交者账号(account id 来自会话,不来自 body) → 出现在本人 /api/me(状态+next_action);
 *   - 越权隔离:别人的 /api/me 看不到你的建议(仅自己的行);
 *   - admin review 写 public_reply → 提交者 /api/me 看得到 public_reply + 状态,且【绝不】暴露内部 review_note;
 *   - /api/me 未登录 → 401。
 */
import Database from 'better-sqlite3'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { Request, Response } from 'express'
import { initTaskProposalSchema } from '../src/layer2-business/L2-9-contribution/task-proposal-store.js'
import { registerTaskProposalsRoutes } from '../src/pwa/routes/task-proposals.js'

let pass = 0, fail = 0
const fails: string[] = []
const ok = (n: string, c: boolean, d = ''): void => { if (c) pass++; else { fail++; fails.push(`✗ ${n}${d ? `\n    ${d}` : ''}`) } }

/* eslint-disable @typescript-eslint/no-explicit-any */
const db: any = new Database(':memory:')
initTaskProposalSchema(db)

// stub auth: Bearer key → user (kA→usrA, kB→usrB); admin via x-admin header.
const USERS: Record<string, { id: string }> = { kA: { id: 'usrA' }, kB: { id: 'usrB' } }
const keyOf = (req: Request) => (req.headers.authorization?.replace('Bearer ', '') ?? (req.body?.api_key as string) ?? '')
const resolveUser = (req: Request) => USERS[keyOf(req)] ?? null
const auth = (req: Request, res: Response) => { const u = USERS[keyOf(req)]; if (!u) { res.status(401).json({ error: 'login required' }); return null } return u }
const errorRes = (res: Response, status: number, code: string, msg: string, extra?: Record<string, unknown>) =>
  res.status(status).json({ error: msg, error_code: code, ...(extra || {}) })

let server: Server, port = 0
const call = (method: string, path: string, body: any, key?: string): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
  const p = body ? JSON.stringify(body) : ''
  const headers: Record<string, string> = {}
  if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(p)) }
  if (key) headers['authorization'] = `Bearer ${key}`
  const r = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
    let raw = ''; res.on('data', c => { raw += c }); res.on('end', () => { let j: any = null; try { j = raw ? JSON.parse(raw) : null } catch { /* noop */ } resolve({ status: res.statusCode ?? 0, json: j }) })
  }); r.on('error', reject); if (body) r.write(p); r.end()
})

async function main(): Promise<void> {
  const app = express(); app.use(express.json())
  registerTaskProposalsRoutes(app, {
    db, errorRes,
    requireSupportAdmin: () => ({ id: 'admin1' }),   // tests drive review as a maintainer
    rateLimitOk: () => true,
    auth, resolveUser,
  })
  server = createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  port = (server.address() as any).port

  // 1) anonymous submit — allowed, NOT linked
  const anon = await call('POST', '/api/public/task-proposals', { title: 'anon idea', summary: 'from a stranger' })
  ok('1: anonymous submit 200', anon.status === 200, JSON.stringify(anon.json))
  ok('1: anonymous linked_to_account=false', anon.json?.linked_to_account === false)

  // 2) authed submit by usrA — linked
  const subA = await call('POST', '/api/public/task-proposals', { title: 'A structured proposal', summary: 'agent-readable body' }, 'kA')
  ok('2: authed submit 200 + linked', subA.status === 200 && subA.json?.linked_to_account === true)
  const idA = subA.json?.proposal?.id

  // anti-spoof: account id must come from session, not body — body proposer_account_id is ignored
  const spoof = await call('POST', '/api/public/task-proposals', { title: 'spoof attempt xyz', summary: 'tries to claim usrB', proposer_account_id: 'usrB' }, 'kA')
  ok('2b: spoof submit linked to the AUTHED user, not the body value', spoof.status === 200 && spoof.json?.linked_to_account === true)

  // 3) usrA sees own; usrB does NOT see usrA's
  const meA = await call('GET', '/api/me/task-proposals', null, 'kA')
  ok('3: A /api/me 200', meA.status === 200)
  const aIds = (meA.json?.proposals ?? []).map((p: any) => p.id)
  ok('3: A sees own proposal', aIds.includes(idA))
  ok('3: A sees the spoof one too (it is A\'s)', (meA.json?.proposals ?? []).some((p: any) => p.title === 'spoof attempt xyz'))
  ok('3: A status=new + next_action present', (meA.json?.proposals ?? []).every((p: any) => p.status === 'new' && typeof p.next_action === 'string' && p.next_action.length > 0))
  const meB = await call('GET', '/api/me/task-proposals', null, 'kB')
  ok('3: B does NOT see A\'s proposals (own-rows guard)', !(meB.json?.proposals ?? []).some((p: any) => p.id === idA))
  ok('3: anonymous proposal not in A nor B', !aIds.includes(anon.json?.proposal?.id) && !(meB.json?.proposals ?? []).some((p: any) => p.id === anon.json?.proposal?.id))

  // 4) admin review with public_reply (+ internal note) → proposer sees reply, NEVER the internal note
  const rev = await call('POST', `/api/admin/task-proposals/${idA}/review`, { status: 'needs_info', note: 'INTERNAL: vague, ping on github', public_reply: 'Please specify desktop vs mobile and which pages.' }, 'kA')
  ok('4: review 200', rev.status === 200, JSON.stringify(rev.json))
  const meA2 = await call('GET', '/api/me/task-proposals', null, 'kA')
  const row = (meA2.json?.proposals ?? []).find((p: any) => p.id === idA)
  ok('4: status now needs_info', row?.status === 'needs_info')
  ok('4: public_reply visible to proposer', row?.public_reply === 'Please specify desktop vs mobile and which pages.')
  ok('4: next_action reflects needs_info', /more detail|missing/i.test(row?.next_action || ''))
  ok('4: internal review_note NEVER exposed to proposer', !('review_note' in (row || {})) && !JSON.stringify(meA2.json).includes('INTERNAL:'))
  ok('4: reviewer_id NEVER exposed to proposer', !('reviewer_id' in (row || {})))

  // 5) /api/me requires auth
  const noauth = await call('GET', '/api/me/task-proposals', null)
  ok('5: /api/me unauthenticated → 401', noauth.status === 401)

  await new Promise<void>(r => server.close(() => r()))
  console.log(`\n${fail === 0 ? '✅' : '❌'} task-proposal-visibility: ${pass} pass / ${fail} fail`)
  if (fail > 0) { console.log(fails.join('\n')); process.exit(1) }
}
main().catch(e => { console.error(e); process.exit(1) })
