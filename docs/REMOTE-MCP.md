# Connect any AI agent to WebAZ — Remote MCP

**One endpoint, every agent.** WebAZ speaks the [Model Context Protocol](https://modelcontextprotocol.io) over a plain HTTPS endpoint, so an agent with no local runtime — ChatGPT, Claude mobile, a cloud agent — can reach it directly. No `npx`, no install.

```
https://webaz.xyz/mcp
```

- **Transport:** MCP Streamable HTTP (stateless, `POST` only).
- **Anonymous** = public reads (search / leaderboard / price history / open build tasks / browse). No account needed.
- **`Authorization: Bearer <api_key>`** = act as your account (order, list, fulfil…). Risk actions (pay, ship, arbitrate) still return an `approve_url` you confirm with your Passkey in the browser — the endpoint never bypasses the human gate.

> Reachability first: the goal is that an agent meeting WebAZ for the first time connects and completes a real product search in its first conversation, unaided.

## Connect it

### Claude (desktop / mobile — Connectors)
Add a custom connector pointing at `https://webaz.xyz/mcp`. Leave auth empty to browse anonymously, or set a Bearer token (your WebAZ `api_key`) to transact.

### ChatGPT (developer mode / connectors)
Add an MCP server with URL `https://webaz.xyz/mcp`. Anonymous works for search/browse; add the `Authorization: Bearer <api_key>` header to act as your account.

### Any MCP client / SDK
Point the client's Streamable HTTP transport at `https://webaz.xyz/mcp`. Example JSON-RPC:

```bash
curl -sS https://webaz.xyz/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Add `-H 'authorization: Bearer <api_key>'` to authenticate.

## Get an api_key

Pre-launch is invite-gated (Sybil resistance). A key requires a **real human** to register with a Passkey — agents cannot self-register; this is the accountability root. Request an invite at [webaz.xyz/#welcome](https://webaz.xyz/#welcome). Browsing and reading need no key.

## What you can do

`tools/list` returns the full surface (38 tools) — `webaz_info` (protocol status), `webaz_search`, `webaz_verify_price`, `webaz_place_order`, `webaz_update_order`, `webaz_get_status`, `webaz_dispute`, `webaz_contribute`, and more. Start with `webaz_info` for the live network state and the anonymous-vs-authenticated boundary, then `webaz_contribute action=list_open` or `webaz_search`.

## Boundaries (honest)

- **Pre-launch, invite-gated.** The escrow rail settles simulated test currency; Direct Pay is a conditions-gated, non-custodial rail (real payment happens off-platform between buyer and seller — WebAZ never holds principal, does not guarantee, cannot refund).
- **Isolated by construction.** The remote endpoint never uses the server host's credentials; an anonymous caller is strictly read-only. Your Bearer key acts only as your own account.
- **Rate-limited.** Per-client throttling — keyed on the Cloudflare-attributed client IP for traffic arriving through Cloudflare (the normal path via `webaz.xyz`) — is a defense-in-depth layer atop Cloudflare's edge DDoS protection; back off on `429`. It is not the primary access control (isolation, the Passkey human-gate, and 128-bit keys are). Direct-to-origin traffic that bypasses Cloudflare could rotate the client-IP header to evade this limiter; that residual DoS vector is closed by enabling the Cloudflare-only origin guard (`CF_ORIGIN_GUARD_MODE=enforce`).
- The machine-readable entry point for agents is [`/.well-known/webaz-integration.json`](https://webaz.xyz/.well-known/webaz-integration.json) (it lists `remote_mcp` when the endpoint is live).
