// 乾坤设计 - 服务端 API 客户端（REST + WebSocket 实时协作）
'use strict';

function apiFetch(base, path, opts) {
  return fetch(base.replace(/\/+$/, '') + path, opts).then(async r => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('请求失败 HTTP ' + r.status));
    return d;
  });
}

class Api {
  constructor(base, token) { this.base = base || ''; this.token = token || ''; }
  headers(json) {
    const h = { Authorization: 'Bearer ' + this.token };
    if (json !== false) h['Content-Type'] = 'application/json';
    return h;
  }
  health() { return apiFetch(this.base, '/api/health', { headers: this.headers() }); }
  login(code) { return apiFetch(this.base, '/api/login', { method: 'POST', headers: this.headers(), body: JSON.stringify({ code }) }); }
  adminLogin(username, password) { return apiFetch(this.base, '/api/admin/login', { method: 'POST', headers: this.headers(), body: JSON.stringify({ username, password }) }); }

  projects() { return apiFetch(this.base, '/api/projects', { headers: this.headers() }); }
  project(id) { return apiFetch(this.base, '/api/projects/' + id, { headers: this.headers() }); }
  createEpisode(pid, name) { return apiFetch(this.base, '/api/projects/' + pid + '/episodes', { method: 'POST', headers: this.headers(), body: JSON.stringify({ name }) }); }
  episode(id) { return apiFetch(this.base, '/api/episodes/' + id, { headers: this.headers() }); }
  saveEpisode(id, data) { return apiFetch(this.base, '/api/episodes/' + id + '/save', { method: 'POST', headers: this.headers(), body: JSON.stringify(data) }); }
  upload(name, dataBase64) { return apiFetch(this.base, '/api/upload', { method: 'POST', headers: this.headers(), body: JSON.stringify({ name, dataBase64 }) }); }

  aiText(projectId, modelId, messages, jsonMode) { return apiFetch(this.base, '/api/ai/text', { method: 'POST', headers: this.headers(), body: JSON.stringify({ projectId, modelId, messages, jsonMode }) }); }
  aiImage(projectId, modelId, prompt, aspect) { return apiFetch(this.base, '/api/ai/image', { method: 'POST', headers: this.headers(), body: JSON.stringify({ projectId, modelId, prompt, aspect }) }); }
  aiVideo(projectId, modelId, prompt, aspect, firstFrame, lastFrame, duration, refImages, audio) { return apiFetch(this.base, '/api/ai/video', { method: 'POST', headers: this.headers(), body: JSON.stringify({ projectId, modelId, prompt, aspect, firstFrame, lastFrame, duration, refImages, audio }) }); }

  stats(payload) { return apiFetch(this.base, '/api/stats', { method: 'POST', headers: this.headers(), body: JSON.stringify(payload) }); }

  adminData() { return apiFetch(this.base, '/api/admin/data', { headers: this.headers() }); }
  adminCreateCode(name, code) { return apiFetch(this.base, '/api/admin/codes', { method: 'POST', headers: this.headers(), body: JSON.stringify({ name, code }) }); }
  adminDeleteCode(id) { return apiFetch(this.base, '/api/admin/codes/' + id, { method: 'DELETE', headers: this.headers() }); }
  adminCreateProject(name) { return apiFetch(this.base, '/api/admin/projects', { method: 'POST', headers: this.headers(), body: JSON.stringify({ name }) }); }
  adminSaveModels(pid, models) { return apiFetch(this.base, '/api/admin/projects/' + pid + '/models', { method: 'PUT', headers: this.headers(), body: JSON.stringify({ models }) }); }
  adminDeleteProject(pid) { return apiFetch(this.base, '/api/admin/projects/' + pid, { method: 'DELETE', headers: this.headers() }); }

  assetsSave(pid, assets) { return apiFetch(this.base, '/api/projects/' + pid + '/assets/save', { method: 'POST', headers: this.headers(), body: JSON.stringify({ assets }) }); }

  abs(u) { return u ? this.base.replace(/\/+$/, '') + u : ''; }

  // ---------- 联邦同步：跨节点资产共享 ----------
  // 调用任意节点（含本机）的联邦接口；base 参数为目标节点 HTTP 地址
  federateInfo(base) { return apiFetch(base, '/federate/info', { headers: this.headers() }); }
  federateProjectAssets(base, pid) { return apiFetch(base, '/federate/projects/' + pid + '/assets', { headers: this.headers() }); }
  federateStats(base) { return apiFetch(base, '/federate/stats', { headers: this.headers() }); }
  // 联邦全量数据：拉取某节点所有项目/校验码/分集元数据/统计（供本机合并，达到跨节点互通）
  federateAll(base) { return apiFetch(base, '/federate/all', { headers: this.headers() }); }
  // 联邦分集内容：按需拉取某分集的剧本/分镜内容
  federateEpisodeContent(base, eid) { return apiFetch(base, '/federate/episode/' + eid + '/content', { headers: this.headers() }); }
  // 联邦合并：把收集到的其他节点数据推送到本机服务器（按 id 去重，只新增本机没有的）
  federateMerge(payload) { return apiFetch(this.base, '/federate/merge', { method: 'POST', headers: this.headers(), body: JSON.stringify(payload) }); }
  // 拉取远程资产原图并转 base64（不通过 Api.headers，因为返回的是二进制）
  // field: 'img'（默认）或 'audio'——指定拉取资产的哪个文件
  async federateFetchBlobBase64(base, assetId, field) {
    const q = field ? '?field=' + encodeURIComponent(field) : '';
    const r = await fetch(base.replace(/\/+$/, '') + '/federate/asset/' + encodeURIComponent(assetId) + '/blob' + q);
    if (!r.ok) throw new Error('拉取原图失败 HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    // 二进制 → base64
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
}

// ---------- WebSocket 实时协作 ----------
class Collab {
  constructor() { this.ws = null; this.clientId = null; this.onOp = null; this.onPresence = null; this.onClose = null; this.onAssetEvent = null; this.alive = false; }
  connect(base, token) {
    this.close();
    const wsBase = base.replace(/^http/, 'ws').replace(/\/+$/, '');
    this.ws = new WebSocket(wsBase + '/ws?token=' + encodeURIComponent(token));
    this.ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'welcome') { this.clientId = m.clientId; this.alive = true; }
      else if (m.t === 'op' && this.onOp) this.onOp(m);
      else if (m.t === 'presence' && this.onPresence) this.onPresence(m.users || []);
      else if ((m.t === 'asset:new' || m.t === 'asset:delete') && this.onAssetEvent) this.onAssetEvent(m);
    };
    this.ws.onclose = () => { this.alive = false; if (this.onClose) this.onClose(); };
    this.ws.onerror = () => { };
    // 心跳
    clearInterval(this._hb);
    this._hb = setInterval(() => { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'ping' })); }, 25000);
  }
  join(projectId, episodeId) { this._send({ t: 'join', projectId, episodeId }); }
  leave() { this._send({ t: 'leave' }); }
  sendOp(op) { this._send({ t: 'op', op }); }
  sendAssetEvent(obj) { this._send(obj); }
  _send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  close() { clearInterval(this._hb); if (this.ws) { try { this.ws.close(); } catch (e) { } this.ws = null; } this.alive = false; }
}
