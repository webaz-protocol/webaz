/**
 * 每日签到 + 任务奖励
 *
 * 由 #1013 Phase 99 从 src/pwa/server.ts 抽出。
 *
 * 3 endpoints:
 *   GET  /api/checkin/status      今日签到状态 + 任务进度
 *   POST /api/checkin             签到（streak 续 + 7/30/100 里程碑奖）
 *   POST /api/tasks/:key/claim    任务奖励领取（progress 校验 + 唯一）
 *
 * 跨域注入：auth + isTrustedRole + errorRes + generateId + getProtocolParam
 *           + resolveCheckinDate + TASK_DEFS + computeTaskProgress
 *           + disbursePlatformReward + broadcastSystemEvent
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface CheckinTasksDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  errorRes: (res: Response, status: number, code: string, msg: string) => void
  generateId: (prefix: string) => string
  getProtocolParam: <T>(key: string, fallback: T) => T
  resolveCheckinDate: (clientDate: string | undefined) => string
  TASK_DEFS: Record<string, { label?: string; reward: number }>
  computeTaskProgress: (userId: string) => Record<string, { progress: number; goal: number; eligible: boolean }>
  disbursePlatformReward: (userId: string, amount: number, source: string, ref?: string | null) => void
  broadcastSystemEvent: (type: string, icon: string, msg: string, refId?: string | null) => void
}

export function registerCheckinTasksRoutes(app: Application, deps: CheckinTasksDeps): void {
  const { db, auth, isTrustedRole, errorRes, generateId, getProtocolParam,
          resolveCheckinDate, TASK_DEFS, computeTaskProgress, disbursePlatformReward,
          broadcastSystemEvent } = deps

  app.get('/api/checkin/status', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user as Record<string, unknown>)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_TRADE', '受信角色无此功能')
    const today = resolveCheckinDate(req.query.local_date ? String(req.query.local_date) : undefined)
    const todayCheckin = await dbOne<{ reward: number; streak: number }>('SELECT reward, streak FROM daily_checkins WHERE user_id = ? AND checkin_date = ?', [user.id, today])
    // streak: 连续签到 — 检查昨日
    const yesterday = new Date(new Date(today + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10)
    const yesterdayCheckin = await dbOne<{ streak: number }>('SELECT streak FROM daily_checkins WHERE user_id = ? AND checkin_date = ?', [user.id, yesterday])
    const currentStreak = todayCheckin?.streak || (yesterdayCheckin ? yesterdayCheckin.streak + 1 : 1)
    // F-2: 里程碑参数 admin 可调
    const bonus7 = getProtocolParam<number>('streak_bonus_7', 5)
    const bonus30 = getProtocolParam<number>('streak_bonus_30', 20)
    const bonus100 = getProtocolParam<number>('streak_bonus_100', 50)
    const milestoneBonus = (s: number) => s % 100 === 0 ? bonus100 : s % 30 === 0 ? bonus30 : s % 7 === 0 ? bonus7 : 0
    const baseReward = getProtocolParam<number>('checkin_base_reward', 0.5)
    const nextReward = baseReward + milestoneBonus(currentStreak)
    // 任务列表
    const progress = computeTaskProgress(String(user.id))
    const claimed = new Map<string, string>()
    for (const row of await dbAll<{ task_key: string; claimed_at: string | null }>('SELECT task_key, claimed_at FROM task_completions WHERE user_id = ?', [user.id])) {
      if (row.claimed_at) claimed.set(row.task_key, row.claimed_at)
    }
    const tasks = Object.entries(TASK_DEFS).map(([key, def]) => ({
      key, label: def.label, reward: def.reward,
      progress: progress[key].progress,
      goal: progress[key].goal,
      eligible: progress[key].eligible,
      claimed_at: claimed.get(key) || null,
    }))
    res.json({
      today,
      today_checked_in: !!todayCheckin,
      today_reward: todayCheckin?.reward || nextReward,
      current_streak: currentStreak,
      next_reward: nextReward,
      base_reward: baseReward,
      tasks,
    })
  })

  app.post('/api/checkin', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user as Record<string, unknown>)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_TRADE', '受信角色无此功能')
    const today = resolveCheckinDate(req.body?.local_date ? String(req.body.local_date) : undefined)
    const existing = await dbOne('SELECT reward FROM daily_checkins WHERE user_id = ? AND checkin_date = ?', [user.id, today])
    if (existing) return void res.status(400).json({ error: '今日已签到', error_code: 'ALREADY_CHECKED_IN' })
    const yesterday = new Date(new Date(today + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10)
    const yesterdayCheckin = await dbOne<{ streak: number }>('SELECT streak FROM daily_checkins WHERE user_id = ? AND checkin_date = ?', [user.id, yesterday])
    const streak = yesterdayCheckin ? yesterdayCheckin.streak + 1 : 1
    // F-2: admin 可调里程碑
    const bonus7 = getProtocolParam<number>('streak_bonus_7', 5)
    const bonus30 = getProtocolParam<number>('streak_bonus_30', 20)
    const bonus100 = getProtocolParam<number>('streak_bonus_100', 50)
    const baseReward = getProtocolParam<number>('checkin_base_reward', 0.5)
    const milestoneBonus = streak % 100 === 0 ? bonus100 : streak % 30 === 0 ? bonus30 : streak % 7 === 0 ? bonus7 : 0
    const reward = baseReward + milestoneBonus
    db.transaction(() => {
      db.prepare(`INSERT INTO daily_checkins (user_id, checkin_date, reward, streak) VALUES (?,?,?,?)`).run(user.id, today, reward, streak)
      // P1-3: 走平台拨付（从 sys_protocol 扣 + 给 user 加 + 写日志）
      disbursePlatformReward(String(user.id), reward, milestoneBonus > 0 ? `milestone_${streak}` : 'daily_checkin', String(streak))
      // 2026-05-24 写通知：让消息中心通知 sub-tab 能看到
      const title = milestoneBonus > 0 ? `🎉 连续签到 ${streak} 天里程碑！` : `✅ 签到成功`
      const body = `+${reward} WAZ${milestoneBonus > 0 ? ` (含里程碑奖 ${milestoneBonus})` : ''} · streak ${streak} 天`
      try {
        db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, order_id) VALUES (?,?,?,?,?,?)`)
          .run(generateId('ntf'), user.id, 'reward', title, body, null)
      } catch (e) { console.error('[checkin notif]', e) }
    })()
    try { broadcastSystemEvent('checkin', '📅', `签到 streak=${streak} · +${reward} WAZ`, String(user.id)) } catch {}
    res.json({ success: true, reward, streak, milestone_bonus: milestoneBonus })
  })

  app.post('/api/tasks/:key/claim', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user as Record<string, unknown>)) return void errorRes(res, 403, 'TRUSTED_ROLE_NO_TRADE', '受信角色无此功能')
    const taskKey = String(req.params.key)
    const def = TASK_DEFS[taskKey]
    if (!def) return void res.status(400).json({ error: '任务不存在' })
    const progress = computeTaskProgress(String(user.id))
    if (!progress[taskKey].eligible) return void res.status(400).json({ error: '任务未完成', progress: progress[taskKey] })
    const existing = await dbOne<{ claimed_at: string | null }>('SELECT claimed_at FROM task_completions WHERE user_id = ? AND task_key = ?', [user.id, taskKey])
    if (existing?.claimed_at) return void res.status(400).json({ error: '任务奖励已领取' })
    db.transaction(() => {
      db.prepare(`INSERT OR REPLACE INTO task_completions (user_id, task_key, completed_at, claimed_at, reward) VALUES (?,?,datetime('now'),datetime('now'),?)`).run(user.id, taskKey, def.reward)
      // P1-3: 走平台拨付助手
      disbursePlatformReward(String(user.id), def.reward, `task_${taskKey}`, null)
      // 2026-05-24 写通知
      try {
        db.prepare(`INSERT INTO notifications (id, user_id, type, title, body, order_id) VALUES (?,?,?,?,?,?)`)
          .run(generateId('ntf'), user.id, 'reward', `🎁 任务完成 — ${def.label || taskKey}`, `+${def.reward} WAZ`, null)
      } catch (e) { console.error('[task notif]', e) }
    })()
    try { broadcastSystemEvent('task_claim', '🎁', `任务领取 ${taskKey} · +${def.reward} WAZ`, String(user.id)) } catch {}
    res.json({ success: true, reward: def.reward })
  })
}
