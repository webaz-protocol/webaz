# Agent/API Security Gateway — Threat Model and Current-Control Audit

**Status**: PR-S0 design candidate; docs only
**Date**: 2026-07-19
**Applies to**: Remote MCP, Recommendation Anchors, Buyer Lite bootstrap,
guest purchase intents, quote/draft/approval APIs
**Related**: [RFC-028](../rfcs/RFC-028-guest-buyer-fast-entry.md)

## 1. Security decision

WebAZ needs an explicit Agent/API Security Gateway boundary before allowing
unregistered-buyer state creation. The gateway is not a second commerce
protocol and does not own order semantics. It is a policy-enforcement plane in
front of existing domain services.

```text
Cloudflare/WAF
  -> origin guard
  -> Agent/API Gateway
       principal verification
       request proof/replay
       object/scope policy
       multidimensional quota/cost/risk/degraded mode
       minimal security audit
  -> public catalog / identity adapter / quote-draft-approval domains
  -> canonical order engine
```

Every state-changing call is default-deny. A higher trust tier can increase
quota; it can never bypass OAuth subject ownership, Passkey or order/financial
authorization.

## 2. Assets

| Asset | Security objective |
|---|---|
| WebAZ account and external subject binding | no account takeover or duplicate silent link |
| Guest intent/resume proof | confidentiality, one-account binding, expiry, no hijack |
| Recommendation anchor provenance | immutable recommender/product binding, no attribution theft |
| Address | never available to agents; object-owner access only |
| Quote/draft/approval/order | integrity, ownership, idempotency, no unauthorized execution |
| OAuth grants/tokens/codes | audience/scope/client/subject binding, one-time code, revocation |
| Passkey challenge/gate token | one-time, purpose/payload bound, never logged |
| Product content | untrusted data; never control instructions or server fetch targets |
| Infrastructure capacity and paid downstream budget | availability and bounded spend |
| Security logs | enough evidence without secrets or PII |

## 3. Trust boundaries and principals

### 3.1 Required principal classes

| Principal | Verifiable basis | Allowed baseline |
|---|---|---|
| `anonymous_agent` | none | exact public anchor resolution, bounded search/detail/policy reads |
| `registered_agent` | approved client registry + cryptographic client proof negotiated for that client | higher public-read quota only |
| `user_authorized_agent` | verified per-connection client proof + active OAuth grant + subject/scope/object checks | quote/draft/approval preparation by scope |
| `verified_partner_agent` | reviewed registry status + sender-constrained token | higher quota; same user/Passkey rules |
| `human_browser_guest` | first-party origin plus anti-bot/risk challenge; not identity | create one minimal guest intent |
| `human_session` | existing WebAZ authenticated account | existing PWA permissions |
| `legacy_api_key_client` | existing API key | unchanged legacy surface; not automatically a verified partner |

### 3.2 Hard identity rule

None of the following proves agent identity:

- User-Agent;
- model or company name;
- Host or Origin alone;
- self-declared header;
- prompt text such as "I am ChatGPT";
- an unverified OAuth DCR `client_id`.

Current DCR creates public, self-declared, `verified=0` clients. Those clients
remain `anonymous_agent` until a separate registry verification process exists.
PKCE protects an authorization code flow; it does not attest the publisher of a
public client.

## 4. Current controls: evidence and gaps

| Control | Current state | Assessment |
|---|---|---|
| Cloudflare origin secret | Middleware protects `/mcp` and `/oauth` when `WEBAZ_EDGE_SECRET` is configured; dormant otherwise | **Partial**: not all future guest/API routes; deployment state must be monitored |
| Remote MCP Origin guard | exact allowlist or no Origin | **Present**, DNS-rebinding control, not identity |
| Request body cap | source comment says 100 KB, but global `express.json()` has no explicit limit in code | **Gap/ambiguity**: Express default happens to be 100 KB; set explicit owned limit and endpoint overrides |
| MCP rate limit | 240/min by validated CF IP | **Partial**: single-process in-memory, IP only, no cost/client/subject/product dimensions |
| Generic rate limiter | in-process `Map<string, number[]>` | **Partial**: lost on restart, not shared across replicas, unbounded-key pressure risk |
| OAuth DCR limits | 10/IP/min + 60 global/min and stale-client sweep | **Present locally**, still in-memory and not verified-client identity |
| OAuth auth-code replay | code is one-time; replay revokes tokens on the associated grant | **Present** |
| OAuth audience | access token stores and verifies `/mcp` audience | **Present** |
| OAuth client/token sender constraint | public bearer token; reserved `agent_pubkey` unused | **Gap in WebAZ**; ChatGPT documents managed mTLS, but WebAZ does not yet validate it |
| OAuth issuer/client/subject proof per request | token resolves grant and client metadata exists | **Partial**: bearer possession is sufficient; no validated mTLS/DPoP/request-signature context or proof replay cache |
| OAuth consent presence | every consent currently requires Passkey | **Strong but incompatible with deferred-Passkey Buyer Lite**: only a server-selected SAFE/non-executing preparation bundle may use verified-session explicit consent; execution stays Passkey |
| Grant scope/object authorization | explicit route middleware; owner-scoped quote/draft reads | **Strong existing base** |
| Grant audit | successful grant authorization fails closed if audit write fails | **Strong existing base** |
| Passkey | UV-required, one-time challenge, purpose data and short gate token | **Strong existing base** |
| Quote/draft/approval idempotency | one-time quote, immutable draft, intent hash, CAS execution/reconcile | **Strong existing base** |
| Recommendation anchor enumeration defense | RFC-027 RA1 has no resolver yet | **Not implemented** |
| Guest intent object authorization | no object exists | **Not implemented** |
| Multi-dimensional quotas/cost budgets | some agent trust caps and endpoint limits exist | **Gap for this surface** |
| Read-only degraded mode | no unified gateway switch | **Gap** |
| WAF/bot/ASN rules | infrastructure configuration not provable from repository | **Unknown — ops experiment/audit required** |
| Monitoring/alerts | local logs/audits exist | **Gap**: no gateway dashboard/alert contract shown |

## 5. Threat analysis

Severity means impact before new mitigations.

| Threat | Severity | Existing defense | Required control |
|---|---|---|---|
| Fake ChatGPT/Claude claims higher trust | critical | consent displays DCR unverified | verified registry + proof; never trust strings |
| Stolen bearer token replay | critical | expiry/audience/revocation | DPoP or mTLS for elevated tiers, nonce/jti replay cache |
| OAuth callback/state tamper | critical | PKCE, redirect validation, state echo | server state record, OIDC nonce, one-time callback CAS |
| Guest intent hijack/id swap | critical | none | separate resume proof + account ownership + CAS |
| Anchor attribution theft | high | RA immutable target | server-resolve anchor; never accept free `ran_*`; context hash |
| Object ID substitution (`gpi/qte/odr/apr/ord`) | critical | quote/draft owner checks | gateway object policy + negative cross-user tests everywhere |
| Anonymous anchor enumeration | high | none for RA | exact-only resolver, uniform miss, distributed miss budget |
| Registration/account farming | high | email, Turnstile, 5/IP/hour | device/network/provider signals, distributed budget, risk hold |
| Quote/draft/approval flooding | high | grant scopes and some IP limits | per-client/subject/account/product/cost limits + anomaly detection |
| DDoS/slow request/large body | critical availability | CF + origin guard + implicit body cap | explicit edge/body/time/concurrency limits and origin removal/lock |
| Paid provider cost exhaustion | high | scattered timeouts | per-provider budgets, circuit breaker, no anonymous calls |
| Prompt injection in product data | high | frontend escaping in places | structured data boundary, no instruction interpolation, URL/SSRF policy |
| PII/secret logging | critical | minimal projections in shopping chain | structured allowlist logger + tests; no body dumps |
| Multi-tab duplicate state | high | downstream idempotency | guest bind/consume CAS and one active chain per intent |
| Gateway outage blocks existing orders | critical availability | none unified | priority lanes + degraded mode preserving reads/reconcile |

## 6. Gateway policy model

Each request produces an internal, non-forgeable context:

```text
request_id
principal_type
verified_client_id? / client_status?
oauth_grant_id? / subject? / scopes? / audience?
proof_thumbprint? / jti? / nonce?
source_ip_hash / asn? / region?
endpoint / operation / cost_class
object_type / object_id / owner_id?
risk_decision / quota_decision / degraded_mode
```

Route handlers may consume this context but cannot construct it from request
headers. Middleware order is fixed:

1. edge provenance and body/time limits;
2. request id;
3. cryptographic credential/proof verification;
4. replay check;
5. principal classification;
6. endpoint/scope/object policy;
7. multi-dimensional quota and cost budget;
8. risk/degraded-mode decision;
9. minimal audit;
10. domain handler.

Denials occur before expensive DB or downstream work where possible.

## 7. Request integrity and sender-constrained tokens

For anonymous public reads, TLS, edge controls and strict input limits are the
boundary. For authenticated agent state changes, validate:

- token hash, issuer, audience, client, grant subject, scope, expiry and
  revocation;
- method and canonical target URI;
- proof timestamp and unique `jti`/nonce;
- key thumbprint bound to the access token;
- request id, idempotency key and canonical payload hash.

### 7.1 Client-proof compatibility decision

The gateway supports a proof-policy seam, not one vendor-specific proof. A
client enters an elevated tier only through a proof method that the client
actually supports and WebAZ has verified end to end.

Current official OpenAI documentation establishes that ChatGPT:

- presents an OpenAI-managed client certificate to MCP servers and publishes
  the CA chain and required SAN for mTLS validation;
- supports Client ID Metadata Documents (CIMD), preferring
  `private_key_jwt` at the token endpoint when the authorization server also
  supports it, with `none` as the public-client fallback;
- sends the issued access token to MCP requests as an
  `Authorization: Bearer` token.

The documentation does not advertise DPoP proof on ChatGPT MCP resource
requests. Therefore **S1 must not require DPoP from ChatGPT**. The minimum
ChatGPT profile is validated OpenAI mTLS on each MCP connection + OAuth user
token validation; CIMD + `private_key_jwt` additionally authenticates the
OAuth client at token exchange but does not replace per-connection mTLS.

DPoP remains the preferred application-layer option for clients that prove
support. Request signatures or customer-controlled mTLS may be registered for
other clients. Unsupported clients stay anonymous/low-tier; a bearer token or
self-declared client name never silently substitutes for proof.

DPoP does **not** make a self-registered client a verified company. It proves
continued possession of a key and constrains a token. Publisher verification is
a separate registry/governance fact.

OpenAI mTLS capability is now documented, but WebAZ deployment compatibility is
not yet proven. Because Cloudflare terminates the public TLS connection, S1
must prove that the edge validates the OpenAI CA chain, client-auth EKU and the
exact `mtls.prod.connectors.openai.com` SAN and then passes only an
edge-authenticated internal principal. A caller-supplied header must never be
accepted as this signal. Cloudflare documents that importing a non-Cloudflare
CA for edge mTLS is an Enterprise capability; if the active plan cannot trust
the OpenAI CA, the experiment must fail closed and choose a dedicated trusted
TLS terminator or keep ChatGPT out of elevated agent tiers. It must not weaken
the rule.

Until a client proves a supported method, it may use only low-quota exact
public reads; a bearer grant alone cannot unlock private user data, guest-intent
creation, quote/draft writes or a verified/high-quota tier.

Replay state must be shared across instances and expire at least as long as the
accepted proof window. Failures return a coarse code; thresholds and observed
fingerprints are not disclosed.

### 7.2 Standards evidence

- [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html) defines DPoP as an
  application-level sender constraint. Its proof binds a unique `jti`, method
  (`htm`), target URI (`htu`), issue time, optional server nonce and, for
  protected-resource access, the access-token hash (`ath`). The RFC explicitly
  says DPoP is not client authentication and is not sufficient by itself for an
  access-control decision.
- [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) recommends
  sender-constrained and audience-restricted access tokens, PKCE for public
  clients, least privilege, and transaction-specific PKCE/nonce values. It also
  requires application state carried in OAuth `state` to be protected against
  tampering and swapping.
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
  supplies the `iss`/`sub` identity model and transaction nonce required for
  Buyer Lite provider login. WebAZ must bind the stable issuer+subject pair;
  display name or email alone is not the account key.
- [OpenAI Apps SDK authentication](https://developers.openai.com/apps-sdk/build/auth)
  documents ChatGPT's OAuth 2.1 client behavior, CIMD support,
  `private_key_jwt`, OpenAI-managed MCP client certificate, published CA chain,
  required SAN and continued requirement for OAuth user authorization.
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
  standardizes OAuth 2.1, protected-resource metadata, resource indicators,
  PKCE, CIMD/DCR and Bearer access-token use. It does not require DPoP, so
  WebAZ cannot make DPoP a universal interoperability assumption.
- [Cloudflare mTLS documentation](https://developers.cloudflare.com/api-shield/security/mtls/)
  documents edge client-certificate validation and the plan boundary for
  bringing a non-Cloudflare CA. WebAZ must verify its actual account capability
  rather than assuming the OpenAI CA can be installed.

DPoP covers selected request metadata, not an arbitrary JSON payload. WebAZ's
existing canonical payload hash, idempotency key and state revalidation remain
necessary for quote/draft/approval writes.

## 8. Multi-dimensional limits and cost classes

### 8.1 Dimensions

Apply intersecting budgets, not alternatives:

```text
IP / subnet / ASN / edge risk
verified client id and client status
OAuth subject and WebAZ account
anchor namespace + exact anchor
product
endpoint + operation
global service budget
downstream provider budget
```

The strictest active decision wins. Distributed storage is required; the
current process-local map is insufficient as the authoritative limiter.

### 8.2 Classes

| Class | Examples | Policy |
|---|---|---|
| public-low | exact anchor, constrained search, product detail | cacheable, bounded page/result/body/time; no state |
| private-read | connection, masked address, owned approval/order | OAuth + ownership; higher priority |
| medium | shipping facts, address-dependent quote | lower rate; subject/client/product budgets |
| high | registration, email, guest intent, draft, approval, Passkey | strict distributed limits, idempotency, risk challenge |
| economic | Passkey approval/order action | existing canonical engine; never shed after commit; reconcile unknown outcome |

### 8.3 Resource budgets

Every gateway policy entry declares maximum body bytes, query length, arrays,
results, DB statement budget, downstream calls, wall time, concurrency and
retries. Anonymous paths cannot call email, SMS, OIDC token exchange, Passkey,
or paid third parties.

## 9. Anchor anti-enumeration

The resolver accepts only one complete canonical anchor. It has no list,
prefix, autocomplete, nearest-match, namespace count or recommender inventory
endpoint. Unknown, withdrawn, disabled and malformed inputs share a public
message and comparable response envelope:

> 没有找到该推荐口令，请检查是否完整复制。

The internal reason remains available only to authorized operations. Miss
budgets aggregate by IP/ASN/client/namespace and detect sequential codes,
cross-namespace scans and high miss ratios. Codes are never reused.

## 10. Provenance integrity

The public caller provides only the canonical anchor string. The server resolves
and freezes:

```text
recommendation_anchor_id
stable recommender_user_id
permanent namespace id
product_id
variant_id
target snapshot hash
```

Guest intent, identity callback state, quote, draft, approval and order accept
only the server record/context hash. A product change clears the context; an
anchor can be changed only by an explicit new exact resolution.

## 11. Prompt injection, URL and content policy

Product title, description, seller terms, anchor labels, images and external
URLs are untrusted data.

- MCP outputs put product facts in structured content, never system/developer
  instruction fields.
- Model-facing text explicitly labels seller content as untrusted data.
- Rendering uses text/escaping; HTML/script/event handlers are never trusted.
- Product content cannot request tool calls or override policy.
- Server-side URL fetches require a fixed scheme/host policy, DNS/IP checks,
  redirect bounds, timeout/body limits and response MIME validation.
- Guest/Agent input never causes arbitrary URL fetch.
- Images/attachments use type, size and content checks.

## 12. Degraded mode and priority

`read_only_degraded_mode` is an explicit operational state. Priority order:

1. existing order/approval read and reconcile;
2. authenticated normal quotes;
3. cached product/anchor reads;
4. anonymous exploration;
5. new registration, intents, drafts and approvals.

In degraded mode, new high-cost state can be refused with retry guidance.
Committed orders and approvals are never deleted, rewritten or forgotten.

The switch requires an owner, audit event, status endpoint and recovery test.
It cannot silently become a permanent launch gate.

## 13. Logging and alerting

Allowlisted security fields:

```text
request_id, principal_type, client_id, masked/hashed subject hint,
endpoint, operation, result_code, latency_bucket, cost_units,
quota/risk decision, anchor_id, product_id, replay outcome
```

Never log access/resume/magic-link tokens, full address, phone, email body,
Passkey challenge/assertion, payment credential, private chat or raw request
body. IP may be retained only according to the privacy/security policy; normal
application audit should use a keyed hash.

Alerts cover volume/miss spikes, replay, registration/quote/draft anomalies,
OAuth errors, DB/CPU/queue saturation, provider cost, WAF events, origin-guard
failures and degraded-mode duration.

## 14. Required experiments / unknowns

| Unknown | Experiment | Pass condition |
|---|---|---|
| Is `WEBAZ_EDGE_SECRET` active in production? | direct-origin negative probe + CF path positive probe | origin sensitive routes 403; canonical host succeeds |
| Current Cloudflare WAF/Bot/ASN/rate rules | export/read-only ops audit | documented owned rules and rollback |
| OpenAI mTLS through the current Cloudflare plan | staging MCP hostname + OpenAI CA/SAN validation + Developer Mode trace | valid ChatGPT connection receives an unforgeable internal principal; no/wrong cert and spoofed headers fail |
| ChatGPT CIMD + `private_key_jwt` | staging authorization-server metadata and token trace | assertion validates against ChatGPT CIMD JWKS; replay/wrong audience/wrong client fails |
| ChatGPT DPoP support | Developer Mode trace without secrets | optional only; absence does not fail the mTLS profile |
| Claude/generic MCP proof support | mTLS/DPoP/request-signature matrix | a supported proof is registered or the client remains low tier |
| Multi-instance shared limiter store | infrastructure inventory/load test | one global budget across instances |
| Explicit request-body/time limits | oversized/slow tests at edge and app | bounded before handler work |
| OIDC providers and subject semantics | provider metadata/policy review | issuer/subject/nonce verified, no email-only takeover |

No unknown may be converted into an implementation assumption.

## 15. PR plan and acceptance gates

### PR-S0 — this document

- assets, boundaries, threats, current controls, unknown experiments;
- no production code, merge or deploy.

### PR-S1 — principal and proof seam

- internal gateway context and default-deny policy registry;
- verified client registry lifecycle (unverified DCR stays anonymous);
- proof negotiation (`openai_mtls`, `dpop`, `request_signature`, partner mTLS);
- OpenAI mTLS edge experiment and fail-closed principal propagation;
- optional CIMD + `private_key_jwt` token-endpoint client authentication;
- shared nonce/jti replay cache;
- feature flag off; no commerce route moved yet.

### PR-S2 — limits and cost budgets

- distributed counters across dimensions;
- endpoint cost classes/body/query/result/time/concurrency budgets;
- downstream circuit breakers;
- precedence and priority tests.

### PR-S3 — business abuse policy

- exact-anchor miss policy;
- Buyer Lite/email/intent/quote/draft/approval limits;
- risk escalation and coarse responses;
- no hard-coded secret thresholds in public output.

### PR-S4 — edge and degraded mode

- Cloudflare/Railway runbook and proof;
- origin exposure closure for new API surfaces;
- auditable degraded-mode switch and recovery.

### PR-S5 — tests and operations

- the 20 required adversarial scenarios;
- dashboards/alerts;
- incident and rollback runbooks;
- load and recovery test evidence.

Every PR is Draft, independently reviewable, default-off where applicable, and
must not merge or deploy without explicit human approval.

## 16. Additional acceptance tests

Beyond the supplied 20 tests, add:

21. unverified DCR client remains anonymous despite arbitrary brand name;
22. DPoP proof for method/URL A cannot authorize method/URL B;
23. OpenAI mTLS positive path requires the published CA chain, client-auth EKU
    and exact SAN;
24. absent certificate, wrong CA, wrong SAN, revoked certificate and a spoofed
    edge-proof header cannot enter `registered_agent`;
25. a valid OAuth bearer replayed outside its bound verified client connection
    cannot reach guest-intent/quote/draft writes;
26. `private_key_jwt` replay, wrong audience, wrong client and unknown `kid`
    fail without changing OAuth or commerce state;
27. two instances reject the same replayed jti;
28. quota cannot be reset by rotating IP while keeping client/subject/product;
29. anonymous agent cannot create even a zero-value persistent intent;
30. first-party guest challenge cannot be replayed by an agent;
31. intent locator without resume proof fails;
32. forged `ran_*` never changes provenance;
33. logs and traces pass a secret/PII canary scan;
34. degraded mode preserves order approval and reconcile paths;
35. circuit breaker opens without exhausting worker/DB pools;
36. cache keys never mix authenticated/private and public responses.
