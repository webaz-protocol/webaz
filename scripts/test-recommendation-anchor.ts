import Database from 'better-sqlite3'
import {
  RECOMMENDATION_LOCAL_CODE_ALPHABET,
  RECOMMENDATION_NAMESPACE_MAX_ANCHORS,
  claimRecommendationNamespace,
  disableRecommendationAnchor,
  disableRecommendationNamespace,
  generateRecommendationLocalCode,
  initRecommendationAnchorSchema,
  issueRecommendationAnchor,
  retireRecommendationNamespace,
  withdrawRecommendationAnchor,
} from '../src/recommendation-anchor.js'
import { initProductVariantsSchema } from '../src/runtime/webaz-schema-helpers.js'

let passed = 0
let failed = 0
const ok = (name: string, condition: boolean, details?: unknown) => {
  if (condition) { passed++; console.log(`✓ ${name}`) }
  else { failed++; console.error(`✗ ${name}`, details === undefined ? '' : JSON.stringify(details)) }
}
const throws = (name: string, fn: () => unknown) => {
  try { fn(); ok(name, false, 'did not throw') } catch { ok(name, true) }
}

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, roles TEXT, name TEXT);
    CREATE TABLE products (
      id TEXT PRIMARY KEY, seller_id TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL, description TEXT NOT NULL, price REAL NOT NULL,
      currency TEXT, status TEXT NOT NULL DEFAULT 'active', updated_at TEXT
    );
  `)
  initProductVariantsSchema(db)
  initRecommendationAnchorSchema(db)
  db.exec(`
    INSERT INTO users (id, role, roles, name) VALUES
      ('usr_recommender','buyer','["buyer"]','Recommender'),
      ('usr_seller','seller','["seller"]','Seller'),
      ('usr_admin','buyer','["buyer","admin"]','Root'),
      ('usr_agent_overlay','buyer','["buyer","agent"]','Agent Overlay'),
      ('agt_catalog','agent','["agent"]','Catalog Agent'),
      ('sys_protocol','admin','["admin"]','Protocol');
    INSERT INTO products (id, seller_id, title, description, price, currency, status, updated_at) VALUES
      ('prd_active','usr_seller','Rice cooker','Small reliable cooker',50,'USDC','active','2026-07-19 00:00:00'),
      ('prd_inactive','usr_seller','Old cooker','No longer sold',40,'USDC','delisted','2026-07-19 00:00:00');
    INSERT INTO product_variants (id, product_id, sku, options_json, price_override, stock, is_active, updated_at) VALUES
      ('var_active','prd_active','RC-RED','{"color":"red"}',NULL,3,1,'2026-07-19 00:00:00'),
      ('var_inactive','prd_active','RC-BLUE','{"color":"blue"}',NULL,3,0,'2026-07-19 00:00:00');
  `)
  return db
}

{
  const db = freshDb()
  const claim = claimRecommendationNamespace(db, { ownerId: 'usr_recommender', namespace: ' Tina ' })
  ok('claim canonicalizes ASCII namespace', claim.ok && claim.namespace === 'tina', claim)
  ok('namespace claim writes immutable event', Number((db.prepare('SELECT COUNT(*) AS n FROM recommendation_namespace_events').get() as { n: number }).n) === 1)
  ok('reserved namespace is denied', claimRecommendationNamespace(db, { ownerId: 'usr_seller', namespace: 'webaz' }).ok === false)
  ok('system identity cannot claim', claimRecommendationNamespace(db, { ownerId: 'sys_protocol', namespace: 'protocol' }).ok === false)
  ok('agent identity cannot claim', claimRecommendationNamespace(db, { ownerId: 'agt_catalog', namespace: 'catalog' }).ok === false)
  ok('agent role membership cannot claim while buyer is active role', claimRecommendationNamespace(db, { ownerId: 'usr_agent_overlay', namespace: 'agentoverlay' }).ok === false)
  ok('one V1 namespace per identity', claimRecommendationNamespace(db, { ownerId: 'usr_recommender', namespace: 'other' }).ok === false)
  if (!claim.ok) throw new Error('test fixture namespace claim failed')

  const issued = issueRecommendationAnchor(db, {
    recommenderId: 'usr_recommender', namespaceId: claim.namespaceId, productId: 'prd_active', variantId: 'var_active',
  })
  ok('human may recommend another seller active product', issued.ok && issued.anchor.startsWith('@tina:'), issued)
  ok('issued code obeys canonical alphabet', issued.ok && new RegExp(`^[${RECOMMENDATION_LOCAL_CODE_ALPHABET}]{5}$`).test(issued.anchor.split(':')[1]))
  ok('issue writes exactly one immutable anchor event', Number((db.prepare('SELECT COUNT(*) AS n FROM recommendation_anchor_events').get() as { n: number }).n) === 1)
  ok('inactive product is denied', issueRecommendationAnchor(db, { recommenderId: 'usr_recommender', namespaceId: claim.namespaceId, productId: 'prd_inactive' }).ok === false)
  ok('inactive variant is denied', issueRecommendationAnchor(db, { recommenderId: 'usr_recommender', namespaceId: claim.namespaceId, productId: 'prd_active', variantId: 'var_inactive' }).ok === false)
  if (!issued.ok) throw new Error('test fixture anchor issue failed')

  throws('DB prevents anchor target retargeting', () => db.prepare(`UPDATE recommendation_anchors SET product_id='prd_inactive' WHERE id=?`).run(issued.anchorId))
  throws('DB prevents anchor deletion/reuse', () => db.prepare(`DELETE FROM recommendation_anchors WHERE id=?`).run(issued.anchorId))
  throws('DB prevents anchor event mutation', () => db.prepare(`UPDATE recommendation_anchor_events SET reason_code='changed'`).run())
  throws('DB prevents anchor event deletion', () => db.prepare(`DELETE FROM recommendation_anchor_events`).run())
  throws('DB prevents namespace-owner mismatch on raw INSERT', () => db.prepare(`INSERT INTO recommendation_anchors (
    id, namespace_id, local_code, recommender_user_id, product_id, seller_id_at_issue, target_snapshot_hash
  ) VALUES ('ran_forged', ?, 'abcde', 'usr_seller', 'prd_active', 'usr_seller', ?)`).run(claim.namespaceId, 'a'.repeat(64)))
  throws('anchor cannot transition without a matching event', () => db.prepare(`UPDATE recommendation_anchors SET status='disabled', disabled_at=datetime('now') WHERE id=?`).run(issued.anchorId))

  ok('only owner can withdraw', withdrawRecommendationAnchor(db, { anchorId: issued.anchorId, ownerId: 'usr_seller' }).ok === false)
  ok('owner withdrawal succeeds', withdrawRecommendationAnchor(db, { anchorId: issued.anchorId, ownerId: 'usr_recommender' }).ok === true)
  const withdrawn = db.prepare(`SELECT status, withdrawn_at FROM recommendation_anchors WHERE id=?`).get(issued.anchorId) as { status: string; withdrawn_at: string | null }
  ok('withdrawal is forward-only status transition', withdrawn.status === 'withdrawn' && withdrawn.withdrawn_at !== null, withdrawn)
  throws('withdrawn anchor cannot be reactivated', () => db.prepare(`UPDATE recommendation_anchors SET status='active' WHERE id=?`).run(issued.anchorId))
  throws('anchor lifecycle timestamp cannot be rewritten', () => db.prepare(`UPDATE recommendation_anchors SET withdrawn_at=datetime('now', '+1 day') WHERE id=?`).run(issued.anchorId))
  ok('withdrawal has append-only event', Number((db.prepare(`SELECT COUNT(*) AS n FROM recommendation_anchor_events WHERE recommendation_anchor_id=?`).get(issued.anchorId) as { n: number }).n) === 2)
}

{
  const db = freshDb()
  const claim = claimRecommendationNamespace(db, { ownerId: 'usr_recommender', namespace: 'tinara' })
  if (!claim.ok) throw new Error('test fixture namespace claim failed')
  const issued = issueRecommendationAnchor(db, { recommenderId: 'usr_recommender', namespaceId: claim.namespaceId, productId: 'prd_active' })
  if (!issued.ok) throw new Error('test fixture anchor issue failed')
  ok('non-admin cannot disable anchor', disableRecommendationAnchor(db, { anchorId: issued.anchorId, adminId: 'usr_seller', reasonCode: 'policy_review' }).ok === false)
  ok('admin membership works without switching the active role', disableRecommendationAnchor(db, { anchorId: issued.anchorId, adminId: 'usr_admin', reasonCode: 'policy_review' }).ok === true)
  ok('disabled anchor cannot be reactivated', (() => { try { db.prepare(`UPDATE recommendation_anchors SET status='active' WHERE id=?`).run(issued.anchorId); return false } catch { return true } })())
  ok('invalid admin reason is denied', disableRecommendationNamespace(db, { namespaceId: claim.namespaceId, adminId: 'usr_admin', reasonCode: 'contains spaces' }).ok === false)
  ok('admin can disable active namespace with coded reason', disableRecommendationNamespace(db, { namespaceId: claim.namespaceId, adminId: 'usr_admin', reasonCode: 'policy_review' }).ok === true)
  throws('namespace deletion is forbidden', () => db.prepare(`DELETE FROM recommendation_namespaces WHERE id=?`).run(claim.namespaceId))
  throws('namespace lifecycle timestamp cannot be rewritten', () => db.prepare(`UPDATE recommendation_namespaces SET disabled_at=datetime('now', '+1 day') WHERE id=?`).run(claim.namespaceId))
  throws('namespace event mutation is forbidden', () => db.prepare(`UPDATE recommendation_namespace_events SET reason_code='changed'`).run())
}

{
  const db = freshDb()
  const claim = claimRecommendationNamespace(db, { ownerId: 'usr_recommender', namespace: 'quotaowner' })
  if (!claim.ok) throw new Error('test fixture namespace claim failed')
  ok('quota constants are explicit and conservative', RECOMMENDATION_NAMESPACE_MAX_ANCHORS === 500)
  const attempts = Array.from({ length: 20 }, () => issueRecommendationAnchor(db, {
    recommenderId: 'usr_recommender', namespaceId: claim.namespaceId, productId: 'prd_active',
  }))
  ok('daily quota permits exactly its configured first twenty issues', attempts.every(result => result.ok), attempts)
  const beyondDaily = issueRecommendationAnchor(db, {
    recommenderId: 'usr_recommender', namespaceId: claim.namespaceId, productId: 'prd_active',
  })
  ok('daily quota fails closed after twenty issues', !beyondDaily.ok && beyondDaily.reason === 'ANCHOR_QUOTA_DAILY', beyondDaily)
}

{
  const db = freshDb()
  const claim = claimRecommendationNamespace(db, { ownerId: 'usr_recommender', namespace: 'retired' })
  if (!claim.ok) throw new Error('test fixture namespace claim failed')
  ok('owner may permanently retire namespace', retireRecommendationNamespace(db, { namespaceId: claim.namespaceId, ownerId: 'usr_recommender' }).ok === true)
  ok('retired namespace blocks issuance', issueRecommendationAnchor(db, { recommenderId: 'usr_recommender', namespaceId: claim.namespaceId, productId: 'prd_active' }).ok === false)
  throws('retired namespace cannot be reactivated', () => db.prepare(`UPDATE recommendation_namespaces SET status='active' WHERE id=?`).run(claim.namespaceId))
}

{
  const codes = new Set(Array.from({ length: 100 }, () => generateRecommendationLocalCode()))
  ok('cryptographic issuer emits canonical five-character codes', [...codes].every(code => /^[23456789abcdefghjkmnpqrstuvwxyz]{5}$/.test(code)))
}

console.log(`\n${passed} passed · ${failed} failed`)
if (failed) process.exit(1)
