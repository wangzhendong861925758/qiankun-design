// 乾坤设计 - 主进程
// 负责：窗口管理、TTS配音、FFmpeg视频合成(480P限制)、协作服务内嵌启动、本地备份、自动更新
'use strict';
const { app, BrowserWindow, ipcMain, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const DATA_DIR = path.join(app.getPath('userData'), 'data');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const SEGS_DIR = path.join(DATA_DIR, 'segs');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
[DATA_DIR, EXPORT_DIR, SEGS_DIR, BACKUP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

let mainWindow = null;

// ---------- 本地文件协议（导出成片/分镜片段预览） ----------
protocol.registerSchemesAsPrivileged([{ scheme: 'mochi-file', privileges: { bypassCSP: true, stream: true } }]);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560, height: 940, minWidth: 1180, minHeight: 720,
    title: '乾坤设计',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      webSecurity: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
app.whenReady().then(() => {
  protocol.handle('mochi-file', request => {
    const u = new URL(request.url);
    // 形如 mochi-file://exports/xxx.mp4 或 mochi-file://segs/xxx.mp4
    const parts = decodeURIComponent(u.pathname.replace(/^\//, '')).split('/');
    const sub = parts[0] || 'exports';
    const rest = parts.slice(1).join('/');
    const base = { exports: EXPORT_DIR, segs: SEGS_DIR }[sub] || EXPORT_DIR;
    const file = path.normalize(path.join(base, rest));
    if (!file.startsWith(base)) return new Response('forbidden', { status: 403 });
    return net.fetch('file:///' + file.replace(/\\/g, '/'));
  });
  createWindow();
  initUpdater();
  // 自动启动内嵌协作服务（本机即服务器，避免"先登录才能开服务"的死循环）
  autoStartServer();
});
function autoStartServer() {
  (async () => {
    for (const port of [3210, 3211, 3212, 3213]) {
      try {
        const { createServer } = require('./server');
        const dir = path.join(app.getPath('userData'), 'server-data');
        const inst = createServer(dir, port);
        await inst.ready;   // 等端口真正监听成功（listen 异步失败会 reject，如端口被占/被系统保留）
        embedded = inst;
        console.log('内嵌协作服务已自动启动: http://localhost:' + port);
        break;
      } catch (e) {
        embedded = null; // 端口被占用/被保留 → 尝试下一个
        console.warn('端口 ' + port + ' 启动失败，尝试下一个：' + (e && e.code || e.message));
      }
    }
    if (!embedded) console.warn('内嵌协作服务启动失败：3210-3213 端口均不可用');
  })();
}
app.on('window-all-closed', () => app.quit());

// ---------- 工具 ----------
function downloadTo(url, dest) {
  return net.fetch(url).then(r => {
    if (!r.ok) throw new Error('下载失败(' + r.status + '): ' + url);
    return r.arrayBuffer();
  }).then(buf => { fs.writeFileSync(dest, Buffer.from(buf)); return dest; });
}
const DIMS = { '16:9': { w: 854, h: 480 }, '9:16': { w: 480, h: 854 }, '1:1': { w: 480, h: 480 }, '4:3': { w: 640, h: 480 } }; // 用户端统一480P

// ---------- TTS 配音（本地生成 → base64 返回，由渲染层上传到协作服务共享） ----------
ipcMain.handle('tts:generate', async (e, { text, voice, rate, pitch }) => {
  const MsTTS = require('msedge-tts').MsEdgeTTS;
  const out = path.join(require('os').tmpdir(), 'qk-tts-' + Date.now() + '.mp3');
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice || 'zh-CN-XiaoxiaoNeural', rate || '+0%', pitch || '+0Hz');
  await tts.toFile(out, text || '');
  const b64 = fs.readFileSync(out).toString('base64');
  const duration = await getAudioDuration(out);
  return { dataBase64: b64, duration };
});
function getAudioDuration(file) {
  return new Promise(resolve => {
    execFile(ffmpegPath, ['-i', file, '-f', 'null', '-'], { timeout: 60000 }, (err, stdout, stderr) => {
      const m = String(stderr || '').match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m) resolve(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]));
      else resolve(0);
    });
  });
}

// ---------- 单镜片段合成（480P）：整片合成与"视频"列单镜生成共用 ----------
async function buildSegment(ctx, sh, i) {
  const { dim, aspect, serverBase, token, videoModelId, projectId, tmp, report } = ctx;
  report('准备素材：' + (sh.text || '').slice(0, 18));
  // 1) 画面来源：视频模型 > 首帧/分镜图
  let videoFile = null;
  if (videoModelId && serverBase) {
    const body = JSON.stringify({
      projectId, modelId: videoModelId, prompt: sh.videoPrompt || '', aspect,
      firstFrame: sh.firstImgUrl || undefined, lastFrame: sh.lastImgUrl || undefined
    });
    const r = await net.fetch(serverBase.replace(/\/+$/, '') + '/api/ai/video', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, { 'Authorization': 'Bearer ' + token }), body });
    const d = await r.json();
    if (!d.ok) throw new Error('分镜' + (i + 1) + ' 视频模型生成失败: ' + (d.error || ''));
    videoFile = await downloadTo(serverBase.replace(/\/+$/, '') + d.url, path.join(tmp, 'v' + i + '.mp4'));
  }
  // 2) 下载配音/音效/图片
  let voiceFile = null, sfxFile = null, imgFile = null;
  if (sh.voiceUrl) voiceFile = await downloadTo(sh.voiceUrl, path.join(tmp, 'a' + i + '.mp3'));
  if (sh.sfxUrl) sfxFile = await downloadTo(sh.sfxUrl, path.join(tmp, 's' + i + path.extname(sh.sfxUrl.split('?')[0]).slice(0, 5)));
  const imgUrl = videoFile ? null : (sh.firstImgUrl || sh.storyboardImgUrl || sh.lastImgUrl);
  if (imgUrl) imgFile = await downloadTo(imgUrl, path.join(tmp, 'i' + i + '.png'));
  if (!videoFile && !imgFile) throw new Error('分镜' + (i + 1) + ' 缺少画面（请生成分镜图或配置视频模型）');
  // 3) 音频时长
  let voiceDur = 0, sfxDur = 0;
  if (voiceFile) voiceDur = await getAudioDuration(voiceFile);
  if (sfxFile) sfxDur = await getAudioDuration(sfxFile);
  const dur = Math.max(videoFile ? 0 : 2.2, voiceDur + 0.4, sh.duration ? Math.min(sh.duration, 60) : 0, videoFile ? 4 : 0);
  // 4) 合成单镜片段（480P）
  report('合成片段');
  const seg = path.join(SEGS_DIR, sh.id + '.mp4');
  const af = [];
  if (voiceFile) af.push({ f: voiceFile, d: voiceDur, vol: '1.0' });
  if (sfxFile) af.push({ f: sfxFile, d: sfxDur, vol: '0.6' });
  const hasAudio = af.length > 0;
  // 字幕文本
  const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019").replace(/\n/g, ' ');
  const subText = sh.dialogue ? (sh.speaker ? esc(sh.speaker) + '：' : '') + esc(sh.dialogue) : '';
  // 输入序列：[0]=视频或图片，后续=音频；无音频时追加 lavfi 静音源
  const inputs = [];
  if (videoFile) inputs.push('-i', videoFile);
  else inputs.push('-loop', '1', '-t', String(dur), '-i', imgFile);
  af.forEach(a => inputs.push('-i', a.f));
  if (!hasAudio) inputs.push('-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=44100:cl=stereo');
  // 滤镜
  const fcParts = [];
  if (videoFile) {
    fcParts.push(`[0:v]scale=${dim.w}:${dim.h}:force_original_aspect_ratio=increase,crop=${dim.w}:${dim.h},fps=30,setsar=1,tpad=stop_mode=clone:stop_duration=${Math.max(dur, 0.1).toFixed(2)}[vmain]`);
  } else {
    fcParts.push(`[0:v]scale=${dim.w}:${dim.h}:force_original_aspect_ratio=increase,crop=${dim.w}:${dim.h},fps=30,setsar=1,format=yuv420p[vmain]`);
  }
  if (subText) {
    fcParts.push(`[vmain]drawtext=text='${subText}':fontfile='C\\:/Windows/Fonts/msyh.ttc':fontsize=${aspect === '16:9' ? 26 : 30}:fontcolor=white:borderw=2:bordercolor=black:box=1:boxcolor=black@0.35:boxborderw=12:x=(w-text_w)/2:y=h-th-52[vout]`);
  } else { fcParts.push('[vmain]null[vout]'); }
  let audioMap;
  if (hasAudio) {
    af.forEach((a, j) => fcParts.push(`[${j + 1}:a]aresample=44100,apad,atrim=0:${Math.max(a.d + 0.5, dur).toFixed(2)},volume=${a.vol}[a${j}]`));
    fcParts.push(af.map((_, j) => `[a${j}]`).join('') + `amix=inputs=${af.length}:normalize=0,atrim=0:${dur.toFixed(2)}[aout]`);
    audioMap = '[aout]';
  } else {
    audioMap = af.length + ':a'; // lavfi 输入索引（= 输入总数-1，视频0 + 音频们 + lavfi）
  }
  const args = [...inputs, '-filter_complex', fcParts.join(';'),
    '-map', '[vout]', '-map', audioMap,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-t', String(dur), '-y', seg];
  await new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: 300000, maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      if (err) reject(new Error('FFmpeg片段失败: ' + String(stderr || err.message).slice(-400))); else resolve();
    });
  });
  return { id: sh.id, path: seg, duration: dur, text: sh.text, dialogue: sh.dialogue, index: i };
}

// ---------- 整片合成（480P） ----------
ipcMain.handle('video:compose', async (e, spec) => {
  const { name, aspect, shots, serverBase, token, videoModelId } = spec;
  const dim = DIMS[aspect] || DIMS['9:16'];
  const tmp = path.join(require('os').tmpdir(), 'qk-compose-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  const segs = [];
  try {
    for (let i = 0; i < shots.length; i++) {
      const seg = await buildSegment(
        { dim, aspect, serverBase, token, videoModelId, projectId: spec.projectId, tmp, report: t => reportProgress(i, shots.length, t + ' ' + (i + 1) + '/' + shots.length) },
        shots[i], i);
      segs.push(seg);
    }
    // 拼接
    reportProgress(shots.length, shots.length, '拼接成片…');
    const listFile = path.join(tmp, 'list.txt');
    fs.writeFileSync(listFile, segs.map(s => "file '" + s.path.replace(/\\/g, '/') + "'").join('\n'), 'utf-8');
    const finalName = (name || '乾坤设计') + '-' + Date.now() + '.mp4';
    const finalPath = path.join(EXPORT_DIR, finalName);
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', finalPath],
        { timeout: 300000 }, (err, stdout, stderr) => {
          if (err) reject(new Error('拼接失败: ' + String(stderr || err.message).slice(-300))); else resolve();
        });
    });
    const total = segs.reduce((s, x) => s + x.duration, 0);
    return { ok: true, path: finalPath, name: finalName, duration: total, url: 'mochi-file://exports/' + encodeURIComponent(finalName), segments: segs.map(s => ({ id: s.id, index: s.index, duration: s.duration, url: 'mochi-file://segs/' + path.basename(s.path) })) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
  }
});

// ---------- 单镜视频生成（编辑器"视频"列，480P） ----------
ipcMain.handle('video:genShot', async (e, spec) => {
  const { shot, aspect, serverBase, token, videoModelId, projectId } = spec;
  const dim = DIMS[aspect] || DIMS['9:16'];
  const tmp = path.join(require('os').tmpdir(), 'qk-shot-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  try {
    reportProgress(0, 1, '生成单镜视频…');
    const seg = await buildSegment({ dim, aspect, serverBase, token, videoModelId, projectId, tmp, report: t => reportProgress(0, 1, t) }, shot, 0);
    return { ok: true, path: seg.path, duration: seg.duration, url: 'mochi-file://segs/' + encodeURIComponent(path.basename(seg.path)) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
  }
});
function reportProgress(cur, total, text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('compose:progress', { cur, total, text });
  }
}

// ---------- 本地自动备份（防崩溃丢数据：服务端为第一存储，本地为兜底） ----------
ipcMain.handle('backup:save', (e, { key, data }) => {
  try {
    const file = path.join(BACKUP_DIR, String(key || 'x').replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
    fs.writeFileSync(file, JSON.stringify({ time: Date.now(), data }));
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

// ---------- 内嵌协作服务（管理员本机一键启动） ----------
let embedded = null;
ipcMain.handle('server:start', async (e, { port }) => {
  if (embedded) return { ok: true, already: true, port: embedded.port };
  try {
    const { createServer } = require('./server');
    const dir = path.join(app.getPath('userData'), 'server-data');
    embedded = createServer(dir, parseInt(port || '3210', 10) || 3210);
    return { ok: true, port: embedded.port };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('server:stop', () => {
  if (embedded) { try { embedded.close(); } catch (e) { } embedded = null; }
  return { ok: true };
});
ipcMain.handle('server:status', () => {
  const nets = os.networkInterfaces();
  const ips = [];
  Object.keys(nets).forEach(k => (nets[k] || []).forEach(n => { if (n.family === 'IPv4' && !n.internal) ips.push(n.address); }));
  return { running: !!embedded, port: embedded ? embedded.port : null, ips, dataDir: embedded ? embedded.dataDir : path.join(app.getPath('userData'), 'server-data') };
});

// ---------- 应用信息 / 系统交互 ----------
ipcMain.handle('app:info', () => ({ version: app.getVersion(), isPackaged: app.isPackaged }));
ipcMain.handle('shell:showItem', (e, p) => { shell.showItemInFolder(p); return { ok: true }; });
ipcMain.handle('shell:open', (e, u) => { shell.openExternal(u); return { ok: true }; });

// ---------- 局域网服务器发现（UDP 探测） ----------
ipcMain.handle('lan:discover', async () => {
  const dgram = require('dgram');
  const ipToInt = ip => ip.split('.').reduce((s, x) => ((s << 8) + parseInt(x, 10)) >>> 0, 0);
  const intToIp = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  // 探测目标：受限广播 + 每个网卡的定向广播（多网卡环境必须逐网卡发送）
  const targets = new Set(['255.255.255.255']);
  const myIPs = new Set(['127.0.0.1']);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of (nets[name] || [])) {
      if (n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254')) {
        myIPs.add(n.address);
        if (n.netmask) {
          const bcast = intToIp((ipToInt(n.address) & ipToInt(n.netmask)) | (~ipToInt(n.netmask) >>> 0));
          if (bcast !== n.address) targets.add(bcast);
        }
      }
    }
  }
  return await new Promise((resolve) => {
    // 关键：绑定随机端口收发，不绑 3211（3211 已被本机服务器 UDP 占用，同机双 socket 会抢占数据包）
    const sock = dgram.createSocket({ type: 'udp4' });
    const found = new Map();
    let done = false;
    const finish = () => { if (done) return; done = true; try { sock.close(); } catch (e) {} resolve(Array.from(found.values())); };
    sock.on('error', () => finish());
    sock.on('message', (msg) => {
      try {
        const j = JSON.parse(msg.toString());
        if (j && j.app === 'qiankun-design' && j.http) {
          // 本机服务器 → 用 localhost 地址（绕开防火墙对局域网 IP 的拦截，连接更稳）
          // 并标记 isMine，供登录页扫描结果显示"（我的服务器）"
          if (j.ip && myIPs.has(j.ip)) { j.http = 'http://localhost:' + j.port; j.isMine = true; }
          found.set(j.http, j);
        }
      } catch (e) {}
    });
    sock.bind(() => {
      sock.setBroadcast(true);
      // 3 轮探测（间隔 800ms）防 UDP 丢包
      const probe = () => { for (const t of targets) { try { sock.send('QK_DISCOVER', 3211, t); } catch (e) {} } };
      probe();
      const t1 = setTimeout(probe, 800), t2 = setTimeout(probe, 1600);
      setTimeout(() => { clearTimeout(t1); clearTimeout(t2); finish(); }, 2500);   // 2.5 秒后收集完毕
    });
    setTimeout(finish, 3500);   // 兜底
  });
});

// ---------- 自动更新（修复：检查完必有反馈） ----------
let _updater = null;
function initUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', d => sendUp('available', { version: d && d.version }));
    autoUpdater.on('update-not-available', () => sendUp('not-available', {}));
    autoUpdater.on('download-progress', d => sendUp('progress', { percent: Math.round(d.percent || 0) }));
    autoUpdater.on('update-downloaded', d => sendUp('downloaded', { version: d && d.version }));
    autoUpdater.on('error', e => sendUp('error', { message: e && e.message }));
    _updater = autoUpdater;
    autoUpdater.checkForUpdates().catch(() => { });
  } catch (e) { }
}
function sendUp(ch, d) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updater:' + ch, d); }
ipcMain.handle('updater:check', async () => {
  if (!app.isPackaged) return { ok: false, dev: true, message: '开发模式不支持检查更新' };
  if (!_updater) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
      _updater = autoUpdater;
    } catch (e) { return { ok: false, message: '更新模块加载失败' }; }
  }
  try {
    const r = await _updater.checkForUpdates();
    const has = !!(r && r.isUpdateAvailable);
    return { ok: true, hasUpdate: has, version: r && r.updateInfo && r.updateInfo.version };
  } catch (e) { return { ok: false, message: String(e.message || e) }; }
});
ipcMain.handle('updater:install', () => {
  if (_updater) { try { _updater.quitAndInstall(); } catch (e) { } }
  return { ok: true };
});
