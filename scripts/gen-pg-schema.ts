#!/usr/bin/env tsx
/**
 * RFC-016 Phase 2 — SQLite → PostgreSQL schema 生成器(introspection-driven)。
 *
 * 为什么不手抄:DDL 分散在 15 个文件、170 CREATE TABLE + 288 ALTER ADD COLUMN,
 *   且 Phase 1 期间代码仍在改。手抄即刻漂移。本脚本【内省 live SQLite】
 *   (`sqlite_master.sql` 已是 CREATE+ALTER 合并后的真实结构),逐表做【方言文本变换】
 *   产出 PG DDL —— 不重构、不重排,保留 UNIQUE / CHECK / 复合主键 / FK 原样。
 *
 * 用法:npm run pg:schema   →  写 db/schema.pg.sql
 *   (只读内省,不动 SQLite;不连 PG —— 产物供 Phase 2 审阅 + 建 PG 实例后导入。)
 *
 * 方言变换(RFC-016 §5):
 *   - `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`(rowid 自增表)
 *   - 残余 `AUTOINCREMENT` 删除
 *   - 类型:`INTEGER`→`BIGINT` · `REAL`→`DOUBLE PRECISION` · `BLOB`→`BYTEA`
 *     (`TEXT`/`DECIMAL(p,s)` PG 原生兼容,保留;金额已 RFC-014 整数化,BIGINT 安全)
 *   - 默认 `(datetime('now'))` / `CURRENT_TIMESTAMP` → 产出与 SQLite 同格式的 UTC 字符串
 *     (列仍是 TEXT,存 'YYYY-MM-DD HH24:MI:SS';保证全仓 `datetime('now')` 比较语义不变)
 *   - CREATE TABLE / INDEX 注入 `IF NOT EXISTS`(幂等)
 *
 * ⚠️ 已知留待 Phase 3 人工确认(本脚本会在末尾打印 caveats):
 *   - PG 保留字撞列名(如出现 user/order 等裸名)→ 需加引号,Phase 2 verify 时暴露
 *   - 时间默认值精度(SQLite 秒级 vs now() 含微秒)已对齐为秒级字符串
 *   - APPEND-ONLY 表(见 APPEND_ONLY_TABLES)用触发器在 DB 层禁 UPDATE/DELETE:SQLite 端是
 *     BEFORE UPDATE/DELETE → RAISE(ABORT)(在表的 init 里建);PG 端无法文本翻译 SQLite 触发器,
 *     故本生成器为声明列表里的表【发等价的 PG plpgsql RAISE EXCEPTION 触发器】(下方 GUARDS 段)。
 *     视图本协议未用。
 */
import Database from 'better-sqlite3'
import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const DB_PATH = process.env.WEBAZ_DB_PATH || join(homedir(), '.webaz/webaz.db')
const OUT_PATH = join('db', 'schema.pg.sql')

if (!existsSync(DB_PATH)) {
  console.error(`❌ SQLite DB not found at ${DB_PATH}`)
  console.error(`   先跑 npm run pwa 让 DB 初始化,再跑本脚本`)
  process.exit(2)
}

const db = new Database(DB_PATH, { readonly: true })

// 与 SQLite datetime('now') 同格式(秒级、UTC、无时区后缀)的 PG 表达式
const PG_NOW = `to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')`

const caveats: string[] = []

/** 去掉 SQL 注释(-- 行注释),避免注释里的 INTEGER/REAL 等词被方言变换误伤。 */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

/** 单条 CREATE TABLE 的 SQLite → PG 方言变换。 */
function portTableSql(sqliteSql: string): string {
  let s = stripComments(sqliteSql)

  // 1) 自增主键:INTEGER PRIMARY KEY AUTOINCREMENT → BIGSERIAL PRIMARY KEY(先于通用 INTEGER 变换)
  s = s.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'BIGSERIAL PRIMARY KEY')
  // 2) 残余 AUTOINCREMENT 删除
  s = s.replace(/\s+AUTOINCREMENT\b/gi, '')

  // 3) 类型方言(\b 词界,避免 real_users / counter 等列名误伤)
  s = s.replace(/\bINTEGER\b/gi, 'BIGINT')
  s = s.replace(/\bREAL\b/gi, 'DOUBLE PRECISION')
  s = s.replace(/\bBLOB\b/gi, 'BYTEA')

  // 4) 时间默认值 → 同格式 UTC 秒级字符串(列保持 TEXT)
  //    覆盖 (datetime('now')) / datetime('now') / (CURRENT_TIMESTAMP) / CURRENT_TIMESTAMP
  s = s.replace(/\(\s*datetime\(\s*'now'\s*\)\s*\)/gi, `(${PG_NOW})`)
  s = s.replace(/\bdatetime\(\s*'now'\s*\)/gi, `(${PG_NOW})`)
  s = s.replace(/\(\s*CURRENT_TIMESTAMP\s*\)/gi, `(${PG_NOW})`)
  s = s.replace(/\bDEFAULT\s+CURRENT_TIMESTAMP\b/gi, `DEFAULT (${PG_NOW})`)
  // INTEGER epoch timestamps use SQLite strftime('%s','now'). PostgreSQL's
  // equivalent must stay integral so existing cooldown arithmetic is unchanged.
  s = s.replace(/strftime\(\s*'%s'\s*,\s*'now'\s*\)/gi, `floor(extract(epoch from now()))::bigint`)

  // 4.5) 字符串默认值的双引号 → 单引号(SQLite 容忍 DEFAULT "x" 当字符串字面量;
  //      PG 里 "x" 是【标识符】会报错)。只动 DEFAULT "..." 串默认值,不碰其它双引号标识符。
  //      SQLite 内嵌 " 用 "" 转义;转 PG 时 "" → " ,内嵌 ' 再转义为 ''。
  s = s.replace(/\bDEFAULT\s+"((?:[^"]|"")*)"/gi, (_m, inner: string) => {
    const literal = inner.replace(/""/g, '"').replace(/'/g, "''")
    return `DEFAULT '${literal}'`
  })

  // 4.6) SQLite 的“仅允许字符集”GLOB guard → PG POSIX regex。SQLite 无 {n} 量词，
  //      所以本仓以 `column NOT GLOB '*[^allowed]*'` 表示无任意非法字符；PG 等价
  //      `column !~ '[^allowed]'`。这里保守只转换简单列名 + ASCII 字符类；任何别的
  //      GLOB 仍由 pg:verify 拦下，避免静默误译。
  s = s.replace(/\b([a-z_][a-z0-9_]*)\s+NOT\s+GLOB\s+'\*\[\^([0-9a-z_-]+)\]\*'/gi, (_m, column: string, allowed: string) => `${column} !~ '[^${allowed}]'`)
  s = s.replace(/\bsubstr\(\s*([a-z_][a-z0-9_]*)\s*,\s*-1\s*,\s*1\s*\)\s+GLOB\s+'(\[[0-9a-z_-]+\])'/gi,
    (_m, column: string, allowed: string) => `right(${column},1) ~ '^${allowed}$'`)

  // 5) 幂等:CREATE TABLE → CREATE TABLE IF NOT EXISTS(若原文未含)
  s = s.replace(/\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ')

  return s.trim()
}

/** 单条 CREATE INDEX 的变换(PG 基本兼容,仅注入 IF NOT EXISTS)。 */
function portIndexSql(sqliteSql: string): string {
  let s = stripComments(sqliteSql).trim()
  s = s.replace(/\bCREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i,
    (_m, uniq) => `CREATE ${uniq ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS `)
  return s
}

// ── 内省:表(按依赖友好的原始顺序),再索引 ──
const tables = db.prepare(
  `SELECT name, sql FROM sqlite_master
   WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
   ORDER BY rowid`
).all() as Array<{ name: string; sql: string }>

const indexes = db.prepare(
  `SELECT name, sql FROM sqlite_master
   WHERE type='index' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
   ORDER BY rowid`
).all() as Array<{ name: string; sql: string }>

/**
 * SQLite permits a table to reference another table that is created later.
 * PostgreSQL resolves REFERENCES targets while executing CREATE TABLE, so the
 * generated artifact must put every dependency before its dependent table.
 * Keep the original sqlite_master order as the stable tie-breaker.
 */
function orderTablesByReferences(input: Array<{ name: string; sql: string }>): Array<{ name: string; sql: string }> {
  const byName = new Map(input.map(table => [table.name.toLowerCase(), table]))
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const ordered: Array<{ name: string; sql: string }> = []

  const visit = (table: { name: string; sql: string }): void => {
    const key = table.name.toLowerCase()
    const current = state.get(key)
    if (current === 'done') return
    if (current === 'visiting') {
      const cycleStart = stack.indexOf(key)
      const cycle = [...stack.slice(cycleStart), key].join(' -> ')
      throw new Error(`PostgreSQL CREATE TABLE dependency cycle: ${cycle}`)
    }

    state.set(key, 'visiting')
    stack.push(key)
    const references = [...table.sql.matchAll(/\bREFERENCES\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi)]
      .map(match => match[1].toLowerCase())
    for (const dependencyName of references) {
      if (dependencyName === key) continue
      const dependency = byName.get(dependencyName)
      if (dependency) visit(dependency)
    }
    stack.pop()
    state.set(key, 'done')
    ordered.push(table)
  }

  for (const table of input) visit(table)
  return ordered
}

const orderedTables = orderTablesByReferences(tables)

// PG 保留字 — 若被用作裸列/表名,Phase 2 import 时会报错,先在产物里标注
const PG_RESERVED = new Set([
  'user', 'order', 'group', 'references', 'check', 'default', 'table',
  'column', 'select', 'where', 'from', 'to', 'desc', 'asc', 'limit',
  'offset', 'primary', 'foreign', 'constraint', 'window', 'end', 'all',
])
function flagReserved(tableName: string, sqliteSql: string): void {
  // 粗检:列定义行首 token(去注释后)落在保留字集合
  for (const line of stripComments(sqliteSql).split('\n')) {
    const m = line.trim().match(/^["`]?([a-z_]+)["`]?\s+(TEXT|INTEGER|REAL|BLOB|DECIMAL|NUMERIC)/i)
    if (m && PG_RESERVED.has(m[1].toLowerCase())) {
      caveats.push(`表 ${tableName}: 列 "${m[1]}" 是 PG 保留字 → import 时需加双引号`)
    }
  }
  if (PG_RESERVED.has(tableName.toLowerCase())) {
    caveats.push(`表名 ${tableName} 是 PG 保留字 → 需加双引号`)
  }
}

const out: string[] = []
out.push('-- RFC-016 Phase 2 — PostgreSQL schema (generated by scripts/gen-pg-schema.ts)')
out.push('-- 由 live SQLite 内省 + 方言文本变换产出;勿手改本文件,改生成器后重跑。')
out.push('-- 源:local SQLite DB via sqlite_master(路径见 WEBAZ_DB_PATH;不内嵌绝对路径以免泄漏本地 home 路径)')
out.push(`-- 生成时间:${new Date().toISOString()}`)
out.push(`-- 表 ${tables.length} · 索引 ${indexes.length}`)
out.push('')
out.push('BEGIN;')
out.push('')

out.push('-- ════════════ TABLES (foreign-key dependency order) ════════════')
for (const t of orderedTables) {
  flagReserved(t.name, t.sql)
  out.push(portTableSql(t.sql) + ';')
  out.push('')
}

// Additive PG upgrade steps that CREATE TABLE IF NOT EXISTS cannot apply to an
// already-provisioned database. Keep these next to their SQLite guarded ALTER.
const hasOauthAccessTokens = tables.some(t => t.name === 'oauth_access_tokens')
const hasOauthRefreshTokens = tables.some(t => t.name === 'oauth_refresh_tokens')
if (hasOauthAccessTokens || hasOauthRefreshTokens) {
  out.push('-- ════════════ ADDITIVE UPGRADES (existing PostgreSQL databases) ════════════')
  if (hasOauthAccessTokens) out.push(`ALTER TABLE oauth_access_tokens ADD COLUMN IF NOT EXISTS dpop_jkt TEXT
  CHECK(dpop_jkt IS NULL OR (length(dpop_jkt) = 43 AND dpop_jkt !~ '[^A-Za-z0-9_-]' AND right(dpop_jkt,1) ~ '^[AEIMQUYcgkosw048]$'));`)
  if (hasOauthRefreshTokens) out.push(`ALTER TABLE oauth_refresh_tokens ADD COLUMN IF NOT EXISTS dpop_jkt TEXT
  CHECK(dpop_jkt IS NULL OR (length(dpop_jkt) = 43 AND dpop_jkt !~ '[^A-Za-z0-9_-]' AND right(dpop_jkt,1) ~ '^[AEIMQUYcgkosw048]$'));`)
  out.push('')
}

out.push('-- ════════════ INDEXES ════════════')
for (const ix of indexes) {
  out.push(portIndexSql(ix.sql) + ';')
}

// ── APPEND-ONLY GUARDS ──
// These tables are immutable logs. SQLite enforces it with BEFORE UPDATE/DELETE → RAISE(ABORT)
// triggers (created in each table's init). SQLite triggers don't text-translate to PG, so we emit the
// equivalent PG plpgsql RAISE EXCEPTION guard here for the tables actually present in this DB.
// (The function body keeps `BEGIN ... END;` on one line so it never looks like a transaction `BEGIN;`.)
const APPEND_ONLY_TABLES = ['identity_binding_events', 'admin_operator_claim_events', 'agent_execution_mandate_events', 'admin_coordination_fact_sources', 'admin_operator_claim_confirmations', 'admin_operator_unlink_requests', 'admin_operator_claim_marking_corrections', 'direct_pay_fee_receivables', 'direct_pay_fee_invoice_items', 'direct_pay_fee_adjustments', 'direct_pay_fee_invoice_events', 'direct_pay_fee_payments', 'direct_pay_fee_prepay_refunds', 'direct_receive_account_qr_images', 'direct_receive_account_events', 'recommendation_namespace_events', 'recommendation_anchor_events', 'waz_sunset_corrections', 'usdc_escrow_chain_events', 'usdc_escrow_event_orphans']   // 直付收款账号 + 推荐命名空间/口令事件都是内容可追溯的不可变审计日志
const presentAppendOnly = APPEND_ONLY_TABLES.filter(name => tables.some(t => t.name === name))
if (presentAppendOnly.length) {
  out.push('')
  out.push('-- ════════════ APPEND-ONLY GUARDS (immutability triggers) ════════════')
  out.push('CREATE OR REPLACE FUNCTION webaz_reject_mutation() RETURNS trigger AS $$')
  out.push(`BEGIN RAISE EXCEPTION 'table % is append-only (UPDATE/DELETE forbidden)', TG_TABLE_NAME; END;`)
  out.push('$$ LANGUAGE plpgsql;')
  for (const name of presentAppendOnly) {
    for (const op of ['UPDATE', 'DELETE']) {
      const trg = `trg_${name}_no_${op.toLowerCase()}`
      out.push(`DROP TRIGGER IF EXISTS ${trg} ON ${name};`)
      out.push(`CREATE TRIGGER ${trg} BEFORE ${op} ON ${name} FOR EACH ROW EXECUTE FUNCTION webaz_reject_mutation();`)
    }
  }
}

// ── RECOMMENDATION-ANCHOR LIFECYCLE GUARDS ──
// The SQLite runtime installs equivalent triggers in initRecommendationAnchorSchema.
// These are intentionally explicit rather than treating the namespace/anchor rows as
// append-only: their lifecycle status changes, while their identity and target never do.
const hasRecommendationAnchors = ['recommendation_namespaces', 'recommendation_namespace_events', 'recommendation_anchors', 'recommendation_anchor_events']
  .every(name => tables.some(t => t.name === name))
if (hasRecommendationAnchors) {
  out.push('')
  out.push('-- ════════════ RECOMMENDATION-ANCHOR LIFECYCLE GUARDS ════════════')
  out.push('CREATE OR REPLACE FUNCTION webaz_recommendation_namespace_guard() RETURNS trigger AS $$')
  out.push(`BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'recommendation namespaces are permanent tombstones (DELETE forbidden)'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.disabled_at IS NOT NULL OR NEW.retired_at IS NOT NULL THEN RAISE EXCEPTION 'recommendation namespace must be inserted active'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.namespace IS DISTINCT FROM OLD.namespace THEN RAISE EXCEPTION 'recommendation namespace owner and name are immutable'; END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.disabled_at IS DISTINCT FROM OLD.disabled_at OR NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN RAISE EXCEPTION 'recommendation namespace lifecycle timestamps are immutable'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'active' OR NEW.status NOT IN ('disabled', 'retired') THEN RAISE EXCEPTION 'recommendation namespace status cannot be reactivated'; END IF;
  IF NEW.status = 'disabled' AND (NEW.disabled_at IS NULL OR NEW.retired_at IS NOT NULL) THEN RAISE EXCEPTION 'disabled recommendation namespace requires only disabled_at'; END IF;
  IF NEW.status = 'retired' AND (NEW.retired_at IS NULL OR NEW.disabled_at IS NOT NULL) THEN RAISE EXCEPTION 'retired recommendation namespace requires only retired_at'; END IF;
  IF NOT EXISTS (SELECT 1 FROM recommendation_namespace_events e WHERE e.namespace_id = OLD.id AND e.event_type = NEW.status) THEN RAISE EXCEPTION 'recommendation namespace status requires append-only event'; END IF;
  RETURN NEW;
END;`)
  out.push('$$ LANGUAGE plpgsql;')
  for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
    const lower = op.toLowerCase()
    out.push(`DROP TRIGGER IF EXISTS trg_recommendation_namespaces_guard_${lower} ON recommendation_namespaces;`)
    out.push(`CREATE TRIGGER trg_recommendation_namespaces_guard_${lower} BEFORE ${op} ON recommendation_namespaces FOR EACH ROW EXECUTE FUNCTION webaz_recommendation_namespace_guard();`)
  }
  out.push('CREATE OR REPLACE FUNCTION webaz_recommendation_anchor_guard() RETURNS trigger AS $$')
  out.push(`BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'recommendation anchors are immutable tombstones (DELETE forbidden)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM recommendation_namespaces n WHERE n.id = NEW.namespace_id AND n.owner_user_id = NEW.recommender_user_id) THEN RAISE EXCEPTION 'recommendation anchor recommender must own namespace'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.withdrawn_at IS NOT NULL OR NEW.disabled_at IS NOT NULL THEN RAISE EXCEPTION 'recommendation anchor must be inserted active'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.namespace_id IS DISTINCT FROM OLD.namespace_id OR NEW.local_code IS DISTINCT FROM OLD.local_code OR NEW.recommender_user_id IS DISTINCT FROM OLD.recommender_user_id OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.variant_id IS DISTINCT FROM OLD.variant_id OR NEW.seller_id_at_issue IS DISTINCT FROM OLD.seller_id_at_issue OR NEW.campaign_ref IS DISTINCT FROM OLD.campaign_ref OR NEW.target_snapshot_hash IS DISTINCT FROM OLD.target_snapshot_hash THEN RAISE EXCEPTION 'recommendation anchor target and issuer are immutable'; END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at OR NEW.disabled_at IS DISTINCT FROM OLD.disabled_at THEN RAISE EXCEPTION 'recommendation anchor lifecycle timestamps are immutable'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'active' OR NEW.status NOT IN ('withdrawn', 'disabled') THEN RAISE EXCEPTION 'recommendation anchor status cannot be reactivated'; END IF;
  IF NEW.status = 'withdrawn' AND (NEW.withdrawn_at IS NULL OR NEW.disabled_at IS NOT NULL) THEN RAISE EXCEPTION 'withdrawn recommendation anchor requires only withdrawn_at'; END IF;
  IF NEW.status = 'disabled' AND (NEW.disabled_at IS NULL OR NEW.withdrawn_at IS NOT NULL) THEN RAISE EXCEPTION 'disabled recommendation anchor requires only disabled_at'; END IF;
  IF NOT EXISTS (SELECT 1 FROM recommendation_anchor_events e WHERE e.recommendation_anchor_id = OLD.id AND e.event_type = NEW.status) THEN RAISE EXCEPTION 'recommendation anchor status requires append-only event'; END IF;
  RETURN NEW;
END;`)
  out.push('$$ LANGUAGE plpgsql;')
  for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
    const lower = op.toLowerCase()
    out.push(`DROP TRIGGER IF EXISTS trg_recommendation_anchors_guard_${lower} ON recommendation_anchors;`)
    out.push(`CREATE TRIGGER trg_recommendation_anchors_guard_${lower} BEFORE ${op} ON recommendation_anchors FOR EACH ROW EXECUTE FUNCTION webaz_recommendation_anchor_guard();`)
  }
}

// ── INSERT-STATUS GUARDS ──
// Tables whose rows may only be CREATED in a specific initial status (then migrate via UPDATE). SQLite
// uses a BEFORE INSERT … WHEN trigger (created in the table's init); PG can't text-translate that, so we
// emit the equivalent plpgsql BEFORE INSERT guard here. (Function body stays one line so it never looks
// like a transaction `BEGIN;`.)
const INSERT_STATUS_GUARDS: Array<{ table: string; initial: string }> = [{ table: 'identity_claim_challenges', initial: 'issued' }]
const presentStatusGuards = INSERT_STATUS_GUARDS.filter(g => tables.some(t => t.name === g.table))
if (presentStatusGuards.length) {
  out.push('')
  out.push('-- ════════════ INSERT-STATUS GUARDS ════════════')
  for (const g of presentStatusGuards) {
    const fn = `webaz_${g.table}_insert_${g.initial}`
    const trg = `trg_${g.table}_insert_${g.initial}`
    out.push(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$`)
    out.push(`BEGIN IF NEW.status <> '${g.initial}' THEN RAISE EXCEPTION '${g.table} must be inserted with status=${g.initial}'; END IF; RETURN NEW; END;`)
    out.push('$$ LANGUAGE plpgsql;')
    out.push(`DROP TRIGGER IF EXISTS ${trg} ON ${g.table};`)
    out.push(`CREATE TRIGGER ${trg} BEFORE INSERT ON ${g.table} FOR EACH ROW EXECUTE FUNCTION ${fn}();`)
  }
}
// ── REFERENCED-EVIDENCE FREEZE ──
// Once an admin_audit_log row is referenced by admin_coordination_fact_sources it is contribution
// evidence truth → frozen. SQLite enforces this with a conditional BEFORE UPDATE/DELETE trigger
// (WHEN EXISTS …, created in admin-coordination-store init); PG can't text-translate it, so emit the
// equivalent conditional plpgsql guard. Non-referenced audit rows stay mutable.
if (tables.some(t => t.name === 'admin_audit_log') && tables.some(t => t.name === 'admin_coordination_fact_sources')) {
  out.push('')
  out.push('-- ════════════ REFERENCED-EVIDENCE FREEZE (admin_audit_log) ════════════')
  out.push('CREATE OR REPLACE FUNCTION webaz_aal_freeze_evidence() RETURNS trigger AS $$')
  out.push(`BEGIN IF EXISTS (SELECT 1 FROM admin_coordination_fact_sources WHERE admin_audit_log_id = OLD.id) THEN RAISE EXCEPTION 'admin_audit_log row is referenced as contribution evidence — immutable'; END IF; RETURN OLD; END;`)
  out.push('$$ LANGUAGE plpgsql;')
  for (const op of ['UPDATE', 'DELETE']) {
    const trg = `trg_aal_freeze_evidence_${op.toLowerCase()}`
    out.push(`DROP TRIGGER IF EXISTS ${trg} ON admin_audit_log;`)
    out.push(`CREATE TRIGGER ${trg} BEFORE ${op} ON admin_audit_log FOR EACH ROW EXECUTE FUNCTION webaz_aal_freeze_evidence();`)
  }
}
// ── CONFIRMATION-MATCH GUARD (admin_operator_claim_confirmations) ──
// A confirmation must reference a 'claimed' event whose admin/contributor match it. SQLite enforces
// this with a conditional BEFORE INSERT trigger; emit the equivalent plpgsql guard for PG.
if (tables.some(t => t.name === 'admin_operator_claim_confirmations') && tables.some(t => t.name === 'admin_operator_claim_events')) {
  out.push('')
  out.push('-- ════════════ CONFIRMATION-MATCH GUARD (admin_operator_claim_confirmations) ════════════')
  out.push('CREATE OR REPLACE FUNCTION webaz_aocc_match_claim() RETURNS trigger AS $$')
  out.push(`BEGIN IF NOT EXISTS (SELECT 1 FROM admin_operator_claim_events e WHERE e.event_id = NEW.claimed_event_id AND e.event_type = 'claimed' AND e.admin_account_id = NEW.admin_account_id AND e.contributor_account_id = NEW.contributor_account_id) THEN RAISE EXCEPTION 'confirmation admin/contributor must match its claimed event'; END IF; RETURN NEW; END;`)
  out.push('$$ LANGUAGE plpgsql;')
  out.push('DROP TRIGGER IF EXISTS trg_aocc_match_claim ON admin_operator_claim_confirmations;')
  out.push('CREATE TRIGGER trg_aocc_match_claim BEFORE INSERT ON admin_operator_claim_confirmations FOR EACH ROW EXECUTE FUNCTION webaz_aocc_match_claim();')
}
out.push('')
out.push('COMMIT;')
out.push('')

// Trailing-whitespace trim (every line): stripping inline `--` comments from the source DDL leaves
// the column-alignment padding as trailing spaces; git diff --check rejects those. Whitespace at
// end-of-line is never SQL-significant, so trim it globally for a clean, diff-stable artifact.
const rendered = out.join('\n').split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n')

// 泄漏自检(Codex #185):PG 里 DEFAULT "..." 是标识符不是字符串字面量 —— 决不能进产物。
// 若仍残留,说明上面 4.5) 变换漏了某种形态;直接拒绝写文件,逼回去修生成器(而非默默产出坏 DDL)。
{
  const leaks = rendered.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /\bDEFAULT\s+"/i.test(line))
  if (leaks.length) {
    console.error(`\n❌ schema.pg.sql 仍含 SQLite 风格双引号字符串默认值(PG 会当标识符报错):`)
    for (const { line, n } of leaks.slice(0, 10)) {
      const m = line.match(/\bDEFAULT\s+"[^"]*"/i)
      console.error(`   行 ${n}: ${m ? m[0] : line.trim().slice(0, 80)}`)
    }
    console.error(`   修 scripts/gen-pg-schema.ts 的 DEFAULT "..." → DEFAULT '...' 变换后重跑。`)
    process.exit(3)
  }
}

if (!existsSync(dirname(OUT_PATH))) mkdirSync(dirname(OUT_PATH), { recursive: true })
writeFileSync(OUT_PATH, rendered, 'utf8')

console.log(`\nRFC-016 PG schema 生成`)
console.log(`────────────────────`)
console.log(`  表      ${tables.length}`)
console.log(`  索引    ${indexes.length}`)
console.log(`  产物    ${OUT_PATH}`)
if (caveats.length) {
  console.log(`\n⚠️  Phase 3 需人工确认的 caveat(${caveats.length}):`)
  for (const c of [...new Set(caveats)]) console.log(`  • ${c}`)
} else {
  console.log(`\n✅ 无保留字/裸名 caveat`)
}
console.log('')
