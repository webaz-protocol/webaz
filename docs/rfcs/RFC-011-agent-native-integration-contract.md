# RFC-011: Agent-Native Integration Contract — 8 dimensions along the integrator journey / Agent-Native 接入契约

**Status**: draft (design) — all 8 dimensions shipped & live; remaining sub-item ⑧ generic external-underwriter onboarding now specified in **RFC-012** (design-only, gated on real demand) — 2026-06-07
**Author**: @seasonkoh + agent
**Track**: normal — new integration surface (publishes existing enforcement + adds an event stream). Touches data boundary (元规则 #3), accountability (iron-rule), and an external value-participant path (economics — that part may split to its own RFC). Does NOT change merge authority or fund conservation.
**Related**: open-protocol moat · the agent-native integration contract · `src/pwa/endpoint-actions.ts` (capability matrix, shipped #126) · `src/version.ts` (version axes, shipped #125) · `order_events` chain (eventing substrate) · META-RULES-FULL.md#3 · RFC-006 (accountability primitives) · RFC-008 (collateral/economics)

---

## Summary / 摘要

WebAZ is **agent-native**: a third party integrates not by us building a bespoke API/auth/webhook layer for them, but by **their agent reading a machine-readable contract and self-integrating**. This RFC defines that contract — one discoverable entry point `/.well-known/webaz-integration.json` that strings together **8 dimensions** along the **integrator journey**, each backed by a live, code-derived surface (doc=code). The protocol's job is **rules + semantics + boundaries + accountability + eventing + verifiability + settlement**, not bespoke integration code. "agent-native 接入 = 用规则约束,不是用接口约束。"

This is **规则工程,不是功能工程**: ~70% is *publishing already-enforced rules* (generated from code, never drifting), ~30% is genuinely new (the event stream, the change feed, the integrator liability + economic-participation contract). Almost none is "building features per integrator".

---

## The integrator journey / 集成方旅程(组织主轴)

The contract is organized as the journey an external agent walks, each stage backed by ≥1 dimension. An integrator takes only the stages it needs (a read-only dashboard walks 1-2-3-5read-7; a logistics agent walks all of it incl. ⑥⑧).

```
 1. DISCOVER      → /.well-known/webaz-integration.json(本契约,指向各维度 live 端点)
 2. UNDERSTAND    → ① 语义(实体字典 + 目标索引)
 3. GET AUTHORITY → ③ 授权  +  ⑦ 责任(成为可问责责任主体)
 4. KNOW LIMITS   → ② 边界(正:能力矩阵 / 负:禁区+限频)
 5. ACT           → 在 scope 内读写(用 ②③)
 6. STAY IN SYNC  → ⑥ 事件(可验签游标事件流,agent 拉)
 7. VERIFY        → ⑤ 可验证(消费的数据可独立验真)
 8. PARTICIPATE   → ⑧ 经济参与(可选:作为价值参与方收/付/押)
        贯穿：④ 版本(契约兼容轴) · ⑦ 责任(整条旅程的问责)
```

---

## The entry point / 总入口 `/.well-known/webaz-integration.json`

A single machine-readable contract an integrator's agent fetches once, carrying both version axes and pointing to every dimension's live surface:

```jsonc
{
  "contract_version": 1, "software_version": "0.1.x",     // ④ 两轴(src/version.ts)
  "journey": ["discover","understand","authorize","limits","act","sync","verify","participate"],
  "dimensions": {
    "semantics":        { "entity_dictionary": "/.well-known/webaz-entities.json", "goal_index": "/api/agent/goal-index" },
    "capability":       { "matrix": "/.well-known/webaz-capabilities.json" },        // ② shipped #126
    "authz":            { "onboarding": ".../docs/INTEGRATOR.md", "scope_declare": "/api/me/agents/:k/scope" },
    "versioning":       { "manifest": "/.well-known/webaz-protocol.json", "change_feed": "/api/agent/changes" },  // ④
    "verifiability":    { "index": "/.well-known/webaz-verifiability.json", "passport_did": "/.well-known/did.json" },
    "eventing":         { "stream": "/api/agent/events?since=<cursor>&scope=<...>" },  // ⑥
    "liability":        { "terms": ".../docs/INTEGRATOR.md#liability", "accountability": "passport + strikes + blocklist" },
    "economic":         { "participation": ".../docs/INTEGRATOR.md#economic", "examples": ["anchor-verify-fee","order-insurance","logistics-fee"] }
  },
  "negative_space": { "forbidden": ["rebuild cross-user graph","resell user data (#3)","impersonate"], "rate": "/.well-known/webaz-capabilities.json#rate" }
}
```

---

## The 8 dimension clauses / 八维度契约条款

Each clause: **what is published · the invariant · status** (✅shipped / 🧱substrate-exists / 🆕to-build).

### ① Semantics 〔stage 2〕
- **Publish:** an **entity dictionary** (`/.well-known/webaz-entities.json`) — each public entity × field × type × meaning × lifecycle state-machine × *verifiable-field flag*, generated from schema + `transitions.ts` + a thin meaning-annotation layer; and a **goal index** (`goal → tools/endpoints/scopes`), extending MCP `search_routing` (#1072).
- **Invariant:** structure is generated from code (no hand-drift); only the meaning layer is authored.
- **Status:** 🟢 **shipped** (#PR). Entity dictionary `/.well-known/webaz-entities.json` now covers **order + product + dispute**: order lifecycle generated from `transitions.ts` (doc=code, lock-tested); product + dispute conservative public field sets (product excludes internal moderation/ranking inputs; the public dispute entity is the **redacted post-ruling `dispute_cases`** — amount bucketed, `buyer_id`/`dispute_id` excluded, live case party+arbitrator-gated). **Goal index** `/.well-known/webaz-goals.json` (22 goals: intent → capability action §② + endpoint + MCP tool + PWA page), generalizing MCP `search_routing` (#1072). doc=code lock: every goal.action is `open` or a real capability-matrix token (`tests/test-goal-index.ts`). Adding the entities is an integrator-observable contract change → **CONTRACT_VERSION 1→2** (kind:`added`) + change-feed entry + CONTRACT-LOCK regenerated (first real §④ change end-to-end). Tests: `tests/test-entity-dictionary.ts` (no-PII guard) + `tests/test-goal-index.ts` + `tests/test-order-lifecycle-contract.ts`.

### ② Boundary 〔stage 4〕
- **Publish:** the **capability matrix** (`/.well-known/webaz-capabilities.json`) — write action-scopes + sensitive-read scopes + SAFE list, serialized from the *same* declarative rule table that enforces (`src/pwa/endpoint-actions.ts`); plus the **negative space** — forbidden behaviours (no cross-user graph rebuild / no data resale per #3 / no impersonation) + a unified **rate policy**.
- **Invariant:** matrix is the live enforcement rules (doc=code, 420-combo equivalence test locked). Negative space is enforced, not just stated.
- **Status:** ✅ **shipped**. Positive matrix #126; negative space now live at `/.well-known/webaz-negative-space.json` (+ `/api/agent/negative-space`): forbidden behaviours (meta-rule #3) + the ENFORCED rate/cap limits + the 3-strike consequence ladder. doc=code: the numeric cap tables are extracted to `src/pwa/limits.ts` and read by BOTH the runtime enforcer (server.ts) and this publisher (zero drift, same as #126); per-agent rate caps read live from protocol_params. Tests: `tests/test-negative-space.ts` (published caps == limits.ts source + live-rate read-through).

### ③ Authorization + Accountability 〔stage 3〕
- **Publish:** integrator onboarding (`docs/INTEGRATOR.md`) — how to obtain a scoped api_key, declare actions, and the **three liability tiers**: *anonymous read* (Schema.org/public endpoints, outside the accountability net, caveat-emptor) · *authenticated write* (in the net via api_key→user→passport, liable) · *value participant* (⑧, collateral-bound).
- **Invariant:** default-deny (undeclared + no Passkey → no write); iron-rule live-WebAuthn for arbitrate/vote/large-withdraw regardless of scope.
- **Status:** ✅ **shipped** — mechanism (scope + default-deny middleware + passport) + integrator-facing packaging `docs/INTEGRATOR.md` (register → `POST /api/me/agents/declarations` with `declared_scope.actions` ← capability matrix → act; the three access tiers anon-read / auth-write / value-participant explicit).

### ④ Versioning 〔cross-cutting〕
- **Publish:** two axes (`software_version` from package.json, never drifts; `contract_version` integer, bumps only on a breaking contract change) in every contract doc; a **change feed** (`/api/agent/changes`) listing contract changes + deprecations; response **deprecation headers** on sunset-bound surfaces.
- **Invariant:** `contract_version` bumps **iff** an integrator-observable contract breaks; software releases never bump it.
- **Status:** ✅ **shipped** — two-axis single source (#125) + change feed `/api/agent/changes` (current_contract_version + per-surface contract fingerprints + change registry + deprecation policy) + a **contract-fingerprint guard** (`docs/CONTRACT-LOCK.json` + `npm run contract:verify` / `tests/test-contract-fingerprint.ts`): a silent contract-surface change without a CONTRACT_VERSION bump is **un-mergeable** (the anti-CHANGELOG-rot mechanism; negative-tested to bite). Deprecation headers (RFC 8594) — policy defined, mechanism deferred until a real sunset. CHANGELOG currency is a separate release chore.
  - *Refined version model:* `contract_version` bumps on **any** integrator-observable contract change (additive or breaking); the change entry's `kind` (added/changed/deprecated/removed) classifies whether it breaks — avoids auto-detecting "breaking".

### ⑤ Verifiability 〔stage 7〕
- **Publish:** a **verifiability index** (`/.well-known/webaz-verifiability.json`) — for each verifiable artifact (agent passport / external anchor / AP2 mandate / order-chain event), *what it proves* + *how to verify* (ecrecover / sig-check / hash-chain), pointing to issuer keys (well-known) and the DID document.
- **Invariant:** verification requires no call back to WebAZ (offline-verifiable where signed).
- **Honesty grade (no over-claim):** each artifact carries a `level` — `public_signature` (passport/AP2: any third party ecrecover/sig-checks offline) / `public_endpoint` (anchor) / `integrity_chain` (order-chain: the per-event `signature` is an HMAC with the actor's api_key → **NOT** third-party verifiable; what *is* verifiable is hash-chain continuity = tamper-evidence) / `party_gated` (full contents only to order parties).
- **Status:** 🟢 **shipped** (#PR). Live unified index `/.well-known/webaz-verifiability.json` + `/api/agent/verifiability`, linked from manifest `agent_endpoints.verifiability_index` and the entry point ⑤. Tests: `tests/test-verifiability-index.ts` (4 artifacts + honest levels; guards order-chain is NOT mislabeled public-signature). Open question (opening the order-chain proof beyond parties) deferred to ⑧/§Open.

### ⑥ Eventing 〔stage 6〕 ★ the v2 correction
- **Publish:** a **cursor event stream** (`/api/agent/events?since=<cursor>&scope=<...>`) — an integrator's agent pulls "all changes relevant to me since cursor X", each event carrying its `order_events` seq + signed `event_hash` (so it is also a ⑤ proof). Scope-gated by the agent's relationship to the data (元规则 #3 — you only see events for orders/entities you are party to or have declared scope for). Pull, not push (no per-integrator webhooks).
- **Invariant:** an event stream **never** exposes data the agent couldn't already read under ②③ (the stream is a *liveness layer over the read boundary*, not a new read grant); ordering + integrity guaranteed by the signed seq-chain.
- **Status:** ✅ **shipped** — `GET /api/agent/events?since=<rowid cursor>` (party-gated to your own orders = the `/chain` gate; structural events + hash-chain fields; rowid cursor = insertion-monotonic, complete + dup-free incremental; HMAC sig not exposed; in the manifest `agent_endpoints`). Tests: `tests/test-order-event-feed.ts`. The `order_events` signed seq-chain did the heavy lifting per invariant 2.

### ⑦ Liability / Recourse 〔stage 3, cross-cutting〕 ★ v2-new
- **Publish:** the integration **liability terms** (`docs/INTEGRATOR.md#liability`) — an integrator agent acting via api_key is a **responsible party** (谁责任谁承担); misuse (false status, bad data, over-aggregation) → strikes / api-key block / passport risk, with an appeal path; the anon/auth/participant tiers carry escalating liability.
- **Invariant:** liability follows authority — more authority (write > read; participant > write) ⇒ more accountability; iron-rule human gates unbypassable.
- **Status:** ✅ **shipped** — machinery (`agent_strikes` 3-strike, blocklist, passport, isApiKeyBlocked) contract-ized in `docs/INTEGRATOR.md`: integrator = responsible party; **enforced** (scope-403 / rate-abuse strike / cross-user-read cap / dispute-fault → 3-strike block) honestly separated from **policy** (meta-rule #3 no-resale — accountability+audit, not full auto-detect); appeal path + iron-rule documented. Tiered with ③.

### ⑧ Economic Participation 〔stage 8〕 ★ v2-new
- **Publish:** the **value-participant path** (`docs/INTEGRATOR.md#economic`) — how an external integrator becomes a paid/paying participant (e.g. external insurer: premium in / payout out; external logistics: delivery fee + collateral; verifier: anchor-verify fee), bound to ⑦ liability + collateral (RFC-008 stake model) and fund-conservation (never mint).
- **Invariant:** every integrator value flow is **conserved + accountable + collateral-or-reputation-backed** — same fairness as the core (责任自负 / 守恒 / 无责零成本).
- **doc=code:** the index reads **live** rates/thresholds from `protocol_params` at request time — it can never drift from the enforced economics (the exact anti-decoration discipline of #1094). Conservation is stated as a hard invariant (forfeit redistributed via `settleFault`, never minted).
- **Status:** 🟢 **shipped** (#PR). Live unified index `/.well-known/webaz-economic.json` + `/api/agent/economic-participation`, linked from manifest `agent_endpoints.economic_participation` and the entry point ⑧. 8 value-participant roles (seller_shop / seller_secondhand / promoter / logistics / anchor_verifier / arbitrator / skill_author = **live**; generic third-party **insurer = scaffolded** → own RFC + enters-core gate, no premature interface). Each role: enters-as × earns (live rate) × collateral × liability (fault states + conservation) × gate × enforced_by. Tests: `tests/test-economic-participation.ts` (live-rate read-through + conservation + honest scaffolded status). Generic external-underwriter onboarding remains the one genuinely-new piece, now specified in **RFC-012** (collateralized risk-cover bound to RFC-008; design-only, gated on real demand; NOT licensed insurance — see its §Compliance).

---

## Invariants (locked) / 不变量

1. **doc=code for enforced surfaces** — the capability matrix (②) and event stream (⑥) are *serialized from the same rules/log that enforce*; an integrator never reads a stale hand-written copy. Equivalence/behaviour tests gate any refactor of an enforced surface.
2. **Liveness ≤ read boundary** — the event stream (⑥) never reveals what ②③ wouldn't already let the agent read. Eventing is a layer over the boundary, not a hole in it.
3. **Authority ⇒ accountability (⑦)** — anon read < authed write < value participant, each tier more liable; iron-rule human gates unbypassable by any scope.
4. **Conservation for participants (⑧)** — every integrator value flow conserves + is collateral/reputation-backed; never mints (same as settleFault/settleOrder).
5. **Pull, not push** — no bespoke per-integrator webhooks; one signed cursor stream the agent pulls. No bespoke per-integrator API.
6. **Versioned contract** — `contract_version` bumps iff an integrator-observable break; published in every contract doc; breaking changes carry a change-feed entry + deprecation window.

---

## "Enters core" test / "进 core" 判据(bound the 10%)

A capability enters the protocol (vs an integrator self-solving on existing data) **iff all three**: **≥N independent integrators need it × it requires cross-party trust/verification × it cannot be reconstructed from already-exposed data.** Otherwise it stays the integrator's agent-glue.

---

## Staged delivery / 分阶段(v2 sequencing)

Each a single-topic PR, doc=code where the surface is enforced, behaviour-locked by tests.

1. **⑥ Event cursor-stream (P0)** — expose `order_events` as a scope-gated "since cursor" signed change stream. Substrate exists; this is the scale geba. *(Invariant 2 + the signed seq-chain do the heavy lifting.)*
2. **① Entity dictionary + goal index *(shipped)*** — order/product/dispute entities (`/.well-known/webaz-entities.json`) + 22-goal index (`/.well-known/webaz-goals.json`, intent→capability action, doc=code-locked). CONTRACT_VERSION→2.
3. **④ Change feed + deprecation signals (P0)** — `/api/agent/changes` + response deprecation headers + CHANGELOG currency.
4. **② Negative-space + ③⑦ integrator packaging (P1)** — unified rate/forbidden policy published + enforced; `docs/INTEGRATOR.md` with the anon/auth/participant liability tiers.
5. **⑤ Verifiability index *(shipped)*** — `/.well-known/webaz-verifiability.json` + `/api/agent/verifiability`: each artifact (passport / anchor / AP2 / order-chain) with what-it-proves + how-to-verify + an honest `level` (public_signature / public_endpoint / integrity_chain / party_gated; order-chain's HMAC is NOT third-party-verifiable, only the hash-chain is). Static (no DB/issuer dep), keys referenced via did.json. Tests: `tests/test-verifiability-index.ts`. **⑧ Economic participation *(shipped)*** — `/.well-known/webaz-economic.json`: 8 value-participant roles × earns (live rate from protocol_params) × collateral × conserved liability × gate; generic insurer marked scaffolded (own RFC + enters-core gate). Tests: `tests/test-economic-participation.ts`.
6. **The entry point** `/.well-known/webaz-integration.json` *(shipped)* — the journey-organized navigation doc linking every dimension's live endpoint, with honest per-dimension status (all 8 dimensions live; generic insurer onboarding within ⑧ marked scaffolded), the negative space, the three liability tiers, the enters-core test, and the iron-rule. Links-only (no content copy → no drift). Tests: `tests/test-integration-contract.ts` (8 dims + journey + no-empty-URL); no-dead-link crawl verified the referenced public well-knowns return JSON.

**Already shipped as starting assets:** ② capability matrix (#126), ④ version two-axis single-source (#125), ⑥ signed seq-chain substrate (order_events).

## Open questions / 待议
- Does the order-chain proof (⑤/⑥) open beyond parties? (lean: events expose *that* a transition happened + its signed hash to scoped integrators, but PII redaction per #1015 — the proof is integrity, not contents.)
- Does ⑧ (external value participant) split into its own RFC given it touches fund flows + collateral + CHARTER economics? (lean: yes, once a real external insurer/logistics integrator appears.)
- Push transport later (SSE/webhook-with-DCO-style-accountability) for latency-sensitive integrators, or pull-only? (lean: pull-only until a real latency need; push is the bespoke trap.)
