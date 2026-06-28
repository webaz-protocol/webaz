/**
 * L0-1 · 数据库 Schema
 * 所有表结构定义。协议里每个角色、每笔交易、每个状态都存在这里。
 */

import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { randomBytes } from 'crypto'

const DATA_DIR = path.join(os.homedir(), '.webaz')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
const DB_PATH = path.join(DATA_DIR, 'webaz.db')

export function initDatabase(): Database.Database {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')  // 更好的并发性能
  db.pragma('foreign_keys = ON')   // 强制外键约束

  db.exec(`

    /* ──────────────────────────────────────────
       用户表 · 每个参与协议的人
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,          -- 唯一ID，格式：usr_xxxx
      name        TEXT NOT NULL,
      role        TEXT NOT NULL,             -- 当前激活角色
      roles       TEXT DEFAULT '[]',         -- 拥有的所有角色（JSON数组）
      api_key     TEXT UNIQUE NOT NULL,      -- Agent 调用时用这个验证身份
      stake       REAL DEFAULT 0,            -- 当前质押金额（模拟货币）
      reputation  REAL DEFAULT 100,          -- 声誉分（满分100）
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    /* ──────────────────────────────────────────
       商品表 · 卖家上架的商品
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS products (
      id            TEXT PRIMARY KEY,         -- 格式：prd_xxxx
      seller_id     TEXT NOT NULL REFERENCES users(id),
      title         TEXT NOT NULL,
      description   TEXT NOT NULL,
      price         REAL NOT NULL,
      currency      TEXT DEFAULT 'DCP',       -- 协议内部模拟货币
      stock         INTEGER DEFAULT 1,
      category      TEXT,
      images        TEXT DEFAULT '[]',        -- JSON 数组，存图片路径
      stake_amount  REAL DEFAULT 0,           -- 卖家为这个商品质押的金额
      status        TEXT DEFAULT 'active',    -- active / paused / delisted
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    /* ──────────────────────────────────────────
       订单表 · 一笔完整的交易
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS orders (
      id              TEXT PRIMARY KEY,       -- 格式：ord_xxxx
      product_id      TEXT NOT NULL REFERENCES products(id),
      buyer_id        TEXT NOT NULL REFERENCES users(id),
      seller_id       TEXT NOT NULL REFERENCES users(id),
      logistics_id    TEXT REFERENCES users(id),   -- 接单的物流方
      promoter_id     TEXT REFERENCES users(id),   -- 带来流量的推荐人（可为空）

      quantity        INTEGER DEFAULT 1,
      unit_price      REAL NOT NULL,
      total_amount    REAL NOT NULL,          -- 买家支付总额
      escrow_amount   REAL NOT NULL,          -- 托管中的金额

      -- 当前状态（L0-2 状态机管理这个字段）
      status          TEXT NOT NULL DEFAULT 'created',
      -- 状态枚举：
      -- created       买家下单，资金待托管
      -- paid          资金已托管
      -- accepted      卖家确认接单
      -- shipped       卖家已交物流
      -- picked_up     物流已揽收
      -- in_transit    运输中
      -- delivered     物流已投递
      -- confirmed     买家确认收货 → 触发结算
      -- disputed      争议中
      -- completed     交易完成，资金已分配
      -- cancelled     取消

      -- 各节点截止时间（超时自动判责）
      pay_deadline      TEXT,   -- 下单后 24h 内必须完成支付
      accept_deadline   TEXT,   -- 支付后 24h 内卖家必须接单
      ship_deadline     TEXT,   -- 接单后按承诺时间发货
      pickup_deadline   TEXT,   -- 发货后 48h 内物流必须揽收
      delivery_deadline TEXT,   -- 揽收后 X 天内必须投递
      confirm_deadline  TEXT,   -- 投递后 72h 内买家确认（否则自动确认）

      shipping_address  TEXT,   -- 收货地址（JSON）
      notes             TEXT,   -- 买家备注

      -- PR-5b-0: direct_p2p 建单时的【入口控制 policy 快照】(冻结当时的 cfg + 判定码;5b wiring 才写入,本 PR 仅建列)。
      -- 全部 additive nullable;布尔以 0/1 存,cap 以整数 base-units 存。仅 direct_p2p 单写,其它 rail 恒 NULL。
      direct_pay_enabled_snapshot           INTEGER,  -- 建单时 direct_pay.enabled 快照(0/1)
      direct_pay_rail_breaker_snapshot      INTEGER,  -- 建单时 rail_breaker_tripped 快照(0/1)
      direct_pay_region_snapshot            TEXT,     -- 建单时 region 快照
      direct_pay_region_allowlist_snapshot  TEXT,     -- 建单时 region_allowlist 快照(CSV/JSON 文本)
      direct_pay_per_tx_cap_units_snapshot  INTEGER,  -- 建单时单笔上限快照(整数 policy base-units;WebAZ 记录订单总额天花板,非场外实付控制)
      direct_pay_seller_breaker_snapshot    INTEGER,  -- 建单时 sellerBreakerTripped 快照(0/1)
      direct_pay_decision_code              TEXT,     -- 建单时控制面判定码快照(成功通常 NULL / 'OK';拒绝码见 DirectPayControlReason)
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    /* ──────────────────────────────────────────
       状态历史表 · 订单每次状态变更的完整记录
       这是「自举证」系统的核心，任何状态变更都留档
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS order_state_history (
      id           TEXT PRIMARY KEY,
      order_id     TEXT NOT NULL REFERENCES orders(id),
      from_status  TEXT NOT NULL,
      to_status    TEXT NOT NULL,
      actor_id     TEXT NOT NULL REFERENCES users(id),  -- 谁触发了这次状态变更
      actor_role   TEXT NOT NULL,                        -- 触发者的角色
      evidence_ids TEXT DEFAULT '[]',                    -- 本次附上的证据（JSON数组）
      notes        TEXT,                                 -- 说明
      created_at   TEXT DEFAULT (datetime('now'))
    );

    /* ──────────────────────────────────────────
       证据表 · 每一份上传的证明材料
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS evidence (
      id           TEXT PRIMARY KEY,           -- 格式：evt_xxxx
      order_id     TEXT NOT NULL REFERENCES orders(id),
      uploader_id  TEXT NOT NULL REFERENCES users(id),
      type         TEXT NOT NULL,              -- photo / video / document / gps / signature
      description  TEXT NOT NULL,              -- 这份证据证明什么
      file_path    TEXT,                       -- 本地存储路径（Phase 0）
      file_hash    TEXT,                       -- 文件内容的哈希（防篡改）
      metadata     TEXT DEFAULT '{}',          -- 额外信息，如GPS坐标（JSON）
      created_at   TEXT DEFAULT (datetime('now'))
    );

    /* ──────────────────────────────────────────
       争议表 · 出现纠纷时的记录
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS disputes (
      id              TEXT PRIMARY KEY,         -- 格式：dsp_xxxx
      order_id        TEXT NOT NULL REFERENCES orders(id),
      initiator_id    TEXT NOT NULL REFERENCES users(id),   -- 谁发起的争议
      reason          TEXT NOT NULL,            -- 争议原因
      stake_deposit   REAL DEFAULT 0,           -- 发起方质押的保证金（防恶意争议）

      status          TEXT DEFAULT 'open',      -- open / in_review / resolved / dismissed
      assigned_arbitrators TEXT DEFAULT '[]',   -- 分配到的仲裁员（JSON数组）
      verdict         TEXT,                     -- 裁定结果（JSON）
      verdict_reason  TEXT,                     -- 裁定理由

      created_at      TEXT DEFAULT (datetime('now')),
      resolved_at     TEXT
    );

    /* ──────────────────────────────────────────
       钱包表 · 协议内的模拟资金
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS wallets (
      user_id   TEXT PRIMARY KEY REFERENCES users(id),
      balance   REAL DEFAULT 0,        -- 可用余额
      staked    REAL DEFAULT 0,        -- 质押中（锁定不可用）
      escrowed  REAL DEFAULT 0,        -- 托管中（交易进行时锁定）
      earned    REAL DEFAULT 0,        -- 累计收益（统计用）
      updated_at TEXT DEFAULT (datetime('now'))
    );

    /* ──────────────────────────────────────────
       收益分配记录
    ────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS payouts (
      id           TEXT PRIMARY KEY,
      order_id     TEXT NOT NULL REFERENCES orders(id),
      recipient_id TEXT NOT NULL REFERENCES users(id),
      role         TEXT NOT NULL,       -- 以什么角色获得这笔收益
      amount       REAL NOT NULL,
      reason       TEXT NOT NULL,       -- seller_share / promoter_fee / logistics_fee / etc.
      created_at   TEXT DEFAULT (datetime('now'))
    );

    /* ──────────────────────────────────────────
       直接支付(Direct Pay)Rail 1 · 非托管撮合 + 信誉轨
       本金(货款)不经协议;以下表仅记录【资格/担保物/费用质押/风控/AML/披露】元数据。
       设计稿: docs/modules/DIRECT-PAYMENT-MODULE-DESIGN.INTERNAL.md (Rev 2026-06-27e)
    ────────────────────────────────────────── */

    -- 卖家"直接收款"资格(一真人一资格;档位 T0/T1/T2 决定配额)
    CREATE TABLE IF NOT EXISTS direct_receive_privileges (
      user_id          TEXT PRIMARY KEY REFERENCES users(id),
      status           TEXT NOT NULL DEFAULT 'none',  -- none | active | suspended
      tier             TEXT NOT NULL DEFAULT 'T0',    -- T0 | T1 | T2
      suspended_reason TEXT,
      granted_at       TEXT,
      updated_at       TEXT DEFAULT (datetime('now'))
    );

    -- base bond = 履约担保物(merchant performance security deposit);法律/会计上独立于买家货款。
    -- currency 必须【显式传入】,只允许 usdc | fiat(外部真实资产,生产收款经 deposit-rail 网关 legal-review gated;本 PR/4b 仅非生产确认)。
    -- WAZ【未启用】为 base-bond currency —— 无默认值 + CHECK 双重拦截;domain helper openDeposit 亦拒(4c 前路由不得 raw-insert 绕过)。
    CREATE TABLE IF NOT EXISTS direct_receive_deposits (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id),
      tier            TEXT NOT NULL DEFAULT 'T0',
      required_amount REAL NOT NULL,                  -- 该档要求的 bond
      amount          REAL NOT NULL DEFAULT 0,        -- 实际到位
      currency        TEXT NOT NULL CHECK (currency IN ('usdc','fiat')),  -- 显式传入,无默认;只允许 usdc|fiat;WAZ 未启用(生产收款 legal-review gated)
      deposit_rail    TEXT NOT NULL DEFAULT 'manual', -- manual(仅 test/非生产) | usdc_onchain | fiat_psp (后两者 GATED)
      external_ref    TEXT,                           -- 链上 tx / PSP 凭证引用
      status          TEXT NOT NULL DEFAULT 'pending',-- pending|confirmed|locked|insufficient|expired|refunding|refunded|slashed
      confirmed_at    TEXT,
      locked_at       TEXT,
      released_at     TEXT,
      production_receipt_confirmed_at TEXT,  -- 仅【真实生产收款】(USDC 链上 / 法币 PSP)确认时置;manual/非生产恒 NULL。生产 go-live 必须要求非 NULL,杜绝 manual rail 冒充 base bond 到位。
      -- PR-4b-1 生产收款 provenance 快照(仅在 production_receipt_confirmed_at 一并写;manual/非生产恒 NULL)。
      -- 刻意 production_ 前缀以区别于运营列 currency/deposit_rail/external_ref(后三者 manual 轨也用)。本 PR 只加列,无写入方。
      production_receipt_ref     TEXT,  -- 生产收款凭证引用(链上 tx / PSP receipt id);独立于 external_ref(manual 也写)
      production_rail_id         TEXT,  -- 确认时的 legal-cleared 生产轨 id 快照(usdc_onchain / fiat_psp)
      production_jurisdiction    TEXT,  -- 法务管辖区快照(担保物定性所适用法域)
      production_policy_version  TEXT,  -- 确认时生效的 base-bond/合规 policy 版本快照(审计可追溯)
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    -- 卖家自填【收款说明】(展示给买家的纯文本/handle/label)。这【不是】payment rail / escrow / PSP / 币种路由:
    -- WebAZ 只存储 + 下单时快照,绝不验证/路由/托管/判断币种/做 allowlist。下单读取卖家当前 active 一条,快照进 order。
    CREATE TABLE IF NOT EXISTS direct_receive_payment_instructions (
      id           TEXT PRIMARY KEY,
      seller_id    TEXT NOT NULL REFERENCES users(id),
      instruction  TEXT NOT NULL,                 -- 卖家自填、展示给买家的收款说明(场外结算用;WebAZ 不解析)
      label        TEXT,                          -- 可选短标签(如 "PayNow" / "Bank")
      status       TEXT NOT NULL DEFAULT 'active',-- active | inactive
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );

    -- 缓交(deferred-deposit)申请;审批=真人(RISK),绝不自动;缓交期配额压低,绝不零威慑。
    CREATE TABLE IF NOT EXISTS direct_receive_deferrals (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT NOT NULL REFERENCES users(id),
      reason               TEXT,
      period_days          INTEGER NOT NULL,
      reduced_quota_factor REAL NOT NULL DEFAULT 0.5,   -- 缓交期配额压低系数(<1,带下限)
      status               TEXT NOT NULL DEFAULT 'pending', -- pending|granted|rejected|expired
      approved_by          TEXT REFERENCES users(id),      -- 真人 admin
      approved_at          TEXT,
      expires_at           TEXT,
      grace_until          TEXT,
      created_at           TEXT DEFAULT (datetime('now'))
    );

    -- 逐单费用质押(fee-stake = 平台应收费用,非买家保障)。锁在现有 WAZ 账本。
    CREATE TABLE IF NOT EXISTS direct_pay_fee_stakes (
      id          TEXT PRIMARY KEY,
      order_id    TEXT NOT NULL REFERENCES orders(id),
      seller_id   TEXT NOT NULL REFERENCES users(id),
      amount      REAL NOT NULL,                  -- 锁定额(= 该单平台费)
      status      TEXT NOT NULL DEFAULT 'locked', -- locked|fee_taken|released|slashed
      created_at  TEXT DEFAULT (datetime('now')),
      settled_at  TEXT,
      UNIQUE(order_id)
    );

    -- penalty 科目(独立、物理隔离、只进不出)。出账【无代码路径】= append-only 硬保证。
    -- 三条出账红线(永不可破):①不退买家 ②不计 WebAZ 利润 ③不按个案裁决结果流向裁决者。
    CREATE TABLE IF NOT EXISTS penalty_fund (
      id                    TEXT PRIMARY KEY,       -- 恒为 'main'
      balance               REAL DEFAULT 0,
      total_fee_stake_slash REAL DEFAULT 0,
      total_base_bond_slash REAL DEFAULT 0,
      updated_at            TEXT
    );
    CREATE TABLE IF NOT EXISTS penalty_fund_txns (
      id               TEXT PRIMARY KEY,
      kind             TEXT NOT NULL,               -- fee_stake_slash | base_bond_slash
      source           TEXT NOT NULL,               -- fee_stake | base_bond (provenance)
      from_user_id     TEXT,
      amount           REAL NOT NULL,
      related_order_id TEXT,
      reason           TEXT,
      created_at       TEXT DEFAULT (datetime('now'))
    );

    -- 制裁/合规筛查(本仓原无;direct-pay 含加密=最重洗钱形态,硬要求)
    CREATE TABLE IF NOT EXISTS sanctions_screening (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id),
      status      TEXT NOT NULL DEFAULT 'clear',   -- clear | flagged | blocked
      source      TEXT,
      reason      TEXT,
      screened_at TEXT DEFAULT (datetime('now')),
      created_at  TEXT DEFAULT (datetime('now'))
    );

    -- AML 监控 flag(进【独立复核队列】,与配额节流分开);AML 能力 = INVARIANT。
    CREATE TABLE IF NOT EXISTS aml_flags (
      id               TEXT PRIMARY KEY,
      subject_user_id  TEXT NOT NULL REFERENCES users(id),
      related_order_id TEXT,
      rule             TEXT NOT NULL,              -- structuring|concentration|cumulative|crypto|velocity
      severity         TEXT NOT NULL DEFAULT 'low',-- low|medium|high
      detail           TEXT,                       -- JSON
      status           TEXT NOT NULL DEFAULT 'open',-- open|reviewing|cleared|escalated|str_filed
      disposition      TEXT,                       -- review_queue|downgrade|suspend (非资金手段)
      reviewed_by      TEXT REFERENCES users(id),
      reviewed_at      TEXT,
      created_at       TEXT DEFAULT (datetime('now'))
    );
    -- STR 申报(具名 compliance 责任人);留存默认 5 年(legal 可调)。
    CREATE TABLE IF NOT EXISTS aml_str_filings (
      id              TEXT PRIMARY KEY,
      flag_id         TEXT REFERENCES aml_flags(id),
      filed_by        TEXT NOT NULL,              -- 具名 compliance officer
      filing_ref      TEXT,
      narrative       TEXT,
      filed_at        TEXT DEFAULT (datetime('now')),
      retention_until TEXT NOT NULL              -- filed_at + 留存年限
    );

    -- 披露契约层凭证(append-only 事件):两次风险提醒各一行 —— stage='pre_select'(展示/选择直付前)
    -- 与 stage='pre_confirm'(最终下单/确认付款前)。每行记 notice_version + acked_at,可证两次【分别】发生、
    -- 第二次在最终确认前。最终确认逻辑只在【两 stage 都 ack】时放行(见 direct-pay-disclosures.ts)。
    -- 这是 Direct Pay「无经济保障、风险自担」边界的证据层 —— 不可压成单次 ack。
    CREATE TABLE IF NOT EXISTS direct_pay_disclosure_acks (
      id             TEXT PRIMARY KEY,
      order_id       TEXT NOT NULL REFERENCES orders(id),
      buyer_id       TEXT NOT NULL REFERENCES users(id),
      stage          TEXT NOT NULL,   -- pre_select | pre_confirm
      notice_version TEXT NOT NULL,   -- 该次提醒的披露文案版本
      acked_at       TEXT DEFAULT (datetime('now')),
      UNIQUE(order_id, stage)         -- 每单每阶段一次;两阶段=两行
    );

  `)

  // 迁移：为已有数据库添加 roles 列
  try {
    db.exec(`ALTER TABLE users ADD COLUMN roles TEXT DEFAULT '[]'`)
  } catch { /* 列已存在 */ }
  db.exec(`UPDATE users SET roles = json_array(role) WHERE roles = '[]' OR roles IS NULL`)

  // 迁移(Direct Pay Rail 1): 既有库补列。ADD COLUMN(非 rebuild),fresh-DB 与 existing-DB 两路均生效。
  try { db.exec(`ALTER TABLE orders ADD COLUMN payment_rail TEXT DEFAULT 'escrow'`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_window_deadline TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_grace_deadline TEXT`) } catch { /* 已存在 */ } // Rail1 paid-but-timeout 宽限期:系统在此之前绝不关单(买家 →disputed 窗口)
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_instruction_snapshot TEXT`) } catch { /* 已存在 */ } // Rail1 4c:下单时快照卖家收款说明(冻结买家所见;卖家事后改/停用不影响)
  // PR-5b-0: direct_p2p 入口控制 policy 快照列(既有库补列;additive nullable,本 PR 无写入方,5b wiring 才写)。
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_enabled_snapshot INTEGER`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_rail_breaker_snapshot INTEGER`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_region_snapshot TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_region_allowlist_snapshot TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_per_tx_cap_units_snapshot INTEGER`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_seller_breaker_snapshot INTEGER`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_decision_code TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE wallets ADD COLUMN fee_staked REAL DEFAULT 0`) } catch { /* 已存在 */ }
  // PR-4b-1: direct_receive_deposits 生产收款 provenance 快照列(既有库补列;additive nullable,无写入方,无 flow 启用)。
  try { db.exec(`ALTER TABLE direct_receive_deposits ADD COLUMN production_receipt_ref TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE direct_receive_deposits ADD COLUMN production_rail_id TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE direct_receive_deposits ADD COLUMN production_jurisdiction TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE direct_receive_deposits ADD COLUMN production_policy_version TEXT`) } catch { /* 已存在 */ }
  // penalty 科目单行种子(只进不出;无出账代码路径)
  db.exec(`INSERT OR IGNORE INTO penalty_fund (id, balance, total_fee_stake_slash, total_base_bond_slash, updated_at) VALUES ('main', 0, 0, 0, datetime('now'))`)

  console.error('✅ L0-1 数据库初始化完成：', DB_PATH)
  return db
}

// 生成唯一 ID 的工具函数 — crypto-safe，128 bit 熵
// Why: 旧版用 Date.now() + Math.random() 4 字符，api_key 仅 4 字符随机 → 36⁴≈168 万种秒破；
// 且 api_key / user_id 共享时间戳前缀泄漏关联（QA agent 抓到）。改用 crypto.randomBytes 后两个 ID 互不相关。
export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`
}
