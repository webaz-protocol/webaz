/**
 * RFC-011 §④ 契约变更体系 —— 让 feed 诚实(防 CHANGELOG-rot 那个失败模式)。
 *
 * 思路:给每个【契约面】(②能力矩阵 / ①实体字典)算确定性指纹(canonical + sha256),
 *   排除 software_version 等易变位 —— 只盖集成方依赖的契约内容。committed 基线 docs/CONTRACT-LOCK.json
 *   按 contract_version 锁;tests/test-contract-fingerprint.ts 守卫:指纹变了但 CONTRACT_VERSION 没 bump
 *   → FAIL,逼"bump + 写 CONTRACT_CHANGES 条目 + 更基线"。静默改契约不可 merge(= schema:verify 模式)。
 *
 * 版本模型:CONTRACT_VERSION = 契约内容修订号,任何 integrator-observable 变更都 bump;
 *   变更条目的 kind(added|changed|deprecated|removed)由人分类是否破坏性(additive agent 可忽略)。
 */
import { createHash } from 'node:crypto'
import { capabilityMatrix } from './endpoint-actions.js'
import { buildEntityDictionary } from './entity-dictionary.js'
import { canonicalSerialize } from '../layer0-foundation/L0-2-state-machine/order-chain.js'
import { CONTRACT_VERSION } from '../version.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

// 契约投影 —— 只取集成方依赖的契约内容,【排除】software_version / 易变 roadmap(todo)。
function contractProjection() {
  const cap = capabilityMatrix()
  const ent = buildEntityDictionary()
  return {
    capability: { model: cap.model, write_actions: cap.write_actions, safe_write_unscoped: cap.safe_write_unscoped, read_scopes: cap.read_scopes, notes: cap.notes },
    entity: { note: ent.note, entities: ent.entities },   // 注:不含 ent.software_version / ent.todo
  }
}

export function contractFingerprints(): { contract_version: number; capability: string; entity: string; combined: string } {
  const p = contractProjection()
  const capability = sha256(canonicalSerialize(p.capability))
  const entity = sha256(canonicalSerialize(p.entity))
  return { contract_version: CONTRACT_VERSION, capability, entity, combined: sha256(`${capability}|${entity}`) }
}

// 契约变更注册表(authored)—— 每个 integrator-observable 变更一条;agent 按 since 取比它新的。
export interface ContractChange { contract_version: number; date: string; surface: 'capability' | 'entity' | 'versioning' | 'eventing' | 'all'; kind: 'genesis' | 'added' | 'changed' | 'deprecated' | 'removed'; summary: string; migration?: string }
export const CONTRACT_CHANGES: ContractChange[] = [
  { contract_version: 1, date: '2026-06-06', surface: 'all', kind: 'genesis', summary: 'Contract v1 baseline: capability matrix (§②), entity dictionary + order lifecycle (§①), event cursor stream (§⑥), two version axes (§④).' },
  { contract_version: 2, date: '2026-06-06', surface: 'entity', kind: 'added', summary: '§① entity dictionary gains product + dispute entities (conservative public fields; dispute = redacted dispute_cases) + goal_index pointer. Additive — existing order entity unchanged; agents may ignore.' },
  { contract_version: 3, date: '2026-06-09', surface: 'entity', kind: 'changed', summary: '§① order lifecycle: corrected declined_nofault state meaning text — it is NOT terminal (transitions declined_nofault→completed on settlement). Dropped the contradictory "(terminal)" label that conflicted with the auto-derived terminal:false. Semantics/state-machine unchanged; text-only clarification for agents reading the entity dictionary.' },
  { contract_version: 4, date: '2026-06-09', surface: 'capability', kind: 'changed', summary: '§② capability matrix: POST /api/reviews/:type/:id/claim now requires the new "review_claim" action scope instead of being SAFE (unscoped). The review-claim path locks a 5 WAZ stake (escrow), so it belongs under default-deny accountability like other value writes. GET reviews endpoints stay open.', migration: 'A declared agent that calls review claim must add the "review_claim" scope to its api_key (or hold a Passkey, or declare "*"). Passkey-bound humans and "*" agents are unaffected; GET reviews unchanged.' },
]

export function buildChangeFeed() {
  return {
    current_contract_version: CONTRACT_VERSION,
    fingerprints: contractFingerprints(),
    deprecation_policy: 'Sunset-bound surfaces carry RFC 8594 Deprecation + Sunset headers; window ≥ 1 contract_version. Any integrator-observable contract change bumps contract_version and appends a change entry (kind: added|changed|deprecated|removed). A fingerprint CI guard makes a silent change un-mergeable.',
    deprecations: [] as Array<{ surface: string; sunset: string; replacement?: string }>,
    changes: CONTRACT_CHANGES,
    note: 'Poll with your last-seen contract_version and apply entries with a higher contract_version. The fingerprints let you detect drift without diffing the whole contract: if combined != your cached value, re-read /.well-known/webaz-{capabilities,entities}.json.',
  }
}
