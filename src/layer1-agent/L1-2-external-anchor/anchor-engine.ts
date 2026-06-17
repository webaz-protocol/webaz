/**
 * L1-2 · 外置存证锚（External Content Anchor）
 *
 * 协议立场：第三方平台（淘宝 / JD / 抖店 / 小红书 / 1688 / Amazon...）
 * 是 WebAZ 的"外置存储"，平台不持有大字节，仅持有：
 *   - 卖家对 (URL, canonical_extract) 的 HMAC 签名
 *   - content_hash（sha256 of canonical）
 *   - 用户共识网络的验证回执
 *   - 卖家自己节点的 fallback URL（硬件兜底）
 *
 * 三层兜底：
 *   Tier 1  第三方平台 (CDN, 主源) — 平台 ToS 不阻挡用户浏览
 *   Tier 2  卖家自己节点 seller_node_url — 平台失效时仍可拉
 *   Tier 3  WebAZ 协议索引 (本表) — hash + 签名 + ownership 验证
 *
 * 反 scraping 立场：服务器从不主动 fetch 外平台。所有 canonical
 * 提取由客户端 / verifier 节点完成，本表只接受**提交 + 签名**。
 *
 * Ownership 验证流程：
 *   1. 卖家想绑外平台账号 → 服务器发 ownership_token = "WAZ-V-{8hex}"
 *   2. 卖家在外平台 listing 描述 / 店铺简介里嵌入 token
 *   3. 任一用户 (verifier 角色或他人) 打开外链确认 token 存在 → 提交 verify
 *   4. 2+ 独立 verifier 一致确认 → ownership_verified = 'community'
 *      （卖家自报为 'self_claimed'，可疑度较高，需后续社区验证）
 */

import Database from 'better-sqlite3'
import crypto from 'crypto'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 seam(纯读)

export type OwnershipLevel = 'none' | 'self_claimed' | 'community' | 'disputed'

export function initExternalAnchorSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_anchors (
      id                   TEXT PRIMARY KEY,
      seller_id            TEXT NOT NULL,
      product_id           TEXT,                       -- NULL = 店铺级 anchor，非具体商品
      platform             TEXT NOT NULL,              -- 'taobao' | 'jd' | 'douyin' | 'amazon' | ...
      external_url         TEXT NOT NULL,
      canonical_json       TEXT NOT NULL,              -- 客户端提取的 canonical JSON
      content_hash         TEXT NOT NULL,              -- sha256(canonical_json)
      signature            TEXT NOT NULL,              -- HMAC-SHA256(seller_api_key, canonical_json)
      seller_node_url      TEXT,                       -- 卖家自有节点兜底 URL（可选）
      ownership_token      TEXT,                       -- 当前生效的 ownership 验证 token
      ownership_token_at   TEXT,                       -- token 发放时间
      ownership_verified   TEXT DEFAULT 'none',        -- OwnershipLevel
      ownership_verified_at TEXT,
      verify_count         INTEGER DEFAULT 0,          -- community 验证累积票数
      last_verified_at     TEXT,
      revoked              INTEGER DEFAULT 0,
      revoked_at           TEXT,
      revoked_reason       TEXT,
      posted_at            TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS external_anchor_verifications (
      id                          TEXT PRIMARY KEY,
      anchor_id                   TEXT NOT NULL,
      verifier_id                 TEXT NOT NULL,
      verifier_role               TEXT NOT NULL,
      submitted_canonical_json    TEXT NOT NULL,
      submitted_content_hash      TEXT NOT NULL,
      content_matches             INTEGER NOT NULL,     -- 0/1
      token_found                 INTEGER NOT NULL,     -- 0/1（如果 anchor 在做 ownership 验证）
      verified_at                 TEXT DEFAULT (datetime('now')),
      notes                       TEXT,
      UNIQUE(anchor_id, verifier_id)                   -- 一人一锚一票
    );
  `)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_anchor_seller ON external_anchors(seller_id, revoked)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_anchor_product ON external_anchors(product_id, revoked)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_anchor_platform ON external_anchors(platform, revoked)') } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_anchor_verif ON external_anchor_verifications(anchor_id, verified_at DESC)') } catch {}
  // #6 验证激励：seller 创建 anchor 时可付 verification_fee → community 升级时按正确投票均分给 verifier
  for (const stmt of [
    'ALTER TABLE external_anchors ADD COLUMN verification_fee REAL DEFAULT 0',
    'ALTER TABLE external_anchors ADD COLUMN fee_paid_out INTEGER DEFAULT 0',
    'ALTER TABLE external_anchor_verifications ADD COLUMN reward_amount REAL DEFAULT 0',
  ]) { try { db.exec(stmt) } catch { /* 已存在 */ } }
}

// 推荐 verification_fee 默认值（前端给的提示，实际由 seller 决定，可为 0 = 不开启 community 验证）
export const ANCHOR_VERIFICATION_FEE_RECOMMENDED = 2.0

function canonicalSerialize(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(canonicalSerialize).join(',') + ']'
  if (typeof obj === 'object') {
    const keys = Object.keys(obj as Record<string, unknown>).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalSerialize((obj as Record<string, unknown>)[k])).join(',') + '}'
  }
  return JSON.stringify(obj)
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

const VALID_PLATFORMS = new Set([
  'taobao', 'tmall', 'jd', 'pdd', 'douyin', '1688',
  'xiaohongshu', 'weidian', 'shopify',
  'amazon', 'shopee', 'lazada', 'aliexpress',
  'instagram', 'tiktok', 'youtube',
  'other',
])

export function createAnchor(db: Database.Database, args: {
  sellerId: string
  productId?: string | null
  platform: string
  externalUrl: string
  canonical: Record<string, unknown>      // 客户端提取的 {title, price, images, description_excerpt, ...}
  sellerNodeUrl?: string | null
  verificationFee?: number                // #6: 可选 — 付费激励 verifier 升级到 community；0/省略 = 不开
}): { id: string; content_hash: string; signature: string; verification_fee: number } {
  if (!VALID_PLATFORMS.has(args.platform)) throw new Error('anchor_unknown_platform:' + args.platform)
  if (!/^https?:\/\//i.test(args.externalUrl)) throw new Error('anchor_invalid_url')
  if (!args.canonical || typeof args.canonical !== 'object') throw new Error('anchor_invalid_canonical')
  const seller = db.prepare('SELECT api_key, role FROM users WHERE id = ?').get(args.sellerId) as { api_key: string; role: string } | undefined
  if (!seller) throw new Error('anchor_seller_not_found')
  if (seller.role !== 'seller') throw new Error('anchor_only_seller_can_anchor')

  // 修复 ultrareview bug_003：product_id 给了就必须验卖家是商品归属人，
  // 否则任何卖家能往别人的 product 页"插"自己的外置存证（impersonation）
  if (args.productId) {
    const p = db.prepare('SELECT seller_id FROM products WHERE id = ?').get(args.productId) as { seller_id: string } | undefined
    if (!p) throw new Error('anchor_product_not_found')
    if (p.seller_id !== args.sellerId) throw new Error('anchor_not_product_owner')
  }

  // 修复 ultrareview bug_013：之前同 URL 重新声明会洗掉之前的 disputed verdict —
  // 拒绝在 disputed 状态下重声明，必须先 revokeAnchor 走显式撤销路径
  const prior = db.prepare('SELECT id, ownership_verified FROM external_anchors WHERE seller_id = ? AND external_url = ? AND revoked = 0').get(args.sellerId, args.externalUrl) as { id: string; ownership_verified: string } | undefined
  if (prior?.ownership_verified === 'disputed') {
    throw new Error('anchor_disputed_must_clear_first')
  }

  // canonical_json 严格 key 排序，让 sender / verifier 算出同样 hash
  const canonJson = canonicalSerialize(args.canonical)
  if (canonJson.length > 64 * 1024) throw new Error('anchor_canonical_too_large')
  const contentHash = sha256Hex(canonJson)
  const signature = crypto.createHmac('sha256', seller.api_key).update(canonJson).digest('hex')

  // 同卖家 + 同 URL 视为重新声明（先撤旧再发新）— 仅在非 disputed 时允许
  db.prepare('UPDATE external_anchors SET revoked = 1, revoked_at = datetime(\'now\'), revoked_reason = ? WHERE seller_id = ? AND external_url = ? AND revoked = 0').run('superseded', args.sellerId, args.externalUrl)

  // #6 验证激励费 — 可选，从 seller 钱包扣款锁入 anchor 的奖励池
  const fee = Math.max(0, Math.round(Number(args.verificationFee || 0) * 100) / 100)
  if (fee > 0) {
    const w = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(args.sellerId) as { balance: number } | undefined
    if (!w || w.balance < fee) throw new Error('anchor_insufficient_balance_for_fee')
    db.prepare('UPDATE wallets SET balance = balance - ? WHERE user_id = ?').run(fee, args.sellerId)
  }

  const id = generateId('xa')
  db.prepare(`
    INSERT INTO external_anchors
      (id, seller_id, product_id, platform, external_url, canonical_json, content_hash, signature, seller_node_url, verification_fee)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, args.sellerId, args.productId || null, args.platform, args.externalUrl,
    canonJson, contentHash, signature, args.sellerNodeUrl || null, fee
  )
  return { id, content_hash: contentHash, signature, verification_fee: fee }
}

// RFC-016 Phase 1:纯读 → 异步 seam(db 参数保留签名兼容;调用点 external-anchors.ts 均 inTx=false,无引擎内写调用)。
export async function verifyAnchorSignature(_db: Database.Database, anchorId: string): Promise<{ ok: boolean; reason?: string }> {
  const r = await dbOne<{ seller_id: string; canonical_json: string; content_hash: string; signature: string }>('SELECT seller_id, canonical_json, content_hash, signature FROM external_anchors WHERE id = ?', [anchorId])
  if (!r) return { ok: false, reason: 'not_found' }
  const reHash = sha256Hex(r.canonical_json)
  if (reHash !== r.content_hash) return { ok: false, reason: 'content_hash_mismatch' }
  const seller = await dbOne<{ api_key: string }>('SELECT api_key FROM users WHERE id = ?', [r.seller_id])
  if (!seller) return { ok: false, reason: 'seller_not_found' }
  const sig = crypto.createHmac('sha256', seller.api_key).update(r.canonical_json).digest('hex')
  return sig === r.signature ? { ok: true } : { ok: false, reason: 'signature_mismatch' }
}

export function revokeAnchor(db: Database.Database, anchorId: string, sellerId: string, reason: string): { ok: boolean; reason?: string } {
  const r = db.prepare('SELECT seller_id, revoked FROM external_anchors WHERE id = ?').get(anchorId) as { seller_id: string; revoked: number } | undefined
  if (!r) return { ok: false, reason: 'not_found' }
  if (r.seller_id !== sellerId) return { ok: false, reason: 'not_owner' }
  if (r.revoked) return { ok: false, reason: 'already_revoked' }
  db.prepare('UPDATE external_anchors SET revoked = 1, revoked_at = datetime(\'now\'), revoked_reason = ? WHERE id = ?').run(reason.slice(0, 200), anchorId)
  return { ok: true }
}

// 服务器发 ownership token — 卖家把它嵌到外平台 listing 描述里证明自己是 url 主人
export function issueOwnershipToken(db: Database.Database, anchorId: string, sellerId: string): { ok: boolean; token?: string; reason?: string } {
  const r = db.prepare('SELECT seller_id, revoked FROM external_anchors WHERE id = ?').get(anchorId) as { seller_id: string; revoked: number } | undefined
  if (!r) return { ok: false, reason: 'not_found' }
  if (r.seller_id !== sellerId) return { ok: false, reason: 'not_owner' }
  if (r.revoked) return { ok: false, reason: 'revoked' }
  const token = 'WAZ-V-' + crypto.randomBytes(4).toString('hex').toUpperCase()
  db.prepare(`UPDATE external_anchors SET ownership_token = ?, ownership_token_at = datetime('now'), ownership_verified = 'self_claimed' WHERE id = ?`).run(token, anchorId)
  return { ok: true, token }
}

// 任一用户作为 verifier 提交独立 canonical + ownership token 检查
export function submitVerification(db: Database.Database, args: {
  anchorId: string
  verifierId: string
  verifierRole: string
  submittedCanonical: Record<string, unknown>
  tokenFoundInExternal: boolean    // verifier 在外平台 URL 里看到 ownership_token 没？
  notes?: string
}): { ok: boolean; reason?: string; matches?: boolean; token_found?: boolean; ownership_level?: OwnershipLevel; reward_paid?: number } {
  const anchor = db.prepare('SELECT * FROM external_anchors WHERE id = ?').get(args.anchorId) as Record<string, unknown> | undefined
  if (!anchor) return { ok: false, reason: 'not_found' }
  if (anchor.revoked) return { ok: false, reason: 'revoked' }
  if (anchor.seller_id === args.verifierId) return { ok: false, reason: 'self_verify_disallowed' }

  // 重复提交检查（UNIQUE 约束兜底）
  const dup = db.prepare('SELECT id FROM external_anchor_verifications WHERE anchor_id = ? AND verifier_id = ?').get(args.anchorId, args.verifierId) as { id: string } | undefined
  if (dup) return { ok: false, reason: 'already_verified' }

  const subCanon = canonicalSerialize(args.submittedCanonical)
  const subHash = sha256Hex(subCanon)
  const matches = subHash === anchor.content_hash

  db.prepare(`
    INSERT INTO external_anchor_verifications
      (id, anchor_id, verifier_id, verifier_role, submitted_canonical_json, submitted_content_hash, content_matches, token_found, notes)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    generateId('xav'), args.anchorId, args.verifierId, args.verifierRole,
    subCanon, subHash, matches ? 1 : 0, args.tokenFoundInExternal ? 1 : 0,
    (args.notes || '').slice(0, 500)
  )

  // 更新 anchor 累积票数 + 自动升级 ownership 等级
  const stats = db.prepare(`
    SELECT COUNT(*) as total, SUM(content_matches) as match_cnt, SUM(token_found) as tok_cnt
    FROM external_anchor_verifications WHERE anchor_id = ?
  `).get(args.anchorId) as { total: number; match_cnt: number; tok_cnt: number }

  // 多数表决 + Sybil 防护（迭代修复 ultrareview bug_004 + bug_008）
  // 之前 community 只要 2 个 token 票 + 67% match — 2 个 sockpuppet 账号就能伪造 badge
  // 现在：community 升级**必须** 来自 verifier / arbitrator 角色，且 ≥3 个独立角色投票
  //       disputed 仍由任一身份 ≥2 票触发（社区警示门槛低）
  //   community  ← verifier_role_match_cnt ≥ 3 AND token_found ≥ 2 AND ratio ≥ 67%
  //   disputed   ← mismatch ≥ 2 AND ratio < 67%
  //   其他       ← self_claimed
  // 受信角色票统计（只算 verifier / arbitrator，普通 buyer/seller 不算 community 升级票）
  const trustedStats = db.prepare(`
    SELECT COUNT(*) as total, SUM(content_matches) as match_cnt, SUM(token_found) as tok_cnt
    FROM external_anchor_verifications
    WHERE anchor_id = ? AND verifier_role IN ('verifier', 'arbitrator')
  `).get(args.anchorId) as { total: number; match_cnt: number; tok_cnt: number }

  const mismatchCnt = stats.total - stats.match_cnt
  const matchRatio = stats.total > 0 ? stats.match_cnt / stats.total : 0
  let newLevel: OwnershipLevel = anchor.ownership_verified as OwnershipLevel || 'none'
  if (mismatchCnt >= 2 && matchRatio < 0.67) {
    newLevel = 'disputed'
  } else if (trustedStats.match_cnt >= 3 && trustedStats.tok_cnt >= 2 && matchRatio >= 0.67 && anchor.ownership_token) {
    newLevel = 'community'
  } else if (anchor.ownership_token) {
    newLevel = anchor.ownership_verified === 'community' ? 'community' : 'self_claimed'
  }

  const wasCommunity = anchor.ownership_verified === 'community'
  db.prepare(`UPDATE external_anchors SET
    verify_count = ?, last_verified_at = datetime('now'),
    ownership_verified = ?,
    ownership_verified_at = CASE WHEN ? = 'community' AND ownership_verified != 'community' THEN datetime('now') ELSE ownership_verified_at END
    WHERE id = ?`).run(stats.total, newLevel, newLevel, args.anchorId)

  // #6 验证激励：刚升级到 community → 分发 verification_fee 给所有 matching verifier/arbitrator
  let rewardPaid = 0
  if (newLevel === 'community' && !wasCommunity) {
    rewardPaid = distributeAnchorRewards(db, args.anchorId)
  }

  return { ok: true, matches, token_found: args.tokenFoundInExternal, ownership_level: newLevel, reward_paid: rewardPaid }
}

// #6 验证奖励分发 — 在 anchor 首次升 community 时调用
// 把 verification_fee 均分给所有 content_matches=1 的 verifier/arbitrator 角色投票者
// 幂等：fee_paid_out=1 后再调用返回 0
// 调用方：通常由 submitVerification 自动触发；也可被管理员手动重发（先重置 fee_paid_out）
export function distributeAnchorRewards(db: Database.Database, anchorId: string): number {
  const a = db.prepare(`SELECT verification_fee, fee_paid_out, ownership_verified FROM external_anchors WHERE id = ?`).get(anchorId) as { verification_fee: number; fee_paid_out: number; ownership_verified: string } | undefined
  if (!a) return 0
  if (a.fee_paid_out) return 0
  if (!a.verification_fee || a.verification_fee <= 0) {
    // 没费可分，标 paid_out 防重复扫描
    db.prepare(`UPDATE external_anchors SET fee_paid_out = 1 WHERE id = ?`).run(anchorId)
    return 0
  }
  if (a.ownership_verified !== 'community') return 0   // 只在 community 才发放

  // 找正确投票的可信角色（与 community 升级条件一致）
  const winners = db.prepare(`
    SELECT id, verifier_id FROM external_anchor_verifications
    WHERE anchor_id = ? AND verifier_role IN ('verifier', 'arbitrator') AND content_matches = 1
    ORDER BY verified_at ASC
  `).all(anchorId) as Array<{ id: string; verifier_id: string }>
  if (winners.length === 0) {
    db.prepare(`UPDATE external_anchors SET fee_paid_out = 1 WHERE id = ?`).run(anchorId)
    return 0
  }

  const share = Math.round((a.verification_fee / winners.length) * 100) / 100
  let actualPaid = 0
  db.transaction(() => {
    for (const w of winners) {
      // 确保 wallet 存在
      db.prepare(`INSERT OR IGNORE INTO wallets (user_id, balance) VALUES (?, 0)`).run(w.verifier_id)
      db.prepare(`UPDATE wallets SET balance = balance + ?, earned = earned + ? WHERE user_id = ?`).run(share, share, w.verifier_id)
      db.prepare(`UPDATE external_anchor_verifications SET reward_amount = ? WHERE id = ?`).run(share, w.id)
      actualPaid += share
    }
    // 浮点精度：实际 paid 可能比 fee 略少 (e.g. 5/3=1.66×3=4.98)，差额留 anchor 不发
    db.prepare(`UPDATE external_anchors SET fee_paid_out = 1 WHERE id = ?`).run(anchorId)
  })()
  return Math.round(actualPaid * 100) / 100
}

export async function getAnchor(_db: Database.Database, anchorId: string) {
  const row = await dbOne<Record<string, unknown>>('SELECT * FROM external_anchors WHERE id = ?', [anchorId])
  if (!row) return null
  const verifs = await dbAll('SELECT id, verifier_id, verifier_role, content_matches, token_found, verified_at FROM external_anchor_verifications WHERE anchor_id = ? ORDER BY verified_at DESC LIMIT 20', [anchorId])
  return { ...row, verifications: verifs }
}

export async function listAnchorsByProduct(_db: Database.Database, productId: string) {
  return await dbAll(`SELECT id, seller_id, platform, external_url, content_hash, ownership_verified, verify_count, seller_node_url, posted_at, revoked
                     FROM external_anchors WHERE product_id = ? AND revoked = 0 ORDER BY posted_at DESC`, [productId])
}

export async function listAnchorsBySeller(_db: Database.Database, sellerId: string) {
  return await dbAll(`SELECT id, product_id, platform, external_url, content_hash, ownership_verified, verify_count, seller_node_url, posted_at, revoked
                     FROM external_anchors WHERE seller_id = ? ORDER BY revoked ASC, posted_at DESC LIMIT 200`, [sellerId])
}
