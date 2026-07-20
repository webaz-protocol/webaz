/**
 * Ops Passkey-in-flow approval — 档位批准【窗口 token】domain(mint / consume-CAS / revoke)。
 *
 * 一次人工 Passkey 批准可开一个【短时、限次、可作废】的窗口:窗口存活期内,同 owner 同档位的后续动作
 *   由服务端凭窗口放行,不必每条都弹 Passkey。这是【就地批准】体验的关键——但绝不能变成"开一次窗永久授权":
 *   - 只 T1/T2(商品处置 / 上架·改价);T3(订单/资金)【永不开窗】,由 schema CHECK 硬约束(tier IN T1,T2)。
 *   - 次数有界(max_uses ≤ 20,schema CHECK 兜底)、TTL 短(默认 30min)、随时可 revoke。
 *   - consume 用 CAS(条件 UPDATE + changes 判定):并发/重放下绝不超发,超次/过期/已作废一律放行失败。
 *
 * 本模块【不执行任何动作、不碰钱路、不 import 执行器】——只负责窗口的发放/核销/作废。执行器(后续 task)
 *   consume 成功才动手;consume 失败即回退到"需要人工 Passkey"。owner-key 流,独立于 agent grant。
 */
import type Database from 'better-sqlite3'

export type WindowTier = 'T1' | 'T2'
const WINDOW_TTL_SEC_DEFAULT = 30 * 60   // 30min:就地批准是即时交互,窗口宁短勿长
const MAX_USES_CEILING = 20              // 与 schema CHECK (max_uses BETWEEN 1 AND 20) 对齐;代码侧 clamp 防抛错

export interface MintWindowResult {
  ok: boolean
  window_id?: string
  expires_at?: string
  max_uses?: number
  error?: string
  error_code?: string
  http?: number
}
export interface ConsumeWindowResult {
  ok: boolean
  window_id?: string
  remaining?: number
  error_code?: string   // NO_ACTIVE_WINDOW(无可核销窗)| WINDOW_OP_FAILED(真实 db 故障,已脱敏)
}
export interface RevokeWindowResult {
  ok: boolean
  revoked: number
  error_code?: string
}

const isTier = (t: string): t is WindowTier => t === 'T1' || t === 'T2'

/**
 * 开一个新窗口。为保证"同 owner 同档位至多一个活跃窗口"(consume 逻辑简单 + 语义清晰),mint 先在同一 tx 内
 *   作废该 (owner,tier) 现存的活跃窗口,再插新窗。max_uses / ttl 在代码侧 clamp 到合法区间,schema CHECK 兜底。
 */
export function mintWindow(db: Database.Database, opts: {
  ownerId: string; tier: string; generateId: (p: string) => string;
  ttlSec?: number; maxUses?: number;
}): MintWindowResult {
  const { ownerId, tier } = opts
  if (!isTier(tier)) return { ok: false, error_code: 'BAD_TIER', error: "tier 必须为 'T1' 或 'T2'(T3 永不开窗)", http: 400 }
  // clamp:调用方给越界值也不抛(schema CHECK 是最后防线,不作正常控制流)。非有限值(NaN/±Infinity,
  //   常见于 Number(req.body.x) 对非数字输入)回落到默认,绝不让 NaN 传到 INSERT(→NOT NULL/CHECK 失败=误导 500)
  //   或 Date(NaN)(→RangeError)。
  const rawMax = Number(opts.maxUses)
  const maxUses = Number.isFinite(rawMax) ? Math.max(1, Math.min(MAX_USES_CEILING, Math.floor(rawMax))) : MAX_USES_CEILING
  const rawTtl = Number(opts.ttlSec)
  const ttlSec = Number.isFinite(rawTtl) ? Math.max(1, Math.floor(rawTtl)) : WINDOW_TTL_SEC_DEFAULT

  try {
    const id = opts.generateId('aw')
    const nowIso = new Date().toISOString()
    const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString()
    db.transaction(() => {
      // 至多一个活跃窗:开新窗前作废旧的活跃窗(未作废且未过期)。
      db.prepare("UPDATE action_approval_windows SET revoked_at=? WHERE owner_id=? AND tier=? AND revoked_at IS NULL AND expires_at > ?")
        .run(nowIso, ownerId, tier, nowIso)
      db.prepare("INSERT INTO action_approval_windows (id, owner_id, tier, uses, max_uses, expires_at) VALUES (?,?,?,0,?,?)")
        .run(id, ownerId, tier, maxUses, expiresAt)
    })()
    return { ok: true, window_id: id, expires_at: expiresAt, max_uses: maxUses }
  } catch (e) {
    console.error('[approval-window] mint failed:', (e as Error).message)   // detail 留服务端
    return { ok: false, error_code: 'WINDOW_OP_FAILED', error: '无法开批准窗,请重试', http: 500 }
  }
}

/**
 * 核销一次(CAS)。挑选该 (owner,tier) 最新的【未作废·未过期·未超次】窗口并原子自增 uses;成功 changes===1。
 *   条件写在 UPDATE 的 WHERE 里(不是先读后写),故并发/重放下绝不超发:每条 UPDATE 只在 uses<max_uses 时 +1,
 *   SQLite 串行化写入。changes===0 = 无可核销窗(不存在/已满/过期/作废),返回 NO_ACTIVE_WINDOW。
 */
export function consumeWindow(db: Database.Database, opts: { ownerId: string; tier: string }): ConsumeWindowResult {
  const { ownerId, tier } = opts
  if (!isTier(tier)) return { ok: false, error_code: 'NO_ACTIVE_WINDOW' }   // 非法 tier 无窗可核销

  try {
    const nowIso = new Date().toISOString()
    // 单条原子 UPDATE … RETURNING:自增与回执(id + 剩余次数)在同一语句取自【正被核销的那一行】。
    //   ① 不再有"UPDATE 已提交、随后独立回读抛错→把已核销误报成失败(白烧一次额度)"的窗口(旧版 bug);
    //   ② 回执严格对应被核销行,不会在多窗共存/时钟回拨下选错窗;
    //   ③ RETURNING 看到的是自增【后】的值,故 max_uses-uses 即真实剩余。changes 语义等价于 row 是否存在。
    const row = db.prepare(
      `UPDATE action_approval_windows SET uses = uses + 1
         WHERE id = (
           SELECT id FROM action_approval_windows
             WHERE owner_id=? AND tier=? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses
             ORDER BY created_at DESC, id DESC LIMIT 1
         )
         AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses
         RETURNING id AS window_id, (max_uses - uses) AS remaining`
    ).get(ownerId, tier, nowIso, nowIso) as { window_id: string; remaining: number } | undefined
    if (!row) return { ok: false, error_code: 'NO_ACTIVE_WINDOW' }   // 无匹配行 = 不存在/已满/过期/作废
    return { ok: true, window_id: row.window_id, remaining: row.remaining }
  } catch (e) {
    console.error('[approval-window] consume failed:', (e as Error).message)
    return { ok: false, error_code: 'WINDOW_OP_FAILED' }
  }
}

/** 作废该 (owner,tier) 的全部活跃窗口(未作废)。返回作废条数。幂等:再调返回 0。 */
export function revokeWindow(db: Database.Database, opts: { ownerId: string; tier: string }): RevokeWindowResult {
  const { ownerId, tier } = opts
  if (!isTier(tier)) return { ok: false, revoked: 0, error_code: 'BAD_TIER' }
  try {
    const nowIso = new Date().toISOString()
    const info = db.prepare("UPDATE action_approval_windows SET revoked_at=? WHERE owner_id=? AND tier=? AND revoked_at IS NULL")
      .run(nowIso, ownerId, tier)
    return { ok: true, revoked: info.changes }
  } catch (e) {
    console.error('[approval-window] revoke failed:', (e as Error).message)
    return { ok: false, revoked: 0, error_code: 'WINDOW_OP_FAILED' }
  }
}
