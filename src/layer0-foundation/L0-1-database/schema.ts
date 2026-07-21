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
      currency      TEXT DEFAULT 'WAZ',       -- 协议内部模拟单位(WAZ);旧默认 'DCP' 已翻转 + 存量回填(见迁移段),existing-DB 建单路径亦显式写 WAZ
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
      draft_id        TEXT,                        -- RFC-026 PR-1:订单↔草稿关联(一 draft 一单;老库由 runtime helper ALTER 补,双向幂等)
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

    -- 直付多收款账号(direct_receive_accounts,Phase B):卖家可维护【多个】收款方式,每个自带币种 + 可选二维码图。
    -- ⚠️ 与单条 payment_instruction 同性质:WebAZ 只【存储 + 展示】卖家自填内容,【绝不】验证/路由/托管/判断币种,
    --   也不解析二维码。currency 仅供买家侧换算展示(FX 支持才显 ≈本地);qr_image_ref 指向硬化图片端点(Phase C)。
    --   多行模型:一个 seller 可有【多个】active(买家下单自选其一),与单 instruction 的"至多一条 active"不同。
    CREATE TABLE IF NOT EXISTS direct_receive_accounts (
      id            TEXT PRIMARY KEY,
      seller_id     TEXT NOT NULL REFERENCES users(id),
      method        TEXT,                          -- 收款方式名(卖家自填,如 PayNow / GCash / PromptPay / Bank)
      currency      TEXT,                          -- 该账号结算币种(卖家声明;买家侧按此换算,FX 支持则显 ≈本地)
      instruction   TEXT NOT NULL,                 -- 展示给买家的收款明细(账号 / 钱包 ID / 链接;WebAZ 不解析)
      label         TEXT,                          -- 可选短标签
      qr_image_ref  TEXT,                          -- 可选收款二维码图片引用(Phase C 填;硬化端点服务,绝不解析)
      status        TEXT NOT NULL DEFAULT 'active',-- active | inactive
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    -- 平台(WebAZ)收款方式(admin 管理,可多个 active):卖家申请充值【平台服务费】时看到、据此线下付款。
    -- ⚠️ 这是【平台侧】收款配置,不是卖家账号。改它 = 改平台收款流向 → 端点 root + Passkey 门。
    --   instruction 是平台公开收款明细,给卖家看(非披露门)。qr 内联存(admin 精选、少量;写时 validateQrDataUri 校验 png/webp≤64KB)。
    CREATE TABLE IF NOT EXISTS platform_receive_accounts (
      id            TEXT PRIMARY KEY,
      label         TEXT,                          -- 短标签(如 "PayNow-主" / "USDC-Base")
      method        TEXT,                          -- 收款方式(PayNow / Bank / USDC…)
      currency      TEXT,                          -- 币种(卖家据此付)
      instruction   TEXT NOT NULL,                 -- 平台收款明细(账号 / 钱包地址 / 链接),展示给卖家
      qr_data_uri   TEXT,                          -- 可选收款码,内联 data:image/(png|webp);base64(写时校验;≤64KB)
      status        TEXT NOT NULL DEFAULT 'active',-- active | inactive
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    -- 直付收款二维码图(Phase C):卖家收款码原始字节。【不可变、按内容寻址(per-seller)】—— ref = sha256(bytes),
    -- replace = 插新行,旧行永不改/删(触发器强制),这样订单可在建单时快照 (ref, seller_id) 并在 D1/D2 ack 后取回【当时那一版】QR。
    -- ⚠️ 主键 = (ref, seller_id):内容寻址【按卖家隔离】。两个卖家上传【相同】字节时各得一行(否则 INSERT OR IGNORE
    --   只留首个卖家的行,第二个卖家 owner-scoped 读 = 命中不到 → "上传成功但预览 404")。dedup 只在同一卖家内发生。
    -- WebAZ 只存字节、经硬化端点转发,绝不解析二维码含义 / 不验证收款方 / 不路由资金。仅 png|webp、解码 ≤64KB。
    CREATE TABLE IF NOT EXISTS direct_receive_account_qr_images (
      ref          TEXT NOT NULL,                  -- = sha256(decoded bytes),内容寻址、不可变
      account_id   TEXT NOT NULL REFERENCES direct_receive_accounts(id),
      seller_id    TEXT NOT NULL REFERENCES users(id),
      mime         TEXT NOT NULL,                  -- 'image/png' | 'image/webp'(仅此二者)
      data_b64     TEXT NOT NULL,                  -- base64 原始字节(硬化端点 forced content-type + nosniff + no-store 转发)
      byte_len     INTEGER NOT NULL,               -- 解码后字节数(≤ 65536)
      sha256       TEXT NOT NULL,                  -- = ref(冗余留证)
      created_at   TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (ref, seller_id)                 -- per-seller 内容寻址:同字节跨卖家各存一行
    );
    CREATE INDEX IF NOT EXISTS idx_dr_qr_account ON direct_receive_account_qr_images(account_id);
    CREATE TRIGGER IF NOT EXISTS trg_dr_qr_no_update BEFORE UPDATE ON direct_receive_account_qr_images BEGIN SELECT RAISE(ABORT, 'direct_receive_account_qr_images is content-addressed & immutable (UPDATE forbidden)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_dr_qr_no_delete BEFORE DELETE ON direct_receive_account_qr_images BEGIN SELECT RAISE(ABORT, 'direct_receive_account_qr_images is immutable (DELETE forbidden — keep for order snapshots)'); END;

    -- 直付收款账号审计(Phase C):append-only,记事件+account/qr ref,【绝不】写 raw instruction / raw QR。
    CREATE TABLE IF NOT EXISTS direct_receive_account_events (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL,
      seller_id    TEXT NOT NULL,
      event_type   TEXT NOT NULL,                  -- account_added | account_updated | account_deactivated | qr_uploaded
      qr_ref       TEXT,                           -- qr 事件时的 ref(= sha256);非 qr 事件为 NULL。绝无 raw 内容
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dr_acct_events_account ON direct_receive_account_events(account_id);
    CREATE TRIGGER IF NOT EXISTS trg_dr_acct_events_no_update BEFORE UPDATE ON direct_receive_account_events BEGIN SELECT RAISE(ABORT, 'direct_receive_account_events is append-only (UPDATE forbidden)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_dr_acct_events_no_delete BEFORE DELETE ON direct_receive_account_events BEGIN SELECT RAISE(ABORT, 'direct_receive_account_events is append-only (DELETE forbidden)'); END;

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

    -- 【按产品】外部平台商品认证(per-product verification)。降低作弊:一次验证【绝不】默认放行该卖家所有产品 ——
    -- 每个要走直付收款的产品都必须【单独】被真人 admin 手动核验通过(硬门:未验证产品 direct-pay 不可用,退回托管)。
    -- 诚实边界:WebAZ【绝不】抓取 external_url(无 SSRF、无"WebAZ 已核验该商品/店铺真实性"超claim)。机制 = 卖家为【该产品】
    -- 申领 code → 展示在其外部平台商品页 → 提交该产品链接 → 真人 admin 手动打开核对 → attest。记录的最弱准确事实 =
    -- "admin <id> 于 <时间> 手动确认产品 <product_id> 在 <url> 展示了验证码 <code>"。状态:issued→submitted→verified|rejected。
    CREATE TABLE IF NOT EXISTS product_verifications (
      id            TEXT PRIMARY KEY,
      product_id    TEXT NOT NULL REFERENCES products(id),
      seller_id     TEXT NOT NULL REFERENCES users(id),
      code          TEXT NOT NULL,                       -- WebAZ 签发、卖家需展示在【该产品】外部页的验证码
      platform      TEXT,                                -- 卖家自填的平台名(展示用,不校验)
      external_url  TEXT,                                -- 卖家提交的该产品外部链接(仅存,WebAZ 不抓取)
      status        TEXT NOT NULL DEFAULT 'issued',      -- issued|submitted|verified|rejected
      reviewed_by   TEXT REFERENCES users(id),           -- 真人 admin(手动核对者)
      reviewed_at   TEXT,
      notes         TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_product_verifications_product ON product_verifications(product_id, status);
    CREATE INDEX IF NOT EXISTS idx_product_verifications_seller ON product_verifications(seller_id, status);

    -- 【按卖家】店铺认证(store verification)= 逐品验证的【豁免】路径。卖家申请一次店铺(发码→贴外部店铺页→提交店铺链接),
    -- 真人 admin 手动核对时【勾选 per_product_exempt】:置 1 = 该卖家所有商品免逐品验证、可直付;置 0(默认)= 仍需逐品验证。
    -- 诚实边界同 product_verifications:WebAZ 绝不抓取 external_url(无 SSRF/无超claim),只存链接+码+真人 attest。单一活跃 per seller。
    CREATE TABLE IF NOT EXISTS store_verifications (
      id                 TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL REFERENCES users(id),
      code               TEXT NOT NULL,
      platform           TEXT,
      external_url       TEXT,
      status             TEXT NOT NULL DEFAULT 'issued',   -- issued|submitted|verified|rejected
      per_product_exempt INTEGER NOT NULL DEFAULT 0,       -- 1 = 该卖家免逐品验证(admin 核店铺时勾选);0 = 仍需逐品
      reviewed_by        TEXT REFERENCES users(id),
      reviewed_at        TEXT,
      notes              TEXT,
      created_at         TEXT DEFAULT (datetime('now')),
      updated_at         TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_store_verifications_user ON store_verifications(user_id, status);

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

    -- ─────────────────────────────────────────────────────────────────────────
    -- Direct Pay 平台费【链下应收(AR)】(设计稿 DIRECT-PAY-FEE-RECEIVABLE-DESIGN.INTERNAL.md)
    -- 替代逐单 WAZ 质押:完成时记真实 USDC 应收,月结开票/人工收/欠费暂停资格。
    -- v1 单一计价币 = USDC。append-only:原始事实行不改,变更走 adjustments / events。
    -- PR-1 = 纯建表 + 读 helper,零行为接线(建单门/accrue/cron/UI 在 PR-2+)。
    -- ─────────────────────────────────────────────────────────────────────────

    -- 月结发票(有 status;每次状态变更必写 invoice_events)。【先于 receivables 建:后者 invoice_id 引用它】。
    CREATE TABLE IF NOT EXISTS direct_pay_fee_invoices (
      id            TEXT PRIMARY KEY,
      seller_id     TEXT NOT NULL REFERENCES users(id),
      period_start  TEXT NOT NULL,
      period_end    TEXT NOT NULL,
      total_amount  REAL NOT NULL CHECK (total_amount >= 0),
      currency      TEXT NOT NULL DEFAULT 'usdc' CHECK (currency = 'usdc'),
      due_date      TEXT NOT NULL,                 -- = period_end + net 15d(D9)
      status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','overdue','void')),
      created_at    TEXT DEFAULT (datetime('now')),
      created_by    TEXT,                          -- 'cron' 或 admin user_id
      paid_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dp_fee_invoices_seller ON direct_pay_fee_invoices(seller_id, status);

    -- 逐单应收 = 完成时赚的一笔平台费(原始 accrual 事实行,IMMUTABLE:行一旦写入永不改)。
    -- ⚠️ 不含 invoice_id:入票关联走独立 append-only 表 direct_pay_fee_invoice_items(避免回填 UPDATE 破坏不可变)。
    CREATE TABLE IF NOT EXISTS direct_pay_fee_receivables (
      id          TEXT PRIMARY KEY,
      order_id    TEXT NOT NULL REFERENCES orders(id),
      seller_id   TEXT NOT NULL REFERENCES users(id),
      amount      REAL NOT NULL CHECK (amount >= 0),  -- 该单平台费(USDC 计价小数;units 经 money.ts 边界)
      currency    TEXT NOT NULL DEFAULT 'usdc' CHECK (currency = 'usdc'),  -- v1 单币;v2 放开
      accrued_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dp_fee_receivables_seller ON direct_pay_fee_receivables(seller_id);

    -- 应收 ↔ 发票分摊(append-only 关联行;月结开票时写,不回填/不改 receivables)。UNIQUE(receivable_id) 防重复入票。
    CREATE TABLE IF NOT EXISTS direct_pay_fee_invoice_items (
      id            TEXT PRIMARY KEY,
      invoice_id    TEXT NOT NULL REFERENCES direct_pay_fee_invoices(id),
      receivable_id TEXT NOT NULL REFERENCES direct_pay_fee_receivables(id),
      amount        REAL NOT NULL CHECK (amount >= 0),  -- 入票金额(= 该 receivable 计入本发票的额)
      created_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(receivable_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dp_fee_invoice_items_invoice ON direct_pay_fee_invoice_items(invoice_id);

    -- 冲销 / 坏账核销 / 手工冲正(独立 append-only 行;原始 accrual 行不动)。
    CREATE TABLE IF NOT EXISTS direct_pay_fee_adjustments (
      id            TEXT PRIMARY KEY,
      receivable_id TEXT REFERENCES direct_pay_fee_receivables(id),  -- nullable(整体冲正可不挂单)
      seller_id     TEXT NOT NULL REFERENCES users(id),
      delta_amount  REAL NOT NULL,                 -- 带符号(退货冲销=负)
      currency      TEXT NOT NULL DEFAULT 'usdc' CHECK (currency = 'usdc'),
      kind          TEXT NOT NULL CHECK (kind IN ('reversal','write_off','correction')),
      reason        TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      created_by    TEXT REFERENCES users(id)      -- admin(人工铁律)
    );
    CREATE INDEX IF NOT EXISTS idx_dp_fee_adjustments_seller ON direct_pay_fee_adjustments(seller_id);

    -- 发票状态变更审计(append-only)。
    CREATE TABLE IF NOT EXISTS direct_pay_fee_invoice_events (
      id          TEXT PRIMARY KEY,
      invoice_id  TEXT NOT NULL REFERENCES direct_pay_fee_invoices(id),
      from_status TEXT,
      to_status   TEXT NOT NULL,
      actor       TEXT,                            -- 'cron' 或 admin user_id
      reason      TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dp_fee_invoice_events_invoice ON direct_pay_fee_invoice_events(invoice_id);

    -- 商家平台服务费【收款/预付款】事实行(append-only,IMMUTABLE)。当前模型 = 首单宽限 + 预充值续用:
    --   每行 = admin 记录的一笔商家平台服务费预付款(USDC/法币);invoice_id IS NULL = 【未分配预充值】=
    --   计入 available_prepay。(invoice_id 非空属早先月结模型预留,本模型不生成发票,故恒 NULL。)
    --   ⚠️ 是【商家平台服务费预付款】,非买家 escrow / 非保证金 / 非 penalty。本轮无"余额退款"实功能。
    CREATE TABLE IF NOT EXISTS direct_pay_fee_payments (
      id          TEXT PRIMARY KEY,
      seller_id   TEXT NOT NULL REFERENCES users(id),
      invoice_id  TEXT REFERENCES direct_pay_fee_invoices(id),
      amount      REAL NOT NULL CHECK (amount >= 0),
      currency    TEXT NOT NULL DEFAULT 'usdc' CHECK (currency = 'usdc'),
      method      TEXT NOT NULL CHECK (method IN ('usdc','fiat')),
      received_at TEXT DEFAULT (datetime('now')),
      recorded_by TEXT REFERENCES users(id),       -- admin(Passkey + purpose-bound)
      evidence_ref TEXT,
      note        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dp_fee_payments_seller ON direct_pay_fee_payments(seller_id);

    -- 平台服务费【预充值申请】(卖家发起 → admin 核实真实到账后确认入账)。留痕:凭据必填、状态流转、关联入账 payment。
    --   ⚠️ 申请【不动钱】—— 只有 admin 确认(PR3)才调 recordFeePrepay 记入余额。amount_units = base units(1 WAZ=1e6)。
    --   platform_account_id = 付给哪个平台收款方式(见 platform_receive_accounts)。杜绝"场外直接付、无据可查"。
    CREATE TABLE IF NOT EXISTS direct_pay_fee_prepay_requests (
      id                   TEXT PRIMARY KEY,
      seller_id            TEXT NOT NULL REFERENCES users(id),
      amount_units         INTEGER NOT NULL,          -- 申请充值额(base units)
      currency             TEXT,                      -- 卖家声明的付款币种(展示;以实际到账为准)
      platform_account_id  TEXT NOT NULL REFERENCES platform_receive_accounts(id),  -- 付给哪个平台收款方式(必选;admin 据此核对到账来源)
      evidence_ref         TEXT NOT NULL,             -- 付款凭证号/流水(必填 —— 不能无据)
      evidence_note        TEXT,
      status               TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | cancelled
      created_at           TEXT DEFAULT (datetime('now')),
      reviewed_by          TEXT REFERENCES users(id), -- admin(PR3 approve/reject 时填,Passkey)
      reviewed_at          TEXT,
      review_note          TEXT,
      resulting_payment_id TEXT REFERENCES direct_pay_fee_payments(id)   -- approve 时关联的入账记录
    );
    CREATE INDEX IF NOT EXISTS idx_dp_fee_prepay_req_seller ON direct_pay_fee_prepay_requests(seller_id, status);

    -- ⏸ DORMANT(早先"AR 信用上限"模型预留;当前 = 首单宽限 + 预充值续用,额度即商家实际预付余额,无固定上限)。
    --   本表与 ceiling_requests/invoices/invoice_items/invoice_events 当前【不写不读】;保留待将来需要时复用或清理。
    CREATE TABLE IF NOT EXISTS direct_pay_fee_ar_seller_overrides (
      seller_id     TEXT PRIMARY KEY REFERENCES users(id),
      ceiling_units INTEGER NOT NULL CHECK (ceiling_units >= 0),  -- 该商家未付 AR 上限(整数 base-units;0=封锁)
      updated_by    TEXT REFERENCES users(id),     -- admin
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    -- 商家【申请】调高未付 AR 上限 → ROOT/admin 真人 Passkey 审批(approve 即写 override)。
    -- 商家不能自调,只能申请;append-only 审计。模式同仓内 build-task 配额申请。
    CREATE TABLE IF NOT EXISTS direct_pay_fee_ceiling_requests (
      id              TEXT PRIMARY KEY,
      seller_id       TEXT NOT NULL REFERENCES users(id),
      requested_units INTEGER NOT NULL CHECK (requested_units >= 0),  -- 申请目标上限(整数 base-units)
      effective_units_at_request INTEGER CHECK (effective_units_at_request >= 0),  -- 申请时生效上限快照(审计用)
      reason          TEXT,
      status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      created_at      TEXT DEFAULT (datetime('now')),
      reviewed_by     TEXT REFERENCES users(id),   -- admin
      reviewed_at     TEXT,
      decision_note   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dp_fee_ceiling_requests_seller ON direct_pay_fee_ceiling_requests(seller_id, status);

    -- 商家平台服务费【预充值余额退款】事实行(append-only,IMMUTABLE)。= WebAZ 把已预付未消耗的平台服务费余额
    --   退还给商家(链下真实退款,记 evidence_ref)。available_prepay 减去 Σ refunds。amount>0(退款额,正)。
    --   ⚠️ 退的是【商家平台服务费预付款】,非买家货款/escrow/保证金/penalty。与 adjustments.correction(账务更正)区分:
    --   refund = 真实退钱;correction = 记账更正(不一定动真钱)。退款额 ≤ 当前 available(不可退已被费用消耗的部分,由 helper 校验)。
    CREATE TABLE IF NOT EXISTS direct_pay_fee_prepay_refunds (
      id           TEXT PRIMARY KEY,
      seller_id    TEXT NOT NULL REFERENCES users(id),
      amount       REAL NOT NULL CHECK (amount >= 0),
      currency     TEXT NOT NULL DEFAULT 'usdc' CHECK (currency = 'usdc'),
      method       TEXT NOT NULL CHECK (method IN ('usdc','fiat')),
      evidence_ref TEXT,
      reason       TEXT,
      recorded_by  TEXT REFERENCES users(id),      -- admin(Passkey + purpose-bound)
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dp_fee_prepay_refunds_seller ON direct_pay_fee_prepay_refunds(seller_id);

    -- ── APPEND-ONLY 硬强制(DB 级,非仅注释)── money-adjacent fee 账本的事实/事件行不可改/删。
    -- 6 张:receivables(immutable accrual)/ invoice_items(写一次)/ adjustments / invoice_events / payments(immutable)/ prepay_refunds(immutable)。
    -- invoices/overrides/ceiling_requests 刻意【不】锁(有合法状态/值变更)。PG 等价 plpgsql guard 由 gen-pg-schema 的 APPEND_ONLY_TABLES 生成。
    CREATE TRIGGER IF NOT EXISTS trg_dp_fee_receivables_no_update BEFORE UPDATE ON direct_pay_fee_receivables BEGIN SELECT RAISE(ABORT, 'direct_pay_fee_receivables is append-only (UPDATE forbidden)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_dp_fee_receivables_no_delete BEFORE DELETE ON direct_pay_fee_receivables BEGIN SELECT RAISE(ABORT, 'direct_pay_fee_receivables is append-only (DELETE forbidden)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_dp_fee_invoice_items_no_update BEFORE UPDATE ON direct_pay_fee_invoice_items BEGIN SELECT RAISE(ABORT, 'direct_pay_fee_invoice_items is append-only (UPDATE forbidden)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_dp_fee_invoice_items_no_delete BEFORE DELETE ON direct_pay_fee_invoice_items BEGIN SELECT RAISE(ABORT, 'direct_pay_fee_invoice_items is append-only (DELETE forbidden)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_dp_fee_adjustments_no_update BEFORE UPDATE ON direct_pay_fee_adjustments BEGIN SELECT RAISE(ABORT, 'direct_pay_fee_adjustments is append-only (UPDATE forbidden)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_dp_fee_adjustments_no_delete BEFORE DELETE ON direct_pay_fee_adjustments BEGIN SELECT RAISE(ABORT, 'direct_pay_fee_adjustments is append-only (DELETE forbidden)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_dp_fee_invoice_events_no_update BEFORE UPDATE ON direct_pay_fee_invoice_events BEGIN SELECT RAISE(ABORT, 'direct_pay_fee_invoice_events is append-only (UPDATE forbidden)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_dp_fee_invoice_events_no_delete BEFORE DELETE ON direct_pay_fee_invoice_events BEGIN SELECT RAISE(ABORT, 'direct_pay_fee_invoice_events is append-only (DELETE forbidden)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_dp_fee_payments_no_update BEFORE UPDATE ON direct_pay_fee_payments BEGIN SELECT RAISE(ABORT, 'direct_pay_fee_payments is append-only (UPDATE forbidden)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_dp_fee_payments_no_delete BEFORE DELETE ON direct_pay_fee_payments BEGIN SELECT RAISE(ABORT, 'direct_pay_fee_payments is append-only (DELETE forbidden)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_dp_fee_prepay_refunds_no_update BEFORE UPDATE ON direct_pay_fee_prepay_refunds BEGIN SELECT RAISE(ABORT, 'direct_pay_fee_prepay_refunds is append-only (UPDATE forbidden)'); END;
    CREATE TRIGGER IF NOT EXISTS trg_dp_fee_prepay_refunds_no_delete BEFORE DELETE ON direct_pay_fee_prepay_refunds BEGIN SELECT RAISE(ABORT, 'direct_pay_fee_prepay_refunds is append-only (DELETE forbidden)'); END;

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
      -- PR-6A: expires_at 由 ALTER 补(见迁移段);制裁结论有有效期,过期视作未通过(fail-closed)。
    );

    -- PR-6A: Direct Pay KYB(商户尽调)复核台账。Direct Pay AML/KYB fail-closed runtime —— 无第三方 vendor、无真实
    -- API 调用,仅记录【真人/合规复核结论】。fail-closed:missing/pending/rejected/revoked/expired 一律不通过,
    -- 只有 approved 且未过期(且无 rejected/revoked)才算 KYB 通过。本表无生产写入方 → 真实卖家天然 fail-closed。
    CREATE TABLE IF NOT EXISTS direct_receive_kyb_reviews (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id),
      status      TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | revoked
      reviewed_by TEXT,                             -- 复核人(真人/合规);无第三方集成
      reviewed_at TEXT,
      expires_at  TEXT,                             -- 复核有效期;过期视作未通过
      reason      TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
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

    -- ── Merchant Base-Bond (v1 collateral-only) — PR1 testnet/dev scaffold。链上为真相,这两张表只是【DB 镜像/缓存】(见 docs/modules/MERCHANT-BASE-BOND-DESIGN.INTERNAL.md §4.1)。
    -- v1 默认关闭、不接 mainnet、不收真钱、live 路径不读写 → 对现有 Direct Pay 零影响。
    CREATE TABLE IF NOT EXISTS merchant_bond_wallets (
      seller_id     TEXT PRIMARY KEY REFERENCES users(id),
      wallet        TEXT NOT NULL,                 -- registeredBondWallet(链上地址);seller_id ↔ wallet 唯一
      chain_id      INTEGER NOT NULL,              -- v1 = Base
      rotated_at    TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(wallet)
    );
    CREATE TABLE IF NOT EXISTS merchant_bond_deposits (
      id               TEXT PRIMARY KEY,
      seller_id        TEXT NOT NULL REFERENCES users(id),
      wallet           TEXT NOT NULL,
      tx_hash          TEXT,
      collateral_units TEXT NOT NULL DEFAULT '0',  -- USDC integer units(字符串,big-int 安全)
      status           TEXT NOT NULL DEFAULT 'pending_confirmations', -- none|pending_confirmations|active|cooling|withdrawable|withdrawn|slashed_below_min(§4 状态机)
      confirmations    INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT DEFAULT (datetime('now')),
      updated_at       TEXT DEFAULT (datetime('now'))
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
  try { db.exec(`ALTER TABLE orders ADD COLUMN payment_query_deadline TEXT`) } catch { /* 已存在 */ } // Rail1 货款协商:卖家报未收款后买家响应宽限(过期→卖家可请求取消)
  try { db.exec(`ALTER TABLE orders ADD COLUMN payment_query_cancel_deadline TEXT`) } catch { /* 已存在 */ } // Rail1 货款协商:卖家请求取消后买家 7 天申诉窗(过期→cron 关单;窗内买家可升举证仲裁)
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_instruction_snapshot TEXT`) } catch { /* 已存在 */ } // Rail1 4c:下单时快照卖家收款说明(冻结买家所见;卖家事后改/停用不影响)
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_account_snapshot TEXT`) } catch { /* 已存在 */ } // Rail1 D2:买家所选收款账号快照 JSON {account_id,method,currency,label,qr_ref}(非敏感元数据;instruction 原文仍在 direct_pay_instruction_snapshot 受披露门;qr_ref 的图字节走 ack 门端点)
  // PR-5b-0: direct_p2p 入口控制 policy 快照列(既有库补列;additive nullable,本 PR 无写入方,5b wiring 才写)。
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_enabled_snapshot INTEGER`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_rail_breaker_snapshot INTEGER`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_region_snapshot TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_region_allowlist_snapshot TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_per_tx_cap_units_snapshot INTEGER`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_seller_breaker_snapshot INTEGER`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN direct_pay_decision_code TEXT`) } catch { /* 已存在 */ }
  // 手动接单模式(v16):卖家可选 auto/manual(单品覆盖 ?? 店铺默认 ?? auto);manual 直付单先进 pending_accept。
  try { db.exec(`ALTER TABLE products ADD COLUMN accept_mode TEXT`) } catch { /* 已存在 */ }               // 'auto'|'manual'|NULL(=继承店铺默认)
  try { db.exec(`ALTER TABLE users ADD COLUMN store_accept_mode TEXT`) } catch { /* 已存在 */ }            // 店铺级默认 'auto'|'manual'|NULL(=auto)
  try { db.exec(`ALTER TABLE orders ADD COLUMN accept_mode_snapshot TEXT`) } catch { /* 已存在 */ }        // 下单时快照(卖家事后改不影响在途单)
  try { db.exec(`ALTER TABLE orders ADD COLUMN pending_accept_deadline TEXT`) } catch { /* 已存在 */ }     // 接单窗(专属 cron 读;超时无责取消+回补库存)
  // 运费模板(PR-2):按收货地区预设运费/时效;下单命中 → 运费并入总额并快照(卖家改模板不影响在途单)。
  try { db.exec(`ALTER TABLE products ADD COLUMN shipping_template TEXT`) } catch { /* 已存在 */ }         // JSON [{region,fee,est_days}];NULL=继承店铺默认
  try { db.exec(`ALTER TABLE users ADD COLUMN store_shipping_template TEXT`) } catch { /* 已存在 */ }      // 店铺级默认模板
  try { db.exec(`ALTER TABLE orders ADD COLUMN ship_to_region TEXT`) } catch { /* 已存在 */ }              // 买家下单所选收货地区(结构化,非自由文本地址)
  try { db.exec(`ALTER TABLE orders ADD COLUMN shipping_fee DECIMAL(18,2)`) } catch { /* 已存在 */ }       // 下单快照运费(已并入 total_amount;NULL=无模板旧单)
  try { db.exec(`ALTER TABLE orders ADD COLUMN shipping_est_days TEXT`) } catch { /* 已存在 */ }           // 下单快照预计时效(展示;不接判责钟)—— logistics_eta 口径(运费模板;非承诺)
  try { db.exec(`ALTER TABLE orders ADD COLUMN promised_eta_snapshot TEXT`) } catch { /* 已存在 */ }       // BUG-02:下单时向买家承诺的配送估计快照 JSON(promised_eta;从 quote 冻结继承;卖家改 listing 不影响;历史单=NULL,展示"下单时未记录")
  // 询价握手(PR-3,直付轨):模板外地区先报价后接单。quote_ok=卖家 opt-in(单品??店铺,默认关)。
  try { db.exec(`ALTER TABLE products ADD COLUMN shipping_quote_ok INTEGER`) } catch { /* 已存在 */ }      // 1|0|NULL(=继承店铺)
  try { db.exec(`ALTER TABLE users ADD COLUMN store_shipping_quote_ok INTEGER`) } catch { /* 已存在 */ }   // 店铺级默认(NULL=关)
  try { db.exec(`ALTER TABLE orders ADD COLUMN shipping_quote_required INTEGER`) } catch { /* 已存在 */ }  // 1=本单须先报价(pending_accept 内子流)
  try { db.exec(`ALTER TABLE orders ADD COLUMN shipping_quote_fee DECIMAL(18,2)`) } catch { /* 已存在 */ } // 卖家报价运费(买家确认后并入 total_amount)
  try { db.exec(`ALTER TABLE orders ADD COLUMN shipping_quote_est_days TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN shipping_quote_note TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN shipping_quote_at TEXT`) } catch { /* 已存在 */ }
  // PR-B(undeliverable/拒收收口):证据裁决 + fault-neutral。两截止列均存 ISO(与 #299 归一化一致)。
  //   delivery_failed_deadline = 买家争议窗口锚(delivery_failed→fault_buyer 的 X 窗口,default 120h)。
  //   goods_return_deadline    = escrow 下卖家确认收货窗口锚(Guardrail B2:超时未确认→默认退买家)。
  try { db.exec(`ALTER TABLE orders ADD COLUMN delivery_failed_deadline TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN goods_return_deadline TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN return_shipping_actual DECIMAL(18,2)`) } catch { /* 已存在 */ }   // PR-B3b:卖家申报的实际退程运费【原始值】(审计/争议记录;结算用 clamp 后值,可由本值+帽复算)
  // PR-B params:seed 于此(非 server.ts DEFAULT_PARAMS)—— server.ts 已达 LOC 天花板(ratchet,不可加行)。
  //   protocol_params 形状与 server.ts:790 一致(均 IF NOT EXISTS / INSERT OR IGNORE,幂等共存,防漂移见该处)。
  //   硬上限走 max_value(Guardrail A:restocking ≤15%)。运行时另在结算处 clamp 兜底(DB 值异常也不越界)。
  db.exec(`CREATE TABLE IF NOT EXISTS protocol_params (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, type TEXT NOT NULL, description TEXT,
    category TEXT DEFAULT 'general', default_value TEXT, min_value REAL, max_value REAL,
    updated_at TEXT DEFAULT (datetime('now')), updated_by TEXT
  )`)
  for (const p of [
    { key: 'undeliverable_closure_enabled', value: '0', type: 'number', desc: 'PR-B rollout flag:undeliverable/拒收收口分阶段启用;默认 0=关(旧 fault_logistics 路径不变)。', cat: 'system', min: 0, max: 1 },
    { key: 'restocking_fee_rate', value: '0.10', type: 'number', desc: 'PR-B escrow 买家责任收口的 restocking 费率(基于 price 不含运费)。硬上限 15%(Guardrail A,防满额没收绕回全额)。', cat: 'fee', min: 0, max: 0.15 },
    { key: 'return_shipping_max_rate', value: '0.20', type: 'number', desc: 'PR-B 卖家申报实际退程运费的上限(占 total 比例,防灌水);实际值随 return-tracking 提交并 clamp 至此。', cat: 'fee', min: 0, max: 0.30 },
    { key: 'undeliverable_contest_window_hours', value: '120', type: 'number', desc: 'PR-B delivery_failed→fault_buyer 的买家争议窗口(小时,X=120,锚 delivery_failed 时刻)。', cat: 'limit', min: 0, max: 336 },
    { key: 'goods_return_confirm_window_hours', value: '120', type: 'number', desc: 'PR-B(Guardrail B2)escrow 卖家确认收货窗口(小时);超时未确认→默认退买家。', cat: 'limit', min: 0, max: 336 },
  ]) {
    try { db.prepare(`INSERT OR IGNORE INTO protocol_params (key, value, type, description, category, default_value, min_value, max_value) VALUES (?,?,?,?,?,?,?,?)`)
      .run(p.key, p.value, p.type, p.desc, p.cat, p.value, p.min, p.max) } catch { /* 已存在 */ }
    try { db.prepare(`UPDATE protocol_params SET min_value = COALESCE(min_value, ?), max_value = COALESCE(max_value, ?) WHERE key = ?`).run(p.min, p.max, p.key) } catch {}
  }
  // 跨境交易条款骨架(S0):清关/物流证据字段(即时开放,展示+快照证据,零计费逻辑=守 ERP 边界)+
  //   结构化规则列(sale_regions/tax_lines/import_duty_terms 先建列【不开 API】—— 不上假开关:S1 带可售 gate、
  //   S3 带税费明细进 total 时才各自开放;既有 ship_regions 是自由文本仅展示,真相源=这些结构化列)。
  try { db.exec(`ALTER TABLE products ADD COLUMN weight_kg REAL`) } catch { /* 已存在 */ }                 // 重量(S0 起 products-update 也写此列 → 收进 base schema,不再只靠 server.ts 迁移;裸 init 路径一致有列)
  try { db.exec(`ALTER TABLE products ADD COLUMN package_size TEXT`) } catch { /* 已存在 */ }              // 长x宽x高 cm 文本(证据/报价参考)
  try { db.exec(`ALTER TABLE products ADD COLUMN origin_country TEXT`) } catch { /* 已存在 */ }            // 发货国(ISO 区码)
  try { db.exec(`ALTER TABLE products ADD COLUMN country_of_origin TEXT`) } catch { /* 已存在 */ }         // 原产国(清关申报)
  try { db.exec(`ALTER TABLE products ADD COLUMN customs_description TEXT`) } catch { /* 已存在 */ }       // 报关品名(英文)
  try { db.exec(`ALTER TABLE products ADD COLUMN hs_code TEXT`) } catch { /* 已存在 */ }                   // HS 编码(可选)
  try { db.exec(`ALTER TABLE products ADD COLUMN sale_regions TEXT`) } catch { /* 已存在 */ }              // S1 gate 消费:{mode,include,exclude} JSON(NULL=继承店铺)
  try { db.exec(`ALTER TABLE products ADD COLUMN tax_lines TEXT`) } catch { /* 已存在 */ }                 // S3 消费:按目的区税费科目 JSON(NULL=继承店铺)
  try { db.exec(`ALTER TABLE products ADD COLUMN import_duty_terms TEXT`) } catch { /* 已存在 */ }         // 'ddu'|'ddp'|NULL(=继承店铺;跨境进口税责声明)
  try { db.exec(`ALTER TABLE users ADD COLUMN store_sale_regions TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN store_tax_lines TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN store_import_duty_terms TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE orders ADD COLUMN trade_terms_snapshot TEXT`) } catch { /* 已存在 */ }        // 下单冻结的交易条款 JSON(运费来源/时效/退货/清关字段/税责声明;商家事后改设置不影响旧订单,争议依据)
  // 营销域满额免邮(S2 返工:从运费模板移出 —— 模板=成本结构,免邮=促销;供应商报价期规则不搬家)
  try { db.exec(`ALTER TABLE products ADD COLUMN free_shipping_threshold DECIMAL(18,2)`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN store_free_shipping_threshold DECIMAL(18,2)`) } catch { /* 已存在 */ }
  // ── 商品【非钱路】扩展列收敛到 base(测试 schema 初始化单一来源;与 weight_kg S4 同法)──
  //   products-create/update/read 写这些属性/溯源/物流/退货/i18n/库存/信誉计数列;历史上只在 server.ts 迁移段(或 MCP register-list-search 助手),
  //   裸 initDatabase / bridge / 测试缺列 → 各测试各自手动补 ALTER(band-aid)。收进 base 后每条 init 路径一致有列,band-aid 可删。
  //   server.ts 内联迁移【保留不动】(byte-identical guarded ALTER,生产迁移序不变;非 wholesale 抽取,不碰钱/单/状态迁移)。
  //   刻意排除:commission_rate(佣金=钱路,不进);stake_amount / images 已在 CREATE TABLE products。
  for (const col of [
    'specs TEXT', 'brand TEXT', 'model TEXT', 'source_price REAL', 'ship_regions TEXT DEFAULT "全国"',          // 属性 + 溯源参考 + 既有自由文本运费地区
    'handling_hours INTEGER DEFAULT 24', 'estimated_days TEXT', 'fragile INTEGER DEFAULT 0',                    // 履约:处理时长/预计时效/易碎
    'return_days INTEGER DEFAULT 7', 'return_condition TEXT', 'warranty_days INTEGER DEFAULT 0',                // 退货/保修承诺
    'source_url TEXT', 'source_price_at TEXT',                                                                 // 溯源链接 + 采价时间
    'commitment_hash TEXT', 'description_hash TEXT', 'price_hash TEXT', 'hashed_at TEXT',                       // 承诺哈希(内容/描述/价格),非价格数值本身
    'origin_claims TEXT', 'i18n_titles TEXT', 'i18n_descs TEXT', `product_type TEXT DEFAULT 'retail'`, 'has_variants INTEGER DEFAULT 0',  // 声明/多语言/分型
    'last_sold_at TEXT', 'first_sold_at TEXT',                                                                 // 销售生命周期时间戳(展示/排序)
    'completion_count INTEGER DEFAULT 0', 'dispute_loss_count INTEGER DEFAULT 0', 'claim_loss_count INTEGER DEFAULT 0', 'value_badge INTEGER DEFAULT 0',  // 信誉/价值计数(纯列,不含状态机/结算逻辑)
    'low_stock_threshold INTEGER DEFAULT 3', 'auto_delist_on_zero INTEGER DEFAULT 1', 'low_stock_alerted_at TEXT',  // 低库存提醒/自动下架(库存运营)
  ]) { try { db.exec(`ALTER TABLE products ADD COLUMN ${col}`) } catch { /* 已存在 */ } }
  try { db.exec(`ALTER TABLE wallets ADD COLUMN fee_staked REAL DEFAULT 0`) } catch { /* 已存在 */ }
  // PR-4b-1: direct_receive_deposits 生产收款 provenance 快照列(既有库补列;additive nullable,无写入方,无 flow 启用)。
  try { db.exec(`ALTER TABLE direct_receive_deposits ADD COLUMN production_receipt_ref TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE direct_receive_deposits ADD COLUMN production_rail_id TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE direct_receive_deposits ADD COLUMN production_jurisdiction TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE direct_receive_deposits ADD COLUMN production_policy_version TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE direct_receive_deposits ADD COLUMN reject_note TEXT`) } catch { /* 已存在 */ }   // B1:admin 驳回申报说明(卖家可见)
  try { db.exec(`ALTER TABLE direct_receive_deposits ADD COLUMN refund_requested_at TEXT`) } catch { /* 已存在 */ }   // B2:退出申请时间(冷静期锚点)
  try { db.exec(`ALTER TABLE direct_receive_deposits ADD COLUMN refund_evidence_ref TEXT`) } catch { /* 已存在 */ }   // B2:场外退还凭据(admin 执行时记录)
  try { db.exec(`ALTER TABLE direct_receive_deposits ADD COLUMN terms_version TEXT`) } catch { /* 已存在 */ }         // 条款同意版本快照(缴纳前强制同意;罚没/退还的合同依据)
  try { db.exec(`ALTER TABLE direct_receive_deposits ADD COLUMN platform_account_id TEXT`) } catch { /* 已存在 */ }   // 缴到哪个平台收款账户(多币种;币种由账户推导)
  // B3:保证金罚没提案(人工铁律:仲裁裁定卖家责的直付争议 → admin 提案 → 冷静期 → ROOT+Passkey 执行;绝不自动)。
  db.exec(`
    CREATE TABLE IF NOT EXISTS bond_slash_proposals (
      id            TEXT PRIMARY KEY,
      deposit_id    TEXT NOT NULL,
      seller_id     TEXT NOT NULL,
      dispute_id    TEXT NOT NULL,                -- 依据争议(须 resolved 且 ruling ∈ 卖家责;direct_p2p 单)
      reason        TEXT,
      status        TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','executed','cancelled')),
      cooling_until TEXT NOT NULL,                -- 绝对截止(propose 时按 param 计算;执行须晚于此)
      proposed_by   TEXT NOT NULL,
      proposed_at   TEXT DEFAULT (datetime('now')),
      executed_at   TEXT,
      executed_txn_id TEXT,
      cancelled_at  TEXT,
      cancel_note   TEXT
    );
  `)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_bond_slash_seller ON bond_slash_proposals(seller_id, status)') } catch { /* 已存在 */ }
  // B4:缓交收口 —— 到期前提醒去重锚点 + 缴清转正式时间戳(ALTER after CREATE 铁律)。
  try { db.exec(`ALTER TABLE direct_receive_deferrals ADD COLUMN reminder_sent_at TEXT`) } catch { /* 已存在 */ }
  try { db.exec(`ALTER TABLE direct_receive_deferrals ADD COLUMN satisfied_at TEXT`) } catch { /* 已存在 */ }
  // PR-6A: sanctions 结论有有效期(过期 → fail-closed)。additive nullable;NULL = 无期限(不过期)。
  try { db.exec(`ALTER TABLE sanctions_screening ADD COLUMN expires_at TEXT`) } catch { /* 已存在 */ }
  // PR-6D: 支撑 #108 AML 监控的窗口查询(seller_id + payment_rail='direct_p2p' + created_at 范围)。
  //   纯只读索引;不改行为、不打开任何规则。命名随既有 idx_orders_* 风格。
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_direct_pay_seller_window ON orders(seller_id, payment_rail, created_at)`) } catch { /* 已存在 */ }
  // Quote-confirm agent cap:先按 buyer 缩小订单,再以进入付款窗的时间锚定延迟确认订单的 rolling-24h 支出。
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_buyer_created_at ON orders(buyer_id, created_at)`) } catch { /* 已存在 */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_order_history_order_status_created ON order_state_history(order_id, to_status, created_at)`) } catch { /* 已存在 */ }
  // 币种回填(Claim 5 gated):把存量遗留内部代号 'DCP' 一次性刷成 'WAZ'。幂等、可重跑(每次 init 都跑,已是 WAZ 则 0 行);
  //   DCP 与 WAZ 是【同一模拟单位纯改名】,金额不变、无汇率换算;且全仓无 `currency='DCP'` 的筛选逻辑,不破坏任何查询。
  //   fresh-DB 默认已是 WAZ;existing-DB 新建单路径亦显式写 WAZ(见 products-create / MCP list_product / RFQ·auction fulfillment)。
  try { db.exec(`UPDATE products SET currency = 'WAZ' WHERE currency = 'DCP'`) } catch { /* products 表尚未建则跳过 */ }
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
