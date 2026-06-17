# RFC-016 — SQLite → PostgreSQL 迁移(横向扩展地基)

- Status: **DRAFT — 待"时机/方向"拍板,代码未动**
- Date: 2026-06-08
- 现状 better-sqlite3 单机单进程是横向扩的唯一根因。
- 方法论: 每个 Phase 一个审计门(exit criteria),门不绿不进下一步;serial PR(依赖链自下而上);钱路守恒永不破(RFC-014 / RFC-007)。

---

## 0. 为什么(一句话)
SQLite(better-sqlite3)= **同步 + 单写者 + 与进程同生命周期** → 无法横向扩(多实例没法共享一个本地文件)。PG = 独立服务 + 并发写 + 连接池 + 读副本 + 复制,是 100万→1000万 一切横向扩的**前提地基**。

## 1. 真实规模(grounded,2026-06-08)
| 项 | 数量 | 含义 |
|---|---|---|
| `db.prepare(` 调用点 | **2776** / **150 文件** | 同步→异步的传染面 |
| `.get/.all/.run` | 3248 | 同上 |
| `db.transaction(` | **126** | 变成异步池化事务;**含钱路=最高风险** |
| `db.exec(` | 541 | 多为 DDL/ALTER(schema) |
| `datetime('now')` | 712 | → `now()` |
| `INSERT OR IGNORE/REPLACE` | 70 | → `ON CONFLICT` |
| `AUTOINCREMENT` | 14 | → `GENERATED`/`SERIAL` 或保持 TEXT id |

**诚实结论**:主成本是 **2776 处同步→异步重构**,它**不因 pre-launch 变便宜**(空库只让"数据迁移/切换"几乎归零,那是小头)。这是动整库的巨型重构,且碰钱路。

## 2. 架构关键点:同步 → 异步(本 RFC 的脊柱)
better-sqlite3 同步(`db.prepare().get()` 直接返回);pg 异步(`await`)。无生产级同步 PG 驱动 → **必须全面异步化**。async 会向上传染(碰 db 的函数→async→其调用者→async)。

**选定打法:async seam,先在 SQLite 上异步化,再换驱动**(把"巨大但低风险的 await 改造"与"高风险的引擎切换"解耦):
- 引入 `src/layer0-foundation/L0-1-database/db.ts` 异步接口:`dbOne<T>(sql,params)` / `dbAll<T>(sql,params)` / `dbRun(sql,params)` / `dbTx(async tx => …)`。
- 两后端,env `WEBAZ_DB` 选择:`sqlite`(better-sqlite3,内部同步、返回 resolved Promise)/ `pg`(Pool,真异步)。
- **先把 2776 处全改成 `await dbX(...)`,仍跑 SQLite**(行为零变化、可合并可部署),再单独换 pg 后端 + 方言 + 锁。
- tsc 是安全网:漏 `await` → Promise 当值用 → 类型报错被抓。

**否决的替代**:① 引 ORM/query-builder(Kysely/Drizzle)= 再叠一次全量重写,风险更大 ② 同步 PG FFI = 非生产级 ③ 半迁(部分表 PG)= 事务跨表,不可行。

## 3. 不变量(扩展不可牺牲)
1. **守恒永不破**:"绝不印钱"。并发下用行锁/隔离级别守住(§6)。
2. **铁律不松**:仲裁/投票/提现真人 Passkey 门不绕过。
3. **doc=code**:费率/参数仍实时读 `protocol_params`。
4. **诚实披露**:`real_users`/launch-pulse 等永远反映真实。
5. **每 Phase 审计门**:exit 不绿不进下一步。

## 4. 分阶段计划(每阶段 = 审计门)

### Phase 0 — seam 骨架 + 决策固化(小,可合并)
- 建 `db.ts` 异步接口 + sqlite 后端(包同步 better-sqlite3);`dbTx` 包 `db.transaction`。
- 试点:1 个只读路由 + 1 个写路由 + 1 个事务(如 settleOrder 的一条)改用 seam,跑通。
- **Exit**:tsc 绿;试点路由 + 全测试套 + schema:verify 绿(仍 SQLite);seam API 定稿。

### Phase 1 — 全量同步→异步(主体,分多批 serial)
- 按 layer/路由文件**分批**把 2776 处 `db.prepare().get/all/run` → `await dbOne/dbAll/dbRun`,126 处 `db.transaction` → `await dbTx`。每批一个 PR。
- **仍跑 SQLite,行为零变化**(纯异步管道)。
- 批次建议序(低危→高危):well-known/只读路由 → 一般写路由 → 引擎读 → **钱路(orders-create/settleOrder/settleFault/dispute executeSettlement)放最后单独一批**。
- **Exit(每批)**:tsc 绿;该批相关测试 + schema:verify 绿;关键批跑浏览器/stdio 实测。**钱路批必须 fault-forfeit 42/42 + dispute 守恒 12/12 全绿。**

### Phase 2 — PG 基础设施 + schema 平价(并行可做)
- Railway 开 managed Postgres(`DATABASE_URL`);schema DDL port 成 PG(类型/约束/索引/无 PRAGMA)。
- 写 PG 版 `schema:verify`(所有 SQL prepare 对 PG schema 验证)。
- **Exit**:PG 实例起;PG schema 建成;schema:verify(PG)绿。

**schema port 打法(已落地 head-start,2026-06-08):不手抄,内省生成。**
DDL 分散在 15 文件、170 CREATE + 288 ALTER,且 Phase 1 期间代码仍在改 → 手抄即刻漂移。
改为 `scripts/gen-pg-schema.ts`(`npm run pg:schema`)【内省 live SQLite `sqlite_master.sql`】
(SQLite 在 `ALTER ADD COLUMN` 时会重写表的存储 SQL,故内省天然含全部 ALTER 合并后的真实结构),
逐表做方言文本变换 → 产出 `db/schema.pg.sql`(保留 UNIQUE/CHECK/复合主键/FK 原样)。
变换见 §5。当前产物:170 表 + 257 索引,0 保留字 caveat,0 方言残留。
*改 schema 后重跑生成器即可,产物勿手改。*

**Railway PG 实例(⚠️ 用户 infra 动作,agent 不代为开通):**
1. Railway 项目内 New → Database → Add PostgreSQL(与现服务同 project,内网互通)。
2. 取自动注入的 `DATABASE_URL`(Postgres 服务的 Connect 页;Railway 会把它注入同 project 的服务变量)。
3. 导入 schema:`psql "$DATABASE_URL" -f db/schema.pg.sql`(或 Railway 的 `railway run psql ... -f ...`)。
4. 回填 webaz 服务环境变量(Phase 3 才接驱动):`WEBAZ_DB=pg` 暂不设,先留 `sqlite`。
之后 Phase 2 Exit 的 PG 版 schema:verify 才能对真实 PG 实例跑。

### Phase 3 — pg 后端 + 方言 + 锁(高风险,聚焦)
- 实现 seam 的 pg 后端(Pool;`dbTx` 用 `pool.connect()`+BEGIN/COMMIT/ROLLBACK);占位符 `?`→`$1`(在 seam 内统一转,call site 不改)。
- 方言批量修:`datetime('now')`→`now()`、`INSERT OR IGNORE/REPLACE`→`ON CONFLICT`、布尔/JSON 差异。
- **钱路加行锁**:钱包/池"读-改-写"用 `SELECT … FOR UPDATE`(§6)。
- `WEBAZ_DB=pg` 跑全套(包括钱路 + 并发守恒)。
- **Exit**:`WEBAZ_DB=pg` 下全测试套 + schema:verify 绿;**§6 并发守恒压力测试绿**。

### Phase 4 — 切换(pre-launch 几乎零成本)
- 生产指向 Railway PG;清测试数据、建空 schema;生产 smoke(协议状态 + 下单闭环 + 结算守恒抽查)。
- 保留 `WEBAZ_DB=sqlite` 回滚开关一段时间。
- **Exit**:prod 跑在 PG;内容指纹 + smoke 验证;观察期(soak)无异常。

## 5. 方言转换清单(Phase 3 集中处理)
- 占位符 `?` → `$1,$2…`(seam 内自动)
- `datetime('now')` / `datetime('now','-7 day')` → `now()` / `now() - interval '7 days'`(712 处,多为默认值/比较)
- `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`;`INSERT OR REPLACE` → `ON CONFLICT … DO UPDATE`(70 处)
- 主键:现多为 TEXT id(`usr_`/`ord_`…),无需 SERIAL,利好;少量 AUTOINCREMENT/rowid 单独处理(14)
- 类型:SQLite 弱类型 → PG 强类型(RFC-014 金额已整数化 = 利好);布尔 0/1 → boolean;`LIKE` 大小写(PG 区分,用 `ILIKE` 视需要)
- 无 `PRAGMA`(WAL/foreign_keys 由 PG 默认/配置替代)

## 6. 钱路并发(最高风险,Phase 3 重点)
- 现在守恒靠 **SQLite 单写者天然串行**:同刻仅一个写事务,不会两笔结算交错。
- PG 并发后此保证消失 → 必须:钱包/池 `SELECT … FOR UPDATE` 锁住"读-改-写"窗口,或 `SERIALIZABLE` + 重试。`applyWalletDelta`/`creditColumns` 已绝对值落库(利好),但锁仍必需。
- **验收**:把 `test-fault-forfeit-conservation`(42)/ `test-dispute-settlement-conservation`(12)扩成**并发版**(N 个并行结算打同一钱包/池),断言守恒残差 0、无双花、无印钱。

## 7. 回滚
- Phase 1 各批仍 SQLite,回滚 = revert PR。
- Phase 3/4 切 PG 后保留 `WEBAZ_DB=sqlite` 开关;出问题切回 SQLite(pre-launch 无真数据,切回零损失)。

## 8. ⚠️ 时机决策(需你拍板,先于 Phase 1 代码)
**关键校正**:主成本(Phase 1,2776 处)**pre-launch 不变便宜**;只有切换(Phase 4)变便宜。两个选择:

- **A. 现在就全做**:若你**确信**那条极速曲线。优点:空库从容验证钱路并发、地基提前夯实。缺点:2776 处巨型 churn(数周 agent 工作 + 逐批审计),期间压住其它功能开发,且为 ~1 用户做大重构。
- **B. 现在"备而不发"(推荐)**:① 本 RFC 落档 ② 做 **Phase 0 seam + 钱路/方言"PG 友好化"小整理**(让未来移植更小)③ SQLite + Cloudflare + **邀请门**当跑道 ④ 见 **Tier-2 信号(单机到顶)** 再触发 Phase 1,用邀请门把入流压在移植窗口内。
  - 依据:邀请门 = 入流阀门,化解了"前置工期 > 反应窗口"的担忧(你控斜率);避免为 1 用户做 2776 处投机重构;真实信号出现再投入。

**我的建议:B**(备而不发 + 先做 Phase 0 seam)。除非你判断极速曲线近在眼前,则走 A。

## 9. 工期(诚实,和我一起)
- Phase 0 seam:1–2 天。
- Phase 1(2776 处,分批):**最大头**;agent 把"机械 await 改造"从传统数周压缩,但 150 文件逐批 + 逐批审计 + 钱路批谨慎 → **现实约 1–2 周日历**(受审计严谨度,非打字速度约束)。
- Phase 2:0.5–1 天。
- Phase 3(pg 后端 + 方言 + 锁 + 并发验证):**钱路并发是不可压的核心**,约数天–1 周。
- Phase 4 切换(pre-launch):0.5 天。
- **合计**:走 A ≈ 2–3 周日历做到"安全上 PG";走 B ≈ 现在只花 1–2 天(Phase 0),其余触发再做。
