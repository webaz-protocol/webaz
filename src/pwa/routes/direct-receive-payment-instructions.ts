/**
 * Direct Pay (Rail 1) — 卖家收款说明(payment instruction)CRUD 端点 (PR-4f-a)。薄 route adapter:
 *   全部 DB 读写委托给 ../../direct-receive-payment-instruction.ts 的 helper(本文件零 db.prepare,
 *   故不进 routes seam allowlist);server.ts 只 import + register,业务逻辑全在 helper / 本模块。
 *
 * ⚠️ 诚实边界:instruction 只是【卖家自填、展示给买家的纯文本】(场外结算用)。WebAZ【绝不】验证 / 路由 /
 *   托管 / 判断币种 / 做 crypto-fiat allowlist,也【不是】PSP / payment processor。本端点【不碰】buyer wallet /
 *   escrow / settlement / refund / order status —— 纯展示文本 CRUD。Direct Pay 仍 non-launchable:launch
 *   blockers 仍是 production base-bond rail + KYC/sanctions + caps/breakers + UI,本 PR 不触及其一。
 *
 * 仅 seller 本人:未登录 401;非 seller 403。每个 seller 至多一条 active(set helper 在事务内先停用旧 active)。
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import {
  getActivePaymentInstruction, setActivePaymentInstruction, deactivatePaymentInstruction,
  MAX_INSTRUCTION_LEN, MAX_LABEL_LEN,
} from '../../direct-receive-payment-instruction.js'

export interface DirectReceivePaymentInstructionDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  generateId: (prefix: string) => string
}

export function registerDirectReceivePaymentInstructionRoutes(app: Application, deps: DirectReceivePaymentInstructionDeps): void {
  const { db, auth, generateId } = deps

  /** 登录 + seller 角色门。返回 user 或 null(已写错误响应)。 */
  function requireSeller(req: Request, res: Response): Record<string, unknown> | null {
    const user = auth(req, res); if (!user) return null
    if (user.role !== 'seller') { res.status(403).json({ error: '仅卖家可设置收款说明', error_code: 'SELLER_ONLY' }); return null }
    return user
  }

  // GET — 卖家本人当前 active 收款说明;无则 instruction:null(200,显式空状态,便于 UI 渲染“尚未设置”)。
  app.get('/api/direct-receive/payment-instruction', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    return void res.json({ instruction: getActivePaymentInstruction(db, user.id as string) })
  })

  // PUT — 设置/替换卖家当前 active 收款说明。instruction 必填、trim、长度上限;label 可选、trim、长度上限。
  app.put('/api/direct-receive/payment-instruction', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim() : ''
    if (!instruction) return void res.status(400).json({ error: '收款说明不能为空', error_code: 'INSTRUCTION_REQUIRED' })
    if (instruction.length > MAX_INSTRUCTION_LEN) return void res.status(400).json({ error: `收款说明过长(上限 ${MAX_INSTRUCTION_LEN} 字符)`, error_code: 'INSTRUCTION_TOO_LONG' })
    const rawLabel = typeof req.body?.label === 'string' ? req.body.label.trim() : ''
    if (rawLabel.length > MAX_LABEL_LEN) return void res.status(400).json({ error: `标签过长(上限 ${MAX_LABEL_LEN} 字符)`, error_code: 'LABEL_TOO_LONG' })
    const saved = setActivePaymentInstruction(db, user.id as string, { instruction, label: rawLabel || null }, generateId)
    return void res.json({ ok: true, instruction: saved })
  })

  // DELETE — 停用卖家当前 active 收款说明(软停用,留历史为 inactive)。停用后 create route fail-closed。
  app.delete('/api/direct-receive/payment-instruction', (req, res) => {
    const user = requireSeller(req, res); if (!user) return
    return void res.json({ ok: true, deactivated: deactivatePaymentInstruction(db, user.id as string) })
  })
}
