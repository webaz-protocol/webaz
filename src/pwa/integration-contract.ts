/**
 * RFC-011 总入口 /.well-known/webaz-integration.json —— 集成方 agent 一次 fetch 拿到整份契约导航。
 * 按【集成方旅程】组织,每维度指向 live 端点 + 诚实标 status(✅live / 🚧 to-build)。
 * 它只【链接 + 导航】,不复制内容(各维度的真身是各自的 live 端点 / 文档),所以不漂移。
 */
import { SOFTWARE_VERSION, CONTRACT_VERSION } from '../version.js'

const BASE = 'https://webaz.xyz'
const GH = 'https://github.com/webaz-protocol/webaz/blob/main'
// 集成必需文档(规则 + onboarding)由协议自身 serve —— 外部 agent 必须能读到它被约束的规则,
// 不能指向私有 repo 的 GitHub 链接(对外 404)。RFC/审计是 provenance,留 GH(随 repo 公开解锁)。
const DOCS = `${BASE}/docs`

export function buildIntegrationContract() {
  return {
    name: 'WebAZ Agent-Native Integration Contract',
    contract_version: CONTRACT_VERSION,
    software_version: SOFTWARE_VERSION,
    thesis: 'WebAZ is agent-native: you integrate by your agent reading this machine-readable contract and self-integrating — we do NOT build a bespoke API/auth/webhook layer per integrator. The protocol provides rules + semantics + boundaries + accountability + eventing + verifiability + settlement. See docs/RFC-011.',
    // 源码仓库 launch 前私有 —— 公开声明,防"自称开源但 GitHub 404"被读成 vaporware。
    source_status: 'The source repo (github.com/webaz-protocol/webaz) is PRIVATE until the W8 public launch, so GitHub links in these surfaces may return 404 until then — they open at launch, not a dead project. The full machine-readable spec is ALREADY public via these /.well-known/* surfaces; an agent never needs the repo to integrate or verify.',
    // 外部 agent 的第一道问题:"我怎么从匿名读升到能写?" —— 入口必须自答(不依赖 GitHub)。
    access: {
      browse_first: 'No account needed to START: browse the live catalog at https://webaz.xyz/#discover and read every well-known surface below anonymously. Try before you commit.',
      anonymous_read: 'no credential needed — public GET endpoints + the well-known surfaces below.',
      get_api_key: 'an api_key requires a REAL HUMAN to register at https://webaz.xyz (invite code + Passkey). Agents CANNOT self-register — this is the accountability root ("every agent has an accountable human behind it"). After the human gets the key, set it as the agent\'s bearer token.',
      how_to_get_invite: 'Pre-launch is invite-gated for Sybil resistance. Request one by leaving your email at https://webaz.xyz/#welcome (or email contact@webaz.xyz). You can browse + read everything WITHOUT an invite — it is only needed to register and write.',
      then: 'declare your write scope at POST /api/me/agents/declarations (scope tokens from the capability matrix §②); a Passkey-bound human is exempt from scope declaration. See onboarding (③).',
      tiers: 'anonymous_read → authenticated_write (api_key→passport) → value_participant (collateral). See liability_tiers below.',
    },
    // 集成方旅程 —— 每步指向背后的维度
    journey: [
      { step: 1, name: 'discover',   uses: ['this document'] },
      { step: 2, name: 'understand', uses: ['semantics ①'] },
      { step: 3, name: 'authorize',  uses: ['authz ③', 'liability ⑦'] },
      { step: 4, name: 'know_limits', uses: ['boundary ②'] },
      { step: 5, name: 'act',        uses: ['boundary ②', 'authz ③'] },
      { step: 6, name: 'stay_in_sync', uses: ['eventing ⑥'] },
      { step: 7, name: 'verify',     uses: ['verifiability ⑤'] },
      { step: 8, name: 'participate', uses: ['economic ⑧'] },
    ],
    dimensions: {
      '①_semantics':     { status: 'live', entity_dictionary: `${BASE}/.well-known/webaz-entities.json`, entities: ['order', 'product', 'dispute'], goal_index: `${BASE}/.well-known/webaz-goals.json` },
      '②_boundary':      { status: 'live', capability_matrix: `${BASE}/.well-known/webaz-capabilities.json`, negative_space: `${BASE}/.well-known/webaz-negative-space.json` },
      '③_authz':         { status: 'live', onboarding: `${DOCS}/INTEGRATOR.md`, scope_declare: `${BASE}/api/me/agents/declarations`, passport: `${BASE}/api/me/agents/:apiKeyPrefix/passport`, scope_tokens: 'from capability_matrix.write_actions' },
      '④_versioning':    { status: 'live', manifest: `${BASE}/.well-known/webaz-protocol.json`, change_feed: `${BASE}/api/agent/changes` },
      '⑤_verifiability': { status: 'live', index: `${BASE}/.well-known/webaz-verifiability.json`, passport_did: `${BASE}/.well-known/did.json`, anchor_verify: `${BASE}/api/external-anchors/:id/verify-sig`, order_chain: `${BASE}/api/orders/:id/chain (party-gated, integrity-chain not signature)` },
      '⑥_eventing':      { status: 'live', event_stream: `${BASE}/api/agent/events?since=<cursor>`, transport: 'pull (cursor), not push; party-gated; rowid cursor; signed hash-chain' },
      '⑦_liability':     { status: 'live', terms: `${DOCS}/INTEGRATOR.md`, accountability: 'api_key → user → passport (5 metrics + custodian); enforced: scope-403 / rate-strike / cross-user-cap / dispute-fault → 3-strike block; appeal: /api/me/agents/strikes/:id/appeal' },
      '⑧_economic':      { status: 'live', index: `${BASE}/.well-known/webaz-economic.json`, note: 'value-participant roles × earns/collateral/liability; rates read live from protocol_params (doc=code). Generic third-party insurer onboarding marked scaffolded (own RFC + enters-core gate).' },
    },
    negative_space: {
      forbidden: ['rebuild cross-user graph / aggregate cross-user data (meta-rule #3)', 'resell user data', 'impersonate a user or the protocol', 'exceed declared scope'],
      enforced_by: ['default-deny write boundary (capability_matrix)', 'cross-user read cap', 'accountability strikes + api-key block'],
      meta_rules: `${DOCS}/META-RULES-FULL.md`,
    },
    liability_tiers: [
      { tier: 'anonymous_read',   net: 'outside accountability net', caveat: 'public/Schema.org reads; caveat-emptor; no writes' },
      { tier: 'authenticated_write', net: 'in net via api_key→passport', liability: 'responsible party; misuse → strikes/block' },
      { tier: 'value_participant', net: 'in net + collateral-bound', liability: 'highest; conserved + collateral/reputation-backed (⑧/RFC-008)' },
    ],
    enters_core_test: 'A capability enters the protocol (vs integrator self-solving) iff ALL: ≥N independent integrators need it × needs cross-party trust/verification × cannot be reconstructed from already-exposed data.',
    iron_rule: 'arbitrate / vote / agent_revoke / delete_passkey / large withdraw require a live WebAuthn ceremony regardless of declared scope.',
    references: {
      // RFC-011 is the public formalization of the agent-native integration audit; the audit doc itself is
      // an internal artifact (not in the public tree), so it is not advertised as a reference here.
      rfc_011: `${GH}/docs/rfcs/RFC-011-agent-native-integration-contract.md`,
      manifest: `${BASE}/.well-known/webaz-protocol.json`,
    },
  }
}
