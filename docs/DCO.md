# Developer Certificate of Origin / 开发者源码证书

WebAZ 用 **DCO 1.1**(Developer Certificate of Origin,Linux Foundation 标准)而**不是** CLA(Contributor License Agreement)管理 contribution 的 license 归属。

WebAZ uses **DCO 1.1** (Developer Certificate of Origin, Linux Foundation standard) instead of a CLA (Contributor License Agreement) to manage contribution licensing.

> 📚 这是规范文件(Reference);完整治理流程见 [`CONTRIBUTING.md`](../CONTRIBUTING.md) + [`CHARTER §4 I-2`](CHARTER.md)。
> Reference doc; full process in `CONTRIBUTING.md` + `CHARTER §4 I-2`.

---

## 🤔 为什么 DCO 而不是 CLA / Why DCO not CLA

| | CLA(传统大公司模式) | **DCO(WebAZ 选择)** |
|---|---|---|
| 提交者要 | 签法律协议(签字 / DocuSign / 表单)| **每个 commit 加一行** `Signed-off-by:` |
| 含义 | "我把版权转让给项目所有者" | "我声明我有权贡献这段代码" |
| 摩擦 | 高(第一次贡献要走法务)| 低(`git commit -s` 一个 flag) |
| 版权归属 | 转给项目方 | **保留在原作者** |
| 适合 | 单一公司主导的项目 | **去中心化 / 多源 contribution** |
| Linux / git / k8s 等用 | ❌ | ✅ |

WebAZ 选 DCO 因为 **#10 参与者即 webazer** + **#5 不偏袒** — contributor 不应该向 project owner 转让版权,所有贡献者地位对等。

WebAZ chose DCO because **#10 (participants are webazers) + #5 (no favoritism)** — contributors shouldn't transfer copyright to a project owner; all contributors are equal.

---

## 📜 DCO 1.1 全文 / Full Text

以下为 DCO 1.1 标准文本,**不可修改**(否则 contributor 签的不是 DCO 1.1)。
Below is the DCO 1.1 standard text, **NOT modifiable** (otherwise contributors aren't signing DCO 1.1).

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

### 中文译本(参考用,不替代英文原文)/ Chinese translation (reference only, English authoritative)

```
开发者源码证书
版本 1.1

通过向本项目贡献代码,我证明:

(a) 该贡献全部或部分由我创作,且我有权按文件中指明的开源许可证提交;或

(b) 该贡献基于先前作品,据我所知该作品有适当的开源许可证保护,我有权
    按该许可证提交此作品(无论是否经我修改),按同一开源许可证(除非
    我被允许按不同许可证提交)发布;或

(c) 该贡献由其他证明 (a)、(b) 或 (c) 的人直接提供给我,我未对其修改。

(d) 我理解并同意:本项目和此贡献是公开的,贡献记录(包括我提交时附带
    的所有个人信息,含 sign-off)将被永久保留,并可能按本项目或相关
    开源许可证的要求被再分发。
```

---

## 📌 WebAZ-specific:DCO + License 演化兼容性 / DCO + License Evolution Compatibility

DCO 1.1 (a) 提到 "the open source license **indicated in the file**" — 但 WebAZ 的 license 是**演化中**的(BSL 1.1 → 2030-05-18 自动转 MIT,见 [`CHARTER §4 I-2`](CHARTER.md))。本段明示这个演化对 DCO sign-off 的影响。

DCO 1.1 (a) references "the open source license indicated in the file" — but WebAZ's license is **evolving** (BSL 1.1 → auto-MIT on 2030-05-18). This section clarifies the impact on DCO sign-offs.

当你按 DCO 签名贡献时,你同意 / When you sign-off via DCO, you agree:

| | 中文 | English |
|---|---|---|
| 1 | 你的贡献按**项目当前 license:BSL 1.1** 发布 | Your contribution is published under the project's current license: BSL 1.1 |
| 2 | Change Date(**2030-05-18**)自动转 MIT 后,你的贡献继续按 MIT 发布 | When BSL 1.1 auto-transitions to MIT on Change Date, your contribution continues under MIT |
| 3 | BSL→MIT 转换已 **baked-in 在 LICENSE 文件**,**无需重签或追认** | The transition is baked-in to LICENSE; **no re-signing or re-acknowledgment** required |
| 4 | **一次 sign-off 永久有效**,跟随项目 license 演化(**只能转更开,不能转更严**) | One sign-off remains valid as license evolves (only more open, never more restrictive) |

**License invariants(见 [`CHARTER §4 I-2`](CHARTER.md))/ License invariants**:

- ❌ 不允许在 Change Date 前转更严格(SSPL / proprietary 等)/ No transition to stricter before Change Date
- ✅ 允许在 Change Date 前**提前**转 Apache-2.0 / MIT(开放方向)/ Early transition to more permissive license allowed
- ❌ 不允许延后 Change Date(2030-05-18 hard-locked)/ No delay of Change Date

→ 这是 #1 当一切可见 + #2 代码即规则 + #4 不撒谎 的法律层兑现:LICENSE 文件即合同条款,演化路径在代码层 baked-in。
→ Realizes #1 + #2 + #4 at the legal layer: LICENSE file IS the contract, evolution path is code-locked.

---

## 🖋 如何 sign-off / How to sign-off

### 单个 commit / Single commit

```bash
git commit -s -m "fix: 修复某 bug"
```

`-s` flag 自动追加 `Signed-off-by: 你的名字 <你的 email>` 到 commit message 末尾。

The `-s` flag automatically appends `Signed-off-by: Your Name <your@email>` to the commit message.

### 已经 commit 但忘了 sign-off / Already committed without sign-off

```bash
# 最近一个 commit:
git commit --amend -s --no-edit

# 多个 commit(interactive rebase):
git rebase -i <base-branch>
#   把每个 commit 的 'pick' 改成 'edit'
#   对每个:git commit --amend -s --no-edit && git rebase --continue

# 改完后:
git push --force-with-lease
```

### 验证 sign-off / Verify

```bash
git log -1 --format=%B
# 应看到末尾有 / Should see at the end:
#   Signed-off-by: Your Name <your@email>
```

---

## 🤖 AI agent 协作的 DCO / DCO for AI-agent collaboration

WebAZ 的 `.github/workflows/ci.yml` **DCO check job** 接受**两种**等价签名:

WebAZ's CI accepts **two equivalent** signature forms:

1. **`Signed-off-by:`** — 你亲手或工具 wrap 时加 / human-typed or wrapped by tools
2. **`Co-authored-by:`** — AI agent 协作时由 monitoring tool / IDE / git hook 加 / added by AI tooling

### 示例 / Example

```
feat(wallet): 加 deposit timeout 告警

Implements 24h timeout warning when deposit not confirmed.

Co-authored-by: Claude Opus 4.7 <noreply@anthropic.com>
Signed-off-by: Holden K <holden@example.com>
```

**这一行 DCO check 就通过**(满足任一即可),但**推荐两个都有**:

- `Signed-off-by` = 人类 custodian 确认 DCO(a)(b)(c)(d) 4 条
- `Co-authored-by` = 透明披露 AI 协作(参考 [`CHARTER`](CHARTER.md) AI agent 共建条款)

Either passes the DCO check, but **both recommended**: Signed-off-by certifies DCO clauses; Co-authored-by transparently discloses AI collaboration.

⚠️ **custodian 责任 / Custodian accountability**:

### AI agent 不能独立 sign-off — 法律人格视角 / Why AI can't independently sign-off — legal personhood

DCO 1.1 (a)(b)(c)(d) **不只是事实声明**(我做了什么),**更是法律承诺**(我有权做 + 我承担相关责任)。

DCO clauses are **not just factual claims** (what I did), but **legal commitments** (I have the right + I bear liability).

AI agent 当前**没有法律人格**,无法承担 DCO 的法律责任 / AI agents currently have **no legal personhood**:
- ✗ 无法被起诉 / 担责 / Cannot be sued / held liable
- ✗ 无法拥有或转让代码版权 / Cannot own or transfer code copyright
- ✗ 无法行使作者权利 / Cannot exercise authorship rights

→ DCO 的 "I" **必须是有法律人格的人类**(custodian)。AI 可以**协作创作**(`Co-authored-by:` 透明披露),但 DCO **法律责任由人类承担**(`Signed-off-by:` 必须是人)。
→ DCO "I" **must be a human with legal personhood** (custodian). AI can co-create (via `Co-authored-by:`), but DCO **liability belongs to humans** (`Signed-off-by:` must be human).

→ 与元规则 #10 参与者即 webazer 一致 — 人是责任主体。
→ Consistent with #10 (participants are webazers) — humans are accountability subjects.

### Custodian 默认规则 / Default custodian rule

| 场景 / Scenario | Custodian 默认 / Default |
|---|---|
| commit 只有 1 个 `Signed-off-by:` | 该人即 custodian / That person is the custodian |
| 多人 sign-off(co-developed)| 任一 sign-off 都是 valid custodian / Any sign-off is a valid custodian |
| AI 协作(`Co-authored-by: AI` + `Signed-off-by: human`)| **触发 AI 的那个人类** = custodian(必须有 Signed-off-by)/ The human who invoked the AI |
| 完全 AI 生成无人 sign-off | ❌ **DCO fail** — 无 custodian = 拒绝合并 / DCO fail — no custodian = reject merge |

显式标注(可选,webaz 自定义 trailer,非 git 标准)/ Explicit annotation (optional, WebAZ custom trailer, non-standard):

```
Custodian: @your-handle
```

PR template 第一项("Change category")的 AI agent 披露段会自动 prompt `Model + Custodian`,收集到 PR description(治理脚手架,非 git 原生)。
The PR template's AI agent disclosure auto-prompts for `Model + Custodian` (governance scaffolding, not native git).

---

## 🛡 CI enforcement

`.github/workflows/ci.yml` 的 `dco-check` job:
- 只在 **PR 触发**(direct push to main 跳过 — phase A solo founder 流程)
- 正则:`'^(Signed-off-by|Co-authored-by):[[:space:]]+.+[[:space:]]+<[^@]+@[^>]+>'`
- 大小写**不敏感**(`Co-Authored-By` / `co-authored-by` 都过)
- 邮箱**必填**(name + `<email@host>` 完整格式)

若 fail,CI 会给修复命令(`git rebase -i ...` + `--amend -s --no-edit`)。
On fail, CI prints fix commands.

---

## 🤐 拒签 / 匿名贡献 / Refusing DCO or anonymous contribution

WebAZ 是**知情同意框架**(对照元规则 #1 当一切可见 + #10 参与者即 webazer),拒签 / 匿名都是合法选项,不被歧视。
WebAZ is an **informed-consent framework** (per #1 + #10); refusing DCO / contributing anonymously are legitimate options, not penalized.

### 如果你反对 DCO 政策 / If you object to DCO

- 短期内 webaz **不接受非 DCO commit** / Currently webaz does NOT accept non-DCO commits
- 可提 **RFC 修订 DCO 政策**(走 [`CHARTER §6`](CHARTER.md) 修订流程)/ You may file an RFC to revise the DCO policy
- RFC 通过前,贡献只能通过 **issue / discussion / RFC 文字** 方式 / Until accepted, contributions only via issue / discussion / RFC text

### 如果你想匿名贡献 / If you want to contribute anonymously

- ✅ 可以使用 **pseudonym + 专用 email** / Use pseudonym + dedicated email
- 例 / Example: `Signed-off-by: anon-webazer <anon-1234@protonmail.com>`
- 仍需满足 DCO 4 条声明(你声明你有权贡献)/ Must still satisfy all 4 DCO clauses
- 仍受元规则 + Code of Conduct 约束 / Still bound by meta-rules + CoC
- **完全保留你的法律权利**(只是不公开真名)/ Your legal rights fully preserved (only the real name is private)

### 如果你担心被起诉 / 失去版权 / If worried about lawsuits or copyright loss

- DCO **不剥夺**你的版权 — 版权保留在你手上 / DCO does **NOT** transfer your copyright — you keep it
- DCO 只是**你声明有权贡献**,不是**你转让版权** / DCO is "I have the right to contribute", not "I assign copyright"
- 这是 DCO 跟 CLA 的本质差别(见本文顶部对比表)/ This is DCO's fundamental difference from CLA (see comparison table above)

参考 / See: [`CHARTER §3 5-tier contributor ladder`](CHARTER.md) + [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) §8 enforcement ladder(注:contributor ladder ≠ enforcement ladder,两套不同 / Note: contributor ladder ≠ enforcement ladder, two distinct systems)

---

## 📚 参考 / References

- [DCO 1.1 原文(linuxfoundation.org)](https://developercertificate.org/) / Official DCO 1.1
- [Linux kernel 关于 sign-off 的说明](https://docs.kernel.org/process/submitting-patches.html#sign-your-work-the-developer-s-certificate-of-origin) / Linux kernel sign-off docs
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — full PR workflow
- [`CHARTER §4 I-2`](CHARTER.md) — license invariant
- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — CI enforcement
- [`.github/dep-license-policy.md`](../.github/dep-license-policy.md) — 依赖 license 政策(贡献 vs 依赖双层 check)/ Dependency license policy (contribution-layer vs dep-layer, double-layer compliance)
- [`SECURITY.md`](../SECURITY.md) — security report flow (also uses DCO for fix PRs)

---

**Last reviewed**: 2026-06-01
**Status**: Reference doc — DCO 1.1 standard text frozen; WebAZ wrapper evolvable via CHARTER §6
