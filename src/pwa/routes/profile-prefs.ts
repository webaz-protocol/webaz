/**
 * Profile 偏好设置域
 *
 * 由 #1013 Phase 58 从 src/pwa/server.ts 抽出。
 *
 * 3 endpoints:
 *   POST  /api/profile/default-address   保存默认配送地址（兼容旧 text/region + 新结构化）
 *   PATCH /api/profile/feed-visible      隐私开关（旧 API，向后兼容）
 *   PATCH /api/profile                   通用 patch — search_anchor / bio / feed_visible 一次更新
 *
 * 默认地址：
 *   - 兼容旧调用：传 text/region → 直接存
 *   - 结构化：line1/country/state/city/recipient_name/phone1 必填，自动派生 text + region
 *
 * 字段边界：search_anchor ≤ 40 / bio ≤ 120 / text ≤ 200
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface ProfilePrefsDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerProfilePrefsRoutes(app: Application, deps: ProfilePrefsDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbRun),不再直接用 deps.db
  const { auth } = deps

  // 默认地址（结构化 + 兼容旧 text/region）
  app.post('/api/profile/default-address', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const body = req.body || {}

    // 兼容旧 API
    if (body.text !== undefined || body.region !== undefined) {
      const text = (body.text || '').toString().trim().slice(0, 200)
      const region = (body.region || '').toString().trim().slice(0, 40)
      await dbRun("UPDATE users SET default_address_text = ?, default_address_region = ?, updated_at = datetime('now') WHERE id = ?",
        [text || null, region || null, user.id])
      return void res.json({ ok: true, text: text || null, region: region || null })
    }

    // 结构化模式
    const line1     = (body.line1     || '').toString().trim().slice(0, 100)
    const line2     = (body.line2     || '').toString().trim().slice(0, 100)
    const country   = (body.country   || '').toString().trim().slice(0, 40)
    const state     = (body.state     || '').toString().trim().slice(0, 40)
    const city      = (body.city      || '').toString().trim().slice(0, 40)
    const recipient = (body.recipient_name || '').toString().trim().slice(0, 40)
    const phone1    = (body.phone1    || '').toString().trim().slice(0, 30)
    const phone2    = (body.phone2    || '').toString().trim().slice(0, 30)
    const postal    = (body.postal_code || '').toString().trim().slice(0, 20)

    const missing = []
    if (!line1)     missing.push('地址行 1')
    if (!country)   missing.push('国家/地区')
    if (!state)     missing.push('省/州')
    if (!city)      missing.push('城市')
    if (!recipient) missing.push('收件人姓名')
    if (!phone1)    missing.push('主要联系方式')
    if (missing.length > 0) {
      return void res.json({ error: '以下必填项缺失：' + missing.join('、') })
    }

    const structured = { line1, line2, country, state, city, recipient_name: recipient, phone1, phone2, postal_code: postal }
    const text = [recipient, `${country} ${state} ${city}`.trim(), line1, line2, postal, phone1].filter(Boolean).join(' / ').slice(0, 200)
    await dbRun("UPDATE users SET default_address_text = ?, default_address_region = ?, default_address_json = ?, updated_at = datetime('now') WHERE id = ?",
      [text || null, state || null, JSON.stringify(structured), user.id])
    res.json({ ok: true, address: structured, derived_text: text, derived_region: state })
  })

  // 隐私开关（旧 API，向后兼容；新代码用 PATCH /api/profile）
  app.patch('/api/profile/feed-visible', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const v = req.body?.visible ? 1 : 0
    await dbRun("UPDATE users SET feed_visible = ?, updated_at = datetime('now') WHERE id = ?", [v, user.id])
    res.json({ ok: true, feed_visible: v })
  })

  // 通用 profile patch（search_anchor / bio / feed_visible）
  app.patch('/api/profile', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const updates: string[] = []
    const values: unknown[] = []

    if ('search_anchor' in (req.body || {})) {
      const raw = (req.body.search_anchor || '').toString().trim()
      if (raw.length > 40) return void res.json({ error: 'search_anchor 不能超过 40 字符' })
      if (raw && !/^[\w一-龥\-_\.]+$/.test(raw)) return void res.json({ error: 'search_anchor 仅允许字母/数字/汉字/-_.' })
      updates.push('search_anchor = ?')
      values.push(raw || null)
    }
    if ('bio' in (req.body || {})) {
      const raw = (req.body.bio || '').toString().trim()
      if (raw.length > 120) return void res.json({ error: 'bio 不能超过 120 字符' })
      updates.push('bio = ?')
      values.push(raw || null)
    }
    if ('feed_visible' in (req.body || {})) {
      updates.push('feed_visible = ?')
      values.push(req.body.feed_visible ? 1 : 0)
    }
    if (updates.length === 0) return void res.json({ error: '没有可更新的字段' })

    updates.push(`updated_at = datetime('now')`)
    values.push(user.id)
    await dbRun(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values)
    const u = (await dbOne<Record<string, unknown>>("SELECT search_anchor, bio, feed_visible FROM users WHERE id = ?", [user.id]))!
    res.json({ ok: true, search_anchor: u.search_anchor, bio: u.bio, feed_visible: Number(u.feed_visible ?? 1) })
  })
}
