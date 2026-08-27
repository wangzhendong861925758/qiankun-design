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
  aiVideo(projectId, modelId, prompt, aspect, firstFrame, lastFrame) { return apiFetch(this.base, '/api/ai/video', { method: 'POST', headers: this.headers(), body: JSON.stringify({ projectId, modelId, prompt, aspect, firstFrame, lastFrame }) }); }

  stats(payload) { return apiFetch(this.base, '/api/stats', { method: 'POST', headers: this.headers(), body: JSON.stringify(payload) }); }

  adminData() { return apiFetch(this.base, '/api/admin/data', { headers: this.headers() }); }
  adminCreateCode(name, code) { return apiFetch(this.base, '/api/admin/codes', { method: 'POST', headers: this.headers(), body: JSON.stringify({ name, code }) }); }
  adminDeleteCode(id) { return apiFetch(this.base, '/api/admin/codes/' + id, { method: 'DELETE', headers: this.headers() }); }
  adminCreateProject(name) { return apiFetch(this.base, '/api/admin/projects', { method: 'POST', headers: this.headers(), body: JSON.stringify({ name }) }); }
  adminSaveModels(pid, models) { return apiFetch(this.base, '/api/admin/projects/' + pid + '/models', { method: 'PUT', headers: this.headers(), body: JSON.stringify({ models }) }); }
  adminDeleteProject(pid) { return apiFetch(this.base, '/api/admin/projects/' + pid, { method: 'DELETE', headers: this.headers() }); }

  abs(u) { return u ? this.base.replace(/\/+$/, '') + u : ''; }
}

// ---------- WebSocket 实时协作 ----------
class Collab {
  constructor() { this.ws = null; this.clientId = null; this.onOp = null; this.onPresence = null; this.onClose = null; this.alive = false; }
  connect(base, token) {
    this.close();
    const wsBase = base.replace(/^http/, 'ws').replace(/\/+$/, '');
    this.ws = new WebSocket(wsBase + '/ws?token=' + encodeURIComponent(token));
    this.ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'welcome') { this.clientId = m.clientId; this.alive = true; }
      else if (m.t === 'op' && this.onOp) this.onOp(m);
      else if (m.t === 'presence' && this.onPresence) this.onPresence(m.users || []);
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
  _send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  close() { clearInterval(this._hb); if (this.ws) { try { this.ws.close(); } catch (e) { } this.ws = null; } this.alive = false; }
}
