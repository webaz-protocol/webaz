/**
 * Governance auto-deactivate cron (task #1093 stage 5)
 *
 * Scans active verifiers daily; auto-deactivates anyone whose
 * confirmed_wrong rate exceeds protocol-defined thresholds.
 *
 * Spec: docs/ARBITRATION-PLAYBOOK.md §6.2 + docs/GOVERNANCE-ONBOARDING.md §6.2
 *
 * Phase A: verifier only (arbitrator deferred — needs arbitrator_stats +
 * overturn mechanism, not present in phase A).
 *
 * Anchor: confirmed_wrong (NOT outlier — per playbook §6.1 core principle).
 *
 * Side effects per deactivated user (transaction):
 *   1. INSERT governance_applications row (action='auto_deactivate',
 *      status='inactive', cooldown_until=now+30d)
 *   2. UPDATE all active rows for user+role → 'inactive'
 *   3. Remove 'verifier' from users.roles JSON
 *   4. INSERT notification with appeal hint (14d window — stage 4)
 *
 * Idempotency: skips users whose users.roles JSON no longer contains
 * the role (already deactivated by another path).
 */
import type Database from 'better-sqlite3'
// RFC-016 Phase 1 — cron 候选扫描读 → async seam;逐用户卸任的 db.transaction 写仍同步(Phase 3 迁 pg)。
import { dbAll } from '../../layer0-foundation/L0-1-database/db.js'

export interface AutoDeactivateDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  getProtocolParam: <T>(key: string, fallback: T) => T
}

export interface AutoDeactivateResult {
  scanned: number
  deactivated: Array<{
    user_id: string
    role: 'verifier' // arbitrator deferred
    tasks_done: number
    tasks_wrong: number
    wrong_pct: number
    reason: string
  }>
}

/**
 * Run one auto-deactivate sweep. Returns deactivation report for caller
 * (cron caller logs to console; admin endpoint can call directly for query).
 */
export async function runAutoDeactivateSweep(deps: AutoDeactivateDeps): Promise<AutoDeactivateResult> {
  const { db, generateId, getProtocolParam } = deps

  const thresholdCount = Number(getProtocolParam<number>('governance_auto_deactivate_threshold_count', 5))
  const thresholdPct = Number(getProtocolParam<number>('governance_auto_deactivate_threshold_pct', 0.3))
  const minSample = Number(getProtocolParam<number>('governance_auto_deactivate_min_sample', 10))
  const cooldownDays = Number(getProtocolParam<number>('governance_resign_cooldown_days', 30))

  // Candidates: users with role 'verifier' in users.roles JSON
  //   + verifier_stats with tasks_done ≥ min_sample
  //   + tasks_wrong ≥ threshold_count
  //   + tasks_wrong/tasks_done ≥ threshold_pct
  // (verifier_stats is the source-of-truth for confirmed_wrong; server.ts:5387 increments it
  // on overturn, admin-verifier-flow.ts:130 decrements it on appeal success — exactly the
  // "confirmed_wrong" signal playbook §6.2 requires.)
  const candidates = await dbAll<{
    user_id: string
    roles: string
    tasks_done: number
    tasks_wrong: number
  }>(`
    SELECT u.id AS user_id, u.roles,
           vs.tasks_done, vs.tasks_wrong
    FROM users u
    JOIN verifier_stats vs ON vs.user_id = u.id
    WHERE u.roles IS NOT NULL
      AND u.roles LIKE '%"verifier"%'
      AND vs.tasks_done >= ?
      AND vs.tasks_wrong >= ?
      AND (CAST(vs.tasks_wrong AS REAL) / CAST(vs.tasks_done AS REAL)) >= ?
  `, [minSample, thresholdCount, thresholdPct])

  const result: AutoDeactivateResult = { scanned: candidates.length, deactivated: [] }
  const cooldownUntil = Math.floor(Date.now() / 1000) + cooldownDays * 86400

  for (const c of candidates) {
    // Recheck role inside transaction (idempotency + race safety)
    try {
      let didDeactivate = false
      db.transaction(() => {
        const u = db.prepare("SELECT roles FROM users WHERE id = ?").get(c.user_id) as { roles: string | null } | undefined
        let roles: string[] = []
        try { roles = JSON.parse(u?.roles || '[]') } catch { roles = [] }
        if (!roles.includes('verifier')) return // already deactivated

        // Codex #231 P1:扫描与本 tx 之间 verifier_stats 可能变化(申诉成功/纠正会减 tasks_wrong)。
        // 必须在 tx 内重读 stats 并基于重读值重算阈值,否则会用陈旧的越线结果误卸任。
        const vs = db.prepare("SELECT tasks_done, tasks_wrong FROM verifier_stats WHERE user_id = ?").get(c.user_id) as { tasks_done: number; tasks_wrong: number } | undefined
        if (!vs) return // stats 行已不存在
        const tasksDone = Number(vs.tasks_done)
        const tasksWrong = Number(vs.tasks_wrong)
        const overThreshold = tasksDone > 0 && tasksDone >= minSample && tasksWrong >= thresholdCount && (tasksWrong / tasksDone) >= thresholdPct
        if (!overThreshold) return // 重读后已不再越线 → 不写任何东西

        const wrongPct = tasksWrong / tasksDone
        const reason = `confirmed_wrong_count=${tasksWrong}/${tasksDone} (${(wrongPct * 100).toFixed(1)}%) ≥ threshold (count=${thresholdCount}, pct=${(thresholdPct * 100).toFixed(0)}%, min_sample=${minSample})`

        // 1. UPDATE all active rows → inactive
        db.prepare(
          "UPDATE governance_applications SET status = 'inactive' WHERE user_id = ? AND role = 'verifier' AND status = 'active'"
        ).run(c.user_id)

        // 2. INSERT auto_deactivate row(audit + appeal source)
        const id = generateId('gapp')
        db.prepare(`
          INSERT INTO governance_applications
            (id, user_id, role, action, status, cooldown_until, appeal_reason)
          VALUES (?, ?, 'verifier', 'auto_deactivate', 'inactive', ?, ?)
        `).run(id, c.user_id, cooldownUntil, reason)
        // Note: appeal_reason field stores the trigger reason (overloaded but keeps schema flat).
        // The user's appeal text(if they file one)goes on a separate appeal row(action='appeal').

        // 3. Remove from users.roles JSON
        const newRoles = roles.filter(r => r !== 'verifier')
        db.prepare("UPDATE users SET roles = ? WHERE id = ?").run(JSON.stringify(newRoles), c.user_id)

        // 4. Notify user with appeal link
        try {
          db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, order_id) VALUES (?,?,?,?,?,?)`)
            .run(generateId('ntf'), c.user_id, 'governance',
              '⚠️ 你的 verifier 资格已被自动卸任 / Verifier role auto-deactivated',
              `${reason}\n\nspec docs/GOVERNANCE-ONBOARDING.md §6.2 §7.2:14 天内可在 #governance-me 提交申诉。\n14-day appeal window opens. Submit appeal at #governance-me.`,
              null)
        } catch (_e) { /* notification failure must not block deactivate */ }

        didDeactivate = true
        result.deactivated.push({
          user_id: c.user_id,
          role: 'verifier',
          tasks_done: tasksDone,
          tasks_wrong: tasksWrong,
          wrong_pct: wrongPct,
          reason,
        })
      })()
      void didDeactivate
    } catch (e) {
      console.error('[governance-auto-deactivate] error for user', c.user_id, e)
    }
  }

  return result
}

/**
 * Boot the cron. Registers an interval timer based on the
 * governance_auto_deactivate_cron_hours protocol param value.
 *
 * Does NOT run an immediate sweep on boot — phase A solo maintainer
 * wants to observe explicitly via admin endpoint first.
 */
export function startAutoDeactivateCron(deps: AutoDeactivateDeps): void {
  const hours = Number(deps.getProtocolParam<number>('governance_auto_deactivate_cron_hours', 24))
  const ms = Math.max(1, hours) * 60 * 60 * 1000
  setInterval(async () => {
    try {
      const r = await runAutoDeactivateSweep(deps)
      if (r.deactivated.length > 0) {
        console.log(`[gov-auto-deactivate] swept ${r.scanned} candidates, deactivated ${r.deactivated.length}:`,
          r.deactivated.map(d => `${d.user_id}(${d.tasks_wrong}/${d.tasks_done})`).join(', '))
      }
    } catch (e) {
      console.error('[gov-auto-deactivate-cron]', e)
    }
  }, ms)
  console.log(`⚖️  governance auto-deactivate cron 已启动 (每 ${hours}h, anchor=confirmed_wrong per playbook §6.2)`)
}
