/**
 * L0-2 · 状态机：合法转移表
 *
 * 每一行定义：从哪个状态 → 到哪个状态，谁有权触发，需要什么证据，用哪个截止时间。
 * 不在这张表里的转移，一律拒绝——这是「无歧义」设计的核心。
 */

export type OrderStatus =
  | 'created'      // 买家下单，等待付款
  | 'paid'         // 资金已托管
  | 'accepted'     // 卖家已接单
  | 'shipped'      // 卖家已交物流
  | 'picked_up'    // 物流已揽收
  | 'in_transit'   // 运输中
  | 'delivered'    // 物流已投递
  | 'delivery_failed'  // PR-B:卖家/物流举证"未派送成功"(送到快照地址退回/拒收);fault-neutral,证据裁决
  | 'return_pending'   // PR-B3b:escrow 单买家责任已定,持有 escrow 等货物返还确认(卖家确认→成本扣除;超时→默认退买家;货丢→仲裁)
  | 'confirmed'    // 买家确认收货 → 触发结算
  | 'disputed'     // 争议中
  | 'completed'    // 交易完成（无争议自然完成 — 旧）
  | 'cancelled'    // 已取消（买家主动取消 / 卖家未接单）
  | 'fault_buyer'      // 超时判责：买家
  | 'fault_seller'     // 超时判责：卖家
  | 'fault_logistics'  // 超时判责：物流
  | 'declined_nofault' // RFC-007：卖家无责拒单（客观无法履行,经人工仲裁认定）→ 全退买家 + 退卖家质押,零罚没
  // ── 模块 B：细化争议结案状态 ────────────────────────────────
  | 'resolved_for_seller'   // 仲裁裁定卖家胜诉，资金释放
  | 'refunded_partial'      // 仲裁裁定部分退款
  | 'refunded_full'         // 仲裁裁定全额退款，订单作废
  | 'dispute_dismissed'     // 争议被驳回（无效）
  | 'expired'               // 订单超时自动失败（通用兜底）
  | 'pending_accept' // 手动接单模式:下单后等卖家确认接单(付款前;直付轨此阶段不展示收款信息)
  // ── Direct Pay (Rail 1) 直付专属状态 ───────────────────────────
  | 'direct_pay_window'          // Rail1: 卖家已质押平台费,展示收款方式,等买家付款(直付/场外)
  | 'direct_expired_unconfirmed' // Rail1: 付款窗口超时未标记 —— 不静默关单,留买家争议/确认窗口
  | 'payment_query'              // Rail1: 卖家报告未收到货款 → 买卖双方【协商】(非仲裁),暂停履约;协商未果才升举证仲裁

export type UserRole =
  | 'buyer' | 'seller' | 'logistics' | 'reviewer'
  | 'arbitrator' | 'promoter' | 'system'  // system = 超时自动触发

export interface Transition {
  allowedRoles: UserRole[]           // 哪些角色可以触发
  deadlineField?: string             // 对应 orders 表里的截止时间字段
  requiresEvidence?: boolean         // 是否必须提交证据
  evidenceHint?: string              // 提示：应该上传什么证据
  autoFaultState?: OrderStatus       // 超时后自动跳转到哪个判责状态
  faultParty?: UserRole              // 超时时谁负责
  description: string                // 人类可读的说明
}

// key 格式：'from_status→to_status'
export const VALID_TRANSITIONS: Record<string, Transition> = {

  // ── 买家付款 ──────────────────────────────────────────────
  'created→paid': {
    allowedRoles: ['buyer'],
    deadlineField: 'pay_deadline',
    requiresEvidence: false,
    autoFaultState: 'cancelled',
    faultParty: 'buyer',
    description: '买家完成付款，资金进入托管'
  },

  'created→cancelled': {
    allowedRoles: ['buyer', 'seller', 'system'],
    requiresEvidence: false,
    description: '下单后付款前取消订单'
  },

  // ── Direct Pay (Rail 1) 直付:只"支付"这一步变,之后汇入既有流程 ──────────────
  //   设计稿 docs/modules/DIRECT-PAYMENT-MODULE-DESIGN.INTERNAL.md §4。
  //   本金(货款)不经协议;协议不验证付款;买家声明已付款 → 汇入 accepted(卖家发货)。
  'created→direct_pay_window': {
    allowedRoles: ['system'],   // 直付下单路由锁定卖家费用质押后,以 system 显式推进(非超时驱动)
    requiresEvidence: false,
    description: 'Rail1 直付:卖家已质押平台费、展示收款方式,进入付款窗口'
  },
  // ── 手动接单模式(accept_mode='manual',v16):付款前先等卖家确认接单 ──────────
  //   直付轨:created→pending_accept(替代 created→direct_pay_window),卖家接单才进付款窗口 ——
  //   非托管无 hold 可言,时序门(接单前不出示收款信息)是唯一正确的付款风控。
  //   escrow 轨不用本状态:escrow 本身就是条件中间态(付款进托管,接单才继续,超时自动全额退回)。
  'created→pending_accept': {
    allowedRoles: ['system'],   // 建单路由按 accept_mode 快照以 system 推进(与 created→direct_pay_window 同模式)
    requiresEvidence: false,
    description: '手动接单:订单等待卖家确认接单(付款前,不展示收款信息)'
  },
  'pending_accept→direct_pay_window': {
    allowedRoles: ['seller', 'system'],
    requiresEvidence: false,
    description: '卖家确认接单 → 进入直付付款窗口(此刻起买家方可见收款信息)'
  },
  'pending_accept→cancelled': {
    // deadlineField 供专属 cron(direct-pay-timeouts.ts)读取;故意不设 autoFaultState →
    // 通用 engine.checkTimeouts 绝不触发本转移(会漏库存回补等副作用)。超时=无责取消(没人付过钱)。
    allowedRoles: ['seller', 'buyer', 'system'],
    deadlineField: 'pending_accept_deadline',
    requiresEvidence: false,
    description: '接单前取消:卖家谢绝 / 买家撤单 / 超时未接单(system) → 无责取消 + 回补库存'
  },
  'direct_pay_window→accepted': {
    allowedRoles: ['buyer'],
    requiresEvidence: false,
    description: 'Rail1 直付:买家声明"我已付款" → 汇入既有流程(卖家发货);协议不验证付款,谎报则卖家不发货(零损失自纠正)'
  },
  'direct_pay_window→cancelled': {
    allowedRoles: ['buyer', 'system'],
    requiresEvidence: false,
    description: 'Rail1 直付:付款前买家取消(或卖家请求取消经买家确认)→ 释放费用质押'
  },
  'direct_pay_window→direct_expired_unconfirmed': {
    // deadlineField 供【专属 cron(direct-pay-timeouts.ts)】读取;故意【不设 autoFaultState】→
    // 通用 engine.checkTimeouts(需 deadlineField+autoFaultState 两者)绝不触发本转移,避免漏掉释放质押等副作用。
    allowedRoles: ['system'],
    deadlineField: 'direct_pay_window_deadline',
    requiresEvidence: false,
    description: 'Rail1 直付:付款窗口超时未标记 → 不静默关单,转可争议态(专属 cron 释放费用质押 + 停用收款指令)'
  },
  'direct_expired_unconfirmed→disputed': {
    allowedRoles: ['buyer'],
    requiresEvidence: true,
    evidenceHint: '上传付款凭证(证据分级:链上 tx / 银行回执 / 截图)',
    description: 'Rail1 直付:买家"我确实付了" → 升级争议(证据级信誉裁决,本档无资金赔付)'
  },
  'direct_expired_unconfirmed→cancelled': {
    allowedRoles: ['buyer', 'system'],
    requiresEvidence: false,
    description: 'Rail1 直付:买家确认未付 / 宽限期后系统关单(终态)'
  },

  // ── Direct Pay (Rail 1) 取消退款握手(审计项 C):买家已付款、卖家未发货 → 三步握手无责关单 ──────────
  //   request(买家)→ mark_refunded(卖家声明已场外退款)→ confirm(买家确认收到,Passkey)→ 本边(system 执行)。
  //   仅 system:买家不能单方取消已付款订单,必须经握手(域模块 src/direct-pay-cancel-refund.ts 收口,非托管零资金)。
  'accepted→cancelled': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: 'Rail1 直付:取消退款握手完成(卖家已场外退款+买家确认收到)→ 系统无责关单,恢复库存'
  },

  // ── Direct Pay (Rail 1) 货款协商(争议≠仲裁):卖家报未收款 → 双方先协商,谈不拢才升举证仲裁 ──────────
  'accepted→payment_query': {
    allowedRoles: ['seller'],
    requiresEvidence: false,
    description: 'Rail1 直付:卖家报告未收到货款 → 进入协商(非仲裁),暂停履约。买家可取消/主张已付,卖家可确认已收/(宽限后)取消'
  },
  'payment_query→accepted': {
    allowedRoles: ['seller'],
    requiresEvidence: false,
    description: 'Rail1 直付:卖家确认已收到货款 → 恢复原订单继续履约'
  },
  'payment_query→cancelled': {
    // buyer=主动取消(承认未付);seller=买家静默宽限后请求取消;system=cron 在 7 天买家申诉窗口后终结。时序/窗口由路由+cron 守。
    allowedRoles: ['buyer', 'seller', 'system'],
    requiresEvidence: false,
    description: 'Rail1 直付:协商关单(买家承认未付 / 卖家宽限后取消 / 系统申诉窗口后终结)'
  },
  'payment_query→disputed': {
    allowedRoles: ['buyer', 'seller'],
    requiresEvidence: true,
    evidenceHint: '上传付款/未收款凭证(链上 tx / 银行回执 / 截图)',
    description: 'Rail1 直付:协商未果(买家主张已付 + 卖家否认)→ 升级举证仲裁(证据制信誉裁决,不涉资金)'
  },
  'disputed→payment_query': {
    // 裁定前回到协商的两条路径:①买卖任一方【撤回仲裁申请】(pq_withdraw);②仲裁员【驳回仲裁,退回协商】——
    //   协议(sys_protocol)在仲裁员现场 Passkey 授权后代执行,故加 'system'。均仅裁定前有效(裁定后 disputed 已终结),时序/授权由路由守。
    allowedRoles: ['buyer', 'seller', 'system'],
    requiresEvidence: false,
    description: 'Rail1 直付:回到协商(裁定前)—— 买卖双方撤回仲裁,或仲裁员驳回仲裁退回协商(system 代执行)'
  },
  'disputed→confirmed': {
    // 争议协商收口(买家侧):买家撤诉并确认收货 —— 包裹晚到/放代收点后来找到等场景,不必只剩仲裁一条收口。
    //   限定【delivered 来源的履约争议 + 争议发起人本人 + 裁定前】,来源/发起人/时序由路由权威门守
    //   (orders-action dispute_withdraw_confirm,与 disputed→payment_query 的 pq_withdraw 同模式);
    //   同一事务内争议 dismissed + confirmed→completed + settleOrder(与既有 confirm 结算完全同链)。
    allowedRoles: ['buyer'],
    requiresEvidence: false,
    description: '买家撤诉并确认收货(裁定前,限履约争议):争议无责关闭,订单正常完成结算'
  },

  // ── 卖家接单 ──────────────────────────────────────────────
  'paid→accepted': {
    allowedRoles: ['seller'],
    deadlineField: 'accept_deadline',
    requiresEvidence: false,
    autoFaultState: 'fault_seller',
    faultParty: 'seller',
    description: '卖家确认接单，承诺按时发货'
  },

  'paid→cancelled': {
    allowedRoles: ['buyer', 'seller', 'system'],
    requiresEvidence: false,
    description: '卖家接单前买家可取消;卖家可按买家原因/买家要求记录无责取消（全额退款）'
  },

  // ── 卖家发货 ──────────────────────────────────────────────
  'accepted→shipped': {
    allowedRoles: ['seller'],
    deadlineField: 'ship_deadline',
    requiresEvidence: true,
    evidenceHint: '上传：物流单号截图 + 包裹称重/外观照片',
    autoFaultState: 'fault_seller',
    faultParty: 'seller',
    description: '卖家将包裹交给物流，提交发货证明'
  },

  // ── 物流揽收 ──────────────────────────────────────────────
  // Phase 1（2026-05-27）：seller 自选 self-fulfill 也可驱动这 3 个 transition（详见 docs/LOGISTICS-PHASING.md）
  // Phase 2 logistics 市场启用后会按 order.fulfillment_mode 限定真实 logistics 角色
  'shipped→picked_up': {
    allowedRoles: ['seller', 'logistics'],
    deadlineField: 'pickup_deadline',
    requiresEvidence: true,
    evidenceHint: '上传：揽收扫描记录 + 当前GPS位置',
    autoFaultState: 'fault_logistics',
    faultParty: 'logistics',
    description: '物流方（或 self-fulfill 卖家）确认已揽收，包裹完整'
  },

  // ── 运输中更新 ─────────────────────────────────────────────
  'picked_up→in_transit': {
    allowedRoles: ['seller', 'logistics', 'system'],
    requiresEvidence: false,
    description: '包裹开始运输（可自动触发；self-fulfill 时由 seller 主动）'
  },

  // ── 物流投递 ──────────────────────────────────────────────
  'in_transit→delivered': {
    allowedRoles: ['seller', 'logistics'],
    deadlineField: 'delivery_deadline',
    requiresEvidence: true,
    evidenceHint: '上传：投递照片（含门牌号）+ 收件人签收/GPS坐标',
    autoFaultState: 'fault_logistics',
    faultParty: 'logistics',
    description: '物流方（或 self-fulfill 卖家）确认投递完成，提交投递证明'
  },

  // ── 买家确认 ──────────────────────────────────────────────
  'delivered→confirmed': {
    allowedRoles: ['buyer', 'system'],  // system = 超时自动确认
    deadlineField: 'confirm_deadline',
    requiresEvidence: false,
    autoFaultState: 'confirmed',        // 超时不是判责，而是自动确认
    faultParty: 'system',
    description: '买家确认收货，触发资金结算'
  },

  // ── 发起争议（任何阶段都可触发）──────────────────────────────
  'paid→disputed': {
    allowedRoles: ['buyer', 'seller'],
    requiresEvidence: true,
    evidenceHint: '描述问题并上传相关证据',
    description: '资金托管后发现问题，发起争议'
  },
  'accepted→disputed': {
    allowedRoles: ['buyer', 'seller'],
    requiresEvidence: true,
    evidenceHint: '描述问题并上传相关证据',
    description: '卖家接单后发现问题'
  },
  'shipped→disputed': {
    allowedRoles: ['buyer', 'seller', 'logistics'],
    requiresEvidence: true,
    evidenceHint: '描述问题并上传相关证据',
    description: '发货后出现问题'
  },
  'picked_up→disputed': {
    allowedRoles: ['buyer', 'seller', 'logistics'],
    requiresEvidence: true,
    evidenceHint: '描述问题并上传相关证据',
    description: '揽收后出现问题（如包裹损毁）'
  },
  'in_transit→disputed': {
    allowedRoles: ['buyer', 'seller', 'logistics'],
    requiresEvidence: true,
    evidenceHint: '描述问题并上传相关证据',
    description: '运输中出现问题'
  },
  'delivered→disputed': {
    allowedRoles: ['buyer'],
    requiresEvidence: true,
    evidenceHint: '上传：收到货物的照片 + 问题描述',
    description: '买家收货后发现货不对版或货损'
  },

  // ── 仲裁结束（旧粗粒度，保留兼容）─────────────────────────
  'disputed→completed': {
    allowedRoles: ['arbitrator', 'system'],
    requiresEvidence: false,
    evidenceHint: '上传仲裁裁定书',
    description: '仲裁员完成裁定，释放资金给卖家（旧粗粒度）'
  },
  'disputed→cancelled': {
    allowedRoles: ['arbitrator', 'system'],
    requiresEvidence: false,
    evidenceHint: '上传仲裁裁定书',
    description: '仲裁裁定取消交易，全额退款给买家（旧粗粒度）'
  },

  // ── 仲裁结案细化（模块 B）─────────────────────────────────
  'disputed→resolved_for_seller': {
    allowedRoles: ['arbitrator', 'system'],
    requiresEvidence: false,
    description: '仲裁裁定卖家胜诉，资金释放给卖家'
  },
  'disputed→refunded_partial': {
    allowedRoles: ['arbitrator', 'system'],
    requiresEvidence: false,
    description: '仲裁裁定部分退款给买家'
  },
  'disputed→refunded_full': {
    allowedRoles: ['arbitrator', 'system'],
    requiresEvidence: false,
    description: '仲裁裁定全额退款给买家，订单作废'
  },
  'disputed→dispute_dismissed': {
    allowedRoles: ['arbitrator', 'system'],
    requiresEvidence: false,
    description: '争议被驳回（无效）'
  },

  // ── 超时通用兜底（system 触发）─────────────────────────────
  'paid→expired': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '订单超时自动失败（通用兜底）'
  },
  'accepted→expired': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '订单超时自动失败（通用兜底）'
  },

  // ── 正常完成 ──────────────────────────────────────────────
  'confirmed→completed': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '买家确认后系统自动结算，交易完成'
  },

  // ── 超时自动判责转移（system 触发）────────────────────────────
  // 这些转移不在正常操作流程里，只由 checkTimeouts 自动触发
  'created→fault_buyer': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '买家超时未付款，自动取消并标记违约'
  },
  'paid→fault_seller': {
    // RFC-007 stage 2：除 system 超时判责外,允许 seller 【主动拒单】(decline) 显式触发此转移。
    //   主动拒单 = 卖家明确不接此单(vs 沉默超时),记 decline_reason_code + declined_at。
    //   stage 2 一律走违约路径(与超时同结算);stage 3 auto-verify 上线后,客观无责拒单将改判 declined_nofault。
    allowedRoles: ['system', 'seller'],
    requiresEvidence: false,
    description: '卖家未接单：system 超时判责 或 seller 主动拒单(decline),退款买家并按违约结算'
  },
  'accepted→fault_seller': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '卖家超时未发货，自动退款并标记违约'
  },
  'shipped→fault_logistics': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '物流超时未揽收，标记物流违约'
  },
  'picked_up→fault_logistics': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '物流超时未投递，标记物流违约'
  },
  'in_transit→fault_logistics': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '物流超时未投递，标记物流违约'
  },

  // ── PR-B:undeliverable/拒收收口(fault-neutral + 证据裁决)────────────────────────────
  //   卖家/物流举证"未派送成功"(送到订单快照 shipping_address 却退回/拒收)→ delivery_failed。
  //   证据锚 = 快照地址(买家自己的输入):发到该地址退回=买家责任;发到别处/无证据=卖家责任。
  //   绝不自动判任何一方:卖家【不作为】仍走既有 delivery_deadline→fault_logistics(卖家兜底),不翻转成自动判买家。
  'shipped→delivery_failed': {
    allowedRoles: ['seller', 'logistics'],
    requiresEvidence: true,
    evidenceHint: '承运商"无法投递/拒收"通知 或 投递尝试证明,须引用订单 on-file 快照收货地址',
    description: '卖家/物流举证未派送成功(发到快照地址退回/拒收)→ 证据裁决,买家可在窗口内争议'
  },
  'picked_up→delivery_failed': {
    allowedRoles: ['seller', 'logistics'],
    requiresEvidence: true,
    evidenceHint: '承运商"无法投递/拒收"通知 或 投递尝试证明,须引用订单 on-file 快照收货地址',
    description: '卖家/物流举证未派送成功 → 证据裁决'
  },
  'in_transit→delivery_failed': {
    allowedRoles: ['seller', 'logistics'],
    requiresEvidence: true,
    evidenceHint: '承运商"无法投递/拒收"通知 或 投递尝试证明,须引用订单 on-file 快照收货地址',
    description: '卖家/物流举证未派送成功 → 证据裁决'
  },
  // 买家窗口内不争议 → 落定买家责任(证据未被反驳)。锚 delivery_failed_deadline(PR-B1 列,ISO)。
  'delivery_failed→fault_buyer': {
    allowedRoles: ['system'],
    deadlineField: 'delivery_failed_deadline',
    requiresEvidence: false,
    autoFaultState: 'fault_buyer',
    faultParty: 'buyer',
    description: 'PR-B:买家未在窗口内争议 → 未派送成功落定为买家责任(direct_p2p=仅声誉;escrow=B3 成本扣除)'
  },
  // 买家反证(卖家发错/未发)→ 进仲裁(复用现有 dispute/arbitration,三方按证据定责)。
  //   B2 仅 buyer 反证;卖家"主张货丢/弃货求全额没收"依赖 escrow 没收机制,属 B3,届时再放开 seller。
  'delivery_failed→disputed': {
    allowedRoles: ['buyer'],
    requiresEvidence: true,
    evidenceHint: '证明卖家发到错误地址/未发货(对比订单快照收货地址)',
    description: 'PR-B:买家争议未派送成功裁定 → 人工仲裁,按证据定责(卖家货丢主张走 return_pending→disputed)'
  },
  // ── PR-B3b:escrow 轨的货物返还持有态(护栏 B2)──────────────────────────────────────
  //   escrow 在争议窗口过期时【不能】直接 fault_buyer 结算(货物去向未知,escrow 该退多少未定)→ 进
  //   return_pending 持有:escrow 保持锁定,等三选一收口。direct_p2p 不经此态(无托管,B2 路径不变)。
  'delivery_failed→return_pending': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: 'PR-B3b:escrow 单争议窗口过期(买家责任已定)→ 持有 escrow 等货物返还确认(卖家确认收货窗口 goods_return_deadline 起算)'
  },
  // 收口①卖家确认收货(带 return-tracking + 实际退程运费)→ 成本扣除结算;②窗口过期卖家未确认 → 默认
  // 全款退买家(放弃扣除)。两者都在 checkTimeouts / confirm_return_received 的原子块内先结算再转移。
  'return_pending→completed': {
    allowedRoles: ['system'],
    deadlineField: 'goods_return_deadline',
    requiresEvidence: false,
    autoFaultState: 'completed',   // 超时=默认退买家全款(非判责;checkTimeouts 专属分支处理,绝不走 settleFault)
    faultParty: 'system',
    description: 'PR-B3b:货物返还收口 → 结算(卖家确认=成本扣除;超时未确认=默认全款退买家)'
  },
  // 收口③卖家主张货丢/弃货 → 仲裁(裁 release_seller=全额归卖家;唯一可达全额没收的路径,绝非自动)。
  'return_pending→disputed': {
    allowedRoles: ['seller'],
    requiresEvidence: true,
    evidenceHint: '货丢/弃货主张:承运商遗失证明/退回件拒收记录等(仲裁裁定后才全额没收,自动路径永不没收)',
    description: 'PR-B3b:卖家主张货丢/弃货 → 人工仲裁(release_seller=全额归卖家;买家可应诉)'
  },

  // ── RFC-007 stage 5：客观拒单仲裁翻案 ─────────────────────────────
  //   临时判责(fault_seller + decline_objective_pending)经【人工仲裁】认定客观无责 → declined_nofault。
  'fault_seller→declined_nofault': {
    allowedRoles: ['arbitrator', 'system'],
    requiresEvidence: false,
    description: 'RFC-007：客观拒单经人工仲裁认定无责 → 翻案为无责拒单(全退买家+退卖家质押,零罚没)'
  },
  'declined_nofault→completed': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: 'RFC-007：无责拒单结算完成(买家全额退款,卖家质押全退,无罚没无佣金)'
  },

  // ── 判责后的处置结算 ─────────────────────────────────────────
  'fault_seller→completed': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '卖家违约：退款买家，扣除卖家质押'
  },
  'fault_logistics→completed': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '物流违约：从物流质押池赔付'
  },
  'fault_buyer→completed': {
    allowedRoles: ['system'],
    requiresEvidence: false,
    description: '买家违约：资金转给卖家，扣除买家质押'
  },
}

/** 给定当前状态，返回「当前应该由谁来操作」（market-fulfill 默认表） */
export const CURRENT_RESPONSIBLE: Record<string, UserRole> = {
  created:    'buyer',       // 等买家付款
  paid:       'seller',      // 等卖家接单
  accepted:   'seller',      // 等卖家发货
  shipped:    'logistics',   // 等物流揽收
  picked_up:  'logistics',   // 等物流投递
  in_transit: 'logistics',   // 等物流投递
  delivered:  'buyer',       // 等买家确认
  delivery_failed: 'buyer',  // PR-B:等买家在窗口内争议(否则落定买家责任)
  return_pending: 'seller',  // PR-B3b:等卖家确认收到退回货物(超时=默认全款退买家)
  disputed:   'arbitrator',  // 等仲裁处理
  direct_pay_window:          'buyer',   // Rail1: 等买家付款并标记
  direct_expired_unconfirmed: 'buyer',   // Rail1: 等买家确认未付 或 升级争议
  payment_query:              'buyer',   // Rail1: 卖家报未收款,等买家协商响应(取消/主张已付)
  pending_accept:             'seller',  // 手动接单:等卖家确认接单(超时无责取消)
}

/** Phase 1 self-fulfill 覆盖表：seller 一人承担 shipped/picked_up/in_transit 全程 */
export const CURRENT_RESPONSIBLE_SELF_FULFILL: Record<string, UserRole> = {
  ...CURRENT_RESPONSIBLE,
  shipped:    'seller',
  picked_up:  'seller',
  in_transit: 'seller',
}

// ─── RFC-011 §① 实体语义:订单状态机契约(doc=code,从 VALID_TRANSITIONS 生成)───────────
// 状态【含义】是 authored(枚举注释无法运行时取);转移由 VALID_TRANSITIONS 生成(零漂移)。
// 覆盖锁:tests/test-order-lifecycle-contract.ts 断言每个 OrderStatus 有含义 + 每条转移被序列化。
export const ORDER_STATE_MEANINGS: Record<OrderStatus, { zh: string; en: string }> = {
  created:             { zh: '已下单,等待买家付款', en: 'placed, awaiting buyer payment' },
  paid:                { zh: '资金已托管(escrow),等待卖家接单', en: 'funds in escrow, awaiting seller acceptance' },
  accepted:            { zh: '卖家已接单,承诺履约', en: 'seller accepted, committed to fulfil' },
  shipped:             { zh: '卖家已交物流/自履行发出', en: 'handed to logistics / self-fulfil dispatched' },
  picked_up:           { zh: '物流已揽收', en: 'picked up by logistics' },
  in_transit:          { zh: '运输中', en: 'in transit' },
  delivered:           { zh: '已投递,等待买家确认', en: 'delivered, awaiting buyer confirmation' },
  delivery_failed:     { zh: 'PR-B:卖家/物流举证未派送成功(退回/拒收),等买家在窗口内争议;不争议则落定买家责任', en: 'PR-B: seller/logistics evidenced failed delivery (returned/refused), awaiting buyer contest; no contest → buyer fault' },
  return_pending:      { zh: 'PR-B3b:escrow 单买家责任已定,escrow 保持锁定等货物返还;卖家确认收货→成本扣除退余款,超时未确认→默认全款退买家,货丢主张→仲裁', en: 'PR-B3b: buyer fault established on escrow order; escrow held pending goods return — seller confirms receipt → cost-deducted refund; seller silent past window → full refund to buyer; loss claim → arbitration' },
  confirmed:           { zh: '买家确认收货 → 触发结算', en: 'buyer confirmed → triggers settlement' },
  disputed:            { zh: '争议中,等待人工仲裁', en: 'in dispute, awaiting human arbitration' },
  completed:           { zh: '交易完成,资金已分配(终态)', en: 'completed, funds settled (terminal)' },
  cancelled:           { zh: '已取消(终态)', en: 'cancelled (terminal)' },
  fault_buyer:         { zh: '买家违约(支付超时未付,或未派送成功经证据裁定;结算 → completed)', en: 'buyer fault (payment timeout, or undeliverable adjudicated; settles → completed)' },
  fault_seller:        { zh: '卖家违约(超时未接/发 或 主动拒单)', en: 'seller fault (accept/ship timeout or active decline)' },
  fault_logistics:     { zh: '物流违约', en: 'logistics fault' },
  declined_nofault:    { zh: '卖家无责拒单裁定(仲裁认定客观),待系统结算 → completed;全退买家+退卖家质押,零罚没', en: 'seller no-fault decline (arbitration-cleared), pending system settlement → completed; full refund + stake returned, no forfeit' },
  resolved_for_seller: { zh: '仲裁裁卖家胜诉,资金释放(终态)', en: 'arbitration ruled for seller, funds released (terminal)' },
  refunded_partial:    { zh: '仲裁裁部分退款(终态)', en: 'arbitration partial refund (terminal)' },
  refunded_full:       { zh: '仲裁裁全额退款,订单作废(终态)', en: 'arbitration full refund, order voided (terminal)' },
  dispute_dismissed:   { zh: '争议被驳回(无效,终态)', en: 'dispute dismissed (terminal)' },
  expired:             { zh: '订单超时自动失败(通用兜底,终态)', en: 'order expired (generic timeout, terminal)' },
  direct_pay_window:           { zh: 'Rail1 直付:已质押平台费,等买家付款(协议不持货款)', en: 'Rail1 direct-pay: fee-staked, awaiting buyer off-protocol payment (protocol holds no funds)' },
  direct_expired_unconfirmed:  { zh: 'Rail1 直付:付款窗口超时未标记(不静默关单,留争议/确认窗口)', en: 'Rail1 direct-pay: payment window expired unmarked (not silently closed; dispute/confirm window open)' },
  payment_query:               { zh: 'Rail1 直付:卖家报未收货款,双方协商中(非仲裁;暂停履约)', en: 'Rail1 direct-pay: seller reported non-receipt, buyer↔seller negotiating (not arbitration; fulfillment paused)' },
  pending_accept:              { zh: '手动接单:等待卖家确认接单(付款前;直付轨此阶段不展示收款信息,超时无责取消)', en: 'manual accept: awaiting seller acceptance (pre-payment; direct-pay hides payment info at this stage; times out to no-fault cancel)' },
}

/** 订单/争议生命周期契约 —— 集成方 agent 读它即懂"订单怎么流转 + 每步谁驱动 + 何时 + 含义"。 */
export function orderLifecycleContract(): {
  entity: string; note: string
  states: Array<{ state: string; zh: string; en: string; responsible: UserRole | null; terminal: boolean }>
  transitions: Array<{ from: string; to: string; allowed_roles: UserRole[]; deadline_field: string | null; requires_evidence: boolean; auto_fault_state: string | null; description: string }>
} {
  const keys = Object.keys(VALID_TRANSITIONS)
  const states = (Object.keys(ORDER_STATE_MEANINGS) as OrderStatus[]).map(s => ({
    state: s, zh: ORDER_STATE_MEANINGS[s].zh, en: ORDER_STATE_MEANINGS[s].en,
    responsible: CURRENT_RESPONSIBLE[s] ?? null,
    terminal: !keys.some(k => k.startsWith(s + '→')),   // 无出边 = 终态
  }))
  const transitions = Object.entries(VALID_TRANSITIONS).map(([key, t]) => {
    const arrow = key.indexOf('→')
    return {
      from: key.slice(0, arrow), to: key.slice(arrow + 1),
      allowed_roles: t.allowedRoles, deadline_field: t.deadlineField ?? null,
      requires_evidence: !!t.requiresEvidence, auto_fault_state: t.autoFaultState ?? null,
      description: t.description,
    }
  })
  return {
    entity: 'order',
    note: 'Order/dispute lifecycle, generated from the protocol state machine (VALID_TRANSITIONS) — doc=code. State changes are observable via the event stream (§⑥ GET /api/agent/events) and integrity-verifiable via the signed chain (§⑤ GET /api/orders/:id/chain).',
    states, transitions,
  }
}
