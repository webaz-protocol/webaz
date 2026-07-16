import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

export function migrateProtocolToPublicLaunch(db: Database.Database): void {
  try {
    const marker = db.prepare("SELECT value FROM system_state WHERE key = 'migration_public_launch_20260716'").get()
    if (marker) return
    db.prepare("INSERT OR IGNORE INTO system_state (key, value) VALUES ('protocol_phase', 'launched')").run()
    const changed = db.prepare("UPDATE system_state SET value = 'launched' WHERE key = 'protocol_phase' AND value = 'pre_launch'").run()
    db.prepare("INSERT OR IGNORE INTO system_state (key, value) VALUES ('migration_public_launch_20260716', '1')").run()
    if (changed.changes > 0) console.log('[WebAZ] protocol phase migrated: pre_launch -> launched')
  } catch (e) { console.warn('[WebAZ] public launch migration', e) }
}

export function seedPublicLaunchConsentV12(db: Database.Database): void {
  if (db.prepare("SELECT version FROM rewards_consent_texts WHERE version = '1.2'").get()) return
  const textZh = 'WebAZ 分享分润开通(rewards opt-in) v1.2 — 由 RFC-002 §3.3 / §3.10 定义。本同意仅用于记录分享分润相关的经济关系:Passkey 真人签名、推荐关系/左右区位置、佣金/PV/escrow 结算规则。本流程不是购物流程,也不是共建贡献资格;不影响贡献任务、GitHub 贡献认领或普通下单。佣金层级按地区合规配置生效;当前全局上限为 1 级,“三级”仅为协议最大设计。你可以随时退出,退出不影响已下单或未来订单;已发生的订单和结算按当时有效规则处理。'
  const textEn = 'WebAZ share-commission opt-in v1.2 — defined by RFC-002 §3.3 / §3.10. This consent only records the economic relationship for share commission: Passkey-signed proof of personhood, referral relationship / left-right placement, and commission / PV / escrow settlement rules. This is not a shopping flow and not contribution eligibility; it does not affect contribution tasks, GitHub contribution claims, or normal orders. Commission levels follow per-region compliance configuration; the current global cap is 1 level, and “three tiers” is only the protocol maximum design. You may leave at any time without affecting past or future orders; already-created orders and settlements follow the rules effective at that time.'
  const hash = createHash('sha256').update(textZh + '\n---\n' + textEn).digest('hex')
  const v11 = db.prepare("SELECT effective_at FROM rewards_consent_texts WHERE version = '1.1'").get() as { effective_at: number } | undefined
  const effectiveAt = Math.max(Date.now(), (v11?.effective_at ?? 0) + 1)
  db.prepare(`INSERT INTO rewards_consent_texts (version, hash, change_class, effective_at, text_zh, text_en, changelog)
              VALUES (?, ?, 'minor', ?, ?, ?, ?)`)
    .run('1.2', hash, effectiveAt, textZh, textEn, 'v1.2 wording refresh — WebAZ publicly launched; economic terms and current 1-level cap unchanged; v1.1 remains immutable')
}
