# RFC-020: Agent Authorization — Passkey-Approved Constrained Delegation Grants

> **Status:** Draft · **Type:** Identity / Auth · **Threat-model-first**
> **Supersedes (agent path only):** handing a **permanent `api_key`** to an agent as the way to authenticate. The
> permanent key stays for **direct human / server** use (§7), but the **agent** path is deprecated in favour of
> Passkey-approved **constrained delegation grants**.
> **Augments:** RFC-003 (MCP dual-mode; the NETWORK self-register human gate) · the human-presence iron-rule
> params (`require_human_presence_for_*`) · RFC-019 (identity binding).
> **Non-goals:** rewards / scoring / tokenomics / ranking; changing what a **human** can do; a general OAuth
> provider for third parties. None of those appear here.

## 1. Problem & goal

Today an agent authenticates by the human registering at webaz.xyz (Passkey), copying their **permanent
`api_key`**, and pasting it into the agent's `WEBAZ_API_KEY`. That is the wrong default:

- **A permanent, long-lived secret ends up in the agent** — its config, context window, logs, subprocess
  env, shell history, crash reports, screen shares, or a third-party LLM provider. Leakage = **total,
  permanent account takeover.**
- **Zero scope** — the key grants everything the human can do except the Passkey-gated iron-rule actions.
- **Illegible boundary** — people can't see what an agent can/can't do, so they (rightly) don't trust it.
- **Hard to revoke/rotate** — rotating a permanent key is heavy.

**Goal:** let a human authorize a specific agent to act on their behalf with a **scoped, constrained,
short-lived, revocable** credential — never a permanent secret — while **preserving** the iron rule (funds /
governance / key actions always require a live human Passkey) and CHARTER §4 I-5 accountability (every agent
backed by a Passkey-bound human). Secure **and** usable: no hand-copied secret; one Passkey approval.

> **Design stance (decided):** "short-lived token" is **not enough** — that is just a shorter key. The unit of
> authority is a **constrained delegation grant**: `capability + constraints + expiry + agent-binding +
> revocation`, with iron-rule actions **never delegable**.

## 2. Threat model (threat-model-first)

**Assets:** the human's account, funds, reputation, identity binding; the grant credential; the master seed
(server-side only).

**Trust root:** the human's **Passkey** (WebAuthn — hardware-bound, phishing-resistant) is the *only* root of
human authority. The server validates grants; the master seed never leaves the server.

**What a grant commits to (parse-don't-validate; weakest accurate word):** a grant is **NOT "the human."** It
is a *named, constrained, time-boxed, revocable delegation* bound to a specific agent. It can do **exactly** the
granted capabilities within their constraints and **nothing else** — and it can **never** do an iron-rule
action, regardless of what it presents.

**Adversaries & required mitigations**

| # | Threat | Mitigation (this RFC) |
|---|---|---|
| T1 | Compromised agent / malicious MCP server in the chain wants to exceed scope | server enforces capability **+ constraints** on every request (§3.1); never-delegable list hard-rejected (§3.2) |
| T2 | **Prompt injection** drives the agent to move funds / register / approve | iron-rule actions are **never delegable** (§3.2) — server hard-rejects; injected agent still cannot move money |
| T3 | Credential leaks via env / logs / shell history / crash report / chat / 3rd-party LLM | credential lives in an **OS secret store**, agent holds only a **handle**; **redacted** everywhere; **not** env-default, **never** in chat (§3.4) |
| T4 | Bearer token stolen and **replayed** elsewhere | **proof-of-possession**: token bound to an agent-held keypair (PKCE/PoP, §3.3) — a stolen bearer alone can't be replayed (target design; see phasing §8) |
| T5 | Over-broad grant abused | **least-privilege constraints** (max amount, daily cap, allowed products, expiry, human-confirm) §3.1; server-generated consent shows the real scope (§3.5) |
| T6 | Malicious agent **mislabels** the consent ("place_order ≤1000" shown as "read catalog") | consent text is **server-generated from canonical capability labels** — the agent may submit only a free-text *reason* (§3.5) |
| T7 | Pairing flow attacked (code intercept, wrong approver, CSRF / clickjacking) | short-TTL **one-time** pairing code, rate-limited; approval is a Passkey ceremony on webaz.xyz with CSRF + framing protection; online revocation check (§3.6, §6) |
| T8 | "Who did this?" — accountability | per-request **audit**: human_id, agent_id, grant_id, capability, constraints, outcome, iron-rule-rejected (§3.7) |

## 3. Design — the Constrained Delegation Grant

### 3.1 Grant = capability **+ constraints** (not a string scope)

A grant is a set of `{ capability, constraints }` entries, not bare scope strings. Constraints are
**server-enforced on every request**, not advisory.

```
grant = {
  grant_id, human_id, agent_id, agent_pubkey,         // binding (§3.3)
  capabilities: [
    { capability: "catalog.read",      constraints: {} },
    { capability: "order.place",       constraints: {
        max_single_amount, daily_spend_cap, allowed_product_ids | allowed_categories,
        human_confirm_required: bool } },
    { capability: "product.list",      constraints: { max_active_listings } },
    ...
  ],
  expires_at, created_at, revoked_at,
}
```

Representative constraints (extensible): `max_single_amount`, `daily_spend_cap` (rolling window),
`expires_at`, `allowed_product_ids` / `allowed_categories`, `human_confirm_required`,
`max_active_listings`, `rate_limit`. A capability with no constraints is read-only/benign by construction.
Money fields reuse `money.ts` integer base-units (RFC-014). Spend caps are checked **server-side against the
ledger**, not trusted from the agent.

### 3.2 Never-delegable iron-rule actions (server hard-reject)

The following can **never** be carried by a grant. The server **hard-rejects** them for any grant credential
(not a UI hint), returning a typed "must be done by the human at webaz.xyz with a live Passkey" — the same
shape as RFC-003's NETWORK self-register block:

- withdraw / transfer / convert / deposit funds
- change / rotate / **create** an `api_key`; change a Passkey
- **raise a grant's own authorization limits** (no privilege self-escalation)
- governance vote · arbitration · verifier judgment
- admin / root / protocol-param operations
- account deletion / access-control / sharing changes

These already map to the `require_human_presence_for_*` iron-rule params; this RFC makes "no grant may ever
satisfy them" an explicit, server-enforced **never-delegable** set, independent of UI.

### 3.3 Pairing flow (OAuth **device-flow** shape + PKCE / PoP)

1. Agent runs anonymous (`network_readonly`). To gain write access it generates a **local keypair** and calls
   an MCP tool (`webaz_pair`) sending its **public key** + a PKCE code challenge → server returns a
   **short-TTL, one-time pairing code + URL** (no credential yet).
2. Human opens webaz.xyz (Passkey-logged-in), sees the **server-generated consent screen** (§3.5), and
   **approves with a live Passkey** (the grant itself passes the human-presence iron rule).
3. Server issues a grant **bound to the agent's public key** (proof-of-possession). The agent retrieves it via
   the pairing endpoint using its PKCE verifier; the credential is delivered to the agent's **secret store**,
   never printed (§3.4).
4. Every subsequent request proves possession of the agent key (PoP), and the server checks capability +
   constraints + revocation + expiry; iron-rule actions are hard-rejected (§3.2).

> **Why PoP, not just a bearer:** a bearer token that leaks can be replayed anywhere. Binding the token to an
> agent-held key (PoP/DPoP-style) means a leaked token alone is not usable. **Phasing (§8):** Phase 1 MAY ship
> a short-TTL bearer to land the model; **PoP/keypair binding is the target design and MUST be written in now**,
> not retrofitted.

### 3.4 Credential delivery — secret store + handle (not env, not chat)

`env` is rejected as the default: it leaks via logs, subprocesses, shell history, crash reports, debug dumps.

- The credential is stored in the **OS secret store** by the MCP/CLI client: **macOS Keychain**, with a
  cross-platform fallback to a **strict-permission local credential file** (e.g. `~/.webaz/credentials`,
  `0600`).
- The **agent holds only a credential handle**, not the secret; the MCP/CLI resolves the handle → secret at
  call time.
- The secret is **redacted** in all logs / tool output / errors / chat. It is **never** returned in an MCP
  tool response body or echoed to the human's chat.

### 3.5 Consent screen — server-generated canonical content

The consent screen is rendered from **server-side canonical capability labels**, amounts, duration, agent
name, source, and a **risk level**. The agent may submit **only a free-text `reason`** — it can **not** define
or relabel the scope text. (Prevents T6: an agent asking for `order.place ≤1000` cannot present it as "read
catalog.") The human approves the **canonical** statement with their Passkey.

### 3.6 Revocation & expiry

- Grants **expire** (`expires_at`) and are **revocable** anytime from a "**Connected agents**" dashboard
  (one-click). Revocation is checked **online on every request** (no relying on cached validity).
- Reuses/extends the existing session-revocation infrastructure (`user_sessions.revoked_at`).
- Compromise of a grant = **bounded blast radius** (capabilities × constraints × TTL) **+ instantly
  revocable**, and **never** touches the permanent key.

### 3.7 Audit model (accountability)

Every grant-authorized request records: `human_id`, `agent_id`, `grant_id`, `capability`, `constraints`
applied, `outcome`, and `iron_rule_rejected` (bool). This is what makes "every agent backed by an accountable
human" *checkable*, and gives disputes/anchor-side traceability a record.

## 4. Why this is secure (and usable)

**Secure** — addresses each threat in §2: no permanent secret in the agent (T3); least-privilege capability +
**enforced** constraints (T1, T5); iron-rule actions never delegable, server-hard-rejected (T2); PoP binding so
a leaked token can't be replayed (T4); server-generated consent (T6); one-time short-TTL pairing + CSRF/framing
protection + online revocation (T7); full per-request audit (T8). A prompt-injected or compromised agent's
**worst case is bounded** by its grant and revocable; it can never move money, vote, or mint keys.

**Usable** — the human never hand-copies a secret; they click **Approve** with their Passkey. The agent
self-onboards (anonymous → pair → constrained grant). Read works immediately; pairing happens only when write
is needed. The consent screen + Connected-agents dashboard make the boundary **legible** and revocation
one-click.

**Boundary statement (the "I don't trust giving an agent my key" answer):** *An agent grant is a scoped,
time-boxed, revocable delegation — not your account, not your keys, not your funds. It can do exactly the
capabilities you approved, within their limits, and nothing else. Moving money, voting, arbitration, and key
changes always require you (live Passkey) — no grant can ever do them. You can see and revoke any agent's
access at any time.*

## 5. Permanent `api_key` posture

- **Kept** for **direct human / server / CI** use (advanced).
- **Deprecated for the agent path:** agents use grants. Pasting a permanent key into an agent is discouraged
  in docs/UX, and any **full-permission** key surface carries a **strong warning** (it is the maximal-blast
  secret).
- Migration: existing agents keep working on the permanent key during transition; new/recommended path is
  pairing. (No hard cutover in this RFC.)

## 6. Anti-abuse

Pairing code **TTL + one-time** use; rate-limit pairing requests; **CSRF + clickjacking** protection on the
approval page; **online revocation check** per request; **token redaction**; one (or few) active grants per
(human, agent); spend caps enforced server-side against the ledger. Sybil/abuse considerations route through
the existing anti-abuse thresholds (governance-adjustable `protocol_params`).

## 7. Phasing (design now, implement later — this RFC is design-only)

- **Phase 1 (model):** grant object (capability + constraints), never-delegable hard-reject, server-generated
  consent + Passkey approval, secret-store delivery + handle + redaction, per-request audit, revocation +
  expiry. (MAY use a short-TTL bearer initially.)
- **Phase 2 (PoP):** agent keypair + PKCE/PoP binding so a leaked token can't be replayed.
- **Phase 3 (UX/breadth):** Connected-agents dashboard, richer constraints, broader capability taxonomy,
  permanent-key deprecation warnings.

Each phase is gated on a threat-model review; money/iron-rule paths follow the money-path tx atomicity +
"don't fake success" rules. **No code in this RFC.**

## 8. Open questions

> **Onboarding journeys + capability taxonomy + PR slicing** are operationalized in the companion
> [RFC-020 Implementation Plan](RFC-020-implementation-plan.md) (J1 member+agent vs J2 stranger+agent; the
> stranger-join case is guide-only — no agent path creates a live account).

1. ~~Exact capability taxonomy mapped to current endpoint actions.~~ **Resolved** — see the capability
   taxonomy (keyless / safe / risk / never-delegable) in the [Implementation Plan §3](RFC-020-implementation-plan.md).
2. PoP scheme specifics (DPoP-style header vs mTLS-lite) and Phase-1→2 migration of live grants. **Partly
   resolved:** Phase-1 MAY ship a short-TTL **bearer for short-lived *safe* scopes only**; **PoP is required
   before any risk scope or longer-lived delegation**, and PoP columns are reserved in the schema from day
   one. Exact PoP header/scheme remains open.
3. Secret-store UX across MCP clients that don't expose Keychain (the strict-perms file fallback contract).
   *(Open.)*
4. ~~Whether `human_confirm_required` per-action uses the existing Passkey human-presence gate inline.~~
   **Resolved — yes:** it reuses the existing `webauthn_gate_tokens` / `requireHumanPresence` gate inline; no
   separate grant-scoped confirmation mechanism.
5. **Grant storage (resolved):** a **new `agent_delegation_grants` table**, cross-linked to
   `agent_attestations` where useful — `agent_attestations` is **not** overloaded as the grant table.

## 9. Proposed invariants

1. No grant credential can satisfy a never-delegable action — **server-enforced**, not UI.
2. Constraints (amount/cap/expiry/products) are enforced **server-side**, never trusted from the agent.
3. Consent text is **server-generated** from canonical labels; the agent supplies only a `reason`.
4. The grant secret never appears in an MCP response, chat, or logs (redacted; handle-only to the agent).
5. Every grant-authorized request is audited (`human_id, agent_id, grant_id, capability, constraints,
   outcome, iron_rule_rejected`).
6. A grant is always **revocable + expiring**; revocation is checked online per request.
