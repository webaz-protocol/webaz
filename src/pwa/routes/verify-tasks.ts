/**
 * Verify tasks — 卖家提交验证码 → 验证池分配 → 验证者提交
 *
 * 由 #1013 Phase 72 从 src/pwa/server.ts 抽出。
 *
 * 7 endpoints:
 *   POST /api/verify-tasks/:id/confirm           卖家确认已添加 code → 进入验证池
 *   GET  /api/verify-tasks/by-product/:productId 卖家查商品进行中的任务
 *   GET  /api/verify-tasks/my-claims             卖家查自己发起的所有任务
 *   GET  /api/verify-tasks/mine                  验证者查分配给我的（含 stats）
 *   POST /api/verify-tasks/:id/submit            验证者提交结果（满人自动结算）
 *   GET  /api/verify-tasks/open                  公开验证大厅（仅展示分配给我的未提交）
 *   GET  /api/verify-stats                       验证者个人统计
 *
 * 跨域注入：auth + assignVerifiers + settleTask + getVerifierStats
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface VerifyTasksDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  assignVerifiers: (taskId: string) => void
  settleTask: (taskId: string) => void
  getVerifierStats: (userId: string) => unknown
}

export function registerVerifyTasksRoutes(app: Application, deps: VerifyTasksDeps): void {
  // 只读/单写站点走 RFC-016 异步 seam;db 保留:submit 是"提交→封顶→结算"裁决资金路径,
  // 提交 CAS + 计票 + seal-CAS 必须原子(db.transaction);settleTask(发奖/扣权,server.ts 无状态门)
  // 在 tx 提交后只对真正封顶的那一票触发,防并发双结算双发奖。Phase 3 迁 pg 行锁。
  const { db, auth, assignVerifiers, settleTask, getVerifierStats } = deps

  // 卖家确认：已在原平台添加验证码 → 任务进入分配池
  app.post('/api/verify-tasks/:id/confirm', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const task = await dbOne<Record<string, unknown>>(`SELECT * FROM verify_tasks WHERE id = ? AND status IN ('code_issued','open')`, [req.params.id])
    if (!task) return void res.json({ error: '任务不存在或已结束' })
    const product = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [task.product_id as string])
    if (!product || product.seller_id !== user.id) return void res.status(403).json({ error: '无权限' })
    if (task.status === 'open') {
      return void res.json({ success: true, already_open: true, message: '任务已在验证中，无需重复确认' })
    }
    await dbRun(`UPDATE verify_tasks SET status='open' WHERE id=?`, [req.params.id])
    try { assignVerifiers(req.params.id as string) } catch {}
    res.json({ success: true, message: '任务已提交到验证池，等待审核员确认' })
  })

  // 卖家：查询某商品的进行中验证任务（供编辑页展示验证码）
  app.get('/api/verify-tasks/by-product/:productId', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const product = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [req.params.productId])
    if (!product || product.seller_id !== user.id) return void res.status(403).json({ error: '无权限' })
    const tasks = await dbAll(`
      SELECT id, type, url, code, status, expires_at, created_at,
        (SELECT COUNT(*) FROM verify_submissions WHERE task_id = verify_tasks.id AND submitted_at IS NOT NULL) as submissions_done
      FROM verify_tasks WHERE product_id = ? AND status IN ('code_issued','open') ORDER BY created_at DESC
    `, [req.params.productId])
    res.json(tasks)
  })

  // 卖家：查询我发起的所有认领任务（用于"查看任务进度"页）
  app.get('/api/verify-tasks/my-claims', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const tasks = await dbAll(`
      SELECT vt.id, vt.type, vt.url, vt.code, vt.status, vt.result,
             vt.verifiers_needed, vt.expires_at, vt.created_at, vt.settled_at,
             p.title as product_title, p.id as product_id,
             (SELECT COUNT(*) FROM verify_submissions WHERE task_id=vt.id AND submitted_at IS NOT NULL) as submissions_done
      FROM verify_tasks vt
      JOIN products p ON vt.product_id = p.id
      WHERE p.seller_id = ?
      ORDER BY vt.created_at DESC
      LIMIT 30
    `, [user.id])
    res.json(tasks)
  })

  app.get('/api/verify-tasks/mine', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const tasks = await dbAll(`
      SELECT vt.id, vt.type, vt.url, vt.verifiers_needed, vt.reward_per_verifier, vt.expires_at,
        vs.id as sub_id, vs.submitted_at, vs.verdict,
        (SELECT COUNT(*) FROM verify_submissions WHERE task_id = vt.id AND submitted_at IS NOT NULL) as submissions_done
      FROM verify_tasks vt
      JOIN verify_submissions vs ON vs.task_id = vt.id AND vs.verifier_id = ?
      WHERE vt.status = 'open'
      ORDER BY vt.created_at DESC
    `, [user.id])
    const stats = getVerifierStats(user.id as string)
    res.json({ tasks, stats })
  })

  // 验证者：提交验证结果（填入式）
  app.post('/api/verify-tasks/:id/submit', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const { submission } = req.body

    const sub = await dbOne<Record<string, unknown>>(`SELECT * FROM verify_submissions WHERE task_id = ? AND verifier_id = ?`,
      [req.params.id, user.id])
    if (!sub) return void res.json({ error: '未分配到此任务' })
    if (sub.submitted_at) return void res.json({ error: '已提交过' })

    const task = await dbOne<Record<string, unknown>>('SELECT * FROM verify_tasks WHERE id = ? AND status = ?', [req.params.id, 'open'])
    if (!task) return void res.json({ error: '任务已结束或不存在' })
    if (new Date(task.expires_at as string) < new Date()) return void res.json({ error: '任务已过期' })

    // 裁决原子段:CAS 写本验证者未提交的行(防同人并发双提交)→ 计票 → 达标则 CAS 翻 open→settling。
    // 返回 didReach=true 仅给真正把任务翻到结算态的那一票。
    const submissionText = (submission ?? '').trim()
    let didReach = false
    try {
      didReach = db.transaction(() => {
        const upd = db.prepare(`UPDATE verify_submissions SET submission=?, submitted_at=datetime('now') WHERE task_id=? AND verifier_id=? AND submitted_at IS NULL`)
          .run(submissionText, req.params.id, user.id)
        if (upd.changes === 0) throw new Error('ALREADY_SUBMITTED')
        const doneCount = (db.prepare(`SELECT COUNT(*) as n FROM verify_submissions WHERE task_id = ? AND submitted_at IS NOT NULL`).get(req.params.id) as { n: number }).n
        if (doneCount < (task.verifiers_needed as number)) return false
        const seal = db.prepare(`UPDATE verify_tasks SET status='settling' WHERE id=? AND status='open'`).run(req.params.id)
        return seal.changes === 1
      })()
    } catch (e) {
      if ((e as Error).message === 'ALREADY_SUBMITTED') return void res.json({ error: '已提交过' })
      console.error('[verify-tasks submit tx]', (e as Error).message)
      return void res.status(500).json({ error: '提交失败,请重试' })
    }

    // 结算在事务提交后只对触发封顶的那一票执行(settleTask 自身写 status='settled' + 发奖)。
    if (didReach) settleTask(req.params.id as string)

    res.json({ success: true, message: '提交成功，等待其他验证者完成后自动结算' })
  })

  // 公开验证大厅 — 仅显示分配给我的未提交任务
  app.get('/api/verify-tasks/open', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const tasks = await dbAll(`
      SELECT vt.id, vt.type, vt.url, vt.reward_per_verifier, vt.expires_at,
        (SELECT COUNT(*) FROM verify_submissions WHERE task_id=vt.id AND submitted_at IS NOT NULL) as done,
        vt.verifiers_needed
      FROM verify_tasks vt
      JOIN verify_submissions vs ON vs.task_id = vt.id AND vs.verifier_id = ? AND vs.submitted_at IS NULL
      WHERE vt.status = 'open'
      ORDER BY vt.created_at ASC
      LIMIT 10
    `, [user.id])
    res.json(tasks)
  })

  app.get('/api/verify-stats', (req, res) => {
    const user = auth(req, res); if (!user) return
    res.json(getVerifierStats(user.id as string))
  })
}
