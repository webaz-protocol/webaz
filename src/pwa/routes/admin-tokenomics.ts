/**
 * Admin: Tokenomics 域 — 注册门控 + 中性参与/佣金统计
 *
 * 由 #1013 Phase 62 从 src/pwa/server.ts 抽出。
 * 匹配奖励的 tier 编辑器 / 管理津贴 / 池注资 endpoints 已随匹配引擎切除(#401)移除。
 *
 * 2 endpoints:
 *   GET  /api/admin/tokenomics                          中性统计(pv_ledger + 佣金高额榜)
 *   POST /api/admin/tokenomics/require-ref/toggle       注册必须 ref 开关
 *
 * 权限：全部 protocol 权限（区域 admin 不能改）
 *
 * 跨域注入：requireProtocolAdmin + logAdminAction
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminTokenomicsDeps {
  db: Database.Database
  requireProtocolAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
}

export function registerAdminTokenomicsRoutes(app: Application, deps: AdminTokenomicsDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { requireProtocolAdmin, logAdminAction } = deps

  // Tokenomics 详细数据 + Tier 配置 + 高额榜
  app.get('/api/admin/tokenomics', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    // matching-rewards admin views (tier config / binary leaderboard / mgmt-bonus / pool injection) removed —
    // engine excised (#401). Only neutral participation-record + affiliate-commission stats remain.
    const topComm = await dbAll(`
      SELECT cr.beneficiary_id, u.name, COUNT(*) as records, COALESCE(SUM(cr.amount),0) as earned
      FROM commission_records cr LEFT JOIN users u ON u.id = cr.beneficiary_id
      WHERE cr.beneficiary_id != 'sys_protocol'
      GROUP BY cr.beneficiary_id ORDER BY earned DESC LIMIT 10
    `)
    const pvLedger = await dbOne(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN processed=0 THEN 1 ELSE 0 END) as pending,
        COALESCE(SUM(CASE WHEN processed=0 THEN pv ELSE 0 END),0) as pending_pv
      FROM pv_ledger
    `)
    res.json({
      pv_ledger:      pvLedger,
      top_commission: topComm,
    })
  })

  // 注册必须 ref 开关
  app.post('/api/admin/tokenomics/require-ref/toggle', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const { enabled } = req.body
    const v = enabled ? '1' : '0'
    await dbRun("INSERT OR REPLACE INTO system_state (key, value) VALUES ('require_ref_to_register', ?)", [v])
    logAdminAction(admin.id as string, 'require_ref_toggle', 'system', 'require_ref_to_register', { value: v })
    res.json({ success: true, enabled: !!enabled })
  })
}
