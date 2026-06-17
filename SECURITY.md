# Security Policy / 安全政策

WebAZ 协议处于 **pre-launch 阶段**(2026-05-31:0 真用户 · verifier+arbitrator 全 fixture · 经济未结算)。
WebAZ is in **pre-launch stage**. Even so, security issues — especially **Iron-Rule bypasses**(对应元规则 #5 不偏袒 + #4 不撒谎 + #6 不滥用 的技术边界)— remain top priority.

> 📚 本文件涉及的"元规则 #N"对应 [`docs/META-RULES-FULL.md`](docs/META-RULES-FULL.md) 的 #1-#10。
> All "元规则 #N / Rule #N" refs map to `docs/META-RULES-FULL.md`.

---

## 🛡 Supported versions / 支持的版本

| Version | Status / 状态 | Security updates / 安全更新 |
|---|---|---|
| `main` (HEAD) | active | ✅ 全部修复 / All fixes |
| latest npm release | active | ✅ next minor 内修复 / Within next minor |
| 历史 git tag / Older tags | unsupported | ❌ 不再回补 / No backports — please upgrade |

We treat the **current `main` branch as the only "supported"** version. Pre-launch means we move fast; please track `main` if you depend on it.

---

## 🚨 报告漏洞 / Report a vulnerability

### 不要在公开 issue 里报告 / Do **NOT** open public issues

公开 issue 会让攻击者先看到。请用以下任一私密渠道:
Public issues let attackers see first. Use one of these private channels:

### 1. GitHub Security Advisory(推荐 / Preferred)

→ [https://github.com/webaz-protocol/webaz/security/advisories/new](https://github.com/webaz-protocol/webaz/security/advisories/new)

- 自带 E2E 加密 / End-to-end private
- 直接产出 advisory ID(可被 PR template 引用)/ Produces advisory ID
- 修复后一键发布 GHSA + 申请 CVE / One-click GHSA + CVE publication

### 2. Email(备用 / Fallback)

→ `security@webaz.xyz`

- Subject 前缀:`[WebAZ Security]` / Subject prefix: `[WebAZ Security]`
- **邮件当前不加密** — phase A 阶段**没有 PGP key**(已知缺口)。
  Email is **NOT encrypted** — **no PGP key in phase A**(known gap).
- **敏感漏洞强烈优先用 Advisory**(自带 E2E),email 仅作低敏感度或无法访问 GitHub 时的备用。
  Strongly prefer Advisory for sensitive reports; use email only as fallback.
- PGP 配置不在 phase A 范围 — 引入需要密钥管理 / 备份 / 轮换流程,这本身是治理问题。
  PGP setup is out of phase-A scope — it needs key management, backup, rotation as a governance topic.
  有意推动 PGP 的 contributor 可提 RFC(`docs/rfcs/`)。
  Contributors willing to drive PGP adoption can open an RFC.

> ⚠️ **关于此 email 的性质**(对应元规则 #4 不撒谎 + #10 phase 透明披露)/ **About this email**:
> - `security@webaz.xyz` 是 Cloudflare Email Routing forwarding alias;phase A 转发到 @seasonkoh 个人 Gmail / `security@webaz.xyz` is a Cloudflare Email Routing forwarding alias; phase A routes to @seasonkoh's personal Gmail
> - phase A solo 状态下 = **个人响应水平**,无 team triage,不是企业级 SLA / phase A solo = **personal response level**, no team triage, not enterprise SLA
> - phase B+ 形成 maintainer 群后,可在 Cloudflare routing rules 加入 maintainer 转发(**无需改文档**)/ Phase B+: routing rules can add maintainer forwards (**no doc change needed**)
> - PGP 加密仍是已知缺口(见上文)/ PGP encryption remains a known gap (see above)

---

## ⏱ Response timeline / 响应时效

> ⚠️ **这不是 SLA,是 best-effort 承诺。**
> ⚠️ **This is NOT an SLA, it is a best-effort commitment.**
>
> - SLA = 失约有补偿义务(我们没有,因为没收费)/ SLA = compensation on miss (we don't, since unpaid)
> - best-effort = 尽力为之,无法律 / 财务义务 / best-effort = good-faith effort, no legal/financial obligation
> - phase B+ 形成 maintainer 群后才会有正式 SLA / Formal SLA arrives in phase B+

phase A 由 @seasonkoh 一人处理。Best-effort 时间窗:
Phase A is handled solo by @seasonkoh. Best-effort windows:

| 严重度 / Severity | 首次回复 / Ack | 修复目标 / Target fix |
|---|---|---|
| **🔴 P0 Iron-Rule 绕过 / Iron-Rule bypass** | 24h | 72h |
| **🔴 P0 资金路径 / Fund-path**(钱包/出金/anchor 押金/charity fund)| 24h | 7d |
| **🟡 P1 身份/授权 / Identity-auth**(api_key scope / agent custodian / trust-anchor)| 48h | 14d |
| **🟢 P2 信息泄露 / DoS** | 7d | 30d |

时间窗解读 / How to interpret:
- "24h Ack" = ~90% 概率达到,不是法律义务 / ~90% likely, not legal obligation
- 看到时间窗 = 这件事我们会优先处理,不是【失约赔偿】 / Means "we prioritize", not "we owe you"

> 🌀 **不可抗力延期条款 / Force majeure extension**(对应元规则 #4 不撒谎 + #10 phase 透明披露):
> - pre-launch solo 时期:节假日 / 病假 / 旅行 / 其他紧急事件 → 时效**可延长最多 1 倍**(e.g. ack 24h → 48h, fix 72h → 144h)
> - Pre-launch solo period: holidays / sick leave / travel / urgent events → timeline may extend **up to 2×**
> - **延长后必须公开告知 reporter**(advisory 评论或 email 回复),不会静默推迟。
>   Extensions **must be disclosed to reporter** (advisory comment or email reply); never silent.

---

## 🔐 Iron-Rule 边界 / Iron-Rule boundary

**Iron-Rule** = 协议为防止 AI agent 代替人类做关键操作而设的真人 Passkey 边界。
**Iron-Rule** = protocol boundary requiring real-human Passkey for critical actions (preventing AI agent from acting on behalf of human).

技术上由协议参数 `require_human_presence_for_*`(默认 `1`)+ PWA Web 端 Passkey ceremony 强制。
Technically enforced via `require_human_presence_for_*` protocol params(default `1`)+ Passkey ceremony on PWA Web.

**完整 Iron-Rule 路径(7 条) / Full Iron-Rule paths (7 total)**:

| # | Action | MCP 工具 / MCP tool | 协议参数 / Protocol param |
|---|---|---|---|
| 1 | **arbitrate** — 仲裁裁定 / Arbitration ruling | `webaz_dispute(action=arbitrate)` | `require_human_presence_for_arbitrate` |
| 2 | **vote** — 验证投票 / Verifier vote | `webaz_claim_verify(action=vote)` | `require_human_presence_for_vote` |
| 3 | **agent_revoke** — 撤销 agent 授权 / Revoke agent authorization | (via PWA #my-agents) | `require_human_presence_for_agent_revoke` |
| 4 | **delete_passkey** — 删除 Passkey 自身 / Delete Passkey itself | (via PWA settings) | `require_human_presence_for_delete_passkey` |
| 5 | **revoke_key** — api_key 死亡 / Kill api_key (no replacement) | `webaz_revoke_key`(仅登记意图 / intent only)| (PWA flow) |
| 6 | **rotate_key** — api_key 轮换 / Rotate api_key | `webaz_rotate_key`(仅登记意图 / intent only)| (PWA flow) |
| 7 | **wallet operations** — 钱包出金 / 入金 / 白名单管理 / Wallet ops | (MCP 不能动钱 / MCP cannot move money)| (PWA + Passkey + email OTP) |

> 关于第 7 条:协议规定 **MCP 永远不能直接转账** — 所有出金 / 入金 / 白名单变更都必须走 PWA Web + Passkey + email OTP。"large_withdraw" 不是分档概念,**所有 withdraw 都是 Iron-Rule**。
> Regarding row 7: MCP **can never directly move money** — all withdraw/deposit/whitelist changes must go through PWA Web + Passkey + email OTP. **All withdraws are Iron-Rule**, not just "large" ones.

**不属于 Iron-Rule 的相邻概念 / Adjacent but NOT Iron-Rule**:
- 协议参数变更 / Protocol parameter changes — 走 CHARTER §3.2 多签 + 公示,不是 Iron-Rule
- 元规则修订 / Meta-rule revision — 走 CHARTER §6(60d + 多签,user 作为一票、非个人否决)/ via CHARTER §6 (60d + multisig, user as one signer, no personal veto)
- 普通 PR / 普通授权 / Regular PR or grant — 走 §3.2 multisig 矩阵

---

## 📋 范围 / Scope

### ✅ In-scope(我们认作漏洞 / We consider these vulnerabilities)

**Iron-Rule 绕过 / Iron-Rule bypass**(对应元规则 #5 不偏袒 + #4 不撒谎 + #6 不滥用)
- 真人 Passkey 验证可被 AI agent 代签 / Real-human Passkey can be signed by AI agent
- `require_human_presence_*` 协议参数被静默关闭(不通过 §3.2 多签)/ Protocol params silently disabled
- 上表 7 条路径任一可在无 Passkey 时调用 / Any of the 7 paths callable without Passkey

**资金路径 / Fund-path**(对应元规则 #6 不滥用)
- 出金不需有效签名 / Withdraw without valid signature
- anchor 押金可被任意 user 提走 / anchor stake claimable by anyone
- charity fund / commission 流向错误 / charity fund / commission misrouted
- WAZ ↔ USDC 兑换比率被篡改 / WAZ ↔ USDC exchange rate tampered

**身份与授权 / Identity & authorization**(对应元规则 #3 不偷数据 + #5 不偏袒)
- api_key scope 边界被绕过 / api_key scope bypass
- agent 监护人(custodian)绑定可伪造 / custodian binding forgery
- Phase 4 trust-anchor / well-known 撤销记录可被篡改 / Phase 4 trust anchor revocation tamperable

**协议状态机 / Protocol state machine**(对应元规则 #2 代码即规则)
- order chain hash 可被伪造 / order chain hash forgery
- dispute evidence 可被伪造或越权读取 / dispute evidence forgery or unauthorized read
- 跨用户读 cap 可被绕过 / cross-user read cap bypass

**Web 标准漏洞 / Standard web vulnerabilities**
- XSS / CSRF / SQL injection / SSRF / DNS rebinding / path traversal
- 任何允许提权或冒充其他用户的漏洞 / Any privilege escalation or impersonation

### ❌ Out-of-scope(请勿报告 / Please do NOT report)

**已知的 phase A 限制(不视为缺陷)**:
**Known phase A limitations (NOT considered defects)** — 对应元规则 #10 phase 透明披露:
- 0 真用户 / verifier+arbitrator 全 fixture(MCP `webaz_info` 已声明 / disclosed in MCP `webaz_info`)
- 经济流尚未真实结算 / Economic flow not yet really settling
- **PGP key 缺失**(见上文"报告漏洞"段)/ PGP key absence (see "Report" section)
- bug bounty 现金奖励暂无 / No cash bug bounty in phase A
- 跨 region 节点尚未部署(仅 SG canonical endpoint)/ Multi-region not deployed
- DAO 治理结构尚未启动 / DAO governance not yet active

报告这些不会被处理 — 节省你和 maintainer 的时间。
Reporting these will not be processed — saves both sides' time.

**协议设计争议(不是漏洞)/ Protocol design disputes (NOT vulnerabilities)**:
- 操纵 / 公平性 / 经济参数的**设计层争议** — 走 `docs/rfcs/RFC-xxx-...` 流程,不是 security 通道
  Manipulation / fairness / economic-param **design disputes** — use RFC, NOT security channel
- 边界划分 / Boundary:
  - 若是【**代码实现**违反元规则 #5 不偏袒】(e.g. 给特定 seller 硬编码 ranking boost)→ ✅ **In-scope** 漏洞
  - 若是【**设计本身**你不同意】(e.g. "当前费率太高")→ ❌ **走 RFC**,提案 + 14 天公示
  - 若是【**元规则本身**需修订】 → ❌ **走 CHARTER §6**(60d 公示 + 2/3 maintainer 多签,user 作为一票、非个人否决)

**其他不接受 / Other rejections**:
- 用户故意配置错误 / User self-misconfiguration
- 通过社工 / 物理访问 @seasonkoh 个人设备 / Social engineering / physical access
- 缺少 `Strict-Transport-Security` / CSP report-uri 等次要 header(改进 PR 欢迎)/ Missing minor headers (improvement PR welcome)
- 自动扫描器报告但无可复现 PoC / Automated scanner reports without PoC
- 第三方依赖 CVE(Dependabot 已自动 track)/ 3rd-party CVEs (Dependabot covers)

---

## 🤝 协调披露 / Coordinated disclosure

**默认 90 天 / Default 90 days** between report and public disclosure.

- 我们承诺 / We commit:
  - 不法律威胁善意报告者 / No legal threats against good-faith reporters
  - 修复后公开致谢(除非你要求匿名)/ Public credit after fix (unless anonymous requested)
  - 发 GHSA + 申请 CVE(若严重度 ≥ P1)/ Publish GHSA + apply for CVE (if severity ≥ P1)
- 你承诺 / You commit:
  - 不公开披露直到我们发布 advisory 或 90 天到期 / No public disclosure before our advisory or 90-day window
  - 不利用漏洞做有害 PoC(读 N 条 fixture 数据 OK,清空真用户数据不 OK)/ No harmful PoC

---

## 🔁 报告后的跟进 / Follow-up after reporting

报告提交后,你会收到 / After submitting, you'll get:
1. **24-72h 内** — 首次 Ack(确认收到 + 严重度初判)/ Initial Ack
2. **7-30 天内** — 修复进度更新(取决于严重度)/ Progress update by severity
3. **修复完成时** — advisory 发布 + 致谢 + dev_contribution 加分 / Advisory + credit + score boost

你可以 / You may:
- 在 advisory 评论区跟进(私密,只有你 + maintainer 看到)/ Comment on advisory privately
- 任何节点没收到回复 → 在 advisory 留言 ping / Ping us if no reply
- 严重度争议 → 提附加 evidence,重新评估 / Dispute severity with new evidence

我们不会 / We will NOT(对应元规则 #1 当一切可见 + #4 不撒谎):
- ✗ 静默推迟修复 / Silently defer fixes
- ✗ 修复后不通知你 / Forget to notify you after fix
- ✗ 不致谢(除非你明确要求匿名)/ Skip credit (unless you ask)
- ✗ 把你的报告 leak 给第三方(包括投资人 / 媒体)/ Leak your report to anyone

---

## 🎁 Recognition / 致谢

phase A **无现金 / 无 WAZ bounty** — 这是经济模型公平性的当前选择,不是疏忽。
Phase A: **no cash, no WAZ bounty** — current choice, not oversight.

**当前可兑现 / Currently redeemable**(对应元规则 #2 代码即规则:写了的才算):
- **公开致谢**(README + advisory + commit message,除非你要求匿名)/ Public credit
- **dev_contribution 加分**(phase B+ tier 晋升信号)/ Score boost (phase B+ tier signal)
- **WebAZ contributor profile 排名加权** / Profile ranking boost

**未来可能引入(具体金额 / 形式 / 触发条件由 RFC 决议)**:
**Future (form / amount / trigger to be decided via RFC)**:
- bounty 程序的引入、金额、触发条件 — 走 [`docs/ECONOMIC-MODEL.md`](docs/ECONOMIC-MODEL.md) 单源真理决议,不在本文 hard-code 任何数字。
  Bounty introduction / amount / trigger — decided in [`docs/ECONOMIC-MODEL.md`](docs/ECONOMIC-MODEL.md) as single source of truth. **No numbers hard-coded here.**
- 元规则 #4 不撒谎:不许诺无法兑现的未来奖励。
  Rule #4 No lies: no promise of future rewards we can't guarantee.

---

## 📚 参考 / References

- [`docs/META-RULES-FULL.md`](docs/META-RULES-FULL.md) — 元规则 #1-#10 完整定义 / Full 10 meta-rules
- [`docs/CHARTER.md §3.2`](docs/CHARTER.md) — 决策权与多签矩阵 / Multisig matrix
- [`.github/ISSUE_TEMPLATE/config.yml`](.github/ISSUE_TEMPLATE/config.yml) — Security Advisory entry
- [GitHub Security Advisory docs](https://docs.github.com/en/code-security/security-advisories)
- [`webaz_info` MCP tool](src/layer1-agent/L1-1-mcp-server/server.ts) — pre-launch 状态自报 / pre-launch self-disclosure

---

**Last reviewed / 最后 review**: 2026-06-01
**Next review / 下次 review**: phase B trigger 时(per CHARTER §3.3)/ When phase B triggers
