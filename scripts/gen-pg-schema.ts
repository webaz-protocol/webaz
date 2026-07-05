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

  // 4.5) 字符串默认值的双引号 → 单引号(SQLite 容忍 DEFAULT "x" 当字符串字面量;
  //      PG 里 "x" 是【标识符】会报错)。只动 DEFAULT "..." 串默认值,不碰其它双引号标识符。
  //      SQLite 内嵌 " 用 "" 转义;转 PG 时 "" → " ,内嵌 ' 再转义为 ''。
  s = s.replace(/\bDEFAULT\s+"((?:[^"]|"")*)"/gi, (_m, inner: string) => {
    const literal = inner.replace(/""/g, '"').replace(/'/g, "''")
    return `DEFAULT '${literal}'`
  })

  // 4.6) SQLite GLOB hex-guard → PG POSIX regex。SQLite 无 {n} 量词,用否定字符类 `*[^0-9a-f]*`
  //      (有任意非小写hex字符);PG 等价 `~ '[^0-9a-f]'`(含非hex字符),NOT 版 → `!~`。
  //      仅翻这一已知形态;若出现其它 GLOB,pg:verify 的 GLOB 泄漏检测会拦下(逼回来扩翻译)。
  s = s.replace(/\bNOT\s+GLOB\s+'\*\[\^0-9a-f\]\*'/gi, "!~ '[^0-9a-f]'")
  s = s.replace(/\bGLOB\s+'\*\[\^0-9a-f\]\*'/gi, "~ '[^0-9a-f]'")

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

out.push('-- ════════════ TABLES ════════════')
for (const t of tables) {
  flagReserved(t.name, t.sql)
  out.push(portTableSql(t.sql) + ';')
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
const APPEND_ONLY_TABLES = ['identity_binding_events', 'admin_operator_claim_events', 'agent_execution_mandate_events', 'admin_coordination_fact_sources', 'admin_operator_claim_confirmations', 'admin_operator_unlink_requests', 'admin_operator_claim_marking_corrections', 'direct_pay_fee_receivables', 'direct_pay_fee_invoice_items', 'direct_pay_fee_adjustments', 'direct_pay_fee_invoice_events', 'direct_pay_fee_payments', 'direct_pay_fee_prepay_refunds', 'direct_receive_account_qr_images', 'direct_receive_account_events']   // 后两张:直付收款 QR 快照(内容寻址不可变)+ 收款账号事件审计(#252 审计补:曾漏 → PG 导入丢不可变性)
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
