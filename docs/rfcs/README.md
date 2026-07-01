# WebAZ RFCs / 请求评论 (Request for Comments)

本目录存放 WebAZ 协议的 RFC 文档 — 重大设计提案、新机制、跨模块改动、元规则修订。
This directory hosts WebAZ protocol RFCs — major design proposals, new mechanisms, cross-module changes, meta-rule revisions.

## 何时需要 RFC / When you need an RFC

- 修订 **10 元规则之一**(#1-#10,见 [`../META-RULES-FULL.md`](../META-RULES-FULL.md))→ 必走 RFC + 60d 公示 + 多签(CHARTER §6)
- 修改 **协议参数**(费率 / 超时 / 阈值 / 奖励曲线)→ RFC + 14d 公示
- 引入 **新协议模块**(新 engine / 新仲裁路径 / 新经济流)
- 跨模块的 **架构调整**
- **应急安全修订** → 24h fast-track,founder + 2 maintainer(CHARTER §3.2)

## 不需要 RFC / Skip RFC when

- bug 修复 → 用 `.github/ISSUE_TEMPLATE/bug.yml`
- 小功能改进 → 用 `.github/ISSUE_TEMPLATE/feature.yml`
- 文档措辞 → 直接 PR

## 命名 / Naming

```
RFC-NNN-short-slug.md
```

- `NNN` = 3 位数零填充的递增序号(`RFC-001-...`, `RFC-002-...`)
- `short-slug` = kebab-case 概括,< 50 字符
- 例:`RFC-001-license-decision.md` / `RFC-002-fee-rate-reform.md`

## Lifecycle / 生命周期

| Stage | 含义 | 文件 status 字段 |
|---|---|---|
| **draft** | 起草中,征求 contributors 早期反馈 | `Status: draft` |
| **review** | 进入正式公示期(14d / 60d / 24h)| `Status: review` |
| **accepted** | 多签通过,准备实现 | `Status: accepted` |
| **ratified** | **追溯式批准** — 决策已实施,RFC 事后正式化;**仅 phase A 适用**(无第二签名方时的豁免;phase B+ 起禁用)| `Status: ratified (retroactive — phase A)` |
| **rejected** | 被驳回(理由必须记录)| `Status: rejected` |
| **deferred** | 暂缓(default +30d,90d 自动归档)| `Status: deferred (until YYYY-MM-DD)` |
| **implemented** | 已 merge 实现,标 commit SHA | `Status: implemented (sha: XXXXXXX)` |

参考 [`CONTRIBUTING.md`](../../CONTRIBUTING.md) RFC Process 段。

## 流程入口 / Entry points

1. **开 issue**:用 [`.github/ISSUE_TEMPLATE/rfc.yml`](../../.github/ISSUE_TEMPLATE/rfc.yml) 创建 RFC issue(自动标 `type:rfc` + `rfc:draft`)
2. **在本目录建文件**:`RFC-NNN-...md`,引用 issue 编号
3. **走公示 + 多签**(CHARTER §3.2 / §6 矩阵决定档位)
4. **merge 时**:更新 status 到 implemented,关闭 issue

## Template

新 RFC 复制 [`RFC-template.md`](RFC-template.md) 起草。

## Current RFCs

| RFC | Title | Status | Track |
|---|---|---|---|
| [RFC-001](RFC-001-license-decision.md) | License Decision — BSL 1.1 with 2030-05-18 → MIT Auto-Transition | ratified (retroactive — phase A) | meta-rule (constitutional) |
| [RFC-002](RFC-002-rewards-opt-in.md) | Rewards Opt-in — co-build identity (application-based) | live | normal |
| [RFC-003](RFC-003-mcp-network-client.md) | MCP Network Client — thin client, three modes (network_readonly default / network / sandbox) | implemented | normal |
| [RFC-004](RFC-004-build-feedback.md) | Build Feedback — agent-native use↔build distance to zero | implemented | normal |
| [RFC-005](RFC-005-ai-triage-pipeline.md) | AI Triage Pipeline — dual-AI advisory (PR + feedback), never merges | implemented | normal |
| [RFC-006](RFC-006-contribution-layer.md) | Contribution Layer — trade-side trust primitives applied to building | implemented | normal |
| [RFC-007](RFC-007-seller-nonacceptance-fault.md) | Seller non-acceptance — fault differentiation, forfeit distribution & objective-decline arbitration | implemented | normal |
| [RFC-008](RFC-008-merchant-cost-collateral.md) | Merchant cost & collateral — fees (capped), stake (rep-tiered), fault penalty (decoupled) | draft | normal |
| [RFC-009](RFC-009-noncode-pr-proxy.md) | Non-code PR-proxy — non-technical contributors ship without GitHub (inbox-scope) | draft (impl. gated on repo-public) | normal |
| [RFC-010](RFC-010-fee-cap-constitutional.md) | Fee Cap as Constitutional Invariant — CHARTER §4 I-7 (≤2%/≤1%/≤3%, ratchet-down-only) | draft (proposal — awaiting ratification) | meta-rule (constitutional) |
| [RFC-011](RFC-011-agent-native-integration-contract.md) | Agent-Native Integration Contract — 8 dimensions along the integrator journey (capability matrix + event stream + verifiability + …) | draft (8 dims shipped & live) | normal |
| [RFC-012](RFC-012-external-risk-underwriter.md) | External Risk Underwriter — collateralized order cover as a value-participant (RFC-011 §⑧; NOT licensed insurance) | draft (design-only, gated on real demand) | normal-but-sensitive |
| [RFC-013](RFC-013-arbitrator-compensation-independence.md) | Arbitrator compensation without compromising independence — pay ⊥ ruling (fix "rule against who can pay") + reputation = capped priority not income | draft (design-only, gated on real arbitrator economy) | normal-but-sensitive |
| [RFC-014](RFC-014-money-representation-precision.md) | Money representation & precision — float ledger → integer base-units (money.ts/ledger.ts/settlement-math.ts; allocate + absolute writes) | in progress (P2 port DONE — zero dust all paths; P3 storage flip gated) | normal-but-sensitive |
| [RFC-015](RFC-015-acp-compatibility-escrow-preserving.md) | ACP compatibility — ACP/ChatGPT agents discover + check out + pay, settlement routed into WebAZ escrow (PSP-agnostic; iron-rule/conservation preserved) | draft (design; spec-feasible; fiat leg gated on RFC-014 + PSP + real-money phase) | normal-but-sensitive |
| [RFC-017](RFC-017-contribution-protocol-v1.md) | Contribution Protocol v1 — facts/identity/claim/metering + uncommitted-value boundary; 16 proposed invariants; fact·valuation·redemption separation (principle-only, no formula/schema) | draft | meta-rule (60d) |
| [RFC-018](RFC-018-settlement-clearing-period.md) | Settlement Clearing Period — accrue commission/score in real time, pay only after the order is fully closed (accrue-then-mature; pending→settled/reversed via `pending_commission_escrow`+`matures_at`; gate at settlement not calculation; no clawback). Decision #2 resolved: returns flow is the post-completion reversal → window load-bearing | deferred (parked — refine later vs mature e-commerce return/clearing practices) | normal-but-sensitive |
| [RFC-019](RFC-019-github-oauth-identity-linking.md) | GitHub OAuth Identity Linking — one-redirect "Connect GitHub" ownership proof; Passkey still gates the bind; Gist marker kept as fallback; two independent proofs (ownership + human presence) unchanged | draft | normal |
| [RFC-020](RFC-020-agent-delegation-grants.md) | Agent Authorization — Passkey-approved **constrained delegation grants** (capability + server-enforced constraints, not a permanent key); never-delegable iron-rule set (server hard-reject); secret-store credential handle (not env / not chat, redacted); PoP/keypair binding as target; server-generated consent; per-request audit. Deprecates raw permanent `api_key` for the **agent** path (kept for direct human/server use) | draft | normal-but-sensitive (auth) |
| [RFC-020 · Impl Plan](RFC-020-implementation-plan.md) | Companion to RFC-020 (not a competing model) — stranger-agent onboarding & delegated auth: J1 member+agent vs J2 stranger+agent (stranger-join is guide-only, no agent creates a live account); capability taxonomy mapped to current endpoints (keyless / safe / risk / never-delegable); resolved decisions (new `agent_delegation_grants` table; bearer-first for safe scopes only, PoP before risk; `human_confirm` reuses the human-presence gate); PR slicing A–E | draft | normal-but-sensitive (auth) |


## References

- [`docs/CHARTER.md §6`](../CHARTER.md) — 修改宪章流程 / Charter self-modification
- [`docs/CHARTER.md §3.2`](../CHARTER.md) — 多签矩阵 / Multisig matrix
- [`docs/META-RULES-FULL.md`](../META-RULES-FULL.md) — 10 元规则 / 10 meta-rules
- [`.github/ISSUE_TEMPLATE/rfc.yml`](../../.github/ISSUE_TEMPLATE/rfc.yml) — RFC issue 模板
