# Public Contributor Entry + Agent Quickstart / 公开贡献者入口 + Agent 快速上手

> **Contribute first, bind later. / 先贡献,后认领。**
> Your first contribution can be a single merged GitHub PR — you can create a WebAZ Passkey account and
> **claim** it later. 你的第一份贡献可以只是一个合并的 GitHub PR——之后再注册 WebAZ Passkey 账号来**认领**它。

> ⚠️ **Everything here is `uncommitted`.** WebAZ records and shows contribution, but **promises no reward,
> right, income, percentage, amount, currency, yield, or payout** — there is **no reward formula** and
> **no payout**. Metering / display is **not** a reward promise. 一切均为 `uncommitted`:记录与展示贡献,
> 但**不承诺**任何奖励/权益/收益/百分比/金额/币种/兑付,**没有奖励公式、没有兑付**;计量/展示**不是**奖励承诺。
> Boundary authority: [`RFC-017`](rfcs/RFC-017-contribution-protocol-v1.md) I-12 ·
> [`CONTRIBUTOR-ENTRY-RELATIONSHIP-GRAPH-V1.md`](CONTRIBUTOR-ENTRY-RELATIONSHIP-GRAPH-V1.md).

This is the low-friction, deterministic front door for **anyone** — a stranger to the project, an **AI
agent** user, or a current / former employee of a larger company. 本文是面向**所有人**(项目陌生人、**AI
agent** 使用者、大厂在职/前员工)的低门槛、确定性入口。

---

## §1 Start small — your first contribution / 从小处开始

Pick something small and verifiable: documentation, a translation, a test, an SDK example, a typed
error-handling fix, a reproducible bug report. Open a **PR / issue / task / RFC** in the project's
recognized flow. 选一件小而可验证的事:文档、翻译、测试、SDK 示例、类型/错误处理修复、可复现的 bug 报告;
在项目认可的流程里开 **PR / issue / task / RFC**。

- **Every real contribution — even a single line — should be remembered.** But being remembered is
  *metering / attribution*, **not** a reward promise. **每一份真实贡献,哪怕一行代码,都应被记住**;但"被记住"
  是*计量/署名*,**不是**奖励承诺。
- **A local sandbox or a private draft is not participation.** Only work submitted into the project's
  recognized flow (a PR / issue / task / RFC) enters the contribution record. **本地 sandbox / 私有草稿不算
  参与**;只有提交进项目认可流程(PR / issue / task / RFC)的工作才会进入贡献记录。
- Don't use production secrets, real user data, or real funds operations. High-risk paths must go through
  the higher-audit process. 不要使用生产 secret、真实用户数据或真实资金操作;高风险路径必须走高审计流程。

## §2 Bring your agent — legally / 让你的 agent 合法参与

An **agent is only an executor**; the **accountable party** is a real human or organization. An agent may
do the work, but it cannot itself claim any future right. **agent 只是 executor**;**accountable party** 是
真人或组织。agent 可以干活,但不能自己认领任何未来权益。

- **DCO sign-off is required** (`git commit -s`). A real person takes responsibility for what an agent
  produces. **必须 DCO sign-off**(`git commit -s`);真人为 agent 的产出担责。
- Keep agents away from production secrets / real user data / real money. 让 agent 远离生产 secret / 真实
  用户数据 / 真实资金。
- See [`AGENT-READY-TASK-SPEC.md`](AGENT-READY-TASK-SPEC.md) for agent-runnable task definitions.

## §3 GitHub-first: contribute now, claim later / GitHub 优先:先贡献,后认领

A merged GitHub PR is recorded as an immutable contribution fact against your **GitHub identity** — before
you have any WebAZ account. Later you prove control of that GitHub identity and bind a **Passkey**-backed
WebAZ account (the shipped identity-**claim** flow); the **claim** binds attribution and accountability. It
does **not** by itself create any redemption right (still `uncommitted`). 合并的 GitHub PR 会作为不可变贡献
事实记在你的 **GitHub 身份**上(此时你还没有 WebAZ 账号);之后你证明拥有该 GitHub 身份并绑定一个 **Passkey**
WebAZ 账号(已上线的身份**认领**流程);**认领**绑定署名与问责,本身**不**产生任何兑付权(仍为 `uncommitted`)。

## §4 Register early for a formal relationship / 尽早注册以形成正式关系

Only **after** you register a WebAZ account do you get your own **`permanent_code` / invite link**, and only
then can you form a **formal** referral / binary-tree relationship — by inviting newcomers with that code.
只有在你**注册** WebAZ 账号**之后**,你才拿到自己的 **`permanent_code` / invite link**,也才能用它邀请新人
形成**正式**的推荐 / 二叉树关系。

**So: register early and use your own invite link** if you want your referrals to count in the formal tree.
**所以:想让你的推荐进入正式关系树,就尽早注册并使用自己的 invite link。**

## §5 Pre-registration GitHub-first referral = evidence, not a position / 注册前的 GitHub 推荐 = 证据,不是位置

A GitHub-first referral made **before** registration is kept only as **contribution / propagation
evidence** — `uncommitted` context. It is **not** a formal binary-tree position and **promises no future
income**. 注册**之前**的 GitHub 推荐只作为**贡献 / 传播证据**保留(`uncommitted` 上下文);它**不是**正式二叉树
位置,**不承诺任何未来收益**。

**No post-hoc tree rewrite.** Formal sponsor / binary-tree placement is fixed at WebAZ registration; a
pre-registration GitHub-first referral can **never** retroactively rewrite the `sponsor_id` /
`placement_id` / `placement_side` formed at real registration time. **不得事后改写关系树**:正式 sponsor /
二叉树位置在 WebAZ 注册时确定;注册前的 GitHub 推荐**绝不能**回溯改写真实注册时形成的位置。

## §6 What we promise — and don't / 我们承诺什么、不承诺什么

- ✅ We promise to **record your contribution accurately** and to **let you claim** it. 我们承诺**准确记录**
  你的贡献,并**允许你认领**。
- ❌ We do **not** promise how much it is worth, or that any redemption will ever occur. Reward / economics
  / legal / KYC are **all** still `uncommitted` and gated behind a separate, higher-audit RFC/PR. 我们**不**
  承诺它值多少、是否会兑付;奖励 / 经济 / 法律 / KYC **全部**仍为 `uncommitted`,且门控在独立的高审计 RFC/PR 之后。

> **For employees of larger companies / 给大厂在职或前员工:** contribute on your **own time**, follow your
> employer's open-source / IP policy, and never bring a former employer's code, internal designs, or
> confidential information. You may submit ideas anonymously, but code contributions still need DCO
> sign-off. 用你**自己的时间**贡献,遵守雇主的开源 / IP 政策,不要带入前雇主的代码、内部设计或保密信息;
> 你可以匿名提想法,但代码贡献仍需 DCO sign-off。

---

**Read next / 延伸阅读:** [`CONTRIBUTOR-ENTRY-RELATIONSHIP-GRAPH-V1.md`](CONTRIBUTOR-ENTRY-RELATIONSHIP-GRAPH-V1.md)
(the full entry / relationship boundary) · [`rfcs/RFC-017-contribution-protocol-v1.md`](rfcs/RFC-017-contribution-protocol-v1.md)
(the contribution protocol) · 
[`../CONTRIBUTING.md`](../CONTRIBUTING.md) · [`AGENT-READY-TASK-SPEC.md`](AGENT-READY-TASK-SPEC.md).
