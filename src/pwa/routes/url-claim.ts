/**
 * 外链认领 / 验证 — 链接挑战 + 卖家认领他人已占链接
 *
 * 由 #1013 Phase 113 从 src/pwa/server.ts 抽出。
 *
 * 2 endpoints:
 *   POST /api/link-challenges/:id/verify  挑战 fetch HTML 查 [WebAZ-CODE]，通过则转移链接
 *   POST /api/claim-url                   建商品 + 锁质押 + feeLocked + 8 字符 code · 72h
 *
 * 跨域注入：auth + db + safeFetch + generateId + parsePlatformUrl
 *           + getStakeDiscount + makeCommitmentHash/makeDescriptionHash/makePriceHash
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface UrlClaimDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  safeFetch: (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ text: () => Promise<string> }>
  generateId: (prefix: string) => string
  parsePlatformUrl: (url: string) => { platform: string; external_id: string | null } | null
  getStakeDiscount: (db: Database.Database, userId: string) => Promise<number>
  makeCommitmentHash: (fields: Record<string, unknown>) => string
  makeDescriptionHash: (fields: Record<string, unknown>) => string
  makePriceHash: (price: number, ts: string) => string
}

export function registerUrlClaimRoutes(app: Application, deps: UrlClaimDeps): void {
  const { db, auth, safeFetch, generateId, parsePlatformUrl,
          getStakeDiscount, makeCommitmentHash, makeDescriptionHash, makePriceHash } = deps

  app.post('/api/link-challenges/:id/verify', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const challenge = await dbOne<Record<string, unknown>>(`SELECT * FROM link_challenges WHERE id = ? AND status = 'pending'`,
      [req.params.id])
    if (!challenge) return void res.json({ error: '验证码不存在或已失效' })
    if (challenge.product_id !== undefined) {
      const prod = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [challenge.product_id])
      if (!prod || prod.seller_id !== user.id) return void res.status(403).json({ error: '无权限' })
    }
    if (new Date(challenge.expires_at as string) < new Date()) {
      await dbRun(`UPDATE link_challenges SET status='expired' WHERE id = ?`, [req.params.id])
      return void res.json({ error: '验证码已过期（48小时有效），请重新添加链接' })
    }

    const fullCode = `WebAZ-${challenge.code}`
    const chUrl = String(challenge.url || '')
    try {
      const ctrl = new AbortController()
      setTimeout(() => ctrl.abort(), 10000)
      const resp = await safeFetch(chUrl, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-CN,zh' } })
      const html = await resp.text()
      if (!html.includes(fullCode)) {
        return void res.json({ error: `页面中未找到验证码 "${fullCode}"，请确认已保存到商品标题或描述中` })
      }
    } catch (e: unknown) {
      const msg = (e as Error).message
      if (msg.startsWith('ssrf_')) return void res.json({ error: '链接指向私网/localhost 或经 redirect 触达内部地址，已拦截' })
      return void res.json({ error: `无法访问页面：${msg}` })
    }

    // 原子段:CAS 翻转 challenge pending→verified(防并发/重放双转移)+ 链接转移到本商品一起落。
    let transferred = false
    try {
      transferred = db.transaction(() => {
        const cas = db.prepare(`UPDATE link_challenges SET status='verified', verified_at=datetime('now') WHERE id=? AND status='pending'`).run(req.params.id)
        if (cas.changes === 0) return false
        db.prepare(`UPDATE product_external_links SET product_id = ?, verify_note = '通过挑战验证，从原商品转移', verified_at = datetime('now') WHERE url = ?`)
          .run(challenge.product_id, challenge.url)
        return true
      })()
    } catch (e) {
      console.error('[url-claim challenge verify tx]', (e as Error).message)
      return void res.status(500).json({ error: '验证失败,请重试' })
    }
    if (!transferred) return void res.json({ error: '验证码已被处理，请刷新页面' })
    res.json({ success: true, message: `验证成功！链接已转移到此商品。` })
  })

  app.post('/api/claim-url', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller') return void res.json({ error: '仅卖家可发起认领' })

    const {
      url, title, description, price, stock = 1, category = '',
      specs, handling_hours = 24, return_days = 7, warranty_days = 0,
      external_title,
    } = req.body
    if (!url || !title || !description || !price) {
      return void res.json({ error: '请填写链接、商品名、描述和价格' })
    }
    const claimExternalTitle: string | null =
      typeof external_title === 'string' && external_title.trim() ? external_title.trim() : null

    const otherClaim = await dbOne<{ id: string }>(`
      SELECT p.id FROM product_external_links pel
      JOIN products p ON pel.product_id = p.id
      WHERE pel.url = ? AND pel.verified = 1 AND p.seller_id != ?
    `, [url, user.id])
    if (!otherClaim) {
      return void res.json({ error: '该链接当前没有其他商家认领，请直接使用导入上架功能' })
    }

    const existingClaim = await dbOne<{ id: string }>(`
      SELECT vt.id FROM verify_tasks vt
      JOIN products p ON vt.product_id = p.id
      WHERE vt.url = ? AND p.seller_id = ? AND vt.status IN ('code_issued','open')
    `, [url, user.id])
    if (existingClaim) {
      return void res.json({ error: '您已有针对此链接的进行中认领任务，请在商品编辑页查看并确认', task_id: existingClaim.id })
    }

    const VERIFIERS_NEEDED = 1
    const REWARD_EACH      = 0.1
    const feeLocked        = VERIFIERS_NEEDED * REWARD_EACH
    // 友好预检查(读):真正的守恒门在事务内(WHERE balance >= stake+fee)。
    const wallet = (await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id]))!
    const priceNum = Number(price)
    const stakeDiscount = await getStakeDiscount(db, user.id as string)
    const stakeRate = Math.max(0.05, 0.15 - stakeDiscount)
    const stakeAmount = Math.round(priceNum * stakeRate * 100) / 100
    if (wallet.balance < stakeAmount + feeLocked) {
      return void res.json({ error: `余额不足：需要 ${stakeAmount} WAZ 质押 + ${feeLocked} WAZ 验证费，当前余额 ${wallet.balance} WAZ` })
    }

    const now = new Date().toISOString()
    const productId = generateId('prd')
    const specsJson = specs ? (typeof specs === 'string' ? specs : JSON.stringify(specs)) : null
    const pFields   = { ship_regions: '全国', handling_hours, estimated_days: null, return_days, return_condition: '', warranty_days }
    const linkId    = generateId('lnk')
    const claimUrlMeta = parsePlatformUrl(url)
    const chars     = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const code      = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
    const taskId    = generateId('vtk')
    const expiresAt = new Date(Date.now() + 72 * 3600_000).toISOString()

    // stake+fee 原子段:重检无进行中认领(防双任务双锁)+ 钱包一次性扣 stake+fee(守恒 guard)
    //   + 建商品(warehouse)+ 锁定时间 + INSERT 链接 + INSERT 验证任务。任一失败整段回滚。
    // 注:原代码两次扣款(stake 一次、fee 一次)合并为一次 balance -= stake+fee, staked += stake(语义等价)。
    try {
      db.transaction(() => {
        const dupTask = db.prepare(`SELECT vt.id FROM verify_tasks vt JOIN products p ON vt.product_id = p.id WHERE vt.url = ? AND p.seller_id = ? AND vt.status IN ('code_issued','open')`)
          .get(url, user.id)
        if (dupTask) throw new Error('CLAIM_EXISTS')
        const debit = db.prepare(`UPDATE wallets SET balance = balance - ?, staked = staked + ? WHERE user_id = ? AND balance >= ?`)
          .run(stakeAmount + feeLocked, stakeAmount, user.id, stakeAmount + feeLocked)
        if (debit.changes === 0) throw new Error('CLAIM_INSUFFICIENT')
        db.prepare(`INSERT INTO products (
          id, seller_id, title, description, price, stock, category, stake_amount,
          specs, source_url, handling_hours, return_days, warranty_days,
          commitment_hash, description_hash, price_hash, hashed_at, status, stake_locked_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'warehouse',datetime('now'))`)
          .run(productId, user.id, title, description, priceNum, Number(stock), category, stakeAmount,
            specsJson, url, Number(handling_hours), Number(return_days), Number(warranty_days),
            makeCommitmentHash(pFields), makeDescriptionHash({ title, description, specs: specsJson }),
            makePriceHash(priceNum, now), now)
        db.prepare(`INSERT INTO product_external_links
          (id, product_id, url, source, verified, verify_note, platform, external_id, external_title)
          VALUES (?,?,?,'claim',0,'认领验证进行中',?,?,?)`)
          .run(linkId, productId, url, claimUrlMeta?.platform ?? null, claimUrlMeta?.external_id ?? null, claimExternalTitle)
        db.prepare(`INSERT INTO verify_tasks (id, type, product_id, url, code, verifiers_needed, reward_per_verifier, fee_locked, status, expires_at)
          VALUES (?,?,?,?,?,?,?,?,'code_issued',?)`)
          .run(taskId, 'code_check', productId, url, code, VERIFIERS_NEEDED, REWARD_EACH, feeLocked, expiresAt)
      })()
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'CLAIM_EXISTS') return void res.json({ error: '您已有针对此链接的进行中认领任务，请在商品编辑页查看并确认' })
      if (msg === 'CLAIM_INSUFFICIENT') return void res.json({ error: `余额不足：需要 ${stakeAmount} WAZ 质押 + ${feeLocked} WAZ 验证费` })
      console.error('[url-claim claim-url tx]', msg)
      return void res.status(500).json({ error: '认领失败,请重试' })
    }

    res.json({
      success: true,
      product_id: productId,
      task_id: taskId,
      code: `[${code}]`,
      expires_at: expiresAt,
      message: `商品已建立，认领任务已创建。请在原平台商品标题或描述中加入验证码 [${code}]，完成后在商品编辑页点击「确认已添加」提交任务，审核通过后链接归属自动转移。`,
    })
  })
}
