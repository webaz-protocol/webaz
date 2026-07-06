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
import { parseShippingTemplate, loadTemplateJson, resolveShipping } from '../../shipping-templates.js'
import { validateSaleRegionsInput, parseSaleRegionsRule, regionAllowedByRule, parsePlatformBlocklist } from '../../sale-regions.js'  // S1 可售区域(店铺+单品写入;gate 在 orders-create;S5 只读披露复用判定 + 与建单门同一 blocklist parser)
import { validateFreeShippingThreshold } from '../../free-shipping.js'  // 营销域满额免邮(S2 返工:写入口暂列本设置面,规则/判定在 free-shipping.ts)
import { validateImportDutyTerms, validateTaxLines, effectiveImportDutyTerms, effectiveTaxLines, parseTaxLines, taxLinesForRegion } from '../../trade-tax.js'  // S3 跨境税费/进口责任声明层(seller-declared,平台不算不收)
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
    if ('store_sale_regions' in b) {   // S1 可售区域(店铺默认):{mode:'all'|'list', include?, exclude?};null=清除(不限)
      const v = validateSaleRegionsInput(b.store_sale_regions)
      if ('error' in v) return void errorRes(res, 400, 'BAD_SALE_REGIONS', v.error)
      await dbRun('UPDATE users SET store_sale_regions = ? WHERE id = ?', [v.json, user.id])
      touched.store_sale_regions = v.json ? JSON.parse(v.json) : null
    }
    if ('product_id' in b && 'sale_regions' in b) {   // S1 单品覆盖(优先于店铺;null=回落店铺)
      const v = validateSaleRegionsInput(b.sale_regions)
      if ('error' in v) return void errorRes(res, 400, 'BAD_SALE_REGIONS', v.error)
      const prodS = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [b.product_id])
      if (!prodS) return void errorRes(res, 404, 'PRODUCT_NOT_FOUND', '商品不存在')
      if (prodS.seller_id !== user.id) return void errorRes(res, 403, 'NOT_PRODUCT_OWNER', '只能设置自己商品')
      await dbRun('UPDATE products SET sale_regions = ? WHERE id = ?', [v.json, b.product_id])
      touched.product_sale_regions = v.json ? JSON.parse(v.json) : null
    }
    if ('store_free_shipping_threshold' in b) {   // 营销:满额免邮(店铺默认;null=清除)。券后货款≥阈值→运费商家承担
      const v = validateFreeShippingThreshold(b.store_free_shipping_threshold)
      if ('error' in v) return void errorRes(res, 400, 'BAD_FREE_SHIPPING_THRESHOLD', v.error)
      await dbRun('UPDATE users SET store_free_shipping_threshold = ? WHERE id = ?', [v.value, user.id])
      touched.store_free_shipping_threshold = v.value
    }
    if ('product_id' in b && 'free_shipping_threshold' in b) {   // 营销:单品覆盖(null=回落店铺)
      const v = validateFreeShippingThreshold(b.free_shipping_threshold)
      if ('error' in v) return void errorRes(res, 400, 'BAD_FREE_SHIPPING_THRESHOLD', v.error)
      const prodF = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [b.product_id])
      if (!prodF) return void errorRes(res, 404, 'PRODUCT_NOT_FOUND', '商品不存在')
      if (prodF.seller_id !== user.id) return void errorRes(res, 403, 'NOT_PRODUCT_OWNER', '只能设置自己商品')
      await dbRun('UPDATE products SET free_shipping_threshold = ? WHERE id = ?', [v.value, b.product_id])
      touched.product_free_shipping_threshold = v.value
    }
    if ('store_import_duty_terms' in b) {   // S3:DDP/DDU 进口责任声明(店铺默认;null=清除)
      const v = validateImportDutyTerms(b.store_import_duty_terms)
      if ('error' in v) return void errorRes(res, 400, 'BAD_IMPORT_DUTY_TERMS', v.error)
      await dbRun('UPDATE users SET store_import_duty_terms = ? WHERE id = ?', [v.value, user.id])
      touched.store_import_duty_terms = v.value
    }
    if ('product_id' in b && 'import_duty_terms' in b) {   // S3:单品覆盖(null=回落店铺)
      const v = validateImportDutyTerms(b.import_duty_terms)
      if ('error' in v) return void errorRes(res, 400, 'BAD_IMPORT_DUTY_TERMS', v.error)
      const prodD = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [b.product_id])
      if (!prodD) return void errorRes(res, 404, 'PRODUCT_NOT_FOUND', '商品不存在')
      if (prodD.seller_id !== user.id) return void errorRes(res, 403, 'NOT_PRODUCT_OWNER', '只能设置自己商品')
      await dbRun('UPDATE products SET import_duty_terms = ? WHERE id = ?', [v.value, b.product_id])
      touched.product_import_duty_terms = v.value
    }
    if ('store_tax_lines' in b) {   // S3:价内已含税声明(店铺默认;仅 'included';null=清除)
      const v = validateTaxLines(b.store_tax_lines)
      if ('error' in v) return void errorRes(res, 400, 'BAD_TAX_LINES', v.error)
      await dbRun('UPDATE users SET store_tax_lines = ? WHERE id = ?', [v.value, user.id])
      touched.store_tax_lines = v.value ? JSON.parse(v.value) : null
    }
    if ('product_id' in b && 'tax_lines' in b) {   // S3:单品覆盖(null=回落店铺)
      const v = validateTaxLines(b.tax_lines)
      if ('error' in v) return void errorRes(res, 400, 'BAD_TAX_LINES', v.error)
      const prodT = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [b.product_id])
      if (!prodT) return void errorRes(res, 404, 'PRODUCT_NOT_FOUND', '商品不存在')
      if (prodT.seller_id !== user.id) return void errorRes(res, 403, 'NOT_PRODUCT_OWNER', '只能设置自己商品')
      await dbRun('UPDATE products SET tax_lines = ? WHERE id = ?', [v.value, b.product_id])
      touched.product_tax_lines = v.value ? JSON.parse(v.value) : null
    }
    if ('product_id' in b && 'quote_ok' in b) {
      if (b.quote_ok !== null && typeof b.quote_ok !== 'boolean') return void errorRes(res, 400, 'BAD_QUOTE_OK', 'quote_ok 只允许 true|false|null')
      const prodQ = await dbOne<{ seller_id: string }>('SELECT seller_id FROM products WHERE id = ?', [b.product_id])
      if (!prodQ) return void errorRes(res, 404, 'PRODUCT_NOT_FOUND', '商品不存在')
      if (prodQ.seller_id !== user.id) return void errorRes(res, 403, 'NOT_PRODUCT_OWNER', '只能设置自己商品')
      await dbRun('UPDATE products SET shipping_quote_ok = ? WHERE id = ?', [b.quote_ok === null ? null : (b.quote_ok ? 1 : 0), b.product_id])
      touched.product_quote_ok = b.quote_ok
    }
    if ('template' in b) {   // 单品运费模板:仅在显式带 template 时进入 —— 关闭整类隐患(此前 'product_id' in b 会让 {product_id, store_*} 等组合尾随进来把模板静默清成 NULL;审计 P2)。清除走 {product_id, template:null}('template' in b 成立)
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
    const row = await dbOne<{ store_accept_mode: string | null; store_shipping_template: string | null; store_shipping_quote_ok: number | null; store_sale_regions: string | null; store_free_shipping_threshold: number | null; store_import_duty_terms: string | null; store_tax_lines: string | null }>(
      'SELECT store_accept_mode, store_shipping_template, store_shipping_quote_ok, store_sale_regions, store_free_shipping_threshold, store_import_duty_terms, store_tax_lines FROM users WHERE id = ?', [user.id])
    return void res.json({
      store_accept_mode: row?.store_accept_mode ?? null,
      store_sale_regions: parseSaleRegionsRule(row?.store_sale_regions ?? null),
      store_free_shipping_threshold: row?.store_free_shipping_threshold ?? null,
      store_import_duty_terms: (row?.store_import_duty_terms === 'ddu' || row?.store_import_duty_terms === 'ddp') ? row.store_import_duty_terms : null,
      store_tax_lines: parseTaxLines(row?.store_tax_lines ?? null),
      store_template: loadTemplateJson(row?.store_shipping_template),
      store_quote_ok: row?.store_shipping_quote_ok == null ? null : Number(row.store_shipping_quote_ok) === 1,
    })
  })

  // 公开读:买家下单前查配送范围。生效 = 单品覆盖 ?? 店铺默认;template=null → 不按地区计费(下单不要求选地区)。
  app.get('/api/products/:id/shipping-options', async (req, res) => {
    const prod = await dbOne<{ id: string; seller_id: string; shipping_template: string | null; shipping_quote_ok: number | null; import_duty_terms: string | null; tax_lines: string | null; sale_regions: string | null; free_shipping_threshold: number | null }>(
      'SELECT id, seller_id, shipping_template, shipping_quote_ok, import_duty_terms, tax_lines, sale_regions, free_shipping_threshold FROM products WHERE id = ?', [req.params.id])
    if (!prod) return void errorRes(res, 404, 'PRODUCT_NOT_FOUND', '商品不存在')
    let entries = loadTemplateJson(prod.shipping_template)
    let source: 'product' | 'store' | null = entries ? 'product' : null
    const seller = await dbOne<{ store_shipping_template: string | null; store_shipping_quote_ok: number | null; store_import_duty_terms: string | null; store_tax_lines: string | null; store_sale_regions: string | null; store_free_shipping_threshold: number | null }>('SELECT store_shipping_template, store_shipping_quote_ok, store_import_duty_terms, store_tax_lines, store_sale_regions, store_free_shipping_threshold FROM users WHERE id = ?', [prod.seller_id])
    if (!entries) {
      entries = loadTemplateJson(seller?.store_shipping_template)
      if (entries) source = 'store'
    }
    const quoteOk = prod.shipping_quote_ok != null ? Number(prod.shipping_quote_ok) === 1 : Number(seller?.store_shipping_quote_ok) === 1
    // S3 税费/进口责任披露(买家下单前可见;卖家 seller-declared,平台不算不收)。
    //   价内含税【按收货地区过滤】(?ship_to_region):目的区匹配项 + '*' 通用项;无地区参数=仅 '*'(只披露必然适用的,
    //   不把不属于该目的地的税误示给买家)。DDP/DDU 是整单单一声明,不按区分。
    const importDuty = effectiveImportDutyTerms(prod.import_duty_terms, seller?.store_import_duty_terms)
    const shipToRegion = typeof req.query.ship_to_region === 'string' && req.query.ship_to_region.trim() ? req.query.ship_to_region.trim().toUpperCase() : null
    const taxLines = taxLinesForRegion(effectiveTaxLines(prod.tax_lines, seller?.store_tax_lines), shipToRegion)
    // S5 买家下单前聚合(只读,复用 S1-S4 判定;不动订单金额/不收税)。
    const saleRule = parseSaleRegionsRule(prod.sale_regions) ?? parseSaleRegionsRule(seller?.store_sale_regions ?? null)   // 可售规则(商品??店铺)
    // 平台合规名单:与建单门 gateSaleRegionForCreate 共用 parsePlatformBlocklist,坏配置 fail-closed 一致(建单 503 ⇄ 预检 platform_policy_invalid),
    //   不再把坏配置当空名单静默放行(否则预检显示"可买"、提交才 503,与 create gate 不一致)。缺省 '[]'/无行=空名单=可售。
    const pr = await dbOne<{ value: string }>("SELECT value FROM protocol_params WHERE key = 'trade.platform_region_blocklist'").catch(() => null)
    const parsedBlock = parsePlatformBlocklist(pr ? pr.value : '[]')
    const policyInvalid = !parsedBlock.ok
    const platformBlock = parsedBlock.ok ? parsedBlock.list : []
    const freeThreshold = (prod.free_shipping_threshold != null && Number(prod.free_shipping_threshold) > 0) ? Number(prod.free_shipping_threshold)
      : (seller?.store_free_shipping_threshold != null && Number(seller.store_free_shipping_threshold) > 0 ? Number(seller.store_free_shipping_threshold) : null)
    // 可售裁定(镜像建单 gateSaleRegionForCreate 的判定,只读不抛):平台配置异常 > 平台合规 > 商家意愿。
    const restricted = policyInvalid || !!saleRule || platformBlock.length > 0
    let sellable: { ok: boolean; reason: string } = { ok: true, reason: 'ok' }
    if (policyInvalid) sellable = { ok: false, reason: 'platform_policy_invalid' }   // 坏配置 fail-closed:显示不可下单,不诱导买家提交后才 503
    else if (restricted) {
      if (!shipToRegion) sellable = { ok: false, reason: 'region_required' }
      else if (platformBlock.includes(shipToRegion)) sellable = { ok: false, reason: 'product_restricted' }   // 平台合规,商家不可放宽
      else if (saleRule && !regionAllowedByRule(saleRule, shipToRegion)) sellable = { ok: false, reason: 'region_not_for_sale' }   // 商家不销往
    }
    // 目的区运费裁定(有模板时;免邮阈值仅回传数值供 UI 提示"满 X 免邮",实际是否免取决于买家券后货款,建单时定)
    let resolvedShipping: { covered: boolean; fee: number | null; est_days: string | null; quote_required: boolean } | null = null
    if (entries && shipToRegion) { const r = resolveShipping(entries, shipToRegion); resolvedShipping = { covered: r.covered, fee: r.covered ? r.fee : null, est_days: r.est_days, quote_required: !r.covered && quoteOk } }
    return void res.json({
      product_id: prod.id,
      region_required: !!entries || restricted,   // S5:可售/合规限制也需买家指定目的地(与建单 SHIP_REGION_REQUIRED 一致)
      template: entries,
      source,
      sellable,                        // S5:{ ok, reason: ok|region_required|product_restricted|region_not_for_sale|platform_policy_invalid }
      sale_regions: saleRule,          // S5:生效可售规则(商品??店铺){mode:'list',include:[...]} | {mode:'all',exclude:[...]} | null —— UI 据此在无运费模板时也能生成地区入口
      resolved_shipping: resolvedShipping,   // S5:目的区运费裁定(covered/fee/est_days/quote_required)| null(无模板或未选区)
      free_shipping_threshold: freeThreshold,   // S5:生效满额免邮阈值(UI 提示"满 X 免邮";实际免取决于建单时券后货款)
      import_duty_terms: importDuty,   // 'ddu'(买家到境自付关税/税)| 'ddp'(卖家已含)| null(未声明)
      tax_included_lines: taxLines,    // 价内已含税声明(如 [{region:'SG',label:'GST',rate_pct:9,kind:'included'}])
      tax_disclosure: 'seller_declared_platform_no_collect',   // S5:税费/进口责任均为卖家声明,平台不代收代缴(直付非托管)
      quote_outside_template: !!entries && quoteOk,   // 直付轨:模板外地区可询价(卖家报运费/时效,确认后付款)
      note: entries
        ? (quoteOk ? '下单须选择收货地区;模板内地区运费自动计入,模板外地区(直付)可先询价再付款。' : '下单须选择收货地区;运费按模板计入总额(快照)。未覆盖地区暂不可下单。')
        : (restricted ? '该商品设有可售地区限制,请选择收货地区确认。' : '该商品不按地区计运费。'),
    })
  })
}
