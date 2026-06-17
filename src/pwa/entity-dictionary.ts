/**
 * RFC-011 §① 实体字典 —— agent 可读的"数据是什么 + 状态机 + 哪些可验证"。
 *   - 状态机:从 transitions.ts 生成(doc=code,零漂移)。
 *   - 字段含义:authored(schema 只有类型);【保守白名单】—— 只列无争议公开字段,
 *     PII(收货地址/recipient_code)与身份/内部字段明确【排除】,全记录走 party-gated /api/orders/:id。
 *     白名单是读边界 + 元规则#3 的安全决策,宁缺勿滥。
 *   coverage/lock 由 tests/test-order-lifecycle-contract.ts 守(每状态有含义 + 每转移序列化 + 无 PII 泄漏)。
 */
import { orderLifecycleContract } from '../layer0-foundation/L0-2-state-machine/transitions.js'
import { SOFTWARE_VERSION, CONTRACT_VERSION } from '../version.js'

// order 实体【保守公开字段】+ 含义。刻意不含 PII / 身份 / 内部结算字段(见 pii_excluded)。
const ORDER_PUBLIC_FIELDS: Array<{ field: string; type: string; meaning: string }> = [
  { field: 'id',                   type: 'string',  meaning: '订单 ID / order id' },
  { field: 'product_id',           type: 'string',  meaning: '商品/二手物品 ID / product (or secondhand item) id' },
  { field: 'status',               type: 'enum',    meaning: '当前状态(见 lifecycle.states)/ current lifecycle state' },
  { field: 'source',               type: 'enum',    meaning: "'shop' | 'secondhand' —— 渠道 / order channel" },
  { field: 'quantity',             type: 'integer', meaning: '数量 / quantity' },
  { field: 'unit_price',           type: 'number',  meaning: '单价(下单快照)/ unit price (order-time snapshot)' },
  { field: 'total_amount',         type: 'number',  meaning: '买家支付总额 / total paid by buyer' },
  { field: 'fulfillment_mode',     type: 'enum',    meaning: "'shipping' | 'in_person' —— 履约方式 / fulfilment mode" },
  { field: 'created_at',           type: 'datetime', meaning: '下单时间 / created' },
  { field: 'updated_at',           type: 'datetime', meaning: '最后更新 / last updated' },
  { field: 'accept_deadline',      type: 'datetime', meaning: '卖家接单截止(超时→fault_seller)/ seller-accept deadline' },
  { field: 'ship_deadline',        type: 'datetime', meaning: '发货截止 / ship deadline' },
  { field: 'delivery_deadline',    type: 'datetime', meaning: '投递截止 / delivery deadline' },
  { field: 'confirm_deadline',     type: 'datetime', meaning: '买家确认截止(超时→自动确认)/ buyer-confirm deadline' },
  { field: 'stake_backing',        type: 'number',  meaning: 'RFC-008 该单赔付背书额(0=起步免赔付)/ per-order stake backing (0 = bootstrap no-payout)' },
  { field: 'decline_reason_code',  type: 'enum',    meaning: 'RFC-007 卖家拒单原因码 / seller decline reason code' },
  { field: 'declined_at',          type: 'datetime', meaning: 'RFC-007 拒单时间 / decline timestamp' },
]

// 明确【不公开】—— 安全/隐私边界声明(让集成方知道这些存在但只对当事人,经 party-gated 端点)
const ORDER_PII_OR_PRIVATE = [
  'shipping_address (PII — 元规则#3)', 'recipient_code (PII)', 'buyer_id / seller_id / logistics_id (party identities — 经 /api/orders/:id 对当事方可见)',
  'escrow_amount / settled_* / commission internals (内部结算)',
]

// product 实体【保守公开字段】—— 买家/agent 选购 + 验证所需,排除内部审核/排序内参。
const PRODUCT_PUBLIC_FIELDS: Array<{ field: string; type: string; meaning: string }> = [
  { field: 'id',                type: 'string',   meaning: '商品 ID (prd_xxx) / product id' },
  { field: 'seller_id',         type: 'string',   meaning: '卖家 ID(公开,店铺主体)/ seller id (public — the shop)' },
  { field: 'title',             type: 'string',   meaning: '标题(按 buyer 语言回落)/ title (localized w/ fallback)' },
  { field: 'description',       type: 'string',   meaning: '描述 / description' },
  { field: 'price',             type: 'number',   meaning: '价格(以 protocol-status 报价币种计)/ price' },
  { field: 'currency',          type: 'string',   meaning: '币种 / currency' },
  { field: 'stock',             type: 'integer',  meaning: '库存(下单 expected_price/stock 守卫见 ②)/ stock' },
  { field: 'category',          type: 'string',   meaning: '类目 / category' },
  { field: 'images',            type: 'json',     meaning: '图片路径数组 / image paths (JSON array)' },
  { field: 'specs',             type: 'json',     meaning: '规格键值 / spec key-values' },
  { field: 'estimated_days',    type: 'json',     meaning: '预计时效 / estimated fulfilment days' },
  { field: 'commission_rate',   type: 'number',   meaning: '分享佣金率(推广方可得)/ promoter commission rate' },
  { field: 'stake_amount',      type: 'number',   meaning: 'RFC-008 卖家为该品质押额(买家保护信号)/ seller stake on this product' },
  { field: 'completion_count',  type: 'integer',  meaning: '累计成交数(社会证明)/ completed sales' },
  { field: 'total_likes',       type: 'integer',  meaning: '点赞数 / likes' },
  { field: 'content_hash',      type: 'string',   meaning: '商品详情 canonical JSON 的 sha256(可验,见 ⑤)/ sha256 of canonical detail (verifiable)' },
  { field: 'content_signature', type: 'string',   meaning: '卖家对 content_hash 的签名(P2P 模式自证)/ seller signature over content_hash' },
  { field: 'status',            type: 'enum',     meaning: "'active' | 'warehouse' | 'deleted' —— 上架状态 / listing status" },
  { field: 'created_at',        type: 'datetime', meaning: '创建 / created' },
  { field: 'updated_at',        type: 'datetime', meaning: '更新 / updated' },
]
const PRODUCT_PRIVATE_OR_INTERNAL = [
  'claim_loss_count (内部审核:声明不实累计,≥3 自动下架)',
  'internal ranking inputs (last_sold_at / unique_sharer_count 等用于排序,非契约字段)',
  'cost / margin (协议不存卖家成本)',
]

// dispute 实体 = 【裁决后公开脱敏版 dispute_cases】(非私域 disputes)。amount 分桶、argument 脱敏、buyer 身份不外露。
const DISPUTE_PUBLIC_FIELDS: Array<{ field: string; type: string; meaning: string }> = [
  { field: 'id',              type: 'string',  meaning: '公开判例 ID (dcase_xxx) / public case id' },
  { field: 'order_id',        type: 'string',  meaning: '关联订单 / order id' },
  { field: 'product_id',      type: 'string',  meaning: '关联商品(按品查判例)/ product id' },
  { field: 'seller_id',       type: 'string',  meaning: '卖家 ID(公开,信誉相关)/ seller id (public)' },
  { field: 'category_tag',    type: 'enum',    meaning: '物流/质量/描述不符/售后/拒收/其他 / dispute category' },
  { field: 'winner',          type: 'enum',    meaning: "'buyer' | 'seller' | 'split' | 'dismissed' —— 裁决结果 / outcome" },
  { field: 'resolution',      type: 'string',  meaning: '简短人读判决(如"全额退款")/ short human-readable resolution' },
  { field: 'amount_bucket',   type: 'enum',    meaning: "'0-100' | '100-500' | '500-2000' | '2000+' —— 金额【分桶】非精确(隐私)/ bucketed amount, not exact" },
  { field: 'buyer_argument',  type: 'string',  meaning: '买家陈述(脱敏)/ buyer statement (redacted)' },
  { field: 'seller_argument', type: 'string',  meaning: '卖家陈述(脱敏)/ seller statement (redacted)' },
  { field: 'ruling_text',     type: 'string',  meaning: '仲裁员判决书(脱敏)/ arbitrator ruling (redacted)' },
  { field: 'fairness_yes',    type: 'integer', meaning: '社区"公正"投票数 / community fairness up-votes' },
  { field: 'fairness_no',     type: 'integer', meaning: '社区"不公"投票数 / fairness down-votes' },
  { field: 'published_at',    type: 'datetime', meaning: '公开发布时间 / published' },
]
const DISPUTE_PRIVATE_OR_INTERNAL = [
  'buyer_id (注释明示"仅内部使用,不外露")',
  'dispute_id (原始 disputes.id,内部追溯)',
  'live case 全文(证据/PII/未脱敏陈述)走 party + arbitrator-gated GET /api/disputes/:id —— dispute_cases 是【裁决后】脱敏快照',
]

export function buildEntityDictionary() {
  return {
    contract_version: CONTRACT_VERSION,
    software_version: SOFTWARE_VERSION,
    note: 'RFC-011 §① machine-readable entity dictionary (order / product / dispute). Order lifecycle is generated from the protocol state machine (doc=code). Field lists are a conservative PUBLIC subset — PII/identity/internal fields are excluded and only reachable by parties via party-gated endpoints. The public "dispute" entity is the redacted post-ruling dispute_cases; the live case is party+arbitrator-gated. Full read access follows the capability matrix (§② /.well-known/webaz-capabilities.json). Intent→action routing: goal index (§① /.well-known/webaz-goals.json).',
    entities: {
      order: {
        kind: 'trade',
        public_fields: ORDER_PUBLIC_FIELDS,
        pii_excluded: ORDER_PII_OR_PRIVATE,
        full_record: 'GET /api/orders/:id (party-gated)',
        lifecycle: orderLifecycleContract(),
        verifiable: {
          state_changes: 'observable via GET /api/agent/events (§⑥), integrity-verifiable via GET /api/orders/:id/chain (§⑤)',
        },
      },
      product: {
        kind: 'listing',
        public_fields: PRODUCT_PUBLIC_FIELDS,
        pii_excluded: PRODUCT_PRIVATE_OR_INTERNAL,
        full_record: 'GET /api/products/:id (public for active listings)',
        list: 'GET /api/search (strict match — see goal index / §② read scope "search")',
        verifiable: {
          detail: 'content_hash = sha256(canonical detail); content_signature = seller signature (P2P self-attestation). See verifiability index (§⑤) external_anchor for real-world ownership/authenticity anchoring.',
        },
      },
      dispute: {
        kind: 'judicial',
        note: 'PUBLIC entity = dispute_cases — the post-ruling, redacted snapshot. The live case (disputes) with full evidence/PII is party + arbitrator-gated.',
        public_fields: DISPUTE_PUBLIC_FIELDS,
        pii_excluded: DISPUTE_PRIVATE_OR_INTERNAL,
        full_record: 'GET /api/disputes/cases/:case_id (public, redacted)',
        list: 'GET /api/disputes/cases · GET /api/disputes/cases/by-product/:product_id',
        live_case: 'GET /api/disputes/:id (party + arbitrator-gated; full evidence, not redacted)',
        lifecycle: 'dispute transitions are part of the order lifecycle (see entities.order.lifecycle: disputed / fault_* / resolved_* / refunded_* states)',
      },
    },
    goal_index: 'GET /.well-known/webaz-goals.json — intent → capability action (§②) + endpoint + MCP tool + PWA page (self-routing).',
  }
}
