/**
 * Admin: Hot wallet 状态 + 提现批准
 *
 * 由 #1013 Phase 69 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints（混合两套 auth）：
 *
 *   GET  /api/admin/hot-wallet/status     protocol perm + 详细指标（USDC + ETH + pending + shortfall）
 *   GET  /api/admin/hot-wallet            adminAuth (x-admin-key legacy) + 仅 USDC balance
 *   GET  /api/admin/withdrawals           adminAuth + 待处理提现列表
 *   POST /api/admin/withdrawals/:id/approve  adminAuth + executeWithdrawal
 *
 * 两套 auth 并存的原因：legacy 端点供 ops 脚本用 x-admin-key 调用，新端点走 RBAC。
 *
 * 跨域注入：requireProtocolAdmin + adminAuth + 链上 client + executeWithdrawal
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminWalletOpsDeps {
  db: Database.Database
  requireProtocolAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  adminAuth: (req: Request, res: Response) => boolean
  // viem 的 readContract 重载链非常复杂；这里用 any 接口对齐，调用端类型推断由源端保证
  // 用 getter 而非值是因为这些 const 在文件下游定义；register call 必须在 SPA catch-all 之前调用
  getPublicClient: () => any
  getUsdcAddr: () => any
  getUsdcAbi: () => any
  getHotWalletAddr: () => any
  wazToUsdc: (n: number) => number
  getIsMainnet: () => boolean
  getNetwork: () => string
  executeWithdrawal: (id: string) => Promise<{ success: true; txHash: string } | { success: false; error: string; txHash?: undefined }>
  // 审计:withdrawals/approve 是真实出金 → 必须留痕(治理审计铁律)。
  logAdminAction: (adminId: string, action: string, targetType: string | null, targetId: string | null, detail?: Record<string, unknown>) => void
  // 【双重受理过渡(dual-accept transition for attribution)】只读、不响应的 protocol-admin 解析器:
  // 登录的 protocol-admin(Bearer)→ 返回该 admin,审计记其真实 id;否则返回 null,回落到共享 ADMIN_KEY 路径。
  // 这只是【归属过渡】,不是最终安全收紧 —— 最终收紧(PWA/工具迁移后弃用 x-admin-key)留作后续 PR。
  resolveProtocolAdminSoft: (req: Request) => Record<string, unknown> | null
}

export function registerAdminWalletOpsRoutes(app: Application, deps: AdminWalletOpsDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbAll),不再直接用 deps.db
  const { requireProtocolAdmin, adminAuth, getPublicClient, getUsdcAddr, getUsdcAbi, getHotWalletAddr, wazToUsdc, getIsMainnet, getNetwork, executeWithdrawal, logAdminAction, resolveProtocolAdminSoft } = deps

  // P2-5: protocol 权限（区域 admin 看不到全局热钱包）
  app.get('/api/admin/hot-wallet/status', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    try {
      const pc = getPublicClient(); const hw = getHotWalletAddr()
      const usdcBal = await pc.readContract({
        address: getUsdcAddr(), abi: getUsdcAbi(), functionName: 'balanceOf', args: [hw],
      }) as bigint
      const ethBal = await pc.getBalance({ address: hw })
      const pending = (await dbOne<{ t: number }>("SELECT COALESCE(SUM(amount), 0) as t FROM withdrawal_requests WHERE status = 'pending'"))!
      const pendingUsdc = wazToUsdc(Number(pending.t))
      res.json({
        address: hw,
        usdc_balance: Number(usdcBal) / 1e6,
        eth_balance: Number(ethBal) / 1e18,
        pending_withdrawals_waz: pending.t,
        pending_withdrawals_usdc: pendingUsdc,
        shortfall_usdc: Math.max(0, pendingUsdc - Number(usdcBal) / 1e6),
        chain: getIsMainnet() ? 'base-mainnet' : 'base-sepolia',
        network: getNetwork(),
      })
    } catch (e) {
      res.status(500).json({ error: 'RPC 读取失败: ' + (e as Error).message })
    }
  })

  // Legacy x-admin-key 入口：仅余额
  app.get('/api/admin/hot-wallet', async (req, res) => {
    if (!adminAuth(req, res)) return
    const hw = getHotWalletAddr()
    try {
      const balance = await getPublicClient().readContract({
        address: getUsdcAddr(), abi: getUsdcAbi(),
        functionName: 'balanceOf', args: [hw],
      }) as bigint
      res.json({ address: hw, usdc_balance: Number(balance) / 1e6 })
    } catch (e) {
      res.json({ address: hw, usdc_balance: null, error: (e as Error).message })
    }
  })

  app.get('/api/admin/withdrawals', async (req, res) => {
    if (!adminAuth(req, res)) return
    const list = await dbAll(`
      SELECT wr.*, u.name as user_name
      FROM withdrawal_requests wr JOIN users u ON wr.user_id = u.id
      WHERE wr.status = 'pending' ORDER BY wr.created_at ASC
    `)
    res.json(list)
  })

  app.post('/api/admin/withdrawals/:id/approve', async (req, res) => {
    // 双重受理过渡鉴权:优先认登录的 protocol-admin(Bearer)→ 记其真实 admin id;
    // 否则回落到共享 ADMIN_KEY(adminAuth,既有运维路径,行为不变)→ actor 记中性标记 'admin_key'。
    // 仅认 protocol 权限的 admin;非 protocol 的 Bearer 不放行(soft 解析返回 null),不扩大访问面,只精确归属。
    let actorId = 'admin_key'
    let authMethod = 'admin_key'
    const bearerAdmin = resolveProtocolAdminSoft(req)
    if (bearerAdmin) {
      actorId = String(bearerAdmin.id)
      authMethod = 'bearer_admin'
    } else {
      if (!adminAuth(req, res)) return
    }
    // 出金前读取目标(user + amount),便于审计;执行后用真实 txHash 记一条 admin_audit_log。
    const wr = await dbOne<{ user_id: string; amount: number }>('SELECT user_id, amount FROM withdrawal_requests WHERE id = ?', [req.params.id])
    const result = await executeWithdrawal(req.params.id).catch(e => ({ success: false as const, error: (e as Error).message, txHash: undefined }))
    if (!result.success) return void res.json({ error: result.error })
    // 审计时机:仅在出金成功后写。actor = 真实 admin id(bearer_admin)或中性标记 'admin_key';不写任何密钥。
    try {
      logAdminAction(actorId, 'withdrawal_approve', 'withdrawal', req.params.id, {
        user_id: wr?.user_id ?? null, amount: wr?.amount ?? null, tx_hash: result.txHash, network: getNetwork(), auth_method: authMethod,
      })
    } catch (e) { console.error('[withdrawal_approve audit]', e) }
    res.json({ success: true, tx_hash: result.txHash })
  })
}
