/**
 * RFC-027 RA1 — recommendation-anchor domain.
 *
 * This module is intentionally unreachable from HTTP, MCP, search, QR, quotes,
 * or orders in RA1. It only owns the permanent identifier/lifecycle substrate
 * that later slices may consume. It never writes attribution, commission,
 * wallet, escrow, settlement, or an order.
 */
import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { initRecommendationAnchorSchema } from './runtime/webaz-schema-helpers.js'

export { initRecommendationAnchorSchema }

export const RECOMMENDATION_LOCAL_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
export const RECOMMENDATION_NAMESPACE_MAX_ANCHORS = 500
export const RECOMMENDATION_NAMESPACE_MAX_PER_DAY = 20
export const RECOMMENDATION_NAMESPACE_RESERVED = new Set([
  'admin', 'api', 'app', 'help', 'mcp', 'oauth', 'root', 'support', 'system', 'webaz', 'www',
])

type NamespaceStatus = 'active' | 'disabled' | 'retired'
type AnchorStatus = 'active' | 'withdrawn' | 'disabled'

type Ok<T extends object> = { ok: true } & T
type No = { ok: false; reason: string }
type Result<T extends object> = Ok<T> | No

interface UserRow { id: string; role: string | null; roles?: string | null }
interface NamespaceRow { id: string; owner_user_id: string; namespace: string; status: NamespaceStatus }
interface ProductRow {
  id: string; seller_id: string; title: string; description: string; price: number; currency: string | null; updated_at: string | null
}
interface VariantRow {
  id: string; product_id: string; sku: string | null; options_json: string; price_override: number | null; updated_at: string | null
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`
}

function isHumanAccount(row: UserRow | undefined): boolean {
  if (!row) return false
  if (row.role === 'agent' || row.role === 'system' || row.id.startsWith('sys_') || row.id.startsWith('agt_')) return false
  try {
    const roles = JSON.parse(row.roles || '[]')
    return Array.isArray(roles) && !roles.includes('agent') && !roles.includes('system')
  } catch { return false }
}

function canonicalNamespace(input: unknown): Result<{ namespace: string }> {
  if (typeof input !== 'string') return { ok: false, reason: 'NAMESPACE_INVALID' }
  const namespace = input.trim().toLowerCase()
  if (!/^[a-z][a-z0-9_]{2,31}$/.test(namespace)) return { ok: false, reason: 'NAMESPACE_INVALID' }
  if (RECOMMENDATION_NAMESPACE_RESERVED.has(namespace)) return { ok: false, reason: 'NAMESPACE_RESERVED' }
  return { ok: true, namespace }
}

function validReasonCode(value: string): boolean {
  return /^[a-z0-9_]{3,64}$/.test(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function targetSnapshotHash(product: ProductRow, variant: VariantRow | undefined): string {
  // Explicit-key object order makes the immutable source digest deterministic.
  return sha256(JSON.stringify({
    product_id: product.id,
    seller_id_at_issue: product.seller_id,
    title: product.title,
    description: product.description,
    price: product.price,
    currency: product.currency,
    product_updated_at: product.updated_at,
    variant_id: variant?.id ?? null,
    variant_sku: variant?.sku ?? null,
    variant_options_json: variant?.options_json ?? null,
    variant_price_override: variant?.price_override ?? null,
    variant_updated_at: variant?.updated_at ?? null,
  }))
}

/** Cryptographically random, fixed-width code with rejection sampling (no modulo bias). */
export function generateRecommendationLocalCode(): string {
  const alphabet = RECOMMENDATION_LOCAL_CODE_ALPHABET
  const max = 256 - (256 % alphabet.length)
  let code = ''
  while (code.length < 5) {
    for (const byte of randomBytes(16)) {
      if (byte >= max) continue
      code += alphabet[byte % alphabet.length]
      if (code.length === 5) break
    }
  }
  return code
}

function writeNamespaceEvent(db: Database.Database, namespaceId: string, actorId: string, eventType: 'claimed' | 'disabled' | 'retired', reasonCode: string): void {
  db.prepare(`INSERT INTO recommendation_namespace_events (id, namespace_id, actor_id, event_type, reason_code)
              VALUES (?,?,?,?,?)`).run(newId('rnev'), namespaceId, actorId, eventType, reasonCode)
}

function writeAnchorEvent(db: Database.Database, anchorId: string, actorId: string, eventType: 'issued' | 'withdrawn' | 'disabled', reasonCode: string): void {
  db.prepare(`INSERT INTO recommendation_anchor_events (id, recommendation_anchor_id, actor_id, event_type, reason_code)
              VALUES (?,?,?,?,?)`).run(newId('raev'), anchorId, actorId, eventType, reasonCode)
}

export function claimRecommendationNamespace(db: Database.Database, args: { ownerId: string; namespace: unknown }): Result<{ namespaceId: string; namespace: string }> {
  const parsed = canonicalNamespace(args.namespace)
  if (!parsed.ok) return parsed

  const namespaceId = newId('rns')
  try {
    db.transaction(() => {
      const owner = db.prepare('SELECT id, role, roles FROM users WHERE id = ?').get(args.ownerId) as UserRow | undefined
      if (!isHumanAccount(owner)) throw new Error('NAMESPACE_OWNER_NOT_HUMAN')
      const existing = db.prepare('SELECT id FROM recommendation_namespaces WHERE owner_user_id = ?').get(args.ownerId)
      if (existing) throw new Error('NAMESPACE_ALREADY_OWNED')
      db.prepare(`INSERT INTO recommendation_namespaces (id, owner_user_id, namespace) VALUES (?,?,?)`)
        .run(namespaceId, args.ownerId, parsed.namespace)
      writeNamespaceEvent(db, namespaceId, args.ownerId, 'claimed', 'namespace_claimed')
    }).immediate()
  } catch (err) {
    const reason = (err as Error).message
    if (reason === 'NAMESPACE_OWNER_NOT_HUMAN' || reason === 'NAMESPACE_ALREADY_OWNED') return { ok: false, reason }
    if (/UNIQUE constraint failed: recommendation_namespaces\.namespace/.test(reason)) return { ok: false, reason: 'NAMESPACE_ALREADY_CLAIMED' }
    if (/UNIQUE constraint failed: recommendation_namespaces\.owner_user_id/.test(reason)) return { ok: false, reason: 'NAMESPACE_ALREADY_OWNED' }
    throw err
  }
  return { ok: true, namespaceId, namespace: parsed.namespace }
}

export function issueRecommendationAnchor(db: Database.Database, args: { recommenderId: string; namespaceId: string; productId: string; variantId?: string | null }): Result<{ anchorId: string; anchor: string; targetSnapshotHash: string }> {
  const anchorId = newId('ran')
  return db.transaction((): Result<{ anchorId: string; anchor: string; targetSnapshotHash: string }> => {
      const recommender = db.prepare('SELECT id, role, roles FROM users WHERE id = ?').get(args.recommenderId) as UserRow | undefined
      if (!isHumanAccount(recommender)) return { ok: false, reason: 'RECOMMENDER_NOT_HUMAN' }

      const namespace = db.prepare(`SELECT id, owner_user_id, namespace, status FROM recommendation_namespaces WHERE id = ?`)
        .get(args.namespaceId) as NamespaceRow | undefined
      if (!namespace) return { ok: false, reason: 'NAMESPACE_NOT_FOUND' }
      if (namespace.owner_user_id !== args.recommenderId) return { ok: false, reason: 'NAMESPACE_NOT_OWNER' }
      if (namespace.status !== 'active') return { ok: false, reason: 'NAMESPACE_NOT_ACTIVE' }

      const product = db.prepare(`SELECT id, seller_id, title, description, price, currency, updated_at
                                  FROM products WHERE id = ? AND status = 'active'`)
        .get(args.productId) as ProductRow | undefined
      if (!product) return { ok: false, reason: 'TARGET_PRODUCT_NOT_ACTIVE' }

      let variant: VariantRow | undefined
      if (args.variantId != null) {
        variant = db.prepare(`SELECT id, product_id, sku, options_json, price_override, updated_at
                              FROM product_variants WHERE id = ? AND product_id = ? AND is_active = 1`)
          .get(args.variantId, product.id) as VariantRow | undefined
        if (!variant) return { ok: false, reason: 'TARGET_VARIANT_NOT_ACTIVE' }
      }

      const quota = db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN issued_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS today
        FROM recommendation_anchors WHERE namespace_id = ?`).get(namespace.id) as { total: number; today: number | null }
      if (Number(quota.total) >= RECOMMENDATION_NAMESPACE_MAX_ANCHORS) return { ok: false, reason: 'ANCHOR_QUOTA_TOTAL' }
      if (Number(quota.today ?? 0) >= RECOMMENDATION_NAMESPACE_MAX_PER_DAY) return { ok: false, reason: 'ANCHOR_QUOTA_DAILY' }

      const digest = targetSnapshotHash(product, variant)
      for (let attempt = 0; attempt < 8; attempt++) {
        const localCode = generateRecommendationLocalCode()
        try {
          db.prepare(`INSERT INTO recommendation_anchors (
            id, namespace_id, local_code, recommender_user_id, product_id, variant_id,
            seller_id_at_issue, campaign_ref, target_snapshot_hash
          ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
            anchorId, namespace.id, localCode, args.recommenderId, product.id, variant?.id ?? null,
            product.seller_id, null, digest,
          )
          writeAnchorEvent(db, anchorId, args.recommenderId, 'issued', 'anchor_issued')
          return { ok: true, anchorId, anchor: `@${namespace.namespace}:${localCode}`, targetSnapshotHash: digest }
        } catch (err) {
          if (/UNIQUE constraint failed: recommendation_anchors\.namespace_id, recommendation_anchors\.local_code/.test((err as Error).message)) continue
          throw err
        }
      }
      return { ok: false, reason: 'ANCHOR_CODE_COLLISION_RETRY_EXHAUSTED' }
    }).immediate()
}

export function withdrawRecommendationAnchor(db: Database.Database, args: { anchorId: string; ownerId: string }): Result<object> {
  const anchor = db.prepare(`SELECT a.id, a.status, n.owner_user_id
                             FROM recommendation_anchors a JOIN recommendation_namespaces n ON n.id = a.namespace_id
                             WHERE a.id = ?`).get(args.anchorId) as { id: string; status: AnchorStatus; owner_user_id: string } | undefined
  if (!anchor) return { ok: false, reason: 'ANCHOR_NOT_FOUND' }
  if (anchor.owner_user_id !== args.ownerId) return { ok: false, reason: 'ANCHOR_NOT_OWNER' }
  if (anchor.status !== 'active') return { ok: false, reason: 'ANCHOR_NOT_ACTIVE' }
  db.transaction(() => {
    writeAnchorEvent(db, anchor.id, args.ownerId, 'withdrawn', 'owner_withdrew')
    const result = db.prepare(`UPDATE recommendation_anchors SET status = 'withdrawn', withdrawn_at = datetime('now')
                               WHERE id = ? AND status = 'active'`).run(anchor.id)
    if (result.changes !== 1) throw new Error('ANCHOR_TRANSITION_CONFLICT')
  }).immediate()
  return { ok: true }
}

function requireAdmin(db: Database.Database, adminId: string): boolean {
  const row = db.prepare(`SELECT role, roles FROM users WHERE id = ?`).get(adminId) as UserRow | undefined
  if (!row) return false
  if (row.role === 'admin') return true
  try {
    const roles = JSON.parse(row.roles || '[]')
    return Array.isArray(roles) && roles.includes('admin')
  } catch { return false }
}

export function disableRecommendationAnchor(db: Database.Database, args: { anchorId: string; adminId: string; reasonCode: string }): Result<object> {
  if (!requireAdmin(db, args.adminId)) return { ok: false, reason: 'ADMIN_REQUIRED' }
  if (!validReasonCode(args.reasonCode)) return { ok: false, reason: 'REASON_CODE_INVALID' }
  const anchor = db.prepare(`SELECT id, status FROM recommendation_anchors WHERE id = ?`).get(args.anchorId) as { id: string; status: AnchorStatus } | undefined
  if (!anchor) return { ok: false, reason: 'ANCHOR_NOT_FOUND' }
  if (anchor.status !== 'active') return { ok: false, reason: 'ANCHOR_NOT_ACTIVE' }
  db.transaction(() => {
    writeAnchorEvent(db, anchor.id, args.adminId, 'disabled', args.reasonCode)
    const result = db.prepare(`UPDATE recommendation_anchors SET status = 'disabled', disabled_at = datetime('now')
                               WHERE id = ? AND status = 'active'`).run(anchor.id)
    if (result.changes !== 1) throw new Error('ANCHOR_TRANSITION_CONFLICT')
  }).immediate()
  return { ok: true }
}

export function retireRecommendationNamespace(db: Database.Database, args: { namespaceId: string; ownerId: string }): Result<object> {
  const namespace = db.prepare(`SELECT id, owner_user_id, status FROM recommendation_namespaces WHERE id = ?`).get(args.namespaceId) as NamespaceRow | undefined
  if (!namespace) return { ok: false, reason: 'NAMESPACE_NOT_FOUND' }
  if (namespace.owner_user_id !== args.ownerId) return { ok: false, reason: 'NAMESPACE_NOT_OWNER' }
  if (namespace.status !== 'active') return { ok: false, reason: 'NAMESPACE_NOT_ACTIVE' }
  db.transaction(() => {
    writeNamespaceEvent(db, namespace.id, args.ownerId, 'retired', 'owner_retired')
    const result = db.prepare(`UPDATE recommendation_namespaces SET status = 'retired', retired_at = datetime('now')
                               WHERE id = ? AND status = 'active'`).run(namespace.id)
    if (result.changes !== 1) throw new Error('NAMESPACE_TRANSITION_CONFLICT')
  }).immediate()
  return { ok: true }
}

export function disableRecommendationNamespace(db: Database.Database, args: { namespaceId: string; adminId: string; reasonCode: string }): Result<object> {
  if (!requireAdmin(db, args.adminId)) return { ok: false, reason: 'ADMIN_REQUIRED' }
  if (!validReasonCode(args.reasonCode)) return { ok: false, reason: 'REASON_CODE_INVALID' }
  const namespace = db.prepare(`SELECT id, status FROM recommendation_namespaces WHERE id = ?`).get(args.namespaceId) as NamespaceRow | undefined
  if (!namespace) return { ok: false, reason: 'NAMESPACE_NOT_FOUND' }
  if (namespace.status !== 'active') return { ok: false, reason: 'NAMESPACE_NOT_ACTIVE' }
  db.transaction(() => {
    writeNamespaceEvent(db, namespace.id, args.adminId, 'disabled', args.reasonCode)
    const result = db.prepare(`UPDATE recommendation_namespaces SET status = 'disabled', disabled_at = datetime('now')
                               WHERE id = ? AND status = 'active'`).run(namespace.id)
    if (result.changes !== 1) throw new Error('NAMESPACE_TRANSITION_CONFLICT')
  }).immediate()
  return { ok: true }
}
