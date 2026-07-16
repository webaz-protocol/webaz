# Legal Disclosures / 法律披露

> **Status**: WebAZ is publicly launched with Direct Pay as its current real-payment rail; the escrow rail remains simulated. No formal outside legal opinion has been obtained. This document is the **operator's own best-effort interpretation** of how WebAZ relates to applicable rules across major jurisdictions. It is **NOT legal advice** for users, contributors, or anyone reading it.
>
> **状态**:WebAZ 已公开发布,Direct Pay 是当前真实支付轨,托管轨仍为模拟测试流程。尚未获取正式律所书面意见。本文档是**项目运营者基于自有理解的尽量谨慎披露**,不构成对用户 / 贡献者 / 任何读者的**法律意见**。
>
> Operator reserves the right to obtain formal legal counsel later (see §7); this document will be revised in light of any such opinion.

**Last updated**: 2026-07-16
**Spec context**: 6 legal questions identified by the operator; paid consultation deferred, not abandoned (the detailed brief is kept privately)

---

## §0 Why this document exists / 为什么有这份文档

The 6 legal questions the operator identified cluster into two risk profiles:

| Risk | Questions | Current operator approach |
|---|---|---|
| 🟢 Mostly civil interpretation | Q1 BSL fork, Q2 Change Date, Q3 contributor disclaimer, Q6 AI agent personhood | Document conservatively + ship |
| 🟠 Criminal / regulatory enforcement floor exists | Q4 cross-jurisdiction arbitration UPL, Q5 MLM laws | Document conservatively + geo-restrict + opt-in only + early consult on first incident |

The operator chose to **defer paid legal consultation** (estimated $2-5k) until:
- Real user count > 100, **OR**
- Cumulative transaction value > $10k USD equivalent, **OR**
- First incident in a high-enforcement jurisdiction, **OR**
- Phase D DAO governance launch (mass arbitration goes live)

Until then, this document is the public-facing operator's good-faith map.

The 6 prepared questions are **kept** privately, not abandoned — they become the brief for the eventual lawyer engagement.

---

## §1 BSL 1.1 License: scope, sovereignty, evolution / BSL 1.1 许可:范围、主权、演化

(Covers `BRIEF.md` Q1 + Q2)

### Operator's interpretation

WebAZ is licensed under **Business Source License 1.1**, auto-converting to MIT on **2030-05-18** (hardcoded in `LICENSE`, locked as `CHARTER.md §4 I-2` invariant).

**Concerning forks** (Q1):
- The Additional Use Grant ("non-competing use permitted") is the operator's **best-effort** scope statement.
- Operator does NOT make affirmative claims about cross-jurisdiction enforceability of the non-compete grant. Reading literally, BSL is a license, not a treaty; enforcement is per-jurisdiction.
- For nested forks / rewritten claims of non-derivative work / cross-jurisdiction infringement: operator does NOT commit to pursuing or NOT pursuing any specific remedy. Any future enforcement would be a separate operator decision.
- Operator's **intent** is forks for genuinely non-competing uses (research, internal tools, downstream integrations) are welcome.

**Concerning Change Date** (Q2):
- The license text says "first publicly available distribution of a specific version".
- Operator **adopts the strict interpretation**: the Change Date clock starts from the **first day the repository is public** on GitHub (the canonical public source). If the repo was temporarily made private and returned to public, the original first-public date controls.
- Even under any other interpretation, the **hardcoded ceiling of 2030-05-18** in the LICENSE file applies — license auto-converts no later than that date regardless.
- This is an operator interpretation; if a court finds another interpretation more correct, the operator will not contest such finding to delay MIT transition.

### What operator does NOT claim

- Operator does NOT claim BSL is "open source" in the OSI sense (it's source-available with limited grant).
- Operator does NOT claim Change Date can be modified later (it's a `CHARTER §4 I-2` invariant, locked).
- Operator does NOT claim the non-compete grant has uniform enforcement strength across jurisdictions.

---

## §2 Regulatory Contributors / 监管研究贡献者

(Covers `BRIEF.md` Q3, implemented via `.github/ISSUE_TEMPLATE/regulatory.yml` — required ack checkboxes + structured submission)

Contributors who submit regulatory-research issues / PRs are providing **research material**, not legal advice. The `regulatory.yml` issue template requires explicit acknowledgement of this from each contributor.

**Operator's position**:
- Research output is for educational understanding of how the protocol's mechanisms map to specific jurisdictions' rules.
- The research output is published in `docs/` under the project's BSL license.
- Operator does NOT vouch for the accuracy of any individual research contribution. Errors in research are not project liability.
- Readers who rely on research-contributor output for their own compliance decisions do so at their own risk and should consult licensed counsel.

---

## §3 Dispute resolution: framing as ADR / 争议解决:框成 ADR

(Covers `BRIEF.md` Q4 — cross-jurisdiction "unauthorized practice of law" risk)

### Operator framing

The WebAZ arbitration mechanism is structurally **contractually-agreed-to private alternative dispute resolution (ADR)**:
- Buyers and sellers each accept the arbitration framework at order time (explicit consent point, recorded in order audit log).
- Arbitrators are protocol-onboarded community members, not licensed legal practitioners; their decisions are not held out as judicial determinations.
- Decisions bind only the disputing parties to the protocol's escrow / refund / reputation outcomes — they do not purport to determine criminal liability, statutory rights, or anything outside the protocol's own state.
- The arbitration process is **on-chain transparent** (audit log + public dispute_cases archive with PII redacted).

### Risk acknowledgement

Even with ADR framing, some jurisdictions define "providing dispute resolution services for a fee" or "rendering legal advice" broadly. The operator's position:
- Arbitrators are **paid via slashing distribution** (not user fees), in line with platform incentives, not professional legal service fees.
- For the operator's identified high-risk jurisdictions (see §6), the operator implements **geo-restrictions** on dispute-initiation flows.
- Any user accessing WebAZ from a jurisdiction where private ADR services trigger UPL red lines is responsible for compliance with local rules. Operator's geo-restrictions are best-effort, not foolproof.

### What operator does NOT claim

- Operator does NOT claim WebAZ arbitration substitutes for court litigation.
- Operator does NOT claim arbitration decisions are enforceable judgments in any jurisdiction.

---

## §4 Commission / referral / PV: differentiation from MLM / 三级奖励 / 推荐 / PV:与 MLM 的区分

(Covers `BRIEF.md` Q5)

WebAZ has a multi-level commission structure (L1 70% / L2 20% / L3 10%) attached to product sales, capped per-region by `region_config.max_levels`. **The operator's good-faith position is that this structure is NOT a multi-level marketing scheme** for the following objectively-verifiable reasons:

### Three core anti-MLM safeguards (code-enforced)

| MLM trait | WebAZ position | Where enforced |
|---|---|---|
| 1. Joining / member fees | ❌ **None ever**; registration is free | `users.role` ≠ 'paid_member' anywhere |
| 2. Income from headcount / team commission (no real product) | ❌ Earnings are proportional to **real transactions** of physical/digital products; if no product purchase, no commission flows | `product_share_attribution` table records actual order anchors |
| 3. Static / unearned income | ❌ Each commission corresponds to a real buyer purchase event; no "passive returns" mechanism | `settleCommission()` triggered only on order completion |

### Additional safeguards

- **Region caps**: `region_config.max_levels` is jurisdiction-specific
  - EU member states: `max_levels = 1` (only direct L1 sharing)
  - Some high-MLM-risk jurisdictions: `max_levels = 0` (entire commission pool routes to `commission_reserve`, a separate protocol-reserve account; no MLM behavior at all)
  - Default permissive (`max_levels = 3`) applies only where local rules allow
- **Region cap is code-enforced**, not honor-system. Operator updates `region_config` based on regulatory developments.
- **Rewards opt-in** (RFC-002, in implementation): default off; user must explicitly activate to receive any commission. Without activation, undistributed commission goes to `commission_reserve` (三级公池, separate from the charity fund, which is reserved for the charity-wishes module).

### Reader notice (for jurisdiction-sensitive readers)

In some jurisdictions (China, India, certain US states, others with strict MLM thresholds), even arrangements that satisfy all three anti-MLM safeguards may still trigger registration requirements or other regulatory burdens.

**The operator's position**:
- For these jurisdictions, the operator sets `max_levels = 0` and/or geo-restricts commission features entirely (see §6).
- Users in such jurisdictions can still use WebAZ as a buyer / seller without engaging the commission system.
- See `docs/PARTICIPATION-ATTRIBUTION-COMPLIANCE.md` for the technical / code-level architecture analysis.

### What operator does NOT claim

- Operator does NOT claim WebAZ's structure has been formally certified as non-MLM in any jurisdiction.
- Operator does NOT claim the L1/70 + L2/20 + L3/10 split is appropriate or legal in every jurisdiction.
- Operator does NOT solicit users to "recruit downlines" — see `docs/PARTICIPATION-ATTRIBUTION-COMPLIANCE.md` for the structural anti-MLM analysis (note: dedicated de-MLM linguistic guideline doc deferred; linguistic discipline currently enforced via PR review + de-MLM word cleanup track per #1092).

---

## §5 AI agent custodianship + Iron-Rule / AI agent 监护人责任 + 铁律

(Covers `BRIEF.md` Q6)

### Operator's design

WebAZ separates operations into two categories:

**Agent-permitted operations** (most ordinary commerce actions):
- Browse, search, list, purchase, fulfill, message, basic dispute participation
- The agent acts under the **custodian's account** (the human user who registered + holds the Passkey)
- Custodian is **legally and operationally responsible** for the agent's actions, same as a legal agent / employee under common-law agency principles

**Iron-Rule operations** (require human Passkey):
- `verifier vote` / `arbitrate verdict` / `agent revoke` / `delete passkey` / `governance apply` / `governance activate` / `governance resign` / `appeal resolve`
- These are protocol-enforced via `require_human_presence_for_*` params (default = 1, see `SECURITY.md`)
- An AI agent **cannot** sign these operations on behalf of its custodian; the human must complete a WebAuthn ceremony

### Operator's position on liability

- For agent-permitted operations: the **custodian (human registered user)** is responsible. AI agent providers (OpenAI, Anthropic, etc.) are not WebAZ parties; their relationship to the user is separate.
- For Iron-Rule operations: only the human can complete them; if a human completed it, they did so as themselves, not as someone else's agent.
- WebAZ as a protocol does not assume legal personhood for AI agents; AI agents are tools operated by custodians.

### Reader notice

In jurisdictions where AI-agent-mediated commerce is novel and case law is sparse, the user (custodian) takes on the operational risk of any agent they configure.

---

## §6 Jurisdiction matrix / 辖区矩阵

The following table represents the operator's **current good-faith geo-restriction decisions**. It is subject to change based on regulatory developments and (eventually) formal legal review.

| Jurisdiction | Sensitive ops restricted | Reasoning |
|---|---|---|
| China (中国大陆) | Commission system disabled (`max_levels = 0`); arbitration restricted to consenting parties only (no third-party arbitrator paid); KYC + reporting tightened | Strict MLM law + crypto restrictions + UPL definition broad |
| India | Commission `max_levels = 0` initially; revisit when local opinion obtained | MLM threshold low + recent regulatory scrutiny on direct selling |
| Iran, North Korea, Cuba, Syria, Crimea, Donetsk, Luhansk (US OFAC) | Entire service restricted | US sanctions compliance |
| EU member states | Commission `max_levels = 1` (L1 only); GDPR-grade PII handling | Strict MLM laws + GDPR |
| UK | Commission `max_levels = 1` initially; FCA crypto rules tightening | Strict MLM + recent FCA guidance |
| US (federal) | Commission permitted with caps; no public solicitation language | FTC MLM guidance + state variability |
| US states with strict MLM enforcement (CA, MT, MD, WY, etc.) | Same as federal + extra disclosures shown at signup | State law variability |
| Singapore | Default `max_levels = 3`; MAS compliance for crypto features | Lighter regulatory baseline + clear MAS framework |
| Other / unspecified | Default `max_levels = 1` (conservative) | Best-effort default |

**Mechanism**: `region_config` table in DB; values updated by operator as needed (audit log via `protocol_params_log`).

**Geo-detection**: IP-based + user self-declaration. Best-effort, not foolproof. Users in restricted jurisdictions who circumvent (VPN, false declaration) take on personal responsibility per ToS.

---

## §7 When the operator will consult a licensed lawyer / 何时会咨询持牌律师

The operator pre-committed in this document to obtain formal written legal opinion under any of these triggers:

1. **Scale-based**: real user count > 100, OR cumulative transaction value > $10k USD equivalent, OR > 10 active disputes/month
2. **Incident-based**: any formal regulator inquiry, takedown request, or first cease-and-desist letter
3. **Expansion-based**: entering a previously-restricted jurisdiction, or significant policy change in current jurisdictions
4. **Phase D**: before the DAO arbitration mechanism goes live for real (this is the highest-risk arbitration moment)

The prepared questions in `docs/LAW-CONSULTATION/BRIEF.md` are the brief for that eventual engagement.

**The operator is not pre-committing to a specific budget or firm.** The 2026-06 deferral was a budget timing decision, not a permanent rejection of legal counsel.

---

## §8 How to challenge or correct this document / 如何挑战或修正本文档

This document is published under BSL 1.1 like all of WebAZ source. Readers who believe any statement is materially incorrect (factually, or as a matter of law in any jurisdiction) are encouraged to:

1. Open a `regulatory` issue per `.github/ISSUE_TEMPLATE/regulatory.yml` — clearly state the disputed claim + cite authoritative source
2. Submit a PR with a proposed correction + rationale
3. Reach the operator at `<contact@webaz.xyz>` if the issue is sensitive

Material corrections will be processed under the RFC procedure for protocol-level documents (`CHARTER §6`).

---

## §9 References

- `docs/CHARTER.md` §4 I-2 (license evolution lock)
- `LICENSE` (BSL 1.1 text + 2030-05-18 Change Date, at repo root)
- `docs/PARTICIPATION-ATTRIBUTION-COMPLIANCE.md` (architectural anti-MLM analysis)
- `docs/ECONOMIC-MODEL.md` §11 (commission flow + region cap mechanics)
- `SECURITY.md` (Iron-Rule design, at repo root)
- `.github/ISSUE_TEMPLATE/regulatory.yml` (contributor disclaimer framework)
- `docs/LAW-CONSULTATION/BRIEF.md` (deferred questions for future lawyer engagement)
- `docs/TERMS-OF-SERVICE.md` (user-facing ToS — companion document)
