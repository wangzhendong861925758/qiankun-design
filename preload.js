// 预加载脚本：向渲染进程暴露安全的 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mochi', {
  // 应用信息与自动更新
  appInfo: () => ipcRenderer.invoke('app:info'),
  checkUpdate: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdaterEvent: (channel, cb) => ipcRenderer.on('updater:' + channel, (e, d) => cb(d)),

  // TTS 配音（返回 base64，由渲染层上传到协作服务）
  ttsGenerate: (opts) => ipcRenderer.invoke('tts:generate', opts),

  // 视频合成（480P 固定）
  composeVideo: (spec) => ipcRenderer.invoke('video:compose', spec),
  onComposeProgress: (cb) => ipcRenderer.on('compose:progress', (e, d) => cb(d)),

  // 本地备份
  backupSave: (key, data) => ipcRenderer.invoke('backup:save', { key, data }),

  // 内嵌协作服务（管理端）
  serverStart: (port) => ipcRenderer.invoke('server:start', { port }),
  serverStop: () => ipcRenderer.invoke('server:stop'),
  serverStatus: () => ipcRenderer.invoke('server:status'),

  // 系统
  showInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  openExternal: (u) => ipcRenderer.invoke('shell:open', u)
});
