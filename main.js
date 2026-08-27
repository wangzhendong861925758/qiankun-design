// 乾坤设计 - 主进程
// 负责：窗口管理、AI调用(文本/图片/视频三模型)、TTS配音、FFmpeg视频合成、数据持久化、自动更新
const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

let mainWindow = null;

// ---------- 存储路径 ----------
const DATA_DIR = path.join(app.getPath('userData'), 'data');
const ASSETS_DIR = path.join(DATA_DIR, 'assets');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const PROJECT_FILE = path.join(DATA_DIR, 'project.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function ensureDirs() {
  [DATA_DIR, ASSETS_DIR, TMP_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));
}

// ---------- 自定义协议：渲染进程显示本地资源 ----------
// mochi-file://assets/xxx.png  ->  DATA_DIR/assets/xxx.png
function registerFileProtocol() {
  protocol.handle('mochi-file', (request) => {
    try {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.hostname + url.pathname);
      rel = rel.replace(/^\/+/, '');
      const filePath = path.normalize(path.join(DATA_DIR, rel));
      if (!filePath.startsWith(DATA_DIR)) {
        return new Response('Forbidden', { status: 403 });
      }
      return net.fetch('file:///' + filePath.replace(/\\/g, '/'));
    } catch (e) {
      return new Response('Bad Request', { status: 400 });
    }
  });
}

// ---------- 配置（v2：文本/图片/视频 三组独立模型） ----------
function emptyModelCfg() { return { baseUrl: '', apiKey: '', model: '' }; }
function loadConfig() {
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (e) { cfg = null; }
  const result = {
    text: Object.assign(emptyModelCfg(), (cfg && cfg.text) || {}),
    image: Object.assign(emptyModelCfg(), (cfg && cfg.image) || {}),
    video: Object.assign(emptyModelCfg(), (cfg && cfg.video) || {})
  };
  // 旧版单配置迁移到文本模型
  if (cfg && cfg.apiBaseUrl && !result.text.baseUrl) {
    result.text = { baseUrl: cfg.apiBaseUrl, apiKey: cfg.apiKey || '', model: cfg.apiModel || '' };
    if (cfg.imageModel) result.image = { baseUrl: cfg.apiBaseUrl, apiKey: cfg.apiKey || '', model: cfg.imageModel };
  }
  return result;
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ---------- 项目数据 ----------
function loadProject() {
  try {
    return JSON.parse(fs.readFileSync(PROJECT_FILE, 'utf-8'));
  } catch (e) {
    return null;
  }
}
function saveProject(project) {
  project.updatedAt = Date.now();
  fs.writeFileSync(PROJECT_FILE, JSON.stringify(project, null, 2), 'utf-8');
  return project;
}

// ---------- 工具 ----------
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function runFfmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { cwd: cwd || undefined, maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error('FFmpeg错误: ' + (stderr || err.message).slice(-1500)));
      } else {
        resolve(stdout);
      }
    });
  });
}

// 探测媒体信息（返回 { duration, hasAudio }）
async function probeMedia(file) {
  const out = await new Promise((resolve) => {
    execFile(ffmpegPath, ['-i', file], { maxBuffer: 1024 * 1024 * 16 }, (err, so, se) => resolve(se || ''));
  });
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  const duration = m ? (parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 100) : 0;
  const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(out);
  return { duration, hasAudio };
}
async function getAudioDuration(file) {
  return (await probeMedia(file)).duration;
}

// 从AI返回文本中提取JSON（容错：去掉```json包裹等）
function extractJSON(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const starts = [t.indexOf('{'), t.indexOf('[')].filter(i => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const endBrace = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start >= 0 && endBrace > start) {
    t = t.slice(start, endBrace + 1);
  }
  return JSON.parse(t);
}

// ---------- AI 通用调用（OpenAI 兼容 chat/completions） ----------
async function callAI(mc, messages, jsonMode) {
  if (!mc.baseUrl || !mc.model) {
    throw new Error('请先在「模型配置」中填写对应模型的 API 地址和模型名称');
  }
  const url = mc.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = { model: mc.model, messages, temperature: 0.3 };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const resp = await net.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(mc.apiKey ? { 'Authorization': 'Bearer ' + mc.apiKey } : {})
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('API请求失败 HTTP ' + resp.status + ': ' + t.slice(0, 500));
  }
  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('API返回为空: ' + JSON.stringify(data).slice(0, 300));
  return content;
}

ipcMain.handle('ai:call', async (event, { messages, jsonMode }) => {
  return callAI(loadConfig().text, messages, jsonMode);
});

// ---------- 剧本拆解（文本模型） ----------
ipcMain.handle('ai:parseScript', async (event, { script, existingAssets }) => {
  const sys = `你是一个专业的漫剧分镜师。把用户提供的剧本文本拆解为分镜列表。
规则：
1. 按叙事节奏拆分，每个分镜15~50字，台词单独提取
2. 识别每个分镜中出现的：人物(characters)、场景(scene)、道具(props)、其他元素(others，如特效/氛围)
3. 人物/场景/道具名称保持统一（同一角色用同一个名字）
4. 只返回JSON，不要任何解释
JSON格式：
{"shots":[{"text":"画面描述文本","dialogue":"人物说的话(无则空字符串)","characters":["人物名"],"scene":"场景名或空","props":["道具名"],"others":["其他"]}]}`;
  const known = existingAssets || { characters: [], scenes: [], props: [] };
  const userList = `
已有资产库（优先匹配这些名字）：
人物: ${known.characters.map(a => a.name).join('、') || '无'}
场景: ${known.scenes.map(a => a.name).join('、') || '无'}
道具: ${known.props.map(a => a.name).join('、') || '无'}`;

  const mc = loadConfig().text;
  const content = await callAI(mc, [
    { role: 'system', content: sys },
    { role: 'user', content: '已有资产参考：' + userList + '\n\n剧本如下：\n' + script }
  ], true).catch(async (e) => {
    // jsonMode失败时用普通模式重试一次
    const c2 = await callAI(mc, [
      { role: 'system', content: sys },
      { role: 'user', content: '已有资产参考：' + userList + '\n\n剧本如下：\n' + script + '\n\n注意：只输出纯JSON。' }
    ], false);
    return c2;
  });
  return extractJSON(content);
});

// ---------- AI 生图（图片模型：人物/场景/道具资产、分镜图） ----------
ipcMain.handle('ai:genImage', async (event, { prompt, aspect }) => {
  const mc = loadConfig().image;
  if (!mc.baseUrl || !mc.model) {
    throw new Error('请先在「模型配置」中填写图片模型（用于资产图/分镜图生成）');
  }
  ensureDirs();
  const url = mc.baseUrl.replace(/\/+$/, '') + '/images/generations';
  const size = aspect === '16:9' ? '1792x1024' : '1024x1792';
  const resp = await net.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(mc.apiKey ? { 'Authorization': 'Bearer ' + mc.apiKey } : {})
    },
    body: JSON.stringify({ model: mc.model, prompt, size, n: 1, response_format: 'b64_json' })
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('生图API失败 HTTP ' + resp.status + ': ' + t.slice(0, 300));
  }
  const data = await resp.json();
  const item = data.data && data.data[0];
  let buf = null;
  if (item && item.b64_json) {
    buf = Buffer.from(item.b64_json, 'base64');
  } else if (item && item.url) {
    const imgResp = await net.fetch(item.url);
    buf = Buffer.from(await imgResp.arrayBuffer());
  }
  if (!buf) throw new Error('API未返回图片数据');
  const fileName = 'img_' + uid() + '.png';
  fs.writeFileSync(path.join(ASSETS_DIR, fileName), buf);
  return 'mochi-file://assets/' + fileName;
});

// ---------- AI 生视频（视频模型：综合所有信息生成每镜视频） ----------
// 兼容两类接口：
// 1) 同步：POST /videos/generations 直接返回 {data:[{url}]}
// 2) 任务制：POST 返回 {id}，GET /videos/generations/{id} 轮询至 succeeded/completed 后取 url
async function callVideoAPI(mc, { prompt, aspect, send }) {
  if (!mc.baseUrl || !mc.model) {
    throw new Error('请先在「模型配置」中填写视频模型');
  }
  const base = mc.baseUrl.replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    ...(mc.apiKey ? { 'Authorization': 'Bearer ' + mc.apiKey } : {})
  };
  const body = { model: mc.model, prompt };
  // 常见参数兼容：优先不带额外参数，部分网关需要 aspect/size
  let resp = await net.fetch(base + '/videos/generations', {
    method: 'POST', headers, body: JSON.stringify(body)
  }).catch(async (e) => {
    // 失败时带 aspect_ratio 重试一次（部分API要求）
    const b2 = Object.assign({}, body, { aspect_ratio: aspect === '16:9' ? '16:9' : '9:16' });
    return net.fetch(base + '/videos/generations', { method: 'POST', headers, body: JSON.stringify(b2) });
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error('视频API提交失败 HTTP ' + resp.status + ': ' + t.slice(0, 300));
  }
  const data = await resp.json().catch(() => { throw new Error('视频API返回非JSON'); });

  const tryExtractUrl = (d) => {
    if (!d) return null;
    if (typeof d.url === 'string') return d.url;
    if (typeof d.video_url === 'string') return d.video_url;
    if (d.data && d.data[0]) {
      if (typeof d.data[0].url === 'string') return d.data[0].url;
      if (typeof d.data[0].video_url === 'string') return d.data[0].video_url;
    }
    if (d.output) {
      if (typeof d.output.video_url === 'string') return d.output.video_url;
      if (typeof d.output.url === 'string') return d.output.url;
      if (Array.isArray(d.output) && d.output[0]) return d.output[0].url || d.output[0].video_url || null;
    }
    if (d.videos && d.videos[0]) return d.videos[0].url || d.videos[0].video_url || null;
    return null;
  };

  let videoUrl = tryExtractUrl(data);
  if (!videoUrl) {
    // 任务制：轮询
    const id = data.id || data.task_id || (data.data && data.data[0] && (data.data[0].id || data.data[0].task_id));
    if (!id) throw new Error('视频API未返回任务ID或视频URL: ' + JSON.stringify(data).slice(0, 300));
    const maxPoll = 150; // 最多 150×5s ≈ 12.5 分钟
    for (let i = 0; i < maxPoll; i++) {
      await new Promise(r => setTimeout(r, 5000));
      let pd = null;
      try {
        const pr = await net.fetch(base + '/videos/generations/' + id, { headers });
        if (pr.ok) pd = await pr.json();
      } catch (e) { pd = null; }
      if (!pd) continue;
      videoUrl = tryExtractUrl(pd);
      const st = String(pd.status || '').toLowerCase();
      if (videoUrl) break;
      if (send) send(`视频模型生成中…（${st || 'processing'}，已等待 ${Math.round((i + 1) * 5 / 60)}分钟）`);
      if (['failed', 'error', 'canceled', 'cancelled'].includes(st)) {
        throw new Error('视频生成失败: ' + JSON.stringify(pd).slice(0, 300));
      }
    }
    if (!videoUrl) throw new Error('视频生成超时（超过12分钟）');
  }

  // 下载视频到本地
  const vr = await net.fetch(videoUrl);
  if (!vr.ok) throw new Error('视频下载失败 HTTP ' + vr.status);
  const buf = Buffer.from(await vr.arrayBuffer());
  if (!buf || buf.length < 1024) throw new Error('视频下载内容为空');
  const fileName = 'vid_' + uid() + '.mp4';
  fs.writeFileSync(path.join(ASSETS_DIR, fileName), buf);
  return 'mochi-file://assets/' + fileName;
}

// 单镜：构建综合所有信息的视频生成提示词
function buildVideoPrompt(shot, project) {
  const assets = project.assets || {};
  const get = (t, id) => (assets[t] || []).find(a => a.id === id);
  const chars = (shot.characters || []).map(id => get('characters', id)).filter(Boolean)
    .map(a => a.name + (a.desc ? '（' + a.desc + '）' : '')).join('、');
  const scene = get('scenes', shot.scene);
  const props = (shot.props || []).map(id => get('props', id)).filter(Boolean)
    .map(a => a.name + (a.desc ? '（' + a.desc + '）' : '')).join('、');
  const others = (shot.others || []).map(id => get('others', id)).filter(Boolean)
    .map(a => a.name).join('、');
  const parts = [];
  parts.push(project.aspect === '16:9' ? '横屏16:9漫剧动画' : '竖屏9:16漫剧动画');
  if (chars) parts.push('登场人物：' + chars + '（保持人物形象一致）');
  if (scene) parts.push('场景：' + scene.name + (scene.desc ? '（' + scene.desc + '）' : ''));
  if (props) parts.push('道具：' + props);
  if (others) parts.push('氛围元素：' + others);
  if (shot.text) parts.push('画面内容：' + shot.text);
  if (shot.dialogue) parts.push('角色台词：' + shot.dialogue);
  parts.push('高质量动画质感，画面连贯流畅，人物动作自然');
  return parts.join('；');
}

// 单镜重新生成视频（手动触发）
ipcMain.handle('ai:genShotVideo', async (event, { shot, project }) => {
  ensureDirs();
  const mc = loadConfig().video;
  const prompt = buildVideoPrompt(shot, project);
  return callVideoAPI(mc, { prompt, aspect: project.aspect, send: (m) => {
    if (mainWindow) mainWindow.webContents.send('video:progress', { msg: m, pct: 10 });
  } });
});

// ---------- 文件保存 ----------
ipcMain.handle('file:saveAsset', async (event, { name, dataBase64 }) => {
  ensureDirs();
  const ext = (path.extname(name) || '.bin').toLowerCase();
  const fileName = uid() + ext;
  const filePath = path.join(ASSETS_DIR, fileName);
  fs.writeFileSync(filePath, Buffer.from(dataBase64, 'base64'));
  return 'mochi-file://assets/' + fileName;
});

ipcMain.handle('dialog:pickFile', async (event, { filters }) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [{ name: '全部文件', extensions: ['*'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('file:readAsBase64', async (event, filePath) => {
  const buf = fs.readFileSync(filePath);
  return buf.toString('base64');
});

ipcMain.handle('shell:showItem', async (event, p) => {
  shell.showItemInFolder(p);
});

// ---------- TTS 配音（msedge-tts，免费） ----------
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

ipcMain.handle('tts:voices', () => {
  return [
    { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓(女·温柔)', gender: '女' },
    { id: 'zh-CN-XiaoyiNeural', name: '晓伊(女·活泼)', gender: '女' },
    { id: 'zh-CN-YunjianNeural', name: '云健(男·沉稳)', gender: '男' },
    { id: 'zh-CN-YunxiNeural', name: '云希(男·阳光)', gender: '男' },
    { id: 'zh-CN-YunxiaNeural', name: '云夏(男·少年)', gender: '男' },
    { id: 'zh-CN-YunyangNeural', name: '云扬(男·新闻)', gender: '男' },
    { id: 'zh-CN-liaoning-XiaobeiNeural', name: '小北(女·东北)', gender: '女' },
    { id: 'zh-CN-shaanxi-XiaoniNeural', name: '小妮(女·陕西)', gender: '女' },
    { id: 'zh-HK-HiuMaanNeural', name: '曉曼(女·粤语)', gender: '女' },
    { id: 'zh-HK-WanLungNeural', name: '雲龍(男·粤语)', gender: '男' },
    { id: 'zh-TW-HsiaoChenNeural', name: '曉臻(女·台湾)', gender: '女' },
    { id: 'en-US-AriaNeural', name: 'Aria(女·英语)', gender: '女' },
    { id: 'en-US-GuyNeural', name: 'Guy(男·英语)', gender: '男' },
    { id: 'ja-JP-NanamiNeural', name: '七海(女·日语)', gender: '女' }
  ];
});

async function ttsToFile(text, voice, rate, pitch, outFile) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice || 'zh-CN-XiaoxiaoNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const prosody = {};
  if (rate && parseInt(rate) !== 0) prosody.rate = (rate > 0 ? '+' : '') + parseInt(rate) + '%';
  if (pitch && parseInt(pitch) !== 0) prosody.pitch = (pitch > 0 ? '+' : '') + parseInt(pitch) + 'Hz';
  const { audioFilePath } = await tts.toFile(path.dirname(outFile), text, prosody);
  try { tts.close(); } catch (e) { }
  if (audioFilePath && path.resolve(audioFilePath) !== path.resolve(outFile)) {
    fs.renameSync(audioFilePath, outFile);
  }
  return outFile;
}

ipcMain.handle('tts:generate', async (event, { text, voice, rate, pitch }) => {
  if (!text || !text.trim()) throw new Error('配音文本为空');
  ensureDirs();
  const fileName = 'voice_' + uid() + '.mp3';
  const outPath = path.join(ASSETS_DIR, fileName);
  await ttsToFile(text.trim(), voice, rate, pitch, outPath);
  const dur = await getAudioDuration(outPath);
  return { url: 'mochi-file://assets/' + fileName, duration: Math.round(dur * 100) / 100 };
});

// ---------- 视频合成 ----------
// 若配置了视频模型：每镜调用视频模型（综合剧本+人物+场景+道具+其他+台词）生成画面，
// 再与配音/音效混音对齐；未配置或失败时退回本地FFmpeg方案（分镜图+配音）。
ipcMain.handle('video:compose', async (event, { project }) => {
  ensureDirs();
  const win = BrowserWindow.fromWebContents(event.sender);
  const send = (msg, pct) => win && win.webContents.send('video:progress', { msg, pct });

  const W = project.aspect === '16:9' ? 1920 : 1080;
  const H = project.aspect === '16:9' ? 1080 : 1920;

  const workDir = path.join(TMP_DIR, 'compose_' + uid());
  fs.mkdirSync(workDir, { recursive: true });

  const shots = project.shots || [];
  if (!shots.length) throw new Error('没有分镜，请先添加或AI拆解剧本');

  const videoCfg = loadConfig().video;
  const useVideoAPI = !!(videoCfg.baseUrl && videoCfg.model);

  const segFiles = [];
  const segments = [];
  const srtLines = [];
  let timeline = 0;

  const toLocal = (url) => {
    if (!url) return null;
    if (url.startsWith('mochi-file://')) {
      const rel = decodeURIComponent(url.replace('mochi-file://', ''));
      return path.join(DATA_DIR, rel);
    }
    return url;
  };

  const baseVf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30`;

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const pct0 = Math.round((i / shots.length) * 90);
    const segPath = path.join(workDir, `seg_${String(i).padStart(4, '0')}.mp4`);
    const voice = toLocal(shot.voicePath);
    const sfx = toLocal(shot.sfxId ? (getAssetUrl(project, 'sfx', shot.sfxId)) : null);
    const hasVoice = voice && fs.existsSync(voice);
    const hasSfx = sfx && fs.existsSync(sfx);

    let apiVideo = null;
    if (useVideoAPI) {
      send(`分镜 ${i + 1}/${shots.length}：视频模型生成中（综合剧本/人物/场景/道具/台词）…`, pct0);
      try {
        const prompt = buildVideoPrompt(shot, project);
        const url = await callVideoAPI(videoCfg, { prompt, aspect: project.aspect, send: (m) => send(m, pct0) });
        apiVideo = toLocal(url);
      } catch (e) {
        send(`分镜 ${i + 1}：视频模型失败（${e.message.slice(0, 120)}），退回本地方案`, pct0);
        apiVideo = null;
      }
    } else {
      send(`正在合成分镜 ${i + 1}/${shots.length}…`, pct0);
    }

    let durV = 0, hasOrigAudio = false;
    let args = ['-y'];

    if (apiVideo && fs.existsSync(apiVideo)) {
      // ===== 视频模型模式 =====
      const info = await probeMedia(apiVideo);
      durV = info.duration;
      hasOrigAudio = info.hasAudio;
      let target = durV;
      let padDur = 0;
      if (hasVoice) {
        const durA = (await getAudioDuration(voice)) + 0.3;
        if (durA > durV) { padDur = durA - durV; target = durA; }
      }
      const vf = padDur > 0 ? `${baseVf},tpad=stop_mode=clone:stop_duration=${Math.ceil(padDur * 100) / 100}` : baseVf;
      args.push('-i', apiVideo);
      if (hasVoice) args.push('-i', voice);
      if (hasSfx) args.push('-i', sfx);
      const nIn = 1 + (hasVoice ? 1 : 0) + (hasSfx ? 1 : 0);

      if (hasVoice && hasSfx) {
        const vi = 1, si = 2;
        args.push('-filter_complex',
          `[0:v]${vf}[v];[${vi}:a]volume=1.0[a1];[${si}:a]volume=0.5[a2];[a1][a2]amix=inputs=2:duration=first:dropout_transition=2[a]`,
          '-map', '[v]', '-map', '[a]');
      } else if (hasVoice) {
        args.push('-vf', vf, '-map', '0:v', '-map', '1:a');
      } else if (hasOrigAudio) {
        args.push('-vf', vf, '-map', '0:v', '-map', '0:a');
      } else {
        args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-vf', vf, '-map', '0:v', '-map', `${nIn}:a`);
      }
      args.push('-t', String(Math.ceil(target * 100) / 100));
    } else {
      // ===== 本地方案（分镜图/纯色背景 + 配音） =====
      const img = toLocal(shot.storyboardImg);
      if (img && fs.existsSync(img)) {
        args.push('-loop', '1', '-i', img);
      } else {
        args.push('-f', 'lavfi', '-i', `color=c=0x14141f:s=${W}x${H}:r=30`);
      }
      let dur = 3;
      if (hasVoice) {
        dur = Math.max(1.5, (await getAudioDuration(voice)) + 0.3);
      } else if (shot.duration && shot.duration > 0) {
        dur = shot.duration;
      }
      if (shot.durationOverride && shot.durationOverride > 0) dur = shot.durationOverride;

      if (hasVoice) args.push('-i', voice);
      if (hasSfx) args.push('-i', sfx);
      const vi = hasVoice ? 1 : -1;
      const si = hasVoice ? (hasSfx ? 2 : -1) : (hasSfx ? 1 : -1);

      if (vi >= 0 && si >= 0) {
        args.push('-filter_complex',
          `[0:v]${baseVf}[v];[${vi}:a]volume=1.0[a1];[${si}:a]volume=0.5[a2];[a1][a2]amix=inputs=2:duration=first:dropout_transition=2[a]`,
          '-map', '[v]', '-map', '[a]');
      } else if (vi >= 0) {
        args.push('-vf', baseVf, '-map', '0:v', '-map', `${vi}:a`);
      } else if (si >= 0) {
        args.push('-vf', baseVf, '-map', '0:v', '-map', `${si}:a`);
      } else {
        args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-vf', baseVf, '-map', '0:v', '-map', '1:a');
      }
      args.push('-t', String(Math.ceil(dur * 100) / 100));
    }

    args.push(
      '-r', '30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      segPath
    );
    await runFfmpeg(args, workDir);
    segFiles.push(segPath);

    // 段实际时长（用于字幕时间轴）
    const segDur = (await probeMedia(segPath)).duration || 1;
    try {
      const segSave = path.join(ASSETS_DIR, `seg_${shot.id}.mp4`);
      fs.copyFileSync(segPath, segSave);
      segments.push({ shotId: shot.id, url: 'mochi-file://assets/' + path.basename(segSave), duration: Math.round(segDur * 100) / 100 });
    } catch (e) { /* 段保存失败不影响成片 */ }

    const srtText = (shot.dialogue || shot.text || '').slice(0, 80);
    if (srtText) {
      const fmt = (t) => {
        const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 1000);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
      };
      srtLines.push(`${i + 1}\n${fmt(timeline)} --> ${fmt(timeline + segDur)}\n${srtText}\n`);
    }
    timeline += segDur;
  }

  // concat 所有段
  send('正在拼接全部分镜…', 92);
  const listFile = path.join(workDir, 'list.txt');
  fs.writeFileSync(listFile, segFiles.map(f => `file '${path.basename(f)}'`).join('\n'), 'utf-8');
  await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'concat.mp4'], workDir);

  // 烧字幕
  send('正在烧录字幕…', 96);
  let finalPath = path.join(workDir, 'concat.mp4');
  if (srtLines.length) {
    fs.writeFileSync(path.join(workDir, 'sub.srt'), '\ufeff' + srtLines.join('\n'), 'utf-8');
    const subPath = path.join(workDir, 'subbed.mp4');
    const style = `FontName=Microsoft YaHei,FontSize=${project.aspect === '16:9' ? 16 : 18},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=60`;
    await runFfmpeg(['-y', '-i', 'concat.mp4', '-vf', `subtitles=sub.srt:force_style='${style}'`, '-c:a', 'copy', 'subbed.mp4'], workDir);
    finalPath = subPath;
  }

  send('正在导出成片…', 98);
  const outDir = path.join(DATA_DIR, 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const outName = `${(project.name || '漫剧').replace(/[\\/:*?"<>|]/g, '_')}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mp4`;
  const outPath = path.join(outDir, outName);
  fs.copyFileSync(finalPath, outPath);

  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { }

  send('视频生成完成！', 100);
  return { path: outPath, name: outName, duration: Math.round(timeline * 100) / 100, segments, usedVideoAPI: useVideoAPI };
});

// 工具：取资产文件的本地URL
function getAssetUrl(project, type, id) {
  const a = ((project.assets || {})[type] || []).find(x => x.id === id);
  return a ? (a.audio || a.img || null) : null;
}

// ---------- 项目存取 ----------
ipcMain.handle('project:load', () => loadProject());
ipcMain.handle('project:save', (e, project) => saveProject(project));
ipcMain.handle('config:load', () => loadConfig());
ipcMain.handle('config:save', (e, cfg) => { saveConfig(cfg); return true; });

// ---------- 自动更新（electron-updater + GitHub Releases） ----------
let updaterReady = false;
function initAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const notify = (channel, data) => {
      if (mainWindow) mainWindow.webContents.send('updater:' + channel, data);
    };
    autoUpdater.on('checking-for-update', () => notify('checking', {}));
    autoUpdater.on('update-available', (i) => notify('available', { version: i.version }));
    autoUpdater.on('update-not-available', () => notify('not-available', {}));
    autoUpdater.on('download-progress', (p) => notify('progress', { percent: Math.round(p.percent), bytes: p.transferred, total: p.total }));
    autoUpdater.on('update-downloaded', (i) => notify('downloaded', { version: i.version }));
    autoUpdater.on('error', (e) => notify('error', { message: e.message }));
    updaterReady = true;
    return autoUpdater;
  } catch (e) {
    console.error('updater init failed:', e.message);
    return null;
  }
}

ipcMain.handle('updater:check', async () => {
  const autoUpdater = initAutoUpdater();
  if (!updaterReady || !autoUpdater) {
    return { ok: false, message: '当前为开发模式，自动更新仅对安装版生效' };
  }
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r && r.updateInfo ? r.updateInfo.version : null };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('updater:install', () => {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall();
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  isPackaged: app.isPackaged,
  dataDir: DATA_DIR
}));

// ---------- 窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 940,
    minWidth: 1200,
    minHeight: 720,
    backgroundColor: '#0d0d14',
    title: '乾坤设计',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 安装版启动后自动检查更新（延迟3秒，避免影响启动速度）
  if (app.isPackaged) {
    setTimeout(() => {
      const autoUpdater = initAutoUpdater();
      if (autoUpdater) autoUpdater.checkForUpdates().catch(() => { });
    }, 3000);
  }
}

app.whenReady().then(() => {
  ensureDirs();
  registerFileProtocol();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
