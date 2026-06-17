# WebAZ Terms of Service / WebAZ 服务条款

> **Status**: pre-launch draft. Will become binding when (a) you register an account, AND (b) the operator formally opens WebAZ to real users at W8 launch. Pre-launch test accounts: this ToS still applies in spirit but operator reserves right to refine at launch.
>
> **Last updated**: 2026-06-03 (task #1084)
> **Companion docs**: `docs/LEGAL-DISCLOSURES.md` (operator's good-faith legal interpretation) + `docs/CHARTER.md` (project constitution)

---

## §1 Acceptance / 接受条款

By registering an account or using WebAZ services after the W8 launch date, you agree to these Terms. If you do not agree, do not use the service.

Material changes to these Terms follow `docs/CHARTER.md §6` (RFC + public notice). Continued use after notice period = acceptance of revised Terms.

---

## §2 Nature of WebAZ / WebAZ 的性质

WebAZ is an **agent-native decentralized commerce protocol** operating under Business Source License 1.1 (auto-converting to MIT on 2030-05-18). It is:
- **Software protocol**, not a financial institution / bank / broker
- **Source-available**, not closed-source
- **Operator-administered in phase A**, transitioning to community-administered governance (phase D DAO) per `CHARTER §3.3`
- **Pre-launch / W8 launch**: small-scale, evolving rapidly, operator-discretion-heavy

You acknowledge WebAZ is **NOT**:
- A regulated financial service
- A licensed legal service / law firm / court substitute
- A registered MLM / direct-selling company (see §6)
- A government entity or quasi-judicial body

---

## §3 Account responsibility / 账户责任

- You are responsible for the credentials of your account, including your WebAuthn Passkey
- Iron-Rule operations (see `../SECURITY.md`) require a real human Passkey signature; if an AI agent operates under your account, **you are the custodian** and bear full responsibility for agent actions
- If you delegate operations to an AI agent (OpenAI Operator, Anthropic Claude, etc.), that delegation does not transfer liability away from you

---

## §4 Dispute resolution: private ADR / 争议解决:私人 ADR

By placing an order on WebAZ, both buyer and seller **explicitly consent** to the following:

1. **Initial dispute resolution** between order parties is handled via WebAZ's built-in dispute mechanism (see `docs/ARBITRATION-PLAYBOOK.md`)
2. The dispute mechanism is **private contractually-agreed alternative dispute resolution (ADR)** — **NOT** a substitute for court litigation
3. Arbitrators are **protocol-onboarded community members**, NOT licensed legal practitioners; their decisions are NOT held out as judicial determinations
4. Decisions bind parties to the protocol's **escrow / refund / reputation** outcomes only; they do not determine criminal liability or statutory rights outside the protocol
5. Either party may, after exhausting the protocol's appeal mechanism, **still seek court remedy** for matters outside the protocol's scope

You waive the right to claim that WebAZ's dispute mechanism alone is a substitute for judicial process. Your courthouse rights remain.

**Jurisdiction notice**: in some jurisdictions, the operator restricts who may serve as an arbitrator and what dispute amounts the mechanism handles. See `docs/LEGAL-DISCLOSURES.md §6` for the geo-restriction matrix.

---

## §5 Commission, referral, PV / 三级奖励、推荐、PV

### What we offer

WebAZ has a multi-tier commission mechanism (L1 70% / L2 20% / L3 10%) attached to actual product sales, capped per-jurisdiction by `region_config.max_levels`. The mechanism is **opt-in** (per RFC-002, in implementation): users must explicitly activate to participate.

### What this is NOT

You acknowledge and agree that the commission mechanism:
- **Is NOT a multi-level marketing scheme.** No joining fees ever; no income from headcount; no static / unearned income (see `docs/PARTICIPATION-ATTRIBUTION-COMPLIANCE.md`)
- **Is NOT a get-rich-quick scheme** or investment vehicle
- **Has NO guaranteed returns.** All commission depends on real third-party purchase events
- **Is NOT a "recruiting" or "team building" system.** WebAZ enforces de-MLM linguistic discipline at PR-review level (see `docs/PARTICIPATION-ATTRIBUTION-COMPLIANCE.md` for structural analysis)

### Region restrictions

- Some jurisdictions have **`max_levels = 0`**: commission mechanism is fully disabled in those jurisdictions; commission flow routes to public-good fund instead
- Some jurisdictions have **`max_levels = 1`**: only direct L1 sharing is permitted
- See `docs/LEGAL-DISCLOSURES.md §6` for the current jurisdiction matrix

If you are in a `max_levels = 0` jurisdiction, you may still use WebAZ as a buyer / seller — only the commission feature is restricted.

### Your responsibility

You must accurately declare your jurisdiction at registration. Circumventing geo-restrictions (VPN, false declaration) is a **breach of these Terms** and may result in account suspension + forfeit of any accrued commission balance.

---

## §6 No MLM warranty / 反 MLM 承诺

WebAZ operator warrants the following as of the date of these Terms, code-enforced where possible:

| Warranty | Enforced by |
|---|---|
| **No joining fees ever** | Code: there is no fee-collection endpoint for membership |
| **No income from recruitment** | Code: `settleCommission()` triggers only on real product order, never on user signup |
| **No static / passive income** | Code: no "monthly reward" / "system distribution" / "team bonus" mechanism exists |
| **No team / downline commission** | Code: L1 earns only from L1's direct referrals' purchases, not from L2 / L3 cascades |
| **Per-jurisdiction caps** | Code: `region_config.max_levels` checked at runtime, slashing excess |

This warranty does NOT extend to the determination of whether WebAZ qualifies as an MLM under any specific local statute. That is a question of statutory interpretation in your jurisdiction.

---

## §7 Privacy / 隐私

WebAZ follows the principles set out in `docs/CHARTER.md §2 #3 (No data theft)`. In particular:
- **No PII sale or sharing** with third parties for marketing
- **No GMV / wallet balance / individual identity** displayed in public leaderboards
- **Region group** only (`APAC` / `EMEA` / etc.) — not country-level — for any public leaderboard
- **PII redaction** in published case studies (`dispute_cases` table)
- Some operational metadata (IP hash, UA hash, order audit trail) is retained for fraud prevention + audit; retention period is documented in `protocol_params`

Users in jurisdictions with formal data-protection regimes (GDPR, CCPA, etc.) have additional rights set by those regimes; WebAZ implements those where applicable.

---

## §8 Agent operator responsibility / Agent 运营者责任

If you operate one or more AI agents under your account:

1. You are the **custodian** of any agent you configure
2. Agent's actions are imputed to your account for protocol purposes
3. WebAZ has Iron-Rule operations (see `../SECURITY.md`) that **cannot** be performed by an agent on your behalf — these always require human Passkey
4. If your agent triggers a dispute, you (not the agent) are responsible for resolving it through WebAZ's mechanism

WebAZ tracks per-agent risk metrics (see `docs/AGENT-GOVERNANCE.md`). Sustained high-risk behavior may result in agent revocation.

---

## §9 Termination / 终止

The operator may suspend or terminate your account if:
- You materially breach these Terms (e.g., circumventing geo-restrictions, attempting fraud)
- You violate a meta-rule (`META-RULES-FULL.md`) in a manner that affects others
- Required by applicable law or court order in any relevant jurisdiction

You may terminate your participation at any time by ceasing to use WebAZ and (where applicable) withdrawing your balances per protocol mechanism.

**Forfeit of pending commission**: pending commission attributable to a closed account at the time of breach-based termination is routed to the public-good fund (`charity_fund`) per protocol design.

---

## §10 Disclaimer of warranties / 免责声明

WebAZ IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION:
- Merchantability
- Fitness for a particular purpose
- Title
- Non-infringement

THE OPERATOR DOES NOT WARRANT THAT:
- WebAZ will meet your specific requirements
- WebAZ will be uninterrupted, timely, secure, or error-free
- Results obtained from using WebAZ will be accurate or reliable

---

## §11 Limitation of liability / 责任限制

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE OPERATOR (INCLUDING MAINTAINERS, CONTRIBUTORS, AND ANY ASSOCIATED ENTITIES) SHALL NOT BE LIABLE FOR:
- INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES
- LOSS OF PROFITS, REVENUE, DATA, GOODWILL, OR OTHER INTANGIBLE LOSSES
- DAMAGES RESULTING FROM YOUR USE OR INABILITY TO USE WebAZ
- DAMAGES RESULTING FROM UNAUTHORIZED ACCESS TO YOUR DATA OR CREDENTIALS

The operator's aggregate liability to you for any claim arising from or related to these Terms shall not exceed the greater of (a) the amount you have paid to the operator (excluding peer-to-peer transactions on WebAZ) in the 12 months preceding the claim, or (b) USD 100.

This limitation is essential to the operator's willingness to provide WebAZ at all, given the pre-launch / phase A state.

---

## §12 Governing law and venue / 适用法律 + 司法管辖

These Terms are interpreted under the law of the operator's domicile, **without** giving effect to its conflict-of-law principles.

For disputes between you and the operator NOT covered by WebAZ's internal dispute mechanism (e.g., breach of these Terms, billing disputes with the platform itself):
- You agree to first attempt resolution by informal negotiation via `<contact@webaz.xyz>` within 30 days
- If unresolved, disputes shall be resolved in the courts of the operator's domicile, unless a different forum is mandatory under applicable consumer protection law in your jurisdiction

This venue clause does not waive any non-waivable rights you have under your home jurisdiction's consumer protection law.

---

## §13 Modifications / 修改

The operator may modify these Terms at any time. Material modifications:
- Are subject to `docs/CHARTER §6` RFC procedure
- Will be announced via on-platform notice and the project's public communication channels
- Take effect after the public-notice period set forth in `CHARTER §3.1` (typically 14 days; 60 days for constitutional-level changes)

You are responsible for reviewing posted notices. Continued use after the notice period = acceptance.

---

## §14 Contact / 联系

- Email: `contact@webaz.xyz`
- GitHub: `https://github.com/webaz-protocol/webaz`
- Public-good fund inquiries: `<charity@webaz.xyz>` (forwarded via Cloudflare Email Routing)

---

## §15 Severability / 可分离性

If any provision of these Terms is held invalid or unenforceable in any jurisdiction, the remaining provisions remain in effect. The operator may unilaterally substitute a valid provision that achieves the original intent as closely as permitted.

---

**By using WebAZ after W8 launch, you confirm you have read and understood these Terms.**

**使用 WebAZ(W8 launch 之后)即代表你已阅读并理解本服务条款。**
