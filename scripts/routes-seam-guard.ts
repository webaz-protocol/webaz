/**
 * RFC-016 routes seam ratchet guard
 *
 * Enforces the sync→async DB-seam migration progress for src/pwa/routes/*.ts.
 *
 * Every route file must have EXACTLY the number of remaining `db.prepare(` call
 * sites listed in REMAINING_SYNC_PREPARES below — files not listed must have 0.
 *
 * The number for a file = the sync `db.prepare` sites NOT yet on the async seam
 * (dbOne/dbAll/dbRun). For files in the transaction-bearing tier these are the
 * statements inside / feeding a `db.transaction()` block (better-sqlite3
 * transactions must stay synchronous until RFC-016 Phase 3 swaps them to the
 * pg transaction API). For not-yet-started files it's their full original count.
 *
 * Strict equality makes this a ratchet:
 *   - Convert a site but forget to lower the number  → count < allow  → FAIL
 *     ("you converted more than the allowlist knows — lower the number")
 *   - Leave a stray non-seam site in a file you "finished" → count > allow → FAIL
 *     ("an unaccounted db.prepare slipped in — convert it or it's a straggler")
 *
 * As Phase 1 proceeds every number trends to 0; when a file hits 0 remove its
 * entry. Phase 3 drives the transaction-tier entries to 0.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pwa', 'routes')

// basename → allowed remaining sync `db.prepare(` sites. Absent ⇒ 0 (fully on seam).
const REMAINING_SYNC_PREPARES: Record<string, number> = {
  // — transaction-bearing tier (residual sites live in / feed db.transaction blocks) —
  'products-aliases.ts': 3,
  'profile-identity.ts': 2,
  'offers.ts': 3,
  'reviews.ts': 3,             // claim stake/escrow tx (dup guard + wallet debit + INSERT task)
  'claim-initiators.ts': 3,    // claim stake/escrow tx (dup guard + wallet debit + INSERT task)
  'products-claims.ts': 3,     // claim stake/escrow tx (dup guard + wallet debit + INSERT task)
  'arbitrator.ts': 10,         // apply/withdraw/approve/reject stake tx (CAS status flip + wallet)
  'verifier-user.ts': 6,       // apply/withdraw stake tx (CAS + wallet)
  'admin-verifier-flow.ts': 13,// approve/reject/decide tx (CAS flip + refund/reward payout)
  'admin-verifier-whitelist.ts': 5,  // revoke forfeit tx (re-read + forfeit/refund + whitelist rewrite)
  'claim-voting.ts': 6,        // vote→seal tx (re-check + INSERT vote + count + CAS seal); settle post-commit
  'verify-tasks.ts': 3,        // submit→seal tx (CAS submit + count + CAS settling); settleTask post-commit
  'products-links.ts': 4,      // claim fee-lock tx (dup task + debit + INSERT link + INSERT task)
  'url-claim.ts': 7,           // challenge-verify CAS tx (2) + claim-url stake+fee tx (5)
  'products-create.ts': 4,     // source_url conflict fee-lock tx (INSERT link + warehouse + debit + INSERT task)
  'auth-register.ts': 5,   // registerTx (users + wallet + audit + placement + register-code consume)
  'anchors.ts': 2,         // touch user-anchor batch attribution (loop INSERTs)
  'shareables.ts': 3,      // DELETE soft-remove tx (status + total_likes + photo_index)
  'shareables-interactions.ts': 7,  // like toggle tx (existing/del/upd×2/ins/upd×2)
  'cart.ts': 4,            // checkout tx (order insert + wallet deduct + stock + cart clear)
  'listings.ts': 5,        // create + offer stake tx (insert + wallet deduct ×2 + listing counter)
  'variants.ts': 10,       // 3 stock-aggregate tx (insert/update + product.stock sync)
  'ratings.ts': 4,         // 2 insert+notify tx (rating/buyer-rating → reputation)
  'addresses.ts': 8,       // 3 default-mutex tx (insert/update/delete + is_default flip)
  'admin-admins.ts': 9,    // create + revoke tx + emergency-freeze tx (suspend + strip admin + revoke sessions + audit — atomic, sync db.transaction)
  'checkin-tasks.ts': 4,   // 2 reward tx (checkin/task insert + notification)
  'admin-protocol-params.ts': 4,  // patch + reset update+log tx (constitutional guard)
  'rewards-apply.ts': 8,   // apply escrow-drain tx + deactivate tx (RFC-002 money path)
  'group-buys.ts': 15,     // settleGroupBuy + sweep sync helpers (cron) + join/leave escrow tx
  'feedback.ts': 5,        // 2 message-insert tx (admin reply + thread message)
  'dispute-cases.ts': 9,   // comment + reply + fairness-vote tx (counters)
  'wallet-write.ts': 16,   // withdraw + confirm iron-rule fund handlers (sync) + cancel tx
  // — deferred money-path helpers (consumed synchronously inside order creation) —
  'coupons.ts': 2,         // applyCouponToOrder
  'flash-sales.ts': 1,     // getActiveFlashSale
  'agent-buy.ts': 12,      // order-create + wallet deduct path(auto_buy 原子核心已包 db.transaction:余额守卫扣款 + 库存 stock>=1 CAS + 建单 + 价格锁,任一 changes!==1 回滚;transition/通知在 tx 后,因 transition 自带事务不可嵌套)
  'secondhand.ts': 7,      // order handler: pragma FK-OFF window + CAS + escrow (money path)
  'chat.ts': 4,            // message-send tx (insert msg + bump conv) + mark-read tx (unread + read_at)
  'orders-create.ts': 24,  // 下单原子事务(15) + 价格锁一次性消费 SELECT+mark(2,无 await gap,Codex #224) + 店铺推荐懒升级(7,必须同步:跑在下单 db.transaction 内、getProductShareChain 之前)
  'orders-action.ts': 20,  // state-machine/decline/settle 写序列 + confirm-in-person tx + 逐单 batch-ship 写 + pq_withdraw 原子(dispute dismiss + transition 同一 tx)(纯校验读已迁 seam)
  'auction.ts': 21,        // 5 db.transaction(create/remind/bid/cancel stake 写序列)+ reminder cron 同步 + 2 个 tx 内余额守恒重读(Codex PR#228 P1:await 预检与同步 stake tx 间的 yield 会让并发超额锁押,故 create/bid 在 tx 内重读余额并先于写抛回滚;create 的 product active→auction_pending flip 同改为带 status 守卫的 CAS 防并发双挂,#239 follow-up)(纯校验读/公开读/读回/单 DELETE/通知已迁 seam)
  'disputes-write.ts': 29, // arbitrate 仲裁核心(原子领取 + 2 settlement tx + reputation/strike/publish)+ 2 pause/resume tx(各含 1 tx 内重读授权/状态守卫,Codex #229 P1:await 预检与同步 tx 间 yield 会用陈旧权限/状态写,故 tx 内重读 dispute 重判 ruling/status/assignment 并从重读行算 baseline,先于写抛回滚)+ tx 内 appendAuditLog + 证据 INSERT/decline 结算序列(纯读/SNF 读/标记写已迁 seam)
  // — not yet started (full original counts; lower as converted) —
  'charity.ts': 62,   // 模块 helper ensureCharityRep(tx 内调用)+ isCharityBlocked(2)+ 两个 cron 整体(expireCharityWishes 14 + autoAcceptExpiredRepayments 5)+ 端点 db.transaction 钱块(发布/确认/取消/还愿/响应/捐款/下架/拨款);Codex #238 P1:publish/repay/donate/disburse 扣款带 balance(或 fund balance)守卫 changes===1、cancel CAS open→cancelled、takedown CAS open/claimed/disputed→cancelled 仅真转换才释放 escrow(disputed=举报自动隐藏但 escrow 仍锁,#247 复审补)、repay tx 内 dup 重检(+1);端点纯校验读/公开列表/读回 + 单语句标记/CAS/通知写已迁 seam
  'claim-verify.ts': 42,  // 模块级结算/资格/通知 helper(settleClaimTask 裸多写结算+distributePool+outlier+notifyEligibleVerifiers+isEligible+activeCount+processQueue,34)+ claim 发起锁押(Codex #237 P1:原裸 3 连写已包进 db.transaction + tx 内 dup 重检 + 余额守卫扣押 + 订单 flag CAS,4)+ vote 共识 guard/insert/recount/seal 4;端点纯校验读/列表/公开查询/读回 + 单语句标记写(seller-evidence 加 status+evidence_at 守卫 409)+ 写后通知已迁 seam
  'governance-auto-deactivate.ts': 6,  // cron role-sweep:候选扫描读已迁 seam,逐用户卸任 db.transaction 写仍同步(Phase 3)+ tx 内重读 verifier_stats 守卫(Codex #231 P1:扫描与 tx 间 tasks_wrong 可能因申诉成功递减,故 tx 内重读 stats 重算阈值,不再越线则不写)
  'governance-onboarding.ts': 12,  // activate/resign/resolve-appeal 的 3 个角色态 CAS db.transaction(各 4);申请/题目/案例/申诉端点纯读+单写已迁 seam
  'returns.ts': 14,        // executeReturnRefund 退款 db.transaction(CAS return 行 + 余额守卫扣款 + 库存 + 状态,8)+ escalate 建争议 tx(2);RFC-018 新增 3:退款 tx 内读 order total + 冲销本单 clearing 行(全退 reversed / 部分按比例减额),与退款原子(10→13);PR4 新增 1:全额退货 tx 内 completion_count -1(13→14)。端点校验读/列表/状态写/消息/通知已迁 seam
  'rewards-auto-downgrade.ts': 4,  // cron consent-sweep:currentMajor + 候选扫描读已迁 seam,逐用户降级 db.transaction 写仍同步(Phase 3)
  'rewards-clearing-mature.ts': 7,  // RFC-018 maturation:matureClearingRow 的同步钱路 db.transaction(order/dispute 重校验读 + CAS pending→settled + region 读 + commission_records 写 + commissionSourceType 的 2 读);sweep 扫描用 async seam(dbAll)。Phase 3 迁 pg
  'rewards-escrow-expire.ts': 2,  // cron money-sweep:扫描读已迁 seam,到期 materialize 的 db.transaction 写仍同步(Phase 3)
  'direct-pay-timeouts.ts': 5,    // Direct Pay (Rail 1) 超时 cron:扫描读(付款窗口/宽限/货款协商申诉窗 3 扫)+ 状态转移/释放质押的 db.transaction 写仍同步(money/state path,Phase 3 迁 pg)
  'rfqs.ts': 25,        // create/cancel/bid/patch/delete 的 db.transaction 写序列 + award/first_match 选标读(rfq/winner 作为权威 subject 喂 awardBidAndCreateOrder,事务内不 re-read);Codex #236 P1:5 条 stake 路径加 tx 内权威守卫——扣款带 balance>=? 守卫、cancel/delete 用 status CAS、create-bid 重确认 RFQ open、patch tx 内重读 bid/rfq 并从重读 stake 算 delta(+3 tx 内重读:patch 2 + delete 1);端点纯校验读/列表/读回 + 单语句通知写已迁 seam
  'trial.ts': 14,          // eval cron 逐 claim metrics 读 + 退款 db.transaction(12)+ claim 抢名额 tx(2);端点纯读/单写已迁 seam。Codex #233 P1:退款 tx 内先 CAS claim(WHERE status='pending_threshold' + changes===1)再扣款(WHERE balance>=amount + changes===1)防并发 eval 双退;metrics/expired 更新同加 status guard(改现有语句,计数不变)
}

const PREPARE_RE = /\bdb\.prepare\s*\(/g

let failed = false
let totalRemaining = 0
const seen = new Set<string>()

for (const file of readdirSync(ROUTES_DIR).filter(f => f.endsWith('.ts')).sort()) {
  const src = readFileSync(join(ROUTES_DIR, file), 'utf8')
  const count = (src.match(PREPARE_RE) || []).length
  const allowed = REMAINING_SYNC_PREPARES[file] ?? 0
  seen.add(file)
  totalRemaining += count
  if (count !== allowed) {
    failed = true
    if (count > allowed) {
      console.error(`❌ ${file}: ${count} db.prepare, allowlist=${allowed} — ${count - allowed} unaccounted site(s). Convert to dbOne/dbAll/dbRun, or (if it must stay in a db.transaction) raise the allowlist with justification.`)
    } else {
      console.error(`❌ ${file}: ${count} db.prepare, allowlist=${allowed} — you converted ${allowed - count} more than recorded. Lower scripts/routes-seam-guard.ts to ${count}.`)
    }
  }
}

// Stale allowlist entry (file deleted/renamed)
for (const file of Object.keys(REMAINING_SYNC_PREPARES)) {
  if (!seen.has(file)) {
    failed = true
    console.error(`❌ allowlist names ${file} but it no longer exists in routes/ — remove the stale entry.`)
  }
}

if (failed) {
  console.error('\nRFC-016 routes seam ratchet failed. The allowlist only goes DOWN as call sites move to the async seam.')
  process.exit(1)
}
console.log(`✅ routes seam ratchet: all ${seen.size} route files match allowlist (${totalRemaining} sync db.prepare remaining across the tx-tier + deferred money-path files)`)
