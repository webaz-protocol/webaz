/**
 * build_reputation engine (RFC-006 — Gap 2: contribution reward closed-loop, stage 3).
 *
 * 【独立信誉池】—— RFC-006 不变量 1:build_reputation 与交易 reputation_scores **完全隔离**,
 * 绝不作为 verifier/arbitrator 等【交易侧】准入输入。防"改文档攒分换交易权"。
 *   · 交易信誉:reputation_scores.total_points(reputation-engine)→ 喂 verifier/arbitrator 门槛。
 *   · 建设信誉:build_reputation.build_points(本文件)→ 只喂【建设】分层 + 贡献者看板。两池永不交叉。
 *
 * 问责锚真人:只有【绑 Passkey】的可问责真人贡献者才记分(调用方校验,沿用 RFC-004 锚点门)。
 * 注:build_reputation 是建设/协调层信誉,非经济奖励、非交易信誉、非 verifier/arbitrator 准入;展示面受 PR-5A
 *     uncommitted-value 边界约束,不承诺金额/币种/收益/兑付。
 * 看板自查私密(不变量 3):getBuildProfile 只给本人看,不做公开榜。
 *
 * 关联:RFC-006 / routes/build-reputation.ts / MCP webaz_contribute(profile)/ build_tasks / build_feedback
 */
import type Database from 'better-sqlite3'
import { generateId } from '../../layer0-foundation/L0-1-database/schema.js'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 seam(纯读)

// 建设贡献分值(独立计量,与交易分无关)
export const BUILD_POINTS: Record<string, number> = {
  feedback_accepted: 8,   // RFC-004 反馈/提案被采纳
  task_done: 12,          // RFC-006 认领的协调任务被验收 done
}

// 建设分层(独立于交易 verifier/arbitrator;仅描述"建设上能做什么")
const BUILD_TIERS = [
  { key: 'core',        min: 150, label_zh: '核心共建', label_en: 'Core',        caps_zh: '文档/翻译 · 审查 · 协议级提案(+守护权兜底)', caps_en: 'docs · review · protocol-level proposals (+ guardianship backstop)' },
  { key: 'trusted',     min: 50,  label_zh: '受信共建', label_en: 'Trusted',     caps_zh: '文档/翻译 · 审查 PR',                       caps_en: 'docs · review PRs' },
  { key: 'contributor', min: 10,  label_zh: '活跃共建', label_en: 'Contributor', caps_zh: '文档/翻译 · 认领日常任务',                   caps_en: 'docs · claim day-to-day tasks' },
  { key: 'newcomer',    min: 0,   label_zh: '新人',     label_en: 'Newcomer',    caps_zh: '文档/翻译(零门槛)',                       caps_en: 'docs / translation (open)' },
]
function tierFor(points: number): typeof BUILD_TIERS[number] {
  return BUILD_TIERS.find(t => points >= t.min) ?? BUILD_TIERS[BUILD_TIERS.length - 1]
}

export function initBuildReputationSchema(db: Database.Database): void {
  // 汇总池(每人一行)—— 独立表,绝不与 reputation_scores 混
  db.exec(`
    CREATE TABLE IF NOT EXISTS build_reputation (
      user_id      TEXT PRIMARY KEY,
      build_points INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  // 流水(可追溯每一分从哪来,防 gaming)
  db.exec(`
    CREATE TABLE IF NOT EXISTS build_reputation_events (
      id         TEXT PRIMARY KEY,              -- brev_xxx
      user_id    TEXT NOT NULL,
      source     TEXT NOT NULL,                 -- feedback_accepted | task_done | ...
      points     INTEGER NOT NULL,
      ref_id     TEXT,                          -- 关联的 feedback / task id
      note       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_build_rep_events ON build_reputation_events(user_id, created_at DESC)`)
  // Codex #104 P3:DB 级去重 —— 同 (source, ref_id) 只记一次 build event(并发/双击/多 worker 安全;
  //   仅约束 ref_id 非空,无 ref 的事件不去重)。先清历史重复行(每组保留最早 id)再建唯一索引,保证能建成。
  db.exec(`DELETE FROM build_reputation_events WHERE ref_id IS NOT NULL AND id NOT IN (
    SELECT MIN(id) FROM build_reputation_events WHERE ref_id IS NOT NULL GROUP BY source, ref_id)`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_build_rep_source_ref ON build_reputation_events(source, ref_id) WHERE ref_id IS NOT NULL`)
}

// 记入建设信誉(独立池)。防重复:同 (source, ref_id) 只记一次。
// 注:调用方负责校验提交者【有 Passkey 锚点】(可问责真人锚点);本函数只管入池。
export function creditBuildReputation(
  db: Database.Database, userId: string, source: string, points: number, refId?: string, note?: string,
): { credited: number; already?: boolean } {
  // 去重权威靠 DB 级 partial UNIQUE(source, ref_id) + INSERT OR IGNORE:并发/双击/多 worker 下
  //   同一 (source, ref_id) 只入一次 event,且仅当真正插入(changes===1)才加 build_points → 绝不重复计分。
  if (refId) {
    const ins = db.prepare(`INSERT OR IGNORE INTO build_reputation_events (id, user_id, source, points, ref_id, note) VALUES (?,?,?,?,?,?)`)
      .run(generateId('brev'), userId, source, points, refId, note ?? null)
    if (ins.changes === 0) return { credited: 0, already: true }   // 唯一冲突 → 已记过,不重复加分
  } else {
    db.prepare(`INSERT INTO build_reputation_events (id, user_id, source, points, ref_id, note) VALUES (?,?,?,?,?,?)`)
      .run(generateId('brev'), userId, source, points, null, note ?? null)
  }
  const existing = db.prepare(`SELECT build_points FROM build_reputation WHERE user_id = ?`).get(userId) as { build_points: number } | undefined
  if (!existing) {
    db.prepare(`INSERT INTO build_reputation (user_id, build_points) VALUES (?, ?)`).run(userId, Math.max(0, points))
  } else {
    db.prepare(`UPDATE build_reputation SET build_points = ?, updated_at = datetime('now') WHERE user_id = ?`)
      .run(Math.max(0, existing.build_points + points), userId)
  }
  return { credited: points }
}

// RFC-006 stage 4(恶意管理)= 复用现有问责中间件,**无需新代码**:
// build_tasks 是 api_key 写端点,被 strike 至 suspend_7d/permanent 的贡献者已被 isApiKeyBlocked
// (server.ts)挡在所有写之外,包括建设。strike/blocklist/outlier 对建设贡献自动生效。
// 看板这里只【展示】当事人的活跃 strike + 申诉入口(透明先于强制);真人申诉走现成 strikes/:id/appeal。

// 贡献者【自查】档案 —— KPI + 等级 + 来源拆分 + provenance + 限制/惩罚 + 申诉入口。
// 不变量 3:仅本人可调(路由层 auth);不做公开榜。
// RFC-016 Phase 1:纯读 → 异步 seam(db 参数保留签名兼容;调用点 build-reputation.ts:24 已确认不在 db.transaction 内)。
export async function getBuildProfile(_db: Database.Database, userId: string): Promise<Record<string, unknown>> {
  const num = async (sql: string, ...p: unknown[]) => ((await dbOne<{ n: number }>(sql, p))?.n ?? 0)

  // KPI(从 build_tasks + build_feedback 实算)
  const kpi = {
    tasks_claimed:      await num(`SELECT COUNT(*) n FROM build_tasks WHERE claimer_id = ? AND status = 'claimed'`, userId),
    tasks_in_review:    await num(`SELECT COUNT(*) n FROM build_tasks WHERE claimer_id = ? AND status = 'in_review'`, userId),
    tasks_done:         await num(`SELECT COUNT(*) n FROM build_tasks WHERE claimer_id = ? AND status = 'done'`, userId),
    tasks_created:      await num(`SELECT COUNT(*) n FROM build_tasks WHERE created_by = ?`, userId),
    feedback_submitted: await num(`SELECT COUNT(*) n FROM build_feedback WHERE user_id = ?`, userId),
    feedback_accepted:  await num(`SELECT COUNT(*) n FROM build_feedback WHERE user_id = ? AND status = 'resolved' AND credited_points > 0`, userId),
  }

  const summary = await dbOne<{ build_points: number }>(`SELECT build_points FROM build_reputation WHERE user_id = ?`, [userId])
  const buildPoints = summary?.build_points ?? 0
  const tier = tierFor(buildPoints)

  const bySource = await dbAll<{ source: string; count: number; points: number }>(
    `SELECT source, COUNT(*) AS count, COALESCE(SUM(points),0) AS points
     FROM build_reputation_events WHERE user_id = ? GROUP BY source`, [userId])

  // provenance 透明(自报,非检测):我认领的任务里 human/ai_assisted/ai_authored 各多少
  const provenance = await dbAll<{ provenance: string; count: number }>(
    `SELECT COALESCE(claimer_provenance,'unspecified') AS provenance, COUNT(*) AS count
     FROM build_tasks WHERE claimer_id = ? GROUP BY claimer_provenance`, [userId])

  // 限制 / 惩罚(复用现有 agent_strikes;只读 + 申诉入口)。无记录时返回空。
  const strikes = await dbAll<Record<string, unknown>>(
    `SELECT id, severity, reason_code, reason_detail, issued_at, expires_at, appeal_status
     FROM agent_strikes WHERE user_id = ?
       AND (expires_at IS NULL OR expires_at > datetime('now'))
       AND COALESCE(appeal_status,'') != 'upheld_removed'
     ORDER BY issued_at DESC LIMIT 20`, [userId])

  const hasAnchor = (await num(`SELECT COUNT(*) n FROM webauthn_credentials WHERE user_id = ?`, userId)) > 0

  return {
    user_id: userId,
    build_points: buildPoints,
    tier: { key: tier.key, label_zh: tier.label_zh, label_en: tier.label_en, caps_zh: tier.caps_zh, caps_en: tier.caps_en, next_at: BUILD_TIERS.find(t => t.min > buildPoints)?.min ?? null },
    kpi,
    by_source: bySource,
    provenance,
    standing: strikes.length === 0 ? 'ok' : 'flagged',
    restrictions: strikes,                 // 当事人看得见自己的扣分 + 原因
    appeal_hint: strikes.length > 0 ? 'POST /api/me/agents/strikes/:id/appeal' : null,
    // 是否已绑定 Passkey 锚点(把贡献锚定到可问责的真人)。无锚点 → 受理致谢但不记入建设信誉。
    // 此处不承诺任何经济回报,只表达"是否锚定了可问责真人"(PR-5A 边界);该字段由旧的 reward-anchor 命名更名而来。
    passkey_anchor_present: hasAnchor,
    // 不变量提示:此 build_points 仅用于建设分层 + 本看板,绝不喂交易侧(verifier/arbitrator)准入。
    pool: 'build_reputation (separate from trade reputation — never gates verifier/arbitrator)',
  }
}
