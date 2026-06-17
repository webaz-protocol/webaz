// WebAZ Desktop Companion — Electron 主进程
//
// 解决浏览器版"tab 关闭 = peer 离线"的根本问题：
//   1. 进程常驻 → libp2p 节点 / SNF inbox / 图片 blob 永久可服务
//   2. 系统托盘 → close-to-tray 不退出
//   3. 单实例锁 → 多次双击图标不会跑出多份后端
//   4. 启动子进程跑 tsx src/pwa/server.ts → 复用现有 PWA 全部能力

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, Notification } = require('electron')
const path  = require('path')
const fs    = require('fs')
const { spawn } = require('child_process')
const http  = require('http')

const REPO_ROOT = path.resolve(__dirname, '..')
const SERVER_URL = 'http://localhost:3000'
const SERVER_READY_TIMEOUT_MS = 30_000

let mainWindow = null
let tray       = null
let serverProc = null
let isQuitting = false

// ─── 单实例锁 ─────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

// ─── 启动后端服务（复用既有 tsx server.ts）─────────────────────
function startServer() {
  if (serverProc) return
  console.log('[desktop] starting webaz server…')
  const env = { ...process.env, PORT: '3000' }
  // 优先用项目里的 tsx（避免依赖全局）
  const tsxPath = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
  const serverPath = path.join(REPO_ROOT, 'src/pwa/server.ts')
  serverProc = spawn(tsxPath, [serverPath], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc.stdout.on('data', d => process.stdout.write('[server] ' + d))
  serverProc.stderr.on('data', d => process.stderr.write('[server] ' + d))
  serverProc.on('exit', (code) => {
    console.log(`[desktop] server exited code=${code}`)
    if (!isQuitting && code !== 0) {
      // 异常退出 → 弹通知
      try {
        new Notification({ title: 'WebAZ', body: '后台服务异常退出，应用即将关闭' }).show()
      } catch {}
      setTimeout(() => { isQuitting = true; app.quit() }, 1500)
    }
  })
}

// 等待 server 就绪（poll :3000/api/products?limit=1 直到 200）
function waitServerReady() {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const probe = () => {
      const req = http.get(SERVER_URL + '/api/products?limit=1', { timeout: 1000 }, (res) => {
        if (res.statusCode === 200) { res.resume(); resolve(); return }
        res.resume()
        retry()
      })
      req.on('error', retry)
      req.on('timeout', () => { req.destroy(); retry() })
    }
    const retry = () => {
      if (Date.now() - started > SERVER_READY_TIMEOUT_MS) return reject(new Error('server_timeout'))
      setTimeout(probe, 500)
    }
    probe()
  })
}

// ─── 主窗口 ───────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 600,
    title: 'WebAZ',
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: getIconPath(),
  })

  mainWindow.loadURL(SERVER_URL).catch(err => console.error('[desktop] loadURL err', err))

  // close 拦截 → 隐藏到托盘而非真正退出
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
      // macOS dock 隐藏
      if (process.platform === 'darwin') app.dock?.hide()
    }
  })

  // 外链在系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(SERVER_URL)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  // 内部 nav 也拦截外链
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(SERVER_URL)) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })
}

// ─── 系统托盘 ─────────────────────────────────────────────────
function getIconPath() {
  // 优先 PNG（更稳），其次 SVG，最后 fallback 到 Electron 默认
  for (const p of [
    path.join(REPO_ROOT, 'src/pwa/public/icon-192.png'),
    path.join(__dirname, 'icon.png'),
    path.join(REPO_ROOT, 'src/pwa/public/icon.svg'),
  ]) if (fs.existsSync(p)) return p
  return null
}

function createTray() {
  const iconPath = getIconPath()
  let img = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  // 空 image (来自 SVG 加载失败) 会让 macOS 弹错；用 1px 透明 PNG 兜底
  if (img.isEmpty()) {
    img = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')
  }
  if (process.platform === 'darwin') {
    img = img.resize({ width: 18, height: 18 })
    img.setTemplateImage(true)
  } else {
    img = img.resize({ width: 16, height: 16 })
  }
  tray = new Tray(img)
  tray.setToolTip('WebAZ Desktop')
  const menu = Menu.buildFromTemplate([
    { label: '打开 WebAZ', click: showWindow },
    { type: 'separator' },
    { label: '在浏览器打开', click: () => shell.openExternal(SERVER_URL) },
    { label: '查看后端日志', click: () => mainWindow?.webContents.openDevTools({ mode: 'detach' }) },
    { type: 'separator' },
    { label: '退出 WebAZ', click: () => { isQuitting = true; app.quit() } },
  ])
  tray.setContextMenu(menu)
  tray.on('click', showWindow)
}

function showWindow() {
  if (!mainWindow) return
  if (process.platform === 'darwin') app.dock?.show()
  mainWindow.show()
  mainWindow.focus()
}

// ─── 应用生命周期 ─────────────────────────────────────────────
app.whenReady().then(async () => {
  startServer()
  try {
    await waitServerReady()
  } catch {
    console.error('[desktop] server never ready, opening anyway')
  }
  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showWindow()
  })
})

// Electron 不在 window-all-closed 事件传 event 参数（只有 before-quit / will-quit 才传）
// 之前 e.preventDefault() 调用在 undefined 上会 throw — 实际不可达（close-to-tray
// 拦截阻止了窗口真正销毁），但代码不规范。
// 修正：只有 isQuitting 时才走 app.quit；订阅本身就抑制默认"全部关闭即退出"行为
app.on('window-all-closed', () => {
  if (isQuitting) app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill('SIGTERM') } catch {}
  }
})
