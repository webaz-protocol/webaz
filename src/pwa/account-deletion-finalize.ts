import type Database from 'better-sqlite3'

export interface FinalizeAccountDeletionInput {
  userId: string
  anonymousName: string
  replacementApiKey: string
  finalizedAt: string
}

export function disconnectDeletedAccountClient(
  clients: Map<string, { end: () => unknown }>,
  userId: string,
): void {
  const client = clients.get(userId)
  if (client) { try { client.end() } catch {}; clients.delete(userId) }
}

/**
 * Finalize an eligible deletion request atomically. Historical commerce,
 * compliance, and audit rows remain, but every live account credential is
 * disabled before the profile is anonymized.
 */
export function finalizeAccountDeletion(
  db: Database.Database,
  input: FinalizeAccountDeletionInput,
): boolean {
  return db.transaction(() => {
    const pending = db.prepare(`
      SELECT 1 FROM account_deletion_requests
      WHERE user_id = ? AND cancelled_at IS NULL AND pii_wiped_at IS NULL
    `).get(input.userId)
    if (!pending) return false

    const hasPendingOrders = db.prepare(`
      SELECT 1 FROM orders
      WHERE (buyer_id = ? OR seller_id = ?)
        AND status NOT IN ('completed', 'confirmed', 'cancelled', 'refunded_full', 'refunded_partial')
      LIMIT 1
    `).get(input.userId, input.userId)
    const hasOpenDisputes = db.prepare(`
      SELECT 1 FROM disputes
      WHERE (initiator_id = ? OR defendant_id = ?)
        AND status NOT IN ('resolved', 'closed')
      LIMIT 1
    `).get(input.userId, input.userId)
    const wallet = db.prepare(`SELECT balance FROM wallets WHERE user_id = ?`).get(input.userId) as { balance: number } | undefined
    if (hasPendingOrders || hasOpenDisputes || (wallet && wallet.balance > 0.01)) return false

    const grantIds = `SELECT grant_id FROM agent_delegation_grants WHERE human_id = ?`
    db.prepare(`UPDATE oauth_access_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND grant_id IN (${grantIds})`)
      .run(input.finalizedAt, input.userId)
    db.prepare(`UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND grant_id IN (${grantIds})`)
      .run(input.finalizedAt, input.userId)
    db.prepare(`UPDATE oauth_auth_codes SET consumed_at = COALESCE(consumed_at, ?) WHERE user_id = ?`)
      .run(input.finalizedAt, input.userId)
    db.prepare(`UPDATE verification_codes SET used_at = COALESCE(used_at, ?) WHERE user_id = ?`)
      .run(input.finalizedAt, input.userId)
    db.prepare(`
      UPDATE agent_delegation_grants
      SET status = 'revoked', revoked_at = ?, revoked_reason = 'account_deleted'
      WHERE human_id = ? AND status != 'revoked'
    `).run(input.finalizedAt, input.userId)
    db.prepare(`UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
      .run(input.finalizedAt, input.userId)
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).run(input.userId)
    db.prepare(`
      UPDATE users
      SET name = ?, handle = NULL, email = NULL, phone = NULL, bio = NULL,
          search_anchor = NULL, password_hash = NULL, api_key = ?,
          deleted_at = ?, feed_visible = 0, listing_paused = 1,
          listing_paused_reason = 'account_deleted', listing_paused_at = ?
      WHERE id = ?
    `).run(input.anonymousName, input.replacementApiKey, input.finalizedAt, input.finalizedAt, input.userId)
    db.prepare(`
      UPDATE products SET status = 'paused', updated_at = ?
      WHERE seller_id = ? AND status = 'active'
    `).run(input.finalizedAt, input.userId)
    db.prepare(`
      UPDATE user_addresses
      SET recipient = '[已注销]', phone = '[已注销]', detail = '[已注销]'
      WHERE user_id = ?
    `).run(input.userId)
    db.prepare(`UPDATE account_deletion_requests SET pii_wiped_at = ? WHERE user_id = ?`)
      .run(input.finalizedAt, input.userId)
    return true
  })()
}
