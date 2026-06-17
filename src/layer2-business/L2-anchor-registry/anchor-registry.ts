// L2-anchor 流量口令注册中心
// 设计目标：把"站外内容创作者引流回 WebAZ"的口令路径协议化
//
// 口令格式（2026-05-21 起去 tier 内嵌）：[prefix][middle]
//   prefix      = 用户 handle（ASCII 小写，锁定，防侵权）
//   middle      = 4 字符（用户自选，≥1 数字，禁顺序/保留词/视觉混淆 oil，
//                 字母与数字必须分段连续不可交错）
//   tier_letter = F/E/D/C/B/A 仍存表（动态属性），lookup 时返回供 UI 显示，
//                 不再拼入字符串（permalink — 达人升级旧 anchor 仍有效）
//
// 状态机：
//   active     — target 存活，正常解析 + 写 attribution
//   retired    — target 已删/owner 主动撤销，lookup 返"已归档"
//   reclaimable — retired 满 365 天 + owner 优先购 30 天，可被新人注册
//
// 6 档 tier（Option B × 10 — A 级为顶级稀有）
//   F: 0
//   E: ≥ 10,000 WAZ 累计推广成交额
//   D: ≥ 100,000
//   C: ≥ 1,000,000
//   B: ≥ 10,000,000
//   A: ≥ 100,000,000
//
// ── 唯一性原则（2026-05-21 决策，简单优先）──
// handle 强制 ASCII-only（[a-z0-9._]+）— 不引入 unicode/中文 handle：
//   1. 全网唯一（DB UNIQUE）— anchor lookup 必须精确指向唯一达人
//   2. 防视觉混淆钓鱼（异形字/繁简体/全角半角 Unicode confusables）
//   3. URL 友好（不需 percent-encode，IM 复制不损坏）
//   4. 口播友好（外站国际观众能输入）
// 中国达人推荐用：拼音 / 拼音首字母+数字（如 xiaomingzx / xm6688）
// 中文显示需求暂不支持；若未来需要请加 display_name 字段而非改 handle 规则

import Database from 'better-sqlite3'

export const ANCHOR_HANDLE_MAX_FOR_USE = 16      // handle 超过此长度不能用作 anchor prefix（2026-05-22 audit：12 → 16，让长 handle 用户也能用 anchor）
export const ANCHOR_MIDDLE_LEN = 4
export const ANCHOR_RECLAIM_COOLDOWN_DAYS = 365   // retired → reclaimable 等待
export const ANCHOR_PRIORITY_RECLAIM_DAYS = 30    // reclaimable 后原 owner 优先购窗口
export const ANCHOR_MAX_PER_USER = 100            // active+retired 上限（2026-05-22 audit: 50→100，大达人多类目场景）
export const ANCHOR_MAX_PER_DAY = 5               // 每天创建上限

// 6 档 tier 阈值（推广成交额，单位 WAZ）
export const TIER_THRESHOLDS: Record<string, number> = {
  F: 0,
  E: 10_000,
  D: 100_000,
  C: 1_000_000,
  B: 10_000_000,
  A: 100_000_000,
}

// 保留词（middle 不能匹配）
const RESERVED_MIDDLES = new Set([
  'admin', 'sys', 'api', 'webaz', 'test', 'null', 'root',
  'help', 'mail', 'user', 'info', 'home', 'www0', 'site',
])

// 顺序串（避免 SEO 滥用）
const SEQUENTIAL_MIDDLES = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '2345', '3456', '4567', '5678', '6789', '0123', 'abcd', 'qwer',
])

export type AnchorTargetKind = 'user' | 'product' | 'shareable' | 'dispute_case'
export type AnchorStatus = 'active' | 'retired' | 'reclaimable'

export function initAnchorRegistrySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS anchor_registry (
      anchor          TEXT PRIMARY KEY,                          -- 全 anchor 字串 = prefix + middle + tier_letter
      prefix          TEXT NOT NULL,                             -- 锁定的 handle 副本
      middle          TEXT NOT NULL,                             -- 用户选的 4 字符
      tier_letter     TEXT NOT NULL,                             -- F/E/D/C/B/A 锁定
      owner_id        TEXT NOT NULL,
      target_kind     TEXT NOT NULL,                             -- user / product / shareable / dispute_case
      target_id       TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active',            -- active / retired / reclaimable
      retired_at      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      hits            INTEGER DEFAULT 0,
      last_hit_at     TEXT
    )
  `)
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_anchor_owner_status ON anchor_registry(owner_id, status)") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_anchor_retired ON anchor_registry(retired_at) WHERE status = 'retired'") } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_anchor_target ON anchor_registry(target_kind, target_id)") } catch {}
  // 2026-05-22: 复合索引 — bought_products 内 anchor_count 子查询
  // owner_id + target_kind + target_id + status 4 列全匹配 → index-only scan
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_anchor_owner_target_status ON anchor_registry(owner_id, target_kind, target_id, status)") } catch {}
}

// 累计推广成交额 — sum of order.total_amount for orders where user is in commission chain
// 注意：依赖 commission_records 表（每个 order × level 一行）— 一个 order 同一 user 只会出现一次（不会同时是 L1 和 L2）
export function userReferralVolume(db: Database.Database, userId: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(o.total_amount), 0) as vol
    FROM commission_records cr
    JOIN orders o ON o.id = cr.order_id
    WHERE cr.beneficiary_id = ? AND o.status = 'completed'
  `).get(userId) as { vol: number } | undefined
  return Number(row?.vol ?? 0)
}

// 根据累计推广成交额计算 tier 字母
export function computeTierLetter(volume: number): 'F'|'E'|'D'|'C'|'B'|'A' {
  if (volume >= TIER_THRESHOLDS.A) return 'A'
  if (volume >= TIER_THRESHOLDS.B) return 'B'
  if (volume >= TIER_THRESHOLDS.C) return 'C'
  if (volume >= TIER_THRESHOLDS.D) return 'D'
  if (volume >= TIER_THRESHOLDS.E) return 'E'
  return 'F'
}

// 校验 middle 字符串
export function validateMiddle(middle: string): { ok: boolean; reason?: string } {
  if (!middle || typeof middle !== 'string') return { ok: false, reason: 'middle_empty' }
  if (middle.length !== ANCHOR_MIDDLE_LEN) return { ok: false, reason: 'middle_must_be_4_chars' }
  const lower = middle.toLowerCase()
  if (!/^[a-z0-9]{4}$/.test(lower)) return { ok: false, reason: 'middle_alphanumeric_only' }
  if (!/[0-9]/.test(lower)) return { ok: false, reason: 'middle_must_contain_digit' }
  if (RESERVED_MIDDLES.has(lower)) return { ok: false, reason: 'middle_reserved' }
  if (SEQUENTIAL_MIDDLES.has(lower)) return { ok: false, reason: 'middle_sequential_forbidden' }
  return { ok: true }
}

// 校验 user 的 handle 是否适合做 anchor prefix
export function validateHandleForAnchor(handle: string | null | undefined): { ok: boolean; reason?: string } {
  if (!handle) return { ok: false, reason: 'handle_not_set' }
  if (handle.length < 3) return { ok: false, reason: 'handle_too_short' }
  if (handle.length > ANCHOR_HANDLE_MAX_FOR_USE) return { ok: false, reason: 'handle_too_long_for_anchor' }
  if (!/^[a-z0-9._]+$/.test(handle)) return { ok: false, reason: 'handle_invalid_chars' }
  return { ok: true }
}

// 计算用户当前活跃 anchor 配额
export function userAnchorQuotaStats(db: Database.Database, userId: string): {
  active_plus_retired: number
  today_created: number
  max_total: number
  max_per_day: number
} {
  const totalRow = db.prepare(`
    SELECT COUNT(*) as n FROM anchor_registry
    WHERE owner_id = ? AND status != 'reclaimable'
  `).get(userId) as { n: number }
  const todayRow = db.prepare(`
    SELECT COUNT(*) as n FROM anchor_registry
    WHERE owner_id = ? AND created_at > datetime('now', '-1 day')
  `).get(userId) as { n: number }
  return {
    active_plus_retired: Number(totalRow?.n ?? 0),
    today_created: Number(todayRow?.n ?? 0),
    max_total: ANCHOR_MAX_PER_USER,
    max_per_day: ANCHOR_MAX_PER_DAY,
  }
}

// 检查 target 写入权限
export function checkAnchorTargetPermission(
  db: Database.Database, userId: string, targetKind: AnchorTargetKind, targetId: string
): { ok: boolean; reason?: string } {
  if (targetKind === 'user') {
    if (userId !== targetId) return { ok: false, reason: 'user_anchor_must_self' }
    return { ok: true }
  }
  if (targetKind === 'product') {
    // 2026-05-21: 推广员场景 — 允许任何登录用户为 product 创建 anchor
    // anchor 已有 owner_id 锁 prefix（来自 handle），不同用户独立锚定同一商品做推广，prefix 不冲突
    // 商品存在校验仍保留
    const p = db.prepare('SELECT id FROM products WHERE id = ? AND status = ?').get(targetId, 'active') as { id: string } | undefined
    if (!p) return { ok: false, reason: 'product_not_found' }
    return { ok: true }
  }
  if (targetKind === 'shareable') {
    const s = db.prepare('SELECT owner_id FROM shareables WHERE id = ?').get(targetId) as { owner_id: string } | undefined
    if (!s) return { ok: false, reason: 'shareable_not_found' }
    if (s.owner_id !== userId) return { ok: false, reason: 'shareable_not_owner' }
    return { ok: true }
  }
  if (targetKind === 'dispute_case') {
    // 仲裁案例：当事方（buyer/seller/arbitrator） 或 admin 可指
    const c = db.prepare('SELECT buyer_id, seller_id, arbitrator_id FROM dispute_cases WHERE id = ?').get(targetId) as { buyer_id: string | null; seller_id: string | null; arbitrator_id: string | null } | undefined
    if (!c) return { ok: false, reason: 'case_not_found' }
    if (c.buyer_id === userId || c.seller_id === userId || c.arbitrator_id === userId) return { ok: true }
    const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined
    if (u?.role === 'admin') return { ok: true }
    return { ok: false, reason: 'case_must_be_party_or_admin' }
  }
  return { ok: false, reason: 'invalid_target_kind' }
}

// 生成 anchor（综合校验 + 唯一性 + INSERT）
export function generateAnchor(db: Database.Database, args: {
  ownerId: string
  middle: string
  targetKind: AnchorTargetKind
  targetId: string
}): { ok: boolean; anchor?: string; tier_letter?: string; reason?: string } {
  const owner = db.prepare('SELECT id, handle FROM users WHERE id = ?').get(args.ownerId) as { id: string; handle: string | null } | undefined
  if (!owner) return { ok: false, reason: 'owner_not_found' }

  // 1. 校验 handle 可作 prefix
  const handleCheck = validateHandleForAnchor(owner.handle)
  if (!handleCheck.ok) return { ok: false, reason: handleCheck.reason }
  const prefix = (owner.handle as string).toLowerCase()

  // 2. 校验 middle
  const middleCheck = validateMiddle(args.middle)
  if (!middleCheck.ok) return { ok: false, reason: middleCheck.reason }
  const middle = args.middle.toLowerCase()

  // 3. 校验 target 权限
  const permCheck = checkAnchorTargetPermission(db, args.ownerId, args.targetKind, args.targetId)
  if (!permCheck.ok) return { ok: false, reason: permCheck.reason }

  // 4. 计算 tier letter
  const vol = userReferralVolume(db, args.ownerId)
  const tier_letter = computeTierLetter(vol)

  // 5. 拼接 anchor + 唯一性
  // 2026-05-21：去掉 tier_letter 内嵌（permalink 设计）
  // 原因：tier 是动态属性（升级），不该锁在静态字符串；达人升级后旧 anchor 仍有效
  // tier_letter 列保留为表字段，lookup 结果中返回供 UI 显示
  const anchor = `${prefix}${middle}`

  // 2026-05-22 audit fix：TOCTOU 保护 — 配额检查 + INSERT/UPDATE 必须在同一事务内
  // 之前：read quota → check < N → INSERT 三步分离 → 并发请求可同时读到 quota=N-1 → 双双 INSERT 致 quota=N+1（超限）
  // 现在：transaction 串行化（better-sqlite3 同进程内 transactions 是 immediate lock）
  // 注：throw 由 transaction 自动 rollback，return 值通过外层闭包传递
  try {
    return db.transaction(() => {
      // 6. 配额检查（事务内 read）
      const quota = userAnchorQuotaStats(db, args.ownerId)
      if (quota.active_plus_retired >= ANCHOR_MAX_PER_USER) {
        return { ok: false, reason: `quota_max_total_${ANCHOR_MAX_PER_USER}` }
      }
      if (quota.today_created >= ANCHOR_MAX_PER_DAY) {
        return { ok: false, reason: `quota_max_per_day_${ANCHOR_MAX_PER_DAY}` }
      }

      // 7. 检查 anchor 是否存在 / 是否在 reclaim 优先购窗口
      const existing = db.prepare(`SELECT owner_id, status, retired_at FROM anchor_registry WHERE anchor = ?`).get(anchor) as { owner_id: string; status: AnchorStatus; retired_at: string | null } | undefined
      if (existing) {
        if (existing.status === 'active') return { ok: false, reason: 'anchor_taken' }
        if (existing.status === 'retired') return { ok: false, reason: 'anchor_retired_not_yet_reclaimable' }
        if (existing.status === 'reclaimable') {
          // 优先购窗口：reclaim 后 30 天内只有原 owner 可领
          const reclaimableSince = existing.retired_at ? new Date(existing.retired_at.replace(' ', 'T') + 'Z').getTime() + ANCHOR_RECLAIM_COOLDOWN_DAYS * 86400_000 : 0
          const inPriorityWindow = (Date.now() - reclaimableSince) < (ANCHOR_PRIORITY_RECLAIM_DAYS * 86400_000)
          if (inPriorityWindow && existing.owner_id !== args.ownerId) {
            return { ok: false, reason: 'anchor_in_priority_window' }
          }
          // 允许覆盖（reclaimable 直接 UPDATE 而非 INSERT）
          db.prepare(`UPDATE anchor_registry SET owner_id = ?, prefix = ?, middle = ?, tier_letter = ?, target_kind = ?, target_id = ?, status = 'active', retired_at = NULL, created_at = datetime('now'), hits = 0, last_hit_at = NULL WHERE anchor = ?`)
            .run(args.ownerId, prefix, middle, tier_letter, args.targetKind, args.targetId, anchor)
          return { ok: true, anchor, tier_letter }
        }
      }

      // 8. 全新 INSERT（事务保护 — 并发请求会被 SQLite 串行化）
      db.prepare(`
        INSERT INTO anchor_registry (anchor, prefix, middle, tier_letter, owner_id, target_kind, target_id, status)
        VALUES (?,?,?,?,?,?,?, 'active')
      `).run(anchor, prefix, middle, tier_letter, args.ownerId, args.targetKind, args.targetId)
      return { ok: true, anchor, tier_letter }
    }).immediate()  // immediate 模式：开始事务即写锁，避免 deferred 的 SQLITE_BUSY
  } catch (e) {
    // UNIQUE 约束冲突（同名 anchor 并发 INSERT）→ 视为 anchor_taken
    if ((e as Error).message?.includes('UNIQUE') || (e as Error).message?.includes('SQLITE_CONSTRAINT')) {
      return { ok: false, reason: 'anchor_taken' }
    }
    throw e
  }
}

// 查 anchor — 不写入，timing-safe（同样调用模式）
export function lookupAnchor(db: Database.Database, code: string): {
  found: boolean
  status?: AnchorStatus
  target_kind?: AnchorTargetKind
  target_id?: string
  owner_id?: string
  tier_letter?: string
  retired_at?: string | null
} {
  if (!code || typeof code !== 'string') return { found: false }
  // 容错：用户可能复制带 @ 前缀（来自 UI 显示），去掉
  let normalized = code.toLowerCase().trim().replace(/^@/, '')
  if (!/^[a-z0-9]{6,20}$/.test(normalized)) return { found: false }   // 形态不对

  const stmt = db.prepare(`
    SELECT status, target_kind, target_id, owner_id, tier_letter, retired_at
    FROM anchor_registry WHERE anchor = ?
  `)
  let row = stmt.get(normalized) as Record<string, unknown> | undefined

  // 兼容旧格式：如果直接查不到，且末尾是单字母 (tier_letter F/E/D/C/B/A 之一) ，
  // 尝试去掉末尾字母再查（达人观众可能仍口播旧 anchor）
  if (!row && /[a-f]$/.test(normalized)) {
    const stripped = normalized.slice(0, -1)
    if (/^[a-z0-9]{6,20}$/.test(stripped)) {
      row = stmt.get(stripped) as Record<string, unknown> | undefined
      if (row) normalized = stripped
    }
  }

  if (!row) return { found: false }
  // 更新 hits + last_hit_at（不阻塞返回）
  try { db.prepare(`UPDATE anchor_registry SET hits = hits + 1, last_hit_at = datetime('now') WHERE anchor = ?`).run(normalized) } catch {}
  return {
    found: true,
    status: row.status as AnchorStatus,
    target_kind: row.target_kind as AnchorTargetKind,
    target_id: row.target_id as string,
    owner_id: row.owner_id as string,
    tier_letter: row.tier_letter as string,
    retired_at: (row.retired_at as string) || null,
  }
}

// owner 主动退役
export function retireAnchor(db: Database.Database, ownerId: string, code: string): { ok: boolean; reason?: string } {
  const normalized = code.toLowerCase().trim()
  const row = db.prepare(`SELECT owner_id, status FROM anchor_registry WHERE anchor = ?`).get(normalized) as { owner_id: string; status: AnchorStatus } | undefined
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.owner_id !== ownerId) return { ok: false, reason: 'not_owner' }
  if (row.status !== 'active') return { ok: false, reason: 'not_active' }
  db.prepare(`UPDATE anchor_registry SET status = 'retired', retired_at = datetime('now') WHERE anchor = ?`).run(normalized)
  return { ok: true }
}

// 删除 target 时调用（hook 进 product / shareable 删除路径）
// 批量把所有指向该 target 的 active anchor 设为 retired
export function retireAnchorsByTarget(db: Database.Database, targetKind: AnchorTargetKind, targetId: string): number {
  const r = db.prepare(`
    UPDATE anchor_registry SET status = 'retired', retired_at = datetime('now')
    WHERE target_kind = ? AND target_id = ? AND status = 'active'
  `).run(targetKind, targetId)
  return r.changes || 0
}

// Daily cron：retired → reclaimable（满 365 天）
export function reclaimRetiredAnchors(db: Database.Database): { reclaimed: number } {
  const r = db.prepare(`
    UPDATE anchor_registry SET status = 'reclaimable'
    WHERE status = 'retired' AND datetime(retired_at) < datetime('now', '-${ANCHOR_RECLAIM_COOLDOWN_DAYS} days')
  `).run()
  return { reclaimed: r.changes || 0 }
}

// 2026-05-22 audit P1：90 天无成交 → 自动 retire 闲置 anchor
// 释放 namespace 让新人能用同名 middle，配合 ANCHOR_MAX_PER_USER=100 升级
// 保留至少 1 个 active anchor（防止用户失去全部 anchor）
//
// 规则：
// 1. status='active'
// 2. created_at 已超 90 天
// 3. hits = 0（从未被 lookup）
// 4. owner 至少保留 1 个 active anchor（按 created_at DESC 排，跳过最新的）
//
// 注：被 retire 后用户可手动 reactive，但 365 天 reclaim 冷却仍生效
export const ANCHOR_IDLE_RETIRE_DAYS = 90

export function retireIdleAnchors(db: Database.Database): { retired: number } {
  // 先找候选 — active + 90+ 天 + hits=0
  const candidates = db.prepare(`
    SELECT anchor, owner_id, created_at, hits FROM anchor_registry
    WHERE status = 'active'
      AND datetime(created_at) < datetime('now', '-${ANCHOR_IDLE_RETIRE_DAYS} days')
      AND COALESCE(hits, 0) = 0
    ORDER BY owner_id, created_at ASC
  `).all() as Array<{ anchor: string; owner_id: string; created_at: string; hits: number }>

  if (candidates.length === 0) return { retired: 0 }

  // 按 owner 分组，保留每用户最新的 1 个 active anchor（不 retire）
  // 即只 retire 闲置 + 非最新（如果用户全是闲置，至少留 1 个）
  const byOwner = new Map<string, string[]>()  // owner_id → anchor[] (按 created_at ASC)
  for (const c of candidates) {
    if (!byOwner.has(c.owner_id)) byOwner.set(c.owner_id, [])
    byOwner.get(c.owner_id)!.push(c.anchor)
  }

  let total = 0
  for (const [ownerId, anchors] of byOwner) {
    // 查该用户当前 active 总数
    const activeCount = (db.prepare(`SELECT COUNT(*) as n FROM anchor_registry WHERE owner_id = ? AND status = 'active'`).get(ownerId) as { n: number }).n
    // 候选数最多 = activeCount - 1（保留最新的 1 个）
    const candidatesForUser = anchors.slice(0, Math.max(0, activeCount - 1))
    if (candidatesForUser.length === 0) continue
    const placeholders = candidatesForUser.map(() => '?').join(',')
    const r = db.prepare(`
      UPDATE anchor_registry SET status = 'retired', retired_at = datetime('now')
      WHERE anchor IN (${placeholders}) AND status = 'active'
    `).run(...candidatesForUser)
    total += r.changes || 0
  }
  return { retired: total }
}
