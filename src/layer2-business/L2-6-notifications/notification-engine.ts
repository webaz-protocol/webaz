/**
 * L2-6 · 通知系统
 *
 * 每次订单状态变更后调用 notifyTransition()，
 * 自动判断通知哪些参与方，写入 notifications 表。
 * PWA 通过 SSE 实时接收；Agent 通过 dcp_notifications 工具轮询。
 */

import Database from 'better-sqlite3'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 seam(纯读)

// ─── Schema 初始化 ────────────────────────────────────────────

export function initNotificationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id),
      order_id   TEXT REFERENCES orders(id),
      type       TEXT NOT NULL DEFAULT 'system',   -- fresh 库直接带默认:server 的 2026-05-24 重建迁移只在"无默认"时触发,曾在 fresh boot 上重建并吞掉本函数刚 ALTER 的 template_key/params(pg 逐列 parity 抓出)
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      read       INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, created_at DESC);
  `)
  // N1 通知 i18n 架构(审计项 B):template_key + params(JSON)—— 客户端按 viewer locale 用 t() 渲染;
  //   旧行两列为 NULL → 前端回退存量中文 title/body(不 backfill)。ALTER 必须在 CREATE 之后(schema 铁律)。
  try { db.exec('ALTER TABLE notifications ADD COLUMN template_key TEXT') } catch { /* 已有 */ }
  try { db.exec('ALTER TABLE notifications ADD COLUMN params TEXT') } catch { /* 已有 */ }
}

// ─── 类型 ─────────────────────────────────────────────────────

export interface Notification {
  id: string
  user_id: string
  order_id: string | null
  type: string
  title: string
  body: string
  read: number
  created_at: string
  template_key?: string   // N1:客户端 i18n 模板 key(旧行/无模板 = undefined → 回退 title/body)
  params?: string         // N1:模板参数 JSON 串
}

// 实时推送回调（由 PWA server 注入，解耦依赖）
let pushCallback: ((userId: string, notif: Notification) => void) | null = null

export function setPushCallback(cb: (userId: string, notif: Notification) => void) {
  pushCallback = cb
}

// ─── 核心：状态变更 → 通知规则 ───────────────────────────────

interface NotifRule {
  recipients: Array<'buyer' | 'seller' | 'logistics' | 'arbitrators' | 'admins'>
  title: string | ((ctx: OrderCtx) => string)
  body: (ctx: OrderCtx) => string
  // N1 迁移:客户端 i18n 模板 key(app-notif-templates-orders.js 注册表)。落库时连同 params
  //   {buyer,seller,product,amount,logistics} 写入;title/body 仍为中文回退(旧客户端/未知 key)。
  //   函数形式用于 rail fork(direct_p2p 的资金语义与 escrow 不同,key 与回退文案都必须分轨)。
  key: string | ((ctx: OrderCtx) => string)
}

interface OrderCtx {
  buyerName: string
  sellerName: string
  productTitle: string
  totalAmount: number
  orderId: string
  logisticsName?: string
  paymentRail?: string   // direct_p2p(非托管)→ 结算/完成通知不得写 WAZ/资金到账/钱包
}

const RULES: Record<string, NotifRule> = {
  'created→paid': {
    recipients: ['seller'], key: 'ord_created_paid',
    title: '🛍️ 新订单',
    body: ctx => `${ctx.buyerName} 下单了「${ctx.productTitle}」，金额 ${ctx.totalAmount} WAZ。请在 24h 内接单，否则自动退款。`,
  },
  'paid→accepted': {
    recipients: ['buyer'], key: 'ord_paid_accepted',
    title: '✅ 卖家已接单',
    body: ctx => `${ctx.sellerName} 已接受你的订单，预计 5 天内发货。`,
  },
  'paid→cancelled': {
    recipients: ['buyer'], key: 'ord_paid_cancelled',
    title: '❌ 订单已取消',
    body: ctx => `订单「${ctx.productTitle}」已取消，${ctx.totalAmount} WAZ 将原路退回。`,
  },
  'accepted→shipped': {
    recipients: ['buyer'], key: 'ord_accepted_shipped',
    title: '📦 商品已发货',
    body: ctx => `${ctx.sellerName} 已发货，物流 48h 内揽收后你可以追踪包裹。`,
  },
  'shipped→picked_up': {
    recipients: ['buyer', 'seller'], key: 'ord_shipped_picked_up',
    title: '🚚 物流已揽收',
    body: ctx => `包裹已由${ctx.logisticsName ?? '物流方'}揽收，正在运输中。`,
  },
  'picked_up→in_transit': {
    recipients: ['buyer'], key: 'ord_picked_up_in_transit',
    title: '🚛 包裹运输中',
    body: ctx => `你的「${ctx.productTitle}」正在运输途中。`,
  },
  // 注：曾有 'accepted→cancelled' 通知规则 — 该边现已存在但仅 system actor(直付取消退款握手,v12),
  // 通知由握手路由自己发(direct_pay_cancel_settled),不走本规则表。
  'in_transit→delivered': {
    recipients: ['buyer'], key: 'ord_in_transit_delivered',
    title: '📬 包裹已投递',
    body: ctx => `你的包裹已送达，请确认收货。72 小时内未确认将自动完成。`,
  },
  'delivered→confirmed': {
    recipients: ['seller'], key: ctx => ctx.paymentRail === 'direct_p2p' ? 'ord_delivered_confirmed_dp' : 'ord_delivered_confirmed',
    title: ctx => ctx.paymentRail === 'direct_p2p' ? '✅ 买家确认收货' : '💰 买家确认收货',
    body: ctx => ctx.paymentRail === 'direct_p2p'
      ? `${ctx.buyerName} 已确认收货，订单完成。直付为非托管:货款由你与买家场外结算,协议不代收、无平台资金入账。`
      : `${ctx.buyerName} 已确认收货，${ctx.totalAmount} WAZ 结算中。`,
  },
  'confirmed→completed': {
    recipients: ['seller'], key: ctx => ctx.paymentRail === 'direct_p2p' ? 'ord_confirmed_completed_dp' : 'ord_confirmed_completed',
    title: ctx => ctx.paymentRail === 'direct_p2p' ? '✅ 交易完成' : '✅ 交易完成，资金到账',
    body: ctx => ctx.paymentRail === 'direct_p2p'
      ? `订单「${ctx.productTitle}」交易完成。直付为非托管:无平台资金结算,货款以你与买家场外结算为准。`
      : `订单「${ctx.productTitle}」交易完成，收益已入账，查看钱包确认。`,
  },
  'paid→disputed': {
    recipients: ['seller'], key: 'ord_paid_disputed',
    title: '⚠️ 买家发起争议',
    body: ctx => `${ctx.buyerName} 对订单「${ctx.productTitle}」发起了争议。请在 48 小时内提交反驳证据，否则协议自动裁定退款。`,
  },
  'accepted→disputed': {
    recipients: ['seller'], key: 'ord_accepted_disputed',
    title: '⚠️ 买家发起争议',
    body: ctx => `${ctx.buyerName} 对订单「${ctx.productTitle}」发起了争议，请在 48h 内回应。`,
  },
  'shipped→disputed': {
    recipients: ['seller', 'logistics'], key: 'ord_shipped_disputed',
    title: '⚠️ 发生争议',
    body: ctx => `订单「${ctx.productTitle}」出现争议，请提交相关证据。`,
  },
  'in_transit→disputed': {
    recipients: ['seller', 'logistics'], key: 'ord_in_transit_disputed',
    title: '⚠️ 运输中发生争议',
    body: ctx => `订单「${ctx.productTitle}」运输过程中发生争议，请及时回应。`,
  },
  'delivered→disputed': {
    recipients: ['seller'], key: 'ord_delivered_disputed',
    title: '⚠️ 买家对收货发起争议',
    body: ctx => `${ctx.buyerName} 声称货物有问题，已发起争议。请在 48h 内提交证据。`,
  },
  // ── 裁定/违约:资金语义 rail-fork —— direct_p2p 非托管,平台不持货款,绝不能写"资金已释放/退回"(那是假话) ──
  'disputed→completed': {
    recipients: ['buyer', 'seller'], key: ctx => ctx.paymentRail === 'direct_p2p' ? 'ord_disputed_completed_dp' : 'ord_disputed_completed',
    title: '⚖️ 争议裁定：卖家胜诉',
    body: ctx => ctx.paymentRail === 'direct_p2p'
      ? `订单「${ctx.productTitle}」争议已裁定:卖家胜诉(直付为信誉裁决,不涉资金流转)。`
      : `订单「${ctx.productTitle}」争议已裁定，资金已释放给卖家。`,
  },
  'disputed→cancelled': {
    recipients: ['buyer', 'seller'], key: ctx => ctx.paymentRail === 'direct_p2p' ? 'ord_disputed_cancelled_dp' : 'ord_disputed_cancelled',
    title: ctx => ctx.paymentRail === 'direct_p2p' ? '⚖️ 争议裁定：支持买家' : '⚖️ 争议裁定：退款买家',
    body: ctx => ctx.paymentRail === 'direct_p2p'
      ? `订单「${ctx.productTitle}」争议已裁定支持买家。直付非托管:平台无资金可退,退款由双方场外处理;卖家信誉处罚已记录。`
      : `订单「${ctx.productTitle}」争议已裁定，${ctx.totalAmount} WAZ 已退回买家。`,
  },
  'paid→fault_seller': {
    recipients: ['buyer', 'seller'], key: 'ord_paid_fault_seller',
    title: '⏰ 卖家超时违约',
    body: ctx => `卖家超时未接单，订单已自动取消，${ctx.totalAmount} WAZ 退款处理中。`,
  },
  'accepted→fault_seller': {
    recipients: ['buyer', 'seller'], key: ctx => ctx.paymentRail === 'direct_p2p' ? 'ord_accepted_fault_seller_dp' : 'ord_accepted_fault_seller',
    title: '⏰ 卖家超时未发货',
    body: ctx => ctx.paymentRail === 'direct_p2p'
      ? `卖家超时未发货，订单已判卖家违约(直付非托管:平台无资金可退,违约已记入卖家信誉;退款请与卖家场外协商,协商未果可发起争议)。`
      : `卖家超时未发货，订单已判违约，资金退回。`,
  },
  'in_transit→fault_logistics': {
    recipients: ['buyer', 'seller'], key: 'ord_in_transit_fault_logistics',
    title: '⏰ 物流超时',
    body: ctx => `物流方超时未完成投递，已自动记录违约。`,
  },
  // ── Direct Pay 货款协商(争议≠仲裁,非托管:全程无退款/资金语义)──────────────────
  'accepted→payment_query': {
    recipients: ['buyer'], key: 'ord_accepted_payment_query',
    title: '🔎 卖家未收到货款',
    body: ctx => `卖家报告尚未收到「${ctx.productTitle}」的货款,请核实:若确已付款请提供付款参考,若未付款可取消订单。直付非托管,协议不代收/不退款。`,
  },
  'payment_query→accepted': {
    recipients: ['buyer'], key: 'ord_payment_query_accepted',
    title: '✅ 卖家已确认收款',
    body: ctx => `卖家已确认收到「${ctx.productTitle}」的货款,订单恢复,等待发货。`,
  },
  'payment_query→disputed': {
    recipients: ['buyer', 'seller'], key: 'ord_payment_query_disputed',
    title: '⚖️ 货款协商升级举证仲裁',
    body: ctx => `「${ctx.productTitle}」货款协商未果,已进入举证仲裁(证据制信誉裁决,非托管:不涉退款/放款)。请提交证据。`,
  },
  'disputed→payment_query': {
    recipients: ['buyer', 'seller'], key: 'ord_disputed_payment_query',
    title: '↩️ 仲裁已撤回,回到协商',
    body: ctx => `「${ctx.productTitle}」的仲裁申请已撤回,回到买卖双方协商。`,
  },
  'payment_query→cancelled': {
    recipients: ['buyer', 'seller'], key: 'ord_payment_query_cancelled',   // 买家取消(卖家知)/ 系统申诉窗满关单(买家知)
    title: '🚫 直付订单已取消(协商)',
    body: ctx => `「${ctx.productTitle}」订单已取消(货款协商未达成)。直付非托管,无平台退款。`,
  },
}

// ─── 主入口：状态变更后调用 ───────────────────────────────────

export function notifyTransition(
  db: Database.Database,
  orderId: string,
  fromStatus: string,
  toStatus: string,
): void {
  const rule = RULES[`${fromStatus}→${toStatus}`]
  if (!rule) return  // 没有规则的转移不发通知

  // 查询订单上下文
  const ctx = getOrderCtx(db, orderId)
  if (!ctx) return

  const title = typeof rule.title === 'function' ? rule.title(ctx) : rule.title
  const body  = rule.body(ctx)
  const type  = `${fromStatus}→${toStatus}`
  // N1 迁移:模板 key + 参数落库,客户端按 viewer locale 渲染;title/body 保持中文回退(零迁移)。
  //   logistics 缺省的兜底词交给客户端模板本地化(服务端不硬编码中文进 params)。
  const templateKey = typeof rule.key === 'function' ? rule.key(ctx) : rule.key
  const params = { buyer: ctx.buyerName, seller: ctx.sellerName, product: ctx.productTitle, amount: ctx.totalAmount, ...(ctx.logisticsName ? { logistics: ctx.logisticsName } : {}) }

  // 确定收件人 ID 列表
  const recipientIds = resolveRecipients(db, rule.recipients, ctx, orderId)

  for (const userId of recipientIds) {
    createNotification(db, userId, orderId, type, title, body, { templateKey, params })
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────

function getOrderCtx(db: Database.Database, orderId: string): OrderCtx | null {
  const row = db.prepare(`
    SELECT o.buyer_id, o.seller_id, o.logistics_id, o.total_amount, o.payment_rail,
           ub.name as buyer_name, us.name as seller_name,
           ul.name as logistics_name, p.title as product_title
    FROM orders o
    JOIN users ub ON o.buyer_id = ub.id
    JOIN users us ON o.seller_id = us.id
    LEFT JOIN users ul ON o.logistics_id = ul.id
    LEFT JOIN products p ON o.product_id = p.id
    WHERE o.id = ?
  `).get(orderId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    orderId,
    buyerName:     row.buyer_name as string,
    sellerName:    row.seller_name as string,
    logisticsName: row.logistics_name as string | undefined,
    productTitle:  row.product_title as string,
    totalAmount:   row.total_amount as number,
    paymentRail:   row.payment_rail as string | undefined,
  }
}

function resolveRecipients(
  db: Database.Database,
  roles: NotifRule['recipients'],
  ctx: OrderCtx,
  orderId: string
): string[] {
  const ids = new Set<string>()
  const order = db.prepare('SELECT buyer_id, seller_id, logistics_id FROM orders WHERE id = ?').get(orderId) as Record<string, string | null>

  for (const role of roles) {
    if (role === 'buyer'      && order.buyer_id)      ids.add(order.buyer_id)
    if (role === 'seller'     && order.seller_id)     ids.add(order.seller_id)
    if (role === 'logistics'  && order.logistics_id)  ids.add(order.logistics_id)
    if (role === 'admins') {
      // 收件人=全体 admin(users.role='admin';root/regional 由具体规则语义决定是否细分 —— 需要仅 root 的
      //   通知(如 fee-prepay 审批,ROOT 门)不走本规则表,在各自路由直查 admin_type='root')。
      try {
        const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all() as { id: string }[]
        admins.forEach(a => ids.add(a.id))
      } catch { /* fresh-DB → 无收件人 */ }
    }
    if (role === 'arbitrators') {
      // 收件人=active arbitrator_whitelist(唯一仲裁能力源;legacy role='arbitrator' 会通知到打不开案件的人、漏掉真仲裁员)。
      //   当前无 NOTIF_RULES 使用 'arbitrators'(仲裁员靠工作台拉取);此分支为未来规则备好正确的授权源。表缺失 → 静默空集。
      try {
        const arbs = db.prepare("SELECT user_id FROM arbitrator_whitelist WHERE status IS NULL OR status = 'active'").all() as { user_id: string }[]
        arbs.forEach(a => ids.add(a.user_id))
      } catch { /* fresh-DB 无表 → 无收件人 */ }
    }
  }
  return [...ids]
}

export function createNotification(
  db: Database.Database,
  userId: string,
  orderId: string | null,
  type: string,
  title: string,
  body: string,
  // N1(审计项 B):可选 i18n 模板 —— template_key + params 落库,客户端按 viewer locale 用 t() 渲染;
  //   title/body 仍必填 = 中文回退(旧客户端/未知 key 一律回退,向后兼容,零迁移)。
  opts?: { templateKey?: string; params?: Record<string, unknown> },
): Notification {
  const notif: Notification = {
    id: generateId('ntf'),
    user_id: userId,
    order_id: orderId,
    type,
    title,
    body,
    read: 0,
    created_at: new Date().toISOString(),
    ...(opts?.templateKey ? { template_key: opts.templateKey, params: JSON.stringify(opts.params ?? {}) } : {}),
  }
  db.prepare(`
    INSERT INTO notifications (id, user_id, order_id, type, title, body, template_key, params)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(notif.id, userId, orderId, type, title, body, opts?.templateKey ?? null, opts?.templateKey ? JSON.stringify(opts.params ?? {}) : null)

  // 实时推送(如果 PWA SSE 连接在线;payload 含模板字段,前端 toast 同样可本地化渲染)
  pushCallback?.(userId, notif)

  return notif
}

/**
 * 仲裁 admin 收件人:root(admin_type='root' → 隐含 ['all'])或 admin_permissions 含 'all'/'arbitration' 的 admin。
 *   与争议读写授权边界(requireAdminPermission(...,'arbitration'))一致 —— content/support 等无 arbitration 权限的
 *   admin【不】收到争议通知。复刻 hasAdminPermission 逻辑,不 import server 层。列缺失(fresh-DB)→ 空集。
 */
export function resolveArbitrationAdminIds(db: Database.Database): string[] {
  const ids: string[] = []
  try {
    const rows = db.prepare("SELECT id, admin_type, admin_permissions FROM users WHERE role = 'admin'").all() as { id: string; admin_type: string | null; admin_permissions: string | null }[]
    for (const r of rows) {
      if (r.admin_type === 'root') { ids.push(r.id); continue }
      let perms: unknown = []
      try { perms = JSON.parse(r.admin_permissions || '[]') } catch { perms = [] }
      if (Array.isArray(perms) && (perms.includes('all') || perms.includes('arbitration'))) ids.push(r.id)
    }
  } catch { /* fresh-DB 无 admin_type/permissions 列 → 空集 */ }
  return ids
}

/**
 * 统一仲裁台:一笔卖家客观拒单举证并入 disputes 后,通知全体 active 仲裁员 + 仲裁 admin(管理面)有新案待处理。
 *   幂等去重:按 (order_id, type='arb:decline_contest_new', user_id) 存在性探测 —— 新建行、backfill 补建、
 *   重复调用皆只对每个收件人发一次,不重复轰炸(镜像 scanDeadlineReminders 的 (order_id,type) 去重)。
 *   收件人为 active arbitrator_whitelist(唯一仲裁能力源)+ users.role='admin'(监督/兜底)。
 * 同步 better-sqlite3(engine 层);调用方(contest 路由 / backfill 脚本)传入同一个 db 句柄。
 */
export function notifyDeclineContestCase(
  db: Database.Database,
  orderId: string,
  disputeId: string,
): { notified: number; skipped: number } {
  const TYPE = 'arb:decline_contest_new'
  const ids = new Set<string>()
  try { (db.prepare("SELECT user_id AS id FROM arbitrator_whitelist WHERE status IS NULL OR status = 'active'").all() as { id: string }[]).forEach(r => ids.add(r.id)) } catch { /* fresh-DB 无表 */ }
  resolveArbitrationAdminIds(db).forEach(id => ids.add(id))   // 仅仲裁 admin(root / all / arbitration),不含 content/support
  let notified = 0, skipped = 0
  for (const uid of ids) {
    const exists = db.prepare('SELECT 1 FROM notifications WHERE order_id = ? AND type = ? AND user_id = ? LIMIT 1').get(orderId, TYPE, uid)
    if (exists) { skipped++; continue }
    createNotification(db, uid, orderId, TYPE,
      '新的拒单举证仲裁待处理',
      '一笔卖家客观拒单举证已进入统一仲裁台,等待仲裁员裁决。',
      { templateKey: 'arb_decline_contest_new', params: { order_id: orderId, dispute_id: disputeId } })
    notified++
  }
  return { notified, skipped }
}

// ─── 查询 ─────────────────────────────────────────────────────

// RFC-016 Phase 1:纯读 → 异步 seam。db 参数保留(签名兼容),内部走 dbAll/dbOne(同实例,setSeamDb)。
// 调用点全部已确认不在 db.transaction 内(notifications.ts:43/60/61 + mcp server.ts:2770/2771)。
export async function getNotifications(
  _db: Database.Database,
  userId: string,
  onlyUnread = false,
  limit = 30
): Promise<Notification[]> {
  const sql = `SELECT * FROM notifications WHERE user_id = ?${onlyUnread ? ' AND read = 0' : ''}
    ORDER BY created_at DESC LIMIT ?`
  return await dbAll<Notification>(sql, [userId, limit])
}

export async function getUnreadCount(_db: Database.Database, userId: string): Promise<number> {
  const row = await dbOne<{ n: number }>('SELECT COUNT(*) as n FROM notifications WHERE user_id = ? AND read = 0', [userId])
  return row?.n ?? 0
}

export function markRead(db: Database.Database, userId: string, notifId?: string): void {
  if (notifId) {
    db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(notifId, userId)
  } else {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(userId)
  }
}

// ─── 截止时间临近提醒 — 防"超时被判违约才知道"────────────────
// 每次扫描幂等：每个 (order_id, reminder_type) 只发一次
// reminder_type 形如 'reminder:accept_6h' / 'reminder:ship_12h' / 'reminder:confirm_24h'
const REMINDER_THRESHOLDS: Array<{
  status: string
  deadlineCol: string
  hoursBefore: number
  recipientRole: 'buyer' | 'seller' | 'logistics'
  type: string
  title: string
  body: (ctx: OrderCtx, h: number) => string
}> = [
  // 卖家：付款后 6h 内未接单 → 提醒卖家
  { status: 'paid',     deadlineCol: 'accept_deadline',   hoursBefore: 6,
    recipientRole: 'seller', type: 'reminder:accept_6h',
    title: '⏰ 还有 6h 接单截止',
    body: ctx => `订单「${ctx.productTitle}」还有 6 小时未接单将被判违约（扣信誉 + 自动退款）。` },
  // 卖家：发货截止前 12h 提醒
  { status: 'accepted', deadlineCol: 'ship_deadline',     hoursBefore: 12,
    recipientRole: 'seller', type: 'reminder:ship_12h',
    title: '⏰ 还有 12h 发货截止',
    body: ctx => `订单「${ctx.productTitle}」还有 12 小时未发货将被判违约，请抓紧时间。` },
  // 物流：揽收截止前 6h
  { status: 'shipped',  deadlineCol: 'pickup_deadline',   hoursBefore: 6,
    recipientRole: 'logistics', type: 'reminder:pickup_6h',
    title: '⏰ 还有 6h 揽收截止',
    body: ctx => `订单「${ctx.productTitle}」还有 6 小时未揽收将被判违约。` },
  // 物流：投递截止前 12h
  { status: 'in_transit', deadlineCol: 'delivery_deadline', hoursBefore: 12,
    recipientRole: 'logistics', type: 'reminder:delivery_12h',
    title: '⏰ 还有 12h 投递截止',
    body: ctx => `订单「${ctx.productTitle}」还有 12 小时未投递将被判违约。` },
  // 买家：确认收货截止前 24h
  { status: 'delivered', deadlineCol: 'confirm_deadline', hoursBefore: 24,
    recipientRole: 'buyer', type: 'reminder:confirm_24h',
    title: '⏰ 还有 24h 自动确认',
    body: ctx => `「${ctx.productTitle}」已送达，24 小时内未确认将自动确认收货 + 释放资金，如有问题请发起争议。` },
]

export function scanDeadlineReminders(db: Database.Database): { sent: number; details: Array<{ orderId: string; type: string }> } {
  const details: Array<{ orderId: string; type: string }> = []
  const nowMs = Date.now()
  for (const r of REMINDER_THRESHOLDS) {
    // 候选订单：当前状态 + deadline 在 (now, now+hoursBefore) 之间
    const targetMs = nowMs + r.hoursBefore * 3600_000
    // datetime() wrap on LHS — addHours 用 ISO 'T' 格式存，SQLite datetime('now') 返空格格式，
    // 同日 prefix 相同时 lex 比较 'T'(0x54) > ' '(0x20) 会让所有 same-day deadline 跳出窗口
    const sql = `SELECT id, ${r.deadlineCol} as dl, buyer_id, seller_id, logistics_id FROM orders WHERE status = ? AND ${r.deadlineCol} IS NOT NULL AND datetime(${r.deadlineCol}) > datetime('now') AND datetime(${r.deadlineCol}) <= datetime(?)`
    const rows = db.prepare(sql).all(r.status, new Date(targetMs).toISOString().replace('T', ' ').slice(0, 19)) as Array<{ id: string; dl: string; buyer_id: string; seller_id: string; logistics_id: string | null }>
    for (const row of rows) {
      const recipientId =
        r.recipientRole === 'buyer'     ? row.buyer_id :
        r.recipientRole === 'seller'    ? row.seller_id :
        r.recipientRole === 'logistics' ? row.logistics_id : null
      if (!recipientId) continue
      // 幂等：该 (order, type) 是否已发过
      const exists = db.prepare(`SELECT 1 FROM notifications WHERE order_id = ? AND type = ? LIMIT 1`).get(row.id, r.type)
      if (exists) continue
      const ctx = getOrderCtx(db, row.id)
      if (!ctx) continue
      createNotification(db, recipientId, row.id, r.type, r.title, r.body(ctx, r.hoursBefore))
      details.push({ orderId: row.id, type: r.type })
    }
  }
  return { sent: details.length, details }
}
