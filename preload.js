// 预加载脚本：向渲染进程暴露安全的 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mochi', {
  // AI
  aiCall: (messages, jsonMode) => ipcRenderer.invoke('ai:call', { messages, jsonMode }),
  aiParseScript: (script, existingAssets) => ipcRenderer.invoke('ai:parseScript', { script, existingAssets }),
  aiGenImage: (prompt, aspect) => ipcRenderer.invoke('ai:genImage', { prompt, aspect }),
  aiGenShotVideo: (shot, project) => ipcRenderer.invoke('ai:genShotVideo', { shot, project }),

  // 配置
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),

  // 项目
  loadProject: () => ipcRenderer.invoke('project:load'),
  saveProject: (p) => ipcRenderer.invoke('project:save', p),

  // 文件
  pickFile: (filters) => ipcRenderer.invoke('dialog:pickFile', { filters }),
  readAsBase64: (p) => ipcRenderer.invoke('file:readAsBase64', p),
  saveAsset: (name, dataBase64) => ipcRenderer.invoke('file:saveAsset', { name, dataBase64 }),
  showInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),

  // TTS
  ttsVoices: () => ipcRenderer.invoke('tts:voices'),
  ttsGenerate: (text, voice, rate, pitch) => ipcRenderer.invoke('tts:generate', { text, voice, rate, pitch }),

  // 视频
  composeVideo: (project) => ipcRenderer.invoke('video:compose', { project }),
  onVideoProgress: (cb) => ipcRenderer.on('video:progress', (e, d) => cb(d)),

  // 应用信息与自动更新
  appInfo: () => ipcRenderer.invoke('app:info'),
  checkUpdate: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdaterEvent: (channel, cb) => ipcRenderer.on('updater:' + channel, (e, d) => cb(d))
});
