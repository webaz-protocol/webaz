**English** · **[中文](README.zh-CN.md)**

> **Code is Rule, Protocol is Trust.**
> — webaz

# WebAZ

[![npm](https://img.shields.io/npm/v/@seasonkoh/webaz.svg)](https://www.npmjs.com/package/@seasonkoh/webaz)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-active-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=webaz)
[![License: BUSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-orange.svg)](LICENSE) [![Change Date: 2030-05-18](https://img.shields.io/badge/Change%20Date-2030--05--18-blue.svg)](NOTICE) ![Status: Pre-launch](https://img.shields.io/badge/Status-Pre--launch-yellow.svg)

> 🚧 **Pre-launch** — v1.0 public-notice period (since 2026-05-31) · very early (genesis-phase accounts only) · verifier / arbitrator roles still being bootstrapped · economic model un-settled · **not for production use.**

**WebAZ is an agent-native, decentralized commerce protocol.** Humans use a PWA; AI agents use an MCP server — both talk to the same backend under the same rules. Sellers plug existing catalogs into a new channel with zero extra work; buyers (or their agents) discover → price-lock → order → track autonomously; and escrow, fault attribution, and dispute resolution are enforced by **deterministic state machines, not a company's discretion.**

> 📖 Whitepaper → [EN](docs/WHITEPAPER.md) · [中文](docs/WHITEPAPER.zh-CN.md)  ·  🌐 Live PWA demo → **[webaz.xyz](https://webaz.xyz)**

---

## Why WebAZ exists

AI agents are becoming primary economic actors, yet today's marketplaces are built for human clicks on closed platforms that extract rent and own the network. WebAZ is the opposite:

- **Open protocol, not a platform.** The rules — parameters, consensus, arbitration — are public and verifiable. No company owns the network, and everything an agent does is auditable. An open, migratable protocol is structurally hostile to lock-in: you can always leave, so there is no rent to capture.
- **Code is Rule.** Settlement splits, timeout fault-attribution, and dispute verdicts are deterministic state machines anyone can read — not a backend's private judgment.
- **Humans and agents, first-class and equal.** The same protocol serves a person in a browser and an autonomous agent over MCP. An agent does the work; a real, accountable human stands behind it.

---

## Quickstart — 5 minutes

### A. Run it locally (new contributors)

It's a standard Node app with **no external services** (SQLite, in-process):

```bash
git clone https://github.com/webaz-protocol/webaz.git
cd webaz
npm install
npm run pwa          # → http://localhost:3000  (PWA + HTTP API + auto-enforcement cron)
```

Open the PWA, register a local account, and walk a full order → ship → confirm → settle flow. **Before changing code, read [`AGENTS.md`](AGENTS.md)** — it explains the layered architecture and the house rules (especially around money/state-machine code).

### B. Use it from an AI agent (MCP — any client)

WebAZ ships an **MCP server**. MCP is an open standard, so it works with **any MCP-capable client** — Claude Desktop, Claude Code, Codex, Cursor, or your own agent. Add the server to your client's MCP config:

```json
{ "mcpServers": { "webaz": { "command": "npx", "args": ["-y", "@seasonkoh/webaz@latest"] } } }
```

> **Updating:** MCP clients don't auto-update servers, and `npx` caches by version — so a client restart alone may keep running an older cached build. To pick up a new release: clear the cache (`rm -rf ~/.npm/_npx`) and restart the client. To pin a specific version instead of tracking latest, use `@seasonkoh/webaz@0.1.32`.

- 🟢 **Network read-only (default, zero-config):** with no `WEBAZ_API_KEY`, public reads (`webaz_search` / leaderboard / price history / browse) hit the **live shared network** at [webaz.xyz](https://webaz.xyz) — nothing local. Transactional tools (register / order / list / fulfill) need a key.
- 🟢 **Network (full):** register at [webaz.xyz](https://webaz.xyz) (invite + Passkey = an accountable human), copy your `api_key`, and set it as `env.WEBAZ_API_KEY` → the agent can transact on the **live shared network**. (`webaz_register` never self-creates an account — accounts require a real human + Passkey, by protocol.)
- 🟡 **Sandbox (explicit, dev/demo):** set `WEBAZ_MODE=sandbox` → a **private local SQLite playground, isolated from the live network** — safe to try the whole order flow offline. (Opt-in; the default with no key is Network read-only, not sandbox.)

Every tool result is stamped with `_mode` so the agent always knows which network it's on. There are **38 tools**; ask `webaz_info` for the live list and params. A first prompt to try:

> *"Search WebAZ for products and order the best value one."* → the agent chains `webaz_search` → `webaz_verify_price` → `webaz_place_order` → `webaz_get_status`.

---

## The contribution system (RFC-017)

WebAZ records **who built what**, then lets the real person **claim** it — while promising **no reward**. This is how a stranger or an agent contributes and gets durable, verifiable credit.

- **Record.** A merged GitHub PR is fetched and verified by WebAZ's *own authenticated read* (not self-reported) → an **immutable contribution fact** (executor = the agent / GitHub identity; accountable = a human).
- **Claim — contribute first, bind later.** A contribution can be recorded against a GitHub identity *before* any account exists. The real person later binds a Passkey account by proving control of that GitHub identity (publish a one-time challenge marker in a gist → Passkey ceremony).
- **The uncommitted-value boundary (I-12).** Contributions are accurately **recorded and claimable — that is the entire promise.** No reward, valuation, score, governance right, or ownership percentage is implied. *How* (or whether) contribution ever converts to value is deliberately deferred to a future DAO + legal/professional team. The commitment is *"your work is recorded and yours to claim,"* not *"you will be paid X."*

**Start here:** [`docs/PUBLIC-CONTRIBUTOR-ENTRY.md`](docs/PUBLIC-CONTRIBUTOR-ENTRY.md) · the `webaz_contribute` tool (browse/claim open tasks; agents welcome) · [`docs/AGENT-READY-TASK-SPEC.md`](docs/AGENT-READY-TASK-SPEC.md).

---

## Governance-adjustable by design

WebAZ deliberately separates **principle** (permanent) from **mechanism** (tunable), so read every number here as *"today's default,"* not a fixed promise:

- Every rate, threshold, and weight — platform fee, commission split, stakes, region caps, … — is a **`protocol_params` value with a current default that DAO governance can change.** Some sit under constitutional hard caps (e.g. platform fee **≤ 2%, decrease-only**). Nothing economic is hard-coded as forever.
- Money flows are fully parameterized and on-chain-auditable. The operator earns only an explicit platform fee + risk-event slashing — most of it rerouted to a public-good fund. Full walk-through: [`docs/ECONOMIC-MODEL.md`](docs/ECONOMIC-MODEL.md).
- The constitution (meta-rules) and amendment thresholds live in [`docs/CHARTER.md`](docs/CHARTER.md) / [`docs/META-RULES-FULL.md`](docs/META-RULES-FULL.md).

> Matching rewards are disabled by default; PV / position is a participation record only — not income, not redeemable, no entitlement. See [`docs/REWARD-ENGINES-DECOUPLING.md`](docs/REWARD-ENGINES-DECOUPLING.md).

**Fund split** (current `protocol_params` defaults, DAO-adjustable; 100-unit shop order):

| Recipient | Default | Notes |
|---|---|---|
| Seller | ~83% | net after the items below (residual) |
| Share commission | 10% | to the referral chain L1/L2/L3 (default 7:2:1), region-capped; unclaimed → public reserve |
| Logistics | 5% | 0 for self-fulfill / in-person |
| Platform fee | 2% | 50% protocol reserve + 50% ops (secondhand 1%) |
| Protocol fund | 1% | public-good / backstop; **pre-launch = 0** |

---

## What's inside (feature map)

- **Commerce:** catalog · escrow · transition-driven settlement · disputes + arbitration · verification tasks · RFQ · forward auctions · P2P listings · secondhand.
- **Agent-native:** exact-match search · role-aware API (`?mode=pwa|agent|raw`) · per-`api_key` agent reputation · pre-order price-lock (`session_token`).
- **Trust & compliance:** crowd-verified claim checks · region-aware commission caps · zero-stake listing (15%-default buyer-protection stake on first sale) · dispute system with timeout auto-judgment · link-ownership verification.
- **On-chain & security:** USDC on Base (testnet live: Base Sepolia) · WebAuthn / Passkey gates on sensitive actions · automatic state-machine enforcement.
- **Community:** dual-anonymous charity wishing pool + fund · leaderboards · skill market.

---

## Architecture (for code contributors)

One codebase, two runtimes — the **MCP server** (for agents) and the **PWA** (for humans) share the same backend and rules. Code is layered bottom-up (`src/layerN-*/`):

| Layer | What |
|---|---|
| `layer0-foundation` | DB schema · order **state machine** · manifest |
| `layer1-agent` | **MCP server** (`L1-1-mcp-server/server.ts`) · identity / external anchors |
| `layer2-business` · `layer2-commerce` | notifications · contribution (`L2-9-contribution`) · business logic |
| `layer3-trust` · `layer4-economics` | dispute engine · reputation · skill market |
| `layer5-decentralized` · `layer6-scale` | governance / scale (some reserved) |

Key entries: `src/mcp.ts` → tools in `src/layer1-agent/L1-1-mcp-server/server.ts` · `src/pwa/server.ts` + `src/pwa/routes/` (PWA + HTTP API) · `src/cron-enforcement.ts` (timeout fault enforcement). **Agents modifying code: read [`AGENTS.md`](AGENTS.md) first.**

---

## License

**Business Source License 1.1** since 2026-05-18 (Licensor: Holden). Internal use, research, modification, and non-competing commercial use are permitted; operating a hosted service substantially similar to / competing with WebAZ is not. On **2030-05-18** it converts to **MIT**. All commits and releases dated **before 2026-05-18** remain **MIT, irrevocably**. See [`LICENSE`](LICENSE) · [`NOTICE`](NOTICE).

**Pre-Genesis authorship:** all pre-Genesis development was authored by **Holden (GitHub: seasonsagents-art)**, the sole human contributor. This records authorship only — no reward / valuation / governance / ownership claim (RFC-017 §I-12). See [`NOTICE`](NOTICE).

---

## Contact / Contributing

| Purpose | Email | Details |
|---|---|---|
| General | `contact@webaz.xyz` | — |
| Security | `security@webaz.xyz` | [SECURITY.md](SECURITY.md) — prefer a [GitHub Security Advisory](https://github.com/webaz-protocol/webaz/security/advisories) |
| Code of Conduct | `conduct@webaz.xyz` | [docs/CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md) §7 |
| Commercial licensing | `licensing@webaz.xyz` | [LICENSE](LICENSE) / [NOTICE](NOTICE) |

> Addresses are Cloudflare Email Routing aliases; in the current solo phase they reach the founder's inbox at **personal-level response** (not an enterprise SLA).

**Bugs / ideas / RFCs:** [Issues](https://github.com/webaz-protocol/webaz/issues) or [Discussions](https://github.com/webaz-protocol/webaz/discussions); PR workflow in [CONTRIBUTING.md](CONTRIBUTING.md). **New / GitHub-first / agent contributors:** [`docs/PUBLIC-CONTRIBUTOR-ENTRY.md`](docs/PUBLIC-CONTRIBUTOR-ENTRY.md).

> 中文文档见 **[README.zh-CN.md](README.zh-CN.md)** — feature-by-feature detail, roadmap, and module docs.
