# Widget i18n 实施规划(agent 卡片中/英,跨 agent)

> 目标:agent 内商品/报价/订单卡片按**用户语言**显示中文或英文。跨 agent(不止 ChatGPT)。
> 约束:不改匹配/钱路/Passkey/投影语义;走源码化+确定性构建+对抗审计;分批,每批独立 PR。
> 授权:对抗审计干净即自行合并部署(见记忆 standing-autonomy-audit-clean)。

## 1. 语言探测(能力探测瀑布,跨 agent)
新增 `webazLocale()`(放 compat-core,所有卡共享),**一次探测缓存**:
1. `window.openai.locale`(ChatGPT Apps SDK)—— 主信号;
2. `window.openai.userAgent?.locale` / 标准桥握手上下文若带 locale(SEP-1865 宿主)—— 次级(能力探测,缺失跳过);
3. `navigator.language`(iframe 浏览器兜底,任何宿主都有);
4. 默认 `'zh'`。
归一:值 `startsWith('en')`(大小写不敏感)→ `'en'`,否则 `'zh'`。theme 探测同款 try/catch,绝不抛。

## 2. 翻译机制:内联双语 `L(zh, en)`,不用 key 表
```
function L(zh, en){ return webazLocale()==='en' ? en : zh }
```
- **为什么内联而非 key 表**:322 串用 key 表极易漏键(en 缺条→显示 key 或空)。内联双语让**每个调用点两种语言并列**,漏译=编译期可见,杜绝错漏(Holden:避免错漏)。
- 带插值的模板双语化:如 `'约'+n+'天'` → `L('约'+n+'天', '~'+n+' days')`;`'共 '+N+' 命中'` → `L('共 '+N+' 命中','+'+N+' total')`。逐点给两版,不做字符串拼接猜译。
- 渲染仍全走 `el()`/textContent(锁不变);L() 只返回字符串。

## 3. 分批(每批 = 独立 PR → CI + 对抗审计 → 合并 → 部署)
- **批 0(地基,先行)**:i18n.ts→并入 compat-core:`webazLocale()` + `L()` + 本地化 compat-core 自身用户可见串(etaDisplay 的「约N天/暂未提供…」、webazCopy 的「已复制✓/已选中…」)。compat-core 共享 → **三张卡 hash 都变**(一次性,后续批各自独立)。
- **批 1**:product-results-body(最大面:排序条/精确匹配标注/展开·详情·准备下单·比较/报价面板/审批面板/前往WebAZ/取消/相关商品横幅/口令 recovery)。
- **批 2**:quote-approval-body(报价卡/审批卡各行标签/按钮/披露)。
- **批 3**:order-timeline-body + 收尾扫残留。

## 4. 每批的测试锁
- `test-widget-i18n`(新):对每张卡的 HTML,断言 `webazLocale`/`L(` 在场;并 vm-eval 渲染在 `locale='en'` 下**关键标签无 CJK**(如按钮/横幅),在 `locale='zh'` 下输出与本地化前**逐字不变**(zh 回归锁——保证中文用户零感知)。
- 现有 parity/锁:pins 前推、被换 hash 入 stale allowlist(窗口保留)、phase3b 断言随文案更新。
- 预算:widget HTML 是 iframe 资源不进模型上下文;但双语使 body 变大~1.5x,确认不触发任何字节锁(widget 无字节顶棚,tools/list 不含 widget)。

## 5. 不做 / 边界
- 服务端投影文案(recovery.note 等)已多为「en / 中文」双写,本轮**不动**(它是模型可读面,非卡片渲染面);
- 不引入 i18n 库(自包含 iframe,零外联);
- 不改 PWA(PWA 有独立 i18n);
- CJK 检测正则 `/[一-鿿]/` 仅用于测试断言,不进运行时。

## 6. 验收(全批完成后)
ChatGPT 英文界面用户 → 卡片全英文;中文用户 → 全中文且与今天逐字一致;其它 agent(navigator.language 兜底)→ 正确切换。真机各跑一遍。
