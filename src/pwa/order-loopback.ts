/**
 * RFC-025 PR-5a — 进程内回环建单调用(order-submit-exec 的执行通道)。
 * 打【真实】POST /api/orders(单一执行真相源:区域/运费/库存 CAS/钱包扣款/直付门全走生产同一条路)。
 * Bearer = 买家本人 api_key(执行发生在其人类 approve 会话内,由其 Passkey 逐笔授权)。
 * portThunk:PORT 常量声明在 server.ts 尾部,注册点用 thunk 延迟取值(调用发生在请求期,无 TDZ)。
 */
export function makeCreateOrderLoopback(portThunk: () => number) {
  return async (apiKey: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> | null }> => {
    const resp = await fetch(`http://127.0.0.1:${portThunk()}/api/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    })
    let json: Record<string, unknown> | null = null
    try { json = await resp.json() as Record<string, unknown> } catch { json = null }
    return { status: resp.status, json }
  }
}
