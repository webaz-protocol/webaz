# RFC-XXX: [Title / 标题]

<!-- 复制本文件为 RFC-NNN-short-slug.md,填空。XXX 占位待 maintainer 分配编号。 -->
<!-- Copy this to RFC-NNN-short-slug.md and fill in. Maintainer assigns NNN. -->

**Status**: draft
**Author**: @your-handle
**Created**: YYYY-MM-DD
**Track**: normal (14d) / meta-rule (60d) / emergency (24h) / exploratory
**Related issue**: #N
**Supersedes**: (n/a or RFC-MMM)
**Superseded by**: (n/a)

---

## Summary / 摘要

<!-- 一段话:本提案做什么 + 为什么 / One paragraph: what + why -->

## Motivation / 动机

<!--
解决什么问题、为什么现状不够。
What problem, why current state insufficient.
-->

## Design / 设计

<!--
详细方案、数据流、状态机变化、影响的模块。
Detailed design, data flow, state-machine changes, affected modules.
-->

## Meta-rule impact / 元规则影响

<!--
对照 10 元规则(#1-#10,见 docs/META-RULES-FULL.md),列出哪些被影响、哪些被增强。
Cross-check #1-#10 from META-RULES-FULL.md.

注意:Iron-Rule 不是元规则,但要单独评估技术边界影响。
Note: Iron-Rule is not a meta-rule; assess its technical boundary impact separately.
-->

- #1 当一切可见:
- #2 代码即规则:
- #3 不偷数据:
- #4 不撒谎:
- #5 不偏袒:
- #6 不滥用:
- #7 不操纵:
- #8 最小介入:
- #9 算法即协议:
- #10 参与者即 webazer:
- Iron-Rule 技术边界:

## Alternatives / 替代方案

<!--
至少列 2 个替代方案,并说明为什么不选。防止 RFC 是 fait accompli。
At least 2 alternatives with reasons rejected. Prevents fait accompli RFCs.
-->

### Alt 1: ...

(Reason rejected: ...)

### Alt 2: ...

(Reason rejected: ...)

## Migration & compatibility / 迁移与兼容

<!--
现有数据怎么处理?现有 agent 行为怎么过渡?需要废弃哪些 API?
Existing data, agent behavior transition, deprecated APIs.
-->

## Risks / 风险

<!--
安全、经济、信任、操纵、滥用各维度。想象本提案在 prod 跑 30 天可能出什么错。
Security, economic, trust, manipulation, abuse dimensions.
Imagine this in prod for 30 days — what might break.
-->

## Test plan / 测试计划

<!-- 如何验证本提案的实现 / How to verify implementation -->

## Pre-flight checklist / 提交前自查

- [ ] 我已读 [`CHARTER.md §6`](../CHARTER.md) (修改流程)和 [`§3.2`](../CHARTER.md) (多签矩阵)
- [ ] 我已对照 [`META-RULES-FULL.md`](../META-RULES-FULL.md) 全部 10 条,不只是表面相关的
- [ ] 我理解【绕过 ≠ 修改】 Iron-Rule — 本提案不通过技术手段绕过 Iron-Rule 的 7 条真人 Passkey 路径
- [ ] 若本提案修改 Iron-Rule 边界或元规则 #1-#10 文字,我选了 "meta-rule" track (60d + multi-sig)
- [ ] 至少列了 2 个替代方案并说明为什么不选

## Implementation tracking / 实现追踪

<!-- accepted 后填:实现 PR / commit SHA / 关闭的 issue -->

- PR:
- Commit:
- Closes issue:

---

**Status history / 状态变更**:

- YYYY-MM-DD: draft created by @author
- YYYY-MM-DD: review entered (14d / 60d / 24h notice period)
- YYYY-MM-DD: accepted / rejected / deferred / implemented
