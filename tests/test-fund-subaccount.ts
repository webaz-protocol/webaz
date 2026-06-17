// Phase A · 基金池科目化回归测试
// 验证：chain gap / orphan sponsor 兜底进 commission_reserve 各自科目，不进 sys_protocol
import Database from 'better-sqlite3'

const db = new Database(':memory:')

// 复刻 server.ts 1228+ 的 commission_reserve + commission_reserve_txns schema（含 Phase A 扩列）
db.exec(`
  CREATE TABLE commission_reserve (
    id              TEXT PRIMARY KEY,
    balance         REAL DEFAULT 0,
    total_donated   REAL DEFAULT 0,
    total_disbursed REAL DEFAULT 0,
    total_redirected REAL DEFAULT 0,
    total_chain_gap REAL DEFAULT 0,
    total_orphan_sponsor REAL DEFAULT 0,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE commission_reserve_txns (
    id                   TEXT PRIMARY KEY,
    kind                 TEXT NOT NULL,
    from_user_id         TEXT,
    to_user_id           TEXT,
    amount               REAL NOT NULL,
    related_wish_id      TEXT,
    related_repay_id     TEXT,
    related_order_id     TEXT,
    note                 TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE wallets (user_id TEXT PRIMARY KEY, balance REAL DEFAULT 0, earned REAL DEFAULT 0);
`)
db.prepare("INSERT INTO commission_reserve (id) VALUES ('main')").run()
db.prepare("INSERT INTO wallets VALUES ('sys_protocol', 0, 0)").run()

// 复刻 redirectToCommissionReserve（server.ts:17421+）
function generateId(prefix: string) { return prefix + '_' + Math.random().toString(36).slice(2, 10) }
function redirectToCommissionReserve(
  amount: number,
  kind: 'redirect_chain_gap' | 'redirect_orphan_sponsor',
  args: { orderId?: string; fromUserId?: string; note?: string } = {}
): void {
  if (!Number.isFinite(amount) || amount <= 0) return
  const a = Math.round(amount * 100) / 100
  const totalCol = kind === 'redirect_chain_gap' ? 'total_chain_gap' : 'total_orphan_sponsor'
  db.transaction(() => {
    db.prepare(`UPDATE commission_reserve SET balance = balance + ?, ${totalCol} = ${totalCol} + ?, updated_at = datetime('now') WHERE id = 'main'`).run(a, a)
    db.prepare(`INSERT INTO commission_reserve_txns (id, kind, from_user_id, amount, related_order_id, note)
                VALUES (?,?,?,?,?,?)`).run(generateId('crt'), kind, args.fromUserId || null, a, args.orderId || null, args.note || null)
  })()
}

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

// ─── 1. chain gap 入 total_chain_gap ────────────────────────────
redirectToCommissionReserve(7, 'redirect_chain_gap', { orderId: 'ord_1', fromUserId: 'buyer1', note: 'L2 空缺' })
const cf1 = db.prepare("SELECT balance, total_chain_gap, total_orphan_sponsor FROM commission_reserve WHERE id='main'").get() as { balance: number; total_chain_gap: number; total_orphan_sponsor: number }
expect('balance 加了 7', cf1.balance === 7)
expect('total_chain_gap 加了 7', cf1.total_chain_gap === 7)
expect('total_orphan_sponsor 不变 = 0', cf1.total_orphan_sponsor === 0)

const txn1 = db.prepare("SELECT kind, amount, related_order_id, note FROM commission_reserve_txns ORDER BY created_at DESC LIMIT 1").get() as { kind: string; amount: number; related_order_id: string; note: string }
expect('txn kind = redirect_chain_gap', txn1.kind === 'redirect_chain_gap')
expect('txn amount = 7', txn1.amount === 7)
expect('txn related_order_id 链入', txn1.related_order_id === 'ord_1')

// ─── 2. orphan sponsor 入 total_orphan_sponsor ──────────────────
redirectToCommissionReserve(3.5, 'redirect_orphan_sponsor', { orderId: 'ord_2', note: 'L1 sponsor 不合规' })
const cf2 = db.prepare("SELECT balance, total_chain_gap, total_orphan_sponsor FROM commission_reserve WHERE id='main'").get() as { balance: number; total_chain_gap: number; total_orphan_sponsor: number }
expect('balance 累加到 10.5', cf2.balance === 10.5)
expect('total_chain_gap 仍 7', cf2.total_chain_gap === 7)
expect('total_orphan_sponsor 加了 3.5', cf2.total_orphan_sponsor === 3.5)

// ─── 3. sys_protocol 钱包不应被任何 redirectToCommissionReserve 影响 ─────
const sys = db.prepare("SELECT balance FROM wallets WHERE user_id='sys_protocol'").get() as { balance: number }
expect('sys_protocol 钱包未被旁路充值（已改进 commission_reserve）', sys.balance === 0)

// ─── 4. 0 / 负 / NaN amount 应被静默拒 ──────────────────────────
redirectToCommissionReserve(0, 'redirect_chain_gap')
redirectToCommissionReserve(-5, 'redirect_chain_gap')
redirectToCommissionReserve(NaN, 'redirect_chain_gap')
redirectToCommissionReserve(Infinity, 'redirect_chain_gap')
const cf3 = db.prepare("SELECT balance FROM commission_reserve WHERE id='main'").get() as { balance: number }
expect('0/负/NaN/Infinity 不动 balance', cf3.balance === 10.5)
const txnCount = (db.prepare("SELECT COUNT(*) as n FROM commission_reserve_txns").get() as { n: number }).n
expect('坏 amount 没产生新 txn', txnCount === 2)

// ─── 5. 多次累加正确（精度 — 浮点 sum 容忍 ε）─────────────
redirectToCommissionReserve(0.1, 'redirect_chain_gap')
redirectToCommissionReserve(0.2, 'redirect_chain_gap')
redirectToCommissionReserve(0.1, 'redirect_chain_gap')
const cf4 = db.prepare("SELECT total_chain_gap FROM commission_reserve WHERE id='main'").get() as { total_chain_gap: number }
expect('累加 0.1+0.2+0.1 后 total_chain_gap ≈ 7.4 (容忍浮点 ε)', Math.abs(cf4.total_chain_gap - 7.4) < 1e-9)

// ─── 6. 科目互不干扰 ──────────────────────────────────────────
redirectToCommissionReserve(100, 'redirect_chain_gap')
redirectToCommissionReserve(200, 'redirect_orphan_sponsor')
const cf5 = db.prepare("SELECT total_chain_gap, total_orphan_sponsor FROM commission_reserve WHERE id='main'").get() as { total_chain_gap: number; total_orphan_sponsor: number }
expect('total_chain_gap = 7.4 + 100 = 107.4', cf5.total_chain_gap === 107.4)
expect('total_orphan_sponsor = 3.5 + 200 = 203.5', cf5.total_orphan_sponsor === 203.5)

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
