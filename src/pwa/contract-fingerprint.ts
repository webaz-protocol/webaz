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
export interface ContractChange { contract_version: number; date: string; surface: 'capability' | 'entity' | 'versioning' | 'eventing' | 'integration' | 'all'; kind: 'genesis' | 'added' | 'changed' | 'deprecated' | 'removed'; summary: string; migration?: string }
export const CONTRACT_CHANGES: ContractChange[] = [
  { contract_version: 1, date: '2026-06-06', surface: 'all', kind: 'genesis', summary: 'Contract v1 baseline: capability matrix (§②), entity dictionary + order lifecycle (§①), event cursor stream (§⑥), two version axes (§④).' },
  { contract_version: 2, date: '2026-06-06', surface: 'entity', kind: 'added', summary: '§① entity dictionary gains product + dispute entities (conservative public fields; dispute = redacted dispute_cases) + goal_index pointer. Additive — existing order entity unchanged; agents may ignore.' },
  { contract_version: 3, date: '2026-06-09', surface: 'entity', kind: 'changed', summary: '§① order lifecycle: corrected declined_nofault state meaning text — it is NOT terminal (transitions declined_nofault→completed on settlement). Dropped the contradictory "(terminal)" label that conflicted with the auto-derived terminal:false. Semantics/state-machine unchanged; text-only clarification for agents reading the entity dictionary.' },
  { contract_version: 4, date: '2026-06-09', surface: 'capability', kind: 'changed', summary: '§② capability matrix: POST /api/reviews/:type/:id/claim now requires the new "review_claim" action scope instead of being SAFE (unscoped). The review-claim path locks a 5 WAZ stake (escrow), so it belongs under default-deny accountability like other value writes. GET reviews endpoints stay open.', migration: 'A declared agent that calls review claim must add the "review_claim" scope to its api_key (or hold a Passkey, or declare "*"). Passkey-bound humans and "*" agents are unaffected; GET reviews unchanged.' },
  { contract_version: 5, date: '2026-06-24', surface: 'integration', kind: 'added', summary: '§④ integration-contract entry (/.well-known/webaz-integration.json) gains an agent_quickstart block: a 60-second stranger-agent cold-start with discrete, machine-parseable fields (canonical_start_url, public_readonly_entrypoints, anonymous_allowed_actions, authenticated_required_actions, safe_next_actions, proposal_flow, contribution_boundary). Additive — no existing field changed; agents may ignore. NB: this surface is NOT covered by the §②/§① fingerprint, so it is registered here by hand.' },
  { contract_version: 6, date: '2026-06-27', surface: 'entity', kind: 'added', summary: '§① order lifecycle gains two Direct Pay Rail 1 (non-custodial off-protocol payment) states: direct_pay_window (seller fee-stake locked, payment method shown, awaiting buyer off-protocol payment) and direct_expired_unconfirmed (payment window timed out without buyer confirmation — order is NOT silently closed; buyer retains a dispute/confirm window). Additive — existing order states/transitions unchanged; escrow orders never enter these states; agents may ignore unless they place direct_p2p orders.' },
  { contract_version: 7, date: '2026-06-27', surface: 'capability', kind: 'added', summary: '§② capability matrix RESERVES a new "direct_pay" action scope for the future /api/direct-pay/* surface (Direct Pay Rail 1). SCAFFOLD ONLY: this revision ships the D1/D2 disclosure helper + append-only ack model and a Passkey RISK-guard helper for later wiring — NO production route is gated yet, and the current order-action paths (mark_paid / cancel / confirm / confirm-in-person) do NOT yet enforce the Passkey or the two-disclosure-ack gate. The classifier maps /api/direct-pay/* → direct_pay so that surface is RISK-scoped the moment routes are added. Additive — no existing action changed.', migration: 'No behavioural change yet — do NOT assume Direct Pay order actions are Passkey-gated or disclosure-gated at this revision, and do NOT assume agents are blocked from them. Real enforcement (Passkey + two-disclosure-ack on mark_paid/confirm/confirm-in-person) is wired in a later PR together with the create route, ack endpoints, and UI.' },
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
