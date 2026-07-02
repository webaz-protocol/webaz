/**
 * 平台(WebAZ)收款方式 —— admin 管理的多收款账号读写 helper。
 *
 * 用途:卖家申请充值【平台服务费】时,看到这些 active 的平台收款方式,据此线下付款(见 fee-prepay 申请流)。
 * 边界:这是【平台侧】收款配置,不是卖家账号。instruction 是平台公开收款明细(给卖家看,非披露门)。
 *   qr 内联存 data:image/(png|webp);base64 —— 写时 validateQrDataUri 校验(png/webp、magic、≤64KB);admin 精选、少量。
 *   改它 = 改平台收款流向 → 路由层 root + Passkey 门(本模块只做纯读写 + 校验,门在 route)。
 */
import type Database from 'better-sqlite3'
import { validateQrDataUri } from './direct-receive-account-qr.js'
import { MAX_INSTRUCTION_LEN, MAX_LABEL_LEN, MAX_METHOD_LEN, CURRENCY_RE } from './direct-receive-accounts.js'

export interface PlatformReceiveAccount {
  id: string
  label: string | null
  method: string | null
  currency: string | null
  instruction: string
  qr_data_uri: string | null
  status: string
}

export interface PlatformAccountInput {
  label?: string | null
  method?: string | null
  currency?: string | null
  instruction: string
  qrDataUri?: string | null   // 缺省=不改(update);null/'' = 清除;字符串 = 校验后设置
}

export interface NormalizedPlatformText { label: string | null; method: string | null; currency: string | null; instruction: string }

/** PURE:校验 + 规范化文本字段(trim / 长度 / 币种)。长度超限=显式拒(非静默截断)。 */
export function normalizePlatformText(input: PlatformAccountInput): { ok: true; value: NormalizedPlatformText } | { ok: false; reason: string } {
  const instruction = String(input?.instruction ?? '').trim()
  if (!instruction) return { ok: false, reason: 'instruction required' }
  if (instruction.length > MAX_INSTRUCTION_LEN) return { ok: false, reason: `instruction must be ≤ ${MAX_INSTRUCTION_LEN} chars` }
  const field = (v: unknown, max: number, name: string): { ok: true; v: string | null } | { ok: false; reason: string } => {
    if (v == null) return { ok: true, v: null }
    const s = String(v).trim()
    if (s.length > max) return { ok: false, reason: `${name} must be ≤ ${max} chars` }
    return { ok: true, v: s || null }
  }
  const L = field(input.label, MAX_LABEL_LEN, 'label'); if (!L.ok) return L
  const M = field(input.method, MAX_METHOD_LEN, 'method'); if (!M.ok) return M
  let currency: string | null = null
  if (input.currency != null && String(input.currency).trim()) {
    currency = String(input.currency).trim().toUpperCase()
    if (!CURRENCY_RE.test(currency)) return { ok: false, reason: 'currency must be a 2-8 char code (e.g. SGD, USDC)' }
  }
  return { ok: true, value: { instruction, label: L.v, method: M.v, currency } }
}

/** PURE:解析 qrDataUri 入参 → 'keep'(缺省不改) | null(清除) | 校验后的 data-uri | 错误。 */
export function resolveQrInput(input: PlatformAccountInput): { ok: true; qr: 'keep' | null | string } | { ok: false; reason: string } {
  if (!('qrDataUri' in input) || input.qrDataUri === undefined) return { ok: true, qr: 'keep' }
  const q = input.qrDataUri
  if (q == null || String(q).trim() === '') return { ok: true, qr: null }   // 清除
  const v = validateQrDataUri(q)
  if (!v.ok) return { ok: false, reason: v.reason }
  return { ok: true, qr: String(q).trim() }
}

const COLS = 'id, label, method, currency, instruction, qr_data_uri, status'

/** 全部平台收款方式(默认仅 active;{ includeInactive:true } 取全部,含 qr_data_uri)。admin 用。 */
export function listPlatformAccounts(db: Database.Database, opts: { includeInactive?: boolean } = {}): PlatformReceiveAccount[] {
  const where = opts.includeInactive ? '' : " WHERE status = 'active'"
  return db.prepare(`SELECT ${COLS} FROM platform_receive_accounts${where} ORDER BY created_at ASC, id ASC`).all() as PlatformReceiveAccount[]
}

/** 仅 active(卖家侧看:含 instruction + qr_data_uri —— 平台公开收款明细,非披露门)。 */
export function listActivePlatformAccounts(db: Database.Database): PlatformReceiveAccount[] {
  return listPlatformAccounts(db, { includeInactive: false })
}

export function getPlatformAccount(db: Database.Database, id: string): PlatformReceiveAccount | null {
  return (db.prepare(`SELECT ${COLS} FROM platform_receive_accounts WHERE id = ?`).get(id) as PlatformReceiveAccount | undefined) ?? null
}

/** 新增 active 平台收款方式。 */
export function addPlatformAccount(
  db: Database.Database, input: PlatformAccountInput, generateId: (p: string) => string,
): { ok: true; account: PlatformReceiveAccount } | { ok: false; reason: string } {
  const t = normalizePlatformText(input); if (!t.ok) return t
  const q = resolveQrInput(input); if (!q.ok) return q
  const qr = q.qr === 'keep' ? null : q.qr   // 新增时无既有值,'keep' 视作无 qr
  const id = generateId('pra')
  db.prepare(`INSERT INTO platform_receive_accounts (id, label, method, currency, instruction, qr_data_uri, status) VALUES (?,?,?,?,?,?, 'active')`)
    .run(id, t.value.label, t.value.method, t.value.currency, t.value.instruction, qr)
  return { ok: true, account: { id, status: 'active', qr_data_uri: qr, ...t.value } }
}

/** 更新(文本总更;qr 仅当入参给了 qrDataUri 才动 —— 缺省保留既有)。 */
export function updatePlatformAccount(
  db: Database.Database, id: string, input: PlatformAccountInput,
): { ok: true; changed: boolean } | { ok: false; reason: string } {
  const t = normalizePlatformText(input); if (!t.ok) return t
  const q = resolveQrInput(input); if (!q.ok) return q
  const v = t.value
  let info
  if (q.qr === 'keep') {
    info = db.prepare(`UPDATE platform_receive_accounts SET label=?, method=?, currency=?, instruction=?, updated_at=datetime('now') WHERE id=?`)
      .run(v.label, v.method, v.currency, v.instruction, id)
  } else {
    info = db.prepare(`UPDATE platform_receive_accounts SET label=?, method=?, currency=?, instruction=?, qr_data_uri=?, updated_at=datetime('now') WHERE id=?`)
      .run(v.label, v.method, v.currency, v.instruction, q.qr, id)
  }
  return { ok: true, changed: info.changes > 0 }
}

/** 软停用(卖家不再看到)。 */
export function deactivatePlatformAccount(db: Database.Database, id: string): boolean {
  return db.prepare("UPDATE platform_receive_accounts SET status='inactive', updated_at=datetime('now') WHERE id=? AND status='active'").run(id).changes > 0
}
