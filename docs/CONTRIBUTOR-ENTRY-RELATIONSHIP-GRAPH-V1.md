# Contributor Entry & Relationship Graph v1 — boundary contract (design-only)

> **Status: design-only.** This document locks the **boundary** of how strangers enter the WebAZ
> contribution system and how relationship metadata (invitation / referral / registration order /
> binary-tree position) is recorded — **before** any reward, percentage, multiplier, payout, or settlement
> exists. It defines **no reward formula, no percentage, no amount, no multiplier, no payout, no
> binary-tree settlement, and no final legal/economic right.** It is **uncommitted** in full (RFC-017
> I-12). Authority: **RFC-017 I-1/I-5/I-6/I-7/I-9/I-12**, **`CONTRIBUTOR-REWARD-FRAMEWORK.md` §3.1/§3.2**
> (the single source of truth for the valuation principle), CHARTER §3.2/§4/§6, and the PR5A
> uncommitted-value boundary (`contribution-display-envelope.ts`).

This is the boundary half of the framework's PR6 (relationship layer) + PR7 (contributor entry). It adds
**no DB table, no API/MCP/PWA route, no schema change, no write path** — only this design.

## §1 Entry & post-hoc claim (already-built path)

1. **A stranger GitHub contributor enters by contributing.** A merged PR is recorded as an immutable
   contribution fact against the **GitHub identity** — *before* any WebAZ account or Passkey exists
   (RFC-017 I-6). The fact, its authenticated GitHub credential, and its attribution are preserved; what
   the unclaimed GitHub identity lacks until claimed is in-protocol permissions and any (currently
   uncommitted) future right — never its attribution.
2. **Post-hoc claim binds a real-human WebAZ account via Passkey.** The contributor later proves control of
   the GitHub identity and binds it to a Passkey-backed WebAZ account (the **4b identity-claim chain**,
   shipped: publication-challenge proof + WebAuthn human gate + atomic consume-and-bind). Claim binds
   **attribution and accountability**; it does **not** by itself create any redemption right (RFC-017 I-12).
   The account's own attributable evidence is then visible read-only (PR-F4 `/github/me`, PR5F
   `/contribution-score/evidence/me`) — always under the uncommitted-value boundary.

The **relationship graph** below is the layer that is *not yet built*; this PR locks its boundary first
(the PR5 lesson: lock naming + boundary before function).

## §2 What the relationship graph is

A **relationship graph** is **attribution / context metadata**: who invited or referred whom, registration
order, early-participation facts, and binary-tree position. Per RFC-017 I-9 these are **permanently
recorded** facts and **MAY** become future valuation *parameters* — but they are recorded **context**, not
economic rights, and recording one promises nothing.

## §3 Invariants (locked)

1. **GitHub contribution identity and WebAZ usage identity are separable**, and the GitHub identity can be
   claimed **post-hoc** via Passkey (RFC-017 I-1/I-5/I-6).
2. **Only a real-human WebAZ account can ultimately claim accountability.** An agent may *execute*
   contributions, but an agent cannot itself claim any future right (RFC-017 I-7; agent
   identity-accountability).
3. **The relationship graph is attribution / context — not an economic right.**
4. **Position / order / referral may be recorded, but recording promises no income.**
5. **Earlier entry / referral / propagation facts may be retained as future governance input**, but with
   **no hard-coded formula** (RFC-017 I-9: recorded + may-be-modifier; weight deferred to the DAO,
   phase-A default = unused).
6. **No inheritance-of-income promise.** "Whoever refers someone automatically earns from that person" is
   forbidden — income is never granted by relationship position alone (framework §3.1).
7. **Every public or self-view display carries the uncommitted-value boundary** (PR5A `value_boundary`:
   `value_state: uncommitted`, valuation/redemption `not_defined`, `economic_rights: false`).
8. **The GitHub-public ↔ WebAZ-account/private privacy boundary is explicit** (see §6).
9. **Abuse vectors are named as must-defend-before-implementation risks** (see §7).
10. **Anything touching reward / economics / legal / KYC requires a separate RFC/PR under higher audit** —
    it is **not** decided here (see §10).
11. **The account-based registration tree and the contribution relationship graph are separate layers.**
    Only a registered WebAZ account can be a `sponsor_id` / `inviter` or occupy a binary-tree placement; a
    pending/unclaimed relationship never auto-rewrites `users.placement_id` / `users.sponsor_id` (see §8).
12. **A pre-registration invitation attribution is evidence-backed *unclaimed context*.** Its subjects are
    identity refs (`github:<stable_actor_id>`, later `webaz:<account_id>`); it resolves to a WebAZ account
    only via the identity-binding overlay *after* claim; until then it produces no sponsor payout, binary
    settlement, wallet right, KYC, or reward eligibility (see §8).
13. **Registration-time placement is final (no post-hoc tree rewrite).** Formal sponsor / binary-tree
    placement is fixed at WebAZ account registration (anchored on `users.id` + the inviter's
    `permanent_code` / invite code + Passkey/accountability); no pending / GitHub-first relationship may
    retroactively rewrite, reparent, conflict with, or shadow it with a second accounting tree (see §9).

## §4 Why it is not reward / income / right / KYC / redemption (now)

Per RFC-017's three-layer separation (*fact · valuation · redemption*) and I-12, the whole protocol is
currently **uncommitted**: no promise of amount, currency, yield, percentage, or that redemption ever
occurs. Recording a referral or a position is a **fact**, not a **valuation**, and never a **redemption**.
A relationship position confers no security, equity, debt, dividend, ranking entitlement, or wallet
balance, and triggers no KYC.

## §5 If governance ever enables reward (future, gated)

Per framework §3.1/§3.2: **position cannot be an independent income source** ("hold a position → get
income" is rejected); it can at most be **one auditable modifier parameter among many**, applied
multiplicatively on a **contribution base** (a real contributor can, by real contribution, match or
surpass an earlier participant). Any such mechanism — and its weights, curves, and regulatory
classification — must be defined by a **separate RFC/PR**, ratified through CHARTER §6 (public notice +
multi-sig), and assessed under applicable law. This document defines **none** of it.

## §6 Privacy boundary

- **GitHub public identity** is an external pseudonymous handle; its merged-PR facts are public by nature.
- **WebAZ account / private identity** (the Passkey-bound real party, and the binding between the two) is
  **private by default** — a binding's visibility defaults `private`, and self-view surfaces never expose
  another account's id, token, nonce, email, or gist content.
- Protocol *mechanism* is public; *operational state* (relationship counts, graph shape, growth) stays
  private until the community is large enough that disclosure can't enable premature forking or
  deanonymization. A public relationship-graph view, if ever built, is a separate, privacy-reviewed PR.

## §7 Abuse vectors a future implementation MUST defend

Listed now so the boundary is set before code; each must be addressed by the implementing PR:

- **Self-referral** — referring oneself (directly or via a sock-account) to manufacture context.
- **Cyclic / reciprocal relationships** — A→B→A loops to inflate either side.
- **Multi-account position farming** — one human spinning up many accounts to occupy positions.
- **Position buying/selling** — treating a recorded position as a transferable asset.
- **Impersonation claims** — claiming a GitHub identity one does not control (mitigated today by the 4b
  publication-challenge + Passkey gate; must stay enforced).

Recording context must never be mistaken for validating it: an unverified or abusive relationship fact is
**context to be audited**, never an automatic entitlement.

## §8 Pending / unclaimed invitation attribution (GitHub-first)

The account-based sponsor / placement tree today accepts only a **registered WebAZ account** as the
inviter: a contributor who has only a GitHub identity and no WebAZ account yet **cannot** occupy a
binary-tree placement or be a `users.sponsor_id`. To support agent / GitHub-first contribution
propagation, the relationship graph MAY record an invitation attribution **before** the inviter has an
account — as **unclaimed context**, strictly separate from the registration tree:

- **Subjects are identity-layer refs, not logins.** `inviter_subject` may be `github:<stable_actor_id>`
  (the stable actor id, **never** the renameable GitHub login); `invitee_subject` may be
  `github:<actor_id>` first and `webaz:<account_id>` later.
- **Evidence-backed only.** A pending invitation relationship MUST carry verifiable evidence — a signed
  invite token, a GitHub-owned publication (PR / comment / gist proof), or both parties' later confirmation
  — never a bare caller-asserted claim (recording context ≠ validating it — §7).
- **Resolved by the identity-binding overlay after claim.** Once the inviter completes GitHub identity
  claim (the 4b chain), the pending relationship resolves to their WebAZ account via the binding overlay at
  **read time** — the same read-overlay model as `accountable_ref`; the underlying relationship fact is not
  rewritten.
- **Unclaimed = no economic effect.** Before claim it is unclaimed context only: it produces **no** sponsor
  payout, **no** binary settlement, **no** wallet right, **no** KYC, **no** reward eligibility.
- **Trees stay separate.** A pending relationship MUST NOT auto-rewrite an existing `users.placement_id` /
  `users.sponsor_id`. The **account-based registration tree** and the **contribution relationship graph**
  are separate layers and are never silently merged.
- **Any placement / reward effect is a separate high-audit PR.** If a future design ever lets a pending
  relationship influence binary placement or act as a reward modifier, that requires a separate, higher-
  audit RFC/PR under CHARTER §6 — not decided here.

## §9 No post-hoc tree rewrite (registration-time placement is final)

Formal sponsor / binary-tree placement is determined **only at WebAZ account registration**, anchored on
`users.id` + the inviter's `permanent_code` / invite code + the Passkey/accountability binding. A
contributor with only a GitHub identity and **no** WebAZ account cannot occupy a binary-tree position or be
a formal sponsor.

GitHub-first referral / propagation MAY be retained as **contribution / propagation evidence** — but it is
**uncommitted context** and MUST NOT:

- retroactively modify a registered user's `sponsor_id` / `placement_id` / `placement_side`;
- reparent a later-registered account under an earlier GitHub contributor's downline;
- conflict with the binary-tree position formed at real registration time;
- create a second reward / settlement accounting tree.

**Guidance to contributors:** if you want a referral relationship to enter the *formal* WebAZ relationship
tree, **register a WebAZ account early**, obtain your own `permanent_code` / invite link, and invite
newcomers with that code. Pre-registration GitHub referral evidence is recorded as **contribution
evidence**, but it is **not** a formal binary-tree position and promises no future income.

## §10 What this PR does NOT do

No DB table / schema / write path; no API / MCP / PWA route; no UI; no reward formula / percentage /
multiplier / payout / binary-tree settlement; no final legal or economic right; no wallet / escrow /
commission / KYC / production / deploy. **Governance-timing note:** these invariants touch reward semantics
→ they are draft/proposed and take formal effect only after the repository is public via CHARTER §6 (60-day
notice + multi-sig); because this PR defines **no** distribution mechanism, it does **not** itself trigger
the economic-parameter governance gates (those fire when a future PR defines valuation/redemption).
