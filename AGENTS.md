# AGENTS.md — guide for AI agents working on this repo / 给改这个仓库的 AI agent

You are most likely an AI coding agent (Claude Code, Cursor, etc.) reading this to **modify the repo and open a PR**. This file is your onboarding entry — read it first.

你大概率是一个 AI 编码 agent(Claude Code / Cursor 等),正在读这份文件以**改代码并提 PR**。这是你的第一站,先读这里。

> Two different things, don't confuse them / 两个不同场景,别混:
> - **Using the protocol** (an agent shopping/selling via the MCP) → call `webaz_info` first; it self-teaches the tools. You don't need this file.
> - **Developing the protocol** (changing this repo's code/docs) → **this file**.
>
> First-time / GitHub-first / agent-driven contributor? Also read [`docs/PUBLIC-CONTRIBUTOR-ENTRY.md`](docs/PUBLIC-CONTRIBUTOR-ENTRY.md) — agent = executor, a real human/org is the accountable party (DCO required); contribute first, claim later; everything `uncommitted`. 第一次 / GitHub 优先 / agent 驱动的贡献者另读 [`docs/PUBLIC-CONTRIBUTOR-ENTRY.md`](docs/PUBLIC-CONTRIBUTOR-ENTRY.md)。

---

## 1. Project map / 项目地图

TypeScript. Two runtimes share one codebase: the **MCP server** (`src/mcp.ts`, for AI agents) and the **PWA** (`src/pwa/`, for humans) — same backend, same rules.

代码分 8 层(`src/layerN-*/`),由底向上依赖:

| Layer | 它是什么 / What |
|---|---|
| `layer0-foundation` | 地基:DB schema(`L0-1-database`)、订单**状态机**(`L0-2-state-machine`)、manifest |
| `layer1-agent` | **agent 接口**:MCP server(`L1-1-mcp-server/server.ts` ← 最常改的文件)、身份 / 外部锚点 |
| `layer2-business` / `layer2-commerce` | 业务:通知、SNF、anchor registry 等 |
| `layer3-trust` | 信任:争议引擎(`L3-1-dispute-engine`) |
| `layer4-economics` | 经济:声誉(`L4-3-reputation`)、技能市场(`L4-4-skill-market`) |
| `layer5-decentralized` / `layer6-scale` | 去中心化治理 / 扩展(部分为后续阶段预留) |

Key entry files / 关键入口:
- `src/mcp.ts` — MCP server bootstrap;tools 实现都在 `src/layer1-agent/L1-1-mcp-server/server.ts`
- `src/pwa/server.ts` — PWA + HTTP API(human + agent 共用的生产端点)
- `src/cron-enforcement.ts` — 协议自动判责执行(超时 → 自动处置)
- `src/pwa/routes/` — HTTP 路由按主题拆分

> Don't scan the whole repo — start from the layer that owns your change, plus its `*-state-machine` / `routes` neighbors.

---

## 2. Before you change code / 改代码前

1. **Read and obey the engineering PR constraints**: [`docs/ENGINEERING-PR-CONSTRAINTS.md`](docs/ENGINEERING-PR-CONSTRAINTS.md). If the requested work conflicts with those constraints, stop before coding and ask for an explicit split or exception.
2. **Build must pass** before any PR: `npm install && npm run build`. (also `npm run pwa` / `npm run mcp` to run locally)
3. If your change touches **the protocol itself** (state machine / funds / governance / meta-rules / security), first align with the 3 canonical docs — see [CONTRIBUTING.md → Going deeper](CONTRIBUTING.md#深入贡献协议级改动--going-deeper-protocol-level-changes). Light changes (docs / i18n / small bugs) can skip that.
4. **Minimize the diff** — touch only task-relevant lines; no incidental "cleanup" or reordering.
5. **Bilingual UI strings**: every user-facing string needs both zh and an `_EN` counterpart. / 每条 UI 文案要 zh + en 双语。
6. **Schema rule**: `ALTER TABLE` must run *after* `CREATE TABLE` (fresh-DB silent-fail trap; CI `schema:verify` guards it).

### Claude Code hard stop rules / Claude Code 硬停规则

If you are Claude Code or another AI coding agent, do not continue coding when any
of these are true unless the user explicitly approves the exception:

- The PR mixes structure refactor, UI polish, schema/migration, behavior change,
  or money/order/status-path work.
- The change adds new feature logic to `src/pwa/server.ts`, `src/pwa/public/app.js`,
  or another very large file without explaining why it cannot live in a domain file.
- The change raises a complexity ratchet baseline just to make CI pass.
- The change touches payment, wallet, order status, settlement, fund, tokenomics,
  commission, escrow, or protocol-parameter paths inside an unrelated PR.
- A new `app-*.js` file is not loaded before `app.js`, not covered by
  `check:pwa-syntax`, or not browser-smoked on its moved routes.

Final PR responses from AI agents must include: PR type, touched money/order/status
path yes/no, touched UI behavior yes/no, touched schema/migration yes/no,
large-file LOC delta, ratchet delta, syntax/build/static tests updated, validation
run, and known risks.

---

## 3. PR flow / PR 流程

1. **Branch off `main`** (protected; no direct push) → open PR to `main`.
2. **Sign every commit with DCO**: `git commit -s` (appends `Signed-off-by`). CI rejects unsigned commits. Do **not** use GitHub's web "Update branch" button — its merge commit has no sign-off; rebase/merge locally with `--signoff` instead.
3. **One topic per PR**, smallest reviewable unit. PR body: **what / why / how to verify**.
4. **All CI checks must pass**: typecheck(build) · schema-verify · DCO · license invariants · meta-rule invariants.
5. Approval tier depends on change type — see [CONTRIBUTING.md → Review tiers](CONTRIBUTING.md#审批分档--review-tiers) / [CHARTER §3.2](docs/CHARTER.md#32-决策权与多签矩阵--decision-authority--multisig-matrix).

---

## 4. AI accountability (important) / AI 责任制

WebAZ is agent-native, so agent-authored PRs are welcome — **with accountability**:

- The AI agent must be **triggered by a Passkey-bound human (a "webazer")**, who is the responsible party. / 提 PR 的 AI 必须由已绑 Passkey 的真人(webazer)触发,该真人担责。
- **Add `🤖🤖🤖` at the end of the PR title**, and state in the body **which webazer operated which agent**.
  - Example: `🤖🤖🤖 feat(mcp): … (submitted by @alice via Claude Code)`
- AI errors → the triggering webazer is accountable (reputation deduction / escalation). Repeated abuse → that webazer's future AI-submission rights may be restricted.

Full rules: [CONTRIBUTING.md → AI Agent Contributors](CONTRIBUTING.md#ai-agent-贡献者--ai-agent-contributors). This mirrors the protocol's own `AGENT_SCOPE_UNDECLARED` accountability — agents act, humans are responsible.

---

## 5. File-header convention / 文件头注约定

When creating or substantially editing a core file, add a top comment block: **what it does / inputs-outputs / related meta-rules + spec section**. Model to copy: `src/pwa/data/onboarding-quiz.ts`.

---

## Before every push (hard rule)
Run `npm run preflight:push` (executes ALL cross-cutting gates: api-docs freshness, contract lock, schema + 4-layer PG parity, ratchets, seam, pwa-syntax, tsc). Then consult the change-type → registration-points matrix in `.claude/skills/webaz-invariants/SKILL.md` — every change here touches 5-8 registration points; green guards ≠ all points registered.

## See also
- [README.md](README.md) — what WebAZ is + architecture overview
- [CONTRIBUTING.md](CONTRIBUTING.md) — full contributor guide (this file is the AI-agent quick entry into it)
- [docs/CHARTER.md](docs/CHARTER.md) · [docs/META-RULES-FULL.md](docs/META-RULES-FULL.md) · [docs/meta-rules.yaml](docs/meta-rules.yaml)
