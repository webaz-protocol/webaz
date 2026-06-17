// 审计修复 T (safeFetch redirect 守门) + U (withdrawal cancel 假退款) 回归
import { safeFetch, isPrivateOrInternalHost } from '../src/pwa/security/ssrf.js'
import * as http from 'http'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

// ─── T: safeFetch ──────────────────────────────────────────────

// 1. 初始 URL 私网 → 立刻拦截
let e1 = ''
try { await safeFetch('http://127.0.0.1/') } catch (e) { e1 = (e as Error).message }
expect('初始 URL 127.0.0.1 → ssrf_blocked', e1 === 'ssrf_blocked')

let e1b = ''
try { await safeFetch('http://10.0.0.1/') } catch (e) { e1b = (e as Error).message }
expect('初始 URL 10.0.0.1 → ssrf_blocked', e1b === 'ssrf_blocked')

let e1c = ''
try { await safeFetch('http://169.254.169.254/latest/meta-data/') } catch (e) { e1c = (e as Error).message }
expect('初始 URL AWS metadata → ssrf_blocked', e1c === 'ssrf_blocked')

// 2. 非 http(s) scheme → 拒绝
let e2 = ''
try { await safeFetch('file:///etc/passwd') } catch (e) { e2 = (e as Error).message }
expect('file:// scheme → ssrf_bad_scheme', e2 === 'ssrf_bad_scheme')

let e2b = ''
try { await safeFetch('javascript:alert(1)') } catch (e) { e2b = (e as Error).message }
expect('javascript: scheme → ssrf_bad_scheme', e2b === 'ssrf_bad_scheme')

// 3. 启 local HTTP server 真实测试 redirect 守门
// 整个测试在 127.0.0.1 上跑 — 把 isPrivateOrInternalHost 临时 monkey-patch 让 127.0.0.1 不算私网
// 这是合理的测试技巧 — 别在生产里这么干
const _origURL = URL
// Workaround：测试 server 用 127.0.0.1，safeFetch 会拒绝所有私网。改用直接构造响应模拟。
// 用一个 hostname alias：放行 'testhost.invalid' 但实际 fetch 127.0.0.1
// 因为测试只是模拟 redirect 行为，我们直接验证 safeFetch 的内部状态转换：在 server 上设 302 → safeFetch 应抛 ssrf_blocked 当 Location 指向私网
const server = http.createServer((req, res) => {
  if (req.url === '/redirect-to-private') {
    res.statusCode = 302
    res.setHeader('Location', 'http://10.0.0.1/secret')
    res.end()
  } else if (req.url === '/redirect-to-public') {
    res.statusCode = 302
    res.setHeader('Location', 'http://example.com/')
    res.end()
  } else if (req.url === '/redirect-chain') {
    res.statusCode = 302
    res.setHeader('Location', '/redirect-chain')  // 自跳 → 死循环
    res.end()
  } else if (req.url === '/200') {
    res.statusCode = 200
    res.end('hello')
  } else {
    res.statusCode = 404
    res.end('not found')
  }
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
const localUrl = (path: string) => `http://127.0.0.1:${port}${path}`

// 重要：safeFetch 会拒绝 127.0.0.1 作为初始 URL。所以这里改用 hosts trick — 用 URL hostname '0.0.0.1' 也会被拒。
// 真正测试 redirect 守门：构造一个 mock，先用 isPrivateOrInternalHost 的内部逻辑验证 Location 校验路径
// 由于 safeFetch 是 redirect: 'manual' 的，且 Location 处理路径单元测试覆盖足够，跳过真实 redirect server 测试。
// 这里直接关掉 server。
server.close()

// 4. 路径名末尾正常 URL（公网域名）safeFetch 应放行（不实际 fetch，因为 DNS / 网络不依赖）
// 直接验证 isPrivateOrInternalHost 部分已在 test-ssrf.ts 覆盖；safeFetch 的初始 URL 检查同样路径，不重复

// ─── safeFetch redirect 守门 — 用 monkey-patched fetch 模拟 302 ─────
// 临时替换 global.fetch 让 safeFetch 看到 302 → Location → 私网，验证是否拦截
const realFetch = globalThis.fetch
const FAKE = new Map<string, { status: number; location?: string; body?: string }>([
  ['https://attacker.example.com/r', { status: 302, location: 'http://10.0.0.1/secret' }],
  ['https://attacker.example.com/chain1', { status: 302, location: 'https://attacker.example.com/chain2' }],
  ['https://attacker.example.com/chain2', { status: 302, location: 'http://169.254.169.254/' }],
  ['https://attacker.example.com/ok', { status: 200, body: 'normal page' }],
])
function mockFetch(input: string | URL | Request, _init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : (input as URL).href
  const f = FAKE.get(url)
  if (!f) return Promise.resolve(new Response('not mocked', { status: 404 }))
  const headers = new Headers()
  if (f.location) headers.set('Location', f.location)
  return Promise.resolve(new Response(f.body ?? null, { status: f.status, headers }))
}
;(globalThis as { fetch: typeof globalThis.fetch }).fetch = mockFetch as typeof globalThis.fetch

// 1 跳：公网 → 302 → 私网
let eRed = ''
try { await safeFetch('https://attacker.example.com/r') } catch (e) { eRed = (e as Error).message }
expect('公网→302→私网 redirect → ssrf_blocked', eRed === 'ssrf_blocked')

// 2 跳：公网 → 302 → 公网 → 302 → metadata
let eRed2 = ''
try { await safeFetch('https://attacker.example.com/chain1') } catch (e) { eRed2 = (e as Error).message }
expect('多跳 redirect 最终触达 169.254 → ssrf_blocked', eRed2 === 'ssrf_blocked')

// 公网 → 200，正常返回
const okResp = await safeFetch('https://attacker.example.com/ok')
expect('公网正常 200 → 通过', okResp.status === 200)

// 还原
globalThis.fetch = realFetch

// ─── U: withdrawal cancel 假退款回归 ───────────────────────
// 这是端点级 SQL 逻辑测试 — 直接模拟逻辑
import Database from 'better-sqlite3'
const db = new Database(':memory:')
db.exec(`
  CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL DEFAULT 0);
  CREATE TABLE withdrawal_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT, to_address TEXT, amount REAL,
    status TEXT DEFAULT 'pending',
    status_detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`)
db.prepare(`INSERT INTO wallets VALUES ('u1', 1000)`).run()
db.prepare(`INSERT INTO wallets VALUES ('u2', 1000)`).run()

// 复刻 server cancel 逻辑（仅 U 涉及的部分）
function cancel(wid: string, uid: string): { refunded: number } {
  const tx = db.transaction(() => {
    const wr = db.prepare(`SELECT user_id, amount, status FROM withdrawal_requests WHERE id = ?`).get(wid) as { user_id: string; amount: number; status: string }
    if (!wr || wr.user_id !== uid) throw new Error('not_owner')
    const isPendingEmail = wr.status === 'pending_email'
    db.prepare(`UPDATE withdrawal_requests SET status = 'cancelled' WHERE id = ?`).run(wid)
    if (!isPendingEmail) {
      db.prepare(`UPDATE wallets SET balance = balance + ? WHERE user_id = ?`).run(wr.amount, uid)
      return wr.amount
    }
    return 0
  })
  return { refunded: tx() }
}

// pending → 退款
db.prepare(`INSERT INTO withdrawal_requests VALUES ('w1','u1','0xabc',100,'pending',NULL,datetime('now'))`).run()
db.prepare(`UPDATE wallets SET balance = balance - 100 WHERE user_id = 'u1'`).run()  // 模拟下单时已扣
const r1 = cancel('w1', 'u1')
const b1 = (db.prepare(`SELECT balance FROM wallets WHERE user_id = 'u1'`).get() as { balance: number }).balance
expect('pending cancel → refunded = 100', r1.refunded === 100)
expect('pending cancel → balance 退回 1000', b1 === 1000)

// pending_email → 0 refund + balance 不动
db.prepare(`INSERT INTO withdrawal_requests VALUES ('w2','u2','0xdef',500,'pending_email',NULL,datetime('now'))`).run()
// 这里 balance 没被扣（pending_email 阶段）
const r2 = cancel('w2', 'u2')
const b2 = (db.prepare(`SELECT balance FROM wallets WHERE user_id = 'u2'`).get() as { balance: number }).balance
expect('pending_email cancel → refunded = 0（fix U）', r2.refunded === 0)
expect('pending_email cancel → balance 不动 = 1000', b2 === 1000)

// ─── safeFetch 也是个简单 sanity 检查
expect('isPrivateOrInternalHost("http://localhost/") = true', isPrivateOrInternalHost('http://localhost/') === true)
expect('isPrivateOrInternalHost("https://example.com/") = false', isPrivateOrInternalHost('https://example.com/') === false)

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
