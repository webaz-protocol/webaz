// RFC-016 Phase 0 — async DB seam 单测:dbOne/dbAll/dbRun 语义 + resolved-Promise 行为。
// 用内存 sqlite 注入 seam,验证读/写/无命中/参数化全对。
import Database from 'better-sqlite3'
import { setSeamDb, dbOne, dbAll, dbRun } from '../src/layer0-foundation/L0-1-database/db.js'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, x?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, x !== undefined ? JSON.stringify(x) : '') } }

const db = new Database(':memory:')
db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, s TEXT)")
setSeamDb(db)

await (async () => {
  // dbRun insert
  const r1 = await dbRun("INSERT INTO t (id, n, s) VALUES (?, ?, ?)", ['a', 1, 'x'])
  ok('dbRun insert → changes=1', r1.changes === 1, r1)
  await dbRun("INSERT INTO t (id, n, s) VALUES (?, ?, ?)", ['b', 2, 'y'])

  // dbOne hit / miss / params
  const one = await dbOne<{ id: string; n: number }>("SELECT id, n FROM t WHERE id = ?", ['a'])
  ok('dbOne hit → row', !!one && one.id === 'a' && one.n === 1, one)
  const miss = await dbOne("SELECT * FROM t WHERE id = ?", ['nope'])
  ok('dbOne miss → undefined', miss === undefined, miss)

  // dbAll
  const all = await dbAll<{ id: string }>("SELECT id FROM t ORDER BY id")
  ok('dbAll → 2 rows ordered', all.length === 2 && all[0].id === 'a' && all[1].id === 'b', all)

  // dbRun update reflects
  const r2 = await dbRun("UPDATE t SET n = ? WHERE id = ?", [9, 'a'])
  ok('dbRun update → changes=1', r2.changes === 1, r2)
  const after = await dbOne<{ n: number }>("SELECT n FROM t WHERE id = ?", ['a'])
  ok('update reflected → n=9', after?.n === 9, after)

  // returns are real Promises (await-able), not sync values
  const p = dbAll("SELECT 1 AS x")
  ok('dbAll returns a Promise', typeof (p as Promise<unknown>).then === 'function')
  await p
})()

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
