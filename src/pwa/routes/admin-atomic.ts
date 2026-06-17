/**
 * Admin: 协议级原子操作（测试 + 紧急）
 *
 * 由 #1013 Phase 65 从 src/pwa/server.ts 抽出。
 *
 * 1 endpoint (matching settlement/payout removed — engine excised #401):
 *   POST /api/admin/atomic/process-ledger  手动跑 PV ledger(中性参与记录聚合)
 *
 * 权限：protocol（协议金库级）
 *
 * 跨域注入：requireProtocolAdmin + processPvLedger
 */
import type { Application, Request, Response } from 'express'

export interface AdminAtomicDeps {
  requireProtocolAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  processPvLedger: () => number
  runBinarySettlement: () => number
  executeSafeSettlementCron: () => Record<string, unknown>
  // 手动触发的协议级资金/结算操作 → 必须记录触发的 admin + 结果摘要(治理审计铁律)。
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
}

export function registerAdminAtomicRoutes(app: Application, deps: AdminAtomicDeps): void {
  // matching settlement / payout endpoints removed — engine excised (#401). Only neutral
  // participation-recording (process-ledger) remains. (runBinarySettlement / executeSafeSettlementCron
  // are still injected by the server but no longer wired to any endpoint here.)
  const { requireProtocolAdmin, processPvLedger, logAdminAction } = deps

  app.post('/api/admin/atomic/process-ledger', (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const processed = processPvLedger()
    logAdminAction(admin.id as string, 'atomic_process_ledger', 'protocol', null, { processed })
    res.json({ processed })
  })
}
