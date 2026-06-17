# WebAZ Desktop Companion

把 WebAZ PWA 套进 Electron 常驻进程 — 给重度卖家 / 仲裁员「永远在线节点」能力。

## 为什么

WebAZ 协议设计上承诺「卖家节点掉线时图片仍可拉、SNF 消息仍能转」，
但浏览器版有物理限制：
- 关 tab = 节点死
- 手机锁屏 ServiceWorker 必死
- 桌面 Chrome 也会"省电"切断长连接

桌面壳子解决这一切：
- ✅ 系统级常驻进程，不受 tab 生命周期影响
- ✅ 系统托盘，关窗口 ≠ 退出
- ✅ 单实例锁，多次点图标不会跑多份后端
- ✅ 后台保留 libp2p 连接 / SNF inbox 消息处理 / 图片 blob 服务

## 架构

```
electron/main.js   ─┬─→ spawn(tsx src/pwa/server.ts) → 子进程跑后端 :3000
                    ├─→ BrowserWindow loadURL('http://localhost:3000')
                    ├─→ Tray (close→minimize)
                    └─→ 单实例锁 + IPC bridge
electron/preload.js → contextBridge 暴露 webazDesktop API 给 PWA
```

后端逻辑 100% 复用既有 `src/pwa/server.ts`，桌面壳子只负责
「常驻 + 托盘 + native wrap」，**零业务代码重复**。

## 使用

### 开发

```bash
# 先装依赖（首次）
cd electron
npm install         # 装 electron + electron-builder

# 启动桌面版（会自动拉起后端 + 打开窗口）
npm start
```

### 打包发布

```bash
cd electron
npm run build:mac       # → dist/WebAZ-0.1.0.dmg
npm run build:win       # → dist/WebAZ Setup 0.1.0.exe
npm run build:linux     # → dist/WebAZ-0.1.0.AppImage
```

## 注意事项

- `electron-builder` 配置里 `extraResources` 把 `src/` 整个目录连同
  `node_modules/tsx` 和 `node_modules/better-sqlite3` 一起打入安装包，
  让 `tsx src/pwa/server.ts` 在用户机器上跑得起来
- `better-sqlite3` 是 native module，跨平台打包需先 `npm rebuild` 对应
  平台（参考 electron-builder 文档）
- 主仓 `package.json` 不引入 electron 依赖（避免污染 npm 包大小）；
  桌面版独立维护
- 用户数据 `~/.webaz/webaz.db` 与 PWA 版完全共享 — 同一台机器同一份数据

## 路线图

- [ ] 自启动（Auto-launch）开关
- [ ] 原生通知（替代 toast）
- [ ] 托盘动态显示 SNF 未读数 / 在线 peer 数
- [ ] 后台 fetch 外置存证锚的兜底验证
- [ ] 卖家自有节点 HTTP server（serve seller_node_url 路径）
