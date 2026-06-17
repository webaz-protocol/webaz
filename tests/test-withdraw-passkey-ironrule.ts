// Codex #100 P1 — 提现真人 Passkey 是【铁律】,绝不可被 protocol param 关闭。
//   即使 protocol_params 把 require_human_presence_for_withdraw 设成 0(admin PATCH 绕过场景),
//   /api/wallet/withdraw 仍必须要求已绑 Passkey + 一次性 x-webauthn-token,
//   返回 PASSKEY_REQUIRED_FOR_WITHDRAW / webauthn_required,且【绝不】创建 withdrawal_request 或扣余额。
//   wallet-write 已改为无条件执行 gate(不读该 param);本测试用 param=0 证明旁路已被堵死。
import Database from 'better-sqlite3'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const ADDR = '0x' + 'a'.repeat(40)

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL DEFAULT 0);
    CREATE TABLE withdrawal_requests (id TEXT PRIMARY KEY, user_id TEXT, to_address TEXT, amount REAL,
      status TEXT DEFAULT 'awaiting_email_confirm', status_detail TEXT, email_confirmed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE withdrawal_whitelist (id TEXT PRIMARY KEY, user_id TEXT, address TEXT, label TEXT,
      activates_at TEXT, revoked_at TEXT, signature_verified_at TEXT);
    CREATE TABLE kyc_records (user_id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT);
  `)
  db.prepare("INSERT INTO wallets (user_id, balance) VALUES ('u1', 500)").run()
  return db
}
const reqCount = (db: Database.Database) => (db.prepare("SELECT COUNT(*) AS n FROM withdrawal_requests").get() as { n: number }).n
const bal = (db: Database.Database) => (db.prepare("SELECT balance AS b FROM wallets WHERE user_id='u1'").get() as { b: number }).b

async function main(): Promise<void> {
  const express = (await import('express')).default
  const { registerWalletWriteRoutes } = await import('../src/pwa/routes/wallet-write.js')

  // 关键:require_human_presence_for_withdraw=0(模拟 admin 把铁律开关关掉);其余 param 取安全默认。
  const params: Record<string, number> = {
    require_human_presence_for_withdraw: 0,   // ← 铁律开关被关 —— 不该有任何效果
    usdc_min_withdraw_waz: 10,
    kyc_required_withdraw_waz: 100000,        // 提 100 不触发 KYC,直达 Passkey gate
    kyc_daily_cumulative_waz: 100000,
  }
  // validToken 时 gate 通过;其余一律失败(模拟"无 token / token 不匹配")。
  function server(db: Database.Database) {
    const app = express(); app.use(express.json())
    registerWalletWriteRoutes(app, {
      db,
      auth: () => ({ id: 'u1', role: 'user' }),
      isTrustedRole: () => false,
      generateId: (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`,
      getProtocolParam: <T,>(k: string, fb: T): T => (k in params ? (params[k] as unknown as T) : fb),
      consumeGateToken: (_u, token) => token === 'valid-token' ? { ok: true } : { ok: false, reason: 'webauthn token 缺失或不匹配' },
      issueCode: () => {}, findActiveCode: () => null, maskEmail: (e: string) => e,
      LARGE_WITHDRAW_THRESHOLD: 100000,
    } as unknown as Parameters<typeof registerWalletWriteRoutes>[1])
    return app
  }
  async function post(app: ReturnType<typeof express>, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const srv = app.listen(0); await new Promise(r => srv.once('listening', r))
    const port = (srv.address() as { port: number }).port
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/wallet/withdraw`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
    } finally { srv.close() }
  }

  // ── A: param=0 + 无 Passkey → 仍被铁律挡(PASSKEY_REQUIRED_FOR_WITHDRAW),不建单不扣款 ──
  {
    const db = freshDb()  // 不插 webauthn_credentials → 无 Passkey
    const { status, body } = await post(server(db), { to_address: ADDR, amount: 100 })
    expect('A param=0 无Passkey → 403', status === 403, { status, body })
    expect('A → error_code=PASSKEY_REQUIRED_FOR_WITHDRAW', body.error_code === 'PASSKEY_REQUIRED_FOR_WITHDRAW', body)
    expect('A → 未创建 withdrawal_request', reqCount(db) === 0)
    expect('A → 余额未动(500)', bal(db) === 500)
  }

  // ── B: param=0 + 有 Passkey 但无一次性 token → webauthn_required,不建单不扣款 ──
  {
    const db = freshDb()
    db.prepare("INSERT INTO webauthn_credentials (id, user_id) VALUES ('cred1','u1')").run()
    const { status, body } = await post(server(db), { to_address: ADDR, amount: 100 })   // 无 x-webauthn-token
    expect('B param=0 有Passkey 无token → 403', status === 403, { status, body })
    expect('B → webauthn_required=true', body.webauthn_required === true, body)
    expect('B → 未创建 withdrawal_request', reqCount(db) === 0)
    expect('B → 余额未动(500)', bal(db) === 500)
  }

  // ── C: 正路依旧通(Passkey + 有效 token + 白名单已生效)→ 建单 + 扣款 ──
  {
    const db = freshDb()
    db.prepare("INSERT INTO webauthn_credentials (id, user_id) VALUES ('cred1','u1')").run()
    db.prepare("INSERT INTO withdrawal_whitelist (id, user_id, address, activates_at) VALUES ('wl1','u1',?, datetime('now','-1 day'))").run(ADDR)
    const { status, body } = await post(server(db), { to_address: ADDR, amount: 100 }, { 'x-webauthn-token': 'valid-token' })
    expect('C 正路 → 200 success', status === 200 && body.success === true, { status, body })
    expect('C → 创建 1 条 withdrawal_request', reqCount(db) === 1)
    expect('C → 余额扣 100 → 400', bal(db) === 400, bal(db))
  }
}

await main()
console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
