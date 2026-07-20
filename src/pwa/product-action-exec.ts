/**
 * Ops Passkey-in-flow approval — product-action【执行器】domain(批准驱动的硬删)。删除切片。
 *
 * 这是【被授权版的 DELETE /api/products/:id】:与该路由完全相同的删除前置(归属 / 必须已在回收箱 status='deleted' /
 *   无进行中订单 / retire anchors + 删外链 + DELETE FROM products),但【只能由授权驱动执行】,永不接受裸 api_key。
 *
 * 授权两条路(镜像 RFC-021 request→approve→execute):
 *   ① 该请求已被人工 Passkey 批准(status='approved')——批准即针对这一条的授权;
 *   ② 该 owner 有活跃 T1 窗口(consumeWindow 成功核销一次)——一次 Passkey 开窗后同档位后续删除免逐条弹。
 *   两路都不满足 → NOT_AUTHORIZED(交由调用方回退到"需要人工 Passkey")。
 *
 * 原子性:授权核销 + 请求 CAS 认领(→executed,防双执行)+ 商品硬删 全在【一个同步 db.transaction】内。任何
 *   一步失败整体回滚(含窗口 uses 自增回退),绝不出现"烧了窗口/认领了请求但没删成"或"删了但没记 executed"。
 *   单一 sanitized 边界:真实 db 故障 → EXEC_FAILED,不泄露 SQL/表名。
 *
 * 本模块【可】import approval-window(它是窗口的消费方);但仍不碰钱路、不建订单。
 */
import type Database from 'better-sqlite3'
import { consumeWindow } from './approval-window.js'

const DELETE_TIER = 'T1'   // 商品处置(删除)= T1 档;T2=上架·改价,T3(订单/资金)永不开窗

export interface ProductActionExecResult {
  ok: boolean
  request_id?: string
  product_id?: string
  authorized_via?: 'approval' | 'window'
  error?: string
  error_code?: string
  http?: number
}

// tx 内已发生写(窗口核销/请求认领)却必须放弃时,抛此错以【回滚】整个 tx,并携带要返回的结果。
class ExecAbort extends Error {
  constructor(public payload: ProductActionExecResult) { super('exec-abort') }
}

interface ExecDeps { requestId: string; retireAnchorsByTarget?: (db: Database.Database, kind: string, id: string) => void }

/**
 * 执行一条 product-action 删除请求。授权(approved / 活跃 T1 窗)成立且删除前置满足才动手;全程单事务原子。
 */
export function executeProductActionRequest(db: Database.Database, opts: ExecDeps): ProductActionExecResult {
  const { requestId, retireAnchorsByTarget } = opts
  try {
    return db.transaction((): ProductActionExecResult => {
      const nowIso = new Date().toISOString()
      const reqRow = db.prepare(
        'SELECT id, owner_id, action, product_id, status, expires_at FROM product_action_requests WHERE id = ?'
      ).get(requestId) as { id: string; owner_id: string; action: string; product_id: string; status: string; expires_at: string } | undefined
      if (!reqRow) return { ok: false, error_code: 'REQUEST_NOT_FOUND', error: '请求不存在', http: 404 }
      if (reqRow.action !== 'delete') return { ok: false, error_code: 'BAD_ACTION', error: '仅支持 delete', http: 400 }

      // 终态 / 过期(只读检查;过期顺手 reap,不构成 tx 内的"必须回滚"写)
      if (reqRow.status === 'executed') return { ok: false, error_code: 'ALREADY_EXECUTED', error: '该请求已执行', http: 409 }
      if (reqRow.status === 'revoked') return { ok: false, error_code: 'REQUEST_REVOKED', error: '该请求已作废', http: 409 }
      if (reqRow.status === 'expired' || reqRow.expires_at <= nowIso) {
        db.prepare("UPDATE product_action_requests SET status='expired' WHERE id=? AND status IN ('pending','approved')").run(requestId)
        return { ok: false, error_code: 'REQUEST_EXPIRED', error: '该请求已过期,请重新发起', http: 410 }
      }

      // 删除前置(只读;与 DELETE /api/products/:id 完全一致):归属 / 已在回收箱 / 无进行中订单。
      //   放在授权核销【之前】,避免删不成还白烧一次窗口额度。
      const product = db.prepare('SELECT id, seller_id, status FROM products WHERE id = ?')
        .get(reqRow.product_id) as { id: string; seller_id: string; status: string } | undefined
      if (!product) return { ok: false, error_code: 'PRODUCT_NOT_FOUND', error: '商品不存在', http: 404 }
      if (product.seller_id !== reqRow.owner_id) return { ok: false, error_code: 'NOT_PRODUCT_OWNER', error: '该商品不属于请求发起人', http: 403 }
      if (product.status !== 'deleted') return { ok: false, error_code: 'NOT_IN_RECYCLE_BIN', error: '请先将商品移入回收箱', http: 409 }
      const active = db.prepare(
        "SELECT COUNT(*) AS n FROM orders WHERE product_id = ? AND status NOT IN ('completed','cancelled','refunded','expired')"
      ).get(reqRow.product_id) as { n: number }
      if (active.n > 0) return { ok: false, error_code: 'HAS_ACTIVE_ORDERS', error: '该商品有进行中的订单,暂无法删除', http: 409 }

      // 授权:approved(本条 Passkey)或 消费一次 T1 窗。pending 且无窗 → NOT_AUTHORIZED(此前无写,直接返回)。
      let authorizedVia: 'approval' | 'window'
      if (reqRow.status === 'approved') {
        authorizedVia = 'approval'
      } else {
        const consumed = consumeWindow(db, { ownerId: reqRow.owner_id, tier: DELETE_TIER })
        if (!consumed.ok) return { ok: false, error_code: 'NOT_AUTHORIZED', error: '需要人工 Passkey 批准', http: 403 }
        authorizedVia = 'window'
      }

      // —— 以下为写:请求 CAS 认领 → 硬删。任何异常/冲突抛 ExecAbort 回滚(含上面可能的窗口核销)。——
      const claim = db.prepare(
        "UPDATE product_action_requests SET status='executed', executed_at=?, execution_result=? WHERE id=? AND status=?"
      ).run(nowIso, JSON.stringify({ deleted_product_id: product.id, via: authorizedVia }), requestId, reqRow.status)
      if (claim.changes !== 1) throw new ExecAbort({ ok: false, error_code: 'CLAIM_CONFLICT', error: '请求状态已变化,请重试', http: 409 })

      // 硬删,复刻 DELETE 路由:先删外链,anchor GC 尽力而为(不因其失败回滚删除),再删商品本体。
      db.prepare('DELETE FROM product_external_links WHERE product_id = ?').run(product.id)
      if (retireAnchorsByTarget) {
        try { retireAnchorsByTarget(db, 'product', product.id) } catch (e) { console.warn('[product-action-exec] anchor gc:', (e as Error).message) }
      }
      db.prepare('DELETE FROM products WHERE id = ?').run(product.id)

      return { ok: true, request_id: requestId, product_id: product.id, authorized_via: authorizedVia }
    })()
  } catch (e) {
    if (e instanceof ExecAbort) return e.payload
    console.error('[product-action-exec] failed:', (e as Error).message)   // detail 留服务端
    return { ok: false, error_code: 'EXEC_FAILED', error: '执行失败,请重试', http: 500 }
  }
}
