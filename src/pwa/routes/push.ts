/**
 * PWA Push 通知订阅域 (Wave E-5)
 *
 * 由 #1013 Phase 31 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints:
 *   GET    /api/push/vapid-public-key     拿 VAPID 公钥（前端订阅用）
 *   POST   /api/push/subscribe            订阅（同 endpoint 重复 → update keys）
 *   DELETE /api/push/subscribe            取消订阅（可指定 endpoint，否则清空所有）
 *   GET    /api/push/status               检查订阅状态 + VAPID 是否配置
 *
 * 跨域 export：
 *   - cleanupStaleSubscription(db, endpoint) — web-push 接入后，发送返 404/410 时调用
 *
 * 配置：VAPID_PUBLIC_KEY 环境变量；未设时 vapid-public-key 返 503
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface PushDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  vapidPublicKey: string
}

/** web-push 失败回调：删除已失效订阅。导出以备 P1-5 任务调用。
 *  RFC-016: db 参数保留(调用方签名兼容),内部走异步 seam(同实例,setSeamDb)。 */
export async function cleanupStaleSubscription(_db: Database.Database, endpoint: string): Promise<void> {
  if (!endpoint) return
  await dbRun('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint])
}

export function registerPushRoutes(app: Application, deps: PushDeps): void {
  // db 已走 RFC-016 异步 seam(dbOne/dbRun),不再直接用 deps.db
  const { generateId, auth, vapidPublicKey } = deps

  app.get('/api/push/vapid-public-key', (_req, res) => {
    if (!vapidPublicKey) return void res.status(503).json({ error: '推送未配置，请联系管理员设置 VAPID_PUBLIC_KEY' })
    res.json({ key: vapidPublicKey })
  })

  app.post('/api/push/subscribe', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { endpoint, keys, user_agent } = req.body || {}
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return void res.status(400).json({ error: '订阅参数不完整（需 endpoint + keys.p256dh + keys.auth）' })
    }
    const id = generateId('psub')
    // 同 user + endpoint 视作重新订阅
    const existing = await dbOne<{ id: string }>('SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [user.id, String(endpoint)])
    if (existing) {
      await dbRun('UPDATE push_subscriptions SET p256dh = ?, auth = ?, user_agent = ?, enabled = 1 WHERE id = ?',
        [String(keys.p256dh), String(keys.auth), user_agent ? String(user_agent).slice(0, 200) : null, existing.id])
      return void res.json({ success: true, id: existing.id })
    }
    await dbRun(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent) VALUES (?,?,?,?,?,?)`,
      [id, user.id, String(endpoint), String(keys.p256dh), String(keys.auth), user_agent ? String(user_agent).slice(0, 200) : null])
    res.json({ success: true, id })
  })

  app.delete('/api/push/subscribe', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const { endpoint } = req.body || {}
    if (endpoint) {
      await dbRun('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [user.id, String(endpoint)])
    } else {
      await dbRun('DELETE FROM push_subscriptions WHERE user_id = ?', [user.id])
    }
    res.json({ success: true })
  })

  app.get('/api/push/status', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const cnt = (await dbOne<{ n: number }>('SELECT COUNT(*) as n FROM push_subscriptions WHERE user_id = ? AND enabled = 1', [user.id]))!.n
    res.json({ subscribed: cnt > 0, count: cnt, vapid_configured: !!vapidPublicKey })
  })
}
