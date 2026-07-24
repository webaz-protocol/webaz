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
 *
 * chain_events 去重键 = UNIQUE(tx_hash, log_index, block_hash)【三键,B4 审计加宽】:仅 (tx_hash,
 * log_index) 二键会让"同位重组"——同一 tx 在同一 logIndex 被重新打包进【新 block_hash】的区块——
 * 的新 canonical 行永远进不了镜像(mirrorEvent 的 INSERT OR IGNORE 静默丢弃),镜像只剩被标孤儿的
 * 重组前行,违背"镜像=链上真相"且饿死下游结算对账(只读非孤儿行)。加入 block_hash 后,同位重组的
 * 替换行按不同三元组作为【新行】落盘,老行照旧被 orphans 标记排除,两行并存、读侧取 canonical。
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
    status          TEXT NOT NULL DEFAULT 'issued',  -- issued | funded | released | resolved | void(B5:Released 后 funded→released;B7a:Resolved 后 funded→resolved,均终态)
    buyer_addr      TEXT,                     -- B6b-2 A3:digest 绑定的买家链上地址(EIP-55;换账号释放的 preflight 校验用)。非 append-only:随重签更新。
    chain_id        INTEGER,                  -- B6b-2 A5:签发时的链 id 快照(env flip 后在途单取快照,不取 live env)
    created_at      TEXT DEFAULT (datetime('now'))
  )`)
  // ALTER AFTER CREATE(fresh DB 走 CREATE,存量表走 ALTER;两列均 nullable,存量空表安全)——
  //   B6b-2 A3/A5 补列:buyer_addr(存款账户校验)、chain_id(链快照)。二者是 voucher 快照的一部分,非 append-only。
  for (const col of ['buyer_addr TEXT', 'chain_id INTEGER']) {
    try { db.exec(`ALTER TABLE usdc_escrow_intents ADD COLUMN ${col}`) } catch { /* 已存在 */ }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_uei_key ON usdc_escrow_intents(order_key)`)

  // 一次性守卫重建(B4 审计):旧 UNIQUE(tx_hash,log_index) 使同位重组的新 canonical 行永远进不了镜像
  // (INSERT OR IGNORE 静默丢弃)——加宽为 UNIQUE(tx_hash,log_index,block_hash)。本表自出生全环境为空
  // (轨道全暗),仅空表才重建;万一非空(理论不可能)保留旧表并大声报错,绝不动数据。
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='usdc_escrow_chain_events'").get() as { sql: string } | undefined
  if (existing && !existing.sql.includes('UNIQUE(tx_hash, log_index, block_hash)')) {
    const n = (db.prepare('SELECT COUNT(*) n FROM usdc_escrow_chain_events').get() as { n: number }).n
    if (n === 0) db.exec('DROP TABLE usdc_escrow_chain_events')
    else console.error('[usdc-escrow-store] chain_events has legacy UNIQUE shape AND data — refusing to rebuild; mirror dedup stays legacy (manual migration required)')
  }

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
    UNIQUE(tx_hash, log_index, block_hash)     -- 三键(B4):同位重组的新 canonical 行按新 block_hash 作为新行落盘
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

  // B5 费用镜像:链上 pull-payment 平台费的【只读镜像】(不是应收 —— direct_p2p 的 fee AR
  // 语义不适用,钱已在合约 accruedFees 收讫)。写入仅 INSERT OR IGNORE(经 settleUsdcEscrowAtCompletion;
  // order_id PK = 一单一行的幂等锚),append-only 触发器与镜像姊妹表(chain_events / event_orphans)一致:
  // BEFORE UPDATE/DELETE → ABORT,PG parity 经 gen-pg-schema APPEND_ONLY_TABLES 同步。
  db.exec(`
  CREATE TABLE IF NOT EXISTS usdc_escrow_fee_ledger (
    order_id     TEXT PRIMARY KEY,          -- 一单一行(幂等锚)
    order_key    TEXT NOT NULL,
    amount_units INTEGER NOT NULL,          -- feePaid(USDC 6dp;链上已收讫,本行仅镜像)
    auto_release INTEGER NOT NULL DEFAULT 0,
    tx_hash      TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now'))
  )`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_uefl_no_update BEFORE UPDATE ON usdc_escrow_fee_ledger
           BEGIN SELECT RAISE(ABORT, 'usdc_escrow_fee_ledger is append-only'); END`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_uefl_no_delete BEFORE DELETE ON usdc_escrow_fee_ledger
           BEGIN SELECT RAISE(ABORT, 'usdc_escrow_fee_ledger is append-only'); END`)
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

// ─── PR-B6a: voucher intent 生命周期(签发写、状态读、取消/清扫作废)。域逻辑集中于此,路由层零 db.prepare。 ───

export interface VoucherIntentInput {
  orderId: string; orderKey: string; contractAddr: string; buyerId: string
  sellerId: string; sellerAddr: string; amountUnits: number; feeBps: number
  autoReleaseAtIso: string; voucherSig: string; authExpiresAtIso: string
  buyerAddr: string; chainId: number   // B6b-2 A3/A5:买家链上地址快照 + 签发时链 id 快照
}

/**
 * 签发/重签 voucher intent(单 sync tx,better-sqlite3 天然串行 → 无 TOCTOU)。
 *   - 无行 → INSERT(status='issued')。
 *   - issued → 重签:UPDATE 全部凭证字段(旧 voucher 一次性 digest 自然作废,合约 replay guard 不受影响)。
 *   - funded/released/resolved → 拒(真钱已入链 / 已结算 / 已仲裁终态;不可重签)。void → 拒(订单已取消/凭证已作废)。
 * order_key 落库【lowercase】—— B4 watcher 按 lowercase 查询,跨 PR 不变量,签发处 toLowerCase 守卫。
 * (funded/released/resolved/void 分支为防御性:路由层 status==='created' 门保证进入此处的 intent 只能是 absent|issued。)
 */
export function upsertUsdcEscrowVoucherIntent(
  db: Database.Database, i: VoucherIntentInput,
): { ok: true; outcome: 'issued' | 'reissued' } | { ok: false; error: string; error_code: string } {
  const key = i.orderKey.toLowerCase()   // 跨 PR 不变量守卫(B4 watcher lowercase 查询)
  return db.transaction(() => {
    const existing = db.prepare('SELECT status FROM usdc_escrow_intents WHERE order_id = ?').get(i.orderId) as { status: string } | undefined
    if (existing) {
      if (existing.status === 'funded' || existing.status === 'released' || existing.status === 'resolved') return { ok: false as const, error: '该订单已完成链上存入,凭证不可重签', error_code: 'USDC_ESCROW_VOUCHER_ALREADY_FUNDED' }
      if (existing.status === 'void') return { ok: false as const, error: '该订单凭证已作废(订单已取消)', error_code: 'USDC_ESCROW_VOUCHER_VOIDED' }
      db.prepare(`UPDATE usdc_escrow_intents SET order_key=?, contract_addr=?, buyer_id=?, seller_id=?, seller_addr=?, amount_units=?, fee_bps=?, auto_release_at=?, voucher_sig=?, auth_expires_at=?, buyer_addr=?, chain_id=?, status='issued' WHERE order_id=?`)
        .run(key, i.contractAddr, i.buyerId, i.sellerId, i.sellerAddr, i.amountUnits, i.feeBps, i.autoReleaseAtIso, i.voucherSig, i.authExpiresAtIso, i.buyerAddr, i.chainId, i.orderId)
      return { ok: true as const, outcome: 'reissued' as const }
    }
    db.prepare(`INSERT INTO usdc_escrow_intents (order_id, order_key, contract_addr, buyer_id, seller_id, seller_addr, amount_units, fee_bps, auto_release_at, voucher_sig, auth_expires_at, buyer_addr, chain_id, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'issued')`)
      .run(i.orderId, key, i.contractAddr, i.buyerId, i.sellerId, i.sellerAddr, i.amountUnits, i.feeBps, i.autoReleaseAtIso, i.voucherSig, i.authExpiresAtIso, i.buyerAddr, i.chainId)
    return { ok: true as const, outcome: 'issued' as const }
  })()
}

/**
 * 轮询端点真值(B6b stepper 消费):intent 状态 + 链上 Deposited/Released 是否已【非孤儿】镜像(重组孤儿排除)。
 * B6b-2 增补【只读】投影:voucher 快照的经济参数(金额 / 卖家收款地址 / 费率 / 自动放款时刻 / 签发时合约地址)。
 *   释放·争议面必须同屏显示这组数字供用户与钱包弹窗交叉核对,倒计时也必须按【存入时冻结的】autoReleaseAt 走,
 *   而不是重新按 param 现算。纯 SELECT 投影:零写、零语义变化(唯一消费方 = routes/usdc-escrow.ts GET /status)。
 */
export interface UsdcEscrowStatusView {
  intent_status: string | null; deposited_seen: boolean; released_seen: boolean; disputed_seen: boolean
  contract_addr: string | null; seller_addr: string | null; buyer_addr: string | null; chain_id: number | null
  amount_units: number | null; fee_bps: number | null; auto_release_at: string | null
}
export function getUsdcEscrowStatus(db: Database.Database, orderId: string): UsdcEscrowStatusView {
  const intent = db.prepare('SELECT order_key, status, contract_addr, seller_addr, buyer_addr, chain_id, amount_units, fee_bps, auto_release_at FROM usdc_escrow_intents WHERE order_id = ?').get(orderId) as
    { order_key: string; status: string; contract_addr: string; seller_addr: string; buyer_addr: string | null; chain_id: number | null; amount_units: number; fee_bps: number; auto_release_at: string } | undefined
  if (!intent) return { intent_status: null, deposited_seen: false, released_seen: false, disputed_seen: false, contract_addr: null, seller_addr: null, buyer_addr: null, chain_id: null, amount_units: null, fee_bps: null, auto_release_at: null }
  const seen = (name: string): boolean => !!db.prepare(`
    SELECT 1 FROM usdc_escrow_chain_events ce
    LEFT JOIN usdc_escrow_event_orphans o ON o.event_id = ce.id
    WHERE o.event_id IS NULL AND ce.event_name = ? AND ce.order_key = ? LIMIT 1
  `).get(name, intent.order_key)
  return {
    // disputed_seen:合约 Disputed 后 escrow 只能经 arbiterResolve 退出 —— buyerRelease/flagDispute 都会 revert。
    //   读面必须暴露它,否则 UI 会渲染出必然失败的按钮(B6b-2 D1 的 calldata 门也用它)。
    intent_status: intent.status, deposited_seen: seen('Deposited'), released_seen: seen('Released'), disputed_seen: seen('Disputed'),
    contract_addr: intent.contract_addr, seller_addr: intent.seller_addr,
    buyer_addr: intent.buyer_addr, chain_id: intent.chain_id === null || intent.chain_id === undefined ? null : Number(intent.chain_id),
    amount_units: Number(intent.amount_units), fee_bps: Number(intent.fee_bps), auto_release_at: intent.auto_release_at,
  }
}

/**
 * 取消/付款窗清扫时作废【未存入(issued)】凭证——一次性 digest 天然失效,链上不受影响。
 * 只动 issued:funded/released 是真钱已入链(绝不改),void 已终态。表缺失/无行 → no-op(direct_p2p 无 intent)。
 * 调用方须在【同一 db.transaction】内先完成 created→cancelled 转移(与库存回补同原子边界)。
 */
export function voidUsdcEscrowIntentOnCancel(db: Database.Database, orderId: string): void {
  try { db.prepare("UPDATE usdc_escrow_intents SET status = 'void' WHERE order_id = ? AND status = 'issued'").run(orderId) } catch { /* 表缺失/无行 → no-op */ }
}
