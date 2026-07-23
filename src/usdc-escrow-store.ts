/**
 * USDC 链上合约担保(B 线)PR-B2 — schema + 卖家收款地址注册的领域模块。
 *
 * 对应合约 contracts/WebazEscrow.sol(#518)。铁律:
 *   - 本金【完全不进】wallets 表 —— 订单资金态由链上事件镜像(usdc_escrow_chain_events)驱动;
 *   - 无确认链上事件绝不进 paid(watcher PR-B4 消费本表,确认数/重组语义在彼处);
 *   - 收款地址是卖家自报的链上地址(EIP-55 校验后存 canonical 形式),retire 不 DELETE;
 *   - intents 表 = 后端签发 voucher 的快照(经济参数与合约 EIP-712 一致),一单一行。
 *
 * chain_events 与 orphan 标记均为【真 append-only】(BEFORE UPDATE/DELETE → ABORT,PG parity 经
 * gen-pg-schema APPEND_ONLY_TABLES 同步):重组不改行 —— 往 usdc_escrow_event_orphans 加一行标记,
 * 读侧 join 排除(与 admin 冲正记账同哲学:更正=加行,绝不改历史)。
 */
import type Database from 'better-sqlite3'
import { getAddress } from 'viem'

export function initUsdcEscrowSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS seller_payout_addresses (
    id            TEXT PRIMARY KEY,
    seller_id     TEXT NOT NULL,
    address       TEXT NOT NULL,              -- EIP-55 canonical(viem getAddress 产物)
    chain         TEXT NOT NULL DEFAULT 'base',
    label         TEXT,
    ownership_sig TEXT,                       -- 可选 personal_sign 归属证明(v1 自报即可)
    status        TEXT NOT NULL DEFAULT 'active',  -- active | retired(绝不 DELETE)
    created_at    TEXT DEFAULT (datetime('now')),
    retired_at    TEXT
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_spa_seller ON seller_payout_addresses(seller_id, status)`)

  db.exec(`
  CREATE TABLE IF NOT EXISTS usdc_escrow_intents (
    order_id        TEXT PRIMARY KEY,
    order_key       TEXT NOT NULL,            -- keccak256(orderId bytes32) hex — 与链上 orderKey 对齐
    contract_addr   TEXT NOT NULL,            -- 签发时的 WebazEscrow 地址(env 快照)
    buyer_id        TEXT NOT NULL,
    seller_id       TEXT NOT NULL,
    seller_addr     TEXT NOT NULL,            -- voucher 绑定的收款地址(EIP-55)
    amount_units    INTEGER NOT NULL,         -- USDC 6dp
    fee_bps         INTEGER NOT NULL,
    auto_release_at TEXT NOT NULL,            -- ISO;合约里为 unix 秒(voucher 快照的人读镜像)
    voucher_sig     TEXT NOT NULL,            -- EIP-712 signature hex
    auth_expires_at TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'issued',  -- issued | funded | void
    created_at      TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_uei_key ON usdc_escrow_intents(order_key)`)

  db.exec(`
  CREATE TABLE IF NOT EXISTS usdc_escrow_chain_events (
    id           TEXT PRIMARY KEY,
    order_key    TEXT NOT NULL,
    event_name   TEXT NOT NULL,               -- Deposited | Released | Disputed | Resolved
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    block_number INTEGER NOT NULL,
    block_hash   TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(tx_hash, log_index)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_uece_key ON usdc_escrow_chain_events(order_key)`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_uece_no_update BEFORE UPDATE ON usdc_escrow_chain_events
           BEGIN SELECT RAISE(ABORT, 'usdc_escrow_chain_events is append-only'); END`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_uece_no_delete BEFORE DELETE ON usdc_escrow_chain_events
           BEGIN SELECT RAISE(ABORT, 'usdc_escrow_chain_events is append-only'); END`)

  // 重组孤儿标记:加行不改行(读侧 LEFT JOIN 排除;event_id 双保险 UNIQUE 防重复标记)
  db.exec(`
  CREATE TABLE IF NOT EXISTS usdc_escrow_event_orphans (
    event_id   TEXT PRIMARY KEY,              -- → usdc_escrow_chain_events.id
    reason     TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_ueeo_no_update BEFORE UPDATE ON usdc_escrow_event_orphans
           BEGIN SELECT RAISE(ABORT, 'usdc_escrow_event_orphans is append-only'); END`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_ueeo_no_delete BEFORE DELETE ON usdc_escrow_event_orphans
           BEGIN SELECT RAISE(ABORT, 'usdc_escrow_event_orphans is append-only'); END`)

  db.exec(`
  CREATE TABLE IF NOT EXISTS usdc_escrow_watcher_state (
    id                 TEXT PRIMARY KEY,      -- 恒为 'main'
    last_scanned_block INTEGER NOT NULL DEFAULT 0,
    updated_at         TEXT
  )`)
}

/** EIP-55 校验 + 归一。返回 canonical 地址或 null(非法输入,含全小写非校验和形式也接受再归一)。 */
export function canonicalEvmAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return null
  try { return getAddress(s.toLowerCase()) } catch { return null }
  // 注:先 toLowerCase 再 getAddress = 接受任意大小写输入、输出统一 EIP-55;
  //    若要拒绝"错误校验和"输入(大小写混合但校验和错误),用 getAddress(s) —— v1 选宽进严出。
}

export interface PayoutAddress {
  id: string; seller_id: string; address: string; chain: string
  label: string | null; status: string; created_at: string; retired_at: string | null
}

/** 卖家 active 收款地址列表(retire 的不出;供 payment-options / voucher 签发消费)。 */
export function listActivePayoutAddresses(db: Database.Database, sellerId: string): PayoutAddress[] {
  try {
    return db.prepare("SELECT id, seller_id, address, chain, label, status, created_at, retired_at FROM seller_payout_addresses WHERE seller_id = ? AND status = 'active' ORDER BY created_at").all(sellerId) as PayoutAddress[]
  } catch { return [] }
}

/** 新增收款地址(EIP-55 归一;同卖家同地址 active 去重)。返回 {ok} 或 {error}。 */
export function addPayoutAddress(
  db: Database.Database,
  args: { generateId: (p: string) => string; sellerId: string; address: unknown; label?: unknown },
): { ok: true; row: PayoutAddress } | { ok: false; error: string; error_code: string } {
  const addr = canonicalEvmAddress(args.address)
  if (!addr) return { ok: false, error: '无效的以太坊地址(0x + 40 位十六进制)', error_code: 'PAYOUT_ADDRESS_INVALID' }
  const dup = db.prepare("SELECT id FROM seller_payout_addresses WHERE seller_id = ? AND address = ? AND status = 'active'").get(args.sellerId, addr)
  if (dup) return { ok: false, error: '该地址已登记', error_code: 'PAYOUT_ADDRESS_DUPLICATE' }
  const label = typeof args.label === 'string' ? args.label.slice(0, 40) : null
  const id = args.generateId('spa')
  db.prepare('INSERT INTO seller_payout_addresses (id, seller_id, address, label) VALUES (?,?,?,?)').run(id, args.sellerId, addr, label)
  const row = db.prepare('SELECT id, seller_id, address, chain, label, status, created_at, retired_at FROM seller_payout_addresses WHERE id = ?').get(id) as PayoutAddress
  return { ok: true, row }
}

/** 退役地址(不 DELETE;幂等:已 retired 再调仍 ok)。只允许本人操作(路由层校验 seller)。 */
export function retirePayoutAddress(db: Database.Database, sellerId: string, id: string): { ok: boolean; error_code?: string } {
  const row = db.prepare('SELECT seller_id, status FROM seller_payout_addresses WHERE id = ?').get(id) as { seller_id: string; status: string } | undefined
  if (!row || row.seller_id !== sellerId) return { ok: false, error_code: 'PAYOUT_ADDRESS_NOT_FOUND' }
  if (row.status !== 'retired') db.prepare("UPDATE seller_payout_addresses SET status = 'retired', retired_at = datetime('now') WHERE id = ?").run(id)
  return { ok: true }
}
