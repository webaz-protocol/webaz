/**
 * Admin: 用户查询 / 详情 / 批量操作 / 时间线（5 个 GET-重端点 + 1 POST batch）
 *
 * 由 #1013 Phase 79 从 src/pwa/server.ts 抽出。
 *
 * 5 endpoints:
 *   GET  /api/admin/users/lookup           按 handle / user_id 精确查找
 *   GET  /api/admin/users/:id/timeline     Wave F-3 完整事件流（订单/评/退/反馈/签到/任务/平台拨付/关注/wishlist/争议/注册）
 *   POST /api/admin/users/batch-action     批量 suspend / unsuspend（≤200）
 *   GET  /api/admin/users                  列表 + 智能搜索（usr_/@/name LIKE）+ 区域 scope 过滤
 *   GET  /api/admin/users/:id/profile      完整档案聚合（basic + wallet + kpis + activity + risks + audit）
 *
 * 权限：全部 users（区域 admin 看不到全局，被 scope 限制）
 *
 * 跨域注入：requireUsersAdmin + adminCanOperateOn + isRootAdmin + isAllowedSponsor
 *           + maskApiKey + computeLightTags + getAdminScope + getSellerDailyLimit
 *           + todayStartISO + broadcastSystemEvent + INTERNAL_AUDITOR_ID
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminUsersQueryDeps {
  db: Database.Database
  requireUsersAdmin:   (req: Request, res: Response) => Record<string, unknown> | null
  adminCanOperateOn:   (admin: Record<string, unknown>, targetId: string, res: Response) => boolean
  isRootAdmin:         (user: Record<string, unknown>) => boolean
  isAllowedSponsor:    (userId: string) => boolean
  maskApiKey:          (key: string) => string
  computeLightTags:    (user: Record<string, unknown>, mod: { suspended: number } | null, vWhite: { tier: string; is_system: number } | null, vAppPending: boolean) => string[]
  getAdminScope:       (user: Record<string, unknown>) => string
  getSellerDailyLimit: (user: { id?: unknown; created_at?: unknown }) => number
  todayStartISO:       () => string
  broadcastSystemEvent: (type: string, icon: string, msg: string, refId?: string | null) => void
  INTERNAL_AUDITOR_ID: string
  // 统一审计:批量封禁/解封改用户状态 → 记一条汇总 admin_audit_log(#admin/audit 可查)。
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
}

export function registerAdminUsersQueryRoutes(app: Application, deps: AdminUsersQueryDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { requireUsersAdmin, adminCanOperateOn, isRootAdmin, isAllowedSponsor,
          maskApiKey, computeLightTags, getAdminScope, getSellerDailyLimit, todayStartISO,
          broadcastSystemEvent, INTERNAL_AUDITOR_ID, logAdminAction } = deps

  // P1-1: 按 handle / id 任意角色查找
  app.get('/api/admin/users/lookup', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    const raw = String(req.query.q || '').trim()
    if (!raw) return void res.status(400).json({ error: 'q 必填（user_id 或 handle）' })
    const term = raw.replace(/^@/, '')
    let user = await dbOne<Record<string, unknown>>("SELECT id, name, handle, role, created_at FROM users WHERE handle = ? AND id NOT IN ('sys_protocol', ?)", [term, INTERNAL_AUDITOR_ID])
    if (!user) user = await dbOne<Record<string, unknown>>("SELECT id, name, handle, role, created_at FROM users WHERE id = ? AND id NOT IN ('sys_protocol', ?)", [term, INTERNAL_AUDITOR_ID])
    if (!user) return void res.status(404).json({ error: '用户不存在' })
    res.json({ user })
  })

  // Wave F-3: 完整事件流
  app.get('/api/admin/users/:id/timeline', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    const id = req.params.id
    const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 100))

    type Evt = { ts: string; type: string; icon: string; summary: string; ref_id?: string | null; ref_type?: string | null; amount?: number | null }
    const events: Evt[] = []
    const push = (ts: string | null, type: string, icon: string, summary: string, refId?: string | null, refType?: string | null, amount?: number | null) => {
      if (!ts) return
      events.push({ ts, type, icon, summary, ref_id: refId || null, ref_type: refType || null, amount: amount ?? null })
    }

    ;(await dbAll<{ id: string; status: string; total_amount: number; created_at: string; buyer_id: string; seller_id: string; logistics_id: string | null }>(`SELECT id, status, total_amount, created_at, buyer_id, seller_id, logistics_id FROM orders WHERE buyer_id=? OR seller_id=? OR logistics_id=? ORDER BY created_at DESC LIMIT 100`, [id, id, id])).forEach(o => {
      const role = o.buyer_id === id ? '买家' : o.seller_id === id ? '卖家' : '物流'
      push(o.created_at, 'order', '📦', `订单 (${role}) ${o.id} · ${o.total_amount} WAZ · ${o.status}`, o.id, 'order', o.total_amount)
    })
    ;(await dbAll<{ order_id: string; stars: number; comment: string | null; created_at: string; buyer_id: string; seller_id: string }>(`SELECT order_id, stars, comment, created_at, buyer_id, seller_id FROM order_ratings WHERE buyer_id=? OR seller_id=? ORDER BY created_at DESC LIMIT 50`, [id, id])).forEach(r => {
      const role = r.buyer_id === id ? '给出' : '收到'
      push(r.created_at, 'rating', '⭐', `${role} ${r.stars} 星评价 (订单 ${r.order_id})`, r.order_id, 'order')
    })
    ;(await dbAll<{ id: string; order_id: string; reason: string; refund_amount: number; status: string; created_at: string; buyer_id: string; seller_id: string }>(`SELECT id, order_id, reason, refund_amount, status, created_at, buyer_id, seller_id FROM return_requests WHERE buyer_id=? OR seller_id=? ORDER BY created_at DESC LIMIT 50`, [id, id])).forEach(r => {
      const role = r.buyer_id === id ? '发起' : '收到'
      push(r.created_at, 'return', '↩', `${role} 退货 (${r.status}, ${r.refund_amount} WAZ, ${r.reason})`, r.order_id, 'order', r.refund_amount)
    })
    ;(await dbAll<{ id: string; category: string; subject: string; status: string; created_at: string }>(`SELECT id, category, subject, status, created_at FROM feedback_tickets WHERE user_id=? ORDER BY created_at DESC LIMIT 30`, [id])).forEach(f => {
      push(f.created_at, 'feedback', '💬', `反馈 (${f.category}/${f.status}): ${f.subject}`, f.id, 'feedback')
    })
    ;(await dbAll<{ checkin_date: string; reward: number; streak: number; created_at: string }>(`SELECT checkin_date, reward, streak, created_at FROM daily_checkins WHERE user_id=? ORDER BY created_at DESC LIMIT 30`, [id])).forEach(c => {
      push(c.created_at, 'checkin', '📅', `签到 ${c.checkin_date} · streak ${c.streak} · +${c.reward} WAZ`, null, null, c.reward)
    })
    ;(await dbAll<{ task_key: string; reward: number; claimed_at: string }>(`SELECT task_key, reward, claimed_at FROM task_completions WHERE user_id=? AND claimed_at IS NOT NULL ORDER BY claimed_at DESC LIMIT 30`, [id])).forEach(tc => {
      push(tc.claimed_at, 'task', '🎁', `任务 ${tc.task_key} 领取 +${tc.reward} WAZ`, null, null, tc.reward)
    })
    ;(await dbAll<{ amount: number; source: string; ref: string | null; created_at: string }>(`SELECT amount, source, ref, created_at FROM platform_reward_log WHERE user_id=? ORDER BY created_at DESC LIMIT 50`, [id])).forEach(p => {
      push(p.created_at, 'reward', '💰', `平台拨付 (${p.source}${p.ref ? '/' + p.ref : ''}) +${p.amount} WAZ`, null, null, p.amount)
    })
    ;(await dbAll<{ followee_id: string; created_at: string }>(`SELECT followee_id, created_at FROM follows WHERE follower_id=? ORDER BY created_at DESC LIMIT 20`, [id])).forEach(f => {
      push(f.created_at, 'follow', '🤝', `关注 ${f.followee_id}`, f.followee_id, 'user')
    })
    ;(await dbAll<{ product_id: string; created_at: string }>(`SELECT product_id, created_at FROM user_wishlist WHERE user_id=? ORDER BY created_at DESC LIMIT 20`, [id])).forEach(w => {
      push(w.created_at, 'wishlist', '❤', `加入心愿单 ${w.product_id}`, w.product_id, 'product')
    })
    ;(await dbAll<{ product_id: string; created_at: string }>(`SELECT product_id, created_at FROM product_waitlist WHERE user_id=? ORDER BY created_at DESC LIMIT 20`, [id])).forEach(w => {
      push(w.created_at, 'waitlist', '⏰', `加入补货提醒 ${w.product_id}`, w.product_id, 'product')
    })
    ;(await dbAll<{ id: string; status: string; ruling_type: string | null; created_at: string; resolved_at: string | null; initiator_id: string; defendant_id: string }>(`SELECT id, status, ruling_type, created_at, resolved_at, initiator_id, defendant_id FROM disputes WHERE initiator_id=? OR defendant_id=? ORDER BY created_at DESC LIMIT 30`, [id, id])).forEach(d => {
      const role = d.initiator_id === id ? '发起' : '被诉'
      push(d.created_at, 'dispute_open', '⚖', `${role} 争议 ${d.id} (${d.status})`, d.id, 'dispute')
      if (d.resolved_at) push(d.resolved_at, 'dispute_resolved', '⚖', `争议 ${d.id} 结案 (${d.ruling_type || '—'})`, d.id, 'dispute')
    })
    const userRow = await dbOne<{ created_at: string; name: string; role: string }>(`SELECT created_at, name, role FROM users WHERE id=?`, [id])
    if (userRow) push(userRow.created_at, 'register', '🎉', `注册账号 ${userRow.name} (${userRow.role})`, null, null)

    events.sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    res.json({ items: events.slice(0, limit), total: events.length })
  })

  app.post('/api/admin/users/batch-action', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    const { user_ids, action, reason } = req.body || {}
    if (!Array.isArray(user_ids) || user_ids.length === 0) return void res.status(400).json({ error: 'user_ids 必填' })
    if (user_ids.length > 200) return void res.status(400).json({ error: '单次最多 200 用户' })
    if (!['suspend', 'unsuspend'].includes(String(action))) return void res.status(400).json({ error: 'action 必须 suspend/unsuspend' })
    const reasonStr = action === 'suspend' ? (reason ? String(reason).slice(0, 200) : 'admin 批量暂停') : null
    const results: Array<{ user_id: string; status: 'ok' | 'skipped'; reason?: string }> = []
    // Per-uid authorization boundary (res-free, so one bad uid never aborts the whole batch). Mirrors
    // adminCanOperateOn but stricter for admin targets: an admin target is ROOT-only regardless of scope.
    const actingRoot = isRootAdmin(admin)
    const actingScope = (admin.admin_scope as string) || 'global'
    const canOperate = (t: { admin_type: string | null; region: string | null }): { ok: boolean; reason?: string } => {
      if (t.admin_type) return actingRoot ? { ok: true } : { ok: false, reason: '仅 root 可操作 admin 账号' }
      if (actingRoot || actingScope === 'global') return { ok: true }
      if (t.region && t.region !== actingScope) return { ok: false, reason: `跨区用户(${t.region})仅本区/全局 admin 可操作` }
      return { ok: true }
    }
    for (const uid of user_ids) {
      try {
        if (uid === 'sys_protocol' || uid === admin.id) { results.push({ user_id: uid, status: 'skipped', reason: '保留账户或自己' }); continue }
        const target = await dbOne<{ admin_type: string | null; region: string | null }>('SELECT admin_type, region FROM users WHERE id = ?', [uid])
        if (!target) { results.push({ user_id: uid, status: 'skipped', reason: '用户不存在' }); continue }
        const gate = canOperate(target)
        if (!gate.ok) { results.push({ user_id: uid, status: 'skipped', reason: gate.reason }); continue }
        if (action === 'suspend') {
          await dbRun(`INSERT INTO user_moderation (user_id, suspended, reason, suspended_by, suspended_at)
            VALUES (?, 1, ?, ?, datetime('now'))
            ON CONFLICT(user_id) DO UPDATE SET suspended = 1, reason = excluded.reason, suspended_by = excluded.suspended_by, suspended_at = excluded.suspended_at`,
            [uid, reasonStr, admin.id])
        } else {
          await dbRun(`UPDATE user_moderation SET suspended = 0 WHERE user_id = ?`, [uid])
        }
        results.push({ user_id: uid, status: 'ok' })
      } catch (e) {
        results.push({ user_id: uid, status: 'skipped', reason: (e as Error).message })
      }
    }
    const ok = results.filter(r => r.status === 'ok').length
    try {
      // 防审计行膨胀:批量上限本就 ≤200,但仍只记前 50 个 id + 计数(truncated 标记),保证单行有界。
      const okIds = results.filter(r => r.status === 'ok').map(r => r.user_id)
      logAdminAction(admin.id as string, 'users_batch_' + String(action), 'user', null, {
        action, reason: reasonStr, applied: ok, requested: user_ids.length,
        user_ids: okIds.slice(0, 50), user_ids_truncated: okIds.length > 50,
      })
    } catch (e) { console.error('[users_batch audit]', e) }
    try { broadcastSystemEvent('admin_bulk_' + action, '🛡', `${admin.id} 批量${action === 'suspend' ? '暂停' : '解封'} ${ok} 用户`, null) } catch {}
    res.json({ success: true, applied: ok, results })
  })

  app.get('/api/admin/users', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    const q     = (req.query.q as string | undefined)?.trim()
    const role  = (req.query.role as string | undefined)?.trim()
    const type  = (req.query.type as string | undefined)?.trim()
    const region = (req.query.region as string | undefined)?.trim()

    let sql = `SELECT u.id, u.name, u.role, u.roles, u.email, u.email_verified, u.created_at, u.failed_attempts,
                u.region, u.admin_type, u.admin_scope,
                COALESCE(m.suspended,0) as suspended, m.reason as suspend_reason,
                vw.tier as v_tier, vw.is_system as v_is_system,
                (SELECT 1 FROM verifier_applications va WHERE va.user_id = u.id AND va.status='pending' LIMIT 1) as v_app_pending
               FROM users u
               LEFT JOIN user_moderation m       ON m.user_id  = u.id
               LEFT JOIN verifier_whitelist vw   ON vw.user_id = u.id
               WHERE u.id NOT IN ('sys_protocol', ?)`
    const params: unknown[] = [INTERNAL_AUDITOR_ID]

    let match_mode: 'id' | 'email' | 'name' | null = null
    if (q) {
      if (q.startsWith('usr_')) {
        sql += ` AND u.id = ?`; params.push(q)
        match_mode = 'id'
      } else if (q.includes('@')) {
        sql += ` AND u.email = ?`; params.push(q.toLowerCase())
        match_mode = 'email'
      } else {
        const qE = String(q).replace(/[\\%_]/g, '\\$&')
        sql += ` AND u.name LIKE ? ESCAPE '\\'`; params.push(`%${qE}%`)
        match_mode = 'name'
      }
    }
    if (role) { sql += ` AND u.role = ?`; params.push(role) }
    if (type === 'internal') {
      sql += ` AND u.role IN ('admin','verifier','logistics','arbitrator')`
    } else if (type === 'external') {
      sql += ` AND u.role IN ('buyer','seller')`
    }
    if (region) { sql += ` AND u.region = ?`; params.push(region) }
    // 区域 admin 仅看自己 scope 内的用户
    if (!isRootAdmin(admin)) {
      const scope = getAdminScope(admin)
      if (scope !== 'global') {
        sql += ` AND u.region = ?`; params.push(scope)
      }
    }
    sql += ` ORDER BY u.created_at DESC LIMIT 100`

    const rows = await dbAll<Record<string, unknown>>(sql, params)
    res.json({
      match_mode,
      my_admin_type: admin.admin_type || 'root',
      my_admin_scope: admin.admin_scope || 'global',
      users: rows.map(r => {
        const mod = { suspended: Number(r.suspended) }
        const vw  = r.v_tier ? { tier: r.v_tier as string, is_system: Number(r.v_is_system) } : null
        const vAppPending = !!r.v_app_pending
        return {
          id: r.id,
          name: r.name,
          role: r.role,
          roles: (() => { try { return JSON.parse((r.roles as string) || '[]') } catch { return [] } })(),
          email: r.email,
          email_verified: !!r.email_verified,
          region: r.region,
          admin_type: r.admin_type,
          admin_scope: r.admin_scope,
          created_at: r.created_at,
          suspended: !!r.suspended,
          suspend_reason: r.suspend_reason,
          tags: computeLightTags(r, mod, vw, vAppPending),
        }
      }),
    })
  })

  // 完整档案聚合
  app.get('/api/admin/users/:id/profile', async (req, res) => {
    const admin = requireUsersAdmin(req, res); if (!admin) return
    if (!adminCanOperateOn(admin, req.params.id, res)) return
    const id = req.params.id

    const user = await dbOne<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", [id])
    if (!user) return void res.json({ error: '用户不存在' })

    const wallet = await dbOne<Record<string, unknown>>("SELECT balance, staked, escrowed, earned, deposit_address FROM wallets WHERE user_id = ?", [id])
    const mod    = await dbOne<Record<string, unknown>>("SELECT suspended, reason, suspended_by, suspended_at FROM user_moderation WHERE user_id = ?", [id])
    const vw     = await dbOne<Record<string, unknown>>("SELECT tier, daily_quota, tasks_today, quota_reset_at, granted_by, stake_amount, cooldown_until, error_count_180d, is_system, added_at FROM verifier_whitelist WHERE user_id = ?", [id])
    const vs     = await dbOne<Record<string, unknown>>("SELECT verify_rights, tasks_done, tasks_correct, tasks_wrong, suspended_until FROM verifier_stats WHERE user_id = ?", [id])
    const vAppPending = !!(await dbOne("SELECT 1 FROM verifier_applications WHERE user_id = ? AND status='pending' LIMIT 1", [id]))

    const roleSet = new Set<string>((() => { try { return JSON.parse((user.roles as string) || '[]') } catch { return [] } })())

    const kpis: Record<string, unknown> = {}
    if (roleSet.has('seller')) {
      const p = (await dbOne<Record<string, number>>(`SELECT COUNT(*) as total,
                                   SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active,
                                   SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END) as paused,
                                   SUM(CASE WHEN status='deleted'THEN 1 ELSE 0 END) as deleted
                            FROM products WHERE seller_id = ?`, [id]))!
      const o = (await dbOne<Record<string, number>>(`SELECT COUNT(*) as total,
                                   SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
                                   COALESCE(SUM(CASE WHEN status='completed' THEN total_amount ELSE 0 END),0) as total_sales
                            FROM orders WHERE seller_id = ?`, [id]))!
      const d = (await dbOne<Record<string, number>>(`SELECT COUNT(*) as defendant_count,
                                   SUM(CASE WHEN ruling_type IN ('refund_buyer','partial_refund') THEN 1 ELSE 0 END) as lost
                            FROM disputes WHERE defendant_id = ?`, [id]))!
      const today = todayStartISO()
      const todayCount = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM products WHERE seller_id = ? AND created_at >= ?", [id, today]))!.n
      const dailyLimit = getSellerDailyLimit({ id, created_at: user.created_at })
      kpis.seller = {
        products_total: p.total, products_active: p.active, products_paused: p.paused, products_deleted: p.deleted,
        orders_total: o.total, orders_completed: o.completed, total_sales: o.total_sales,
        disputes_as_defendant: d.defendant_count, disputes_lost: d.lost,
        max_products: Number(user.max_products ?? 200),
        daily_limit: dailyLimit, daily_used: todayCount,
        listing_paused: !!user.listing_paused,
        listing_paused_reason: user.listing_paused_reason ?? null,
      }
    }
    if (roleSet.has('buyer')) {
      const o = (await dbOne<Record<string, number | string>>(`SELECT COUNT(*) as total,
                                   SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
                                   COALESCE(SUM(CASE WHEN status='completed' THEN total_amount ELSE 0 END),0) as total_spent,
                                   MAX(created_at) as last_order_at
                            FROM orders WHERE buyer_id = ?`, [id]))!
      kpis.buyer = {
        orders_total: o.total, orders_completed: o.completed,
        total_spent: o.total_spent, last_order_at: o.last_order_at,
      }
    }
    if (roleSet.has('logistics')) {
      const o = (await dbOne<Record<string, number>>(`SELECT COUNT(*) as total,
                                   SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed
                            FROM orders WHERE logistics_id = ?`, [id]))!
      kpis.logistics = { deliveries_total: o.total, deliveries_completed: o.completed }
    }
    if (roleSet.has('verifier') && vw) {
      const accuracy = (vs && vs.tasks_done as number > 0)
        ? Number((vs.tasks_correct as number) / (vs.tasks_done as number)).toFixed(3) : '—'
      kpis.verifier = {
        tier: vw.tier, daily_quota: vw.daily_quota, tasks_today: vw.tasks_today,
        remaining: Number(vw.daily_quota) > 0 ? Math.max(0, Number(vw.daily_quota) - Number(vw.tasks_today)) : 0,
        tasks_done: vs?.tasks_done ?? 0, tasks_correct: vs?.tasks_correct ?? 0,
        accuracy, error_count_180d: vw.error_count_180d,
        verify_rights: vs?.verify_rights ?? 0,
        suspended_until: vs?.suspended_until, cooldown_until: vw.cooldown_until,
        is_system: vw.is_system === 1,
      }
    }

    const tags = computeLightTags(user, mod ? { suspended: Number(mod.suspended) } : null, vw ? { tier: vw.tier as string, is_system: Number(vw.is_system) } : null, vAppPending)
    if (wallet && Number(wallet.balance) > 1000) tags.push('high_balance')

    // 最近活动
    const events: { ts: string; type: string; icon: string; summary: string; ref_id?: string; ref_type?: string }[] = []
    const pushEvt = (ts: string | null, type: string, icon: string, summary: string, refId?: string, refType?: string) => {
      if (!ts) return
      events.push({ ts, type, icon, summary, ref_id: refId, ref_type: refType })
    }
    ;(await dbAll(`SELECT id, total_amount, product_id, status, created_at FROM orders WHERE buyer_id = ? ORDER BY created_at DESC LIMIT 10`, [id]) as any[]).forEach(o => pushEvt(o.created_at, 'order_buy', '🛒', `下单 ${o.total_amount} WAZ (${o.status})`, o.id, 'order'))
    ;(await dbAll(`SELECT id, total_amount, status, created_at FROM orders WHERE seller_id = ? ORDER BY created_at DESC LIMIT 10`, [id]) as any[]).forEach(o => pushEvt(o.created_at, 'order_sell', '💰', `售出 ${o.total_amount} WAZ (${o.status})`, o.id, 'order'))
    ;(await dbAll(`SELECT id, title, status, created_at FROM products WHERE seller_id = ? ORDER BY created_at DESC LIMIT 10`, [id]) as any[]).forEach(p => pushEvt(p.created_at, 'product_listed', '🏪', `上架商品 ${(p.title||'').slice(0,30)}`, p.id, 'product'))
    ;(await dbAll(`SELECT id, task_id, verdict, claimed_at, submitted_at FROM verify_submissions WHERE verifier_id = ? ORDER BY claimed_at DESC LIMIT 10`, [id]) as any[]).forEach(s => {
      pushEvt(s.claimed_at, 'verify_claimed', '🔍', `认领验证任务`, s.task_id, 'task')
      if (s.submitted_at) {
        const icon = s.verdict === 'correct' ? '✓' : s.verdict === 'wrong' ? '✗' : '⏳'
        pushEvt(s.submitted_at, 'verify_submitted', icon, `提交验证 (${s.verdict || 'pending'})`, s.task_id, 'task')
      }
    })
    ;(await dbAll(`SELECT id, status, ruling_type, created_at, resolved_at, initiator_id, defendant_id FROM disputes WHERE initiator_id = ? OR defendant_id = ? ORDER BY created_at DESC LIMIT 10`, [id, id]) as any[]).forEach(d => {
      const role = d.initiator_id === id ? '发起' : '被告'
      pushEvt(d.created_at, 'dispute_init', '⚖', `争议 ${role} (${d.status})`, d.id, 'dispute')
      if (d.resolved_at) pushEvt(d.resolved_at, 'dispute_resolved', '⚖', `争议结案 (${d.ruling_type || '—'})`, d.id, 'dispute')
    })
    ;(await dbAll(`SELECT id, status, decision_note, applied_at, reviewed_at FROM verifier_applications WHERE user_id = ? ORDER BY applied_at DESC LIMIT 5`, [id]) as any[]).forEach(a => {
      pushEvt(a.applied_at, 'verifier_apply', '📥', `提交审核员申请`, a.id, 'verifier_app')
      if (a.reviewed_at) pushEvt(a.reviewed_at, 'verifier_review', a.status === 'approved' ? '✅' : '❌', `申请${a.status === 'approved' ? '获批' : a.status === 'rejected' ? '被拒' : a.status}`, a.id, 'verifier_app')
    })
    ;(await dbAll(`SELECT id, status, created_at, reviewed_at FROM verifier_appeals WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`, [id]) as any[]).forEach(a => {
      pushEvt(a.created_at, 'appeal_submitted', '📩', `提交申诉`, a.id, 'appeal')
      if (a.reviewed_at) pushEvt(a.reviewed_at, 'appeal_decided', a.status === 'accepted' ? '✅' : '❌', `申诉${a.status === 'accepted' ? '成立' : '驳回'}`, a.id, 'appeal')
    })
    events.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    const activity = events.slice(0, 20)

    // 风险信号
    const risks: { severity: string; label: string; detail: string }[] = []
    const failedAttempts = Number(user.failed_attempts ?? 0)
    if (failedAttempts >= 3) risks.push({ severity: 'medium', label: '近期多次登录失败', detail: `${failedAttempts} 次` })
    if (user.locked_until && new Date(user.locked_until as string).getTime() > Date.now()) {
      risks.push({ severity: 'high', label: '账户已锁定', detail: `解锁: ${user.locked_until}` })
    }
    const openDisputes = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM disputes WHERE defendant_id = ? AND status IN ('open','in_review')", [id]))!.n
    if (openDisputes > 0) risks.push({ severity: 'medium', label: '未结争议作为被告', detail: `${openDisputes} 起` })
    const lostCount = (await dbOne<{ n: number }>("SELECT COUNT(*) as n FROM disputes WHERE defendant_id = ? AND ruling_type IN ('refund_buyer','partial_refund')", [id]))!.n
    if (lostCount > 0) risks.push({ severity: 'low', label: '历史仲裁判输', detail: `${lostCount} 次` })
    if (wallet && Number(wallet.staked) > Number(wallet.balance) * 2) {
      risks.push({ severity: 'low', label: '钱包大额锁定', detail: `锁定 ${Number(wallet.staked).toFixed(2)} / 余 ${Number(wallet.balance).toFixed(2)}` })
    }
    if (vw && Number(vw.error_count_180d) >= 1 && !vw.is_system) {
      const ec = Number(vw.error_count_180d)
      risks.push({ severity: ec >= 2 ? 'high' : 'medium', label: '审核员近期错误', detail: `180 天 ${ec} 次` })
    }

    const audit = (await dbAll<Record<string, unknown>>(`
      SELECT al.id, al.admin_id, al.action, al.detail, al.created_at,
             u.name as admin_name
      FROM admin_audit_log al
      LEFT JOIN users u ON u.id = al.admin_id
      WHERE al.target_type = 'user' AND al.target_id = ?
      ORDER BY al.created_at DESC LIMIT 20
    `, [id])).map(r => ({
      ...r,
      detail: r.detail ? (() => { try { return JSON.parse(r.detail as string) } catch { return r.detail } })() : null,
    }))

    res.json({
      basic: {
        id: user.id, name: user.name,
        role: user.role,
        roles: Array.from(roleSet),
        api_key_masked: maskApiKey(user.api_key as string),
        created_at: user.created_at, updated_at: user.updated_at,
        email: user.email, email_verified: !!user.email_verified,
        phone: user.phone, phone_verified: !!user.phone_verified,
        has_password: !!user.password_hash,
        reputation: user.reputation,
        failed_attempts: user.failed_attempts ?? 0,
        locked_until: user.locked_until,
        l1_share_override:   Number(user.l1_share_override ?? 0),
        can_l1_share:        isAllowedSponsor(user.id as string),
      },
      wallet: wallet ?? null,
      moderation: mod ?? null,
      tags,
      kpis,
      activity,
      risks,
      audit,
    })
  })
}
