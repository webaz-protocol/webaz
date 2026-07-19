# RFC-027 — Recommendation Anchors / 推荐商品口令

**Status**: draft — RA0 research only; no production behavior is changed by this RFC.
**Author**: WebAZ maintainers
**Created**: 2026-07-19
**Track**: exploratory
**Related**: product discovery, share links, RFC-025 and RFC-026
**Supersedes**: (n/a)
**Superseded by**: (n/a)

---

## 1. Summary / 摘要

WebAZ needs a short, stable recommendation identifier that a person can copy,
say, put in a QR code, or give to an agent without relying on a mutable
`@handle`.  The proposed public text form is:

```text
@tina:ha95k
```

It means one immutable recommendation record: a permanent WebAZ recommendation
namespace (`tina`) plus a local code (`ha95k`).  It can identify the
recommender, product, optional variant, and a future explicit order-source
record.  It must never be re-bound to another person or product.

This RFC deliberately does **not** create a commission, cookie, click-based
attribution, payment, settlement, or ranking rule.  A recommendation is only
linked to an order when the buyer or buyer's authorized agent explicitly carries
that anchor through a quote, draft, approval, and order.  Existing share
commission logic remains untouched.

The recommended delivery is RA0–RA5.  RA0 is this document; no implementation
PR may claim that a host has natural-language support until the empirical host
matrix in section 8 passes.

## 2. Evidence status / 证据状态

This distinction is intentional:

| Label | Meaning in this RFC |
|---|---|
| **Verified code fact** | Read directly from the current WebAZ source tree. |
| **Verified protocol fact** | Reproduced against a standards document or WebAZ's live MCP endpoint. |
| **Design decision** | The recommended future behavior; it is not implemented yet. |
| **Unknown / experiment** | Must be tested before a compatibility or UX claim is made. |

## 3. RA0 audit / 当前能力审计

### 3.1 Current handles cannot be the recommendation namespace

**Verified code fact.** `POST /api/profile/change-handle` normalizes and
updates `users.handle`, keeps a cooldown log, and only checks whether the
*current* handle is already held.  It does not reserve historic values
([`profile-identity.ts`](../../src/pwa/routes/profile-identity.ts#L141)).  A
later account can therefore claim a prior handle.  A permanent recommendation
identity cannot resolve through current `@handle` or through the historical
JSON log.

This is also a known general handle lifecycle hazard: YouTube's official
documentation says a previous handle is held briefly and can subsequently be
available to another account.  Its own guidance also notes that non-ASCII
handles are not uniformly portable across applications.  [YouTube handle
guidance](https://support.google.com/youtube/answer/11585688?hl=en), [handle
change lifecycle](https://support.google.com/youtube/answer/15920820?hl=en-ZW).

### 3.2 Existing `anchor_registry` is related but is not a valid authority

**Verified code fact.** WebAZ already has an `anchor_registry`, but its anchor
is formed from the owner's current handle plus a four-character middle segment
([`anchor-registry.ts`](../../src/layer2-business/L2-anchor-registry/anchor-registry.ts#L67)).
It also permits `retired -> reclaimable` and then reassigns the record to a new
owner ([`anchor-registry.ts`](../../src/layer2-business/L2-anchor-registry/anchor-registry.ts#L242)).
Its lookup increments a hit counter and its public endpoint returns owner and
product enrichment ([`anchors.ts`](../../src/pwa/routes/anchors.ts#L58)).

That is appropriate for its historical traffic-anchor use, but it violates all
of the following Recommendation Anchor requirements:

- independent permanent namespace;
- never transfer or reuse a public recommendation string;
- immutable recommender/product/variant binding;
- minimal public projection;
- no implicit first-touch attribution.

**Decision:** RA must use new tables and a new domain resolver.  It may reuse
the generic QR encoder and rate-limit patterns, but not the registry's identity,
reclaim, lookup, or attribution semantics.

### 3.3 Existing share attribution has incompatible economics

**Verified code fact.** `/s/:id` and `/api/product-share/touch` create or
refresh `product_share_attribution`; the latter is explicitly a 30-day
first-touch rule ([`share-redirects.ts`](../../src/pwa/routes/share-redirects.ts#L128)).
The old anchor touch route writes the same table
([`anchors.ts`](../../src/pwa/routes/anchors.ts#L114)).  Order creation then
reads that chain to snapshot L1/L2/L3 commission recipients
([`orders-create.ts`](../../src/pwa/routes/orders-create.ts#L310)).

**Decision:** RA0–RA4 must not write `product_share_attribution`,
`l1_uid/l2_uid/l3_uid`, `commission_records`, wallets, escrow, or settlement.
Recommendation source is a separate, explicit provenance record.  Any future
commercial program requires its own RFC and economic review.

### 3.4 Quote, draft, approval, and order already provide a safe propagation seam

**Verified code fact.** `order_quotes` holds a server-authoritative,
short-lived quote snapshot; `order_drafts` consumes it atomically and copies its
fields ([`webaz-schema-helpers.ts`](../../src/runtime/webaz-schema-helpers.ts#L1838)).
The approval executor rechecks the snapshot and only then invokes the canonical
order creation route ([`order-submit-exec.ts`](../../src/pwa/order-submit-exec.ts#L112)).

There is no recommendation-anchor field today.  The existing quote idempotency
hash is an economic input hash ([`buyer-quote.ts`](../../src/pwa/buyer-quote.ts#L295)).
Therefore a future source context must be stored and compared separately: it
must be bound to buyer consent without changing amount, rail, stock, or the
economic duplicate-purchase invariant.

### 3.5 Variants and QR already have reusable primitives

**Verified code fact.** A product variant is a stable row with `id`,
`product_id`, `options_json`, price override, stock, and active flag
([`webaz-schema-helpers.ts`](../../src/runtime/webaz-schema-helpers.ts#L1140)).
The existing `/api/qr` endpoint encodes arbitrary text as QR SVG with an ETag
([`share-redirects.ts`](../../src/pwa/routes/share-redirects.ts#L51)).

**Decision:** a recommendation record may have a nullable `variant_id`; when it
is non-null, resolution must never silently fall back to the parent product.
RA3 can reuse the QR encoder with a canonical RA URL, without creating a second
attribution source.

### 3.6 Search is the correct first agent surface, but it needs a hard branch

**Verified code fact.** `webaz_search` accepts a free-form `query` and currently
forwards network-mode queries to `/api/products` before ordinary strict search
([`server.ts`](../../src/layer1-agent/L1-1-mcp-server/server.ts#L2642)).  Its
normal zero-match recovery can attach a labeled catalog sample
([`server.ts`](../../src/layer1-agent/L1-1-mcp-server/server.ts#L2700)).  It
does not parse `@namespace:code` today.

**Verified protocol fact.** A RA0 read-only live MCP probe sent
`"@tina:ha95"` as the `query` argument.  The string reached WebAZ's normal
strict-search path unchanged; it did not resolve as an anchor.  The response
then used ordinary zero-match recovery.  This proves transport preservation,
not host natural-language selection.

**Required RA2 rule:** an input that is syntactically a recommendation-anchor
candidate must bypass ordinary product search, aliases, discovery hints, and
catalog samples.  Invalid, unknown, unavailable, or withdrawn candidates return
only a clear RA-specific non-match.  There is no fuzzy match, title match,
substring match, or similar-product recovery on that branch.

## 4. Standards and external research / 外部调研

### 4.1 MCP and structured tools

**Verified protocol fact.** MCP `tools/call` uses a named tool plus an object of
arbitrary JSON arguments, and tool inputs/outputs are JSON Schema-defined.
Thus `"@tina:ha95k"` is a normal string argument, not a protocol extension.
[MCP schema reference](https://modelcontextprotocol.io/specification/2025-06-18/schema).

OpenAI's Apps SDK states that MCP tool metadata and structured content are used
for discovery/conversation state, and that MCP is self-describing across
ChatGPT web and mobile.  That supports using the existing `webaz_search` tool
and a structured result; it does **not** guarantee that any model will infer an
anchor from arbitrary prose.  [OpenAI Apps SDK: MCP](https://developers.openai.com/apps-sdk/concepts/mcp-server#why-apps-sdk-standardises-on-mcp).

### 4.2 URL and QR form

RFC 3986 allows both `@` and `:` in a URI path segment, but a colon in the
first segment of a *relative* reference has special parsing consequences.
[RFC 3986 section 3.3](https://www.rfc-editor.org/rfc/rfc3986.html#section-3.3).

**Decision:** the human text form and browser URL form are deliberately
different representations of the same record:

```text
Human / agent text:  @tina:ha95k
Canonical URL / QR:  https://webaz.xyz/r/tina/ha95k
```

The path form is easier to route, avoids mention parsing in social clients, and
does not depend on percent-encoding behavior.  It resolves the same
`recommendation_anchor_id`; it is not another attribution system.

### 4.3 Format comparison

| Candidate | Result | Why |
|---|---|---|
| `@tina:ha95k` | **Chosen text form** | Explicit public namespace and local code; easy to copy and inspect. |
| `@tinaha95k` | Reject | Namespace/code boundary is ambiguous. |
| `@tina-ha95k` | Reject | Mixes namespace grammar with local-code grammar and encourages visual ambiguity. |
| `@tina/ha95k` | Reject for text | Useful URL shape, poor in prose and easily treated as a path. |
| `tina:ha95k` | Reject | Not visibly a WebAZ anchor; colon resembles a scheme/value delimiter. |
| `waz:@tina:ha95k` / `webaz:@tina:ha95k` | Copy-only fallback, not canonical | More explicit but unnecessarily long and more likely to be transformed by hosts. |

### 4.4 Host compatibility is partly unknown by design

| Surface | What RA0 verifies | What remains an experiment |
|---|---|---|
| MCP transport | JSON preserves the anchor string as a tool argument. | Nothing protocol-specific. |
| ChatGPT web/mobile | MCP structured tools can carry the string. | Whether natural-language text reliably selects `webaz_search` with the exact anchor. |
| Claude clients | Standard remote MCP can carry a string argument. | Prompt/tool-selection and any UI mention handling. |
| OpenClaw and other clients | Standard MCP arguments are sufficient. | Their prompt parser and connector UI behavior. |
| Browser/QR | `/r/<namespace>/<code>` is standards-safe by design. | iOS/Android scanning, deep-link and PWA route rendering. |

No host-specific protocol branch is permitted.  If a host does not recognize
the text in prose, its integration should send the exact string to
`webaz_search`, display a copy action, or open the canonical URL.  WebAZ must
not change its public protocol semantics for one host.

## 5. Proposed canonical design / 建议设计

### 5.1 Grammar and normalization

The stored canonical string is lowercase ASCII and matches:

```text
^@([a-z][a-z0-9_]{2,31}):([23456789abcdefghjkmnpqrstuvwxyz]{5})$
```

- `namespace`: 3–32 ASCII characters, globally unique, separately claimed for
  an account, immutable after issue, never transferred or reused.
- `local_code`: 5 characters from a 31-symbol alphabet that excludes `0`, `1`,
  `i`, `l`, and `o` to reduce oral and visual confusion.
- The code is generated with cryptographic randomness and a database unique
  constraint on `(namespace_id, local_code)`; V1 has no seller-chosen code.
- Five characters yield 28,629,151 slots per namespace.  A collision is safely
  retried under the unique constraint; unlike a four-character code, it is not
  trivial to exhaustively enumerate at normal client limits.

Only leading/trailing whitespace is trimmed and ASCII letters are lowercased.
Full-width punctuation, zero-width characters, controls, non-ASCII lookalikes,
embedded whitespace, extra suffixes, and partial strings are rejected.  An NFKC
comparison may be used to explain that a pasted string is non-canonical, but it
must **not** silently resolve a lookalike.  The returned value always gives the
canonical form the user should copy.

A bounded candidate detector runs before the canonical parser.  It treats an
entire trimmed string that either has the ASCII `@…:…` shape or becomes that
shape under NFKC as an attempted anchor.  Such a candidate always returns an RA
error when canonical parsing fails; it cannot fall through to title search or a
catalog sample.  NFKC is only a detector/error aid, never a lookup transform.

This conservative rule is intentional: international display names are welcome,
but a permanent, cross-host machine locator should not depend on Unicode
confusable behavior.

`namespace` is deliberately **not** a current `@handle` namespace.  A future
claim flow may offer an eligible current handle as a convenience, but it copies
that string only after an explicit claim; a later handle change never changes
resolution of an already issued recommendation namespace.

### 5.2 Authority and lifecycle

The proposed future records are:

```text
recommendation_namespaces
  id, owner_user_id, namespace, status, issued_at, disabled_at, retired_at
  UNIQUE(namespace), UNIQUE(owner_user_id)  -- one V1 namespace per identity

recommendation_anchors
  id, namespace_id, local_code, recommender_user_id,
  product_id, variant_id NULL, seller_id_at_issue,
  campaign_ref NULL, target_snapshot_hash,
  status, issued_at, withdrawn_at
  UNIQUE(namespace_id, local_code)

recommendation_anchor_events
  id, recommendation_anchor_id, actor_id NULL, event_type, reason_code,
  created_at
  append-only; no public free-text reason

order_recommendation_sources
  id, order_id UNIQUE, recommendation_anchor_id,
  quote_id NULL, draft_id NULL, approval_request_id NULL, created_at
  UNIQUE(order_id); partial UNIQUE indexes for each non-NULL upstream id
  immutable provenance; absent when the buyer chose no recommendation source
```

`recommender_user_id`, product, variant, and seller snapshot are write-once.
An anchor cannot be retargeted.  Recommending a different product, different
variant, or a materially replaced listing requires a new anchor.

`recommender_user_id` must equal `recommendation_namespaces.owner_user_id` for
its `namespace_id`; RA1 enforces this in the domain writer and with a database
guard.  Keeping the immutable recommender snapshot is useful for audit, but it
must never permit a second user to issue under somebody else's namespace.

RA1 provides one authoritative `claimRecommendationNamespace()` domain writer.
It accepts a real human account only, denies system/agent identities, verifies
the syntax and one-namespace limit, and rejects a server-controlled reserved
set (at least `webaz`, `admin`, `system`, and protocol route names).  Protected
or brand-sensitive names are never granted through the generic claim path;
they remain unclaimable until a future verified/admin claim policy is approved.
This makes the V1 first-claim surface conservative without coupling it to a
mutable handle or inventing a brand-verification program in this RFC.

Anchor issuance is human-account authenticated: the caller must own the active
namespace, must not be a system or agent identity, and may target only a
currently active product and an active variant belonging to that product.
Creation is quota- and rate-limited, records a non-PII target snapshot hash,
and emits an append-only event.  Owner withdrawal and administrative
moderation disable the record rather than deleting, transferring, or recycling
it.  `campaign_ref` remains null in V1 unless it is a validated opaque foreign
key to a separately approved campaign record; caller-supplied free text is not
stored.

"Append-only" is a database property, not a convention: RA1 installs
no-update/no-delete triggers for `recommendation_anchor_events`.  It also
rejects direct updates to an anchor's namespace, local code, recommender,
product, variant, seller snapshot, campaign reference, and target hash.  The
only lifecycle changes are domain-owned status transitions that write the
corresponding event in the same transaction.

Public behavior is fail-closed:

| Situation | Public resolution | Internal record |
|---|---|---|
| Malformed candidate | `RECOMMENDATION_ANCHOR_INVALID`; no product fallback | No record lookup is needed. |
| Unknown valid anchor, withdrawn, disabled namespace, suspended recommender, inactive/deleted target, seller snapshot mismatch, or inactive/deleted variant | `RECOMMENDATION_ANCHOR_NOT_AVAILABLE`; no replacement or product fallback | Specific reason remains auditable only to the owner/admin surface. |
| Active target | Minimal product/variant card plus an explicit source context | Resolver event is optional and rate-limited. |

An account deletion or namespace retirement produces a permanent tombstone.  It
does not free the namespace or local codes for a new account.  A recommender who
is also the seller is not treated as an independent recommendation: RA UI must
label it as seller-originated.  It still has no V1 economic effect.

### 5.3 Resolver and `webaz_search`

RA2 introduces one shared, server-owned `resolveRecommendationAnchor()` domain
function.  It is used by the public resolver route and by both WebAZ search
backends; neither may repeat SQL, parsing, or lifecycle logic.

`webaz_search(query)` first trims and checks whether the **entire** query is an
anchor candidate.  If so it calls this resolver before external-link handling,
alias lookup, title lookup, product discovery, or zero-match recovery.

Success is a dedicated projection, for example:

```json
{
  "schema_version": "webaz.recommendation_anchor.v1",
  "matched_by": "recommendation_anchor",
  "anchor": "@tina:ha95k",
  "recommendation_context": {"anchor": "@tina:ha95k", "explicit_only": true},
  "recommender": {"display_name": "Tina", "relationship_label": "推荐人"},
  "product": {"id": "prod_...", "title": "..."},
  "variant": null,
  "purchase_source_note": "Use only if the buyer explicitly chooses this recommendation."
}
```

A candidate non-match returns a RA-specific structured error with `products: []`
and no `recovery`, `catalog_sample`, discover handoff, or similar item.  The
result must not expose internal user ids, seller private data, event reasons,
or commission-chain data.

The `webaz_search` description must tell models to pass a copied WebAZ anchor
as the whole `query` value.  RA2 does not add a second public tool unless
cross-client testing proves that a separate resolver materially improves
selection; the resolver domain exists regardless.

### 5.4 Explicit transaction source, not hidden attribution

RA4 carries a source only when the buyer explicitly selects it in the PWA or an
authorized buyer agent sends the exact anchor while requesting a quote.  It must
cover **every canonical order-creation path**, not merely the agent-assisted
one.

1. **Agent path:** Quote validates the active anchor and exact product/variant
   target, then snapshots nullable `recommendation_anchor_id` and a separate
   source-context hash.  Quote idempotency requires the existing economic
   intent hash **and** the same source context; the economic hash itself does
   not include the anchor.  Draft copies the immutable source field, and the
   approval request displays and Passkey-binds the source identity.  Its
   purchase-intent duplicate guard remains economic-only.
2. **PWA direct-checkout path:** after a visible buyer choice, the server issues
   a short-lived recommendation context proof bound to that buyer, the exact
   product/variant, and the anchor.  A raw anchor id from browser input is never
   trusted at `POST /api/orders`.  The canonical order route validates this
   proof before using it.  Opening `/r`, resolving a search result, scanning a
   QR code, or merely rendering a product page never issues or writes a source
   by itself.
3. **Shared order write:** both the normal escrow branch and the `direct_p2p`
   branch of the canonical order route validate the exact target and atomically
   write one immutable `order_recommendation_sources` row with the order.
   Failure to write the provenance row rolls back the new order; an absent,
   cleared, expired, mismatched, or unapproved source creates no row.  The
   agent path additionally links its quote, draft, and approval request through
   partial unique indexes; direct PWA checkout leaves those nullable links
   empty.

Changing a source requires a fresh quote/draft on the agent path, or a new
explicit buyer choice on the PWA path; it never rewrites an existing order.  A
pending economic purchase approval is not duplicated merely to change source:
it must be cancelled or expire before a new approval can be created.  No cookie,
URL visit, QR scan, search, or background "touch" can silently set this context.
RA must never write existing share-attribution tables.

### 5.5 URLs and QR

RA3 adds one canonical route:

```text
GET /r/:namespace/:local_code
```

It resolves the same record as text search and opens a PWA product page with a
visible, removable recommendation context.  A GET may create an aggregate,
privacy-preserving rate-limit/audit event, but must not write buyer attribution,
commission eligibility, or an order source.  QR encodes only the canonical URL
through the existing QR renderer.  The text form, URL, QR, PWA page, and MCP
result all expose the same canonical anchor.

## 6. Security, privacy, and anti-abuse / 安全与反滥用

- Exact full-string recognition only; no partial/substr/alias/fuzzy matching.
- Database uniqueness plus append-only lifecycle events; no reclaim or owner
  transfer operation.
- Public resolver response has a fixed minimal projection and uniform failure
  shape for malformed/unknown/disabled sources where practical.
- Rate-limit by IP and authenticated subject, with a global budget and
  namespace-level anomaly signal.  Do not retain raw IP or user-agent in RA
  business records; use existing privacy-reviewed telemetry conventions.
- No redirect destination is caller-controlled.  `/r` only routes to a verified
  internal target.
- No free-text campaign reason, PII, recipient address, commission recipient,
  private seller status, or hidden score enters resolver output, QR text, tool
  output, or source hashes.
- Anchor lookup/resolution must be read-only with respect to economic state;
  only an explicit later quote can create source provenance.
- Existing product/variant availability and price gates re-run at quote/order
  time.  An RA match never bypasses status, inventory, region, payment-rail,
  direct-pay, or Passkey rules.

## 7. Alternatives / 替代方案

### Alt 1: resolve through current `@handle`

Rejected.  Handles are mutable and old values are not permanently reserved.
This creates eventual misattribution and impersonation risk.

### Alt 2: extend `anchor_registry`

Rejected.  Its handle-derived identity, hit/touch semantics, reclaim lifecycle,
and commission-linked attribution are incompatible with permanent recommendation
records.  Altering it would risk historical links and economic behavior.

### Alt 3: use only `product_aliases`

Rejected.  Aliases identify products, not a recommender, variant, campaign, or
explicit order source.  The current search path permits substring inclusion,
which is forbidden for a security-sensitive anchor.

### Alt 4: URL/cookie first-touch attribution

Rejected.  It is invisible to buyers, conflicts with the existing commission
path, and makes an incidental click look like an affirmative recommendation
choice.

### Alt 5: a host-specific ChatGPT action/tool

Rejected.  MCP already carries structured string arguments.  A vendor-specific
protocol would harm Claude, OpenClaw, Cursor, Codex, and future clients without
solving natural-language ambiguity.

## 8. Required compatibility experiments / 必须完成的验证

These are release gates for RA2–RA5, not assumptions.

| Test | Procedure | Pass condition |
|---|---|---|
| MCP wire | Call `webaz_search` with exact `@tina:ha95k` JSON argument. | Resolver branch returns the RA projection; malformed input never falls back. |
| ChatGPT web | Paste raw anchor, code-span anchor, and anchor inside a sentence into a signed-in chat with the WebAZ connector. | Tool trace shows exact whole-anchor query or the client offers an explicit copy/open fallback. |
| ChatGPT mobile | Repeat after connector installation and PWA deep-link open. | Same semantics; no hidden attribution. |
| Claude web/Desktop/Code | Run the same raw/paste/markdown cases over Remote MCP. | Exact tool argument or documented fallback. |
| OpenClaw | Use its remote MCP probe then a controlled tool request. | Exact argument and structured response survive. |
| Browser + QR | Open desktop/mobile `/r/tina/ha95k`; scan a generated QR. | Canonical route, matching record, removable context, no attribution write. |
| Security | Try full-width punctuation, zero-width characters, suffixes, title aliases, inactive product, deleted variant, and rate bursts. | Clear RA non-match/availability result; no product recovery, redirect, commission write, or data leak. |

## 9. Implementation plan / 实施切分

| PR | Scope | Must not do |
|---|---|---|
| **RA0** | This audit/RFC and host experiment plan. | Production code, database migration, deployment. |
| **RA1** | Independent namespace/anchor/event schema, lifecycle domain, cryptographic issuer, admin-safe audit, unit tests. | Search routing, URLs, QR, order attribution, commission changes. |
| **RA2** | Shared exact resolver, public minimal projection, `webaz_search` branch and output contract, rate limits, negative tests. | Implicit source write or fallback search for anchor candidates. |
| **RA3** | PWA issue/manage/copy flow, canonical `/r` route, QR rendering, visible/removable context. | Cookie/scan attribution or a second resolver authority. |
| **RA4** | Explicit source propagation through quote -> draft -> approval -> order **and** PWA direct checkout; buyer-bound context proof; both escrow/direct_p2p atomic order-source writes; Passkey display/binding; append-only order source; full money-path regression tests. | Price/commission/settlement/wallet changes. |
| **RA5** | Cross-host conformance matrix, real browser/QR tests, canary metrics, docs. | Host-specific protocol forks or a commercial attribution program. |

Every implementation PR is additive and independently fail-closed.  RA4 must
be reviewed as money-adjacent provenance work even though it does not modify
money calculations.

## 10. Migration, compatibility, and rollback

- Existing `anchor_registry`, `/s` links, invite links, aliases, and
  `product_share_attribution` retain their present semantics.
- RA starts forward-only.  No automatic migration of old anchors or past orders
  is allowed; importing a historic record would need an explicit audited tool
  and user confirmation in a later RFC.
- Before RA4, recommendation records are discovery metadata only.
- RA1/RA2 rollback means disabling the new resolver/issuer and retaining
  tombstoned records; identifiers are never reassigned during rollback.
- RA4 rollback disables new source creation but leaves past
  `order_recommendation_sources` rows as immutable audit facts.

## 11. Decisions to lock before RA1

1. **Code length:** approve fixed five-character local codes (recommended) or
   explicitly accept the weaker four-character example format.
2. **Namespace policy:** one permanent non-transferable namespace per identity
   in V1 (recommended), plus the reserved/protected-name policy above, versus a
   future multi-namespace/campaign hierarchy.
3. **Seller-as-recommender:** permit it with a visible “seller recommendation”
   label and no economic effect (recommended), versus prohibit it entirely.
4. **Material product edits:** V1 can preserve the anchor but show a
   `changed_since_recommendation` disclosure from a stored content snapshot;
   automatic retargeting is prohibited.

## 12. Meta-rule impact / 元规则影响

- **#1 当一切可见:** explicit source is visible and removable before quote and
  visible in approval/order history.
- **#2 代码即规则:** namespace ownership, uniqueness, no-reuse, lifecycle, and
  source propagation are database/domain constraints, not UI promises.
- **#3 不偷数据:** no raw address, hidden clicks, cookies, or incidental source
  attribution.
- **#4 不撒谎:** recommender/seller relationship is accurately labelled; RA is
  not marketed as a commission or price benefit.
- **#5 不偏袒:** no undisclosed first/last-touch winner; a buyer explicitly
  chooses the source.
- **#6 不滥用:** rate limits, narrow projection, anti-enumeration controls, and
  no auto-redirection to unrelated items.
- **#7 不操纵:** no ranking boost, conversion score, or forced recommendation
  context in this RFC.
- **#8 最小介入:** the new resolver is narrow and existing share economics stay
  untouched.
- **#9 算法即协议:** canonical grammar, failure behavior, and propagation are
  specified and tested.
- **#10 参与者即 webazer:** a user owns a stable recommendation namespace apart
  from a mutable display handle.
- **Iron-Rule technical boundary:** no Passkey path is bypassed.  RA4 adds
  source display/binding to the existing approval path; it cannot execute an
  order by itself.

## 13. Test plan / 测试计划

- Parser/property tests: ASCII grammar, normalization rejection, no partial
  match, no Unicode/invisible acceptance, random-code collision retry.
- Schema tests: unique namespace, unique local code per namespace, namespace
  owner equals recommender, immutable target/recommender, reserved-name denial,
  tombstone/no-reclaim, and database-enforced append-only events.
- Resolver tests: every lifecycle branch, no PII, no title/alias/catalog fallback,
  exact product/variant availability, rate-limit behavior.
- Regression tests: legacy anchors, share links, referral attribution,
  commissions, aliases, ordinary `webaz_search`, direct pay, escrow, and
  existing quote/draft/order tests remain unchanged unless RA4 is under test.
- RA4 tests: explicit source copied quote->draft->approval->order; PWA direct
  checkout requires a buyer/product/variant-bound context proof; both escrow
  and direct_p2p write provenance atomically; source swap conflicts on quote
  idempotency; source absent/expired/mismatched means no row; duplicate economic
  purchase remains blocked; no amount/commission/wallet difference.
- RA5 tests: the matrix in section 8, with captured tool traces and mobile
  screenshots recorded as evidence rather than hand-waved compatibility claims.

## 14. Pre-flight checklist / 提交前自查

- [x] This RA0 document contains no production code or schema migration.
- [x] Existing handles, anchors, aliases, and share attribution were audited.
- [x] At least five alternatives were considered and rejected with reasons.
- [x] Unknown host behavior is assigned to concrete experiments.
- [x] No existing commission, wallet, escrow, settlement, or Passkey semantics
  are changed by this proposal.
- [ ] Maintainer assigns review window and records decisions in section 11.

## Implementation tracking / 实现追踪

- RA0 RFC PR: pending
- RA1: pending
- RA2: pending
- RA3: pending
- RA4: pending
- RA5: pending

---

**Status history / 状态变更**:

- 2026-07-19: RA0 draft created from read-only code audit, standards research,
  and a live MCP string-transport probe.  No production code changed.
