> **Code is Rule, Protocol is Trust.**
> **代码即规则，协议即信任。**
> — webaz

# WebAZ 文档总入口

> 按阅读顺序推荐 — 先理念后实施

---

## ⭐ 最高级共识（开发方向指引）

| 文档 | 用途 | 谁该读 |
|---|---|---|

**核心理念**：
- **OPC → COP 范式**：参与即建设，贡献可见
- **团队定位**：临时过渡执行者，目标是把治理权交还社区
- **终局**：全面 DAO + 团队"消失"在协议里

---

## 📘 项目入门

| 文档 | 用途 |
|---|---|
| [WHAT-IS-WEBAZ.md](WHAT-IS-WEBAZ.md) | 项目认知 — 是什么 / 能做什么（291 行） |

---

## 🛠 部署与运维

| 文档 | 用途 |
|---|---|
| [`.env.example`](../.env.example) | 22 个环境变量分 3 档 |

---

## 📚 模块技术文档

| 文档 | 用途 |
|---|---|
| [api-endpoints.md](api-endpoints.md) | 509 endpoint 目录（自动生成）|
| [`openapi.json`](../src/pwa/public/openapi.json) | OpenAPI 3.0（agent SDK import）|
| [PARTICIPATION-ATTRIBUTION-COMPLIANCE.md](PARTICIPATION-ATTRIBUTION-COMPLIANCE.md) | 33 国合规审计 |
| [modules/](modules/) | 11 个模块主题文档 |
| - [intent-driven-buy.md](modules/intent-driven-buy.md) | 协议级精准镜像搜索 |
| - [product-aliases.md](modules/product-aliases.md) | 商品 alias 系统 |
| - [products-api.md](modules/products-api.md) | 三种调用方分级 API |
| - [agent-reputation.md](modules/agent-reputation.md) | API key trust_score |
| - [rfq-auction-chat.md](modules/rfq-auction-chat.md) | RFQ + 拍卖 + 聊天 |
| - [claim-verification.md](modules/claim-verification.md) | 声明验证共识 |
| - [charity.md](modules/charity.md) | 慈善许愿 + 双匿名 |
| - [region-compliance.md](modules/region-compliance.md) | 地区差异化 |
| - [verifier-access-control.md](modules/verifier-access-control.md) | 审核员 ACL |
| - [nav-architecture.md](modules/nav-architecture.md) | 导航架构 |

---

## 📈 工作产出

| 文档 | 用途 |
|---|---|
| [`CHANGELOG.md`](../CHANGELOG.md) | 完整变更历史（v0.1.0 → v0.4.14）|

---

## 🎯 阅读路径推荐

### 第一次接触
2. WHAT-IS-WEBAZ.md（产品全景）
3. ../README.md（快速开始）

### 开发者
1. ⭐ VISION（先看哲学）
2. api-endpoints.md（API 目录）
3. modules/（模块技术文档）

### 部署运维
3. .env.example（环境变量）

### UX/产品
1. ⭐ VISION（理解 COP 模式）

### 治理/参与者
1. ⭐ VISION（团队自我约束）
2. PARTICIPATION-ATTRIBUTION-COMPLIANCE.md（合规边界）
3. modules/claim-verification.md（如何参与共识）

---

## 🛡 共识层级

```
  ↓
执行：CHANGELOG.md / api-endpoints.md（实现细节）
```

**冲突时**：以更高层为准。低层不能违反高层。
