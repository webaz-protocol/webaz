> **Code is Rule, Protocol is Trust.**
> — webaz

# `@webaz/agent-sdk` · Template (v0.1)

> Starter template for third-party developers building agents on WebAZ.
> Spec: [`../../docs/AGENT-GOVERNANCE.md`](../../docs/AGENT-GOVERNANCE.md)

## What you get

- TypeScript MCP client wrapping all 32 `webaz_*` tools
- Declaration helper (POST your agent's `operator_name` / `purpose` / `declared_scope`)
- Rate-limit aware retry (auto-backoff on 429)
- Strike / revocation aware (refuses to call when `error_code: 'AGENT_BLOCKED'`)
- Bilateral attestation flow (prompt user to approve before sensitive ops)

## Quick start

```bash
# 1. Get your api_key
curl -X POST https://webaz.xyz/api/users -d '{"role":"buyer","handle":"my_agent_001"}'

# 2. Declare your agent (required for trust > new)
curl -X POST https://webaz.xyz/api/me/agents/declarations \
  -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "operator_name": "Acme Corp",
    "operator_contact": "agents@acme.com",
    "purpose": "AI shopping assistant — finds cheapest crypto-aware sellers",
    "declared_scope": {
      "roles": ["buyer"],
      "actions": ["search", "verify_price", "place_order"],
      "regions": ["*"]
    },
    "attestations": {
      "no_pii_export": true,
      "gdpr_compliant": true
    }
  }'

# 3. Use MCP tools
# See ../../docs/api-endpoints.md for full schema
```

## Trust ladder

| Level | Triggers | Rate (per minute) | Capabilities |
|---|---|---|---|
| new | default | 10 | search / view / get_status |
| trusted | trust_score ≥ 0.4 + 1 successful purchase | 60 | + place_order, list_product, charity.donate |
| quality | trust_score ≥ 0.7 + 100 calls + 0 strikes | 200 | + bulk ops, auto_bid |
| legend | trust_score ≥ 0.9 + 30 orders + 0 strikes 90d + user-approved scope | 600 | all 32 tools |

## Iron rules (cannot be bypassed)

- Verifier voting → requires human + WebAuthn (when `require_human_presence_for_vote=1`)
- Arbitration → requires human + WebAuthn (when `require_human_presence_for_arbitrate=1`)
- Large withdrawals (≥ 1000 WAZ) → WebAuthn required
- KYC submission → human only
- Admin operations → root admin only

See [`AGENT-GOVERNANCE.md §4`](../../docs/AGENT-GOVERNANCE.md#4-铁律节点必须真实人工agent-不可代操作) for the full list.

## Strike system

3-strike state machine:
1. Warning + 24h rate limit halved
2. 7-day suspension of write operations
3. Permanent revocation (operator goes on watch list)

Appeal: `POST /api/me/agents/:apiKey/appeal` within 30 days.

## Standards compliance

- MCP protocol: see `/api/openapi.json`
- Schema versioning: SemVer with 90-day deprecation window
- All breaking changes announced via DAO `agent_policy` proposals (Phase B+)
