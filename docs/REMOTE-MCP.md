# Connect any AI agent to WebAZ — Remote MCP

**One endpoint, every agent.** WebAZ speaks the [Model Context Protocol](https://modelcontextprotocol.io) over a plain HTTPS endpoint, so an agent with no local runtime — ChatGPT, Claude mobile, a cloud agent — can reach it directly. No `npx`, no install.

```
https://webaz.xyz/mcp
```

- **Transport:** MCP Streamable HTTP (stateless, `POST` only).
- **Anonymous** = public reads (search / leaderboard / price history / open build tasks / browse). No account needed.
- **OAuth 2.1** (when live) = click **Connect** in a compliant MCP client — no key handling. You log in with your Passkey, approve SAFE scopes on a consent screen, and the client receives a short-lived, audience-bound access token. See [Connect via OAuth](#connect-via-oauth-21--no-pasted-key).
- **`Authorization: Bearer <api_key>`** = act as your account (order, list, fulfil…). Risk actions (pay, ship, arbitrate) still return an `approve_url` you confirm with your Passkey in the browser — the endpoint never bypasses the human gate. OAuth never removes this path; both stay valid.

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

## Connect via OAuth 2.1 — no pasted key

When the OAuth surface is live (`WEBAZ_OAUTH=1`), a compliant MCP client (Claude / ChatGPT / Cursor connectors) can connect without you ever handling an api_key:

1. **Discovery.** The client reads [`/.well-known/oauth-protected-resource/mcp`](https://webaz.xyz/.well-known/oauth-protected-resource/mcp) (RFC 9728) and [`/.well-known/oauth-authorization-server`](https://webaz.xyz/.well-known/oauth-authorization-server) (RFC 8414). Calling an account-bound tool without adequate authorization returns the auth challenge inline: an `HTTP 200` tool result with `isError: true` and `result._meta["mcp/www_authenticate"]` carrying an RFC 6750 `Bearer resource_metadata="…"` challenge (with `error` + `error_description`; mirrored to a `WWW-Authenticate` header for RFC 9728-aware clients). ChatGPT reads that `_meta` challenge to pop the **Connect via OAuth** UI, so a client self-starts the flow mid-session — no re-login for a scope step-up.
2. **Authorize.** Authorization Code + PKCE (`S256` only). You're redirected to webaz.xyz, log in with your **Passkey**, and see a consent screen naming the client, the exact SAFE scopes (`read`, `order:draft`, `list:draft`), and the resource (`https://webaz.xyz/mcp`).
3. **Token.** The client exchanges the code for a **short-lived, audience-bound, opaque** access token — a credential for the delegation grant your approval minted (revocable anytime from your account; no refresh tokens in v1, the client re-consents on expiry).

Boundaries (identical to every other path): OAuth tokens carry **SAFE scopes only** — read (public + your own catalog + minimal orders, no buyer PII), draft creation, and *submitting* accept/ship requests to your approval queue. Anything beyond that — executing an order action, publishing, paying, arbitrating, or any api_key-only operation — is **not performed by an OAuth token**; it needs your `api_key` or a per-action Passkey approval. No token ever bypasses the human gate. Anonymous browsing needs no OAuth and is unchanged.

## Get an api_key

Pre-launch is invite-gated (Sybil resistance). A key requires a **real human** to register with a Passkey — agents cannot self-register; this is the accountability root. Request an invite at [webaz.xyz/#welcome](https://webaz.xyz/#welcome). Browsing and reading need no key.

## What you can do

`tools/list` returns the full surface (38 tools) — `webaz_info` (protocol status), `webaz_search`, `webaz_verify_price`, `webaz_place_order`, `webaz_update_order`, `webaz_get_status`, `webaz_dispute`, `webaz_contribute`, and more. Start with `webaz_info` for the live network state and the anonymous-vs-authenticated boundary, then `webaz_contribute action=list_open` or `webaz_search`.

## Boundaries (honest)

- **Pre-launch, invite-gated.** The escrow rail settles simulated test currency; Direct Pay is a conditions-gated, non-custodial rail (real payment happens off-platform between buyer and seller — WebAZ never holds principal, does not guarantee, cannot refund).
- **Isolated by construction.** The remote endpoint never uses the server host's credentials; an anonymous caller is strictly read-only. Your Bearer key acts only as your own account.
- **Rate-limited.** Per-client throttling — keyed on the Cloudflare-attributed client IP for traffic arriving through Cloudflare (the normal path via `webaz.xyz`) — is a defense-in-depth layer atop Cloudflare's edge DDoS protection; back off on `429`. It is not the primary access control (isolation, the Passkey human-gate, and 128-bit keys are). Direct-to-origin traffic that bypasses Cloudflare could rotate the client-IP header to evade this limiter; that residual DoS vector is closed by enabling the Cloudflare-only origin guard (`CF_ORIGIN_GUARD_MODE=enforce`).
- The machine-readable entry point for agents is [`/.well-known/webaz-integration.json`](https://webaz.xyz/.well-known/webaz-integration.json) (it lists `remote_mcp` when the endpoint is live).

## Compatibility & the North Star (P1)

Two live harnesses measure whether a stranger agent can actually use WebAZ (run against the live endpoint):

- **`npm run agent:first-success`** — the North Star: fresh anonymous MCP client, canonical first task (connect → tools/list → natural-language search recovery → browse → act on a product), reports the **Agent First Task Success Rate**.
- **`npm run agent:compat-matrix`** — runs that same task through the distinct request shapes real clients use (MCP SDK = Claude Desktop/Code, Cursor; ChatGPT-connector init order; older/newer protocol-version negotiation; stateless no-initialize clients like OpenClaw/Hermes; bare JSON-RPC). All profiles must pass.

These verify the server-side compatibility surface (protocol-version negotiation, Accept handling, stateless call ordering) that determines whether each client can connect. Driving the hosted ChatGPT / Claude / Cursor UIs themselves is manual (steps above).
