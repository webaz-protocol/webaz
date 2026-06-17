# RFC-019: GitHub OAuth Identity Linking

> **Status:** Draft · **Type:** Identity / Auth · **Authority for task T16** ([`OPEN-SOURCE-FIRST-TASKS.md`](../OPEN-SOURCE-FIRST-TASKS.md))
> **Augments:** RFC-017 (contribution protocol) claim flow · **Supersedes:** nothing
> **Non-goals:** governance scoring · rewards · tokenomics · ranking — none of these appear in this design.

## 1. Problem & goal

Today a contributor proves GitHub ownership by publishing a **Gist marker**
(`webaz-identity-claim:v1:<challengeId>:<nonce>`), which WebAZ re-fetches and verifies, then commits the
binding behind a **Passkey** ceremony (`requireHumanPresence('identity_claim')`). It is secure but
high-friction (create gist → copy marker → paste → Passkey).

**Goal:** add a one-redirect **"Connect GitHub" OAuth** path that proves GitHub ownership **without weakening**
either existing guarantee — *human presence (Passkey)* and *GitHub account ownership* — and keep the Gist flow
as a **fallback**.

## 2. Security model (threat-model-first)

The binding requires **two independent proofs**. OAuth only changes *how ownership is proven*; the
human-presence iron rule and the append-only binding are unchanged.

| Guarantee | Today (Gist) | With OAuth | Invariant (unchanged) |
|---|---|---|---|
| **GitHub ownership** | publish marker in a gist owned by `actor_id`; WebAZ re-fetches `GET /gists/<id>` and asserts `owner.id == actor_id` | GitHub OAuth code exchange → `GET /user` with the user's token → authoritative numeric `id` | ownership is **server-verified against `api.github.com`**, never client-asserted |
| **Human presence** | `requireHumanPresence('identity_claim', webauthn_token)` gates the bind commit | **identical** — OAuth success alone never binds; Passkey still gates the commit | iron rule unchanged; an agent cannot self-bind |
| **Anchor** | stable numeric `github_actor_id` (not login) ↔ `users.id` | same | double-bind blocked by `identity_bindings_active` PK |

**Threats & mitigations**

- **CSRF on callback** — `state` nonce bound to the WebAZ session, single-use, short TTL (`oauth_link_states`).
- **Auth-code interception / replay** — **Authorization Code + PKCE** (`code_verifier`/`code_challenge`); code single-use, short-lived.
- **Token leakage** — request **minimal scope** (`read:user` only, enough for the numeric id; **no `repo`/write scope**); access token is used **once** for `GET /user`, then **discarded** — never persisted, never logged (same discipline as the existing `github-fetch-adapter`: fixed origin `api.github.com`, no token leak).
- **Confused deputy / account takeover** — OAuth proves *current control* of the GitHub account (same trust level as controlling the gist account). Rebind = **revoke event + fresh proof + Passkey** (append-only `identity_binding_events`); the PK on `identity_bindings_active(github_actor_id)` blocks silent double-bind.
- **Human-presence bypass via OAuth automation** — impossible: the bind commit is Passkey-gated; an agent completing OAuth still cannot bind without the human's WebAuthn ceremony.
- **Fail-closed config** — if `GITHUB_OAUTH_CLIENT_ID/SECRET` are unset, the OAuth route returns **503 before** consuming any state/token (mirrors the existing `GITHUB_CONTRIB_READ_TOKEN` config-first pattern).

## 3. Architecture

OAuth is a **new ownership-proof adapter** feeding the **same** Passkey-gated, append-only bind
(`bindGithubIdentityCore`). OAuth and Gist are two `proof_method`s into one commit.

```
"Connect GitHub" ─▶ GET  /api/contribution-identity/github/oauth/start
                     └─ mint oauth_link_state{state, code_verifier, account_id(session), exp} → 302 GitHub authorize (scope=read:user, PKCE)
GitHub consent ───▶ GET  /api/contribution-identity/github/oauth/callback?code&state
                     ├─ validate state (session-bound, unconsumed, unexpired) → consume (CAS)
                     ├─ exchange code (+ code_verifier) → access_token      [github-oauth-adapter, fixed origin]
                     ├─ GET /user → authoritative github_actor_id (+login)  [token used once, then discarded]
                     └─ stash single-use, short-TTL verified link-intent {account_id, github_actor_id, proof_method:'github_oauth'}
PWA Passkey ──────▶ POST /api/contribution-identity/github/oauth/link-complete { webauthn_token }
                     ├─ requireHumanPresence('identity_claim', token, purpose_data bound to {account_id, github_actor_id})   ◀ IRON RULE
                     └─ bindGithubIdentityCore(db, {accountId(session), githubActorId, proofVerified:true, proof_method:'github_oauth'})
                         → append 'bound' event + upsert identity_bindings_active   (same engine as the gist path)
Future facts ─────▶ executor_ref github:<actor_id> auto-resolves to the human via the existing accountable read-overlay (resolveAccountable) — no per-fact claim.
```

The binding engine and append-only event model are **unchanged**. Auto-attribution already follows from an
existing binding; OAuth simply makes creating that one binding frictionless.

## 4. Schema changes (additive, minimal)

```sql
-- ephemeral OAuth handshake state (single-use, short TTL); NOT a binding record
CREATE TABLE oauth_link_states (
  state         TEXT PRIMARY KEY,             -- random; CSRF anchor
  account_id    TEXT NOT NULL REFERENCES users(id),
  code_verifier TEXT NOT NULL,                -- PKCE
  status        TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','consumed')),
  consumed_at   TEXT,
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- **No change** to `identity_bindings_active` structure. `identity_binding_events` allows a new
  `proof_method = 'github_oauth'` (it already records the proof method).
- The verified link-intent (account_id ↔ actor_id) carried from callback → `link-complete` is **single-use +
  short-TTL** so the Passkey step cannot be skipped or re-pointed to a different actor.
- **No data migration**: existing bindings are proof-method-agnostic and remain valid.

## 5. UI / UX

`#my-contributions` → **"Connect GitHub"** → GitHub consent → return to WebAZ → **Passkey prompt** ("confirm
it's you") → **"GitHub linked ✓ — contributions now auto-attribute."** The Gist flow stays behind a
**"Link manually (advanced)"** link. Bilingual (`t()` + `_EN`).

## 6. Migration & backward compatibility

- **Gist remains fully supported** as a fallback (no removal). `claim-complete` (gist) and
  `oauth/link-complete` produce identical bindings.
- **Existing bindings unaffected** — no re-link required; they carry `proof_method='github_publication_challenge'`.
- Rollout is **purely additive**: ship OAuth dark (config absent → 503), enable by setting the OAuth app creds.

## 7. Agent-first

- Contributions originate from agents (`executor_ref = github:<actor_id>`); **attribution always resolves to a
  human** via the binding + accountable overlay.
- **Agent-assisted onboarding:** an agent can guide the human to "Connect GitHub" and explain it, but the human
  performs the OAuth consent + Passkey — the desired human-in-the-loop. For headless contexts the **Gist
  fallback** lets an agent post the marker while the human still completes Passkey.

## 8. Implementation plan — small PR-sized milestones

| PR | Scope | Risk |
|---|---|---|
| **M1** | this RFC + threat model (doc only) | low |
| **M2** | `oauth_link_states` schema + store (single-use / TTL, DB CHECK backstop) + tests; no routes | low |
| **M3** | `github-oauth-adapter` (authorize-URL + PKCE + code exchange + `GET /user` id), fixed origin, token-never-persisted, strict args, fake-fetch tests | medium |
| **M4** | bind path: extend the claim engine to accept `proof_method='github_oauth'` (reuse `bindGithubIdentityCore`); typed outcomes; engine tests | **high** (trust-critical; maintainer-led) |
| **M5** | routes `oauth/start` + `oauth/callback` + `oauth/link-complete` (Passkey-gated, CSRF/state, config-first 503); real-express tests | **high** (trust-critical; maintainer-led) |
| **M6** | PWA "Connect GitHub" + Passkey confirm + linked state + i18n | low |
| **M7** | docs + fallback wording + config/runbook (`GITHUB_OAUTH_*`) | low |

Each PR is independently green-able; **M4/M5 touch the auth/identity trust root and the iron-rule path — they
are maintainer-led / high-audit and must not weaken `requireHumanPresence`.** M2/M3/M6/M7 are additive and
contributor-friendly.

## 9. Open questions (for maintainer decision)

- OAuth **App** vs **GitHub App** (App is simpler for `read:user`; GitHub App offers finer control but more setup).
- Whether to persist a minimal "linked via OAuth at `<ts>`" provenance on the binding event (audit) vs nothing.
- Rate-limiting / abuse controls on `oauth/start` (re-use the existing IP rate-limit helper).
