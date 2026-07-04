/**
 * 运费模板路由(PR-2)—— 卖家设置(店铺默认 + 单品覆盖)+ 公开查询(买家下单前看配送范围/运费/时效)。
 *
 *   POST /api/seller/shipping-template      卖家写:{ store_template } 和/或 { product_id, template }
 *                                            (值=条目数组;null/[] = 清除 —— 单品回落店铺默认,店铺回落无模板)
 *   GET  /api/products/:id/shipping-options 公开读:生效模板(单品??店铺默认)+ 是否需要选地区
 *
 * 域逻辑(校验/解析/匹配)全在 src/shipping-templates.ts;建单守门在 orders-create(gateShippingForCreate)。
 * 只影响【之后】的新订单(下单时快照运费三列);模板是公开信息(买家下单前本就该看到),无脱敏面。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { parseShippingTemplate, loadTemplateJson } from '../../shipping-templates.js'
import { dbOne, dbRun } from '../../layer0-foundation/L0-1-database/db.js'

export interface ShippingTemplateRoutesDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  errorRes: (res: Response, status: number, code: string, msg: string) => void
}

export function registerShippingTemplateRoutes(app: Application, deps: ShippingTemplateRoutesDeps): void {
  const { auth, errorRes } = deps

  app.post('/api/seller/shipping-template', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller') return void errorRes(res, 403, 'SELLER_ONLY', '仅卖家可设置运费模板')
    const b = req.body || {}
    const touched: Record<string, unknown> = {}
    if ('store_template' in b) {
      const p = parseShippingTemplate(b.store_template)
      if (!p.ok) return void errorRes(res, 400, 'BAD_SHIPPING_TEMPLATE', p.error)
      await dbRun('UPDATE users SET store_shipping_template = ? WHERE id = ?', [p.entries ? JSON.stringify(p.entries) : null, user.id])
      touched.store_template = p.entries
    }
    if ('store_quote_ok' in b) {   // PR-3:模板外地区询价 opt-in(店铺默认;直付轨生效)
      if (b.store_quote_ok !== null && typeof b.store_quote_ok !== 'boolean') return void errorRes(res, 400, 'BAD_QUOTE_OK', 'store_quote_ok 只允许 true|false|null')
      await dbRun('UPDATE users SET store_shipping_quote_ok = ? WHERE id = ?', [b.store_quote_ok === null ? null : (b.store_quote_ok ? 1 : 0), user.id])
      touched.store_quote_ok = b.store_quote_ok
    }
    if ('product_id' in b && 'quote_ok' in b) {
      if (b.quote_ok !== null && typeof b.quote_ok !== 'boolean') return void errorRes(res, 400, 'BAD_QUOTE_OK', 'quote_ok 只允许 true|false|null')
      const prodQ = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [b.product_id])
      if (!prodQ) return void errorRes(res, 404, 'PRODUCT_NOT_FOUND', '商品不存在')
      if (prodQ.seller_id !== user.id) return void errorRes(res, 403, 'NOT_PRODUCT_OWNER', '只能设置自己商品')
      await dbRun('UPDATE products SET shipping_quote_ok = ? WHERE id = ?', [b.quote_ok === null ? null : (b.quote_ok ? 1 : 0), b.product_id])
      touched.product_quote_ok = b.quote_ok
    }
    if ('product_id' in b || 'template' in b) {
      if (!b.product_id) return void errorRes(res, 400, 'MISSING_PRODUCT_ID', '设置单品运费模板须带 product_id')
      const p = parseShippingTemplate(b.template)
      if (!p.ok) return void errorRes(res, 400, 'BAD_SHIPPING_TEMPLATE', p.error)
      const prod = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [b.product_id])
      if (!prod) return void errorRes(res, 404, 'PRODUCT_NOT_FOUND', '商品不存在')
      if (prod.seller_id !== user.id) return void errorRes(res, 403, 'NOT_PRODUCT_OWNER', '只能设置自己商品的运费模板')
      await dbRun('UPDATE products SET shipping_template = ? WHERE id = ?', [p.entries ? JSON.stringify(p.entries) : null, b.product_id])
      touched.product_template = p.entries
    }
    if (Object.keys(touched).length === 0) return void errorRes(res, 400, 'NOTHING_TO_SET', '未提供任何设置项')
    return void res.json({ success: true, ...touched })
  })

  // 卖家读自己的店铺级设置(设置 UI 回显):接单模式 + 运费模板 + 询价开关。
  app.get('/api/seller/shipping-settings', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (user.role !== 'seller') return void errorRes(res, 403, 'SELLER_ONLY', '仅卖家')
    const row = await dbOne<{ store_accept_mode: string | null; store_shipping_template: string | null; store_shipping_quote_ok: number | null }>(
      'SELECT store_accept_mode, store_shipping_template, store_shipping_quote_ok FROM users WHERE id = ?', [user.id])
    return void res.json({
      store_accept_mode: row?.store_accept_mode ?? null,
      store_template: loadTemplateJson(row?.store_shipping_template),
      store_quote_ok: row?.store_shipping_quote_ok == null ? null : Number(row.store_shipping_quote_ok) === 1,
    })
  })

  // 公开读:买家下单前查配送范围。生效 = 单品覆盖 ?? 店铺默认;template=null → 不按地区计费(下单不要求选地区)。
  app.get('/api/products/:id/shipping-options', async (req, res) => {
    const prod = await dbOne<{ id: string; seller_id: string; shipping_template: string | null; shipping_quote_ok: number | null }>(
      'SELECT id, seller_id, shipping_template, shipping_quote_ok FROM products WHERE id = ?', [req.params.id])
    if (!prod) return void errorRes(res, 404, 'PRODUCT_NOT_FOUND', '商品不存在')
    let entries = loadTemplateJson(prod.shipping_template)
    let source: 'product' | 'store' | null = entries ? 'product' : null
    const seller = await dbOne<{ store_shipping_template: string | null; store_shipping_quote_ok: number | null }>('SELECT store_shipping_template, store_shipping_quote_ok FROM users WHERE id = ?', [prod.seller_id])
    if (!entries) {
      entries = loadTemplateJson(seller?.store_shipping_template)
      if (entries) source = 'store'
    }
    const quoteOk = prod.shipping_quote_ok != null ? Number(prod.shipping_quote_ok) === 1 : Number(seller?.store_shipping_quote_ok) === 1
    return void res.json({
      product_id: prod.id,
      region_required: !!entries,
      template: entries,
      source,
      quote_outside_template: !!entries && quoteOk,   // 直付轨:模板外地区可询价(卖家报运费/时效,确认后付款)
      note: entries
        ? (quoteOk ? '下单须选择收货地区;模板内地区运费自动计入,模板外地区(直付)可先询价再付款。' : '下单须选择收货地区;运费按模板计入总额(快照)。未覆盖地区暂不可下单。')
        : '该商品不按地区计运费。',
    })
  })
}
