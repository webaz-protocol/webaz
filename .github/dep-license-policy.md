# Dependency License Policy / 依赖 license 政策

新增 / 升级依赖时,必须确保其 license 与 WebAZ 兼容。本政策由 PR template `Pre-flight checklist` 引用。

When adding / upgrading dependencies, ensure license compatibility with WebAZ. Referenced by PR template's pre-flight checklist.

> 📚 WebAZ license context:**BSL 1.1**(当前)→ **2030-05-18 自动转 MIT**(见 [`LICENSE`](../LICENSE) / [`NOTICE`](../NOTICE) / [`CHARTER §4 I-2`](../docs/CHARTER.md) / [`docs/DCO.md`](../docs/DCO.md))。
> 兼容性需同时满足**当前 BSL 期间** + **Change Date 之后的 MIT 期间**。
> Must satisfy both BSL period AND post-Change-Date MIT period.

---

## ⚠️⚠️ 最大风险:传递依赖 / Top risk: Transitive dependencies

**直接依赖 license 干净 ≠ 安全。**
**Clean direct deps does NOT mean safe.**

99% 的 license 事故来自**传递依赖**(transitive),不是直接依赖。
一个 MIT 直接依赖可能拉进几十个传递依赖,其中可能藏 GPL / 未声明 license。
99% of license incidents come from **transitive deps**, not direct deps.
A single MIT direct dep can pull in dozens of transitives, possibly hiding GPL / unspecified licenses.

**强制要求 / Mandatory**:
- 每次 `npm install` 后跑 / After every `npm install`:
  ```bash
  npx --yes license-checker --production --summary
  ```
- **launch 前必须跑 full audit**(含全部 transitive),不只是直接依赖
- **Before each public release: full audit required** including all transitives, not just direct
- CI(W4+)必须扫 production 全树 / CI must scan full production tree
- 发现传递依赖红区 → 找替代**直接依赖**或锁版本 / Find alternative direct dep or pin version

→ 这是元规则 #1 当一切可见 — 风险必须被看到,不能埋在依赖树里。
→ Per #1 (visibility) — risks must be seen, not buried in dep tree.

---

## 🎯 兼容性矩阵 / Compatibility Matrix

### 🟢 永远兼容 / Always OK(无需 review,自由引入)

| License | 备注 / Note |
|---|---|
| **MIT** / MIT-0 | webaz 当前主要依赖类型 / WebAZ's primary dep type |
| **BSD-2-Clause** / BSD-3-Clause | 无 advertising clause / No ad clause |
| **Apache-2.0** | 含专利 grant / Includes patent grant |
| **ISC** | Functionally equivalent to MIT |
| **0BSD** | Permissive 极简 / Ultra-permissive |
| **Unlicense** | Public domain dedication |
| **CC0-1.0** | Public domain dedication |
| **MPL-2.0** | File-level copyleft,**文件级**,不感染 webaz 主代码 / File-level copyleft, doesn't infect main code(用法:运行时引用 MPL dep ✓ 自由 / 修改 MPL 文件并 redistribute → 该文件继续 MPL,但 webaz 其他文件不受影响 / Use MPL dep at runtime = free; modify+redistribute MPL files = that file stays MPL, rest of webaz unaffected) |

### 🟡 条件兼容 / Conditional(PR review 时人工判断)

| License | 触发条件 / Trigger | 需附加动作 / Required action |
|---|---|---|
| **LGPL-2.1** / LGPL-3.0 | npm 包都是动态 link → OK | NOTICE 加 LGPL attribution + 链 source |
| **BSD-4-Clause** | "obnoxious advertising clause" | NOTICE 加 advertising text |
| **CC-BY-4.0** / 其他 CC-BY | 需 attribution / Requires attribution | NOTICE 加致谢 + 链原作者 |
| **BSL 1.1**(其他项目)| 看其 Change Date + Additional Use Grant | case-by-case;若 Change Date 早于 webaz 即 OK |
| **Eclipse Public License 1.0 / 2.0** | 弱 copyleft,文件级 | NOTICE 加 EPL attribution |
| **Mozilla Public License 1.1** | 已被 MPL 2.0 取代,旧项目可能用 | 强烈建议找 MPL-2.0 替代 |

### 🔴 不兼容 / Forbidden(PR 必拒)

| License | 不兼容原因 / Why forbidden |
|---|---|
| **GPL-2.0** / GPL-3.0 | 强 copyleft — 会感染 webaz 主代码,迫使整个项目转 GPL |
| **AGPL-3.0** | Viral over network — 任何用 AGPL 库的网络服务必须开源 |
| **SSPL** | MongoDB 式 — 要求"运行所需所有服务"开源,与商业 grant 冲突 |
| **Commons Clause** / 任何附加商业限制 | 与 BSL 1.1 Additional Use Grant 冲突 |
| **CC-BY-NC** / 任何 NC(非商业)variants | 禁商业用,与 BSL 1.1 commercial grant 冲突 |
| **专有 / Proprietary** 无 grant | 默认不可用 |
| **未声明 / 缺失 LICENSE 文件** | 默认不可用 — license unknown = no permission |

---

## 🛠 如何检查 / How to verify

### 单次检查 / One-shot check

```bash
# 列所有 deps 的 license(需要 npx license-checker,不需要本地安装)
npx --yes license-checker --production --summary

# 详细看每个 dep 的 license + 来源
npx --yes license-checker --production --json | jq 'to_entries[] | {pkg: .key, license: .value.licenses}'
```

### 新增 dep 前先验 / Verify before adding

```bash
# 查目标包的 license(不实际安装)
npm view <package-name> license
# 例 / e.g.:
npm view zod license   # → "MIT" ✓
npm view mongodb license   # → "Apache-2.0" ✓
npm view bull license  # → "MIT" ✓
```

### CI 自动 check(W4+ 规划 / Future)

当前**手动 PR review**,W4+ 规划加 CI step。**用白名单(default-deny)而不只是黑名单**:
Currently manual PR review; W4+ plan CI step. **Use whitelist (default-deny), not just blacklist**:

```bash
# 推荐:白名单模式(任何不在白名单的 license 自动拒)
# Recommended: whitelist mode (auto-reject anything not whitelisted)
npx license-checker --production --onlyAllow \
  'MIT;BSD-2-Clause;BSD-3-Clause;Apache-2.0;ISC;0BSD;Unlicense;CC0-1.0;MPL-2.0'

# 配合:显式黑名单(完整 SPDX,含 -only / -or-later 变体)
# Complement: explicit blacklist (full SPDX, including -only / -or-later variants)
npx license-checker --production --failOn \
  'GPL-2.0-only;GPL-2.0-or-later;GPL-3.0-only;GPL-3.0-or-later;AGPL-3.0-only;AGPL-3.0-or-later;SSPL-1.0;CC-BY-NC-4.0;CC-BY-NC-SA-4.0'
```

⚠️ **为什么白名单优先 / Why whitelist first**:
- 黑名单(`--failOn`)漏 **Commons Clause / 未声明 license**(无 SPDX 匹配)
- 白名单(`--onlyAllow`)是 **fail-safe default-deny** — 任何不在白名单的都拒,自动覆盖"未声明 = 不可用"政策
- SPDX 2.x 用 `GPL-3.0-only` / `GPL-3.0-or-later`,**不是** `GPL-3.0`(旧标识符)— 黑名单要列全变体
- Blacklist (`--failOn`) misses **Commons Clause / unspecified licenses** (no SPDX match)
- Whitelist (`--onlyAllow`) is **fail-safe default-deny** — auto-covers "no permission = unspecified" policy
- SPDX 2.x uses `GPL-3.0-only` / `GPL-3.0-or-later`, **not** `GPL-3.0` — blacklist must list all variants

---

## ✅ 当前 deps 状态 / Current deps status

**所有直接 deps 均为 🟢 白名单**(2026-06-01 audit verified)。

**Verify 方法**(可复现 / reproducible):
```bash
for pkg in $(jq -r '.dependencies, .devDependencies | keys[]?' package.json); do
  printf "%-30s v%-12s %s\n" "$pkg" "$(npm view $pkg version)" "$(npm view $pkg license)"
done
```

**实测输出 / Verified output**(2026-06-01,via `npm view <pkg> license`):

```
production deps (10):
  @anthropic-ai/sdk              v0.100.1        MIT
  @modelcontextprotocol/sdk      v1.29.0         MIT
  @simplewebauthn/server         v13.3.1         MIT
  @types/qrcode                  v1.5.6          MIT
  better-sqlite3                 v12.10.0        MIT
  express                        v5.2.1          MIT
  qrcode                         v1.5.4          MIT
  undici                         v8.3.0          MIT
  viem                           v2.51.3         MIT
  zod                            v4.4.3          MIT

devDependencies (5):
  @types/better-sqlite3          v7.6.13         MIT
  @types/express                 v5.0.6          MIT
  @types/node                    v25.9.1         MIT
  tsx                            v4.22.4         MIT
  typescript                     v6.0.3          Apache-2.0   ← 非 MIT,但在 🟢 绿区
```

→ 全部绿区。无需 NOTICE 更新或额外 attribution(Apache-2.0 需 attribution 仅当 fork/redistribute typescript 源码本身,运行时引用无要求)。
→ All green-zone. No NOTICE update / additional attribution required (Apache-2.0 attribution only required when forking/redistributing typescript's source itself; runtime usage exempt).

⚠️ **Scope**:上表为**主 repo 直接 deps**(`/package.json` dependencies + devDependencies)。
**传递 deps**(`node_modules/` 全集合,可能数百个)需独立审计:
```bash
npx --yes license-checker --production --summary
```
当前直接 deps 来自主流 npm 维护者(Anthropic / Express 团队 / Vercel / Node.js core 等),传递 deps **大概率**仍是 MIT/BSD/Apache,但**launch 前必须跑一次 full audit**(W4+ 规划自动化)。

⚠️ **Scope**: Above is **main-repo direct deps** only. **Transitive deps** (full `node_modules/`, potentially hundreds) need separate audit via `license-checker --production`. Direct deps come from mainstream maintainers, transitives **likely** all green, but **full audit required before launch** (CI automation planned W4+).

### electron/ 子项目独立 deps tree / `electron/` sub-project separate deps tree

WebAZ 的 desktop 壳子 `electron/` 是**独立 npm 子项目**(自带 `electron/package.json`,**不在**主 repo 的 dependency 树里)。它有独立 license audit:
WebAZ's desktop scaffold `electron/` is a **separate npm sub-project** (own `electron/package.json`, **NOT** in main repo's dep tree). It needs independent license audit:

```
electron/ devDependencies (2):
  electron                       ^42.3.0         MIT(Electron 自身)
                                                 含内嵌 Chromium(BSD-3-Clause)
                                                 + Node.js(MIT)+ V8(BSD-3-Clause)
  electron-builder               ^26.8.1         MIT
```

→ Electron 内嵌 Chromium / V8 / Node.js 等多层组件 license,打包为 .dmg/.exe/.AppImage 时**必须**保留这些内嵌组件的 NOTICE(electron-builder 默认会处理,但需 launch 前 verify)。
→ Electron embeds Chromium / V8 / Node.js etc. When packaging into .dmg/.exe/.AppImage, **must** retain NOTICE for embedded components (electron-builder handles by default; verify before launch).

**Verify 命令 / Verify command**:
```bash
cd electron && for pkg in $(jq -r '.devDependencies | keys[]?' package.json); do
  printf "%-30s v%-12s %s\n" "$pkg" "$(npm view $pkg version)" "$(npm view $pkg license)"
done
```

⚠️ 主 repo 的 "15 deps 全绿" 断言 + electron/ 子项目的 2 deps,合计 17 项直接 deps,全部 🟢 白名单(2026-06-01 verified)。
⚠️ Main repo's "15 deps all green" + electron/ sub-project's 2 deps = 17 direct deps total, all 🟢 whitelisted (2026-06-01 verified).

---

## 📋 处理流程 / Procedure

### 新增 dep / Adding a dep

1. 用 `npm view <pkg> license` 查 license
2. 对照本政策矩阵:
   - 🟢 → 直接 `npm install --save <pkg>`,PR 描述里说明用途
   - 🟡 → PR 标 `needs-license-review` label;在 PR description 写"附加动作"完成情况
   - 🔴 → **不要装**;在 PR description 解释为什么需要 + 替代方案
3. 提交 PR 时勾上 [`PULL_REQUEST_TEMPLATE.md`](PULL_REQUEST_TEMPLATE.md) Pre-flight 的"依赖 license 兼容"项

### 升级 dep / Upgrading a dep

1. license 变化跟 semver **无关**(semver 约束 API 兼容性,**不约束 license**)— 实践中 license 通常通过 major 版本变化,但 minor/patch 也**技术上可改 license**
2. **任何**版本升级都建议重 verify(`npm view <pkg>@<new-version> license`),major 升级**必须** verify
3. 若 license 从绿变黄/红 → 立刻 PR description 标注 + 触发 license-review 流程

### 发现已有 dep 是红区(audit drift)/ Found existing dep in red zone

1. **不要立刻 force remove**(可能影响功能)
2. 开 issue 标 `type:security` + `area:ci`,描述发现 + 影响面
3. 寻找替代品(同功能 + 绿区 license)
4. 替代品确定后开 PR,在 PR description 注明 "license drift fix: X → Y"
5. 若**找不到替代品** → 走 RFC 决策(继续用 vs 砍掉功能)

---

## 🔗 跨 license 路径专项 / Special cross-license cases

### Phase 4 信任锚 / Trust-anchor

WebAZ Phase 4 信任锚生态依赖**协议规范**(W3C VC / DID 等)— 这些是**公共规范文本**,不是软件 license:
WebAZ Phase 4 trust-anchor depends on **protocol specs** (W3C VC / DID etc) — these are **public specifications**, not software licenses:

- ✅ W3C 规范实现库(MIT / Apache) — OK
- ✅ 引用 W3C spec 文档 — 公共规范,自由引用
- ⚠️ 第三方 anchor 自己的 JSON-LD context — 视其 license 而定(多数 CC-BY)

### 二进制 / wasm 依赖 / Binary / wasm deps

- 二进制 npm 包(.node / .wasm)— license 看其 package.json,**且**看 binary 内嵌 dep 的 license
- Binary npm packages — check BOTH wrapper license AND embedded binary license
- 例 / Example:`better-sqlite3`(MIT 包装层)内嵌 SQLite(public domain)
  - 双层都 ✓ 兼容
  - **验证内嵌二进制 license 的路径** / **How to verify embedded binary license**:
    - 看 `node_modules/better-sqlite3/deps/` 里的 SQLite 版本 + LICENSE 文件
    - SQLite 官方:[https://www.sqlite.org/copyright.html](https://www.sqlite.org/copyright.html)(public domain)
  - 任何内嵌二进制都应 **case-by-case 查【包 license + 内嵌物 license】 双层** / Any embedded binary: case-by-case check both layers
  - ⚠️ 部分 SQLite 发行附带 SQLite Consortium 可选商业许可 — 我们只用 amalgamation 的 public domain 部分 / Some SQLite distributions include optional commercial license; we only use the public-domain amalgamation

### Apache-2.0 + electron 打包分发 / Apache-2.0 + electron distribution

webaz 有 `electron/` 桌面壳(commit `3268a72` 升级到 electron 42)。**electron 打包分发触发 redistribution 义务**,跟纯 npm 库依赖不同:
WebAZ has `electron/` desktop scaffold (electron 42 per commit `3268a72`). **Electron packaging = redistribution**, different from pure-npm runtime deps:

| 场景 / Scenario | Apache-2.0 义务 / Obligation |
|---|---|
| npm runtime 依赖(node 直接 require) | ✅ 无义务(non-redistribution)/ No obligation |
| webaz 打包为 .dmg / .exe / .AppImage(via electron-builder) | ⚠️ **可能触发 NOTICE 传递**(若上游 Apache-2.0 dep 自带 NOTICE 文件)/ May trigger NOTICE retention |

**实操 / Practical**:
- electron desktop launch 前必须扫:`for pkg in $(production transitive Apache-2.0 deps); do find node_modules/$pkg -name NOTICE; done`
- 任何有 NOTICE 的 Apache-2.0 上游 → app 的 `About` / `NOTICE.txt` 必须保留致谢
- Before electron desktop launch: find all NOTICE files in Apache-2.0 transitive deps; preserve attribution in app's About / NOTICE.txt
- 当前 webaz **typescript**(devDep,不打包进 desktop)— 无影响 / Currently only TypeScript is Apache-2.0 (devDep, not bundled into desktop) — no impact yet

→ 这是 #4 不撒谎 的合规层:运行时 vs 分发场景的义务区别要明示,不能假装一样。
→ Per #4 (no lies): runtime vs distribution obligations differ — must be explicit, not hand-waved.

### MCP 协议依赖 / MCP protocol deps

- `@modelcontextprotocol/sdk` — Anthropic 维护,MIT — OK
- MCP 协议规范本身 — 开放规范,自由实现

---

## 🤝 DCO + 依赖 license 双层 check / Double-layer check

引入 dep 时,**两层独立验证**(对照 [`docs/DCO.md`](../docs/DCO.md)):

1. **DCO 层(你的贡献)** — 你 sign-off 声明 "我有权按 BSL 1.1 提交这段代码"
2. **依赖 license 层(dep 的归属)** — dep 自身的 license 必须允许被 webaz 这样用

两层都过 = 合规;任一不过 = PR 拒绝。

Two independent checks (per [`docs/DCO.md`](../docs/DCO.md)):
1. **DCO layer (your contribution)**: you certify rights via sign-off
2. **Dep license layer (the dep itself)**: the dep's own license must allow webaz's use

Both pass = compliant; either fails = PR rejected.

---

## 🎯 元规则映射 / Maps to meta-rules

本政策是以下元规则在依赖管理路径的具体执行(不是新元规则,见 [`docs/META-RULES-FULL.md`](../docs/META-RULES-FULL.md)):
This policy is the dependency-management execution of the following meta-rules (not new rules):

- **#2 代码即规则**:license check 在 PR 阶段强制(未来 CI 自动化),不靠"contributor 自觉" / Enforced at PR gate, not on honor system
- **#4 不撒谎**:当前 deps license 公开列出 + 任何 drift 必须诚实披露 + 文档断言必须实测 verify(self-review 抓到 typescript Apache-2.0 → 立刻改正) / Public license disclosure, drift must be honestly reported, doc claims verified by `npm view`
- **#5 不偏袒**:红区 license 对所有 contributor 一视同仁,不开"自己人"绿灯 / Forbidden licenses apply equally — no insider exceptions

---

## 📚 参考 / References

- [SPDX License List](https://spdx.org/licenses/) — 标准 license 标识符 / Standard identifiers
- [GNU License Compatibility](https://www.gnu.org/licenses/license-list.en.html) — FSF 兼容性参考 / FSF compatibility ref
- [BSL FAQ](https://mariadb.com/bsl-faq-adopting/) — BSL 1.1 解读 / BSL 1.1 interpretation
- [`LICENSE`](../LICENSE) / [`NOTICE`](../NOTICE) — webaz 自身 license
- [`docs/DCO.md`](../docs/DCO.md) — contributor 签名机制
- [`docs/CHARTER.md §4 I-2`](../docs/CHARTER.md) — license 演化锁定

---

**Last reviewed**: 2026-06-01
**Status**: Reference doc — matrix evolvable via CHARTER §6;当前 deps 状态需 quarterly re-audit
