import type Database from 'better-sqlite3'

export class PriceSessionConsumeError extends Error {}

export function consumePriceSession(db: Database.Database, token: string | undefined): void {
  if (!token) return
  const result = db.prepare(`UPDATE price_sessions SET used_at = datetime('now') WHERE token = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')`).run(token)
  if (result.changes !== 1) throw new PriceSessionConsumeError('session_token 已使用，请重新调用 verify-price')
}
