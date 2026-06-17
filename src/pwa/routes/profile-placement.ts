/**
 * Profile 放置挂靠 (placement) 域
 *
 * 由 #1013 Phase 56 从 src/pwa/server.ts 抽出。
 *
 * 3 endpoints:
 *   GET  /api/profile/placement-status   查挂靠状态（孤儿 / 已绑 / 有下线）
 *   POST /api/profile/bind-placement     补绑（仅孤儿可绑；防环路；多形态识别）
 *   POST /api/profile/placement-pref     长期偏好（team_count / pv_count）
 *
 * 边界：
 *   - 已有 placement → 拒（永久第一触点不可改）
 *   - 已有下线 → 拒（防破坏树结构）
 *   - inviter 不能是自己；不能形成环路
 *   - placement_pref 仅 team_count / pv_count，legacy left/right 静默折算
 *
 * 跨域注入：
 *   - resolveUserRef（多形态 usr_/permanent_code/@handle 解析）
 *   - pickPreferredSide / joinPowerLeg（放置树引擎）
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface ProfilePlacementDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  internalAuditorId: string
  resolveUserRef: (raw: string | null | undefined) => string | null
  // invite-code-ONLY resolver (permanent_code [+ -L/-R]); the binary-tree bind entry uses this, not resolveUserRef
  resolveInviteCodeRef: (raw: string) => { userId: string; code: string; side: 'left' | 'right' | null } | null
  pickPreferredSide: (inviterId: string) => 'left' | 'right'
  joinPowerLeg: (inviterId: string, side: 'left' | 'right', newUserId: string) => { depth: number }
}

export function registerProfilePlacementRoutes(app: Application, deps: ProfilePlacementDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbRun),不再直接用 deps.db
  const { auth, internalAuditorId, resolveInviteCodeRef, pickPreferredSide, joinPowerLeg } = deps

  app.get('/api/profile/placement-status', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const u = await dbOne<Record<string, unknown>>("SELECT placement_id, placement_side, left_child_id, right_child_id, placement_pref FROM users WHERE id = ?", [user.id])
    const hasPlacement = !!u?.placement_id
    const hasDownline  = !!u?.left_child_id || !!u?.right_child_id
    res.json({
      has_placement: hasPlacement,
      has_downline:  hasDownline,
      can_bind:      !hasPlacement && !hasDownline,
      placement_pref: u?.placement_pref || 'team_count',
      placement_id:  u?.placement_id,
      placement_side: u?.placement_side,
    })
  })

  app.post('/api/profile/bind-placement', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { inviter_id } = req.body
    if (!inviter_id || typeof inviter_id !== 'string') return void res.json({ error: '请提供 inviter_id' })
    // invite-code ONLY: 6-7 位 permanent_code。usr_xxx / @handle / 裸 handle 不再接受 —
    // 这是积分树关系绑定入口,必须与收窄后的邀请面一致。
    const ref = resolveInviteCodeRef(inviter_id)
    if (!ref) return void res.json({ error: 'inviter 邀请码无效（仅 6-7 位永久码）' })
    const resolvedInviterId = ref.userId
    if (resolvedInviterId === user.id) return void res.json({ error: '不能挂靠到自己' })

    const u = await dbOne<Record<string, unknown>>("SELECT placement_id, left_child_id, right_child_id FROM users WHERE id = ?", [user.id])
    if (u?.placement_id)                       return void res.json({ error: '你已在放置树中（永久第一触点，不可改）' })
    if (u?.left_child_id || u?.right_child_id) return void res.json({ error: '你已有下线，不可补绑（防破坏树结构）' })

    const inviter = await dbOne<{ id: string; placement_path: string | null }>("SELECT id, placement_path FROM users WHERE id = ? AND id NOT IN ('sys_protocol', ?)",
      [resolvedInviterId, internalAuditorId])
    if (!inviter) return void res.json({ error: 'inviter 不存在' })
    // 环路检查：inviter 的 placement_path 不能含自己
    if ((inviter.placement_path || '').split('>').includes(user.id as string)) {
      return void res.json({ error: '检测到环路（你已是 inviter 的上线）' })
    }

    // pre-public 去左右码:忽略用户/邀请码指定的左右侧,放置侧别永远由系统自动决定
    const chosenSide: 'left' | 'right' = pickPreferredSide(inviter.id)
    try {
      const placed = joinPowerLeg(inviter.id, chosenSide, user.id as string)
      res.json({ success: true, inviter_id: inviter.id, side: chosenSide, depth: placed.depth })
    } catch (e) {
      res.json({ error: `挂靠失败: ${(e as Error).message}` })
    }
  })

  app.post('/api/profile/placement-pref', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { pref } = req.body
    if (!['team_count', 'pv_count', 'left', 'right'].includes(pref)) {
      return void res.json({ error: 'pref 必须是 team_count / pv_count' })
    }
    // legacy left/right 已不再支持长期强偏，无声折算为 team_count（agent 兼容期保护）
    const stored = (pref === 'left' || pref === 'right') ? 'team_count' : pref
    await dbRun("UPDATE users SET placement_pref = ?, updated_at = datetime('now') WHERE id = ?", [stored, user.id as string])
    res.json({ success: true, placement_pref: stored, coerced: stored !== pref ? `${pref} → ${stored}（已统一为长期默认偏好）` : undefined })
  })
}
