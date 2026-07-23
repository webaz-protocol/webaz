/**
 * Verifier / Arbitrator 资格谓词(P2-E,从 server.ts 闭包抽出以可测试)。
 *
 * ★ 信誉单一真相源(P2-E 收敛):resolution 一律读 reputation_scores.total_points(真实台账,
 *   由 reputation-engine 事件流维护 + 衰减)。旧 users.reputation 列自建号起静止(默认 100,
 *   全仓零写点)——曾被本文件前身消费,构成"违约累累但资格门照过"的潜伏失守面,现已废弃不读。
 *   (列本身保留:SQLite 删列成本高且有历史行,任何新代码不得再读写它。)
 *
 * 门槛与 public-utils.ts 的公开口径(/api/public 资格文档)保持一致:
 *   verifier   = 60d / 20 单 / 0 判输 / 未暂停 / 余额 200 / reputation 110
 *   arbitrator = 90d / 50 单 / 0 判输 / 未暂停 / 余额 500 / reputation 300
 */
import type Database from 'better-sqlite3'
import { genuineSalePredicate } from '../layer0-foundation/L0-2-state-machine/genuine-sale.js'

export interface EligibilityItem { key: string; label: string; current: number | string; required: number | string; ok: boolean }
export interface EligibilityResult { eligible: boolean; items: EligibilityItem[] }

/** 真实信誉分(单一真相源):reputation_scores.total_points;无行 = 0。 */
export function liveReputationPoints(db: Database.Database, userId: string): number {
  const row = db.prepare('SELECT total_points FROM reputation_scores WHERE user_id = ?').get(userId) as { total_points: number } | undefined
  return Number(row?.total_points ?? 0)
}

function commonItems(db: Database.Database, userId: string, user: Record<string, unknown>, cfg: { ageDays: number; orders: number; balance: number; reputation: number }): EligibilityItem[] {
  const items: EligibilityItem[] = []
  const ageDays = Math.floor((Date.now() - new Date(user.created_at as string).getTime()) / 86400_000)
  items.push({ key: 'age', label: `账户年龄 ≥ ${cfg.ageDays} 天`, current: ageDays, required: cfg.ageDays, ok: ageDays >= cfg.ageDays })
  items.push({ key: 'email', label: '邮箱已验证', current: user.email_verified ? '✓' : '✗', required: '✓', ok: !!user.email_verified })
  const orders = (db.prepare(`SELECT COUNT(*) as n FROM orders WHERE (buyer_id = ? OR seller_id = ?) AND ${genuineSalePredicate('orders')}`).get(userId, userId) as { n: number }).n
  items.push({ key: 'orders', label: `完成订单 ≥ ${cfg.orders} 笔`, current: orders, required: cfg.orders, ok: orders >= cfg.orders })
  const disputeLost = (db.prepare(`
    SELECT COUNT(*) as n FROM disputes
    WHERE ((initiator_id = ? AND ruling_type = 'release_seller')
       OR  (defendant_id = ? AND ruling_type IN ('refund_buyer','partial_refund')))
       AND status IN ('resolved')
  `).get(userId, userId) as { n: number }).n
  items.push({ key: 'no_violations', label: '零仲裁判输', current: disputeLost, required: 0, ok: disputeLost === 0 })
  const wasSuspended = !!db.prepare('SELECT 1 FROM user_moderation WHERE user_id = ?').get(userId)
  items.push({ key: 'never_suspended', label: '账户未曾被暂停', current: wasSuspended ? '✗' : '✓', required: '✓', ok: !wasSuspended })
  const wallet = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId) as { balance: number } | undefined
  const balance = wallet?.balance ?? 0
  items.push({ key: 'balance', label: `钱包余额 ≥ ${cfg.balance} WAZ`, current: Number(balance).toFixed(2), required: cfg.balance, ok: balance >= cfg.balance })
  const rep = liveReputationPoints(db, userId)
  items.push({ key: 'reputation', label: `reputation ≥ ${cfg.reputation}`, current: rep, required: cfg.reputation, ok: rep >= cfg.reputation })
  return items
}

export function checkVerifierEligibility(db: Database.Database, userId: string): EligibilityResult {
  const user = db.prepare('SELECT id, name, email_verified, created_at FROM users WHERE id = ?').get(userId) as Record<string, unknown> | undefined
  if (!user) return { eligible: false, items: [] }
  const items = commonItems(db, userId, user, { ageDays: 60, orders: 20, balance: 200, reputation: 110 })
  return { eligible: items.every(i => i.ok), items }
}

export function checkArbitratorEligibility(db: Database.Database, userId: string): EligibilityResult {
  const user = db.prepare('SELECT id, email_verified, created_at FROM users WHERE id = ?').get(userId) as Record<string, unknown> | undefined
  if (!user) return { eligible: false, items: [] }
  const items = commonItems(db, userId, user, { ageDays: 90, orders: 50, balance: 500, reputation: 300 })
  return { eligible: items.every(i => i.ok), items }
}
