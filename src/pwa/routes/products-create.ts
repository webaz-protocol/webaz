/**
 * Products POST create — 卖家上架 + 来源链接冲突检测 + alias 入库
 *
 * 由 #1013 Phase 94 从 src/pwa/server.ts 抽出（单端点 232 行）。
 *
 * 1 endpoint:
 *   POST /api/products
 *
 * 关键路径：
 *   1. 角色门 + 1h 上架 ≤5 速率
 *   2. checkSellerCanList 配额检查
 *   3. 图片 hash 校验（≤9 张 + 64 hex）
 *   4. VALID_PRODUCT_TYPES 校验
 *   5. external_title 不 fallback 到店铺 title（精准匹配）
 *   6. M7.2.6 免质押上架（stake 记录为 stake_deferred，首单成交时锁定）
 *   7. INSERT + 重算 commitment/description/price hash
 *   8. aliases 同步入库（卖家勾选的 candidates）
 *   9. source_url 冲突检测：
 *      - 他人 verified=1 → 进 warehouse + 发起验证任务（锁 0.1 WAZ + 8 位码 + 72h）
 *      - 无冲突 → verified=1
 *   10. additional_links 同步冲突检查（最多 5 个）
 *
 * 跨域注入：auth + generateId + checkSellerCanList + getStakeDiscount + VALID_PRODUCT_TYPES
 *           + parsePlatformUrl + makeCommitmentHash + makeDescriptionHash + makePriceHash
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface ProductsCreateDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
  checkSellerCanList: (user: Record<string, unknown>) => { ok: boolean; reason?: string }
  getStakeDiscount: (db: Database.Database, userId: string) => Promise<number>
  VALID_PRODUCT_TYPES: Set<string>
  parsePlatformUrl: (rawUrl: string | null | undefined) => { platform: string; external_id: string | null } | null
  makeCommitmentHash: (p: Record<string, unknown>) => string
  makeDescriptionHash: (p: Record<string, unknown>) => string
  makePriceHash: (price: number, ts: string) => string
}

export interface CreateProductOpts {
  forceStatus?: 'warehouse'
  onCreated?: (productId: string) => Promise<void> | void
  // RFC-020 PR-4: when a SAFE grant (seller_product_draft) creates a draft, ALL external source-link handling
  //   MUST be skipped AND source_url/source_price are NOT persisted — a grant cannot associate a source link
  //   at all. Otherwise (a) a colliding source_url debits the seller's wallet (0.1 WAZ verify fee) + spawns a
  //   verify_task — a money side-effect a safe scope must never trigger; and (b) even just storing source_url
  //   would let the draft carry a link claim that never enters the conflict/verification machinery the human
  //   create path opens (verification is the feature that ADJUDICATES a claim — keep vs revoke the link — not a
  //   publish gate; publish never re-checks source_url). The human associates links themselves when they
  //   edit/publish, which opens that adjudication normally.
  skipExternalLinkEffects?: boolean
}

/**
 * The SINGLE source of product-create validation + insert. res-coupled but auth-agnostic: the caller resolves
 * `user` (the human api_key route, OR the delegation-grant draft route) and may force `warehouse` status. Both
 * the human `POST /api/products` and the grant-gated draft route MUST go through this — no parallel copy.
 */
export function makeCreateProductHandler(deps: ProductsCreateDeps) {
  const { db, generateId, checkSellerCanList, getStakeDiscount, VALID_PRODUCT_TYPES,
          parsePlatformUrl, makeCommitmentHash, makeDescriptionHash, makePriceHash } = deps
  return async function createProductHandler(req: Request, res: Response, user: Record<string, unknown>, opts: CreateProductOpts = {}): Promise<void> {
    // 里程碑 3-D：1h 上架限速（防 spam 批量上架）
    const LISTING_RATE_LIMIT = 5
    const recentListings = (await dbOne<{ n: number }>(`
      SELECT COUNT(1) as n FROM products
      WHERE seller_id = ? AND created_at > datetime('now', '-1 hour')
    `, [user.id]))!.n
    if (recentListings >= LISTING_RATE_LIMIT) {
      return void res.status(429).json({
        error: `上架过于频繁：1 小时内最多 ${LISTING_RATE_LIMIT} 个商品（当前已 ${recentListings} 个）`,
        retry_after_seconds: 3600,
      })
    }

    // 发新品配额检查（模块 A）
    const quotaCheck = checkSellerCanList(user)
    if (!quotaCheck.ok) return void res.json({ error: quotaCheck.reason })

    const {
      title, description, price, stock = 1, category = '',
      specs, brand, model, source_url, source_price, external_title,
      weight_kg, ship_regions = '全国', handling_hours = 24,
      estimated_days, fragile = 0,
      return_days = 7, return_condition = '', warranty_days = 0,
      low_stock_threshold = 3, auto_delist_on_zero = 1,
      commission_rate,
      product_type = 'retail', create_status,   // 里程碑 6 / S4:create_status='warehouse' 让含单品覆盖的新品先落仓库,覆盖全落定再激活(避免公开 active 但缺可售/税费声明)
      aliases = [],              // 里程碑 7.2：上架时同步声明的 alias 集合
      image_hashes = [],         // 商品图片 — 只存 hash（64 hex），实际 blob 在卖家节点 IDB
      package_size, origin_country, country_of_origin, customs_description, hs_code,   // S0 跨境清关/物流证据字段(全可选,零计费逻辑;进条款快照)
    } = req.body

    // 协议化原则：服务端只存 hash 引用，不存图片字节。校验仅做格式 + 数量。
    let imagesJsonForInsert: string | null = null
    if (Array.isArray(image_hashes) && image_hashes.length > 0) {
      if (image_hashes.length > 9) return void res.json({ error: '图片最多 9 张' })
      for (const h of image_hashes) {
        if (typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)) {
          return void res.json({ error: 'image_hashes 必须为 64 字符十六进制' })
        }
      }
      imagesJsonForInsert = JSON.stringify(image_hashes)
    }
    // product_type 校验
    if (typeof product_type !== 'string' || !VALID_PRODUCT_TYPES.has(product_type)) {
      return void res.json({ error: `product_type 必须是 ${[...VALID_PRODUCT_TYPES].join(' / ')} 之一` })
    }
    const sourceMeta = parsePlatformUrl(source_url)
    // 精准匹配原则：external_title 必须显式提供，不 fallback 到店铺 title
    const externalTitleVal: string | null =
      typeof external_title === 'string' && external_title.trim() ? external_title.trim() : null
    if (!title || !description || !price) return void res.json({ error: '请填写商品名、描述、价格' })

    // 推土机 commission_rate（1%-50%）
    const commissionRateNum = Number(commission_rate ?? 0.10)
    if (!(commissionRateNum >= 0.01 && commissionRateNum <= 0.50)) {
      return void res.json({ error: 'commission_rate 必须在 1% - 50% 之间（小数 0.01-0.50）' })
    }

    // 上架前检查：同一卖家不能重复关联相同外部链接
    if (source_url && !opts.skipExternalLinkEffects) {
      const sameSellerDupe = (await dbOne<{ n: number }>(`
        SELECT COUNT(*) as n FROM product_external_links pel
        JOIN products p ON pel.product_id = p.id
        WHERE pel.url = ? AND p.seller_id = ?
      `, [source_url, user.id]))!
      if (sameSellerDupe.n > 0) {
        return void res.json({ error: '您已上架过来自此链接的商品，不能重复关联相同外部链接' })
      }
    }

    // M7.2.6 / 方案 3：上架免质押 — 零门槛入驻
    // stake_amount 字段记录"预期 stake"（首单成交时从订单 escrow 锁定）
    const priceNum = Number(price)
    const stakeDiscount = await getStakeDiscount(db, user.id as string)
    const stakeRate = Math.max(0.05, 0.15 - stakeDiscount)
    // S0 清关字段轻校验(可选;长度界 + 区码大写 + HS 编码字符集)
    const _cc = (x: unknown): string | null => (typeof x === 'string' && x.trim()) ? x.trim().toUpperCase().slice(0, 8) : null
    const _tx = (x: unknown, n: number): string | null => (typeof x === 'string' && x.trim()) ? x.trim().slice(0, n) : null
    const _hs = _tx(hs_code, 12)
    if (_hs && !/^[0-9.]{4,12}$/.test(_hs)) return void res.status(400).json({ error: 'hs_code 须为 4-12 位数字(可含 .)', error_code: 'INVALID_HS_CODE' })
    const stakeAmount = Math.round(priceNum * stakeRate * 100) / 100

    const now = new Date().toISOString()
    const id = generateId('prd')
    const specsJson = specs ? (typeof specs === 'string' ? specs : JSON.stringify(specs)) : null
    const estJson   = estimated_days ? (typeof estimated_days === 'string' ? estimated_days : JSON.stringify(estimated_days)) : null
    const pFields   = { ship_regions, handling_hours, estimated_days: estJson, return_days, return_condition, warranty_days }

    await dbRun(`INSERT INTO products (
      id, seller_id, title, description, price, stock, category, stake_amount,
      specs, brand, model, source_url, source_price, source_price_at,
      weight_kg, ship_regions, handling_hours, estimated_days, fragile,
      return_days, return_condition, warranty_days,
      low_stock_threshold, auto_delist_on_zero,
      commitment_hash, description_hash, price_hash, hashed_at,
      commission_rate, product_type, images, currency,
      package_size, origin_country, country_of_origin, customs_description, hs_code, status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'WAZ',?,?,?,?,?,?)`, [
      id, user.id, title, description, priceNum, Number(stock), category, stakeAmount,
      specsJson, brand ?? null, model ?? null,
      opts.skipExternalLinkEffects ? null : (source_url ?? null), opts.skipExternalLinkEffects ? null : (source_price ? Number(source_price) : null), opts.skipExternalLinkEffects ? null : (source_price ? now : null),
      weight_kg ? Number(weight_kg) : null, ship_regions, Number(handling_hours), estJson, fragile ? 1 : 0,
      Number(return_days), return_condition, Number(warranty_days),
      Math.max(0, Math.floor(Number(low_stock_threshold) || 0)), auto_delist_on_zero ? 1 : 0,
      makeCommitmentHash(pFields), makeDescriptionHash({ title, description, specs: specsJson }),
      makePriceHash(priceNum, now), now,
      commissionRateNum, product_type, imagesJsonForInsert,
      _tx(package_size, 40), _cc(origin_country), _cc(country_of_origin), _tx(customs_description, 120), _hs, (opts.forceStatus === 'warehouse' || create_status === 'warehouse') ? 'warehouse' : 'active'
    ])
    // M7.2.6：免质押上架 — 不再扣 stake；首单成交时 settleOrder 自动从订单 escrow 锁定

    // M7.2-6: 上架时同步入 aliases（卖家已勾选的 candidates）
    if (Array.isArray(aliases) && aliases.length > 0) {
      const ALLOWED_TYPES = new Set(['external_id', 'external_title', 'short_url', 'kouling_token', 'title_substring'])
      const ALIAS_LIMIT = 20
      let n = 0
      for (const a of aliases as Array<{ type?: string; value?: string }>) {
        if (n >= ALIAS_LIMIT) break
        const type = String(a?.type || '').trim()
        const value = String(a?.value || '').trim()
        if (!ALLOWED_TYPES.has(type) || value.length < 6 || value.length > 200) continue
        // M-2 fix: title_substring 必须是 product.title 真子串
        if (type === 'title_substring' && !String(title).includes(value)) continue
        try {
          await dbRun(`INSERT INTO product_aliases (id, product_id, alias_type, alias_value, min_match_chars) VALUES (?,?,?,?,6)`,
            [generateId('pal'), id, type, value])
          n++
        } catch {}
      }
    }

    // 来源链接：冲突检测
    let linkConflict: { task_id?: string; code?: string; expires_at?: string; message: string } | null = null
    if (source_url && !opts.skipExternalLinkEffects) {
      // 另一家卖家已认领此链接（verified=1）
      const otherClaim = await dbOne<{ product_id: string }>(`
        SELECT pel.product_id FROM product_external_links pel
        JOIN products p ON pel.product_id = p.id
        WHERE pel.url = ? AND pel.verified = 1 AND p.seller_id != ?
      `, [source_url, user.id])

      if (otherClaim) {
        // 创建认领验证任务（扣锁定费）
        const VERIFIERS_NEEDED = 1
        const REWARD_EACH      = 0.1
        const feeLocked        = VERIFIERS_NEEDED * REWARD_EACH
        const chars   = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
        const code    = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
        const linkId2 = generateId('lnk')
        const taskId  = generateId('vtk')
        const expiresAt = new Date(Date.now() + 72 * 3600_000).toISOString()
        const baseMsg = `此商品来源链接已被其他商家认领。请将验证码 [${code}] 放入该平台商品标题或描述，等待人工审核确认后归属自动转移。`

        // 冲突解析原子段:INSERT 冲突链接 + 商品转 warehouse + (余额够则)守恒扣验证费 + INSERT 验证任务。
        // 扣费用 WHERE balance >= fee 守恒;不够则不建任务(feeOk=false → 手动验证文案),链接/仓库仍落。
        let feeOk = false
        try {
          feeOk = db.transaction(() => {
            db.prepare(`INSERT OR IGNORE INTO product_external_links
              (id, product_id, url, source, verified, verify_note, platform, external_id, external_title)
              VALUES (?, ?, ?, 'import', 0, '链接冲突：等待众包验证确认归属', ?, ?, ?)`)
              .run(linkId2, id, source_url, sourceMeta?.platform ?? null, sourceMeta?.external_id ?? null, externalTitleVal)
            db.prepare(`UPDATE products SET status='warehouse', updated_at=datetime('now') WHERE id=?`).run(id)
            const debit = db.prepare(`UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND balance >= ?`).run(feeLocked, user.id, feeLocked)
            if (debit.changes === 0) return false
            db.prepare(`INSERT INTO verify_tasks (id, type, product_id, url, code, verifiers_needed, reward_per_verifier, fee_locked, status, expires_at)
              VALUES (?,?,?,?,?,?,?,?,'code_issued',?)`).run(taskId, 'code_check', id, source_url, code, VERIFIERS_NEEDED, REWARD_EACH, feeLocked, expiresAt)
            return true
          })()
        } catch (e) {
          console.error('[products-create conflict tx]', (e as Error).message)
          return void res.status(500).json({ error: '创建失败,请重试' })
        }
        linkConflict = feeOk
          ? { task_id: taskId, code: `[${code}]`, expires_at: expiresAt, message: baseMsg }
          : { message: `${baseMsg}（当前余额不足以锁定验证费 ${feeLocked} WAZ，请充值后前往商品编辑页手动发起验证）` }
      } else {
        // 无冲突 — 直接 verified=1
        await dbRun(`INSERT OR IGNORE INTO product_external_links
          (id, product_id, url, source, verified, verified_at, platform, external_id, external_title)
          VALUES (?, ?, ?, 'import', 1, datetime('now'), ?, ?, ?)`,
            [generateId('lnk'), id, source_url,
            sourceMeta?.platform ?? null, sourceMeta?.external_id ?? null, externalTitleVal])
      }
    }

    // 额外链接：同步冲突检查（最多 5 个）
    const additionalLinks = req.body.additional_links
    const blockedLinks: { url: string; message: string }[] = []
    if (!opts.skipExternalLinkEffects && Array.isArray(additionalLinks) && additionalLinks.length > 0) {
      for (const extraUrl of additionalLinks.slice(0, 5)) {
        if (typeof extraUrl !== 'string' || !extraUrl.startsWith('http')) continue
        const alreadyLinked = await dbOne('SELECT id FROM product_external_links WHERE product_id = ? AND url = ?', [id, extraUrl])
        if (alreadyLinked) continue
        // 同卖家已在其他商品关联过此链接
        const selfConflict = await dbOne<{ title: string }>(`
          SELECT p.title FROM product_external_links pel
          JOIN products p ON pel.product_id = p.id
          WHERE pel.url = ? AND p.seller_id = ? AND p.id != ?
        `, [extraUrl, user.id, id])
        if (selfConflict) {
          blockedLinks.push({ url: extraUrl, message: `您已在商品「${selfConflict.title}」中关联了此链接` })
          continue
        }
        // 他人已认领（verified=1）
        const otherConflict = await dbOne<{ title: string }>(`
          SELECT p.title FROM product_external_links pel
          JOIN products p ON pel.product_id = p.id
          WHERE pel.url = ? AND pel.verified = 1 AND p.seller_id != ?
        `, [extraUrl, user.id])
        if (otherConflict) {
          blockedLinks.push({ url: extraUrl, message: `此链接已被其他商家认领，上架后可在商品编辑页发起验证任务` })
          continue
        }
        // 无冲突 — 直接 verified=1
        try {
          const extraMeta = parsePlatformUrl(extraUrl)
          await dbRun(`INSERT OR IGNORE INTO product_external_links
            (id, product_id, url, source, verified, verified_at, platform, external_id)
            VALUES (?, ?, ?, 'import_extra', 1, datetime('now'), ?, ?)`,
              [generateId('lnk'), id, extraUrl, extraMeta?.platform ?? null, extraMeta?.external_id ?? null])
        } catch {}
      }
    }

    if (opts.onCreated) { try { await opts.onCreated(id) } catch (e) { console.error('[products-create onCreated]', (e as Error).message) } }

    res.json({
      success: true,
      product_id: id,
      status: (opts.forceStatus === 'warehouse' || create_status === 'warehouse') ? 'warehouse' : 'active',
      stake_locked: 0,                                  // 免质押上架（M7.2.6 方案 3）
      stake_deferred: stakeAmount,                      // 首单成交时自动锁定（trusted+ 跳过）
      ...(linkConflict ? { link_conflict: linkConflict } : {}),
      ...(blockedLinks.length > 0 ? { blocked_links: blockedLinks } : {}),
    })
  }
}

export function registerProductsCreateRoutes(app: Application, deps: ProductsCreateDeps): void {
  const createProductHandler = makeCreateProductHandler(deps)
  app.post('/api/products', async (req, res) => {
    const user = deps.auth(req, res); if (!user) return
    if (user.role !== 'seller') return void res.json({ error: '仅卖家可上架商品' })
    await createProductHandler(req, res, user)
  })
}
