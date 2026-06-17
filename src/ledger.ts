/**
 * Wallet ledger helpers (RFC-014) — 钱包资金写入的【唯一】入口:整数 base-units + 绝对值落库。
 *
 * 为什么绝对值:REAL 列上 `col = col + ?` 是 IEEE754 加法,即使 delta 干净也会漂移
 *   (1402.73 + 4.67 = 1407.3999999999)。读→单位算→写 toDecimal(绝对值)落库的是规范 double,
 *   消灭这种漂移(存储仍 REAL,schema 改 INTEGER 是 RFC-014 P3)。
 *
 * 由 PR2(engine settle*)首次引入(原私有于 engine.ts),PR3 抽到此处共享,供所有资金路径复用,防多份漂移。
 */
import type Database from 'better-sqlite3'
import { toUnits, toDecimal, type Units } from './money.js'

export type WalletField = 'balance' | 'staked' | 'escrowed' | 'earned'

/** 读某用户钱包当前余额(整数 base-units)。无钱包行 → 全 0。 */
export function walletUnits(db: Database.Database, userId: string): Record<WalletField, Units> {
  const r = db.prepare('SELECT COALESCE(balance,0) balance, COALESCE(staked,0) staked, COALESCE(escrowed,0) escrowed, COALESCE(earned,0) earned FROM wallets WHERE user_id = ?')
    .get(userId) as Record<WalletField, number> | undefined
  return { balance: toUnits(r?.balance ?? 0), staked: toUnits(r?.staked ?? 0), escrowed: toUnits(r?.escrowed ?? 0), earned: toUnits(r?.earned ?? 0) }
}

/**
 * 对钱包字段施加整数单位 delta,以【绝对值】落库(读当前→加 delta→写 toDecimal)。
 *   - 字段白名单固定(balance/staked/escrowed/earned),无 SQL 注入面。
 *   - 钱包行不存在 → UPDATE 影响 0 行(与历史相对更新的静默行为一致)。
 *   - 必须在调用方的 transaction 内使用(资金路径本就如此)。
 */
export function applyWalletDelta(db: Database.Database, userId: string, deltas: Partial<Record<WalletField, Units>>): void {
  const fields = (Object.keys(deltas) as WalletField[]).filter(f => deltas[f] !== undefined && deltas[f] !== 0)
  if (fields.length === 0) return
  const cur = walletUnits(db, userId)
  const sets: string[] = []; const vals: unknown[] = []
  for (const f of fields) { sets.push(`${f} = ?`); vals.push(toDecimal(cur[f] + (deltas[f] as Units))) }
  vals.push(userId)
  db.prepare(`UPDATE wallets SET ${sets.join(', ')} WHERE user_id = ?`).run(...vals)
}

/**
 * 从某用户【先扣 staked,不足再扣 balance】,封顶其可用额(staked+balance,不转负)。返回实扣 units。
 *   争议罚没/仲裁费常用:质押优先承担,质押不够再动自由余额。绝对值落库,无浮点 dust。
 */
export function debitStakeThenBalance(db: Database.Database, userId: string, amountU: Units): Units {
  const cur = walletUnits(db, userId)
  const avail = Math.max(0, cur.staked) + Math.max(0, cur.balance)
  const actual = Math.min(Math.max(0, amountU), avail)
  if (actual <= 0) return 0
  const fromStaked = Math.min(actual, Math.max(0, cur.staked))
  const fromBalance = actual - fromStaked
  applyWalletDelta(db, userId, { staked: -fromStaked, balance: -fromBalance })
  return actual
}

/**
 * 通用基金/池表的【绝对值】入账(整数 base-units):读当前→加 delta→写 toDecimal。
 *   用于 global_fund / protocol_reserve_pool / commission_reserve / charity_fund 等单行池表。
 *   table / 列名 / whereClause 均为【代码字面量】(非用户输入)→ 无 SQL 注入面。
 *   行不存在 → UPDATE 影响 0 行(与历史相对更新一致)。
 */
export function creditColumns(
  db: Database.Database,
  table: string,
  whereClause: string,
  whereArgs: unknown[],
  deltas: Record<string, Units>,
): void {
  const cols = Object.keys(deltas).filter(c => deltas[c] !== 0)
  if (cols.length === 0) return
  const cur = db.prepare(`SELECT ${cols.map(c => `COALESCE(${c},0) AS ${c}`).join(', ')} FROM ${table} WHERE ${whereClause}`)
    .get(...whereArgs) as Record<string, number> | undefined
  const sets = cols.map(c => `${c} = ?`).join(', ')
  const vals = cols.map(c => toDecimal(toUnits(cur?.[c] ?? 0) + deltas[c]))
  db.prepare(`UPDATE ${table} SET ${sets} WHERE ${whereClause}`).run(...vals, ...whereArgs)
}
