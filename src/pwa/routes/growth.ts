/**
 * 成长任务域（分享达人养成主线）
 *
 * 由 #1013 Phase 30 从 src/pwa/server.ts 抽出。
 *
 * 4 endpoints:
 *   GET   /api/growth/tasks                我的任务列表 + summary（自动判定完成态）
 *   POST  /api/growth/tasks/:id/claim      标记 claimed
 *   POST  /api/growth/tasks/:id/skip       标记 skipped
 *   POST  /api/growth/tasks/:id/reset      撤销 claim/skip → 回到 available
 *
 * 内部：
 *   - GROWTH_TASK_CATALOG（12 个任务定义，4 章节）
 *   - buildGrowthTaskCtx — 拉用户上下文（bio/anchor/订单数/团队/PV/收益等）
 *   - evaluateGrowthTasks — 自动判定 + 写 completed_at
 *
 * 注：自动判定会写 growth_task_log（INSERT OR REPLACE completed），副作用保留。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

type GrowthTaskCtx = {
  userId: string
  bio: string | null
  search_anchor: string | null
  default_address_line1: string | null
  completed_orders: number
  team_l1: number
  team_total: number
  earnings_grand: number
  shareables_count: number
  manifests_count: number
  min_leg_pv: number
  last_30_total: number
}

type GrowthTaskDef = {
  id: string
  chapter: 1 | 2 | 3 | 4
  title_zh: string
  title_en: string
  desc_zh: string
  desc_en: string
  cta?: { label_zh: string; label_en: string; href?: string; action?: string }
  evaluate: (c: GrowthTaskCtx) => boolean
}

const GROWTH_TASK_CATALOG: GrowthTaskDef[] = [
  // 第 1 关：新手起步
  { id: 'first_purchase', chapter: 1,
    title_zh: '完成首笔购买', title_en: 'Complete first purchase',
    desc_zh: '完成后可使用分享功能(分享仅作归因 / 参与记录)', desc_en: 'Unlocks the share feature (attribution / participation record only)',
    cta: { label_zh: '去发现', label_en: 'Browse', href: '#buy' },
    evaluate: c => c.completed_orders >= 1 },
  { id: 'default_address', chapter: 1,
    title_zh: '设置默认配送地址', title_en: 'Set default shipping address',
    desc_zh: 'AI找同款将按地址过滤可派送商品', desc_en: 'AI Match filters by your address',
    cta: { label_zh: '去填写', label_en: 'Set up', href: '#profile' },
    evaluate: c => !!c.default_address_line1 },
  { id: 'profile_bio', chapter: 1,
    title_zh: '写一句话简介', title_en: 'Write a one-line bio',
    desc_zh: '让买家知道你是谁', desc_en: 'Let buyers know who you are',
    cta: { label_zh: '去设置', label_en: 'Set up', href: '#profile' },
    evaluate: c => !!(c.bio && c.bio.trim()) },
  { id: 'profile_anchor', chapter: 1,
    title_zh: '设置流量口令', title_en: 'Set your search anchor',
    desc_zh: '从抖音 / 小红书引流到 WebAZ', desc_en: 'Funnel traffic from TikTok / Xiaohongshu',
    cta: { label_zh: '去设置', label_en: 'Set up', href: '#profile' },
    evaluate: c => !!(c.search_anchor && c.search_anchor.trim()) },
  // 第 2 关：开始分享
  { id: 'first_l1', chapter: 2,
    title_zh: '你推荐的第一个人完成注册', title_en: 'Your first referral signs up',
    desc_zh: '通过你的邀请链让一人注册', desc_en: 'One sign-up via your referral link',
    cta: { label_zh: '复制邀请链', label_en: 'Copy invite link', action: 'scrollToShareTools' },
    evaluate: c => c.team_l1 >= 1 },
  { id: 'first_shareable', chapter: 2,
    title_zh: '添加首个外部分享链', title_en: 'Add first external share link',
    desc_zh: 'YouTube / TikTok / 小红书 链接绑商品', desc_en: 'Link YouTube / TikTok / etc. to a product',
    cta: { label_zh: '添加', label_en: 'Add', action: 'openAddExternalModal' },
    evaluate: c => c.shareables_count >= 1 },
  { id: 'first_commission', chapter: 2,
    title_zh: '拿到第一笔分享佣金', title_en: 'Earn first share commission',
    desc_zh: '分享链产生第一笔成交', desc_en: 'A share link generates its first sale',
    evaluate: c => c.earnings_grand > 0 },
  // 第 3 关：团队建设
  { id: 'first_manifest', chapter: 3,
    title_zh: '创作首个原生内容', title_en: 'Create first native content',
    desc_zh: 'P2P 流转 + pin 收益', desc_en: 'P2P-distributed + pin rewards',
    cta: { label_zh: '创作', label_en: 'Create', action: 'openCreateNativeModal' },
    evaluate: c => c.manifests_count >= 1 },
  { id: 'team_5', chapter: 3,
    title_zh: '推荐网络达到 5 人', title_en: 'Referral network reaches 5',
    desc_zh: '稳定贡献从这里开始', desc_en: 'Steady contribution starts here',
    evaluate: c => c.team_total >= 5 },
  { id: 'tier1_match', chapter: 3,
    title_zh: '持续贡献阶段 1', title_en: 'Contribution stage 1',
    desc_zh: '推荐网络贡献达到第一阶段标准', desc_en: 'Referral-network contribution reaches stage-1 threshold',
    evaluate: c => c.min_leg_pv >= 30000 },
  // 第 4 关：分享达人
  { id: 'monthly_100', chapter: 4,
    title_zh: '月度推荐收益 100 WAZ', title_en: 'Monthly referral income 100 WAZ',
    desc_zh: '近 30 日累计推荐返利 ≥ 100 WAZ', desc_en: 'Last-30-day referral rewards ≥ 100 WAZ',
    evaluate: c => c.last_30_total >= 100 },
  { id: 'team_50', chapter: 4,
    title_zh: '推荐网络达到 50 人', title_en: 'Referral network reaches 50',
    desc_zh: '正式跻身分享达人', desc_en: 'Officially a share pro',
    evaluate: c => c.team_total >= 50 },
]

// RFC-016: db 参数保留(签名兼容),内部走异步 seam(同实例,setSeamDb)
async function buildGrowthTaskCtx(_db: Database.Database, userId: string): Promise<GrowthTaskCtx> {
  const u = await dbOne<{ bio: string | null; search_anchor: string | null; default_address_json: string | null; default_address_text: string | null }>("SELECT bio, search_anchor, default_address_json, default_address_text FROM users WHERE id = ?", [userId])
  let line1: string | null = null
  try { const a = JSON.parse(u?.default_address_json || 'null'); line1 = a?.line1 || null } catch {}
  if (!line1 && u?.default_address_text) line1 = u.default_address_text  // legacy 兜底
  const completed = (await dbOne<{ n: number }>("SELECT COUNT(*) AS n FROM orders WHERE buyer_id = ? AND status = 'completed'", [userId]))!.n
  const l1 = (await dbOne<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE sponsor_id = ?", [userId]))!.n
  const teamTotal = (await dbOne<{ n: number }>(`
    SELECT COUNT(*) AS n FROM users
    WHERE sponsor_id = ?
       OR sponsor_id IN (SELECT id FROM users WHERE sponsor_id = ?)
       OR sponsor_id IN (SELECT id FROM users WHERE sponsor_id IN (SELECT id FROM users WHERE sponsor_id = ?))
  `, [userId, userId, userId]))!.n
  const grand = (await dbOne<{ s: number }>("SELECT COALESCE(SUM(amount),0) AS s FROM commission_records WHERE beneficiary_id = ?", [userId]))!.s
  const sCount = (await dbOne<{ n: number }>("SELECT COUNT(*) AS n FROM shareables WHERE owner_id = ? AND status = 'active'", [userId]))!.n
  const mCount = (await dbOne<{ n: number }>("SELECT COUNT(*) AS n FROM manifest_registry WHERE owner_id = ? AND status = 'active'", [userId]))!.n
  const pv = await dbOne<{ total_left_pv: number; total_right_pv: number }>("SELECT total_left_pv, total_right_pv FROM users WHERE id = ?", [userId])
  const minLeg = Math.min(Number(pv?.total_left_pv || 0), Number(pv?.total_right_pv || 0))
  const comm30 = (await dbOne<{ s: number }>(`SELECT COALESCE(SUM(amount),0) AS s FROM commission_records WHERE beneficiary_id = ? AND created_at >= datetime('now','-30 days')`, [userId]))!.s
  const waz30 = (await dbOne<{ s: number }>(`SELECT COALESCE(SUM(waz_amount),0) AS s FROM binary_score_records WHERE user_id = ? AND settled_at >= datetime('now','-30 days')`, [userId]))!.s
  return {
    userId,
    bio: u?.bio || null,
    search_anchor: u?.search_anchor || null,
    default_address_line1: line1,
    completed_orders: completed,
    team_l1: l1,
    team_total: teamTotal,
    earnings_grand: grand,
    shareables_count: sCount,
    manifests_count: mCount,
    min_leg_pv: minLeg,
    last_30_total: comm30 + waz30,
  }
}

async function evaluateGrowthTasks(_db: Database.Database, userId: string, lang: 'zh' | 'en' = 'zh') {
  const ctx = await buildGrowthTaskCtx(_db, userId)
  const logs = await dbAll<{ task_id: string; status: string; claimed_at: string | null; completed_at: string | null }>("SELECT task_id, status, claimed_at, completed_at FROM growth_task_log WHERE user_id = ?", [userId])
  const logMap = new Map(logs.map(l => [l.task_id, l]))
  const out: Array<{ id: string; chapter: number; title: string; desc: string; status: string; cta?: { label: string; href?: string; action?: string }; claimed_at?: string | null; completed_at?: string | null }> = []
  for (const t of GROWTH_TASK_CATALOG) {
    const done = t.evaluate(ctx)
    const log = logMap.get(t.id)
    let status: string
    let completed_at: string | null = log?.completed_at || null
    if (done) {
      if (!log || log.status !== 'completed') {
        await dbRun(`INSERT OR REPLACE INTO growth_task_log (user_id, task_id, status, claimed_at, completed_at)
                    VALUES (?,?,?,?,datetime('now'))`, [userId, t.id, 'completed', log?.claimed_at || null])
        completed_at = new Date().toISOString().slice(0, 19).replace('T', ' ')
      }
      status = 'completed'
    } else if (log?.status === 'skipped') status = 'skipped'
    else if (log?.status === 'claimed') status = 'claimed'
    else status = 'available'
    out.push({
      id: t.id, chapter: t.chapter,
      title: lang === 'en' ? t.title_en : t.title_zh,
      desc:  lang === 'en' ? t.desc_en  : t.desc_zh,
      status,
      cta: t.cta ? { label: lang === 'en' ? t.cta.label_en : t.cta.label_zh, href: t.cta.href, action: t.cta.action } : undefined,
      claimed_at: log?.claimed_at || null,
      completed_at,
    })
  }
  const summary = {
    available: out.filter(t => t.status === 'available').length,
    claimed:   out.filter(t => t.status === 'claimed').length,
    completed: out.filter(t => t.status === 'completed').length,
    skipped:   out.filter(t => t.status === 'skipped').length,
    chapter_progress: [1, 2, 3, 4].map(ch => {
      const chTasks = out.filter(t => t.chapter === ch)
      const chDone = chTasks.filter(t => t.status === 'completed').length
      return { chapter: ch, total: chTasks.length, completed: chDone }
    }),
  }
  return { tasks: out, summary }
}

export interface GrowthDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
}

export function registerGrowthRoutes(app: Application, deps: GrowthDeps): void {
  // db 仍在 destructure 中(传给 evaluateGrowthTasks 的签名);本文件 handler 走 RFC-016 异步 seam
  const { db, auth } = deps

  app.get('/api/growth/tasks', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const lang = String(req.headers['accept-language'] || '').startsWith('en') ? 'en' : 'zh'
    res.json(await evaluateGrowthTasks(db, user.id as string, lang))
  })

  app.post('/api/growth/tasks/:id/claim', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const taskId = req.params.id
    if (!GROWTH_TASK_CATALOG.find(t => t.id === taskId)) return void res.json({ error: 'unknown task' })
    const existing = await dbOne<{ status: string; completed_at: string | null }>("SELECT status, completed_at FROM growth_task_log WHERE user_id = ? AND task_id = ?", [user.id, taskId])
    if (existing?.status === 'completed') return void res.json({ error: '该任务已完成' })
    await dbRun(`INSERT OR REPLACE INTO growth_task_log (user_id, task_id, status, claimed_at, completed_at)
                VALUES (?,?,?,datetime('now'),NULL)`, [user.id, taskId, 'claimed'])
    res.json({ success: true, status: 'claimed' })
  })

  app.post('/api/growth/tasks/:id/skip', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const taskId = req.params.id
    if (!GROWTH_TASK_CATALOG.find(t => t.id === taskId)) return void res.json({ error: 'unknown task' })
    const existing = await dbOne<{ status: string }>("SELECT status FROM growth_task_log WHERE user_id = ? AND task_id = ?", [user.id, taskId])
    if (existing?.status === 'completed') return void res.json({ error: '该任务已完成，无法跳过' })
    await dbRun(`INSERT OR REPLACE INTO growth_task_log (user_id, task_id, status, claimed_at, completed_at)
                VALUES (?,?,?,NULL,NULL)`, [user.id, taskId, 'skipped'])
    res.json({ success: true, status: 'skipped' })
  })

  app.post('/api/growth/tasks/:id/reset', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const taskId = req.params.id
    if (!GROWTH_TASK_CATALOG.find(t => t.id === taskId)) return void res.json({ error: 'unknown task' })
    const existing = await dbOne<{ status: string }>("SELECT status FROM growth_task_log WHERE user_id = ? AND task_id = ?", [user.id, taskId])
    if (existing?.status === 'completed') return void res.json({ error: '已完成任务无法重置' })
    await dbRun("DELETE FROM growth_task_log WHERE user_id = ? AND task_id = ?", [user.id, taskId])
    res.json({ success: true, status: 'available' })
  })
}
