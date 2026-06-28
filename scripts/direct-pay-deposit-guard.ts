#!/usr/bin/env tsx
/**
 * Direct Pay (Rail 1) — base-bond deposit write-boundary guard (PR-4b-1 + 4b-1 hardening).
 *
 * direct_receive_deposits 是【商家履约担保物】台账,production_receipt_confirmed_at(+ production_* 快照)是 Direct Pay
 *   生产硬门的【唯一真相】。本 guard 静态守住四条边界,防止任何 PR 误开"绕过门"或"manual 冒充生产":
 *
 *   1. routes/** 绝不 raw INSERT/UPDATE direct_receive_deposits(必须经域 helper)。
 *   2. 对 direct_receive_deposits 的 INSERT/UPDATE 只允许出现在 src/direct-receive-deposits.ts(单一写入文件)。
 *   3. production_receipt_confirmed_at 的【写赋值】(SQL SET)只允许出现在【明确命名的 helper 函数】confirmProductionReceipt
 *      内 —— 不再是文件级 allowlist,而是 helper/invariant 级:即便在域 helper 文件内,也只有该函数可写此列。
 *      该 helper 当前【尚不存在】(4b-3 才建,且必须 assertProductionDepositRail-gated)→ 故现在 src/** 内
 *      【没有任何】production_receipt_confirmed_at 写入是合法的。
 *   4. 读路径(IS NOT NULL / != null / SELECT)与 CREATE TABLE 列声明【不】误报。
 *
 * 纯静态文本扫描;无 DB、无 boot。含内联 self-test(校验匹配器不回归)。失败即 exit 1。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const ROUTES = join(SRC, 'pwa', 'routes')

// 对 direct_receive_deposits 整表的 INSERT/UPDATE 只允许这一个域文件。
const DEPOSIT_WRITER_FILE = 'src/direct-receive-deposits.ts'
// production_receipt_confirmed_at 的写入只允许这一个【helper 函数名】(无论在哪个文件)。
const PRODUCTION_RECEIPT_WRITER_FN = 'confirmProductionReceipt'
// 且该 helper body 必须调用此【生产/法务闸】不变量 —— 没调它就不许写生产 receipt(防 4b-3 写出未 gate 的 writer)。
const PRODUCTION_RECEIPT_GATE_FN = 'assertProductionDepositRail'

const DEPOSIT_WRITE_RE = /\b(INSERT\s+INTO|UPDATE)\s+direct_receive_deposits\b/i
const PROD_RECEIPT_SET_RE = /production_receipt_confirmed_at\s*=/   // SQL SET 赋值(读如 `!= null` / `IS NOT NULL` 不匹配;`TEXT,` 列声明不匹配)
const GATE_CALL_RE = new RegExp(`\\b${PRODUCTION_RECEIPT_GATE_FN}\\s*\\(`)

/** 某行所属的【模块级】符号名(最近的 `function NAME` / `const NAME =`,锚定行首=模块级,跳过函数体内缩进的 const)。 */
function enclosingModuleSymbol(lines: string[], idx: number): string | null {
  for (let i = idx; i >= 0; i--) {
    const fn = lines[i].match(/^(?:export\s+)?function\s+(\w+)/)
    if (fn) return fn[1]
    const cn = lines[i].match(/^(?:export\s+)?const\s+(\w+)\s*=/)
    if (cn) return cn[1]
  }
  return null
}

/** 提取某模块级函数(function NAME / const NAME =)的 body 文本(从声明行起花括号配平);找不到返回 null。 */
function moduleFnBody(lines: string[], name: string): string | null {
  const decl = new RegExp(`^(?:export\\s+)?(?:function\\s+${name}\\b|const\\s+${name}\\s*=)`)
  let start = -1
  for (let i = 0; i < lines.length; i++) { if (decl.test(lines[i])) { start = i; break } }
  if (start < 0) return null
  let depth = 0, opened = false
  const body: string[] = []
  for (let i = start; i < lines.length; i++) {
    body.push(lines[i])
    for (const ch of lines[i]) { if (ch === '{') { depth++; opened = true } else if (ch === '}') depth-- }
    if (opened && depth <= 0) break
  }
  return body.join('\n')
}

/** 文件内对 production_receipt_confirmed_at 的【非法写入】(行号 + 原因)。
 *  合法 ⟺ 写赋值位于 confirmProductionReceipt 内 且 该 helper body 调用了 assertProductionDepositRail(...)。 */
function illegalProdReceiptWrites(src: string): Array<{ line: number; reason: string }> {
  const lines = src.split('\n')
  const bad: Array<{ line: number; reason: string }> = []
  for (let i = 0; i < lines.length; i++) {
    if (!PROD_RECEIPT_SET_RE.test(lines[i])) continue
    if (enclosingModuleSymbol(lines, i) !== PRODUCTION_RECEIPT_WRITER_FN) {
      bad.push({ line: i + 1, reason: `outside the '${PRODUCTION_RECEIPT_WRITER_FN}' helper` })
      continue
    }
    const body = moduleFnBody(lines, PRODUCTION_RECEIPT_WRITER_FN)
    if (!body || !GATE_CALL_RE.test(body)) {
      bad.push({ line: i + 1, reason: `'${PRODUCTION_RECEIPT_WRITER_FN}' writes the production receipt but does not call ${PRODUCTION_RECEIPT_GATE_FN}() — the legal-cleared production-rail gate is mandatory` })
    }
  }
  return bad
}

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (e.endsWith('.ts')) out.push(p)
  }
  return out
}
const rel = (p: string) => relative(ROOT, p).split('\\').join('/')

// ──────────────────────────── self-test (匹配器不回归) ────────────────────────────
function selfTest(): string[] {
  const errs: string[] = []
  const expect = (name: string, cond: boolean) => { if (!cond) errs.push(`self-test FAILED: ${name}`) }
  // route raw write → 抓
  expect('catches INSERT direct_receive_deposits', DEPOSIT_WRITE_RE.test("db.prepare('INSERT INTO direct_receive_deposits (id) VALUES (?)')"))
  expect('catches UPDATE direct_receive_deposits', DEPOSIT_WRITE_RE.test('UPDATE direct_receive_deposits SET status=?'))
  // prod-receipt SET inside a NON-confirmProductionReceipt fn → 抓(原因=outside helper)
  const badFix = ['export function sneakyConfirm(db) {', "  db.prepare(\"UPDATE direct_receive_deposits SET production_receipt_confirmed_at = datetime('now') WHERE id=?\")", '}'].join('\n')
  expect('catches prod-receipt SET outside confirmProductionReceipt', illegalProdReceiptWrites(badFix).length === 1 && /outside/.test(illegalProdReceiptWrites(badFix)[0].reason))
  // prod-receipt SET INSIDE confirmProductionReceipt 但【未调用 assertProductionDepositRail】→ 抓(原因=missing gate)
  const badFix2 = ['export function confirmProductionReceipt(db, args) {', "  const ref = args.ref", "  db.prepare(\"UPDATE direct_receive_deposits SET production_receipt_confirmed_at = datetime('now') WHERE id=?\")", '}'].join('\n')
  expect('catches confirmProductionReceipt write WITHOUT assertProductionDepositRail', illegalProdReceiptWrites(badFix2).length === 1 && /assertProductionDepositRail/.test(illegalProdReceiptWrites(badFix2)[0].reason))
  // prod-receipt SET INSIDE confirmProductionReceipt 且【先调用 assertProductionDepositRail(...)】(还带内层 const)→ 允许
  const okFix = ['export function confirmProductionReceipt(db, args) {', "  const ref = args.ref", '  assertProductionDepositRail(getDepositRail(args.railId))', "  db.prepare(\"UPDATE direct_receive_deposits SET production_receipt_confirmed_at = datetime('now'), production_receipt_ref = ? WHERE id=?\")", '}'].join('\n')
  expect('allows prod-receipt SET inside gated confirmProductionReceipt (skips inner const)', illegalProdReceiptWrites(okFix).length === 0)
  // reads → 忽略
  expect('ignores != null read', illegalProdReceiptWrites('return row.production_receipt_confirmed_at != null').length === 0)
  expect('ignores IS NOT NULL read', illegalProdReceiptWrites("SELECT 1 FROM direct_receive_deposits WHERE production_receipt_confirmed_at IS NOT NULL").length === 0)
  // CREATE TABLE column declaration → 忽略
  expect('ignores CREATE column declaration', illegalProdReceiptWrites('      production_receipt_confirmed_at TEXT,').length === 0)
  return errs
}

// ──────────────────────────── main scan ────────────────────────────
let failed = false
const fail = (m: string) => { failed = true; console.error(`❌ ${m}`) }

const selfErrs = selfTest()
if (selfErrs.length) { selfErrs.forEach(e => fail(e)); }

// guard 1: routes/** 无 raw INSERT/UPDATE direct_receive_deposits
for (const f of tsFiles(ROUTES)) {
  if (DEPOSIT_WRITE_RE.test(readFileSync(f, 'utf8'))) {
    fail(`${rel(f)}: raw INSERT/UPDATE direct_receive_deposits in a route — must go through ${DEPOSIT_WRITER_FILE} helpers (no route-level deposit writes).`)
  }
}

for (const f of tsFiles(SRC)) {
  const r = rel(f)
  const src = readFileSync(f, 'utf8')
  // guard 2: 整表写入只在域文件
  if (DEPOSIT_WRITE_RE.test(src) && r !== DEPOSIT_WRITER_FILE) {
    fail(`${r}: writes direct_receive_deposits outside the single writer module — only ${DEPOSIT_WRITER_FILE} may INSERT/UPDATE it.`)
  }
  // guard 3 (hardened, helper + invariant level): production_receipt_confirmed_at 写赋值只能在 confirmProductionReceipt
  //   函数内,且该 helper 必须调用 assertProductionDepositRail(...)。当前该 helper 不存在 → 任何写入都非法。
  for (const { line, reason } of illegalProdReceiptWrites(src)) {
    fail(`${r}:${line}: illegal production_receipt_confirmed_at write — ${reason}. This column is the sole production go-live gate; its only writer must be a single legal-cleared '${PRODUCTION_RECEIPT_WRITER_FN}' that calls ${PRODUCTION_RECEIPT_GATE_FN}() (not yet built → no writes allowed).`)
  }
}

if (failed) {
  console.error('\nDirect Pay deposit write-boundary guard FAILED — see above. These boundaries keep the base-bond production gate fail-closed and un-bypassable.')
  process.exit(1)
}
console.log(`✅ direct-pay deposit write-boundary guard: no route raw-writes; direct_receive_deposits writes confined to ${DEPOSIT_WRITER_FILE}; production_receipt_confirmed_at writable ONLY inside ${PRODUCTION_RECEIPT_WRITER_FN}() AND only if it calls ${PRODUCTION_RECEIPT_GATE_FN}() (writes stay unreachable until a rail is legal-cleared); self-test ${selfErrs.length === 0 ? 'OK' : 'FAILED'}.`)
