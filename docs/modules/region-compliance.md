# Region Compliance — 地区合规分润层级

WebAZ 全球市场，不同地区监管规则不同：分润超过 N 级常被认定为
传销 / 金字塔骗局。我们采用 `region_config` 表 + 自动降级机制。

## 现状

| Region | max_levels | 依据 |
|---|---|---|
| `china` | 2 | 直销条例 / 反传销条例（3 级以上违法） |
| `us` | 2 | FTC 严格审查 multi-level commission |
| `eu` | 2 | 多数成员国 / EU 消法保守 |
| `india` | 2 | Direct Selling Rules 2021 |
| `global_north` | 3 | 其他 OECD 发达地区 |
| `global` | 3 | 默认兜底（无明确限制地区） |

`region_config.active = 1` 才生效。Admin 可禁用某地区（暂停接入）。

## 运行时路径

### 注册（users.region 必填）

```
POST /api/register { name, role, region: 'china' }
   ↓
users.region = 'china'
   ↓
后续 settleCommission 按该 region 的 max_levels 路由
```

### 旧账户补设

```
POST /api/profile/region { region: 'us' }
   ↓
users.region = 'us'
```

### Commission 结算

`settleCommission()` 读 buyer.region → region_config.max_levels：

- max_levels = 2 → L3 commission 流向 `sys_protocol` 协议池（不发给 L3 受益人）
- max_levels = 3 → L1 / L2 / L3 都发

`fund_deposits.amount_l3` 字段语义已扩为「commission 端回流总额」（含
区域 max_levels<3 截留 + 全员 verified gate 未通过截留）。

## UI 适配

### `getMaxLevels()` 客户端 helper

```js
const REGION_2_LEVELS = new Set(['china', 'us', 'eu', 'india'])
function getMaxLevels() {
  const r = state.user?.region || 'global'
  return REGION_2_LEVELS.has(r) ? 2 : 3
}
```

### L3 条件渲染

- `renderPromoter` 团队分享：max=3 → 4 列 L1/L2/L3/总计 + 3 列 L1 70%/L2 20%/L3 10%；max=2 → 3 列 L1/L2/总计 + 2 列 L1/L2
- `renderWallet` 收入构成：同上

切换地区后即时重渲，不需要重启 / 重登录。

## 卖家文案适配

避免硬编码 `70/20/10`，改为：

- "分享分润 多级（按地区合规自动拆分）"
- "分享成交拿 commission（分润多级，按地区合规自动拆分）"

## 注册地区选择 UI

`renderLogin` 注册 tab 加 region 选择器（6 选项，必填）：

```html
<select id="inp-region">
  <option value="">请选择…</option>
  <option value="china">🇨🇳 中国</option>
  <option value="us">🇺🇸 美国</option>
  <option value="eu">🇪🇺 欧盟</option>
  <option value="india">🇮🇳 印度</option>
  <option value="global_north">🌏 其他发达地区</option>
  <option value="global">🌐 其他地区</option>
</select>
```

不向用户展示"决定分润最大层级（合规要求）"等平台运营文本。

## 资料页随时切换

`/profile` 偏好卡片 加 🌍 国家 / 地区 dropdown，紧邻语言切换。
旧账户（无 region）显示「未设置 — 请选择」红字提示。

## 未来扩展

- **跨境订单**：buyer.region vs seller.region 不一致时，按更严格的 max_levels 应用
- **更细分**：US-CA / US-FL 等州一级（FTC + 州法）
- **动态合规更新**：region_config 可热更新（admin endpoint）
