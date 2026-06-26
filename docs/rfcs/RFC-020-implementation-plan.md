# RFC-020 Implementation Plan — Stranger-agent onboarding & delegated auth

> **Status:** Draft · **Type:** Implementation plan (docs-only) · **Companion to**
> [`RFC-020-agent-delegation-grants.md`](RFC-020-agent-delegation-grants.md).
>
> This is **not** a competing auth model. [RFC-020](RFC-020-agent-delegation-grants.md) is the **source of
> truth** for the delegation-grant model (threat model, grant object, never-delegable set, device-flow +
> PKCE/PoP pairing, server-generated consent, audit, phasing). This document only **operationalizes** it: it
> distinguishes the two onboarding journeys, resolves RFC-020's open capability-taxonomy question against
> current endpoints, records the decisions taken, and proposes a PR slicing. Where this plan and RFC-020
> disagree, RFC-020 wins (or RFC-020 is amended).
>
> **This PR (docs-only):** no code, no schema, no MCP/route behavior changes, no weakening of
> invite/email/Passkey/live-registration gates, no money/order/status/wallet/escrow/commission/fund work.

## 1. Two journeys (RFC-020 covers only the first)

RFC-020 assumes the human already holds a Passkey account. Onboarding has **two** journeys; only J1 is
covered there.

- **J1 — Member + agent.** The human already registered at webaz.xyz (invite + email + Passkey) and wants an
  agent to act for them. → **RFC-020 pairing**: anonymous agent → `webaz_pair` → server-generated consent →
  Passkey approval → scoped, short-lived, revocable **delegation grant**. *Fully covered by RFC-020.*

- **J2 — Stranger + agent.** The human has **no account** (and maybe no invite code) and an agent is helping
  them try/adopt WebAZ. The agent's role is **guide + (optional) invite-request only — it never creates a
  live account and never bypasses a gate.** Concretely:
  1. Read-only public discovery works keyless (current `network_readonly`).
  2. To do anything that needs an account, the agent **routes the human to webaz.xyz** registration (invite +
     email + Passkey) — exactly today's `handleRegister` NETWORK-mode behavior
     (`must_be_done_by_human_at_webaz_xyz`), which is **preserved**.
  3. If the human has **no referral code**, an optional **invite-request** (PR-E) lets them lodge a request
     into the existing maintainer/quota grant path. The agent only surfaces this; it does not grant invites.
  4. Once the human has registered + has a Passkey, they fall into **J1** and pair the agent.

  **No agent path creates a live account.** J2 is "help the human cross the human-only gate," never "cross it
  for them."

## 2. Current state (verified against code)

| Capability | Today | Location |
|---|---|---|
| MCP sandbox self-register | Local-only test account (no invite/email) | `src/layer1-agent/L1-1-mcp-server/server.ts` `handleRegister()` (SANDBOX branch) |
| MCP NETWORK register | **Refused** → `must_be_done_by_human_at_webaz_xyz` + 3-step guide | same (`isNetworkMode()` branch) |
| Live PWA register | Invite gate (`require_ref_to_register` system_state) + `resolveInviteCodeRef()` (permanent_code ± L/R) + **email-code** verification | `src/pwa/routes/auth-register.ts` (`/api/register/send-code`, `/api/register`) |
| Request auth | `Authorization: Bearer <api_key>` **or** `body.api_key` → `getUser()`/`auth()`; strict Bearer money-path resolver | `src/pwa/server.ts` (`getUser`/`auth`/`recordSession`); `src/pwa/admin-bearer-auth.ts` |
| Human-presence iron-rule | `requireHumanPresence()` → 412 `HUMAN_PRESENCE_REQUIRED`, consumes one-time `webauthn_gate_tokens` minted by a Passkey ceremony | `src/pwa/human-presence.ts`; params `require_human_presence_for_*` in `server.ts` |
| Passkey ceremony | `/api/webauthn/{register,auth}/{start,finish}` with `purpose` + `purpose_data`; finish issues `wgt_*` gate token (~60s) | `src/pwa/routes/webauthn.ts`; tables `webauthn_credentials` / `_challenges` / `_gate_tokens` in `src/pwa/server-schema.ts` |
| Session revocation | `user_sessions.revoked_at` checked per request (remote logout) | `src/pwa/server-schema.ts`; `server.ts` |
| Agent attestation (precursor) | `agent_attestations(approved_scope JSON, spend_cap_per_order, spend_cap_daily, granted_at, revoked_at)` UNIQUE(api_key,user_id) | `src/pwa/server-schema.ts` |
| Audit | `admin_audit_log`, `agent_call_log`, `agent_reputation`, `agent_declarations` | `src/pwa/server-schema.ts` |
| Delegation grants / `webaz_pair` | **Not implemented** — RFC-020 design only | — |

> **Schema-file location note:** the schema-helper definitions above live in `src/pwa/server-schema.ts` on
> `main`. PR #69 (MCP fresh-DB schema bridge, currently Draft) relocates them to
> `src/runtime/webaz-schema-helpers.ts` with `src/pwa/server-schema.ts` kept as a re-export. The
> implementation PRs below should target whichever has landed: **if #69 is merged first, use the runtime
> helpers; otherwise the current location is `src/pwa/server-schema.ts`.**

**Onboarding-copy problem (drives the wrong default):** README (EN/zh-CN), `RFC-003`, `RFC-004`, MCP
`handleRegister` step 3, and ~every keyed MCP tool's `api_key` property description ("…or omit and set the
`WEBAZ_API_KEY` env var") steer the human to **copy a permanent `api_key` into `WEBAZ_API_KEY`** — the
maximal-blast secret RFC-020 deprecates for the agent path. Flipping this copy is a docs change in the
implementation phase (see PR slicing), **not** part of this companion-note PR.

## 3. Capability taxonomy (resolves RFC-020 §8 open-Q1 against current endpoints)

A grant is `{capability, constraints}`, constraints **server-enforced** (RFC-020 §3.1).

**Keyless (no grant, no key) — public discovery, unchanged:** `webaz_search`, `webaz_info`, `webaz_nearby`,
public product/profile reads (current `network_readonly`).

**Safe scopes — grantable, server-enforced constraints, no per-action Passkey:**

| Capability | Maps to | Representative constraints |
|---|---|---|
| `read_public` | public read endpoints | none (benign by construction) |
| `profile_read` | own-profile read | none |
| `search` | authed `webaz_search` variants | `rate_limit` |
| `list_product_draft` | create a **draft / unpublished** listing | `max_active_listings` |
| `product_publish_request` | submit a listing for publish (queued; **stake/commit stays human-side**) | `allowed_categories`, `max_active_listings` |
| `draft_order` | build cart / price session (`price_sessions` exists), **not** pay | `allowed_product_ids` / `allowed_categories`, `max_single_amount` (advisory at draft) |

**Risk scopes — target invariant: a live Passkey *each time* (NOT yet enforced on all of them):**
`place_order` (pay/escrow), order-status transitions (`accept`/`ship`/…), `wallet` ops, `payout`, `refund`,
dispute `arbitrate`, governance `vote`, verifier judgment, `claim_verify` decisions.

> ⚠️ **Current reality (verified on main):** the `requireHumanPresence` / 412 gate is wired today for
> **withdraw, governance `vote`, dispute `arbitrate`, identity-claim, the governance lifecycle
> (apply/activate/resign/appeal-resolve), `delete_passkey`, and `agent_revoke`** — i.e. the
> `require_human_presence_for_*` params in `server.ts`. It is **NOT** wired on order creation / order actions /
> returns / refunds / generic wallet ops — those are plain `auth()` paths today (e.g.
> `src/pwa/routes/orders-create.ts`, `src/pwa/routes/orders-action.ts`). So the "Passkey each time" line above
> is a **target / future enforcement**, not an existing protection.
>
> **Consequence for the grant work:** the grant PR (PR-B/C) **MUST default to hard-rejecting every risk scope**
> — exactly like a never-delegable action — **until** the corresponding money/state route actually adds a
> Passkey gate in its own dedicated, money-path-aware PR. A grant must never silently authorize a risk action
> just because the route lacks a gate. **No grant alone authorizes a risk scope.**

**Never-delegable (server hard-reject — RFC-020 §3.2; no grant may ever satisfy these):** withdraw / transfer
/ convert / deposit funds; create / rotate / reveal `api_key`; change Passkey; **raise a grant's own limits**
(no self-escalation); account deletion; access-control / sharing changes; admin / root / protocol-param ops;
**creating a live account.** Presenting any of these returns the typed "do it at webaz.xyz with a live
Passkey" rejection (same shape as RFC-003's NETWORK self-register block).

## 4. Non-goals

Inherits RFC-020's non-goals (no rewards / scoring / tokenomics / ranking; no change to what a **human** can
do; not a general OAuth provider for third parties) and adds:

- **No agent-driven live account creation** (J2 is guide-only).
- **No weakening** of invite / email-verification / Passkey / live-registration gates.
- **No money/order/status/wallet/escrow/commission/fund implementation** in the auth work; risk-scope
  enforcement that touches those paths is a dedicated, Codex-gated PR under the money-path rules.
- **No competing credential model** — permanent `api_key` stays only for direct human / server / CI use
  (RFC-020 §5), demoted for the agent path.

## 5. Decisions (resolved — recorded here, RFC-020 §8 amended to point here)

1. **Grant storage:** a **new `agent_delegation_grants` table**, cross-linked to `agent_attestations` where
   useful. **Do not overload `agent_attestations`** as the grant table — grants need `agent_pubkey` (PoP),
   `pairing_code` / PKCE, `capabilities + constraints` JSON, and `expires_at` that attestations lack.
2. **Bearer-first scope limit:** Phase-1 MAY ship a **short-TTL bearer for short-lived *safe* scopes only**.
   **PoP/keypair binding is required before any risk scope or any longer-lived delegation.** PoP columns are
   **reserved in the schema from day one** (RFC-020 §3.3 / §7).
3. **PR-E (stranger invite-request):** useful pre-launch but **comes last** — after member+agent delegation
   (J1) is designed and built.
4. **`human_confirm_required`:** **reuses the existing `webauthn_gate_tokens` / human-presence gate**
   (`requireHumanPresence`) inline — no separate grant-scoped confirmation mechanism.

(Remaining RFC-020 §8 items — PoP scheme specifics, secret-store fallback contract — stay open for the
implementation PRs.)

## 6. PR slicing (each = one change type; money/state untouched except via dedicated gated PRs)

- **PR A — docs/spec/copy only *(this track)*.** This companion note + an RFC-020 §8 amendment marking the
  resolved decisions. A follow-up docs change (separate small PR) flips onboarding copy to recommend *pairing*
  over `WEBAZ_API_KEY` and demotes the permanent key to "advanced / not for agents" with a blast-radius
  warning. **No code.**
- **PR B — grant schema + PWA issue/revoke endpoints.** New `agent_delegation_grants` table (PoP-ready
  columns) added to the schema helpers — **if #69 has landed, in `src/runtime/webaz-schema-helpers.ts` +
  `applyWebazRuntimeSchema` wiring; otherwise in `src/pwa/server-schema.ts`** (and wire MCP boot to create it
  too); plus `routes/agent-grants.ts` (pair-request, server-generated consent, Passkey-approve → issue, list,
  revoke). Reuses `requireHumanPresence` / `webauthn_*`. Schema PR (own type): ratchet + `schema:verify` +
  fresh-DB. **No
  money path.**
- **PR C — MCP delegation-grant auth + scope enforcement.** `webaz_pair` tool (device-flow + PKCE),
  secret-store + handle delivery (RFC-020 §3.4), per-request capability/constraint/expiry/revocation check,
  never-delegable hard-reject. Demote `WEBAZ_API_KEY` default.
- **PR D — Connected-agents UI + audit + smoke tests.** Dashboard (one-click revoke, online per-request
  revocation), grant audit surfaced, browser smoke.
- **PR E — optional stranger invite-request (J2).** A human with no referral code lodges an invite request
  routed to the existing maintainer/quota grant path; **invite gate unchanged**, agent only guides. **Last.**

**Sequencing:** A → B → (C, D after B) → E. PR-B and any risk-scope enforcement touching money/state are
Codex-gated dedicated reviews per the money-path tx-atomicity + "don't fake success" rules.

## 7. Invariants (carried from RFC-020 §9 — must hold in every implementation PR)

1. No grant can satisfy a never-delegable action — **server-enforced**, not UI.
2. Constraints (amount / cap / expiry / products) enforced **server-side against the ledger**, never trusted
   from the agent.
3. Consent text is **server-generated** from canonical labels; the agent supplies only a free-text `reason`.
4. The grant secret never appears in an MCP response / chat / logs (redacted; handle-only to the agent).
5. Every grant-authorized request is audited (`human_id, agent_id, grant_id, capability, constraints,
   outcome, iron_rule_rejected`).
6. Grants are always **revocable + expiring**; revocation is checked **online** per request.
7. **NETWORK self-registration stays blocked** (`handleRegister` / `isNetworkMode()`); invite + email +
   Passkey gates are **not weakened**; **no agent path creates a live account.**

## 8. Files referenced (for the implementation PRs — none edited in this docs PR)

- MCP auth/tool gate + onboarding copy: `src/layer1-agent/L1-1-mcp-server/server.ts` (mode routing,
  `handleRegister`, tool `api_key` descriptions, future `webaz_pair`).
- PWA auth/session: `src/pwa/server.ts` (`getUser`/`auth`/`recordSession`); `src/pwa/admin-bearer-auth.ts`.
- PWA security/settings routes: `src/pwa/routes/webauthn.ts`; future `src/pwa/routes/agent-grants.ts`.
- Human-presence gate: `src/pwa/human-presence.ts` + `require_human_presence_for_*` params in `server.ts`.
- Registration / invite gate: `src/pwa/routes/auth-register.ts` (J2 invite-request lives near here; **gate
  not weakened**).
- Schema: `src/pwa/server-schema.ts` on `main` (relocated to `src/runtime/webaz-schema-helpers.ts` +
  `applyWebazRuntimeSchema` if #69 lands first) — new `agent_delegation_grants`; cross-link
  `agent_attestations`; revocation via the `user_sessions` pattern; honor ALTER-after-CREATE + ratchet + (if
  on the runtime helper) `applyWebazRuntimeSchema` wiring so MCP gets the table too.
- Audit: `admin_audit_log` / `agent_call_log` (add grant audit fields per RFC-020 §3.7).
- Docs/onboarding copy: `README.md`, `README.zh-CN.md`, `docs/rfcs/RFC-003-*.md`, `RFC-004-*.md`,
  `RFC-020-agent-delegation-grants.md`.
