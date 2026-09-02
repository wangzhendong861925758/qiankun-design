// 乾坤设计 - 协作服务端（可独立运行，也可内嵌在 Electron 中）
// 负责：登录校验码、项目/分集/资产共享存储、AI代理（凭证不出服务端）、生成统计、WebSocket实时共创
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');

// 两位管理员（账号硬编码，仅服务端校验）
const ADMINS = [
  { username: 'wangzhendong', password: '123456', name: '管理员-王' },
  { username: 'zhaojiawei', password: '123456', name: '管理员-赵' }
];

const APP_VERSION = '2.0.7';
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function nowTs() { return Date.now(); }
function genCode() { // 生成8位校验码
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function emptyAssets() {
  return { characters: [], scenes: [], props: [], others: [], sfx: [] };
}

async function fetchTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); }
  finally { clearTimeout(t); }
}

function createServer(dataDir, port = 3210) {
  fs.mkdirSync(path.join(dataDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'episodes'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });

  const epFile = id => path.join(dataDir, 'episodes', id + '.json');
  function loadJSON(f, def) { try { return JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf-8')); } catch (e) { return def; } }
  const db = {
    server: loadJSON('server.json', { codes: [], users: [], nodeId: '' }),
    projects: loadJSON('projects.json', []),
    episodes: loadJSON('episodes.json', []),
    stats: loadJSON('stats.json', [])
  };
  const saveTimers = {};
  function saveKey(key, file) {
    clearTimeout(saveTimers[key]);
    saveTimers[key] = setTimeout(() => {
      try { fs.writeFileSync(path.join(dataDir, file), JSON.stringify(db[key], null, 2)); } catch (e) { console.error('save', key, e.message); }
    }, 250);
  }
  // 节点唯一 ID：联邦同步用于识别资产来源节点；首次启动生成并持久化
  // （注意：必须在 saveKey/saveTimers 定义之后调用，否则触发 const 暂时性死区 ReferenceError）
  if (!db.server.nodeId) {
    db.server.nodeId = 'node_' + uid();
    saveKey('server', 'server.json');
  }
  const epSaveTimers = {};
  function loadEpisode(id) {
    try { return JSON.parse(fs.readFileSync(epFile(id), 'utf-8')); } catch (e) { return null; }
  }
  function saveEpisodeDebounced(id, data) {
    clearTimeout(epSaveTimers[id]);
    epSaveTimers[id] = setTimeout(() => {
      try { fs.writeFileSync(epFile(id), JSON.stringify(data, null, 2)); } catch (e) { console.error('saveEp', e.message); }
    }, 300);
  }
  function touchEpisode(id, userName) {
    const ep = db.episodes.find(x => x.id === id);
    if (ep) { ep.updatedAt = nowTs(); ep.updatedBy = userName || ''; saveKey('episodes', 'episodes.json'); }
  }

  // ---------- 令牌 ----------
  const tokens = new Map(); // token -> {kind:'user'|'admin', id, name}
  function mkToken(info) { const t = crypto.randomBytes(20).toString('hex'); tokens.set(t, info); return t; }

  // ---------- HTTP ----------
  const app = express();
  app.use(express.json({ limit: '256mb' }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });
  app.get('/', (req, res) => res.type('html').send(
    `<meta charset="utf-8"><body style="font-family:sans-serif;background:#14152b;color:#eee;padding:40px">
     <h2>☯ 乾坤设计 · 协作服务运行中</h2>
     <p>版本 ${APP_VERSION} | 项目 ${db.projects.length} 个 | 分集 ${db.episodes.length} 集 | 用户 ${db.server.codes.length} 个</p>
     <p style="color:#9ab">客户端登录页请填入服务器地址：<b>http://本机IP:${port}</b></p></body>`));
  app.get('/api/health', (req, res) => res.json({ ok: true, name: '乾坤设计协作服务', version: APP_VERSION, time: nowTs() }));
  app.use('/assets', express.static(path.join(dataDir, 'assets'), { maxAge: '7d' }));

  function auth(req) {
    const h = req.headers.authorization || '';
    return tokens.get(h.replace(/^Bearer\s+/i, '')) || null;
  }
  function needUser(req, res) {
    const a = auth(req);
    if (!a || a.kind !== 'user') { res.status(401).json({ error: '未登录或凭证失效' }); return null; }
    return a;
  }
  function needAdmin(req, res) {
    const a = auth(req);
    if (!a || a.kind !== 'admin') { res.status(401).json({ error: '需要管理员权限' }); return null; }
    return a;
  }
  function absUrl(req, p) { return 'http://' + (req.headers.host || ('localhost:' + port)) + p; }

  // ---------- 登录 ----------
  app.post('/api/login', (req, res) => {
    const code = String((req.body || {}).code || '').trim().toUpperCase();
    const c = db.server.codes.find(x => x.code.toUpperCase() === code && !x.disabled);
    if (!c) return res.status(400).json({ error: '校验码无效或已被删除' });
    let u = db.server.users.find(x => x.codeId === c.id);
    if (!u) { u = { id: uid(), codeId: c.id, name: c.name, firstSeen: nowTs() }; db.server.users.push(u); saveKey('server', 'server.json'); }
    res.json({ ok: true, token: mkToken({ kind: 'user', id: u.id, name: u.name }), user: { id: u.id, name: u.name } });
  });
  app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body || {};
    const a = ADMINS.find(x => x.username === String(username || '').trim() && x.password === password);
    if (!a) return res.status(400).json({ error: '管理员账号或密码错误' });
    res.json({ ok: true, token: mkToken({ kind: 'admin', id: a.username, name: a.name }), admin: { username: a.username, name: a.name } });
  });

  // ---------- 用户：项目/分集 ----------
  function stripKey(m) { return { id: m.id, name: m.name, type: m.type || '' }; }
  function safeProject(p) {
    return {
      id: p.id, name: p.name, updatedAt: p.updatedAt,
      models: {
        text: (p.models && p.models.text || []).map(stripKey),
        image: (p.models && p.models.image || []).map(stripKey),
        video: (p.models && p.models.video || []).map(stripKey)
      },
      assets: p.assets || emptyAssets()
    };
  }
  app.get('/api/projects', (req, res) => {
    if (!needUser(req, res)) return;
    res.json(db.projects.map(p => ({
      id: p.id, name: p.name, updatedAt: p.updatedAt,
      episodeCount: db.episodes.filter(e => e.projectId === p.id).length
    })));
  });
  app.get('/api/projects/:id', (req, res) => {
    if (!needUser(req, res)) return;
    const p = db.projects.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '项目不存在' });
    const eps = db.episodes.filter(e => e.projectId === p.id).sort((a, b) => (a.order || 0) - (b.order || 0));
    res.json({ project: safeProject(p), episodes: eps });
  });
  app.post('/api/projects/:id/episodes', (req, res) => {
    const u = needUser(req, res); if (!u) return;
    const p = db.projects.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '项目不存在' });
    const count = db.episodes.filter(e => e.projectId === p.id).length;
    const name = String((req.body || {}).name || '').trim() || ('第' + (count + 1) + '集');
    const ep = { id: uid(), projectId: p.id, name, order: count + 1, createdAt: nowTs(), updatedAt: nowTs(), updatedBy: u.name, ownerNode: db.server.nodeId };
    db.episodes.push(ep);
    fs.writeFileSync(epFile(ep.id), JSON.stringify({ id: ep.id, projectId: p.id, name: ep.name, aspect: '9:16', script: '', shots: [] }, null, 2));
    p.updatedAt = nowTs();
    saveKey('projects', 'projects.json'); saveKey('episodes', 'episodes.json');
    res.json({ ok: true, episode: ep });
  });
  app.get('/api/episodes/:id', (req, res) => {
    if (!needUser(req, res)) return;
    const ep = db.episodes.find(x => x.id === req.params.id);
    if (!ep) return res.status(404).json({ error: '分集不存在' });
    const data = loadEpisode(ep.id) || { id: ep.id, projectId: ep.projectId, name: ep.name, aspect: '9:16', script: '', shots: [] };
    res.json({ episode: ep, data });
  });
  app.post('/api/episodes/:id/save', (req, res) => {
    const u = needUser(req, res); if (!u) return;
    const ep = db.episodes.find(x => x.id === req.params.id);
    if (!ep) return res.status(404).json({ error: '分集不存在' });
    const d = req.body || {};
    fs.writeFileSync(epFile(ep.id), JSON.stringify({
      id: ep.id, projectId: ep.projectId,
      name: d.name || ep.name, aspect: d.aspect || '9:16',
      script: d.script || '', shots: d.shots || []
    }, null, 2));
    touchEpisode(ep.id, u.name);
    res.json({ ok: true });
  });
  app.post('/api/projects/:id/assets/save', (req, res) => {
    const u = needUser(req, res); if (!u) return;
    const p = db.projects.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '项目不存在' });
    if (req.body && req.body.assets) { p.assets = req.body.assets; p.updatedAt = nowTs(); saveKey('projects', 'projects.json'); }
    res.json({ ok: true });
  });

  // ---------- 文件上传 ----------
  app.post('/api/upload', (req, res) => {
    if (!needUser(req, res)) return;
    const { name, dataBase64 } = req.body || {};
    if (!dataBase64) return res.status(400).json({ error: '缺少文件数据' });
    const ext = (path.extname(name || '') || '.bin').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
    const fn = uid() + ext;
    try { fs.writeFileSync(path.join(dataDir, 'assets', fn), Buffer.from(dataBase64, 'base64')); }
    catch (e) { return res.status(500).json({ error: '保存文件失败: ' + e.message }); }
    res.json({ ok: true, url: '/assets/' + fn });
  });

  // ---------- AI 代理（模型凭证仅存在服务端，不暴露给用户端） ----------
  // 参考图转公网可用的形式：本地文件（/assets/xx.png 或 localhost 地址）→ base64 data URL；外部 http URL 原样返回
  // 原因：外部 AI 网关无法访问本机 localhost 地址，直接传 localhost URL 会被网关忽略，退化为纯文生视频
  function refToDataUrl(u) {
    if (!u || typeof u !== 'string') return '';
    if (/^data:/i.test(u)) return u;                       // 已是 data URL
    let p = '';
    if (/^https?:\/\//i.test(u)) {
      if (!/\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(u)) return u;  // 外部公网 URL 直接用
      try { p = decodeURIComponent(new URL(u).pathname); } catch { return ''; }
    } else if (u.startsWith('/')) {
      p = u;                                               // 本地相对路径
    } else return '';
    if (!/^\/assets\/[\w.-]+$/.test(p)) return '';         // 仅允许 assets 目录，防路径穿越
    const fp = path.join(dataDir, 'assets', path.basename(p));
    try {
      if (!fs.existsSync(fp)) return '';
      const ext = path.extname(fp).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg' }[ext] || 'image/png';
      return 'data:' + mime + ';base64,' + fs.readFileSync(fp).toString('base64');
    } catch { return ''; }
  }
  function getModel(pid, kind, id) {
    const p = db.projects.find(x => x.id === pid);
    if (!p) return null;
    const list = (p.models && p.models[kind]) || [];
    return list.find(m => m.id === id) || list[0] || null;
  }
  function aiHeaders(m) {
    const h = { 'Content-Type': 'application/json' };
    if (m.apiKey) h['Authorization'] = 'Bearer ' + m.apiKey;
    return h;
  }
  // Base URL 归一化：末尾未带版本号时自动补 /v1（兼容 nginx 网关 405）
  function apiBase(m) {
    const b = m.baseUrl.replace(/\/+$/, '');
    return /\/v\d+[a-z]*$/.test(b) ? b : b + '/v1';
  }
  app.post('/api/ai/text', async (req, res) => {
    if (!needUser(req, res)) return;
    const { projectId, modelId, messages, jsonMode } = req.body || {};
    const m = getModel(projectId, 'text', modelId);
    if (!m) return res.status(400).json({ error: '该项目未配置文本模型，请联系管理员' });
    try {
      const body = { model: m.model, messages: messages || [], temperature: 0.3 };
      if (jsonMode) body.response_format = { type: 'json_object' };
      const r = await fetchTimeout(apiBase(m) + '/chat/completions',
        { method: 'POST', headers: aiHeaders(m), body: JSON.stringify(body) }, 300000);
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (await r.text()).slice(0, 300));
      const d = await r.json();
      const c = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (!c) throw new Error('模型返回内容为空');
      res.json({ ok: true, content: c });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  app.post('/api/ai/image', async (req, res) => {
    if (!needUser(req, res)) return;
    const { projectId, modelId, prompt, aspect } = req.body || {};
    const m = getModel(projectId, 'image', modelId);
    if (!m) return res.status(400).json({ error: '该项目未配置图片模型，请联系管理员' });
    try {
      const body = { model: m.model, prompt: prompt, n: 1, size: aspect === '16:9' ? '1024x576' : '576x1024' };
      const r = await fetchTimeout(apiBase(m) + '/images/generations',
        { method: 'POST', headers: aiHeaders(m), body: JSON.stringify(body) }, 600000);
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (await r.text()).slice(0, 300));
      const d = await r.json();
      const item = d.data && d.data[0];
      let b64 = null;
      if (item && item.b64_json) b64 = item.b64_json;
      else if (item && item.url) {
        const rr = await fetchTimeout(item.url, {}, 600000);
        if (!rr.ok) throw new Error('下载生成图片失败');
        b64 = Buffer.from(await rr.arrayBuffer()).toString('base64');
      }
      if (!b64) throw new Error('模型未返回图片');
      const fn = uid() + '.png';
      fs.writeFileSync(path.join(dataDir, 'assets', fn), Buffer.from(b64, 'base64'));
      res.json({ ok: true, url: '/assets/' + fn });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  // 视频生成核心流程：提交任务 → 轮询 → 下载保存（支持首尾帧模式）
  // 同步接口（/api/ai/video）与后台任务接口（/api/ai/video/task）共用
  async function runVideoGen(m, params) {
    const { prompt, aspect, firstFrame, lastFrame, duration, refImages, audio } = params || {};
    {
      const base = apiBase(m);
      const dur = Math.max(4, Math.min(15, Number(duration) || 5));   // Seedance 2.0 时长范围 [4,15] 秒
      const ratio = aspect === '9:16' ? '9:16' : '16:9';               // 方舟宽高比字段为 ratio
      // 参考图（本地图转 base64 data URL；外部公网 URL 原样）—— 多模态参考模式与首尾帧模式互斥
      const rawRefs = Array.isArray(refImages) ? refImages.slice(0, 9) : [];
      const refs = rawRefs.map(refToDataUrl).filter(Boolean);
      const ff = firstFrame ? refToDataUrl(firstFrame) : '';
      const lf = lastFrame ? refToDataUrl(lastFrame) : '';
      // 参考音频（配音）：官方约束"音频不可单独输入，至少配合1张参考图"，无图时不传
      const au = (audio && (refs.length || ff)) ? refToDataUrl(audio) : '';

      // ---- 火山方舟/Seedance 2.0 原生格式（content 数组，多参考图支持最完整）----
      // 官方规范：POST {base}/contents/generations/tasks
      // content: [{type:'text',text}, {type:'image_url',image_url:{url},role:'reference_image'|'first_frame'|'last_frame'}]
      // resolution 为顶层参数，可选 480p/720p/1080p/4k，默认 720p
      const rawText = String(prompt || '').slice(0, 4000);
      const text = rawText;  // 提示词原文
      const cArr = [{ type: 'text', text }];
      if (refs.length) refs.forEach(u => cArr.push({ type: 'image_url', image_url: { url: u }, role: 'reference_image' }));
      else { if (ff) cArr.push({ type: 'image_url', image_url: { url: ff }, role: 'first_frame' }); if (lf) cArr.push({ type: 'image_url', image_url: { url: lf }, role: 'last_frame' }); }
      // 参考音频（配音）→ 口型同步：官方 content 结构 {type:'audio_url', audio_url:{url}, role:'reference_audio'}
      if (au) cArr.push({ type: 'audio_url', audio_url: { url: au }, role: 'reference_audio' });
      const arkBody = { model: m.model, content: cArr, ratio, duration: dur, resolution: '480p', watermark: false };
      if (au) arkBody.generate_audio = true;

      // ---- new-api / OpenAI 风格 flat 格式（兜底）----
      const flatBody = { model: m.model, prompt: text, ratio, aspect_ratio: ratio, duration: dur, duration_seconds: dur, resolution: '480p', size: ratio === '16:9' ? '864x480' : '480x864', quality: '480p' };
      if (refs.length) { flatBody.reference_image_urls = refs; flatBody.reference_images = refs; flatBody.input_reference_role = 'reference_image'; }
      else { if (ff) { flatBody.image = ff; flatBody.image_url = ff; flatBody.first_frame_url = ff; } if (lf) { flatBody.image_tail = lf; flatBody.last_frame_url = lf; } }
      if (au) { flatBody.audio_url = au; flatBody.reference_audio_urls = [au]; flatBody.generate_audio = true; }

      // 端点+格式自适应：方舟原生优先；网关无此端点(404/405)时降级 new-api 风格
      const rootBase = base.replace(/\/(v\d+|api\/v\d+)\/?$/, '');
      const tries = [
        { ep: base + '/contents/generations/tasks', body: arkBody },                 // base 已带 /v3 或 /v1 的方舟风格网关
        { ep: rootBase + '/api/v3/contents/generations/tasks', body: arkBody },      // 方舟官方裸域名
        { ep: base + '/videos', body: flatBody },                                    // new-api 标准
        { ep: base + '/videos/generations', body: flatBody },
        { ep: base + '/video/generations', body: flatBody }
      ];
      let submit = null, epUsed = '', lastErr = '';
      // 诊断日志：确认多模态参考真的发出（base64 以 data: 开头）+ 比例与时长
      console.log('[video] 提交', m.model, '| ratio', ratio, '| 时长', dur + 's', '| 参考图', refs.length, '张:',
        refs.map(u => u.slice(0, 40) + (u.length > 40 ? '…(' + u.length + '字符)' : '')),
        '| 首帧', ff ? '有' : '无', '| 尾帧', lf ? '有' : '无', '| 配音', au ? '有(' + au.length + '字符)' : '无');
      for (const t of tries) {
        submit = await fetchTimeout(t.ep,
          { method: 'POST', headers: aiHeaders(m), body: JSON.stringify(t.body) }, 300000);
        if (submit.ok) { epUsed = t.ep; break; }
        lastErr = '提交失败 HTTP ' + submit.status + ' @ ' + t.ep + ': ' + (await submit.text()).slice(0, 300);
        // 404/405=端点不存在；500/502/503=网关上游不可用 → 均继续尝试下个端点
        if (![404, 405, 500, 502, 503].includes(submit.status)) throw new Error(lastErr);
      }
      if (!submit || !submit.ok) throw new Error(lastErr);
      const sd = await submit.json();
      // 兼容多种网关返回结构提取任务ID
      const pickVid = d => d.id || d.task_id || (d.data && d.data[0] && d.data[0].id) || (d.videos && d.videos[0] && d.videos[0].id) || '';
      const pickUrl = d => {
        // 方舟原生结构：{status, content:{video_url}}
        if (d.content && d.content.video_url) return d.content.video_url;
        const flat = d.url || d.video_url || d.result || (typeof d.output === 'string' ? d.output : '');
        if (flat) return flat;
        if (d.data && d.data[0] && (d.data[0].url || d.data[0].video_url)) return d.data[0].url || d.data[0].video_url;
        if (d.videos && d.videos[0] && (d.videos[0].url || d.videos[0].video_url)) return d.videos[0].url || d.videos[0].video_url;
        return '';
      };
      let vid = pickVid(sd);
      // 同步直接返回 url 的情况
      let url = pickUrl(sd);
      if (!url && vid) {
        // 任务制：轮询（最长20分钟）；查询端点 = 提交端点 + /{id}（方舟与 new-api 均如此）
        for (let i = 0; i < 240; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const pr = await fetchTimeout(epUsed + '/' + vid, { headers: aiHeaders(m) }, 120000);
          if (!pr.ok) continue;
          const pd = await pr.json();
          const st = pd.status || pd.task_status || (pd.data && pd.data[0] && pd.data[0].status) || '';
          const u = pickUrl(pd);
          if (u && String(st).toLowerCase() !== 'failed') { url = u; break; }
          if (String(st).toLowerCase() === 'failed') throw new Error('视频生成失败：' + (pd.error && (pd.error.message || pd.error) || '任务失败'));
        }
      }
      if (!url) throw new Error('视频生成超时或未返回地址');
      const vr = await fetchTimeout(url, {}, 900000);
      if (!vr.ok) throw new Error('下载生成视频失败');
      const ext = (path.extname(url.split('?')[0]) || '.mp4').toLowerCase();
      const fn = uid() + (['.mp4', '.webm', '.mov'].includes(ext) ? ext : '.mp4');
      fs.writeFileSync(path.join(dataDir, 'assets', fn), Buffer.from(await vr.arrayBuffer()));
      return { url: '/assets/' + fn, duration: dur };
    }
  }
  // 同步生成接口（旧版客户端兼容；Electron 合成等内部调用也走此接口，等待结果返回）
  app.post('/api/ai/video', async (req, res) => {
    if (!needUser(req, res)) return;
    const { projectId, modelId } = req.body || {};
    const m = getModel(projectId, 'video', modelId);
    if (!m) return res.status(400).json({ error: '该项目未配置视频模型，请联系管理员' });
    try {
      const result = await runVideoGen(m, req.body || {});
      res.json({ ok: true, url: result.url, duration: result.duration });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // ---------- 视频生成后台任务（v2.0.7+）：生成与页面/客户端彻底解耦 ----------
  // 提交后立即返回 taskId，服务端后台执行；用户退出编辑页甚至退出软件都不影响生成。
  // 成功后服务端直接落地：分集数据更新 + WS 广播全员 + 生成统计写入（不依赖任何客户端在线）。
  const videoTasks = new Map();   // taskId -> 任务对象（内存态；完成态保留30分钟供查询后清理）
  function taskPublic(t) {
    return { id: t.id, projectId: t.projectId, episodeId: t.episodeId, shotId: t.shotId,
      status: t.status, pct: t.pct, startedAt: t.startedAt, duration: t.duration, url: t.url, error: t.error,
      by: t.by };
  }
  // 任务成功落地：更新分集数据 + 广播 + 写统计（服务端完成，跨设备数据留存的本体）
  function finishVideoTask(task, result) {
    try {
      if (task.episodeId && task.shotId) {
        const ep = loadEpisode(task.episodeId);
        if (ep) {
          const i = ep.shots.findIndex(s => s.id === task.shotId);
          if (i >= 0) {
            const shot = ep.shots[i];
            const videos = (shot.videos || []).slice();
            videos.unshift({ url: result.url, duration: result.duration, ts: nowTs() });
            shot.videoUrl = result.url; shot.duration = result.duration; shot.videos = videos;
            ep.shots[i] = shot;
            // 同步立即写盘（不用防抖）：多个并发任务几乎同时完成时，防抖会基于旧副本互相覆盖导致丢数据
            fs.writeFileSync(epFile(task.episodeId), JSON.stringify(ep, null, 2));
            touchEpisode(task.episodeId, task.by.name);
            // 广播给同项目所有在线客户端；op 带 genTaskId 标记，客户端据此清除本地任务态并提示
            broadcastRoom(task.projectId, { t: 'op', op: { kind: 'shot-update', episodeId: task.episodeId, shot, genTaskId: task.id }, from: { userId: task.by.userId, name: task.by.name }, clientId: 'srv_' + task.id });
          }
        }
      }
      // 统计：服务端直写（含人员/项目/分集/分镜信息），管理端经联邦合并后全网络可见
      const p = db.projects.find(x => x.id === task.projectId);
      const epMeta = db.episodes.find(x => x.id === task.episodeId);
      const usr = db.server.users.find(x => x.id === task.by.userId);
      const codeObj = usr ? (db.server.codes.find(c => c.id === usr.codeId) || null) : null;
      let shotIdx = 0;
      if (task.episodeId && task.shotId) {
        const epd = loadEpisode(task.episodeId);
        if (epd) { const ii = epd.shots.findIndex(s => s.id === task.shotId); if (ii >= 0) shotIdx = ii; }
      }
      db.stats.push({
        id: uid(), groupId: task.id, ts: nowTs(), userId: task.by.userId, userName: task.by.name,
        userCode: codeObj ? codeObj.code : '', codeName: codeObj ? codeObj.name : '',
        projectId: task.projectId, projectName: p ? p.name : '', episodeId: task.episodeId, episodeName: epMeta ? epMeta.name : '',
        kind: 'video', resolution: '480p', durationSec: Number(result.duration || 0),
        shotId: task.shotId, shotIndex: shotIdx, shotText: String(task.shotText || '').slice(0, 60),
        nodeId: db.server.nodeId
      });
      saveKey('stats', 'stats.json');
    } catch (e) { console.error('finishVideoTask', e.message); }
  }
  // 提交生成任务：立即返回 taskId；后台执行（多任务天然并发，同用户多分镜/多用户互不阻塞）
  app.post('/api/ai/video/task', async (req, res) => {
    const u = needUser(req, res); if (!u) return;
    const b = req.body || {};
    const m = getModel(b.projectId, 'video', b.modelId);
    if (!m) return res.status(400).json({ error: '该项目未配置视频模型，请联系管理员' });
    const task = {
      id: 'vt_' + uid(), projectId: b.projectId, episodeId: b.episodeId || '', shotId: b.shotId || '',
      shotText: String(b.shotText || '').slice(0, 60),
      params: { prompt: b.prompt, aspect: b.aspect, firstFrame: b.firstFrame, lastFrame: b.lastFrame, duration: b.duration, refImages: b.refImages, audio: b.audio },
      status: 'running', pct: 0, startedAt: nowTs(), duration: Math.max(4, Math.min(15, Number(b.duration) || 5)),
      by: { userId: u.id, name: u.name }
    };
    videoTasks.set(task.id, task);
    res.json({ ok: true, taskId: task.id });
    // 后台执行（不 await：客户端断开/退出均不影响）
    (async () => {
      const estMs = (90 + task.duration * 6) * 1000;   // 进度估算与客户端一致
      const tick = setInterval(() => {
        if (task.status !== 'running') { clearInterval(tick); return; }
        task.pct = Math.min(95, Math.round((nowTs() - task.startedAt) / estMs * 100));
      }, 1000);
      try {
        const result = await runVideoGen(m, task.params);
        clearInterval(tick);
        task.pct = 100; task.status = 'done'; task.url = result.url;
        finishVideoTask(task, result);
      } catch (e) {
        clearInterval(tick);
        task.status = 'error'; task.error = String(e.message || e);
      }
      setTimeout(() => { try { videoTasks.delete(task.id); } catch (e2) { } }, 30 * 60 * 1000);
    })();
  });
  // 查询单个任务状态（客户端轮询兜底：WS 断连/广播丢失时发现完成或失败）
  app.get('/api/ai/video/task/:id', (req, res) => {
    if (!needUser(req, res)) return;
    const t = videoTasks.get(req.params.id);
    if (!t) return res.status(404).json({ error: '任务不存在或已过期' });
    res.json({ ok: true, task: taskPublic(t) });
  });
  // 查询分集进行中的任务（客户端重进分集/重启软件后恢复进度显示）
  app.get('/api/ai/video/tasks/active', (req, res) => {
    if (!needUser(req, res)) return;
    const eid = String(req.query.episodeId || '');
    const list = [];
    videoTasks.forEach(t => { if (t.status === 'running' && (!eid || t.episodeId === eid)) list.push(taskPublic(t)); });
    res.json({ ok: true, tasks: list });
  });

  // ---------- 联邦同步：跨节点资产共享 ----------
  // 设计：每台机器作为自己的服务器；本组接口供同网络其他节点拉取本项目资产元数据与原图
  // 客户端进入项目时通过 UDP 发现的节点列表，并行拉取所有节点的该项目资产，
  // 把本机没有的资产原图下载并上传到本机服务器，达到"上传即全员本地缓存"效果
  app.get('/federate/info', (req, res) => {
    res.json({
      nodeId: db.server.nodeId, version: APP_VERSION,
      projects: db.projects.length, episodes: db.episodes.length
    });
  });
  // 返回本节点某项目的资产元数据（不含原图二进制；原图按需拉取）
  app.get('/federate/projects/:pid/assets', (req, res) => {
    const p = db.projects.find(x => x.id === req.params.pid);
    if (!p) return res.status(404).json({ error: '项目不存在' });
    res.json({
      nodeId: db.server.nodeId, projectId: p.id,
      assets: p.assets || emptyAssets()
    });
  });
  // 联邦拉取资产原图：根据资产ID在所有项目中查找并返回二进制
  // field 参数指定拉取哪个字段的文件：img（默认）或 audio——修复 audio 永远拉到图片文件的 bug
  app.get('/federate/asset/:id/blob', (req, res) => {
    const aid = req.params.id;
    const field = req.query.field === 'audio' ? 'audio' : 'img';
    let asset = null;
    for (const p of db.projects) {
      for (const k of ['characters', 'scenes', 'props', 'others', 'sfx']) {
        const found = ((p.assets && p.assets[k]) || []).find(a => a.id === aid);
        if (found) { asset = found; break; }
      }
      if (asset) break;
    }
    if (!asset) return res.status(404).json({ error: '资产不存在' });
    // img / audio 字段为 /assets/xxx.png 路径
    const imgPath = asset[field] || '';
    if (!imgPath || !/^\/assets\/[\w.-]+$/.test(imgPath)) return res.status(404).json({ error: '原图不存在' });
    const fp = path.join(dataDir, 'assets', path.basename(imgPath));
    if (!fs.existsSync(fp)) return res.status(404).json({ error: '原图文件不存在' });
    res.sendFile(fp);
  });
  // 联邦拉取任意 /assets/xxx 路径的文件（兜底）
  app.get('/federate/blob', (req, res) => {
    const u = String(req.query.url || '');
    if (!/^\/assets\/[\w.-]+$/.test(u)) return res.status(400).json({ error: '非法路径' });
    const fp = path.join(dataDir, 'assets', path.basename(u));
    if (!fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
    res.sendFile(fp);
  });
  // 联邦统计接口：返回本节点统计供管理端聚合
  app.get('/federate/stats', (req, res) => {
    res.json({ nodeId: db.server.nodeId, stats: db.stats });
  });
  // 联邦全量数据：供同网络其他节点拉取合并（项目/校验码/用户/分集元数据/统计）
  // 设计：每条数据带 ownerNode 标识来源节点，接收方按 id 去重合并，避免循环传播
  app.get('/federate/all', (req, res) => {
    res.json({
      nodeId: db.server.nodeId, version: APP_VERSION,
      codes: db.server.codes, users: db.server.users,
      projects: db.projects, episodes: db.episodes, stats: db.stats
    });
  });
  // 联邦分集内容：按需拉取某分集的剧本/分镜内容（episodes/xxx.json）
  app.get('/federate/episode/:id/content', (req, res) => {
    const ep = db.episodes.find(x => x.id === req.params.id);
    if (!ep) return res.status(404).json({ error: '分集不存在' });
    const data = loadEpisode(ep.id);
    if (!data) return res.status(404).json({ error: '分集内容不存在' });
    res.json({ nodeId: db.server.nodeId, episodeId: ep.id, data });
  });
  // 联邦合并：接收其他节点推送的数据，按 id 去重只新增本机没有的（避免循环 + 数据互通）
  app.post('/federate/merge', (req, res) => {
    const body = req.body || {};
    let changed = { projects: 0, codes: 0, episodes: 0, stats: 0 };
    // 合并项目（按 id 去重）
    if (Array.isArray(body.projects)) {
      const ids = new Set(db.projects.map(p => p.id));
      for (const p of body.projects) {
        if (p && p.id && !ids.has(p.id)) {
          db.projects.push({
            id: p.id, name: p.name || '未命名', createdAt: p.createdAt || nowTs(), updatedAt: p.updatedAt || nowTs(),
            ownerNode: p.ownerNode || '', models: p.models || { text: [], image: [], video: [] }, assets: p.assets || emptyAssets()
          });
          changed.projects++;
        }
      }
    }
    // 合并校验码（按 id 去重；校验码是登录凭证，跨节点共享后新设备登录也能用）
    if (Array.isArray(body.codes)) {
      const ids = new Set(db.server.codes.map(c => c.id));
      for (const c of body.codes) {
        if (c && c.id && !ids.has(c.id)) {
          db.server.codes.push({
            id: c.id, code: c.code, name: c.name || '未命名', createdAt: c.createdAt || nowTs(),
            disabled: !!c.disabled, ownerNode: c.ownerNode || ''
          });
          changed.codes++;
        }
      }
    }
    // 合并分集元数据（按 id 去重；内容按需通过 /federate/episode/:id/content 拉取）
    if (Array.isArray(body.episodes)) {
      const ids = new Set(db.episodes.map(e => e.id));
      for (const e of body.episodes) {
        if (e && e.id && !ids.has(e.id)) {
          db.episodes.push({
            id: e.id, projectId: e.projectId, name: e.name || '未命名', order: e.order || 0,
            createdAt: e.createdAt || nowTs(), updatedAt: e.updatedAt || nowTs(),
            updatedBy: e.updatedBy || '', ownerNode: e.ownerNode || ''
          });
          changed.episodes++;
        }
      }
    }
    // 合并生成统计（按 id 去重；视频生成记录跨设备聚合，离线设备上线后自动补齐，无遗漏无重复）
    if (Array.isArray(body.stats)) {
      const ids = new Set(db.stats.map(s => s.id));
      for (const s of body.stats) {
        if (s && s.id && !ids.has(s.id)) {
          db.stats.push(s);
          changed.stats++;
        }
      }
    }
    if (changed.projects) saveKey('projects', 'projects.json');
    if (changed.codes) saveKey('server', 'server.json');
    if (changed.episodes) saveKey('episodes', 'episodes.json');
    if (changed.stats) saveKey('stats', 'stats.json');
    res.json({ ok: true, changed });
  });

  // ---------- 生成统计 ----------
  app.post('/api/stats', (req, res) => {
    const u = needUser(req, res); if (!u) return;
    const { projectId, episodeId, kind, resolution, durationSec, items } = req.body || {};
    const p = db.projects.find(x => x.id === projectId);
    const ep = db.episodes.find(x => x.id === episodeId);
    const usr = db.server.users.find(x => x.id === u.id);
    const codeObj = usr ? (db.server.codes.find(c => c.id === usr.codeId) || null) : null;
    const groupId = uid();
    const ts = nowTs();
    (items && items.length ? items : [{}]).forEach(it => {
      db.stats.push({
        id: uid(), groupId, ts, userId: u.id, userName: u.name,
        userCode: codeObj ? codeObj.code : '', codeName: codeObj ? codeObj.name : '',
        projectId, projectName: p ? p.name : '', episodeId, episodeName: ep ? ep.name : '',
        kind: kind || 'video', resolution: resolution || '', durationSec: Number(it.duration || durationSec || 0),
        shotId: it.shotId || '', shotIndex: (it.index === undefined ? 0 : it.index),
        shotText: String(it.text || '').slice(0, 60),
        nodeId: db.server.nodeId
      });
    });
    saveKey('stats', 'stats.json');
    res.json({ ok: true });
  });

  // ---------- 管理端 ----------
  app.get('/api/admin/data', (req, res) => {
    if (!needAdmin(req, res)) return;
    res.json({ codes: db.server.codes, users: db.server.users, projects: db.projects, episodes: db.episodes, stats: db.stats });
  });
  app.post('/api/admin/codes', (req, res) => {
    if (!needAdmin(req, res)) return;
    const name = String((req.body || {}).name || '').trim() || '未命名用户';
    const code = String((req.body || {}).code || '').trim().toUpperCase() || genCode();
    if (db.server.codes.some(c => c.code === code)) return res.status(400).json({ error: '该校验码已存在' });
    const c = { id: uid(), code, name, createdAt: nowTs(), disabled: false, ownerNode: db.server.nodeId };
    db.server.codes.push(c);
    saveKey('server', 'server.json');
    res.json({ ok: true, code: c });
  });
  app.delete('/api/admin/codes/:id', (req, res) => {
    if (!needAdmin(req, res)) return;
    db.server.codes = db.server.codes.filter(c => c.id !== req.params.id);
    saveKey('server', 'server.json');
    res.json({ ok: true });
  });
  app.post('/api/admin/projects', (req, res) => {
    if (!needAdmin(req, res)) return;
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: '请填写项目名称' });
    const p = { id: uid(), name, createdAt: nowTs(), updatedAt: nowTs(), ownerNode: db.server.nodeId, models: { text: [], image: [], video: [] }, assets: emptyAssets() };
    db.projects.push(p);
    saveKey('projects', 'projects.json');
    res.json({ ok: true, project: p });
  });
  app.put('/api/admin/projects/:id/models', (req, res) => {
    if (!needAdmin(req, res)) return;
    const p = db.projects.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '项目不存在' });
    const m = (req.body || {}).models || {};
    p.models = {
      text: Array.isArray(m.text) ? m.text : [],
      image: Array.isArray(m.image) ? m.image : [],
      video: Array.isArray(m.video) ? m.video.map(v => Object.assign({}, v, { type: v.type === 'firstlast' ? 'firstlast' : 'allref' })) : []
    };
    p.updatedAt = nowTs();
    saveKey('projects', 'projects.json');
    res.json({ ok: true });
  });
  app.delete('/api/admin/projects/:id', (req, res) => {
    if (!needAdmin(req, res)) return;
    const pid = req.params.id;
    const eps = db.episodes.filter(e => e.projectId === pid);
    eps.forEach(e => { try { fs.unlinkSync(epFile(e.id)); } catch (err) { } });
    db.episodes = db.episodes.filter(e => e.projectId !== pid);
    db.projects = db.projects.filter(p => p.id !== pid);
    saveKey('projects', 'projects.json'); saveKey('episodes', 'episodes.json');
    res.json({ ok: true });
  });

  // ---------- WebSocket 实时协作 ----------
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  // ws 库会把 http server 的 error（如端口占用 EADDRINUSE）转发到 wss 上；不监听会触发
  // "Unhandled 'error' event" 导致整个进程崩溃（端口退让逻辑也会失效），必须吞掉并仅记录日志
  wss.on('error', e => console.warn('WS server error:', (e && e.code) || (e && e.message) || e));
  const rooms = new Map(); // projectId -> Set<ws>
  function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { } }
  function broadcastRoom(pid, obj, exceptClientId) {
    const room = rooms.get(pid);
    if (!room) return;
    const raw = JSON.stringify(obj);
    room.forEach(ws => {
      if (exceptClientId && ws.info && ws.info.clientId === exceptClientId) return;
      try { ws.send(raw); } catch (e) { }
    });
  }
  function presenceOf(pid) {
    const room = rooms.get(pid);
    if (!room) return [];
    const seen = new Map();
    room.forEach(ws => {
      if (!ws.info) return;
      const key = ws.info.user.id + '|' + (ws.info.episodeId || '');
      if (!seen.has(key)) seen.set(key, { userId: ws.info.user.id, name: ws.info.user.name, episodeId: ws.info.episodeId });
    });
    return Array.from(seen.values());
  }
  function broadcastPresence(pid) { if (pid) broadcastRoom(pid, { t: 'presence', users: presenceOf(pid) }); }
  function joinRoom(ws, pid) {
    if (!pid) return;
    if (!rooms.has(pid)) rooms.set(pid, new Set());
    rooms.get(pid).add(ws);
  }
  function leaveRoom(ws) {
    if (!ws.info || !ws.info.projectId) return;
    const room = rooms.get(ws.info.projectId);
    if (room) { room.delete(ws); if (!room.size) rooms.delete(ws.info.projectId); }
  }
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const a = tokens.get(url.searchParams.get('token') || '');
    if (!a || a.kind !== 'user') { ws.close(4001, 'unauthorized'); return; }
    ws.info = { user: a, projectId: null, episodeId: null, clientId: uid() };
    send(ws, { t: 'welcome', clientId: ws.info.clientId, name: a.name });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.t === 'join') {
        leaveRoom(ws);
        ws.info.projectId = m.projectId;
        ws.info.episodeId = m.episodeId || null;
        joinRoom(ws, m.projectId);
        send(ws, { t: 'joined', clientId: ws.info.clientId });
        broadcastPresence(m.projectId);
      } else if (m.t === 'leave') {
        const pid = ws.info.projectId;
        leaveRoom(ws); ws.info.projectId = null; ws.info.episodeId = null;
        broadcastPresence(pid);
      } else if (m.t === 'ping') {
        send(ws, { t: 'pong', ts: nowTs() });
      } else if (m.t === 'op') {
        const pid = ws.info.projectId;
        if (!pid) return;
        try { applyOp(pid, m.op || {}, ws.info.user); } catch (e) { console.error('op', e.message); }
        broadcastRoom(pid, { t: 'op', op: m.op, from: { userId: ws.info.user.id, name: ws.info.user.name }, clientId: ws.info.clientId }, ws.info.clientId);
      } else if (m.t === 'asset:new' || m.t === 'asset:delete') {
        // 联邦：资产增删事件转发给同项目其他在线客户端（不落地本节点数据，
        // 由接收方根据来源 nodeId 决定是否拉取原图缓存到本机）
        const pid = ws.info.projectId;
        if (!pid) return;
        broadcastRoom(pid, Object.assign({}, m, { from: ws.info.user.name, fromClientId: ws.info.clientId }), ws.info.clientId);
      }
    });
    ws.on('close', () => { const pid = ws.info && ws.info.projectId; leaveRoom(ws); broadcastPresence(pid); });
  });
  // 服务端落地操作（防丢失）
  function applyOp(pid, op, user) {
    if (op.kind === 'shot-add' || op.kind === 'shot-update') {
      if (!op.episodeId || !op.shot) return;
      const ep = loadEpisode(op.episodeId); if (!ep) return;
      const i = ep.shots.findIndex(s => s.id === op.shot.id);
      if (op.kind === 'shot-add' && i < 0) ep.shots.push(op.shot);
      if (op.kind === 'shot-update' && i >= 0) ep.shots[i] = op.shot;
      saveEpisodeDebounced(op.episodeId, ep);
      touchEpisode(op.episodeId, user && user.name);
    } else if (op.kind === 'shot-delete') {
      if (!op.episodeId || !op.shotId) return;
      const ep = loadEpisode(op.episodeId); if (!ep) return;
      ep.shots = ep.shots.filter(s => s.id !== op.shotId);
      saveEpisodeDebounced(op.episodeId, ep);
      touchEpisode(op.episodeId, user && user.name);
    } else if (op.kind === 'shots-replace') {
      if (!op.episodeId || !Array.isArray(op.shots)) return;
      const ep = loadEpisode(op.episodeId); if (!ep) return;
      ep.shots = op.shots;
      if (op.script !== undefined) ep.script = op.script;
      saveEpisodeDebounced(op.episodeId, ep);
      touchEpisode(op.episodeId, user && user.name);
    } else if (op.kind === 'shot-reorder') {
      if (!op.episodeId || !Array.isArray(op.shotIds)) return;
      const ep = loadEpisode(op.episodeId); if (!ep) return;
      const map = new Map(ep.shots.map(s => [s.id, s]));
      ep.shots = op.shotIds.map(id => map.get(id)).filter(Boolean);
      saveEpisodeDebounced(op.episodeId, ep);
      touchEpisode(op.episodeId, user && user.name);
    } else if (op.kind === 'assets-update') {
      const p = db.projects.find(x => x.id === pid);
      if (p && op.assets) { p.assets = op.assets; p.updatedAt = nowTs(); saveKey('projects', 'projects.json'); }
    } else if (op.kind === 'episode-meta') {
      if (!op.episodeId) return;
      const ep = loadEpisode(op.episodeId); if (!ep) return;
      if (op.name !== undefined) ep.name = op.name;
      if (op.aspect !== undefined) ep.aspect = op.aspect;
      if (op.script !== undefined) ep.script = op.script;
      saveEpisodeDebounced(op.episodeId, ep);
      touchEpisode(op.episodeId, user && user.name);
    }
  }

  // 端口监听就绪（异步失败也 reject，让调用方能正确退让端口，避免"静默失败"）
  const ready = new Promise((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', err => { try { server.close(); } catch (e) { } reject(err); });
  });
  server.listen(port, '0.0.0.0');

  // 局域网自动发现：UDP 广播定时宣告本机 HTTP 地址，客户端扫描即可一键连接
  let udpSock = null;
  try {
    const dgram = require('dgram');
    udpSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udpSock.on('error', () => { try { udpSock.close(); } catch (e) {} });
    udpSock.on('message', (msg, rinfo) => {
      // 收到客户端探测请求 → 单播定向回送请求者（客户端不监听 3211，必须回送到其随机端口）
      if (msg.toString() === 'QK_DISCOVER') sendAnnounce(rinfo.address, rinfo.port);
    });
    udpSock.bind(3211, '0.0.0.0', () => {
      udpSock.setBroadcast(true);
      setInterval(sendBroadcast, 5000);   // 每 5 秒主动广播一次
      sendBroadcast();
    });
  } catch (e) { console.warn('UDP discover disabled:', e.message); }

  function getLanIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const n of (nets[name] || [])) {
        if (n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254')) return n.address;
      }
    }
    return '127.0.0.1';
  }

  const ipToInt = ip => ip.split('.').reduce((s, x) => ((s << 8) + parseInt(x, 10)) >>> 0, 0);
  const intToIp = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  // 广播目标：受限广播 + 每个网卡的定向广播（如 192.168.1.255）。
  // 多网卡环境（VMware/WSL/VPN 虚拟网卡）下 255.255.255.255 只从默认路由网卡发出，必须逐网卡定向广播
  function broadcastTargets() {
    const set = new Set(['255.255.255.255']);
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const n of (nets[name] || [])) {
        if (n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254') && n.netmask) {
          const bcast = intToIp((ipToInt(n.address) & ipToInt(n.netmask)) | (~ipToInt(n.netmask) >>> 0));
          if (bcast !== n.address) set.add(bcast);
        }
      }
    }
    return Array.from(set);
  }

  function makePayload() {
    const ip = getLanIP();
    return JSON.stringify({
      app: 'qiankun-design', version: APP_VERSION,
      http: 'http://' + ip + ':' + port, ip, port,
      nodeId: db.server.nodeId,                    // 联邦同步识别节点
      projects: db.projects.length, episodes: db.episodes.length,
      ts: Date.now()
    });
  }

  function sendBroadcast() {
    if (!udpSock) return;
    try {
      const payload = makePayload();
      for (const t of broadcastTargets()) udpSock.send(payload, 3211, t);
    } catch (e) { }
  }

  function sendAnnounce(host, port2) {
    if (!udpSock) return;
    try { udpSock.send(makePayload(), port2, host); } catch (e) { }
  }

  return { server, app, wss, port, dataDir, ready, nodeId: db.server.nodeId, close: () => { try { udpSock && udpSock.close(); } catch (e) {} try { server.close(); } catch (e) {} } };
}

module.exports = { createServer, ADMINS, APP_VERSION };

// 独立运行：node server.js [port]
if (require.main === module) {
  const port = parseInt(process.argv[2] || process.env.PORT || '3210', 10);
  createServer(path.join(__dirname, 'server-data'), port);
  console.log('☯ 乾坤设计协作服务已启动: http://localhost:' + port);
  console.log('  数据目录: ' + path.join(__dirname, 'server-data'));
}
