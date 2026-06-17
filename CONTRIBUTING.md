> *In lumine Tuo videbimus lumen.*  
> **借汝之光,得见光明。**  
> <sub>——敬引哥伦比亚大学校训,典出《诗篇》36:9</sub>
>
> 在 WebAZ,你的每一次参与都会被看见、被记住。
> 代码可以复现,而你不能被替代。
> **WebAZ 是所有参与者的 WebAZ。**
>
> At WebAZ, every contribution you make is seen, and remembered.
> Code can be reproduced, but you cannot be replaced.
> **WebAZ belongs to everyone who builds it.**

---

# Contributing to WebAZ / 贡献给 WebAZ

Thanks for considering a contribution. Bug reports, feature ideas, code patches, RFCs (idea-only), and natural-language proposals are all welcome — **and you don't need to read the whole governance stack to help.** Fixing a typo, adding a translation, or filing a bug takes 2 minutes.

感谢你考虑贡献。Bug 报告、功能想法、代码补丁、RFC(纯想法亦可)、自然语言提议,都欢迎 —— **而且不必先读完整套治理文档**。修个 typo、补个翻译、报个 bug,2 分钟就行。

> 想改的是**协议本身**(状态机 / 资金 / 治理 / 元规则)? 跳到 [深入贡献](#深入贡献协议级改动--going-deeper-protocol-level-changes)。
> Changing the **protocol itself** (state machine / funds / governance / meta-rules)? Jump to [Going deeper](#深入贡献协议级改动--going-deeper-protocol-level-changes).

---

## Quick start / 跑起来

```bash
git clone https://github.com/<your-fork>/webaz.git
cd webaz
npm install
npm run build       # must pass before opening a PR / PR 前必过
npm run pwa         # start PWA + auto state-machine enforcement (port 3000) / 启动 PWA + 协议状态机自动判责执行(超时→自动处置)
npm run mcp         # start MCP server alone (for Claude Desktop) / 单独启 MCP
npm run demo        # full trade demo / 完整交易演示
```

数据库默认 `~/.webaz/webaz.db`。删此目录可重置本地数据。
DB defaults to `~/.webaz/webaz.db`. Delete to reset local data.

---

## What can I do? / 我可以做什么?

> 🚪 **New here, GitHub-first, or bringing your own agent?** Start with
> [`docs/PUBLIC-CONTRIBUTOR-ENTRY.md`](docs/PUBLIC-CONTRIBUTOR-ENTRY.md) — *contribute first, bind later*
> (GitHub PR now, Passkey claim later); everything stays `uncommitted` (no reward promised). **第一次来 /
> GitHub 优先 / 带自己的 agent?** 先看 [`docs/PUBLIC-CONTRIBUTOR-ENTRY.md`](docs/PUBLIC-CONTRIBUTOR-ENTRY.md)。

挑一个最顺手的开始,**都欢迎** / Pick whatever's easiest — **all welcome**:

- **改文档 / Edit docs**: README / docs/ 里有错都欢迎修 / all doc fixes welcome
- **翻译 / Translate**: i18n 缺哪个语种欢迎补 / any missing i18n locale welcome
- **报 Bug / Report bugs**: 先看 [Issues](https://github.com/webaz-protocol/webaz/issues) 有没有重复,没有就开新 issue;带复现步骤的优先 / check existing issues first; ones with repro steps get priority
- **写代码 / Write code**: 从 `good-first-issue` 标签挑(如果有),或者直接提 PR / start from `good-first-issue` (if any), or just submit a PR
- **提建议 / Suggest**: Issue / Discussions / RFC — 不必先有代码 / no code required first

> 不写代码也能贡献:直接写 RFC 提想法,agent / maintainer 会评估 + 设计实现。RFC 通过本身就是贡献。
> Non-coder? Write an RFC with your idea — agents/maintainers assess and design it. An accepted RFC is itself a contribution.

---

## Your first PR / 提你的第一个 PR

3 步 / 3 steps:

1. **Fork → 新分支改 → 提 PR 到 main** / Fork → new branch → PR to `main`
2. **本地必过** / Must pass locally: `npm run build`
3. **每个 commit 加 `-s` 签 DCO** / Sign each commit with `-s`:
   ```bash
   git commit -s -m "docs: fix typo in README"
   ```
   (`-s` 自动追加 `Signed-off-by`;CI 会检查,未签不能 merge。详见 [DCO](#贡献者签名-dco--developer-certificate-of-origin) / appends `Signed-off-by`; CI checks it, unsigned PRs can't merge. See [DCO](#贡献者签名-dco--developer-certificate-of-origin).)

PR 描述写清楚:**改了什么 / 为什么 / 怎么验证**。PR 模板第一项【改动分类】必填(AI review 据此分流)。
In the PR: **what / why / how to verify**. The PR template's first item [change category] is required (AI review routes by it).

> 文档 / i18n / 小修不必懂治理细节,放心提。涉及协议状态机 / 资金 / 治理的改动,见下面 [深入贡献](#深入贡献协议级改动--going-deeper-protocol-level-changes)。
> Docs / i18n / small fixes need no governance knowledge — just send it. For protocol-state / funds / governance changes, see [Going deeper](#深入贡献协议级改动--going-deeper-protocol-level-changes) below.

---

## Contact / 联系方式

- **Issues**: <https://github.com/webaz-protocol/webaz/issues>
- **Discussions**: <https://github.com/webaz-protocol/webaz/discussions>
- **Maintainer**: [@seasonsagents-art](https://github.com/seasonsagents-art)
- **Security**: 私下报告漏洞请发 / report privately to: `security@webaz.xyz`(参 [SECURITY.md](SECURITY.md))

> 参与任何 WebAZ 空间即同意 [CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md)(社区行为标准)。
> Participating in any WebAZ space implies agreement to [CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md).

---
---

# 深入贡献:协议级改动 / Going deeper: protocol-level changes

以下内容**只在你的改动触及协议本身时才需要** —— 状态机 / 资金 / 治理 / 元规则 / 安全。轻量贡献(文档 / i18n / 小 bug)不必读这一段。

The rest applies **only when your change touches the protocol itself** — state machine / funds / governance / meta-rules / security. Light contributions (docs / i18n / small bugs) can skip this.

## 协议级改动前先对齐 / Read before protocol-level changes

3 docs / 5 min — 协议级 PR 的作者请先对齐这 3 份(轻量贡献不必):

1. **[10 元规则 / 10 Meta-Rules](docs/meta-rules.yaml)** — canonical 一句话定义(机读锁定版)/ one-line definitions (locked machine-readable form)
2. **[META-RULES-FULL](docs/META-RULES-FULL.md)** — 完整阐释 + 反例 + 开发协作场景 / full expansion + reverse examples + dev-collab guidance
3. **[CHARTER](docs/CHARTER.md)** — 开发协作宪章(治理 / 角色 / 决策 / 加入退出) / Charter (governance / roles / decisions / join & leave)

协议级 PR 会按 [CHARTER §3.2](docs/CHARTER.md#32-决策权与多签矩阵--decision-authority--multisig-matrix) 走对应审计矩阵;若改动与某条元规则冲突,会被 AI review + maintainer **标出来一起对齐**(不是一拒了之 —— 我们会说明冲突在哪、怎么改)。

Protocol-level PRs follow the [CHARTER §3.2](docs/CHARTER.md#32-决策权与多签矩阵--decision-authority--multisig-matrix) audit matrix; if a change conflicts with a meta-rule, AI review + maintainer will **flag it for alignment** (not a silent reject — we explain the conflict and how to fix).

---

## ⚠️ 本地 / 生产数据隔离原则 (元规则 #3)
## Dev / Prod Data Isolation (Rule #3)

**dev 环境严禁 / Dev environment MUST NOT**:
- 用 prod 数据(snapshot 必须 anonymized)/ Use prod data (snapshots must be anonymized)
- 把本地 `webaz.db` 上传 / 分享 / 截屏(可能含早期测试用户数据)/ Upload / share / screenshot local `webaz.db` (may contain early test users' data)
- 测试时连真实 production endpoint / Connect to real production endpoint in tests
- 把 prod 的 api_key / Passkey / token 在 dev 环境用 / Use prod credentials in dev

**dev 环境必须 / Dev environment MUST**:
- 用 `npm run demo` 生成的虚拟数据 / Use virtual data generated by `npm run demo`
- 任何外发数据流(API → 第三方)在 dev 必须 disabled / mocked / Any outbound data flow disabled / mocked in dev
- 测试敏感场景(资金 / Passkey)用 demo 测试号,不用真号 / Use demo accounts for sensitive scenarios (funds / Passkey)

**TBD(W4+)实现的工具 / TBD (W4+) tooling**:
- `npm run gen-test-data` — 生成完整 anonymized demo dataset(W4 计划)/ Generate full anonymized demo dataset (planned for W4)
- `npm run scrub-pii` — 把已有 db 的 PII 字段批量 anonymize(W4 计划)/ Bulk anonymize PII in existing DB (planned for W4)
- 在 W4 实现前,contributor 只用 `npm run demo` 生成的数据 / Until W4, contributors only use `npm run demo` data

理由:直接对应元规则 #3 / #4 / #6;是 AI review 第一道关检查内容。
Rationale: Direct mapping to Rule #3 / #4 / #6; first gate for AI review.

---

## 审批分档 / Review tiers

**main 分支已开启保护;审批要求按改动类型决定(参 [CHARTER §3.2](docs/CHARTER.md#32-决策权与多签矩阵--decision-authority--multisig-matrix))**:
**`main` is protected; approval requirements vary by change type (see [CHARTER §3.2](docs/CHARTER.md#32-决策权与多签矩阵--decision-authority--multisig-matrix))**:

| 改动类型 / Change type | 必要审批 / Required approval | 超时机制 / Timeout |
|---|---|---|
| docs / 文案 / i18n | AI review + 任 1 maintainer / + any 1 maintainer | 14 天无响应 → AI 自动推进 / 14d → AI auto-advance |
| 普通 code(无协议/资金/Iron-Rule)/ Normal code | AI review + 1 maintainer | 14 天 / 14d → AI auto-advance |
| 协议状态机 / fault 处置规则 / 资金路径 / Protocol state-machine / fault-handling rule / fund-path | AI review + 2-of-2 多签(任 1 maintainer + user 作为多签一票)/ AI review + 2-of-2 multisig (any 1 maintainer + user as one signer) | 30 天无多签 → 自动归档 / 30d no multisig → auto-archive |
| 元规则 / 宪法参数 / Iron-Rule 默认 / Meta-rules / constitutional params / Iron-Rule defaults | AI review + 超级多数多签(phase A: user 1-of-1;phase B+: ≥ 2/3 maintainer,user 作为一票)+ 14d 公示(宪法级 60d)/ AI review + supermajority multisig (phase A: user 1-of-1; phase B+: ≥ 2/3 maintainer, user as one signer) + 14d public (60d constitutional) | 60 天未达多签 → 作废 / 60d w/o multisig → void |
| 安全 / Passkey / api_key / Security / Passkey / api_key | AI review + 2-of-2 多签(任 1 maintainer + user 作为多签一票)+ security 专审 / AI review + 2-of-2 multisig (any 1 maintainer + user as one signer) + security audit | **24h → 紧急多签** / **24h → emergency multisig** |

**不确定哪一档 → 默认按高一档走,maintainer 会下调** / **Unsure which tier → default to higher; maintainer can downgrade**

> 注:审批 / 治理的**完整口径**见 [CHARTER §3.2](docs/CHARTER.md#32-决策权与多签矩阵--decision-authority--multisig-matrix)(多签矩阵)+ [§4 I-4 / I-4a](docs/CHARTER.md)。治理是**两层独立机制**:① **修改流程去人格化** —— user 只是多签里的一票,对所有提案者一致([I-4]);② **创始人守护权** —— 一个独立的防破坏机制([I-4a],BDFL),随 phase A→D 逐步收缩,phase D 仅剩"挡破坏"。
> Note: the **full** governance model is in [CHARTER §3.2](docs/CHARTER.md#32-决策权与多签矩阵--decision-authority--multisig-matrix) (multisig matrix) + [§4 I-4 / I-4a](docs/CHARTER.md). It is **two separate layers**: ① the **amendment process is depersonalized** — user is just one signer, uniform for every proposer ([I-4]); ② **founder guardianship** is a separate defensive mechanism ([I-4a], BDFL) that contracts across phases A→D, leaving only "block-harm" by phase D.

---

## 修改约定 / Modification Conventions

- **优先改动最小** / **Minimize change**: 只动跟当前 task 直接相关的行,不要顺手"清理"或重排无关代码 / Only touch task-relevant lines; no incidental "cleanup" or reordering
- **SQLite migration 规则** / **SQLite migration rule**: `ALTER TABLE` 必须紧跟在对应 `CREATE TABLE IF NOT EXISTS` 之后,或确保对应的 `init*Schema()` 已经调用过(放在 CREATE 前面会被 try/catch 静默吞掉)/ `ALTER TABLE` must follow the corresponding `CREATE TABLE IF NOT EXISTS` or ensure the corresponding `init*Schema()` has been called
- **MCP 协议日志走 stderr** / **MCP protocol log to stderr**: stdio 通信,stdout 是协议帧,**不要 `console.log`**,要用 `console.error` / stdio communication, stdout is protocol frames — **never use `console.log`**, use `console.error`
- **不要修改无关的工作代码** / **Don't touch unrelated working code**: 在已通过的功能里"顺便重构"是引入回归的最快方式 / Refactoring already-working code "while you're there" is the fastest way to introduce regressions

---

## Commit 规范 / Commit Convention

中英文都接受,但必须语义化前缀 / Both Chinese and English accepted, but require semantic prefix:

- `feat:` — 新功能 / new feature
- `fix:` — Bug 修复 / bug fix
- `docs:` — 文档变更 / docs change
- `refactor:` — 重构(不影响外部行为)/ refactor (no external behavior change)
- `chore:` — 杂项(依赖、构建配置)/ chore (deps, build config)
- `test:` — 测试相关 / test-related

可加 scope / Can add scope: `feat(mcp):` `fix(pwa):` `feat(telemetry):`

**例子(参考 git log)/ Examples (see git log)**:
- `feat(mcp): 下单前价格锁定 (webaz_verify_price + session_token)`
- `fix: arbitration partial_refund with third-party liable party`
- `docs: 更新 README 反映 0.1.8 能力`

### 元规则 trace(必须 / Required when relevant)

**触发场景必须 trace / Must trace when**:
- 任何 `fix:` 涉及 PII / 资金 / 权限 / 协议参数 / Any `fix:` involving PII / funds / permissions / protocol params
- 任何 `feat:` 新增数据导出 / 跨用户读 / 算法 / Iron-Rule 边界 / Any `feat:` adding data export / cross-user read / algorithm / Iron-Rule
- 任何 `refactor:` 涉及 settle / fault / dispute / search / recommend / Any `refactor:` touching settle / fault / dispute / search / recommend
- 任何 `docs:` 跟协议承诺相关 / Any `docs:` on protocol promises

**格式 / Format**:

```
<type>(<scope>): <subject>

[Meta-Rules trace]
Rule #X 元规则名 — 为什么这个 commit 跟元规则相关
Example: Rule #3 不偷数据 — 修复 PII leak 到 audit log 的 bug
```

**不需要 trace / No trace needed for**:`chore` / 纯文案 / 拼写 / i18n / build 配置 / pure copy edits / typos / i18n / build config

**理由 / Why**:跟 META-RULES-FULL.md 的"AI 检查 hint" + "开发协作场景"闭环;AI review 直接据 commit message 查元规则 alignment;历史 audit 时方便追溯。
Closes the loop with META-RULES-FULL.md's "AI check hint" + "dev-collab scenario"; AI review can read commit message for meta-rule alignment; eases historical audit.

---

## RFC 流程 / RFC Process

任何 ≥ 50 行架构改动 / 协议参数 / 治理结构调整,先走 RFC 流程:
Any architecture change ≥ 50 lines / protocol param / governance adjustment requires RFC:

1. 在 `docs/rfcs/RFC-xxx-your-topic.md` 起草(自然语言 OK,不必先有代码)/ Draft at `docs/rfcs/RFC-xxx-your-topic.md` (natural-language OK, no code required upfront)
2. PR 标题 `[RFC] 你的提议简述` / PR title `[RFC] brief proposal`
3. **14 天公示期**(宪法级 60 天)— 任何 webazer 可评论 / **14-day public notice** (60d for constitutional) — any webazer can comment
4. **收敛 → maintainer 决定**: / **Converge → maintainer decides**:
   - `accept` → 进入对应 code PR / proceed to code PR
   - `reject` → 必须给出元规则 trace + 替代建议 / must provide meta-rule trace + alternative suggestion
   - `defer` → 必须明确推迟到何时(默认 +30 天)并标 follow-up issue / must specify deferral date (default +30 days) and tag follow-up issue

### 超时机制 / Timeout

- 普通 RFC **14 天**后无人 review → 触发 maintainer 轮值响应 / After **14d** no review → maintainer rotation triggered
- 元规则 RFC **60 天**后未达多签 → 自动作废,重新提案 / After **60d** without multisig → auto-void, re-propose
- **紧急安全 RFC**:24h 无响应 → 触发紧急多签(2 maintainer + 14d user 追认)/ **Emergency security RFC**: 24h no response → emergency multisig (2 maintainers + 14d user retro-confirm)
- 任何 RFC 被 defer 超过 **90 天** → 自动归档,需重新提 / Any RFC `defer`'d > **90d** → auto-archive, must re-submit

### 公示期内 RFC 修改 / RFC Edits During Public Notice

修改后**重新启动公示期**;防"先简单提案过审,再悄悄加扩展"。
Edits **restart the public notice period**; prevents "simple proposal first, sneaky expansion later".

### 透明性 / Transparency

- 所有 RFC 决策必须公开记录(audit log)/ All RFC decisions must be publicly logged
- `reject` 理由必须 trace 到元规则 / `reject` reasoning must trace to meta-rules
- 任何 contributor 可挑战决策(走元 RFC)/ Any contributor can challenge via meta-RFC

---

## AI Agent 贡献者 / AI Agent Contributors

如果你是 AI agent(Claude / GPT / Cursor 等)代替人类提 PR,请在 **PR 标题末尾加 `🤖🤖🤖`**。
If you're an AI agent (Claude / GPT / Cursor) submitting on behalf of a human, **add `🤖🤖🤖` at the end of PR title**.

### AI 责任承担 / AI Accountability

跟 CHARTER §4 I-5 contribution = ownership + agent_passport 责任制对齐 / Aligns with CHARTER §4 I-5 + agent_passport accountability:

- 提 PR 的 AI agent 必须由**已绑 Passkey 的 webazer**触发(责任主体)/ The AI agent must be triggered by a **Passkey-bound webazer** (responsible party)
- PR 标题加 `🤖🤖🤖` + 在描述写**哪个 webazer 操作了哪个 agent** / Add `🤖🤖🤖` + describe **which webazer operated which agent**
- 例 / Example: `🤖🤖🤖 feat(mcp): xxx (由 @alice 通过 Claude Code 提交 / submitted by @alice via Claude Code)`
- AI 出错 → 触发方 webazer 承担(信誉扣分 / 警告升级)/ AI errors → triggering webazer accountable (reputation deduction / warning escalation)
- AI 重复出错 → 触发方 webazer 可被限制**未来 AI 提交权限** / Repeated AI errors → triggering webazer's **future AI submission rights** may be restricted

跟 webaz 协议本身的 `AGENT_SCOPE_UNDECLARED` 机制呼应,防止 AI 当替罪羊或 webazer 滥用 AI 提垃圾 PR。
Resonates with webaz's own `AGENT_SCOPE_UNDECLARED` mechanism; prevents AI being scapegoated or webazers abusing AI for spam PRs.

### 标签设计致敬 / Tag Design Credit

AI agent 标签设计致敬 [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers/blob/main/CONTRIBUTING.md) 社区。
The AI agent tagging convention credits [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers/blob/main/CONTRIBUTING.md) community.

**为什么采用 / Why**:
1. **透明性** — maintainer 一眼识别 AI 协作,调整 review 节奏 / **Transparency** — maintainers identify AI collab at a glance, adjust review cadence
2. **不歧视** — 不因为 AI 协作而过度警惕(元规则 #5 不偏袒)/ **No discrimination** — don't be over-vigilant just because AI is involved (Rule #5)
3. **谨慎度** — LLM 容易犯特定错(捏造 import / 误删测试 / 改动范围溢出),标签提示 maintainer 多 focus / **Caution** — LLMs make specific mistakes (fabricated imports / deleted tests / scope creep); tag prompts maintainer focus
4. **信誉系统** — 跟 webaz `agent_reputation` 联动,AI 协作历史进入 webazer 的"共建信誉" / **Reputation** — links to webaz `agent_reputation`; AI collab history goes into webazer's "co-build reputation"

---

## 贡献者签名 (DCO — Developer Certificate of Origin) / Contributor Sign-off

WebAZ 不要求 CLA(避免企业感 + 法律门槛),改用 **DCO(Developer Certificate of Origin)**— 跟 Linux 内核同款机制。
WebAZ does not require a CLA (avoid enterprise feel + legal barrier); instead uses **DCO** — same as Linux kernel.

**怎么做 / How to**:每个 commit 加 `-s` flag / Add `-s` flag to each commit:

```bash
git commit -s -m "feat(foo): your message"
```

This appends to the commit message / 自动在 commit message 末尾追加:
```
Signed-off-by: Your Name <your@email.com>
```

签 DCO 等于声明 / DCO sign-off declares that:
- 你拥有提交内容的版权,或有权按本项目 license 提交 / You own the copyright or are entitled to submit under the project's license
- 你同意你的贡献按 **CHARTER §4 I-2 描述的 license**(当前 BSL 1.1,Change Date 2030-05-18 自动转 MIT)发布 / You agree your contribution is licensed under the **license described in CHARTER §4 I-2** (currently BSL 1.1, auto-converts to MIT on Change Date 2030-05-18)
- 你的签名信息(name + email)会永久记录在 git 历史 / Your sign-off (name + email) will be permanently recorded in git history

**详细条款 / Full text**: [DCO 1.1](https://developercertificate.org/)

CI 会自动检查所有 commit 是否 DCO 签;未签的 PR 不能 merge。
CI auto-checks DCO sign-off on all commits; unsigned PRs cannot be merged.

> ⚠️ **License 变化 / License changes**:如果 CHARTER §4 I-2 的 license 在未来调整(走 60 天公示 + multisig),DCO 签名内容也相应更新 — 你过去的贡献仍按签名时的 license,新贡献按新 license。
> ⚠️ If CHARTER §4 I-2's license is adjusted in the future (via 60-day public notice + multisig), the DCO sign-off content updates accordingly — your past contributions remain under the license at sign-off time, new contributions under new license.

---

## License

**当前 / Current**: [Business Source License 1.1](LICENSE) — 商业保护期,**Change Date 2030-05-18 自动转 MIT**(`LICENSE` 文件 hardcoded)。
**Current**: BSL 1.1 — commercial protection period, auto-converts to MIT on **Change Date 2030-05-18** (hardcoded in `LICENSE`).

详细条款见 [CHARTER §4 I-2](docs/CHARTER.md#i-2-license-演化锁定--license-evolution-lock)。
Full terms see [CHARTER §4 I-2](docs/CHARTER.md#i-2-license-演化锁定--license-evolution-lock).

### License invariants (CHARTER §4)

永远 / Always:
- license 不能比"最终 MIT"更严格 / license never stricter than "final MIT"
- 不允许延后 Change Date(2030-05-18 hard-locked)/ no delay of Change Date
- 不允许在 Change Date 前转向更严格(SSPL / proprietary)/ no transition to stricter before Change Date
- 任何 license 调整需 user + 2/3 maintainer 多签 + 60 天公示(且不能违反以上 3 条)/ any adjustment requires user + 2/3 maintainer multisig + 60-day public notice
