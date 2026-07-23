import type Database from 'better-sqlite3'

export interface FinalizeAccountDeletionInput {
  userId: string
  anonymousName: string
  replacementApiKey: string
  finalizedAt: string
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

    const grantIds = `SELECT grant_id FROM agent_delegation_grants WHERE human_id = ?`
    db.prepare(`UPDATE oauth_access_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND grant_id IN (${grantIds})`)
      .run(input.finalizedAt, input.userId)
    db.prepare(`UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND grant_id IN (${grantIds})`)
      .run(input.finalizedAt, input.userId)
    db.prepare(`UPDATE oauth_auth_codes SET consumed_at = COALESCE(consumed_at, ?) WHERE user_id = ?`)
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
          deleted_at = ?, feed_visible = 0
      WHERE id = ?
    `).run(input.anonymousName, input.replacementApiKey, input.finalizedAt, input.userId)
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
