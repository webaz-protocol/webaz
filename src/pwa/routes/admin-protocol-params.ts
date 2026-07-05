/**
 * Admin: 协议参数配置域 (Wave F-2)
 *
 * 由 #1013 Phase 60 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints:
 *   GET   /api/admin/protocol-params               列全部参数
 *   PATCH /api/admin/protocol-params/:key          修改（type + min/max 校验 + 写 log + constitutional 守护）
 *   POST  /api/admin/protocol-params/:key/reset    重置为 default_value（constitutional 触发 only-increase 守护）
 *   GET   /api/admin/protocol-params/:key/history  变更历史
 *
 * 权限：
 *   - GET 列表 + history 只需 admin
 *   - PATCH + reset 需 protocol 权限（区域 admin 不能改全局参数）
 *
 * 类型校验：number（含 min_value/max_value 范围）/ boolean / 其他字符串
 *
 * 2026-06-03 task #1095 — CHARTER §4 I-4 宪法级修改保护(去人格化)
 * ─────────────────────────────────────────────────────────────────
 * `category='constitutional'` 的 param 触发 only-increase 锁(numeric only):
 *   - PATCH new value 必须 >= old value(允许等于,等于 = no-op)
 *   - Reset 若 default_value < current value 也拒绝
 *   - 修复防绕过:user 不能通过"先松保护再改一切"绕过宪法门槛
 *
 * ⚠️ **语义假设**:本实现假设 `category='constitutional'` 的 param 都满足
 * "increase = more protection" 语义:
 *   - `constitutional_supermajority_ratio`(高 → 更难修改 → 更多保护)✓
 *   - `constitutional_notice_days`(长 → 更多公示挑战时间 → 更多保护)✓
 * 未来添加 constitutional param 必须 evaluate 方向是否符合此语义;
 * 若反向(如 `*_max_emergency_window_days` 假设短=更保护),需 explicit override。
 *
 * 2026-06-03 task #1097 boot guard:server.ts 启动时 assert 所有 constitutional
 * param `type='number'`,防止 bool/string constitutional 被悄悄加入(only-increase
 * 锁只对 number 生效,bool/string 会静默失效)。详 src/pwa/server.ts 紧跟
 * DEFAULT_PARAMS 之后的 boot guard 段。
 *
 * 2026-06-03 task #1096 audit log:拒绝时(PATCH lower / reset lower)
 * INSERT protocol_params_log 行,action='constitutional_reject_patch' /
 * 'constitutional_reject_reset'。Meta-rule #1 "当一切可见":尝试降低宪法保护
 * 也要留痕,即便 attempt 被拒。log 写失败不阻塞 reject(reject 决定永远优先)。
 *
 * Phase A solo:user 1-of-1 单签,本机制守的是"未来 phase B+ 多签门槛
 * 不被悄悄降低"。详 docs/CHARTER.md §4 I-4。
 *
 * Multisig 收集器 / RFC bot / 60d 公示 Issue 跟踪 — phase B+ 实施,本 PR 不做。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminProtocolParamsDeps {
  db: Database.Database
  generateId: (prefix: string) => string
  requireAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  requireProtocolAdmin: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerAdminProtocolParamsRoutes(app: Application, deps: AdminProtocolParamsDeps): void {
  const { db, generateId, requireAdmin, requireProtocolAdmin } = deps

  app.get('/api/admin/protocol-params', async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return
    const rows = await dbAll(`SELECT key, value, type, description, category, default_value, min_value, max_value, updated_at, updated_by
      FROM protocol_params ORDER BY category, key`, [])
    res.json({ items: rows })
  })

  // H-2 P1-2: 协议参数是全局配置，需 protocol 权限（区域 admin 不能改）
  // 2026-06-03 #1095: + constitutional only-increase 守护
  app.patch('/api/admin/protocol-params/:key', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const param = await dbOne<{ type: string; min_value: number | null; max_value: number | null; category: string; value: string; requires_meta_rule_change: number | null }>('SELECT type, min_value, max_value, category, value, requires_meta_rule_change FROM protocol_params WHERE key = ?', [req.params.key])
    if (!param) return void res.status(404).json({ error: '参数不存在' })
    const { value } = req.body || {}
    if (value === undefined || value === null) return void res.status(400).json({ error: 'value 必填' })
    // 类型校验
    const strVal = String(value)
    if (param.type === 'number') {
      const n = Number(strVal)
      if (!Number.isFinite(n)) return void res.status(400).json({ error: '类型不匹配（需 number）' })
      // P0-2: 范围校验
      if (param.min_value != null && n < param.min_value) {
        return void res.status(400).json({ error: `value 低于下限 ${param.min_value}` })
      }
      if (param.max_value != null && n > param.max_value) {
        return void res.status(400).json({ error: `value 高于上限 ${param.max_value}` })
      }
      // #1095 CHARTER §4 I-4: constitutional only-increase 锁
      // 假设 increase = more protection;详头部注释块
      if (param.category === 'constitutional') {
        const oldNum = Number(param.value)
        if (Number.isFinite(oldNum) && n < oldNum) {
          // #1096 audit:拒绝时也写 protocol_params_log(meta-rule #1 "当一切可见")
          // 谁尝试降低宪法保护要留痕,即便 attempt 失败
          try {
            await dbRun(`INSERT INTO protocol_params_log (id, key, old_value, new_value, changed_by, action) VALUES (?,?,?,?,?,'constitutional_reject_patch')`,
              [generateId('ppl'), req.params.key, param.value, strVal, admin.id])
          } catch (_e) { /* log 失败不阻塞 reject 决定 */ }
          return void res.status(403).json({
            error: `宪法级 param 只能调高,不能调低(${param.value} → ${n})— CHARTER §4 I-4 防绕过`,
            code: 'CONSTITUTIONAL_ONLY_INCREASE',
            current: oldNum,
            attempted: n,
          })
        }
      }
      // #1090 RFC-002 P1#6 runtime enforcement:meta-rule-locked params 走同款 only-increase
      // (CI lint PR-3.1 守 source seed;此处守 runtime DB)
      // PATCH-1c PR-3.1 描述行注明哪个方向是 more protection;协议侧约定 higher = stricter
      if (param.requires_meta_rule_change === 1) {
        const oldNum = Number(param.value)
        if (Number.isFinite(oldNum) && n < oldNum) {
          try {
            await dbRun(`INSERT INTO protocol_params_log (id, key, old_value, new_value, changed_by, action) VALUES (?,?,?,?,?,'meta_rule_reject_patch')`,
              [generateId('ppl'), req.params.key, param.value, strVal, admin.id])
          } catch (_e) { /* log 失败不阻塞 */ }
          return void res.status(403).json({
            error: `meta-rule-locked param 只能调高(${param.value} → ${n})— 降低需 60d amendment(CHARTER §4 I-1)`,
            code: 'META_RULE_LOCKED_ONLY_INCREASE',
            current: oldNum,
            attempted: n,
          })
        }
      }
    }
    if (param.type === 'boolean' && !['true', 'false', '1', '0'].includes(strVal)) {
      return void res.status(400).json({ error: '类型不匹配（需 boolean）' })
    }
    // S1 审计:json 型参数必须能被 parse(此前只有 number/boolean 校验,json 型能写进任意串 → 消费方 fail-open/closed 两难)
    if (param.type === 'json') {
      let parsed: unknown
      try { parsed = JSON.parse(strVal) } catch { return void res.status(400).json({ error: '类型不匹配(需合法 JSON)' }) }
      // key 专项:平台禁售名单必须是大写区码数组(2-8 位字母/数字/-)—— 该参数直接进建单硬门,坏值会 fail-closed 挡全部下单
      if (req.params.key === 'trade.platform_region_blocklist') {
        if (!Array.isArray(parsed) || !parsed.every(x => typeof x === 'string' && /^[A-Z0-9-]{2,8}$/.test(x))) {
          return void res.status(400).json({ error: 'trade.platform_region_blocklist 须为大写区码字符串数组,如 ["KP"]', code: 'BAD_REGION_BLOCKLIST' })
        }
      }
    }
    // A-3: 变更前快照旧值
    const oldRow = await dbOne<{ value: string }>('SELECT value FROM protocol_params WHERE key = ?', [req.params.key])
    db.transaction(() => {
      db.prepare(`UPDATE protocol_params SET value = ?, updated_at = datetime('now'), updated_by = ? WHERE key = ?`)
        .run(strVal, admin.id, req.params.key)
      db.prepare(`INSERT INTO protocol_params_log (id, key, old_value, new_value, changed_by, action) VALUES (?,?,?,?,?,'update')`)
        .run(generateId('ppl'), req.params.key, oldRow?.value || null, strVal, admin.id)
    })()
    res.json({ success: true })
  })

  app.post('/api/admin/protocol-params/:key/reset', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const param = await dbOne<{ default_value: string | null; value: string; category: string; type: string; requires_meta_rule_change: number | null }>('SELECT default_value, value, category, type, requires_meta_rule_change FROM protocol_params WHERE key = ?', [req.params.key])
    if (!param || param.default_value == null) return void res.status(404).json({ error: '参数不存在或无默认值' })
    // #1095 CHARTER §4 I-4: constitutional reset 走 same only-increase
    // 若 default 低于 current,reset 会构成降低保护 → 拒绝
    if (param.category === 'constitutional' && param.type === 'number') {
      const cur = Number(param.value)
      const def = Number(param.default_value)
      if (Number.isFinite(cur) && Number.isFinite(def) && def < cur) {
        // #1096 audit:reset 拒绝同样留痕
        try {
          await dbRun(`INSERT INTO protocol_params_log (id, key, old_value, new_value, changed_by, action) VALUES (?,?,?,?,?,'constitutional_reject_reset')`,
            [generateId('ppl'), req.params.key, param.value, param.default_value, admin.id])
        } catch (_e) { /* log 失败不阻塞 */ }
        return void res.status(403).json({
          error: `宪法级 param 不能 reset 至更低值(${param.value} → ${param.default_value})— CHARTER §4 I-4 防绕过`,
          code: 'CONSTITUTIONAL_ONLY_INCREASE',
          current: cur,
          default: def,
        })
      }
    }
    // #1090 RFC-002 P1#6:meta-rule-locked param reset 也走 only-increase
    if (param.requires_meta_rule_change === 1 && param.type === 'number') {
      const cur = Number(param.value)
      const def = Number(param.default_value)
      if (Number.isFinite(cur) && Number.isFinite(def) && def < cur) {
        try {
          await dbRun(`INSERT INTO protocol_params_log (id, key, old_value, new_value, changed_by, action) VALUES (?,?,?,?,?,'meta_rule_reject_reset')`,
            [generateId('ppl'), req.params.key, param.value, param.default_value, admin.id])
        } catch (_e) { /* log 失败不阻塞 */ }
        return void res.status(403).json({
          error: `meta-rule-locked param 不能 reset 至更低值(${param.value} → ${param.default_value})— 降低需 60d amendment(CHARTER §4 I-1)`,
          code: 'META_RULE_LOCKED_ONLY_INCREASE',
          current: cur,
          default: def,
        })
      }
    }
    db.transaction(() => {
      db.prepare(`UPDATE protocol_params SET value = ?, updated_at = datetime('now'), updated_by = ? WHERE key = ?`)
        .run(param.default_value, admin.id, req.params.key)
      db.prepare(`INSERT INTO protocol_params_log (id, key, old_value, new_value, changed_by, action) VALUES (?,?,?,?,?,'reset')`)
        .run(generateId('ppl'), req.params.key, param.value, param.default_value, admin.id)
    })()
    res.json({ success: true })
  })

  // A-3: 变更历史
  app.get('/api/admin/protocol-params/:key/history', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    const rows = await dbAll(`
      SELECT l.id, l.old_value, l.new_value, l.changed_by, l.action, l.created_at,
        u.name as changed_by_name, u.handle as changed_by_handle
      FROM protocol_params_log l
      LEFT JOIN users u ON u.id = l.changed_by
      WHERE l.key = ?
      ORDER BY l.created_at DESC LIMIT 100
    `, [req.params.key])
    res.json({ items: rows })
  })
}
