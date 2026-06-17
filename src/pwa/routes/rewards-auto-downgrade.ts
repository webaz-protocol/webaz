/**
 * RFC-002 §3.10 — auto_downgrade cron (PR-3 slice 2)
 *
 * Daily sweep: when a major consent text version is published, opted-in
 * users have `protocol_params.rewards_opt_in.reconfirm_grace_days` (default
 * 14) to re-sign. Past the deadline, the system flips them to opted-out
 * with action='auto_downgrade'. Per PR-1c-a settleCommission gate, their
 * future commissions then route to pending_commission_escrow (NOT directly
 * to charity), giving them a recovery path if they later re-activate.
 *
 * Anchors:
 *   - rewards_consent_texts.effective_at + reconfirm_grace_days
 *   - user's last activate/reconfirm row in rewards_applications
 *
 * Idempotency: the UPDATE clause filters on rewards_opted_in=1 so a row
 * that was downgraded by a prior sweep is skipped automatically.
 *
 * Anti-race: if a user reconfirms between the SELECT and the UPDATE, the
 * UPDATE row count is 0 (rewards_opted_in already 0 or last row updated
 * after our window) — caller treats it as benign.
 *
 * Spec: docs/rfcs/RFC-002-rewards-opt-in.md §3.10 (auto_downgrade trigger)
 */
import type Database from 'better-sqlite3'
// RFC-016 Phase 1 — cron 的 currentMajor + 候选扫描读 → async seam;逐用户降级 db.transaction 写仍同步(Phase 3)。
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'

export interface AutoDowngradeDeps {
  db: Database.Database
  getProtocolParam: <T>(key: string, fallback: T) => T
}

export interface AutoDowngradeResult {
  scanned: number
  downgraded: Array<{ user_id: string; last_version: string | null; current_major: string; effective_at: number }>
  skip_reason?: string
}

export async function runAutoDowngradeSweep(deps: AutoDowngradeDeps): Promise<AutoDowngradeResult> {
  const { db, getProtocolParam } = deps

  // Current major consent
  const currentMajor = await dbOne<{ version: string; effective_at: number }>(`SELECT version, effective_at FROM rewards_consent_texts WHERE change_class='major' ORDER BY effective_at DESC LIMIT 1`)
  if (!currentMajor) return { scanned: 0, downgraded: [], skip_reason: 'no major consent text in rewards_consent_texts' }

  const graceDays = Number(getProtocolParam<number>('rewards_opt_in.reconfirm_grace_days', 14))
  const now = Date.now()
  const deadline = currentMajor.effective_at + graceDays * 86400 * 1000
  if (now < deadline) return { scanned: 0, downgraded: [], skip_reason: `current_major ${currentMajor.version} grace not yet expired (deadline=${deadline})` }

  // Candidates: opted-in users whose LATEST activate-or-reconfirm consent_version
  // is older than the current major.
  const candidates = await dbAll<{ user_id: string; last_version: string | null }>(`
    SELECT u.id AS user_id, (
      SELECT consent_version FROM rewards_applications
      WHERE user_id = u.id AND action IN ('activate','reconfirm')
      ORDER BY created_at DESC LIMIT 1
    ) AS last_version
    FROM users u WHERE u.rewards_opted_in = 1
  `)

  const downgraded: AutoDowngradeResult['downgraded'] = []
  for (const c of candidates) {
    if (c.last_version === currentMajor.version) continue
    db.transaction(() => {
      // Re-verify inside the transaction. Between the SELECT and here, the
      // user may have reconfirmed (PR-2 endpoint inserts a new row with
      // consent_version=current_major). If so, flag stays 1 but our outer
      // check would still flip it — wrongly. The transactional re-read
      // closes this race window.
      const fresh = db.prepare(`SELECT consent_version FROM rewards_applications WHERE user_id = ? AND action IN ('activate','reconfirm') ORDER BY created_at DESC LIMIT 1`).get(c.user_id) as { consent_version: string | null } | undefined
      if (fresh?.consent_version === currentMajor.version) return  // user reconfirmed mid-flight
      const upd = db.prepare(`UPDATE users SET rewards_opted_in = 0 WHERE id = ? AND rewards_opted_in = 1`).run(c.user_id)
      if (upd.changes === 0) return  // race: user already toggled out
      db.prepare(`INSERT INTO rewards_applications (user_id, action, verification_method, created_at) VALUES (?, 'auto_downgrade', 'system_auto', ?)`).run(c.user_id, now)
      // Notify user (PR-2b): tell them their consent expired + escrow accrual + how to recover.
      // Failure here is non-fatal — notification is best-effort, downgrade itself is the source of truth.
      try {
        db.prepare(`INSERT INTO notifications (id, user_id, type, title, body) VALUES (?, ?, 'rewards_auto_downgrade', ?, ?)`)
          .run(`ntf_rwd_${c.user_id}_${now}`, c.user_id,
               '分享分润已自动降级 / Rewards auto-downgraded',
               `新 consent 版本 ${currentMajor.version} 未在 grace 期内重新确认。未来 commission 进入 escrow(30 天可激活领回)。前往 #rewards-me 重新申请。 / New consent ${currentMajor.version} not re-confirmed within grace window. Future commission flows to escrow (30d recovery window). Visit #rewards-me to re-apply.`)
      } catch { /* notifications schema diff between envs; best-effort */ }
      downgraded.push({ user_id: c.user_id, last_version: c.last_version, current_major: currentMajor.version, effective_at: currentMajor.effective_at })
    })()
  }
  return { scanned: candidates.length, downgraded }
}

export function startAutoDowngradeCron(deps: AutoDowngradeDeps): void {
  const ms = 24 * 60 * 60 * 1000  // 1d fixed
  setInterval(async () => {
    try {
      const r = await runAutoDowngradeSweep(deps)
      if (r.downgraded.length > 0) {
        console.log(`[rewards-auto-downgrade] swept ${r.scanned}, downgraded ${r.downgraded.length}: ${r.downgraded.map(d => `${d.user_id} ${d.last_version || '(none)'}→${d.current_major}`).join(', ')}`)
      }
    } catch (e) {
      console.error('[rewards-auto-downgrade-cron]', e)
    }
  }, ms)
  console.log('⏬ RFC-002 §3.10 auto-downgrade cron 已启动 (每 24h, anchor=consent_text major effective_at + grace_days)')
}
