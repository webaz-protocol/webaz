/**
 * Profile 位置 (粗粒度地理) 域
 *
 * 由 #1013 Phase 57 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   POST /api/profile/set-location      设置粗粒度位置（按 protocol_param precision_deg 截断）
 *   POST /api/profile/clear-location    清除
 *
 * 隐私：
 *   - 服务端按当前 nearby_cell_precision protocol_param 截断（防客户端传精确坐标）
 *   - 所有存储遵循当前 cell 精度
 *   - lat ∈ [-90,90] / lng ∈ [-180,180]
 *
 * 跨域注入：getNearbyCellPrecision (与 /api/nearby 共享)
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

function quantizeCoord(value: number, precision_deg: number): number {
  // 例：precision=0.1 → factor=10；precision=0.05 → factor=20
  const factor = 1 / precision_deg
  return Math.round(value * factor) / factor
}

export interface ProfileLocationDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  getNearbyCellPrecision: () => { precision_deg: number; approx_km: number }
}

export function registerProfileLocationRoutes(app: Application, deps: ProfileLocationDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbRun),不再直接用 deps.db
  const { auth, getNearbyCellPrecision } = deps

  app.post('/api/profile/set-location', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rawLat = Number(req.body?.lat)
    const rawLng = Number(req.body?.lng)
    if (!Number.isFinite(rawLat) || !Number.isFinite(rawLng)) {
      return void res.json({ error: 'lat/lng 必须为有效数字' })
    }
    if (rawLat < -90 || rawLat > 90 || rawLng < -180 || rawLng > 180) {
      return void res.json({ error: 'lat/lng 超出地理范围' })
    }
    const { precision_deg, approx_km } = getNearbyCellPrecision()
    // 服务端截断（防客户端传精确坐标）
    const lat = quantizeCoord(rawLat, precision_deg)
    const lng = quantizeCoord(rawLng, precision_deg)
    await dbRun("UPDATE users SET geo_lat = ?, geo_lng = ?, geo_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      [lat, lng, user.id])
    res.json({ ok: true, lat, lng, precision_deg, approx_km })
  })

  app.post('/api/profile/clear-location', async (req, res) => {
    const user = auth(req, res); if (!user) return
    await dbRun("UPDATE users SET geo_lat = NULL, geo_lng = NULL, geo_updated_at = NULL WHERE id = ?", [user.id])
    res.json({ ok: true })
  })
}
