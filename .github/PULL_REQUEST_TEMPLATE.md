<!--
WebAZ Pull Request Template

🇨🇳 中文 / 🇬🇧 English — 都可以,但请保留两部分骨架,方便跨语言审阅。
Either language is fine, but keep both section skeletons for cross-language reviewers.

📚 提交前请读: CONTRIBUTING.md + CHARTER §3.2 (多签矩阵) + META-RULES-FULL.md (相关条目)
📚 Before submitting: CONTRIBUTING.md + CHARTER §3.2 (multisig matrix) + META-RULES-FULL.md
-->

## Summary / 摘要

<!--
一句话说明这个 PR 做了什么 + 为什么。focus on WHY, not just WHAT。
One sentence: what + why. Focus on WHY.
-->

## Change category / 改动类别

<!-- 勾选一个主要类别 / Check ONE primary category -->

- [ ] 🐛 Bug fix (功能性 bug,无安全影响 / functional bug, no security impact)
- [ ] ✨ Feature (新功能或现有功能增强 / new feature or enhancement)
- [ ] 📜 Meta-rule revision (修订 10 元规则之一 — 需要 RFC + 60d + 多签)
- [ ] 🔧 Protocol parameter (修改费率/超时/阈值 — 需要 RFC + 14d)
- [ ] 🏛 Charter / governance (治理文档变更)
- [ ] 📚 Docs only (纯文档,无代码影响)
- [ ] 🧪 Tests only (纯测试,无代码影响)
- [ ] 🔨 Refactor (重构,无外部行为变化)
- [ ] 🛡 Security fix (**必须先走 GitHub Security Advisory**;advisory ID 填到下方 Linked issues / must go through Security Advisory first; put advisory ID in Linked issues)
- [ ] 🚨 Emergency security multisig (CHARTER §3.2:24h 无响应触发,任 2 maintainer + user 14d 追认 / 24h-no-response trigger, any 2 maintainers + user retro-confirm within 14d)

## Linked issues / 关联 issue

<!-- Closes #123 / Refs #456 / RFC #789 / Advisory GHSA-xxxx-xxxx-xxxx -->

Closes #
Refs RFC #
Refs Advisory:  <!-- 若 Security fix,填 GHSA ID;否则留空 / If Security fix, fill GHSA ID; else leave blank -->

## Meta-rule trace / 元规则对照

<!--
本 PR 是否触及 10 元规则之一?(#1-#10 见 docs/META-RULES-FULL.md)
即使你认为不触及,也请简短说明对照过哪几条。

Does this PR touch any of the 10 meta-rules? Even if not, briefly explain which you cross-checked.
注:本 repo 已有 M1-M7(协议里程碑)/ M1-M3(开放协作 milestone)— 元规则用 #1-#10 区分,勿混。
Note: this repo also uses M1-M7 (protocol milestones) and M1-M3 (open-collab milestones). Meta-rules use #1-#10 to disambiguate.
-->

- [ ] 我对照过 #1-#10,本 PR 不涉及任何元规则变更 / I cross-checked #1-#10, no meta-rule impact
- [ ] 本 PR 增强某条元规则的执行(说明:)
- [ ] 本 PR 修订某条元规则(必须有对应 accepted RFC)
- [ ] 本 PR 触碰 Iron-Rule(技术边界,对应 #4 不撒谎 + #5 不偏袒 + #6 不滥用 + #7 不操纵)的 7 条路径之一(投票/仲裁/agent_revoke/delete_passkey/revoke_key/rotate_key/wallet 操作)

具体说明 / Specifics:

## Test plan / 测试计划

<!-- 列出验证方式 — 自动测试 + 手测都可以 / Auto tests + manual checks both fine -->

- [ ] `npm run build` 通过 / passes
- [ ] `npm run schema:verify` 通过 / passes
- [ ] 浏览器手测路径:
- [ ] MCP 工具手测(如适用):
- [ ] 写了新的 test(`tests/test-*.ts` 或 `.sh`):

## Risks / 风险

<!-- 想象本 PR 在 prod 跑了 24 小时,可能出什么错? / Imagine this in prod for 24h — what might break? -->

## Pre-flight / 提交前自查

- [ ] 我已读 [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] commit message 遵循 conventional commits + 元规则 trace(`refs #5 不偏袒` 或 `meta:none`)
- [ ] 我已用 DCO sign-off (`git commit -s`) — 我同意 [Developer Certificate of Origin](../docs/DCO.md)
- [ ] 没有引入 prod 数据 / 真实用户 PII / API key 到 repo
- [ ] 没有让 AI agent 代替我做需要 Iron-Rule 真人 Passkey 的操作
- [ ] 引入的依赖 license 与 BSL 1.1 兼容(避免 AGPL / SSPL / 其他不兼容 license)/ Dependency licenses compatible with BSL 1.1 (avoid AGPL / SSPL / incompatible)
- [ ] 文档同步更新(若改 API、配置、行为)
- [ ] 双语 UI 字符串(若新增 UI 文案)

## AI agent disclosure / AI 协作披露

<!--
本 PR 由 AI agent 协作完成?WebAZ 鼓励透明披露,不影响 review。
This PR was co-authored with an AI agent? WebAZ encourages transparent disclosure — doesn't affect review.
-->

- [ ] 全部由人手写 / Fully hand-written by human
- [ ] AI 协作(模型 + 监护人 / Model + custodian):

<!-- 例如 / e.g.(GitHub 标准约定:Co-authored-by,只 C 大写;CI 实际大小写不敏感)
Co-authored-by: Claude Opus 4.7 <noreply@anthropic.com>
Custodian: @seasonkoh (responsible for review and merge)
-->
