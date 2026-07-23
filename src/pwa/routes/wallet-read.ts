/**
 * Wallet — 用户钱包读 + 白名单管理 + 测试充值
 *
 * 由 #1013 Phase 80 从 src/pwa/server.ts 抽出。
 *
 * 10 endpoints:
 *   GET    /api/wallet                       钱包状态（含首次访问 deriveDepositAddress）
 *   GET    /api/wallet/deposit-qr            充值地址 QR（SVG，私有缓存 24h）
 *   GET    /api/wallet/rate                  公开汇率（WAZ/USDC + 最小额 + 确认数）
 *   GET    /api/wallet/whitelist             我的出金白名单
 *   POST   /api/wallet/whitelist             加白（密码 + 24h 冷却 + 小写存储）
 *   DELETE /api/wallet/whitelist/:id         撤白
 *   GET    /api/wallet/withdrawals           我的提现记录
 *   GET    /api/wallet/deposits              我的充值记录（含确认进度）
 *   GET    /api/wallet/income                收入构成(销售 / 分享归因 / PV 记录,若适用)
 *   POST   /api/wallet/topup                 P0 测试充值（≤1000/次，上限 5000）
 *
 * 受信角色（admin/verifier）无钱包 — 多处守门
 *
 * 链上常量用 getter 注入（IS_MAINNET / ACTIVE_CHAIN / USDC_CONTRACT / NETWORK）
 * — 因为这些 const 定义在 server.ts 下游，而 register call 须在 SPA catch-all 前
 *
 * 跨域注入：auth + isTrustedRole + generateId + verifyPassword + deriveDepositAddress
 *           + getProtocolParam + publicClient（getter）+ 链上常量 getters
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne, dbAll, dbRun } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface WalletReadDeps {
  db: Database.Database
  auth: (req: Request, res: Response) => Record<string, unknown> | null
  isTrustedRole: (user: Record<string, unknown>) => boolean
  generateId: (prefix: string) => string
  verifyPassword: (plain: string, stored: string) => boolean
  deriveDepositAddress: (userId: string) => string
  getProtocolParam: <T>(key: string, fallback: T) => T
  getPublicClient: () => any
  getIsMainnet: () => boolean
  getActiveChainId: () => number
  getUsdcContract: () => string
  getNetwork: () => string
}

export function registerWalletReadRoutes(app: Application, deps: WalletReadDeps): void {
  // db 已全量走 RFC-016 异步 seam(dbOne/dbAll/dbRun),不再直接用 deps.db
  const { auth, isTrustedRole, generateId, verifyPassword, deriveDepositAddress, getProtocolParam,
          getPublicClient, getIsMainnet, getActiveChainId, getUsdcContract, getNetwork } = deps

  // 钱包状态
  app.get('/api/wallet', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (isTrustedRole(user as Record<string, unknown>)) return void res.status(403).json({ error: '受信角色无钱包', error_code: 'TRUSTED_ROLE_NO_WALLET' })
    // WAZ 退役(2026-07-23):渠道关(默认)→ 钱包信息面从源头断供:零余额 DTO + 双语 notice,不派生充值地址。
    //   MCP webaz_wallet(network 模式)转发本端点,agent 面自动同真值。fail-closed。
    if (Number(getProtocolParam('payment_rail_waz_escrow_enabled', 0)) !== 1) {
      return void res.json({ waz_sunset: true, notice: 'WAZ 模拟货币已退役,历史余额已按 append-only 冲正清零;真实交易请使用直付(Direct Pay)。 / WAZ (simulated) has been retired; balances were zeroed via append-only corrections. Use Direct Pay for real transactions.', balance: 0, staked: 0, escrowed: 0, earned: 0, fee_staked: 0 })
    }
    const wallet = await dbOne<Record<string, unknown>>('SELECT * FROM wallets WHERE user_id = ?', [user.id])
    if (!wallet) return void res.status(500).json({ error: '钱包记录缺失', error_code: 'WALLET_MISSING' })

    if (!wallet.deposit_address) {
      const addr = deriveDepositAddress(user.id as string)
      await dbRun('UPDATE wallets SET deposit_address = ? WHERE user_id = ?', [addr, user.id])
      wallet.deposit_address = addr
    }
    res.json(wallet)
  })

  // 充值地址 QR — SVG（轻量 + 矢量，移动端扫码体验最佳）
  app.get('/api/wallet/deposit-qr', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const wallet = await dbOne<{ deposit_address: string | null }>('SELECT deposit_address FROM wallets WHERE user_id = ?', [user.id])
    if (!wallet?.deposit_address) return void res.status(404).json({ error: '充值地址未生成' })
    try {
      const { toString } = await import('qrcode')
      // 裸地址 + 客户端按需加 hint；EIP-681 兼容性参差
      const payload = wallet.deposit_address
      const svg = await toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 240 })
      res.setHeader('Content-Type', 'image/svg+xml')
      res.setHeader('Cache-Control', 'private, max-age=86400')
      res.send(svg)
    } catch (e) {
      res.status(500).json({ error: 'QR 生成失败：' + (e as Error).message })
    }
  })

  // 公开汇率
  app.get('/api/wallet/rate', (_req, res) => {
    res.json({
      waz_usdc_rate: getProtocolParam<number>('waz_usdc_rate', 1.0),
      min_deposit_usdc: getProtocolParam<number>('usdc_min_deposit', 0.01),
      min_withdraw_waz: getProtocolParam<number>('usdc_min_withdraw_waz', 10),
      required_confirmations: getProtocolParam<number>('usdc_required_confirmations', 12),
      chain: getIsMainnet() ? 'base-mainnet' : 'base-sepolia',
      chain_id: getActiveChainId(),
      usdc_contract: getUsdcContract(),
      network: getNetwork(),
    })
  })

  // 白名单 GET / POST / DELETE
  app.get('/api/wallet/whitelist', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const rows = await dbAll<{ id: string; address: string; label: string | null; added_at: string; activates_at: string }>(`
      SELECT id, address, label, added_at, activates_at
      FROM withdrawal_whitelist
      WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY added_at DESC
    `, [user.id])
    const now = Date.now()
    res.json({
      whitelist: rows.map(r => ({
        ...r,
        activated: new Date(r.activates_at.replace(' ', 'T') + 'Z').getTime() <= now,
      })),
    })
  })

  app.post('/api/wallet/whitelist', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const pwd = String(req.body?.password || '')
    if (!user.password_hash) return void res.json({ error: '请先设置登录密码（敏感操作必需）' })
    if (!verifyPassword(pwd, user.password_hash as string)) return void res.json({ error: '密码错误' })

    const addressRaw = String(req.body?.address || '').trim()
    const label = String(req.body?.label || '').trim().slice(0, 50)
    if (!/^0x[0-9a-fA-F]{40}$/.test(addressRaw)) return void res.json({ error: '请输入有效的以太坊地址' })
    // P0-1: 统一小写存储
    const address = addressRaw.toLowerCase()

    const existing = await dbOne<{ id: string; revoked_at: string | null }>(`SELECT id, revoked_at FROM withdrawal_whitelist WHERE user_id = ? AND address = ?`, [user.id, address])
    if (existing && !existing.revoked_at) return void res.json({ error: '该地址已在白名单中' })

    const id = generateId('wl')
    const activatesAt = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
    if (existing) {
      await dbRun(`UPDATE withdrawal_whitelist
                  SET revoked_at = NULL, added_at = datetime('now'), activates_at = ?, label = ?, id = ?
                  WHERE user_id = ? AND address = ?`,
        [activatesAt, label || null, id, user.id, address])
    } else {
      await dbRun(`INSERT INTO withdrawal_whitelist (id, user_id, address, label, activates_at)
                  VALUES (?,?,?,?,?)`, [id, user.id, address, label || null, activatesAt])
    }
    res.json({ ok: true, id, activates_at: activatesAt, message: '地址已添加，24 小时冷却期后可用于提现' })
  })

  app.delete('/api/wallet/whitelist/:id', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const row = await dbOne<{ user_id: string }>(`SELECT user_id FROM withdrawal_whitelist WHERE id = ?`, [req.params.id])
    if (!row || row.user_id !== user.id) return void res.status(404).json({ error: '地址不存在' })
    await dbRun(`UPDATE withdrawal_whitelist SET revoked_at = datetime('now') WHERE id = ?`, [req.params.id])
    res.json({ ok: true })
  })

  // 我的提现记录
  app.get('/api/wallet/withdrawals', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const list = await dbAll(
      `SELECT id, to_address, amount, status, created_at, tx_hash FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
      [user.id]
    )
    res.json(list)
  })

  // 我的充值记录（含确认进度）
  // P1-2: latestBlock 30s 缓存，多用户访问不重复打 RPC
  let _latestBlockCache: { value: number; expiresAt: number } | null = null
  const getCachedLatestBlock = async (): Promise<number | null> => {
    const now = Date.now()
    if (_latestBlockCache && _latestBlockCache.expiresAt > now) return _latestBlockCache.value
    try {
      const v = Number(await getPublicClient().getBlockNumber())
      _latestBlockCache = { value: v, expiresAt: now + 30_000 }
      return v
    } catch { return _latestBlockCache?.value ?? null }
  }

  app.get('/api/wallet/deposits', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const list = await dbAll<{ tx_hash: string; amount: number; credited_waz: number | null; block_number: number; swept: number; confirmed_at: string | null; block_at_seen: number | null; created_at: string }>(
      `SELECT tx_hash, amount, credited_waz, block_number, swept, confirmed_at, block_at_seen, created_at
       FROM deposit_txns WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
      [user.id]
    )
    const requiredConf = getProtocolParam<number>('usdc_required_confirmations', 12)
    let latestBlock: number | null = null
    if (list.some(r => !r.confirmed_at)) {
      latestBlock = await getCachedLatestBlock()
    }
    const enriched = list.map(r => {
      const pending = !r.confirmed_at
      const confs = pending && latestBlock != null ? Math.max(0, latestBlock - r.block_number) : null
      return {
        ...r,
        status: r.confirmed_at ? 'confirmed' : 'pending',
        confirmations: confs,
        required_confirmations: requiredConf,
      }
    })
    res.json(enriched)
  })

  // 收入构成:销售 / 分享归因 / PV 记录(若适用)
  app.get('/api/wallet/income', async (req, res) => {
    const user = auth(req, res); if (!user) return
    const commByLevel = await dbAll<{ level: number; cnt: number; total: number }>(`
      SELECT level, COUNT(*) as cnt, COALESCE(SUM(amount),0) as total
      FROM commission_records WHERE beneficiary_id = ? GROUP BY level
    `, [user.id])
    const commMap: Record<string, { count: number; total: number }> = { l1: { count:0, total:0 }, l2: { count:0, total:0 }, l3: { count:0, total:0 } }
    for (const r of commByLevel) {
      const key = `l${r.level}`
      if (commMap[key]) commMap[key] = { count: r.cnt, total: Number(r.total.toFixed(2)) }
    }
    // matching-rewards income removed — engine excised (#401). Income = affiliate commission (real sales) + own sales.
    const sales = (await dbOne<{ cnt: number; total: number }>(`
      SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total
      FROM orders WHERE seller_id = ? AND status = 'completed'
    `, [user.id]))!
    const totalIncome =
      commMap.l1.total + commMap.l2.total + commMap.l3.total + Number(sales.total)
    // RFC-018: commission accrued but still in the clearing window (matures into commissions/total_income). Pure read.
    const clearing = (await dbOne<{ s: number }>("SELECT COALESCE(SUM(amount),0) as s FROM pending_commission_escrow WHERE recipient_user_id = ? AND matures_at IS NOT NULL AND status = 'pending'", [user.id]))!.s
    res.json({
      commissions: commMap,
      commission_clearing: Number(clearing.toFixed(2)),   // RFC-018: accrued, maturing after the return window (not yet paid)
      sales: { count: sales.cnt, total: Number(Number(sales.total).toFixed(2)) },
      total_income: Number(totalIncome.toFixed(2)),
    })
  })

  // P0 测试充值（Phase 0 专用）
  // 测试水龙头(faucet)— 资金铸造路径,fail-safe **默认关闭**(Codex #187/#222 / task #1128)。
  //   1) 环境门禁(见 isFaucetAllowed):**绝不靠 NODE_ENV 的默认值**关闭铸币路径 —— 本仓库不设 NODE_ENV,
  //      生产全靠 Railway 面板注入;旧代码 `NODE_ENV || 'development'` 若漏设会把 faucet 在生产打开。
  //      现在:显式 production → 永远关;部署平台(Railway 注入 RAILWAY_ENVIRONMENT)→ 默认关,
  //      仅显式 WEBAZ_ENABLE_TEST_FAUCET=1 才开;本地(无平台信号 + dev/test/未设)→ 开。
  //   2) cap 原子化:单条 `balance = MIN(5000, balance + ?)`,并发/Phase 3 pg 下都不会越过 5000。
  //   3) Phase 3 资金路径:迁 pg 时应移到 wallet-write + SELECT...FOR UPDATE 行锁。
  const FAUCET_ALLOWED = isFaucetAllowed({
    nodeEnv: process.env.NODE_ENV,
    onDeployPlatform: !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID),
    explicitEnableFlag: process.env.WEBAZ_ENABLE_TEST_FAUCET === '1',
  })
  app.post('/api/wallet/topup', async (req, res) => {
    const user = auth(req, res); if (!user) return
    if (!FAUCET_ALLOWED) return void res.status(403).json({ error: '充值水龙头仅在测试环境开放', error_code: 'FAUCET_DISABLED' })
    if (isTrustedRole(user as Record<string, unknown>)) return void res.status(403).json({ error: '受信角色无钱包', error_code: 'TRUSTED_ROLE_NO_WALLET' })
    const amount = Math.min(1000, Math.max(1, Number(req.body?.amount) || 500))
    const before = await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id])
    if (!before) return void res.status(500).json({ error: '钱包记录缺失', error_code: 'WALLET_MISSING' })
    if (before.balance >= 5000) return void res.json({ error: '余额已达上限 5000 WAZ，无需充值' })
    // 原子封顶:无论并发,balance 永不超 5000(MIN 在单条 UPDATE 内对当前值求值)。
    await dbRun('UPDATE wallets SET balance = MIN(5000, balance + ?) WHERE user_id = ?', [amount, user.id])
    const after = (await dbOne<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', [user.id]))!.balance
    res.json({ success: true, added: Math.round((after - before.balance) * 100) / 100, new_balance: after, capped: after >= 5000 })
  })
}

/**
 * Faucet (WAZ mint path) gate — fail-safe DEFAULT-CLOSED (task #1128 / Codex #187/#222).
 *
 * The repo never sets NODE_ENV; production relies on the Railway dashboard injecting it. So a
 * mint path must NOT lean on a `NODE_ENV || 'development'` default to stay shut — an unset
 * NODE_ENV in prod would open it. Rules (in order):
 *   1. explicit NODE_ENV==='production' → CLOSED (even if the enable flag is mis-set).
 *   2. explicit enable flag (WEBAZ_ENABLE_TEST_FAUCET=1) → OPEN (staging/test boxes opt in).
 *   3. on a deploy platform (Railway injects RAILWAY_ENVIRONMENT/PROJECT/SERVICE) without the
 *      flag → CLOSED — this is the fail-safe for a misconfigured/unset NODE_ENV in prod.
 *   4. off-platform (local dev) → OPEN only for unset / 'development' / 'test'; any other
 *      explicit value → CLOSED.
 */
export function isFaucetAllowed(e: { nodeEnv?: string; onDeployPlatform: boolean; explicitEnableFlag: boolean }): boolean {
  if (e.nodeEnv === 'production') return false
  if (e.explicitEnableFlag) return true
  if (e.onDeployPlatform) return false
  return e.nodeEnv === undefined || e.nodeEnv === 'development' || e.nodeEnv === 'test'
}
