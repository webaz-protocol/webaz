/**
 * Admin 系统健康监控 — DB 体积 + 表行数 + RPC 延迟 + 内存 + in-mem buffer
 *
 * 由 #1013 Phase 111 从 src/pwa/server.ts 抽出。
 *
 * 1 endpoint:
 *   GET /api/admin/health  (protocol)  系统健康快照
 *
 * 跨域注入：requireProtocolAdmin + publicClient (getter) + rpcUrl + NETWORK
 *           + adminEventClients/sseClients/systemEventBuffer/authFailures (in-mem 引用)
 */
import type { Application, Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { dbOne } from '../../layer0-foundation/L0-1-database/db.js'  // RFC-016 异步 DB seam

export interface AdminHealthDeps {
  db: Database.Database
  requireProtocolAdmin: (req: Request, res: Response) => Record<string, unknown> | null
  // publicClient 在 server.ts 是 const → 用 getter 延迟解析避免 TDZ
  getPublicClient: () => { getBlockNumber: () => Promise<unknown> }
  getRpcUrl: () => string
  getNetwork: () => string
  adminEventClients: Set<unknown> | Map<unknown, unknown>
  sseClients: Set<unknown> | Map<unknown, unknown>
  systemEventBuffer: Array<unknown>
  authFailures: Map<unknown, unknown>
}

export function registerAdminHealthRoutes(app: Application, deps: AdminHealthDeps): void {
  const { db, requireProtocolAdmin, getPublicClient, getRpcUrl, getNetwork,
          adminEventClients, sseClients, systemEventBuffer, authFailures } = deps

  app.get('/api/admin/health', async (req, res) => {
    const admin = requireProtocolAdmin(req, res); if (!admin) return
    let dbSizeBytes = 0
    try {
      const fs = await import('node:fs')
      const dbPath = (db as unknown as { name?: string }).name || './webaz.db'
      if (fs.existsSync(dbPath)) dbSizeBytes = fs.statSync(dbPath).size
    } catch {}
    const tableCounts: Record<string, number> = {}
    const tables = ['users', 'orders', 'products', 'wallets', 'disputes', 'order_ratings',
      'return_requests', 'deposit_txns', 'withdrawal_requests', 'notifications',
      'feedback_tickets', 'platform_reward_log', 'protocol_params_log', 'flash_sales',
      'push_subscriptions', 'system_events_buffer_in_mem']
    for (const t of tables) {
      if (t === 'system_events_buffer_in_mem') continue
      try {
        tableCounts[t] = (await dbOne<{ n: number }>(`SELECT COUNT(*) as n FROM ${t}`))!.n
      } catch { tableCounts[t] = -1 }
    }
    let rpcLatencyMs = -1
    try {
      const t0 = Date.now()
      await getPublicClient().getBlockNumber()
      rpcLatencyMs = Date.now() - t0
    } catch {}
    const mem = process.memoryUsage()
    res.json({
      timestamp: new Date().toISOString(),
      uptime_sec: Math.floor(process.uptime()),
      node_env: process.env.NODE_ENV || 'development',
      network: getNetwork(),
      db: {
        size_bytes: dbSizeBytes,
        size_mb: dbSizeBytes ? (dbSizeBytes / 1024 / 1024).toFixed(2) : null,
        tables: tableCounts,
      },
      memory: {
        rss_mb: (mem.rss / 1024 / 1024).toFixed(2),
        heap_used_mb: (mem.heapUsed / 1024 / 1024).toFixed(2),
        heap_total_mb: (mem.heapTotal / 1024 / 1024).toFixed(2),
      },
      in_memory_buffers: {
        sse_admin_clients: (adminEventClients as Set<unknown>).size ?? (adminEventClients as Map<unknown, unknown>).size,
        sse_user_clients: (sseClients as Set<unknown>).size ?? (sseClients as Map<unknown, unknown>).size,
        system_event_buffer: systemEventBuffer.length,
        auth_failure_records: authFailures.size,
      },
      rpc: {
        url: getRpcUrl(),
        latency_ms: rpcLatencyMs,
        ok: rpcLatencyMs >= 0,
      },
    })
  })
}
