#!/usr/bin/env tsx
import Database from 'better-sqlite3'
import { disconnectDeletedAccountClient, finalizeAccountDeletion, initDeletedSellerOrderGuard } from '../src/pwa/account-deletion-finalize.js'

let pass = 0
const ok = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message)
  pass++
}

function fixture(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT, handle TEXT, email TEXT, phone TEXT, bio TEXT,
      search_anchor TEXT, password_hash TEXT, api_key TEXT UNIQUE, deleted_at TEXT, feed_visible INTEGER,
      listing_paused INTEGER DEFAULT 0, listing_paused_reason TEXT, listing_paused_at TEXT
    );
    CREATE TABLE products (id TEXT PRIMARY KEY, seller_id TEXT, status TEXT, updated_at TEXT);
    CREATE TABLE orders (buyer_id TEXT, seller_id TEXT, status TEXT);
    CREATE TABLE disputes (initiator_id TEXT, defendant_id TEXT, status TEXT);
    CREATE TABLE wallets (user_id TEXT, balance REAL);
    CREATE TABLE user_addresses (user_id TEXT, recipient TEXT, phone TEXT, detail TEXT);
    CREATE TABLE account_deletion_requests (
      user_id TEXT PRIMARY KEY, cancelled_at TEXT, pii_wiped_at TEXT
    );
    CREATE TABLE agent_delegation_grants (
      grant_id TEXT PRIMARY KEY, human_id TEXT, status TEXT, revoked_at TEXT, revoked_reason TEXT
    );
    CREATE TABLE oauth_access_tokens (grant_id TEXT, revoked_at TEXT);
    CREATE TABLE oauth_refresh_tokens (grant_id TEXT, revoked_at TEXT);
    CREATE TABLE oauth_auth_codes (user_id TEXT, consumed_at TEXT);
    CREATE TABLE verification_codes (user_id TEXT, used_at TEXT);
    CREATE TABLE user_sessions (user_id TEXT, revoked_at TEXT);
    CREATE TABLE push_subscriptions (user_id TEXT);
  `)
  db.prepare(`INSERT INTO users (id,name,handle,email,phone,bio,search_anchor,password_hash,api_key,deleted_at,feed_visible) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('u1', 'Alice', 'alice', 'a@example.test', '1', 'bio', '@a', 'hash', 'key_old', null, 1)
  db.prepare(`INSERT INTO products VALUES (?,?,?,?)`).run('p1', 'u1', 'active', 'old')
  db.prepare(`INSERT INTO user_addresses VALUES (?,?,?,?)`).run('u1', 'Alice', '1', 'Street 1')
  db.prepare(`INSERT INTO account_deletion_requests VALUES (?,?,?)`).run('u1', null, null)
  db.prepare(`INSERT INTO agent_delegation_grants VALUES (?,?,?,?,?)`).run('g1', 'u1', 'active', null, null)
  db.prepare(`INSERT INTO agent_delegation_grants VALUES (?,?,?,?,?)`).run('g2', 'u1', 'revoked', 'old', 'manual')
  db.prepare(`INSERT INTO oauth_access_tokens VALUES (?,?)`).run('g1', null)
  db.prepare(`INSERT INTO oauth_refresh_tokens VALUES (?,?)`).run('g1', null)
  db.prepare(`INSERT INTO oauth_auth_codes VALUES (?,?)`).run('u1', null)
  db.prepare(`INSERT INTO verification_codes VALUES (?,?)`).run('u1', null)
  db.prepare(`INSERT INTO user_sessions VALUES (?,?)`).run('u1', null)
  db.prepare(`INSERT INTO push_subscriptions VALUES (?)`).run('u1')
  initDeletedSellerOrderGuard(db)
  return db
}

const at = '2026-07-23T10:00:00.000Z'
const db = fixture()
ok(finalizeAccountDeletion(db, {
  userId: 'u1', anonymousName: 'anon_test', replacementApiKey: 'deleted_new', finalizedAt: at,
}), 'eligible deletion should finalize')

const user = db.prepare(`SELECT * FROM users WHERE id='u1'`).get() as Record<string, unknown>
ok(user.name === 'anon_test' && user.handle === null && user.email === null && user.phone === null, 'profile must be anonymized')
ok(user.password_hash === null && user.api_key === 'deleted_new' && user.deleted_at === at, 'login credentials must be disabled')
ok(user.listing_paused === 1 && user.listing_paused_reason === 'account_deleted', 'deleted seller listings must be paused')
ok((db.prepare(`SELECT status FROM products WHERE id='p1'`).get() as { status: string }).status === 'paused', 'active seller products must be paused')
ok((db.prepare(`SELECT revoked_at FROM user_sessions WHERE user_id='u1'`).get() as { revoked_at: string }).revoked_at === at, 'sessions must be revoked')
ok((db.prepare(`SELECT status FROM agent_delegation_grants WHERE grant_id='g1'`).get() as { status: string }).status === 'revoked', 'active grants must be revoked')
ok((db.prepare(`SELECT revoked_reason FROM agent_delegation_grants WHERE grant_id='g2'`).get() as { revoked_reason: string }).revoked_reason === 'manual', 'existing revocation metadata must remain')
ok((db.prepare(`SELECT revoked_at FROM oauth_access_tokens`).get() as { revoked_at: string }).revoked_at === at, 'OAuth access tokens must be revoked')
ok((db.prepare(`SELECT revoked_at FROM oauth_refresh_tokens`).get() as { revoked_at: string }).revoked_at === at, 'OAuth refresh tokens must be revoked')
ok((db.prepare(`SELECT consumed_at FROM oauth_auth_codes`).get() as { consumed_at: string }).consumed_at === at, 'pending authorization codes must be consumed')
ok((db.prepare(`SELECT used_at FROM verification_codes`).get() as { used_at: string }).used_at === at, 'pending recovery codes must be consumed')
ok((db.prepare(`SELECT COUNT(*) n FROM push_subscriptions`).get() as { n: number }).n === 0, 'push subscriptions must be removed')
ok((db.prepare(`SELECT recipient FROM user_addresses`).get() as { recipient: string }).recipient === '[已注销]', 'saved address must be anonymized')
ok((db.prepare(`SELECT pii_wiped_at FROM account_deletion_requests`).get() as { pii_wiped_at: string }).pii_wiped_at === at, 'request must be marked finalized')
ok(!finalizeAccountDeletion(db, {
  userId: 'u1', anonymousName: 'other', replacementApiKey: 'deleted_other', finalizedAt: at,
}), 'finalization must be idempotent')

let ended = 0
const clients = new Map<string, { end: () => void }>([['u1', { end: () => { ended++ } }]])
disconnectDeletedAccountClient(clients, 'u1')
ok(ended === 1 && !clients.has('u1'), 'finalized account SSE client must be closed and removed')
let deletedSellerRejected = false
try { db.prepare(`INSERT INTO orders VALUES (?,?,?)`).run('u2', 'u1', 'created') } catch { deletedSellerRejected = true }
ok(deletedSellerRejected, 'database guard must reject every order insert for a deleted seller')

for (const setup of [
  (blocked: Database.Database) => blocked.prepare(`INSERT INTO orders VALUES (?,?,?)`).run('u1', 'u2', 'paid'),
  (blocked: Database.Database) => blocked.prepare(`INSERT INTO disputes VALUES (?,?,?)`).run('u1', 'u2', 'open'),
  (blocked: Database.Database) => blocked.prepare(`INSERT INTO wallets VALUES (?,?)`).run('u1', 0.02),
]) {
  const blockedDb = fixture()
  setup(blockedDb)
  ok(!finalizeAccountDeletion(blockedDb, {
    userId: 'u1', anonymousName: 'anon_test', replacementApiKey: 'deleted_new', finalizedAt: at,
  }), 'new commerce responsibility must block finalization')
  ok((blockedDb.prepare(`SELECT deleted_at FROM users WHERE id='u1'`).get() as { deleted_at: string | null }).deleted_at === null, 'blocked finalization must leave account active')
  ok((blockedDb.prepare(`SELECT status FROM agent_delegation_grants WHERE grant_id='g1'`).get() as { status: string }).status === 'active', 'blocked finalization must leave grants active')
}

const rollbackDb = fixture()
rollbackDb.exec(`CREATE TRIGGER fail_user_delete BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT, 'injected'); END;`)
let threw = false
try {
  finalizeAccountDeletion(rollbackDb, {
    userId: 'u1', anonymousName: 'anon_test', replacementApiKey: 'deleted_new', finalizedAt: at,
  })
} catch {
  threw = true
}
ok(threw, 'injected failure must surface')
ok((rollbackDb.prepare(`SELECT status FROM agent_delegation_grants WHERE grant_id='g1'`).get() as { status: string }).status === 'active', 'grant revocation must roll back')
ok((rollbackDb.prepare(`SELECT revoked_at FROM oauth_access_tokens`).get() as { revoked_at: string | null }).revoked_at === null, 'OAuth revocation must roll back')
ok((rollbackDb.prepare(`SELECT revoked_at FROM user_sessions`).get() as { revoked_at: string | null }).revoked_at === null, 'session revocation must roll back')
ok((rollbackDb.prepare(`SELECT used_at FROM verification_codes`).get() as { used_at: string | null }).used_at === null, 'recovery-code consumption must roll back')
ok((rollbackDb.prepare(`SELECT COUNT(*) n FROM push_subscriptions`).get() as { n: number }).n === 1, 'push deletion must roll back')

console.log(`account-deletion-finalize passed (${pass} assertions)`)
