---
name: webaz-invariants
description: WebAZ 改动类型→登记点矩阵与推送前纪律。改 route/schema/契约面/状态机/前端模块/真相源时必查;推 PR 前跑 preflight:push。防"局部正确但漏登记点"类遗漏(api-docs 漂移/PG artifact 失同步/半迁移/假开关)。
---

# WebAZ 不变量登记点矩阵

本仓库每个改动平均牵 5-8 个登记点,守卫绿≠登记齐。**推送前必跑 `npm run preflight:push`**(真执行全部跨切面检查)。以下按改动类型列"动了 A 必须同步 B":

## 改动类型 → 必须同步的登记点

| 你改了 | 必须同步 |
|---|---|
| `src/pwa/routes/*.ts` 任何行数变动(含注释) | `npm run gen:api-docs` 并提交两个生成物 |
| schema 列/表/索引/trigger(SQLite) | ①ALTER 必须在 CREATE 之后(fresh 库静默失败铁律);②同步 `db/schema.pg.sql`(从 **fresh boot** 库 `WEBAZ_DB_PATH=… npm run pg:schema` 重出,勿用长命 dev 库);③`schema:verify` + `pg:verify`(四层 parity:表/索引/逐列/不可变 trigger) |
| 契约面(create body/order 状态/边/actor/错误码语义/DTO 字段) | bump `CONTRACT_VERSION` + `CONTRACT_CHANGES` 条目 + 重出 `docs/CONTRACT-LOCK.json` + `scripts/test-direct-pay-ui.ts` 版本锚 |
| 状态机边/角色 | `test-payment-query-transitions` 等钉角色串的锚;manifest 手写 transitions 表历史性不全,以 entity dictionary 为准 |
| 新 `app-*.js` 前端模块 | ①`index.html` script 标签(注意 wrapper 的加载顺序);②`check:pwa-syntax` 加 `node --check`;③ratchet `LOC_CEILINGS` 登记(pr-constraints Guard B 双查) |
| 新 UI 字符串 | `t()` + `i18n.js` `_EN` 条目(各 UI 测试有 parity 锚) |
| orders-action 新 `error_code` | `app-order-errors.js` `orderErrorLookup`(完整性测试守;该文件顶 50 行,折行) |
| 新 Passkey 动作 | webauthn purpose 白名单(每新动作必查;`direct_pay_order_action` 走 purpose_data 例外) |
| 新 `test:*` script | `package.json` + **手动接 `ci.yml`**(不自动发现) |
| 通知新 `templateKey` | 客户端模板注册(对应 `app-*-ui.js` 的 NOTIF_TEMPLATES) |
| protocol param 被代码读取且宣称"admin 可配" | 必须 seed 进 `DEFAULT_PARAMS`(admin PATCH 对不存在的 key 404)+ 写入校验;消费方对坏配置 fail-closed |

## 高危模式(历史事故类)

- **改真相源(A 表→B 表/角色→白名单)= 全生命周期扫**:写入/读取/切换/UI 邀请/卸任,只改一侧=半迁移(梦想者1号案)。
- **折叠既有代码行前**,先 grep 该行文本在 `scripts/` `tests/` 的语义锚 —— 锚钉旧形态会红(本类撞过 3 次)。
- **重建式迁移(new 表+copy+rename)**:给该表后续加列的人必须同步重建 DDL,否则 fresh 库丢列(notifications template_key 案)。
- **宣称即接线**:契约/注释里写"可配/已支持"前,端到端走一遍那条路;列建好但 API 不开 = 明说"保留,不上假开关"。
- **顶格文件净零行**:`app.js` / `server.ts` / `orders-create.ts` / `app-account.js` 等见 ratchet 清单;折行守恒,ceiling 只降不升。

## 推送前(固定流程)

1. `npm run preflight:push`(api-docs-fresh/contract/schema/pg/ratchet/pr-constraints/seam/pwa-syntax/tsc)
2. 相关运行时测试套件(按域)
3. 刻意停一拍:本次改了什么真相源?列它的全部读写方与跨产物,逐一对表
4. 浏览器/boot 冒烟(接线漏静态扫不出)
