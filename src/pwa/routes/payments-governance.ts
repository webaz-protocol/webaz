/**
 * 治理参数 + 支付方法管理域
 *
 * 由 #1013 Phase 14 从 src/pwa/server.ts 抽出。两个相关基础设施域合并：
 *   - 治理参数公示（COP transparency — protocol_params + 变更日志）
 *   - 支付方法基础设施（payment_methods + region_payment_methods CRUD，admin only）
 *
 * 13 endpoints:
 *   GET    /api/governance/params                        — 全部协议参数 + 最近 5 条变更
 *   GET    /api/governance/params/:key/history           — 某参数完整变更历史
 *   GET    /api/payment-methods                          — 公共列表（active + preview）
 *   GET    /api/payment-methods/for-region               — 某 region 可用方法（fallback global）
 *   GET    /api/payment-methods/log                      — 公共审计日志（COP transparency）
 *   GET    /api/admin/payment-methods                    — admin 全量
 *   POST   /api/admin/payment-methods                    — 创建
 *   PUT    /api/admin/payment-methods/:id                — 修改
 *   DELETE /api/admin/payment-methods/:id                — 删除（usdc_base 不可删）
 *   GET    /api/admin/region-payment-methods             — region mapping 列表
 *   POST   /api/admin/region-payment-methods             — 创建 mapping
 *   PUT    /api/admin/region-payment-methods/:id         — 修改 mapping
 *   DELETE /api/admin/region-payment-methods/:id         — 删除 mapping (global×usdc_base 不可删)
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

const PAYMENT_METHOD_KINDS = new Set(['crypto_onchain', 'bank_wire', 'card', 'mobile_wallet', 'p2p'])
const PAYMENT_METHOD_STATUSES = new Set(['active', 'preview', 'inactive', 'deprecated'])
const RPM_DIRECTIONS = new Set(['deposit', 'withdraw', 'both'])
const RPM_STATUSES = new Set(['active', 'paused', 'blocked'])

export interface PaymentsGovernanceDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  requireRootAdmin: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerPaymentsGovernanceRoutes(app: Application, deps: PaymentsGovernanceDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { generateId, requireRootAdmin } = deps

  // 写支付变更审计日志
  async function logPaymentChange(entity_kind: 'method' | 'region_mapping', entity_id: string, action: string, oldValue: unknown, newValue: unknown, changed_by: string, reason?: string): Promise<void> {
    await dbRun(`INSERT INTO payment_methods_log (entity_kind, entity_id, action, old_value, new_value, changed_by, reason) VALUES (?,?,?,?,?,?,?)`,
      [entity_kind, entity_id, action,
      oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue),
      changed_by, reason ?? null])
  }

  // ─── 治理参数 ────────────────────────────────────────────────
  app.get('/api/governance/params', async (_req, res) => {
    const params = await dbAll<Record<string, unknown>>(`
      SELECT key, value, type, description, category, default_value, min_value, max_value, updated_at
      FROM protocol_params
      ORDER BY category, key
    `)
    // 每个参数附最近 5 条变更
    for (const p of params) {
      const recent = await dbAll(`
        SELECT old_value, new_value, action, created_at
        FROM protocol_params_log
        WHERE key = ?
        ORDER BY id DESC LIMIT 5
      `, [p.key])
      p.recent_changes = recent
    }
    res.json({
      notice: 'WebAZ 协议参数公示 — COP 团队自约束：所有参数变更必须可被任何人查询。',
      params,
      last_change: (await dbOne(`SELECT key, old_value, new_value, action, created_at FROM protocol_params_log ORDER BY id DESC LIMIT 1`)) || null,
    })
  })

  app.get('/api/governance/params/:key/history', async (req, res) => {
    const param = await dbOne(`SELECT * FROM protocol_params WHERE key = ?`, [req.params.key])
    if (!param) return void res.status(404).json({ error: 'param not found' })
    const history = await dbAll(`
      SELECT id, old_value, new_value, action, created_at,
        (SELECT name FROM users WHERE id = protocol_params_log.changed_by) as changed_by_name
      FROM protocol_params_log
      WHERE key = ?
      ORDER BY id DESC LIMIT 100
    `, [req.params.key])
    res.json({ param, history })
  })

  // ─── 公共支付方法 ───────────────────────────────────────────
  app.get('/api/payment-methods', async (_req, res) => {
    const rows = await dbAll(
      `SELECT id, display_name, display_name_en, kind, asset, chain, contract_address, decimals, icon, status, watcher_status, notes
       FROM payment_methods WHERE status IN ('active','preview') ORDER BY status DESC, kind, asset`,
    )
    res.json({ items: rows })
  })

  // 某地区可用方法（fallback 到 global）
  app.get('/api/payment-methods/for-region', async (req, res) => {
    const region = String(req.query.region || 'global')
    const direction = String(req.query.direction || '')   // 'deposit' | 'withdraw' | '' (任意)
    if (direction && !RPM_DIRECTIONS.has(direction)) {
      return void res.status(400).json({ error: `direction 必须是 ${[...RPM_DIRECTIONS].join(' / ')}` })
    }
    const rowsRegion = await dbAll<Record<string, unknown>>(`
      SELECT rpm.region, rpm.method_id, rpm.direction, rpm.status, rpm.min_amount, rpm.max_amount, rpm.daily_cap, rpm.notes,
        pm.display_name, pm.display_name_en, pm.kind, pm.asset, pm.chain, pm.icon, pm.status as method_status, pm.watcher_status
      FROM region_payment_methods rpm JOIN payment_methods pm ON pm.id = rpm.method_id
      WHERE rpm.region = ? AND rpm.status = 'active' AND pm.status IN ('active','preview')
    `, [region])
    const useFallback = rowsRegion.length === 0 && region !== 'global'
    const finalRegion = useFallback ? 'global' : region
    const rows = useFallback ? await dbAll<Record<string, unknown>>(`
      SELECT rpm.region, rpm.method_id, rpm.direction, rpm.status, rpm.min_amount, rpm.max_amount, rpm.daily_cap, rpm.notes,
        pm.display_name, pm.display_name_en, pm.kind, pm.asset, pm.chain, pm.icon, pm.status as method_status, pm.watcher_status
      FROM region_payment_methods rpm JOIN payment_methods pm ON pm.id = rpm.method_id
      WHERE rpm.region = 'global' AND rpm.status = 'active' AND pm.status IN ('active','preview')
    `) : rowsRegion
    const filtered = direction
      ? rows.filter(r => r.direction === direction || r.direction === 'both')
      : rows
    res.json({ region: finalRegion, fallback_from: useFallback ? region : null, items: filtered })
  })

  // 公共变更审计日志（COP transparency）
  app.get('/api/payment-methods/log', async (req, res) => {
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50))
    const rows = await dbAll(
      `SELECT id, entity_kind, entity_id, action, old_value, new_value, changed_by, reason, created_at
       FROM payment_methods_log ORDER BY id DESC LIMIT ?`,
      [limit],
    )
    res.json({ items: rows })
  })

  // ─── Admin payment_methods CRUD（root admin only · 基础设施变更需根权限）─
  app.get('/api/admin/payment-methods', async (req, res) => {
    const user = requireRootAdmin(req, res); if (!user) return
    const rows = await dbAll(`SELECT * FROM payment_methods ORDER BY status DESC, kind, asset`)
    res.json({ items: rows })
  })

  app.post('/api/admin/payment-methods', async (req, res) => {
    const user = requireRootAdmin(req, res); if (!user) return
    const b = req.body as Record<string, unknown>
    const id = String(b.id || '').trim().toLowerCase()
    if (!/^[a-z0-9_]{3,40}$/.test(id)) return void res.status(400).json({ error: 'id 必须是 3-40 位 [a-z0-9_]（如 usdc_base）' })
    if (await dbOne(`SELECT 1 FROM payment_methods WHERE id = ?`, [id])) return void res.status(409).json({ error: 'id 已存在' })
    const display_name = String(b.display_name || '').trim()
    if (display_name.length < 1 || display_name.length > 60) return void res.status(400).json({ error: 'display_name 1-60 字' })
    const display_name_en = b.display_name_en ? String(b.display_name_en).slice(0, 60) : null
    const kind = String(b.kind || '')
    if (!PAYMENT_METHOD_KINDS.has(kind)) return void res.status(400).json({ error: `kind 必须是 ${[...PAYMENT_METHOD_KINDS].join(' / ')}` })
    const asset = String(b.asset || '').trim().toUpperCase()
    if (!/^[A-Z]{2,10}$/.test(asset)) return void res.status(400).json({ error: 'asset 必须是 2-10 位大写字母（如 USDC）' })
    const chain = b.chain ? String(b.chain).trim().toLowerCase().slice(0, 20) : null
    const contract_address = b.contract_address ? String(b.contract_address).trim().slice(0, 80) : null
    const decimals = Number.isFinite(Number(b.decimals)) ? Number(b.decimals) : 6
    if (decimals < 0 || decimals > 18) return void res.status(400).json({ error: 'decimals 0-18' })
    const icon = b.icon ? String(b.icon).slice(0, 8) : null
    const status = String(b.status || 'inactive')
    if (!PAYMENT_METHOD_STATUSES.has(status)) return void res.status(400).json({ error: `status 必须是 ${[...PAYMENT_METHOD_STATUSES].join(' / ')}` })
    const notes = b.notes ? String(b.notes).slice(0, 200) : null

    const newRow = { id, display_name, display_name_en, kind, asset, chain, contract_address, decimals, icon, status, watcher_status: 'unconfigured', notes }
    await dbRun(`INSERT INTO payment_methods (
      id, display_name, display_name_en, kind, asset, chain, contract_address, decimals, icon, status, watcher_status, notes, updated_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, display_name, display_name_en, kind, asset, chain, contract_address, decimals, icon, status, 'unconfigured', notes, user.id as string])
    await logPaymentChange('method', id, 'create', null, newRow, user.id as string, String(b.reason || ''))
    res.json({ ok: true, id })
  })

  app.put('/api/admin/payment-methods/:id', async (req, res) => {
    const user = requireRootAdmin(req, res); if (!user) return
    const id = req.params.id
    const existing = await dbOne<Record<string, unknown>>(`SELECT * FROM payment_methods WHERE id = ?`, [id])
    if (!existing) return void res.status(404).json({ error: 'not_found' })
    const b = req.body as Record<string, unknown>
    const updates: Record<string, unknown> = {}
    if (b.display_name !== undefined) {
      const v = String(b.display_name).trim()
      if (v.length < 1 || v.length > 60) return void res.status(400).json({ error: 'display_name 1-60 字' })
      updates.display_name = v
    }
    if (b.display_name_en !== undefined) updates.display_name_en = b.display_name_en ? String(b.display_name_en).slice(0, 60) : null
    if (b.status !== undefined) {
      if (!PAYMENT_METHOD_STATUSES.has(String(b.status))) return void res.status(400).json({ error: 'status 非法' })
      updates.status = String(b.status)
    }
    if (b.chain !== undefined) updates.chain = b.chain ? String(b.chain).trim().toLowerCase().slice(0, 20) : null
    if (b.contract_address !== undefined) updates.contract_address = b.contract_address ? String(b.contract_address).trim().slice(0, 80) : null
    if (b.decimals !== undefined) {
      const d = Number(b.decimals)
      if (!Number.isFinite(d) || d < 0 || d > 18) return void res.status(400).json({ error: 'decimals 0-18' })
      updates.decimals = d
    }
    if (b.icon !== undefined) updates.icon = b.icon ? String(b.icon).slice(0, 8) : null
    if (b.notes !== undefined) updates.notes = b.notes ? String(b.notes).slice(0, 200) : null
    if (b.watcher_status !== undefined) {
      const ws = String(b.watcher_status)
      if (!['active', 'unconfigured', 'failing'].includes(ws)) return void res.status(400).json({ error: 'watcher_status 非法' })
      updates.watcher_status = ws
    }
    if (Object.keys(updates).length === 0) return void res.status(400).json({ error: '无更新字段' })

    const cols = Object.keys(updates).map(k => `${k} = ?`).join(', ')
    const vals = Object.values(updates)
    await dbRun(`UPDATE payment_methods SET ${cols}, updated_at = datetime('now'), updated_by = ? WHERE id = ?`, [...vals, user.id as string, id])
    await logPaymentChange('method', id, 'update', existing, { ...existing, ...updates }, user.id as string, String(b.reason || ''))
    res.json({ ok: true })
  })

  app.delete('/api/admin/payment-methods/:id', async (req, res) => {
    const user = requireRootAdmin(req, res); if (!user) return
    const id = req.params.id
    if (id === 'usdc_base') return void res.status(400).json({ error: '默认协议方法 usdc_base 不可删除，可改为 deprecated 状态' })
    const existing = await dbOne<Record<string, unknown>>(`SELECT * FROM payment_methods WHERE id = ?`, [id])
    if (!existing) return void res.status(404).json({ error: 'not_found' })
    const refs = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM region_payment_methods WHERE method_id = ? AND status = 'active'`, [id]))!.n
    if (refs > 0) return void res.status(409).json({ error: `还有 ${refs} 条 active 区域映射引用该方法，请先停用` })
    await dbRun(`DELETE FROM payment_methods WHERE id = ?`, [id])
    await logPaymentChange('method', id, 'delete', existing, null, user.id as string, String((req.body || {}).reason || ''))
    res.json({ ok: true })
  })

  // ─── region_payment_methods CRUD ──────────────────────────
  app.get('/api/admin/region-payment-methods', async (req, res) => {
    const user = requireRootAdmin(req, res); if (!user) return
    const where: string[] = []
    const params: unknown[] = []
    if (req.query.region) { where.push('rpm.region = ?'); params.push(String(req.query.region)) }
    if (req.query.method_id) { where.push('rpm.method_id = ?'); params.push(String(req.query.method_id)) }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = await dbAll(`
      SELECT rpm.*, pm.display_name, pm.display_name_en, pm.icon, pm.asset, pm.chain
      FROM region_payment_methods rpm JOIN payment_methods pm ON pm.id = rpm.method_id
      ${whereSql}
      ORDER BY rpm.region, pm.kind, pm.asset
    `, params)
    res.json({ items: rows })
  })

  app.post('/api/admin/region-payment-methods', async (req, res) => {
    const user = requireRootAdmin(req, res); if (!user) return
    const b = req.body as Record<string, unknown>
    const region = String(b.region || '').trim().toLowerCase()
    if (!/^[a-z_]{2,20}$/.test(region)) return void res.status(400).json({ error: 'region 必须是 2-20 位 [a-z_]' })
    const method_id = String(b.method_id || '')
    if (!(await dbOne(`SELECT 1 FROM payment_methods WHERE id = ?`, [method_id]))) return void res.status(404).json({ error: 'method_id 不存在' })
    const direction = String(b.direction || 'both')
    if (!RPM_DIRECTIONS.has(direction)) return void res.status(400).json({ error: `direction 必须是 ${[...RPM_DIRECTIONS].join(' / ')}` })
    const status = String(b.status || 'active')
    if (!RPM_STATUSES.has(status)) return void res.status(400).json({ error: `status 必须是 ${[...RPM_STATUSES].join(' / ')}` })
    const min_amount = b.min_amount != null ? Math.max(0, Number(b.min_amount)) : 0
    const max_amount = b.max_amount != null && b.max_amount !== '' ? Math.max(0, Number(b.max_amount)) : null
    const daily_cap = b.daily_cap != null && b.daily_cap !== '' ? Math.max(0, Number(b.daily_cap)) : null
    if (max_amount != null && min_amount > max_amount) return void res.status(400).json({ error: 'min_amount 不能大于 max_amount' })
    const notes = b.notes ? String(b.notes).slice(0, 200) : null
    const id = generateId('rpm')
    try {
      await dbRun(`INSERT INTO region_payment_methods (
        id, region, method_id, direction, status, min_amount, max_amount, daily_cap, notes, updated_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id, region, method_id, direction, status, min_amount, max_amount, daily_cap, notes, user.id as string])
    } catch (e) {
      if (String(e).includes('UNIQUE')) return void res.status(409).json({ error: '同一 region + method + direction 已存在' })
      throw e
    }
    await logPaymentChange('region_mapping', id, 'create', null,
      { region, method_id, direction, status, min_amount, max_amount, daily_cap, notes }, user.id as string, String(b.reason || ''))
    res.json({ ok: true, id })
  })

  app.put('/api/admin/region-payment-methods/:id', async (req, res) => {
    const user = requireRootAdmin(req, res); if (!user) return
    const id = req.params.id
    const existing = await dbOne<Record<string, unknown>>(`SELECT * FROM region_payment_methods WHERE id = ?`, [id])
    if (!existing) return void res.status(404).json({ error: 'not_found' })
    const b = req.body as Record<string, unknown>
    const updates: Record<string, unknown> = {}
    if (b.status !== undefined) {
      if (!RPM_STATUSES.has(String(b.status))) return void res.status(400).json({ error: 'status 非法' })
      updates.status = String(b.status)
    }
    if (b.min_amount !== undefined) updates.min_amount = Math.max(0, Number(b.min_amount))
    if (b.max_amount !== undefined) updates.max_amount = b.max_amount === null || b.max_amount === '' ? null : Math.max(0, Number(b.max_amount))
    if (b.daily_cap !== undefined) updates.daily_cap = b.daily_cap === null || b.daily_cap === '' ? null : Math.max(0, Number(b.daily_cap))
    if (b.notes !== undefined) updates.notes = b.notes ? String(b.notes).slice(0, 200) : null
    if (Object.keys(updates).length === 0) return void res.status(400).json({ error: '无更新字段' })
    // min/max 交叉校验
    const newMin = updates.min_amount != null ? Number(updates.min_amount) : Number(existing.min_amount)
    const newMax = updates.max_amount !== undefined ? (updates.max_amount as number | null) : (existing.max_amount as number | null)
    if (newMax != null && newMin > newMax) return void res.status(400).json({ error: 'min_amount 不能大于 max_amount' })

    const cols = Object.keys(updates).map(k => `${k} = ?`).join(', ')
    const vals = Object.values(updates)
    await dbRun(`UPDATE region_payment_methods SET ${cols}, updated_at = datetime('now'), updated_by = ? WHERE id = ?`, [...vals, user.id as string, id])
    await logPaymentChange('region_mapping', id, 'update', existing, { ...existing, ...updates }, user.id as string, String(b.reason || ''))
    res.json({ ok: true })
  })

  app.delete('/api/admin/region-payment-methods/:id', async (req, res) => {
    const user = requireRootAdmin(req, res); if (!user) return
    const id = req.params.id
    const existing = await dbOne<Record<string, unknown>>(`SELECT * FROM region_payment_methods WHERE id = ?`, [id])
    if (!existing) return void res.status(404).json({ error: 'not_found' })
    if (existing.region === 'global' && existing.method_id === 'usdc_base') {
      return void res.status(400).json({ error: '默认协议映射 global × usdc_base 不可删除' })
    }
    await dbRun(`DELETE FROM region_payment_methods WHERE id = ?`, [id])
    await logPaymentChange('region_mapping', id, 'delete', existing, null, user.id as string, String((req.body || {}).reason || ''))
    res.json({ ok: true })
  })
}
