# WebAZ Engineering PR Constraints

These rules are mandatory for code PRs. They exist to prevent structural debt from
growing back while WebAZ is being refactored in small, reviewable slices.

这些规则是代码 PR 的硬约束。目标不是制造流程负担,而是防止已经压下去的复杂度重新长回
`server.ts`、`app.js`、启动路径和钱/状态路径。

## 1. One PR, One Change Type

Each PR must have one primary type:

- structure/refactor
- feature or behavior change
- UI polish
- schema/migration
- money/order/status-path change
- docs/tests/chore

Do not mix structure refactors with UI polish, schema changes, behavior changes,
or money/order/status-path edits. If the work needs multiple types, split it into
multiple PRs.

一个 PR 只做一类事。结构拆分、UI 优化、schema/migration、业务行为、钱/订单/状态路径
必须分开。

## 2. No Large-File Backflow

Do not add new feature logic to these files unless the PR explicitly explains why:

- `src/pwa/server.ts`
- `src/pwa/public/app.js`
- very large route files

New frontend page/domain logic should go into an `app-<domain>.js` file loaded
before `app.js`. New backend behavior should go into the owning route, service,
schema, migration, or domain module.

禁止把新逻辑回塞进大文件。确实必须改大文件时,PR 描述必须说明原因和替代方案。

## 3. Complexity Ratchet Is a Gate

Complexity baselines are current debt ceilings, not quality targets.

- Do not raise LOC ceilings, inline `CREATE TABLE`, or inline `ALTER TABLE`
  baselines just to pass CI.
- Structure PRs that remove code from a large file must lower the corresponding
  ratchet baseline in the same PR.
- New split files must get their own LOC ceiling so complexity cannot simply move
  under a new filename.
- If a baseline must rise, the PR must call it out as an intentional exception and
  explain why no smaller split is possible.

基线只能有意降低,不能为了过 CI 自己抬高。新增拆分文件也必须进入 ratchet。

> CI-enforced (fail-closed) by `npm run guard:pr-constraints` (Guard A): any
> existing ratchet baseline that rises vs the merge-base with `main` fails the
> build. There is no in-PR exception channel — a baseline that genuinely must
> rise is a separate, explicit decision. / 由 `guard:pr-constraints` 机械强制,无例外通道。

## 4. Schema And Migration Rules

- `CREATE TABLE` must run before dependent `ALTER TABLE`.
- DDL, one-time data migrations, and bootstrap repairs must stay separated.
- Schema extraction PRs should be pure moves unless the PR clearly declares a
  behavior change.
- Run `npm run schema:verify` for schema/migration PRs.
- For boot-path changes, verify a fresh/empty DB cold start when possible.

`ALTER` 在 `CREATE` 前静默失败是已知 fresh DB 风险;不要重排这个顺序。

## 5. Frontend Split Rules

The current PWA uses classic scripts, not ES modules or a bundler.

- Keep the classic multi-script model unless a dedicated PR changes the build
  strategy.
- Load every new `app-*.js` before `app.js` in `src/pwa/public/index.html`.
- Add every new `app-*.js` to `npm run check:pwa-syntax`.
- Update static tests that read `app.js` or source spans so coverage follows the
  moved code.
- Browser-smoke every route whose renderer or handlers moved, and check the
  console for `ReferenceError`.

当前阶段不要顺手切 ES module/bundler。拆文件要同时接入加载顺序、syntax check、静态测试和
浏览器 smoke。

> CI-enforced (fail-closed) by `npm run guard:pr-constraints` (Guard B): every
> `src/pwa/public/app-*.js` must appear in BOTH `check:pwa-syntax` and the ratchet
> `LOC_CEILINGS`, so complexity cannot hide under an unchecked new filename. (Load
> order and browser-smoke remain author/review responsibilities.) /
> 由 `guard:pr-constraints` 机械强制接入 syntax + ratchet。

## 6. Money, Order, And Status Paths Are Protected

Do not touch payment, wallet, order status, settlement, fund, tokenomics,
commission, escrow, or protocol-parameter paths inside ordinary refactor or UI
PRs.

Those paths require dedicated, surgical PRs and must not run concurrently with
payment-route development unless explicitly approved.

支付、钱包、订单状态、结算、fund、tokenomics、commission、escrow、协议参数路径不得混入普通
结构 PR 或 UI PR。

## 7. UI Polish Must Be Separate

UI polish is welcome, but it must be a separate PR after the structural move is
merged. A UI PR should name the pages changed and include browser-smoke evidence.

不要在结构拆分 PR 里顺手改视觉、文案、布局或交互。

## 8. Required Verification

Every code PR should run the relevant subset:

- `git diff --check`
- `npm run guard:complexity`
- `npm run guard:pr-constraints` (ratchet monotonicity + app-*.js wiring; CI-enforced)
- `npm run check:pwa-syntax` for PWA frontend changes
- `npm run build`
- `npm run schema:verify` for schema/migration changes
- targeted static/contract tests for moved or behavior-touched surfaces
- browser smoke for moved frontend routes

If a command is skipped, explain why in the PR body.

## 9. Required PR Self-Report

Every code PR body must state:

- PR type
- whether UI behavior changed
- whether schema/migration changed
- whether money/order/status paths were touched
- large-file LOC delta
- ratchet baseline delta
- new files added to syntax/build checks
- static tests updated
- validation run
- known risks

AI agents must stop before coding if the requested work conflicts with these
rules, and must ask for an explicit split or exception.
