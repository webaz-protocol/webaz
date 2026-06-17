/**
 * Product external links — 卖家关联 + 验证任务 + 删除
 *
 * 由 #1013 Phase 91 从 src/pwa/server.ts 抽出。
 *
 * 3 endpoints:
 *   GET    /api/products/:id/links            owner 查商品所有外部链接
 *   POST   /api/products/:id/links            添加链接（无冲突直接 verified=1；有冲突 → 发起众包验证任务）
 *   DELETE /api/products/:id/links/:linkId    owner 删除
 *
 * POST 关键规则：
 *   - 支持 (a) {url, external_title?} (b) {text} — 后者从分享文本提取 url + title
 *   - external_title 必须显式输入或从「」抽取，不 fallback 到 product.title
 *   - 同卖家其他商品已关联此链接 → 拒绝
 *   - 已被他人 verified 认领 → 发起 verify_task（锁 0.1 WAZ × 1 verifier）
 *   - 验证码 8 位（排除易混 IOOLZ 等）有效期 72h
 *
 * 跨域注入：auth + generateId + extractUrlFromText + extractTitleFromText + parsePlatformUrl
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface ProductsLinksDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  extractUrlFromText: (text: string | null | undefined) => string | null
  extractTitleFromText: (text: string | null | undefined) => string | null
  parsePlatformUrl: (rawUrl: string | null | undefined) => { platform: string; external_id: string | null } | null
}

export function registerProductsLinksRoutes(app: Application, deps: ProductsLinksDeps): void {
  // 只读/单写站点走 RFC-016 异步 seam;db 保留:认领冲突分支是 fee-lock 资金路径,
  // INSERT 链接 + INSERT 验证任务 + 钱包扣费必须原子(db.transaction + 守恒/dup guard),Phase 3 迁 pg 行锁。
  const { db, auth, generateId, extractUrlFromText, extractTitleFromText, parsePlatformUrl } = deps

  app.get('/api/products/:id/links', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const product = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [req.params.id])
    if (!product) return void res.status(404).json({ error: '商品不存在' })
    if (product.seller_id !== user.id) return void res.status(403).json({ error: '无权限' })
    const links = await dbAll(`SELECT id, url, source, verified, revoked, verify_note, added_at, platform, external_id, external_title FROM product_external_links WHERE product_id = ? ORDER BY added_at ASC`, [req.params.id])
    res.json(links)
  })

  // 新链接（无人认领）直接 verified=1；已被他人认领则发起众包验证任务
  app.post('/api/products/:id/links', async (req: Request, res: Response) => {
    const user = auth(req, res); if (!user) return
    const product = await dbOne<Record<string, unknown>>('SELECT * FROM products WHERE id = ? AND seller_id = ?', [req.params.id, user.id])
    if (!product) return void res.status(404).json({ error: '商品不存在或无权限' })

    // 支持两种 body：(a) {url, external_title?} (b) {text}
    const rawText: string | undefined = req.body?.text
    let url: string | undefined = req.body?.url
    let bodyExternalTitle: string | undefined = req.body?.external_title

    if (!url && rawText) {
      url = extractUrlFromText(rawText) ?? undefined
      if (!bodyExternalTitle) bodyExternalTitle = extractTitleFromText(rawText) ?? undefined
    }

    if (!url || !url.startsWith('http')) return void res.json({ error: '请提供有效链接（URL 或包含 URL 的分享文本）' })

    // 精准匹配原则：external_title 必须显式输入，不 fallback 到 product.title
    const linkExternalTitle: string | null =
      bodyExternalTitle && bodyExternalTitle.trim() ? bodyExternalTitle.trim() : null

    // 已关联此商品
    const existing = await dbOne<{ id: string; verified: number; revoked: number }>('SELECT id, verified, revoked FROM product_external_links WHERE product_id = ? AND url = ?',
      [req.params.id as string, url])
    if (existing) {
      // 主权失效的旧记录：删除后允许重新发起认领
      if (existing.revoked) {
        await dbRun('DELETE FROM product_external_links WHERE id = ?', [existing.id])
      } else {
        return void res.json({ error: '该链接已关联到此商品' })
      }
    }

    // 同卖家的其他商品已关联此链接
    const sameSellerOther = await dbOne<{ title: string }>(`
      SELECT p.title FROM product_external_links pel
      JOIN products p ON pel.product_id = p.id
      WHERE pel.url = ? AND p.seller_id = ? AND pel.product_id != ?
    `, [url, user.id, req.params.id as string])
    if (sameSellerOther) {
      return void res.json({ error: `此链接已在您的商品「${sameSellerOther.title}」中关联，一个链接不能关联多个商品` })
    }

    // 是否已被其他卖家 verified 认领
    const otherClaim = await dbOne<{ product_title: string }>(`
      SELECT p.title as product_title FROM product_external_links pel
      JOIN products p ON pel.product_id = p.id
      WHERE pel.url = ? AND pel.verified = 1 AND p.seller_id != ?
    `, [url, user.id])

    if (!otherClaim) {
      // 新链接，无冲突：直接 verified=1
      const linkId = generateId('lnk')
      const meta = parsePlatformUrl(url)
      await dbRun(`INSERT INTO product_external_links
        (id, product_id, url, source, verified, verified_at, platform, external_id, external_title)
        VALUES (?, ?, ?, 'manual', 1, datetime('now'), ?, ?, ?)`,
          [linkId, req.params.id, url, meta?.platform ?? null, meta?.external_id ?? null, linkExternalTitle])
      return void res.json({ link_id: linkId, verified: 1, external_title: linkExternalTitle, message: '链接已关联' })
    }

    // 已被他人认领：发起众包验证任务
    const existingTask = await dbOne<{ id: string; code: string; status: string; expires_at: string }>(`SELECT id, code, status, expires_at FROM verify_tasks WHERE product_id = ? AND url = ? AND status IN ('code_issued','open')`,
      [req.params.id as string, url])
    if (existingTask) {
      const isPending = existingTask.status === 'code_issued'
      return void res.json({
        task_id: existingTask.id,
        code: `[${existingTask.code}]`,
        status: existingTask.status,
        expires_at: existingTask.expires_at,
        already_pending: true,
        conflict: true,
        instructions: isPending
          ? `此链接已有认领任务，请将验证码 [${existingTask.code}] 放入原平台商品标题或描述，完成后回来点击「确认已添加」提交任务。`
          : `此链接已有进行中的认领任务，等待验证者确认。`,
      })
    }

    const VERIFIERS_NEEDED = 1
    const REWARD_EACH      = 0.1
    const feeLocked        = VERIFIERS_NEEDED * REWARD_EACH
    // 友好预检查(读):真正的守恒门在事务内(WHERE balance >= feeLocked)。
    const wallet = (await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id]))!
    if (wallet.balance < feeLocked) {
      return void res.json({ error: `余额不足：认领验证需锁定 ${feeLocked} WAZ，当前余额 ${wallet.balance} WAZ` })
    }

    // 8 位验证码（排除易混 IOOLZ）
    const chars     = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const code      = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
    const linkId    = generateId('lnk')
    const taskId    = generateId('vtk')
    const expiresAt = new Date(Date.now() + 72 * 3600_000).toISOString()
    const claimMeta = parsePlatformUrl(url)

    // fee-lock 原子段:重检无进行中任务(防双任务双锁费)+ 钱包扣费(守恒 guard)+ INSERT 链接 + INSERT 验证任务。
    try {
      db.transaction(() => {
        const dupTask = db.prepare(`SELECT id FROM verify_tasks WHERE product_id = ? AND url = ? AND status IN ('code_issued','open')`).get(req.params.id, url)
        if (dupTask) throw new Error('LINK_TASK_EXISTS')
        const debit = db.prepare(`UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND balance >= ?`).run(feeLocked, user.id, feeLocked)
        if (debit.changes === 0) throw new Error('LINK_INSUFFICIENT')
        db.prepare(`INSERT INTO product_external_links
          (id, product_id, url, source, verified, verify_note, platform, external_id, external_title)
          VALUES (?, ?, ?, 'manual', 0, '认领验证进行中', ?, ?, ?)`)
          .run(linkId, req.params.id, url, claimMeta?.platform ?? null, claimMeta?.external_id ?? null, linkExternalTitle)
        db.prepare(`INSERT INTO verify_tasks (id, type, product_id, url, code, verifiers_needed, reward_per_verifier, fee_locked, status, expires_at)
          VALUES (?,?,?,?,?,?,?,?,'code_issued',?)`)
          .run(taskId, 'claim', req.params.id, url, code, VERIFIERS_NEEDED, REWARD_EACH, feeLocked, expiresAt)
      })()
    } catch (e) {
      const msg = (e as Error).message
      if (msg === 'LINK_TASK_EXISTS') return void res.json({ error: '此链接已有进行中的认领任务，请刷新页面查看' })
      if (msg === 'LINK_INSUFFICIENT') return void res.json({ error: `余额不足：认领验证需锁定 ${feeLocked} WAZ` })
      console.error('[products-links claim tx]', msg)
      return void res.status(500).json({ error: '发起认领失败,请重试' })
    }

    res.json({
      link_id:  linkId,
      task_id:  taskId,
      verified: 0,
      conflict: true,
      code:     `[${code}]`,
      instructions: `此链接已被其他商家的商品「${otherClaim.product_title}」认领。请将验证码 [${code}] 放入该平台商品标题或描述，完成后在商品编辑页点击「确认已添加」提交验证任务，经审核确认后，链接归属将转移到您的商品。`,
      expires_at: expiresAt,
    })
  })

  app.delete('/api/products/:id/links/:linkId', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const product = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [req.params.id])
    if (!product || product.seller_id !== user.id) return void res.status(403).json({ error: '无权限' })
    await dbRun('DELETE FROM product_external_links WHERE id = ? AND product_id = ?', [req.params.linkId, req.params.id])
    res.json({ success: true })
  })
}
