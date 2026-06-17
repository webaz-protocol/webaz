// RFC-006 断点2 验证:proposal 被采纳 → 桥 → 可认领 build_task + 邀请提案人(真实引擎,无网络)。
//   断点2 = "反馈被采纳" 接到 "来一起建设"。桥在 adminUpdateBuildFeedback(promoteToTask=true) 上,
//   由 maintainer 决定哪些 proposal 升任务(非每次采纳都自动建)。本测验证桥真的接通。
import Database from 'better-sqlite3'
import { initBuildFeedbackSchema, submitBuildFeedback, adminUpdateBuildFeedback, listMyBuildFeedback } from '../src/layer2-business/L2-8-feedback/build-feedback-engine.js'
import { initBuildTasksSchema, listBuildTasks } from '../src/layer2-business/L2-9-contribution/build-tasks-engine.js'
import { initBuildReputationSchema } from '../src/layer2-business/L2-9-contribution/build-reputation-engine.js'

let pass = 0, fail = 0
const expect = (n: string, c: boolean, h?: unknown) => { if (c) { pass++; console.log('✓', n) } else { fail++; console.log('✗', n, h !== undefined ? JSON.stringify(h) : '') } }

const db = new Database(':memory:')
initBuildFeedbackSchema(db)
initBuildTasksSchema(db)
initBuildReputationSchema(db)
db.exec(`CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, title TEXT, body TEXT, read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));`)

const notifsTo = (uid: string, type: string) => db.prepare("SELECT * FROM notifications WHERE user_id=? AND type=?").all(uid, type) as Array<Record<string, unknown>>
const openTasks = () => (listBuildTasks(db, { status: 'open' }) as Array<Record<string, unknown>>)

// 提案人提交一个 proposal(真实 submit 路径)
const sub = submitBuildFeedback(db, { userId: 'proposer1', type: 'proposal', area: 'orders', subject: '订单页加批量导出', body: '希望能一键导出我的订单 CSV', source: 'agent' })
expect('proposal 提交成功', !('error' in sub), sub)
const fid = (sub as { id: string }).id

// ── 桥:maintainer 采纳 + promoteToTask ──
const before = openTasks().length
const r = adminUpdateBuildFeedback(db, { id: fid, status: 'resolved', promoteToTask: true, credit: false, adminId: 'admin1' })
expect('adminUpdate 成功', !('error' in r), r)
const promotedTaskId = (r as { promoted_task_id?: string }).promoted_task_id
expect('断点2:返回 promoted_task_id(建了任务)', !!promotedTaskId, r)
expect('断点2:open build_task +1', openTasks().length === before + 1, { before, after: openTasks().length })

// 任务内容来自提案
const task = openTasks().find(t => t.id === promotedTaskId)
expect('任务标题来自提案 subject', !!task && String(task.title).includes('批量导出'), task?.title)

// 邀请提案人
const invites = notifsTo('proposer1', 'build_invite')
expect('断点2:提案人收到 build_invite 邀请', invites.length === 1, invites.length)
expect('邀请正文含任务号 + 引导 webaz_contribute', invites.length === 1 && String(invites[0].body).includes(promotedTaskId!) && String(invites[0].body).includes('webaz_contribute'))

// 反馈闭环里能看到 promoted_task_id(用户查"我的反馈到哪了")
const mine = listMyBuildFeedback(db, 'proposer1') as Array<Record<string, unknown>>
const row = mine.find(m => m.id === fid)
expect('闭环:listMyBuildFeedback 显示 promoted_task_id', !!row && row.promoted_task_id === promotedTaskId, row?.promoted_task_id)

// ── 幂等:再 promote 一次不重复建 ──
const r2 = adminUpdateBuildFeedback(db, { id: fid, status: 'resolved', promoteToTask: true, credit: false, adminId: 'admin1' })
expect('幂等:二次 promote 不返回新 task', !('error' in r2) && !(r2 as { promoted_task_id?: string }).promoted_task_id)
expect('幂等:open task 数不变', openTasks().length === before + 1)
expect('幂等:不重复发邀请', notifsTo('proposer1', 'build_invite').length === 1)

// ── 边界:非 proposal(bug)即使 promoteToTask 也不建任务 ──
const bug = submitBuildFeedback(db, { userId: 'reporter1', type: 'bug', area: 'orders', subject: '导出按钮 404', body: '点了导出按钮直接报错 404 页面', source: 'agent' })
const rb = adminUpdateBuildFeedback(db, { id: (bug as { id: string }).id, status: 'resolved', promoteToTask: true, credit: false, adminId: 'admin1' })
expect('边界:bug 类反馈不升任务(仅 proposal 升)', !('error' in rb) && !(rb as { promoted_task_id?: string }).promoted_task_id)
expect('边界:open task 数仍不变', openTasks().length === before + 1)

// ── Codex #113 P2:promote 只能在 resolved(采纳)时执行 ──
{
  const p = submitBuildFeedback(db, { userId: 'proposer2', type: 'proposal', area: 'orders', subject: '加暗色模式', body: '希望支持暗色主题', source: 'agent' })
  const pid = (p as { id: string }).id
  const baseOpen = openTasks().length
  // 非 resolved(triaged)+ promote → 报错,不建任务,不发邀请
  const bad = adminUpdateBuildFeedback(db, { id: pid, status: 'triaged', promoteToTask: true, credit: false, adminId: 'admin1' })
  expect('Codex#113:非 resolved promote 返回 PROMOTE_REQUIRES_RESOLVED', ('error' in bad) && bad.error === 'PROMOTE_REQUIRES_RESOLVED', bad)
  expect('Codex#113:非 resolved 不建 build_task', openTasks().length === baseOpen, { baseOpen, after: openTasks().length })
  expect('Codex#113:非 resolved 不发被采纳邀请', notifsTo('proposer2', 'build_invite').length === 0)
  expect('Codex#113:报错时状态未被改成 triaged(写前短路)', (db.prepare('SELECT status FROM build_feedback WHERE id=?').get(pid) as { status: string }).status !== 'triaged')
  // resolved + promote → 正常建一次
  const ok = adminUpdateBuildFeedback(db, { id: pid, status: 'resolved', promoteToTask: true, credit: false, adminId: 'admin1' })
  expect('Codex#113:resolved + promote 建任务一次', !('error' in ok) && !!(ok as { promoted_task_id?: string }).promoted_task_id)
  expect('Codex#113:open task +1', openTasks().length === baseOpen + 1)
  expect('Codex#113:提案人收到一次邀请', notifsTo('proposer2', 'build_invite').length === 1)
}

console.log(`\n${pass} pass · ${fail} fail`)
if (fail > 0) process.exit(1)
