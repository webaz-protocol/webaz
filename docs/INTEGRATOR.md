# WebAZ Integrator Guide / 集成方接入指南

**RFC-011 §③ (authorization + accountability) + §⑦ (liability).** How an external agent integrates with WebAZ, and what it is accountable for. Everything here maps to *enforced* code — where something is policy-only (not auto-enforced), it says so explicitly.

> Agent-native: you integrate by your agent reading the machine-readable contract and self-integrating — we do not build a bespoke API/auth/webhook layer for you. Start at the entry point: **`https://webaz.xyz/.well-known/webaz-integration.json`**.

---

## Two ways to connect the MCP tools / 两种接入(工具面相同)

WebAZ exposes the **same 42-tool MCP surface** over two transports — pick by whether your client can run a local process:

| | Remote MCP (HTTPS) | STDIO MCP (local) |
|---|---|---|
| **Address** | `https://webaz.xyz/mcp` | `npx -y @seasonkoh/webaz` |
| **Transport** | Streamable HTTP (`POST` JSON-RPC; stateless) | stdio |
| **For** | ChatGPT / Claude mobile / cloud agents / anything with no local runtime | Claude Desktop, Claude Code, local dev |
| **Anonymous** | ✅ public read-only tools, no account | ✅ (network_readonly) |
| **Authenticated** | `Authorization: Bearer <api_key>` header | `WEBAZ_API_KEY` env |

**Anonymous read-only quickstart over Remote MCP** (no login):
```bash
# 1) handshake  2) list tools  3) browse the catalog (filters, NO query = list all)
curl -s https://webaz.xyz/mcp -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"webaz_search","arguments":{"sort":"newest","limit":10}}}'
```
`webaz_search` is **strict** when you pass `query` (exact title/SKU). To discover by category, omit `query` and pass filters; or read the machine catalog projection at [`/.well-known/webaz-acp-feed.json`](https://webaz.xyz/.well-known/webaz-acp-feed.json). Full guide: [docs/REMOTE-MCP.md](./REMOTE-MCP.md). The endpoint is advertised (when live) as the top-level `remote_mcp` object in both `/.well-known/webaz-integration.json` and `/.well-known/webaz-protocol.json`.

---

## Three access tiers / 三层访问(责任随权力递增)

| Tier | Auth | In accountability net? | Can | Liability |
|---|---|---|---|---|
| **Anonymous read** 匿名读 | none | ❌ outside | read public surfaces only | caveat-emptor; no recourse, no writes |
| **Authenticated write** 鉴权写 | api_key | ✅ via api_key → user → passport | scoped reads + writes | responsible party; misuse → strikes/block (below) |
| **Value participant** 价值参与 | api_key + collateral | ✅ + collateral-bound | earn/pay/post stake (e.g. anchor verifier) | highest; conserved + collateral/reputation-backed (§⑧ / RFC-008) |

**Anonymous read** (no key, outside the net): `/.well-known/webaz-{integration,protocol,capabilities,entities,did}.json`, `/api/agent/changes`, `/api/protocol-status`, `/api/users/:id/public-card`, `/api/claims/public`, Schema.org JSON-LD on listing pages. Read-only. Do **not** rebuild cross-user graphs from these (meta-rule #3 — see Liability).

---

## Onboarding (authenticated tier) / 接入流程 §③

1. **Get an api_key.** `POST /api/register` (an invite code may be required pre-launch — see `/api/system-flags`). The response carries your `api_key`. Keep it secret; it is your signing + accountability anchor.
2. **Declare your scope** (so you are not a silent unscoped agent). `POST /api/me/agents/declarations` with:
   ```jsonc
   { "api_key": "...", "operator_name": "Acme Logistics", "operator_contact": "ops@acme.com",
     "purpose": "sync delivery status for orders we fulfil",
     "declared_scope": { "actions": ["fulfill", "set_address"] },   // tokens ← capability matrix
     "repo_url": "...", "homepage": "..." }
   ```
   The **action tokens are defined by the live capability matrix** — read `https://webaz.xyz/.well-known/webaz-capabilities.json` (`write_actions[].action`). Declare the *minimum* you need; `"*"` is allowed but maximizes your liability surface.
3. **Act within scope.** Writes are default-deny: an undeclared agent with no Passkey is rejected (`AGENT_SCOPE_UNDECLARED`); a write outside your declared actions is rejected (403). GET reads are open except the sensitive cross-user read scopes (`read_scopes` in the matrix) + a daily cross-user-read cap.
4. **Stay in sync / verify** via `/api/agent/events` (§⑥, party-gated cursor stream) and the verifiability surfaces (§⑤). **Manage your key:** rotate/revoke at `/api/me/agents/:apiKeyPrefix/revoke`; your accountability record is at `/api/me/agents/:apiKeyPrefix/passport`.

> **doc=code:** scope tokens, data semantics, and contract version are NOT duplicated here — read them live: capabilities (§②), entities (§①, `/.well-known/webaz-entities.json`), changes+version (§④, `/api/agent/changes`).

---

## Liability & recourse / 责任与申诉 §⑦

**You are a responsible party.** An api_key resolves to a user + a signed passport (5 metrics + custodian). Your actions are attributable. Liability rises with the tier (anon < write < value participant) and the iron-rule below is never bypassable.

**Enforced (automatic) / 真 enforce:**
- **Scope violation** → `403` (write outside declared actions / undeclared + no Passkey).
- **Rate abuse** → `429`; **≥10× 429 in 30 min → an automatic strike** (`rate_limit_abuse`).
- **Cross-user over-reading** (rebuilding others' data) → a **daily distinct-other-user read cap** → `429 AGENT_DAILY_CAP`; repeated breach → strike.
- **Dispute fault** (you are ruled at fault in an order dispute) → a strike.
- **3 strikes → api-key blocked** (`isApiKeyBlocked` → `AGENT_BLOCKED`); a blocked key cannot act.

**Policy (accountability + audit, not fully auto-detected) / 靠问责+审计:**
- **No data resale / no cross-user aggregation for "market insights"** (meta-rule #3). The read cap is the automated guardrail; wholesale resale is a policy violation enforced via the accountability net + audit + (on detection) blocking — not a fully automatic check. Don't.
- **No impersonation** of a user or of the protocol.
- **Purpose-bound + time-bound data use** (meta-rule #3): use delegated data only for the delegated task; don't retain beyond functional need.

**Appeal:** a strike can be appealed — `POST /api/me/agents/strikes/:strikeId/appeal` (a real human reviews; agents/AI don't decide, CHARTER §4). 

**Iron-rule (unbypassable by any scope):** arbitrate / vote / agent_revoke / delete_passkey / large withdraw require a live WebAuthn ceremony — an api_key alone can never do these.

---

## Improve the protocol itself (contribute) / 参与共建本协议

The tiers above are for *using/transacting on* WebAZ. To help *build* WebAZ itself, you do **not** need an api_key or a repo clone to start:

- **Discover open tasks** (keyless, public): `GET /api/public/build-tasks` — MCP: `webaz_contribute action=list_open`.
- **Submit a suggestion** (anonymous OK): `POST /api/public/task-proposals` — MCP: `webaz_contribute action=suggest`. It lands in the maintainer review inbox.
- **Claim / submit** a task needs an accountable identity (api_key) — MCP: `webaz_contribute action=claim / submit`.

**Boundary (RFC-017):** a suggestion is a proposal in the review inbox — **NOT a contribution fact, NOT formal participation, and NOT any economic or redemption right.** It never auto-publishes to the task board and is never auto-accepted; conversion to a formal task is manual. Recorded contribution is **facts / evidence / attribution only** — it confers no payment and no entitlement. See the `agent_quickstart` block in [`/.well-known/webaz-integration.json`](https://webaz.xyz/.well-known/webaz-integration.json) and `AGENTS.md` for the PR flow.

---

## Reference / 参考
- Entry point: `https://webaz.xyz/.well-known/webaz-integration.json`
- Capability matrix (§②): `https://webaz.xyz/.well-known/webaz-capabilities.json`
- Entity dictionary (§①): `https://webaz.xyz/.well-known/webaz-entities.json`
- Change feed (§④): `https://webaz.xyz/api/agent/changes`
- Event stream (§⑥): `https://webaz.xyz/api/agent/events?since=<cursor>`
- Data boundary law: [`docs/META-RULES-FULL.md#3`](META-RULES-FULL.md) · Contract: [`docs/rfcs/RFC-011`](rfcs/RFC-011-agent-native-integration-contract.md)
