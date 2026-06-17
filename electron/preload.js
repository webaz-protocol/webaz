// Preload — 在 renderer 启动前注入安全的 contextBridge
// 当前留空 hook；未来可暴露 native notification / 本地文件 serving / auto-start 等

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('webazDesktop', {
  isDesktop: true,
  // 仅暴露白名单事件，避免 renderer 触达 node API
  onTrayCommand: (cb) => ipcRenderer.on('tray-cmd', (_e, cmd) => cb(cmd)),
  // 后续可加：showNativeNotification / openDataDir / setAutoLaunch
})
