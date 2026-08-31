// 乾坤设计 v3 - 客户端主逻辑（深色专业版）
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtTime = ts => { if (!ts) return '-'; const d = new Date(ts); return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const fmtDur = s => { s = Math.round(Number(s) || 0); return Math.floor(s / 60) + '分' + String(s % 60).padStart(2, '0') + '秒'; };
const avatarColor = (name) => {
  const colors = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#6366f1'];
  let h = 0; for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
};
const firstChar = n => String(n || '?').charAt(0).toUpperCase();

const S = {
  base: localStorage.getItem('qk_base') || 'http://localhost:3210',
  token: '', user: null, admin: null,
  api: null, collab: new Collab(),
  page: 'login', loginMode: 'user',
  projects: [], project: null, episodes: [], episode: null, data: null,
  assetTab: 'characters', workTab: 'mine', projTab: 'works',
  sel: { text: '', image: '', video: '' },
  selectedShotId: '', charFilter: '',
  composing: false, updateReady: null, wsRetryTimer: null,
  stylePickerOpen: false
};
const VOICES = [
  ['zh-CN-XiaoxiaoNeural', '晓晓(女·温柔)'], ['zh-CN-YunxiNeural', '云希(男·阳光)'], ['zh-CN-YunyangNeural', '云扬(男·沉稳)'],
  ['zh-CN-XiaoyiNeural', '晓伊(女·活泼)'], ['zh-CN-YunjianNeural', '云健(男·浑厚)'], ['zh-CN-liaoning-XiaobeiNeural', '小北(东北)'],
  ['zh-TW-HsiaoChenNeural', '晓臻(台湾)'], ['zh-HK-HiuMaanNeural', '曉曼(粤语)']
];
const STYLES = [
  ['国漫风', '国漫风格，线条细腻，色彩明快'],
  ['日漫风', '日本动漫风格，赛璐璐上色，清新唯美'],
  ['美漫风', '美式漫画风格，线条硬朗，对比强烈'],
  ['写实电影', '写实电影质感，光影真实，电影级构图'],
  ['3D渲染', '3D卡通渲染，皮克斯风格，立体圆润'],
  ['水墨画', '中国水墨画风，留白意境，笔墨晕染'],
  ['赛博朋克', '赛博朋克风格，霓虹光效，未来都市'],
  ['像素风', '像素艺术风格，复古游戏画面']
];
const EXAMPLE_TEXTS = [
  ['星星邮递员', '一只小白兔迷路后遇到森林朋友，经历冒险最终回家的温馨故事。'],
  ['赛博都市', '2077年的霓虹都市，一名女黑客发现了公司背后的巨大阴谋。赛博朋克风格，紧张刺激。'],
  ['江湖侠客', '古代江湖中，少年剑客为报师仇踏上旅途，最终领悟剑道真谛。水墨武侠风格。'],
  ['校园青春', '高中校园里，转学生与班长从误会到成为挚友的青春故事。日漫清新风格。']
];

function toast(msg, type, ms) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(() => el.remove(), ms || 2600);
}
function openModal(title, html, wide) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modalBox').classList.toggle('modal-wide', !!wide);
  $('#modalMask').classList.remove('hidden');
}
function closeModal() { $('#modalMask').classList.add('hidden'); $('#modalBody').innerHTML = ''; }

function showPage(name) {
  S.page = name;
  ['login', 'projects', 'episodes', 'setup', 'editor', 'admin'].forEach(p => {
    $('#page-' + p).classList.toggle('hidden', p !== name);
  });
}

function pickFile(accept) {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept || '';
    inp.onchange = () => {
      const f = inp.files[0];
      if (!f) return resolve(null);
      const fr = new FileReader();
      fr.onload = () => resolve({ name: f.name, dataBase64: String(fr.result).split(',')[1] });
      fr.readAsDataURL(f);
    };
    inp.click();
  });
}
async function uploadPicked(accept) {
  const f = await pickFile(accept);
  if (!f) return null;
  const r = await S.api.upload(f.name, f.dataBase64);
  return r.url;
}
function extractJSON(text) {
  const t = String(text || '').trim();
  const tryParse = s => { try { return JSON.parse(s); } catch (e) { return undefined; } };
  let r = tryParse(t);
  if (r) return r;
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { r = tryParse(m[1].trim()); if (r) return r; }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { r = tryParse(t.slice(a, b + 1)); if (r) return r; }
  throw new Error('AI 返回的不是有效 JSON');
}

// 登录页
function initLogin() {
  $('#loginServer').value = S.base;
  $$('.login-tab').forEach(t => t.onclick = () => {
    $$('.login-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    S.loginMode = t.dataset.mode;
    $('#loginUserBox').classList.toggle('hidden', S.loginMode !== 'user');
    $('#loginAdminBox').classList.toggle('hidden', S.loginMode !== 'admin');
  });
  $('#loginCode').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('#loginAdminPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('#btnLogin').onclick = doLogin;
}
async function doLogin() {
  const base = $('#loginServer').value.trim().replace(/\/+$/, '');
  const hint = $('#loginHint');
  hint.textContent = '';
  if (!/^https?:\/\/.+/.test(base)) { hint.textContent = '服务器地址格式不正确'; return; }
  $('#btnLogin').disabled = true; $('#btnLogin').textContent = '连接中…';
  try {
    const probe = new Api(base, '');
    await probe.health();
    if (S.loginMode === 'user') {
      const code = $('#loginCode').value.trim();
      if (!code) { hint.textContent = '请输入校验码'; return; }
      const r = await probe.login(code);
      S.base = base; S.token = r.token; S.user = r.user;
      localStorage.setItem('qk_base', base);
      S.api = new Api(base, r.token);
      initCollab();
      await loadProjects();
    } else {
      const u = $('#loginAdminUser').value.trim(), p = $('#loginAdminPass').value;
      if (!u || !p) { hint.textContent = '请输入管理员账号和密码'; return; }
      const r = await probe.adminLogin(u, p);
      S.base = base; S.token = r.token; S.admin = r.admin;
      localStorage.setItem('qk_base', base);
      S.api = new Api(base, r.token);
      enterAdmin();
    }
  } catch (e) {
    const msg = String(e.message || e);
    hint.textContent = /failed to fetch|networkerror|load failed/i.test(msg)
      ? '无法连接服务器，请检查地址是否正确'
      : (msg || '连接失败');
  } finally {
    $('#btnLogin').disabled = false; $('#btnLogin').textContent = '登 录';
  }
}

// 项目列表页（图1）
async function loadProjects() {
  S.projects = await S.api.projects();
  renderProjects();
  showPage('projects');
}
function renderProjects() {
  const recentWrap = $('#projCards');
  const tbody = $('#workListBody');
  const recent = S.projects.slice(0, 6);
  recentWrap.innerHTML = recent.map(p => `
    <div class="proj-card-sm" data-id="${p.id}">
      <div class="pc-ai-badge">AI</div>
      <div class="pc-avatar" style="background:${avatarColor(p.name)}">
        <span>${esc(firstChar(p.name))}</span>
        <div class="badge-1">${p.episodeCount || 0}</div>
      </div>
      <div class="pc-info">
        <h3>${esc(p.name)}</h3>
        <div class="pc-meta">
          <div>🎬 ${p.episodeCount || 0} 集</div>
          <div>🕐 ${fmtTime(p.updatedAt)}</div>
          <div class="owner">👤 ${esc(p.creatorName || '管理员')}</div>
        </div>
      </div>
    </div>
  `).join('');
  $$('#projCards .proj-card-sm').forEach(c => c.onclick = () => openProject(c.dataset.id));
  const rows = S.projects.map(p => `
    <tr data-id="${p.id}">
      <td><span class="type-tag">AI生成</span></td>
      <td class="proj-cell">
        <span class="mini-avatar" style="background:${avatarColor(p.name)}">${esc(firstChar(p.name))}</span>
        <span class="name-cell">${esc(p.name)}</span>
      </td>
      <td>${p.episodeCount || 0}集</td>
      <td><span class="avatar-circle">👤</span></td>
      <td class="time-cell">${fmtTime(p.updatedAt)}</td>
      <td>-</td>
      <td>16:9</td>
      <td>-</td>
      <td class="op-cell"><span class="op-link" data-act="open">打开</span></td>
    </tr>
  `).join('');
  tbody.innerHTML = rows || `<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text3)">暂无项目</td></tr>`;
  $$('#workListBody tr').forEach(tr => {
    tr.onclick = () => openProject(tr.dataset.id);
  });
}

// 项目详情页（图2）
async function openProject(id) {
  try {
    const r = await S.api.project(id);
    S.project = r.project; S.episodes = r.episodes;
    $('#epProjAvatar').textContent = firstChar(S.project.name);
    $('#epProjAvatar').style.background = avatarColor(S.project.name);
    $('#epProjName').textContent = S.project.name;
    $('#epProjOwner').textContent = S.project.creatorName || '管理员';
    $('#epProjDesc').textContent = '🎬 ' + S.episodes.length + ' 集 · 更新于 ' + fmtTime(S.project.updatedAt);
    renderEpisodes();
    showPage('episodes');
  } catch (e) { toast(e.message, 'err'); }
}
function renderEpisodes() {
  const tbody = $('#epListBody');
  const rows = S.episodes.map((e2, i) => `
    <tr data-id="${e2.id}">
      <td class="proj-cell">
        <span class="mini-avatar" style="background:${avatarColor(e2.name)}">${i + 1}</span>
        <span class="name-cell">${esc(e2.name)}</span>
      </td>
      <td>-</td>
      <td>-</td>
      <td>${esc(e2.updatedBy || (S.user ? S.user.name : ''))}</td>
      <td>16:9</td>
      <td>-</td>
      <td class="time-cell">${fmtTime(e2.createdAt)}</td>
      <td class="time-cell">${fmtTime(e2.updatedAt)}</td>
      <td>-</td>
      <td class="op-cell"><span class="op-link" data-act="open">打开</span></td>
    </tr>
  `).join('');
  tbody.innerHTML = rows || `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text3)">还没有分集，点击右上角「创建作品」开始创作</td></tr>`;
  $$('#epListBody tr').forEach(tr => {
    tr.onclick = () => openEpisode(tr.dataset.id);
  });
}
function newEpisode() {
  const count = S.episodes.length;
  const defName = '第' + (count + 1) + '集';
  openModal('新建作品', `
    <div class="form-row"><label>作品名称</label><input id="neName" value="${esc(defName)}"></div>
    <div class="modal-foot-btns">
      <button class="btn ghost" id="neCancel">取消</button>
      <button class="btn primary" id="neCreate">创建并进入编辑</button>
    </div>`);
  const inp = $('#neName');
  inp.focus(); inp.select();
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') $('#neCreate').click(); });
  $('#neCancel').onclick = closeModal;
  $('#neCreate').onclick = async () => {
    const name = $('#neName').value.trim() || defName;
    const btn = $('#neCreate');
    btn.disabled = true; btn.textContent = '创建中…';
    try {
      const r = await S.api.createEpisode(S.project.id, name);
      closeModal();
      await openProject(S.project.id);
      toast('已创建', 'ok');
      openEpisode(r.episode.id);
    } catch (e) {
      toast(e.message, 'err', 4000);
      btn.disabled = false; btn.textContent = '创建并进入编辑';
    }
  };
}

// 编辑器入口
function videoMode() {
  const vm = (S.project.models.video || []).find(m => m.id === S.sel.video);
  return vm ? (vm.type || 'allref') : 'allref';
}
async function openEpisode(id) {
  try {
    const r = await S.api.episode(id);
    S.episode = r.episode;
    S.data = Object.assign({ aspect: '16:9', style: '国漫风', script: '', require: '', shots: [] }, r.data);
    if (!Array.isArray(S.data.shots)) S.data.shots = [];
    // 从服务端刷新项目共享资产（其他成员添加的资产进入时即可见）
    try {
      const pr = await S.api.project(S.project.id);
      if (pr.project && pr.project.assets) S.project.assets = pr.project.assets;
    } catch (e2) { }
    $('#edEpisodeName').textContent = S.project.name + ' · ' + S.episode.name;
    const saved = JSON.parse(localStorage.getItem('qk_sel_' + S.project.id) || '{}');
    S.sel = { text: saved.text || '', image: saved.image || '', video: saved.video || '' };
    renderModelSels();
    S.collab.connect(S.base, S.token);
    S.collab.join(S.project.id, S.episode.id);
    setSaveState(true);
    // 首次进入（无分镜且无剧本）弹出解析剧本页；再次进入保留上次操作，直接进编辑器
    if (!S.data.shots.length && !S.data.script) showSetup();
    else enterEditorPage();
  } catch (e) { toast(e.message, 'err'); }
}

// 剧本分解页（图3）
function showSetup() {
  renderSetup();
  showPage('setup');
}
function renderSetup() {
  $('#setupScript').value = S.data.script || '';
  $('#setupRequire').value = S.data.require || '';
  $('#setupCharCount').textContent = (S.data.script || '').length;
  $('#setupReqCount').textContent = (S.data.require || '').length;
  $$('.aspect-btn').forEach(b => b.classList.toggle('active', b.dataset.v === (S.data.aspect || '16:9')));
  const chips = $('#styleChips');
  chips.innerHTML = STYLES.map(([name]) =>
    `<button class="style-chip${S.data.style === name ? ' active' : ''}" data-style="${esc(name)}">${esc(name)}</button>`).join('');
  $$('#styleChips .style-chip').forEach(c => c.onclick = () => {
    S.data.style = c.dataset.style;
    emitOp({ kind: 'episode-meta', episodeId: S.episode.id, style: S.data.style });
    $$('#styleChips .style-chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
  });
  $$('.example-tag').forEach(b => b.onclick = () => {
    const text = b.dataset.text;
    if (text) {
      $('#setupScript').value = text;
      S.data.script = text;
      $('#setupCharCount').textContent = text.length;
      emitOp({ kind: 'episode-meta', episodeId: S.episode.id, script: text });
    }
  });
  const n = S.data.shots.length;
  $('#btnSkipParse').textContent = n ? '跳过解析' : '跳过解析';
  $('#setupHint').textContent = n ? '已有 ' + n + ' 个分镜，重新解析将覆盖。' : '';
}
function enterEditorPage() {
  renderEditor();
  showPage('editor');
}
async function skipParse() {
  S.data.script = $('#setupScript').value;
  S.data.require = $('#setupRequire').value;
  emitOp({ kind: 'episode-meta', episodeId: S.episode.id, script: S.data.script, require: S.data.require });
  flushOps();
  // 跳过解析且无分镜时，创建一个空白分镜供用户自行编辑
  if (!S.data.shots.length) addShot('__first__');
  enterEditorPage();
}
function renderModelSels() {
  const mk = (elId, list, key, label) => {
    const el = $(elId);
    if (!el) return;
    if (!list.length) { el.innerHTML = '<option value="">未配置</option>'; el.disabled = true; return; }
    if (!list.some(m => m.id === S.sel[key])) S.sel[key] = list[0].id;
    el.innerHTML = list.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    el.value = S.sel[key];
    el.disabled = false;
    el.onchange = () => {
      S.sel[key] = el.value;
      localStorage.setItem('qk_sel_' + S.project.id, JSON.stringify(S.sel));
      if (key === 'video') renderShots();
    };
  };
  mk('#selTextModel', S.project.models.text || [], 'text', '文本');
  mk('#selImageModel', S.project.models.image || [], 'image', '图片');
  mk('#selVideoModel', S.project.models.video || [], 'video', '视频');
}
function renderEditor() {
  renderShots();
  renderCharPanel();
}
function shotById(id) { return S.data.shots.find(s => s.id === id); }
function assetsOf(kind) { return (S.project.assets && S.project.assets[kind]) || []; }
function getAppeared(kind) {
  if (kind === 'characters') {
    const ids = new Set();
    S.data.shots.forEach(s => (s.characterIds || []).forEach(id => ids.add(id)));
    return (S.project.assets?.characters || []).filter(c => ids.has(c.id));
  }
  if (kind === 'scenes') {
    const ids = new Set();
    S.data.shots.forEach(s => { if (s.sceneId) ids.add(s.sceneId); });
    return (S.project.assets?.scenes || []).filter(c => ids.has(c.id));
  }
  if (kind === 'props') {
    const ids = new Set();
    S.data.shots.forEach(s => (s.propIds || []).forEach(id => ids.add(id)));
    return (S.project.assets?.props || []).filter(c => ids.has(c.id));
  }
  if (kind === 'others') {
    const ids = new Set();
    S.data.shots.forEach(s => (s.otherIds || []).forEach(id => ids.add(id)));
    return (S.project.assets?.others || []).filter(c => ids.has(c.id));
  }
  return [];
}
function getUnused(kind) {
  if (kind === 'characters') {
    const ids = new Set();
    S.data.shots.forEach(s => (s.characterIds || []).forEach(id => ids.add(id)));
    return (S.project.assets?.characters || []).filter(c => !ids.has(c.id));
  }
  if (kind === 'scenes') {
    const ids = new Set();
    S.data.shots.forEach(s => { if (s.sceneId) ids.add(s.sceneId); });
    return (S.project.assets?.scenes || []).filter(c => !ids.has(c.id));
  }
  if (kind === 'props') {
    const ids = new Set();
    S.data.shots.forEach(s => (s.propIds || []).forEach(id => ids.add(id)));
    return (S.project.assets?.props || []).filter(c => !ids.has(c.id));
  }
  if (kind === 'others') {
    const ids = new Set();
    S.data.shots.forEach(s => (s.otherIds || []).forEach(id => ids.add(id)));
    return (S.project.assets?.others || []).filter(c => !ids.has(c.id));
  }
  return [];
}
function getAssetIdsForShot(s, kind) {
  if (kind === 'characters') return s.characterIds || [];
  if (kind === 'scenes') return s.sceneId ? [s.sceneId] : [];
  if (kind === 'props') return s.propIds || [];
  if (kind === 'others') return s.otherIds || [];
  return [];
}
function setAssetIdsForShot(s, kind, ids) {
  if (kind === 'characters') s.characterIds = ids;
  else if (kind === 'scenes') s.sceneId = ids[0] || '';
  else if (kind === 'props') s.propIds = ids;
  else if (kind === 'others') s.otherIds = ids;
}
function assetThumb(a) {
  if (a.img) return `<img src="${esc(S.api.abs(a.img))}">`;
  return `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:${avatarColor(a.name)};font-size:16px;font-weight:700;color:#fff">${esc(firstChar(a.name))}</div>`;
}

// 分镜渲染（九列横排）
function renderShots() {
  const body = $('#shotsWrap');
  const A = S.project.assets || { characters: [], scenes: [], props: [], others: [], sfx: [] };
  if (!S.data.shots.length) {
    body.innerHTML = `<div class="story-empty">
      暂无分镜<br><br>可在上方「解析剧本」AI 拆解，或直接创建空白分镜自行编辑<br><br>
      <button class="add-shot-btn" data-act="insert-after" data-sid="__first__">＋ 新建分镜</button>
    </div>`;
    return;
  }
  body.innerHTML = S.data.shots.map((s, i) => {
    return `
    <div class="shot-row" data-id="${s.id}">
      <div class="sr-cell sr-no">
        <input type="checkbox">
        <div class="sr-no-num">${i + 1}</div>
        <div class="sr-lock">🔓</div>
      </div>
      <div class="sr-cell sr-script">
        <div class="script-hl" data-hl="${s.id}">${scriptHighlightHTML(s.text || '', A)}</div>
        <textarea data-f="text" data-sid="${s.id}" placeholder="输入画面描述...">${esc(s.text)}</textarea>
      </div>
      <div class="sr-cell sr-chars"><div class="thumb-grid">${charThumbsHTML(s, A)}</div></div>
      <div class="sr-cell sr-scene"><div class="thumb-grid">${sceneThumbHTML(s, A)}</div></div>
      <div class="sr-cell sr-props"><div class="thumb-grid">${propThumbsHTML(s, A)}</div></div>
      <div class="sr-cell sr-others"><div class="thumb-grid">${otherThumbsHTML(s, A)}</div></div>
      <div class="sr-cell sr-aux">
        <button class="aux-btn" data-act="gen-img" data-sid="${s.id}">🖼 AI生图</button>
        <button class="aux-btn" data-act="upload-frame" data-sid="${s.id}" data-field="storyboardImg">⬆ 上传分镜图</button>
        <button class="aux-btn" data-act="gen-voice" data-sid="${s.id}">🎙 AI配音</button>
        <button class="aux-btn" data-act="upload-voice" data-sid="${s.id}">🎵 上传配音</button>
        ${s.voiceUrl ? `<button class="aux-btn" data-act="play-voice" data-url="${S.api.abs(s.voiceUrl)}">🔊 试听配音</button>` : ''}
      </div>
      <div class="sr-cell sr-img"><div class="frame-imgs">${frameSlotHTML(s, 'storyboardImg', '图', true)}${frameSlotHTML(s, 'lastImg', '尾', false)}</div></div>
      <div class="sr-cell sr-video">
        ${videoSlotHTML(s)}
        <button class="gen-video-btn" data-act="gen-video-btn" data-sid="${s.id}">${s.videoUrl ? '重新生成' : '生成本镜视频'}</button>
      </div>
      <div class="sr-cell sr-ops">
        <button class="sr-ops-btn" data-act="up" data-sid="${s.id}">↑</button>
        <button class="sr-ops-btn" data-act="del" data-sid="${s.id}">✕</button>
      </div>
    </div>
    <div class="shot-insert" data-act="insert-after" data-sid="${s.id}" title="在此下方新建分镜"><span class="si-btn">＋</span><span class="si-txt">新建分镜</span></div>`;
  }).join('');
  // 播放上传的配音
  body.querySelectorAll('[data-act="play-voice"]').forEach(el => el.onclick = () => {
    const u = el.dataset.url;
    openModal('试听配音', `<audio src="${esc(u)}" controls autoplay style="width:100%"></audio>`, true);
  });
}

// ---- 各单元格HTML（供整行渲染与局部刷新共用）----
function charThumbsHTML(s, A) {
  const list = (s.characterIds || []).map(id => (A.characters || []).find(c => c.id === id)).filter(Boolean);
  return list.slice(0, 3).map(c => `
    <div class="thumb-item" data-act="pick-char" data-sid="${s.id}" data-cid="${c.id}">${assetThumb(c)}</div>
  `).join('') + `<div class="thumb-item" data-act="add-char" data-sid="${s.id}"><div class="thumb-add">+</div>${list.length ? `<div class="badge-cnt">${list.length}</div>` : ''}</div>`;
}
function sceneThumbHTML(s, A) {
  const scene = (A.scenes || []).find(c => c.id === s.sceneId);
  return scene ? `
    <div class="thumb-item" data-act="pick-scene" data-sid="${s.id}" data-cid="${scene.id}">${assetThumb(scene)}</div>
  ` : `<div class="thumb-item" data-act="add-scene" data-sid="${s.id}"><div class="thumb-add">+</div></div>`;
}
function propThumbsHTML(s, A) {
  const list = (s.propIds || []).map(id => (A.props || []).find(c => c.id === id)).filter(Boolean);
  return list.slice(0, 3).map(p => `
    <div class="thumb-item" data-act="pick-prop" data-sid="${s.id}" data-cid="${p.id}">${assetThumb(p)}</div>
  `).join('') + `<div class="thumb-item" data-act="add-prop" data-sid="${s.id}"><div class="thumb-add">+</div></div>`;
}
function otherThumbsHTML(s, A) {
  const list = (s.otherIds || []).map(id => (A.others || []).find(c => c.id === id)).filter(Boolean);
  return list.slice(0, 3).map(o => `
    <div class="thumb-item" data-act="pick-other" data-sid="${s.id}" data-cid="${o.id}">${assetThumb(o)}</div>
  `).join('') + `<div class="thumb-item" data-act="add-other" data-sid="${s.id}"><div class="thumb-add">+</div></div>`;
}
function frameSlotHTML(s, field, badge, canGen) {
  const url = field === 'storyboardImg' ? (s.storyboardImg || s.firstImg) : s.lastImg;
  if (url) return `
    <div class="frame-slot-sm" data-act="preview" data-url="${S.api.abs(url)}">
      <img src="${esc(S.api.abs(url))}"><div class="badge-cnt">${badge}</div>
      <button class="fs-upload" data-act="upload-frame" data-sid="${s.id}" data-field="${field}" title="上传替换">⬆</button>
    </div>`;
  return `
    <div class="frame-slot-sm frame-slot-empty">
      ${canGen ? `<button class="fs-act" data-act="gen-img" data-sid="${s.id}" title="AI生成">✨</button>` : ''}
      ${!canGen ? `<button class="fs-act" data-act="gen-last" data-sid="${s.id}" title="AI生成">✨</button>` : ''}
      <button class="fs-act" data-act="upload-frame" data-sid="${s.id}" data-field="${field}" title="上传图片">⬆</button>
    </div>`;
}
function videoSlotHTML(s) {
  if (s.videoUrl) return `
    <div class="video-slot" data-act="play" data-url="${S.api.abs(s.videoUrl)}">
      <video preload="none" src="${esc(S.api.abs(s.videoUrl))}"></video>
      <div class="play-icon">▶</div><div class="badge-cnt">${fmtDur(s.duration)}</div>
    </div>`;
  return `<div class="video-slot" data-act="gen-video" data-sid="${s.id}"><div class="play-icon" style="opacity:.4">▶</div></div>`;
}

// ---- 剧本文本资产高亮 ----
function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function scriptHighlightHTML(text, A) {
  if (!text) return '';
  const items = [];
  [['characters', 'char'], ['scenes', 'scene'], ['props', 'prop']].forEach(([k, cls]) => {
    (A[k] || []).forEach(a => { if (a.name && a.name.length >= 2) items.push({ name: a.name, cls, id: a.id }); });
  });
  if (!items.length) return esc(text);
  items.sort((a, b) => b.name.length - a.name.length);
  const marks = [];
  items.forEach(it => {
    const re = new RegExp(escapeReg(it.name), 'g');
    let m;
    while ((m = re.exec(text)) !== null) marks.push({ s: m.index, e: m.index + it.name.length, cls: it.cls, id: it.id });
  });
  marks.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
  const kept = []; let pos = 0;
  marks.forEach(m => { if (m.s >= pos) { kept.push(m); pos = m.e; } });
  let out = '', cur = 0;
  kept.forEach(m => {
    out += esc(text.slice(cur, m.s));
    out += `<mark class="hl-${m.cls}" title="已自动绑定${m.cls === 'char' ? '出场人物' : m.cls === 'scene' ? '场景' : '道具'}">${esc(text.slice(m.s, m.e))}</mark>`;
    cur = m.e;
  });
  out += esc(text.slice(cur));
  return out;
}
// 根据剧本文本自动绑定资产（只增不减）
function autoBindAssets(s) {
  const A = S.project.assets || {}; const text = s.text || ''; let changed = false;
  (A.characters || []).forEach(a => {
    s.characterIds = s.characterIds || [];
    if (a.name && a.name.length >= 2 && text.includes(a.name) && !s.characterIds.includes(a.id)) { s.characterIds.push(a.id); changed = true; }
  });
  (A.scenes || []).forEach(a => {
    if (a.name && a.name.length >= 2 && text.includes(a.name) && !s.sceneId) { s.sceneId = a.id; changed = true; }
  });
  (A.props || []).forEach(a => {
    s.propIds = s.propIds || [];
    if (a.name && a.name.length >= 2 && text.includes(a.name) && !s.propIds.includes(a.id)) { s.propIds.push(a.id); changed = true; }
  });
  if (changed) emitOp({ kind: 'shot-update', episodeId: S.episode.id, shot: s });
  return changed;
}
// 局部刷新某分镜行的资产单元格（不打断输入焦点）
function refreshRowAssets(sid) {
  const row = document.querySelector(`.shot-row[data-id="${sid}"]`); if (!row) return;
  const A = S.project.assets || {};
  const s = shotById(sid); if (!s) return;
  const cs = row.querySelector('.sr-chars .thumb-grid'); if (cs) cs.innerHTML = charThumbsHTML(s, A);
  const sc = row.querySelector('.sr-scene .thumb-grid'); if (sc) sc.innerHTML = sceneThumbHTML(s, A);
  const pr = row.querySelector('.sr-props .thumb-grid'); if (pr) pr.innerHTML = propThumbsHTML(s, A);
}

function renderCharPanel() {
  const kind = S.assetTab;
  const A = S.project.assets || { characters: [], scenes: [], props: [], others: [] };
  const appeared = getAppeared(kind);
  const unused = getUnused(kind);
  const list = A[kind] || [];

  // 更新标签
  $$('.char-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === kind));

  const filter = S.charFilter.toLowerCase();
  const renderGrid = (items, isApp) => {
    const filtered = items.filter(c => !filter || c.name.toLowerCase().includes(filter));
    return filtered.map(c => `
      <div class="char-thumb" data-cid="${c.id}" data-kind="${kind}" data-act="drag-char">
        ${assetThumb(c)}
        ${isApp ? '<div class="char-dot"></div>' : ''}
      </div>
    `).join('') + `<div class="char-add" data-act="new-char" data-kind="${kind}">+</div>`;
  };

  // 更新计数
  $('#onStageCount').textContent = `已出场 (${appeared.length}/${list.length})`;
  $('#offStageCount').textContent = `未出场 (${unused.length})`;

  // 渲染已出场
  $('#onStageGrid').innerHTML = appeared.length ? renderGrid(appeared, true) : '<div class="empty-hint">暂无</div>';
  // 渲染未出场
  $('#offStageGrid').innerHTML = unused.length ? renderGrid(unused, false) : '<div class="empty-hint">暂无</div>';
  $('#newCharGrid').innerHTML = '';

  // 绑定点击事件
  const bindThumbClick = (grid) => {
    grid.querySelectorAll('.char-thumb').forEach(t => t.onclick = () => {
      if (!S.selectedShotId) return toast('请先选择一个分镜', '', 2000);
      const cid = t.dataset.cid;
      const akind = t.dataset.kind;
      const s = shotById(S.selectedShotId); if (!s) return;
      const currentIds = getAssetIdsForShot(s, akind);
      if (akind === 'scenes') {
        setAssetIdsForShot(s, akind, [cid]);
      } else {
        if (currentIds.includes(cid)) {
          setAssetIdsForShot(s, akind, currentIds.filter(x => x !== cid));
        } else {
          setAssetIdsForShot(s, akind, [...currentIds, cid]);
        }
      }
      emitOp({ kind: 'shot-update', episodeId: S.episode.id, shot: s });
      renderShots(); renderCharPanel();
    });
  };
  bindThumbClick($('#onStageGrid'));
  bindThumbClick($('#offStageGrid'));

  $$('[data-act="new-char"]').forEach(b => b.onclick = () => {
    openAssetModal(b.dataset.kind, null, () => { renderShots(); renderCharPanel(); });
  });
}

function initShotEvents() {
  const body = $('#shotsWrap');
  const autoBindTimers = {};
  body.addEventListener('input', e => {
    const ta = e.target.closest('textarea[data-f]'); if (!ta) return;
    const id = ta.dataset.sid, f = ta.dataset.f;
    if (f === 'text') {
      updShot(id, { [f]: ta.value }, false);
      // 实时刷新高亮层
      const row = ta.closest('.shot-row');
      const hl = row && row.querySelector('.script-hl');
      if (hl) hl.innerHTML = scriptHighlightHTML(ta.value, S.project.assets || {});
      // 防抖自动绑定资产（只增不减），局部刷新缩略图不打断输入
      clearTimeout(autoBindTimers[id]);
      autoBindTimers[id] = setTimeout(() => {
        const s = shotById(id); if (!s) return;
        if (autoBindAssets(s)) { refreshRowAssets(id); renderCharPanel(); }
      }, 600);
    }
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  });
  // 高亮层与文本框滚动同步
  body.addEventListener('scroll', e => {
    const ta = e.target;
    if (ta.matches && ta.matches('textarea[data-f="text"]')) {
      const hl = ta.closest('.shot-row') && ta.closest('.shot-row').querySelector('.script-hl');
      if (hl) hl.scrollTop = ta.scrollTop;
    }
  }, true);
  body.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const act = btn.dataset.act;
    const sid = btn.dataset.sid;
    const s = sid ? shotById(sid) : null;
    const idx = sid ? S.data.shots.findIndex(x => x.id === sid) : -1;
    const row = btn.closest('.shot-row');
    if (row) {
      S.selectedShotId = row.dataset.id;
      $$('.shot-row').forEach(r => r.classList.toggle('selected', r.dataset.id === S.selectedShotId));
      renderCharPanel();
    }
    if (act === 'insert-after') {
      addShot(sid);
    } else if (act === 'del' && s) {
      S.data.shots.splice(idx, 1);
      emitOp({ kind: 'shot-delete', episodeId: S.episode.id, shotId: sid });
      renderShots(); renderCharPanel();
    } else if (act === 'up' && idx > 0) {
      [S.data.shots[idx - 1], S.data.shots[idx]] = [S.data.shots[idx], S.data.shots[idx - 1]];
      emitOp({ kind: 'shot-reorder', episodeId: S.episode.id, shotIds: S.data.shots.map(x => x.id) });
      renderShots();
    } else if (act === 'gen-img' && s) {
      await genShotImage(sid);
    } else if (act === 'gen-last' && s) {
      await genFrameImage(sid, 'lastImg');
    } else if (act === 'gen-voice' && s) {
      await genShotVoice(sid);
    } else if (act === 'upload-voice' && s) {
      await uploadShotVoice(sid);
    } else if (act === 'upload-frame' && s) {
      await uploadShotFrame(sid, btn.dataset.field || 'storyboardImg');
    } else if ((act === 'gen-video' || act === 'gen-video-btn') && s) {
      await genShotVideo(sid);
    } else if (act === 'preview') {
      openModal('预览', `<img src="${esc(btn.dataset.url)}" style="width:100%">`, true);
    } else if (act === 'add-char') {
      openAssetPicker('characters', sid);
    } else if (act === 'add-scene') {
      openAssetPicker('scenes', sid, true);
    } else if (act === 'add-prop') {
      openAssetPicker('props', sid);
    } else if (act === 'add-other') {
      openAssetPicker('others', sid);
    } else if (act === 'pick-char' && btn.dataset.cid) {
      if (s) {
        const cid = btn.dataset.cid;
        const arr = s.characterIds || [];
        s.characterIds = arr.filter(x => x !== cid);
        emitOp({ kind: 'shot-update', episodeId: S.episode.id, shot: s });
        renderShots(); renderCharPanel();
      }
    } else if (act === 'pick-scene') {
      if (s) { s.sceneId = ''; emitOp({ kind: 'shot-update', episodeId: S.episode.id, shot: s }); renderShots(); renderCharPanel(); }
    } else if (act === 'pick-prop' && btn.dataset.cid) {
      if (s) {
        const cid = btn.dataset.cid;
        s.propIds = (s.propIds || []).filter(x => x !== cid);
        emitOp({ kind: 'shot-update', episodeId: S.episode.id, shot: s });
        renderShots(); renderCharPanel();
      }
    } else if (act === 'pick-other' && btn.dataset.cid) {
      if (s) {
        const cid = btn.dataset.cid;
        s.otherIds = (s.otherIds || []).filter(x => x !== cid);
        emitOp({ kind: 'shot-update', episodeId: S.episode.id, shot: s });
        renderShots(); renderCharPanel();
      }
    }
  });
}

function openAssetPicker(kind, shotId, single) {
  const list = assetsOf(kind);
  const s = shotById(shotId);
  const name = { characters: '人物', scenes: '场景', props: '道具', others: '其他' }[kind];
  if (!list.length) {
    openAssetModal(kind, null, (a) => {
      if (!s) return;
      if (single) setAssetIdsForShot(s, kind, [a.id]);
      else { const arr = getAssetIdsForShot(s, kind); arr.push(a.id); setAssetIdsForShot(s, kind, arr); }
      emitOp({ kind: 'shot-update', episodeId: S.episode.id, shot: s });
      renderShots(); renderCharPanel();
    });
    return;
  }
  const current = getAssetIdsForShot(s, kind);
  openModal('选择' + name, `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
      ${list.map(a => `
        <div class="char-thumb" data-pick="${a.id}" style="cursor:pointer;border:2px solid ${current.includes(a.id) ? 'var(--ok)' : 'transparent'}">
          ${assetThumb(a)}
        </div>
      `).join('')}
      <div class="char-add" data-pick="__new__">+</div>
    </div>
    <div class="modal-foot-btns"><button class="btn ghost" id="apCancel">取消</button><button class="btn primary" id="apConfirm">确定</button></div>
  `, true);
  let picked = new Set(current.filter(Boolean));
  $$('[data-pick]').forEach(el => el.onclick = () => {
    const id = el.dataset.pick;
    if (id === '__new__') {
      closeModal();
      openAssetModal(kind, null, (a) => {
        if (s) {
          if (single) setAssetIdsForShot(s, kind, [a.id]);
          else { const arr = getAssetIdsForShot(s, kind); arr.push(a.id); setAssetIdsForShot(s, kind, arr); }
          emitOp({ kind: 'shot-update', episodeId: S.episode.id, shot: s });
          renderShots(); renderCharPanel();
        }
      });
      return;
    }
    if (single) {
      picked = new Set([id]);
      $$('[data-pick]').forEach(x => x.style.borderColor = x.dataset.pick === id ? 'var(--ok)' : 'transparent');
    } else {
      if (picked.has(id)) { picked.delete(id); el.style.borderColor = 'transparent'; }
      else { picked.add(id); el.style.borderColor = 'var(--ok)'; }
    }
  });
  $('#apCancel').onclick = closeModal;
  $('#apConfirm').onclick = () => {
    if (s) {
      setAssetIdsForShot(s, kind, [...picked]);
      emitOp({ kind: 'shot-update', episodeId: S.episode.id, shot: s });
    }
    closeModal(); renderShots(); renderCharPanel();
  };
}

function updShot(id, patch) {
  const s = shotById(id); if (!s) return;
  Object.assign(s, patch);
  emitOp({ kind: 'shot-update', episodeId: S.episode.id, shot: s });
}
function addShot(afterSid) {
  const s = { id: uid(), text: '', dialogue: '', speaker: '', characterIds: [], sceneId: '', propIds: [], otherIds: [], sfxId: '', duration: 0, storyboardImg: '', firstImg: '', lastImg: '', voiceUrl: '', voice: 'zh-CN-XiaoxiaoNeural' };
  if (afterSid && afterSid !== '__first__') {
    const i = S.data.shots.findIndex(x => x.id === afterSid);
    if (i >= 0) S.data.shots.splice(i + 1, 0, s);
    else S.data.shots.push(s);
  } else {
    S.data.shots.push(s);
  }
  emitOp({ kind: 'shot-add', episodeId: S.episode.id, shot: s });
  renderShots(); renderCharPanel();
  S.selectedShotId = s.id;
}

function openAssetModal(kind, asset, onSave) {
  const isSfx = kind === 'sfx';
  const isChar = kind === 'characters';
  const a = asset || { id: uid(), name: '', desc: '', img: '', audio: '', voice: isChar ? 'zh-CN-XiaoxiaoNeural' : '' };
  const name = { characters: '人物', scenes: '场景', props: '道具', others: '其他', sfx: '音效' }[kind];
  openModal((asset ? '编辑' : '新增') + name + '资产', `
    <div class="form-row"><label>名称 *</label><input id="amName" value="${esc(a.name)}"></div>
    <div class="form-row"><label>描述</label><textarea id="amDesc" rows="3">${esc(a.desc)}</textarea></div>
    ${!isSfx ? `<div class="form-row"><label>参考图</label>
      <div style="display:flex;gap:8px;align-items:center">
        <img id="amImgPrev" src="${a.img ? esc(S.api.abs(a.img)) : ''}" style="width:80px;height:80px;object-fit:cover;border-radius:8px;background:var(--bg4);border:1px solid var(--line)">
        <button class="btn small" id="amImgUp">上传</button>
        <button class="btn small" id="amImgAi">AI生成</button>
      </div></div>` : ''}
    ${isChar ? `<div class="form-row"><label>配音音色</label><select id="amVoice">${VOICES.map(v => `<option value="${v[0]}" ${a.voice === v[0] ? 'selected' : ''}>${v[1]}</option>`).join('')}</select></div>` : ''}
    <div class="modal-foot-btns"><button class="btn ghost" id="amCancel">取消</button><button class="btn primary" id="amSave">保存</button></div>
  `);
  let img = a.img, audio = a.audio;
  const up = $('#amImgUp');
  if (up) up.onclick = async () => { try { const u = await uploadPicked('image/*'); if (u) { img = u; $('#amImgPrev').src = S.api.abs(u); } } catch (e) { toast(e.message, 'err'); } };
  const ai = $('#amImgAi');
  if (ai) ai.onclick = async () => {
    const n = $('#amName').value.trim();
    if (!n) return toast('请先填写名称', 'err');
    ai.disabled = true; ai.textContent = '生成中…';
    try {
      const prompt = buildAssetPrompt(kind, n, $('#amDesc').value.trim());
      const r = await S.api.aiImage(S.project.id, S.sel.image, prompt, S.data.aspect || '16:9');
      img = r.url; $('#amImgPrev').src = S.api.abs(r.url);
    } catch (e) { toast(e.message, 'err'); } finally { ai.disabled = false; ai.textContent = 'AI生成'; }
  };
  $('#amCancel').onclick = closeModal;
  $('#amSave').onclick = () => {
    const n = $('#amName').value.trim();
    if (!n) return toast('请填写名称', 'err');
    a.name = n; a.desc = $('#amDesc').value.trim(); a.img = img;
    if (isChar) a.voice = $('#amVoice').value;
    if (!asset) {
      if (!S.project.assets) S.project.assets = { characters: [], scenes: [], props: [], others: [], sfx: [] };
      if (!S.project.assets[kind]) S.project.assets[kind] = [];
      S.project.assets[kind].push(a);
    }
    emitOp({ kind: 'assets-update', assets: S.project.assets });
    closeModal();
    renderShots(); renderCharPanel();
    if (onSave) onSave(a);
  };
}
function buildAssetPrompt(kind, name, desc) {
  const kn = { characters: '人物', scenes: '场景', props: '道具', others: '元素' }[kind] || kind;
  return `漫剧${kn}设定图：${name}。${desc || ''}。高质量插画风格，主体突出。`;
}

async function parseScript() {
  const script = $('#setupScript').value.trim();
  if (!script) return toast('请先输入剧本内容', 'err');
  if (!(S.project.models.text || []).length) return toast('未配置文本模型', 'err');
  const btn = $('#btnStartParse');
  const hint = $('#setupHint');
  btn.disabled = true; btn.textContent = '⏳ 解析中…';
  hint.textContent = 'AI 正在拆解剧本…';
  try {
    const A = S.project.assets || {};
    const assetList = {
      characters: (A.characters || []).map(c => c.name),
      scenes: (A.scenes || []).map(c => c.name),
      props: (A.props || []).map(c => c.name),
      others: (A.others || []).map(c => c.name)
    };
    const requireText = $('#setupRequire').value.trim();
    const sys = `你是专业漫剧分镜师。将剧本拆解为分镜列表。严格返回JSON：{"shots":[{"text":"画面描述","dialogue":"台词","speaker":"说话人","characters":["人物名"],"scene":"场景名","props":["道具"],"other":["其他"],"sfx":""}]}
规则：按剧情拆分，人物/场景/道具尽量从已有资产匹配，只返回JSON。`;
    const usr = `画风：${S.data.style || '国漫风'}；画幅：${S.data.aspect || '16:9'}；要求：${requireText || '无'}；已有资产：${JSON.stringify(assetList)}\n剧本：\n${script.slice(0, 8000)}`;
    const r = await S.api.aiText(S.project.id, S.sel.text, [{ role: 'system', content: sys }, { role: 'user', content: usr }], true);
    const j = extractJSON(r.content);
    const shots = (j.shots || []).map(o => ({
      id: uid(),
      text: String(o.text || ''), dialogue: String(o.dialogue || ''), speaker: String(o.speaker || ''),
      characterIds: matchAssets(A.characters, o.characters),
      sceneId: matchAssets(A.scenes, o.scene ? [o.scene] : [])[0] || '',
      propIds: matchAssets(A.props, o.props),
      otherIds: matchAssets(A.others, o.other),
      sfxId: '', duration: 0, storyboardImg: '', firstImg: '', lastImg: '',
      voiceUrl: '', voice: 'zh-CN-XiaoxiaoNeural'
    }));
    if (!shots.length) throw new Error('未拆解出分镜');
    S.data.script = script; S.data.require = requireText; S.data.shots = shots;
    emitOp({ kind: 'shots-replace', episodeId: S.episode.id, shots, script, require: requireText });
    emitOp({ kind: 'episode-meta', episodeId: S.episode.id, style: S.data.style, aspect: S.data.aspect });
    flushOps();
    toast('拆解完成：' + shots.length + ' 个分镜', 'ok');
    enterEditorPage();
  } catch (e) {
    hint.textContent = '';
    toast('拆解失败：' + (e.message || e), 'err', 4000);
  } finally { btn.disabled = false; btn.textContent = '开始解析'; }
}
function matchAssets(list, names) {
  if (!list || !names) return [];
  return list.filter(a => names.some(n => n && (a.name === n || a.name.includes(n) || String(n).includes(a.name)))).map(a => a.id);
}

function buildShotPrompt(s) {
  const A = S.project.assets || {};
  const parts = [];
  parts.push('漫剧画面：' + (s.text || ''));
  (A.characters || []).filter(c => (s.characterIds || []).includes(c.id)).forEach(c => parts.push('人物[' + c.name + ']：' + (c.desc || c.name)));
  const sc = (A.scenes || []).find(c => c.id === s.sceneId);
  if (sc) parts.push('场景[' + sc.name + ']：' + (sc.desc || sc.name));
  (A.props || []).filter(c => (s.propIds || []).includes(c.id)).forEach(c => parts.push('道具[' + c.name + ']'));
  return parts.join('；') + '。高质量动漫风格。';
}
async function genFrameImage(id, field) {
  const s = shotById(id); if (!s) return;
  if (!(S.project.models.image || []).length) return toast('未配置图片模型', 'err');
  toast('AI 生图中…');
  try {
    let prompt = buildShotPrompt(s);
    if (field === 'lastImg') prompt += ' 镜头结束时刻状态。';
    const r = await S.api.aiImage(S.project.id, S.sel.image, prompt, S.data.aspect);
    updShot(id, { [field]: r.url });
    renderShots();
    toast('图片已生成', 'ok');
  } catch (e) { toast(e.message, 'err'); renderShots(); }
}
async function genShotImage(id) { await genFrameImage(id, 'storyboardImg'); }

async function genShotVoice(id) {
  const s = shotById(id); if (!s) return;
  const text = (s.dialogue || s.text || '').trim();
  if (!text) return toast('没有台词无法配音', 'err');
  let voice = s.voice || 'zh-CN-XiaoxiaoNeural';
  const A = (S.project.assets || {}).characters || [];
  const c = A.find(x => (s.characterIds || []).includes(x.id) && x.voice);
  if (c) voice = c.voice;
  try {
    toast('配音中…');
    const r = await window.mochi.ttsGenerate({ text, voice, rate: '+0%', pitch: '+0Hz' });
    if (!r.dataBase64) throw new Error('TTS 返回为空');
    const up = await S.api.upload('voice.mp3', r.dataBase64);
    updShot(id, { voiceUrl: up.url, voice });
    renderShots();
    toast('配音完成', 'ok');
  } catch (e) { toast('配音失败：' + (e.message || e), 'err'); }
}

// ---- 文件选择与上传 ----
function pickLocalFile(accept) {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept;
    inp.onchange = () => resolve(inp.files[0] || null);
    inp.click();
  });
}
async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
async function uploadFile(file, namePrefix) {
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || ['.bin'])[0].toLowerCase();
  const b64 = await fileToBase64(file);
  return S.api.upload(namePrefix + ext, b64);
}
// 自由上传配音（不限于绑定的角色音色）
async function uploadShotVoice(id) {
  const s = shotById(id); if (!s) return;
  const f = await pickFile('audio/*');
  if (!f) return;
  try {
    toast('上传配音中…');
    const up = await uploadFile(f, 'voice-' + id);
    updShot(id, { voiceUrl: up.url, voice: 'custom' });
    renderShots();
    toast('配音已上传', 'ok');
  } catch (e) { toast('上传失败：' + (e.message || e), 'err'); }
}
// 自行上传分镜首帧/尾帧图
async function uploadShotFrame(id, field) {
  const s = shotById(id); if (!s) return;
  const f = await pickLocalFile('image/*');
  if (!f) return;
  try {
    toast('上传图片中…');
    const up = await uploadFile(f, 'frame-' + id + '-' + field);
    updShot(id, { [field]: up.url });
    renderShots();
    toast('图片已上传', 'ok');
  } catch (e) { toast('上传失败：' + (e.message || e), 'err'); }
}

// ---- 视频时长：按模型名称自动识别可选项 ----
function videoDurationOptions(modelId) {
  const m = (S.project.models.video || []).find(x => x.id === modelId);
  const str = (m ? ((m.model || '') + ' ' + (m.name || '')) : '').toLowerCase();
  // Seedance 2.0：固定枚举时长 4/5/6/8/10/12/15 秒，其他值会被API拒绝
  if (/seedance\s*[-_.]?\s*2/.test(str) || /seedance.*2\.0/.test(str)) return [4, 5, 6, 8, 10, 12, 15];
  const opts = new Set();
  const range = str.match(/(\d{1,2})\s*[-~到]\s*(\d{1,2})\s*s\b/);
  if (range) { for (let i = +range[1]; i <= +range[2] && i - range[1] <= 15; i++) opts.add(i); }
  (str.match(/\d{1,2}\s*s\b/g) || []).forEach(x => opts.add(parseInt(x, 10)));
  if (!opts.size) [5, 10].forEach(x => opts.add(x));
  return [...opts].filter(n => n > 0 && n <= 60).sort((a, b) => a - b);
}

async function genShotVideo(id) {
  const s = shotById(id); if (!s) return;
  if (!S.sel.video) return toast('请先选择视频模型', 'err');
  const model = (S.project.models.video || []).find(x => x.id === S.sel.video);
  const isFL = model && model.type === 'firstlast';
  const first = s.firstImg || s.storyboardImg;
  // 首尾帧模式：首帧+尾帧两张图必填；全能参考模式：分镜图可选
  if (isFL && (!first || !s.lastImg)) {
    return toast('首尾帧模式必须提供首帧与尾帧两张图片（可AI生成或上传）', 'err', 4000);
  }
  const durs = videoDurationOptions(S.sel.video);
  const cur = s.durSel || durs[0];
  openModal('生成视频 · 第' + (S.data.shots.findIndex(x => x.id === id) + 1) + '镜', `
    <div class="form-row"><label>视频时长 *（由模型「${esc(model ? model.name : '')}」自动识别支持的时长）</label>
      <div class="dur-pills">
        ${durs.map(d => `<button class="dur-pill${d === cur ? ' on' : ''}" data-dur="${d}">${d} 秒</button>`).join('')}
      </div>
    </div>
    ${isFL
      ? '<p class="hint">首尾帧模式：将使用本镜<b>首帧 + 尾帧</b>两张图片生成。</p>'
      : (first
        ? '<p class="hint">全能参考模式：将综合分镜图与台词生成（分镜图可选，已提供）。</p>'
        : '<p class="hint">全能参考模式：将按剧本描述生成（未提供分镜图，可先生成或上传以获得更稳定画面）。</p>')}
    <div class="modal-foot-btns"><button class="btn ghost" id="gvCancel">取消</button><button class="btn primary" id="gvGo">🎬 开始生成</button></div>
  `, true);
  let chosen = cur;
  $$('.dur-pill').forEach(p => p.onclick = () => {
    chosen = +p.dataset.dur;
    $$('.dur-pill').forEach(x => x.classList.toggle('on', x === p));
    s.durSel = chosen;
    updShot(id, { durSel: chosen }, false);
  });
  $('#gvCancel').onclick = closeModal;
  $('#gvGo').onclick = async () => {
    if (!chosen) return toast('请先选择视频时长', 'err');
    closeModal();
    await doGenShotVideo(id, chosen, isFL);
  };
}
async function doGenShotVideo(id, duration, isFL) {
  const s = shotById(id); if (!s) return;
  const first = s.firstImg || s.storyboardImg;
  try {
    toast('视频生成中（' + duration + '秒）…', '', 3000);
    const prompt = buildShotPrompt(s);
    const r = await S.api.aiVideo(S.project.id, S.sel.video, prompt, S.data.aspect, first ? S.api.abs(first) : '', isFL && s.lastImg ? S.api.abs(s.lastImg) : '', duration);
    if (r.url) {
      updShot(id, { videoUrl: r.url, duration: r.duration || duration });
      renderShots();
      toast('视频已生成', 'ok');
    }
  } catch (e) { toast('视频生成失败：' + (e.message || e), 'err', 4000); }
}

function initCompose() {}
async function composeVideo() {
  if (!S.data.shots.length) return toast('没有分镜', 'err');
  toast('合成整片视频功能开发中…', '', 2000);
}

let opQueue = [], opTimer = null, backupTimer = null;
function emitOp(op) {
  opQueue.push(op);
  setSaveState(false);
  clearTimeout(opTimer);
  opTimer = setTimeout(flushOps, 450);
  clearTimeout(backupTimer);
  backupTimer = setTimeout(localBackup, 1500);
}
function flushOps() {
  const ops = opQueue.splice(0);
  ops.forEach(op => S.collab.sendOp(op));
  // 资产更新走可靠HTTP通道持久化（WS断开时ops会被丢弃），确保项目资产留存并向全员共享
  const lastAssets = [...ops].reverse().find(op => op.kind === 'assets-update');
  if (lastAssets && S.project && S.api) {
    S.api.assetsSave(S.project.id, lastAssets.assets).catch(() => { });
  }
  if (ops.length) setSaveState(true);
  localBackup();
}
function localBackup() {
  if (!S.episode || !S.data) return;
  window.mochi.backupSave('episode-' + S.episode.id, S.data);
}
function setSaveState(saved) {
  ['#saveBadge', '#saveBadgeTop'].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    el.textContent = saved ? '已保存' : '保存中…';
    el.classList.toggle('saving', !saved);
  });
}
async function fullSaveEpisode() {
  if (!S.episode || !S.data || !S.api) return;
  try { await S.api.saveEpisode(S.episode.id, { name: S.episode.name, aspect: S.data.aspect, style: S.data.style, script: S.data.script, require: S.data.require, shots: S.data.shots }); } catch (e) { }
}
function initCollab() {
  S.collab.onOp = m => {
    const { op, clientId } = m;
    if (clientId === S.collab.clientId) return;
    if (!op || !S.data) return;
    let rerender = false;
    if (op.kind === 'shot-add') { if (!S.data.shots.some(s => s.id === op.shot.id)) { S.data.shots.push(op.shot); rerender = true; } }
    else if (op.kind === 'shot-update') { const i = S.data.shots.findIndex(s => s.id === op.shot.id); if (i >= 0) { S.data.shots[i] = op.shot; rerender = true; } }
    else if (op.kind === 'shot-delete') { S.data.shots = S.data.shots.filter(s => s.id !== op.shotId); rerender = true; }
    else if (op.kind === 'shots-replace') {
      S.data.shots = op.shots;
      if (op.script !== undefined) S.data.script = op.script;
      if (op.require !== undefined) S.data.require = op.require;
      if (S.page === 'setup') { if ($('#setupScript')) $('#setupScript').value = op.script || ''; if ($('#setupRequire')) $('#setupRequire').value = op.require || ''; }
      rerender = true;
    } else if (op.kind === 'shot-reorder') {
      const map = new Map(S.data.shots.map(s => [s.id, s]));
      S.data.shots = op.shotIds.map(id => map.get(id)).filter(Boolean); rerender = true;
    } else if (op.kind === 'assets-update') { S.project.assets = op.assets; rerender = true; }
    else if (op.kind === 'episode-meta') {
      if (op.aspect !== undefined) S.data.aspect = op.aspect;
      if (op.style !== undefined) S.data.style = op.style;
      if (op.script !== undefined) { S.data.script = op.script; if (S.page === 'setup' && $('#setupScript')) $('#setupScript').value = op.script; }
      if (op.require !== undefined) { S.data.require = op.require; if (S.page === 'setup' && $('#setupRequire')) $('#setupRequire').value = op.require; }
      if (S.page === 'setup') renderSetup();
    }
    if (rerender && S.page === 'editor') { renderShots(); renderCharPanel(); }
  };
  S.collab.onPresence = users => {
    const el = $('#presenceBadge');
    if (!el) return;
    const mine = S.user ? S.user.id : '';
    const others = users.filter(u => u.userId !== mine);
    if (!others.length) { el.textContent = ''; el.style.display = 'none'; return; }
    el.style.display = '';
    el.textContent = '👥 ' + others.map(u => u.name).join('、') + ' 协作中';
  };
  S.collab.onClose = () => {
    if (S.page === 'editor' || S.page === 'setup') {
      setSaveState(false);
      clearTimeout(S.wsRetryTimer);
      S.wsRetryTimer = setTimeout(() => {
        if (S.page !== 'editor' && S.page !== 'setup') return;
        try { S.collab.connect(S.base, S.token); S.collab.join(S.project.id, S.episode.id); fullSaveEpisode(); } catch (e) { }
      }, 3000);
    }
  };
}

// 管理端
let adminTab = 'stats', adminCache = null;
function enterAdmin() {
  $('#adminName').textContent = '👤 ' + S.admin.name;
  showPage('admin');
  loadAdmin();
}
async function loadAdmin() {
  try { adminCache = await S.api.adminData(); renderAdmin(); } catch (e) { toast(e.message, 'err'); }
}
function renderAdmin() {
  const b = $('#adminBody');
  if (!adminCache) { b.innerHTML = '<p class="hint">加载中…</p>'; return; }
  if (adminTab === 'stats') renderAdminStats(b);
  else if (adminTab === 'users') renderAdminUsers(b);
  else if (adminTab === 'projects') renderAdminProjects(b);
  else renderAdminServer(b);
}
function renderAdminStats(b) {
  const st = (adminCache.stats || []).filter(x => x.kind === 'video');
  const groupIds = new Set(st.map(x => x.groupId));
  const totalDur = st.reduce((s, x) => s + (x.durationSec || 0), 0);
  const users = new Set(st.map(x => x.userId));
  const byUser = {};
  st.forEach(x => {
    byUser[x.userName] = byUser[x.userName] || { count: 0, groups: new Set(), dur: 0 };
    byUser[x.userName].count++; byUser[x.userName].groups.add(x.groupId); byUser[x.userName].dur += x.durationSec || 0;
  });
  const byShot = {};
  st.forEach(x => {
    const k = x.projectId + '|' + x.episodeId + '|' + x.shotIndex;
    byShot[k] = byShot[k] || { projectName: x.projectName, episodeName: x.episodeName, idx: x.shotIndex, text: x.shotText, count: 0, last: 0, dur: 0, res: x.resolution };
    byShot[k].count++; byShot[k].last = Math.max(byShot[k].last, x.ts); byShot[k].dur += x.durationSec || 0;
  });
  const shotRows = Object.values(byShot).sort((a, b2) => b2.last - a.last).slice(0, 300);
  b.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card"><div class="sc-label">生成视频总数</div><div class="sc-num">${groupIds.size}</div></div>
      <div class="stat-card"><div class="sc-label">分镜生成次数</div><div class="sc-num">${st.length}</div></div>
      <div class="stat-card"><div class="sc-label">视频总时长</div><div class="sc-num">${fmtDur(totalDur)}</div></div>
      <div class="stat-card"><div class="sc-label">参与用户数</div><div class="sc-num">${users.size}</div></div>
      <div class="stat-card"><div class="sc-label">项目数</div><div class="sc-num">${(adminCache.projects || []).length}</div></div>
    </div>
    <div class="admin-section"><h3>按用户统计</h3>
      <table class="admin-table"><tr><th>用户</th><th>视频数</th><th>分镜生成次数</th><th>总时长</th></tr>
      ${Object.entries(byUser).map(([n, v]) => `<tr><td>${esc(n)}</td><td>${v.groups.size}</td><td>${v.count}</td><td>${fmtDur(v.dur)}</td></tr>`).join('') || '<tr><td colspan="4">暂无数据</td></tr>'}
      </table></div>
    <div class="admin-section"><h3>按分镜统计（最近300条）</h3>
      <table class="admin-table"><tr><th>项目</th><th>分集</th><th>镜号</th><th>画面内容</th><th>生成次数</th><th>累计时长</th><th>清晰度</th><th>最近生成</th></tr>
      ${shotRows.map(r => `<tr><td>${esc(r.projectName)}</td><td>${esc(r.episodeName)}</td><td>#${r.idx + 1}</td><td>${esc(r.text)}</td><td>${r.count}</td><td>${fmtDur(r.dur)}</td><td>${esc(r.res)}</td><td>${fmtTime(r.last)}</td></tr>`).join('') || '<tr><td colspan="8">暂无数据，用户生成视频后此处自动统计</td></tr>'}
      </table></div>`;
}
function renderAdminUsers(b) {
  const codes = adminCache.codes || [];
  const users = adminCache.users || [];
  b.innerHTML = `
    <div class="admin-toolbar">
      <input id="cuName" placeholder="用户名称">
      <input id="cuCode" placeholder="校验码（留空自动生成）" style="width:220px">
      <button class="btn primary" id="btnAddCode">＋ 添加校验码</button>
      <button class="btn ghost" id="btnRefreshAdmin">刷新</button>
    </div>
    <table class="admin-table"><tr><th>用户名称</th><th>校验码</th><th>创建时间</th><th>登录过</th><th>操作</th></tr>
    ${codes.map(c => {
      const used = users.some(u => u.codeId === c.id);
      return `<tr><td>${esc(c.name)}</td><td class="code-mono">${esc(c.code)}</td><td>${fmtTime(c.createdAt)}</td><td>${used ? '✓' : '—'}</td><td><button class="btn small danger" data-del="${c.id}">删除</button></td></tr>`;
    }).join('') || '<tr><td colspan="5">暂无校验码</td></tr>'}
    </table>`;
  $('#btnRefreshAdmin').onclick = loadAdmin;
  $('#btnAddCode').onclick = async () => {
    const name = $('#cuName').value.trim();
    if (!name) return toast('请填写名称', 'err');
    try { await S.api.adminCreateCode(name, $('#cuCode').value.trim()); toast('已创建', 'ok'); loadAdmin(); } catch (e) { toast(e.message, 'err'); }
  };
  b.querySelectorAll('[data-del]').forEach(btn => btn.onclick = async () => {
    try { await S.api.adminDeleteCode(btn.dataset.del); toast('已删除', 'ok'); loadAdmin(); } catch (e) { toast(e.message, 'err'); }
  });
}
function renderAdminProjects(b) {
  const ps = adminCache.projects || [];
  const eps = adminCache.episodes || [];
  const modelCount = p => {
    const m = p.models || {};
    const t = (m.text || []).length, i2 = (m.image || []).length, v = (m.video || []).length;
    return (t || i2 || v) ? `文${t} 图${i2} 视${v}` : '未配置';
  };
  b.innerHTML = `
    <div class="admin-toolbar">
      <input id="npName" placeholder="项目名称">
      <button class="btn primary" id="btnAddProj">＋ 创建项目</button>
      <button class="btn ghost" id="btnRefreshAdmin2">刷新</button>
    </div>
    <p class="hint">项目与各项目的模型配置（文本/图片/视频，含 API 地址与 Key）由管理员在此管理。</p>
    <table class="admin-table"><tr><th>项目</th><th>分集数</th><th>模型配置</th><th>创建时间</th><th>操作</th></tr>
    ${ps.map(p => `<tr>
      <td>${esc(p.name)}</td>
      <td>${eps.filter(e => e.projectId === p.id).length}</td>
      <td>${modelCount(p)}</td>
      <td>${fmtTime(p.createdAt)}</td>
      <td class="op-cell">
        <button class="btn small" data-cfg="${p.id}">⚙ 编辑配置</button>
        <button class="btn small danger" data-delp="${p.id}">删除</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="5">暂无项目</td></tr>'}
    </table>`;
  $('#btnAddProj').onclick = async () => {
    const name = $('#npName').value.trim();
    if (!name) return toast('请填写名称', 'err');
    try { await S.api.adminCreateProject(name); toast('项目已创建', 'ok'); loadAdmin(); } catch (e) { toast(e.message, 'err'); }
  };
  $('#btnRefreshAdmin2').onclick = loadAdmin;
  b.querySelectorAll('[data-cfg]').forEach(btn => btn.onclick = () => openModelCfg(btn.dataset.cfg));
  b.querySelectorAll('[data-delp]').forEach(btn => btn.onclick = async () => {
    if (!confirm('删除项目将同时删除其全部分集数据，确定？')) return;
    try { await S.api.adminDeleteProject(btn.dataset.delp); toast('已删除', 'ok'); loadAdmin(); } catch (e) { toast(e.message, 'err'); }
  });
}
function openModelCfg(pid) {
  const p = adminCache.projects.find(x => x.id === pid);
  if (!p) return;
  p.models = p.models || { text: [], image: [], video: [] };
  ['text', 'image', 'video'].forEach(k => { if (!Array.isArray(p.models[k])) p.models[k] = []; });
  const section = (kind, title, sub) => `
    <div class="mcfg-section">
      <div class="mcfg-title">${title} <span>${sub}</span></div>
      <div id="mcfg-${kind}"></div>
      <button class="btn small" data-add="${kind}" style="margin-bottom:10px">＋ 添加${title.replace(/^[^\s]+\s*/, '')}</button>
    </div>`;
  openModal('⚙ 模型配置 · ' + p.name, `
    <p class="hint">配置仅保存在服务端，API Key 不会下发给用户；用户只能看到模型名称并进行选择。视频模型可选「全能参考」（综合所有素材生成）或「首尾帧」（必须提供首帧/尾帧图）。</p>
    ${section('text', '📝 文本模型', '负责剧本拆解、台词处理')}
    ${section('image', '🖼 图片模型', '负责资产图与分镜图生成')}
    ${section('video', '🎞 视频模型', '负责最终成片画面')}
    <div class="modal-foot-btns"><button class="btn ghost" id="mcCancel">取消</button><button class="btn primary" id="mcSave">保存配置</button></div>
  `, true);
  const render = kind => {
    const w = $('#mcfg-' + kind);
    w.innerHTML = p.models[kind].map((m, i) => `
      <div class="mcfg-item">
        <div class="mi-head">
          <input class="mi-name" data-k="${kind}" data-i="${i}" data-f="name" value="${esc(m.name)}" placeholder="显示名称（如：全能参考）">
          ${kind === 'video' ? `<select data-k="${kind}" data-i="${i}" data-f="type" style="width:120px">
            <option value="allref" ${m.type !== 'firstlast' ? 'selected' : ''}>全能参考</option>
            <option value="firstlast" ${m.type === 'firstlast' ? 'selected' : ''}>首尾帧</option>
          </select>` : ''}
          <button class="btn small danger" data-rm="${kind}" data-i="${i}">✕</button>
        </div>
        <div class="form-row half"><label>API 地址 (Base URL)</label><input data-k="${kind}" data-i="${i}" data-f="baseUrl" value="${esc(m.baseUrl)}" placeholder="https://api.xxx.com/v1"></div>
        <div class="form-row half"><label>API Key</label><input data-k="${kind}" data-i="${i}" data-f="apiKey" type="password" value="${esc(m.apiKey)}" placeholder="sk-…"></div>
        <div class="form-row half"><label>模型名称</label><input data-k="${kind}" data-i="${i}" data-f="model" value="${esc(m.model)}" placeholder="model id"></div>
      </div>`).join('') || '<p class="hint">暂未配置</p>';
  };
  ['text', 'image', 'video'].forEach(render);
  $('#modalBody').querySelectorAll('[data-add]').forEach(btn => btn.onclick = () => {
    p.models[btn.dataset.add].push({ id: uid(), name: '', baseUrl: '', apiKey: '', model: '', type: btn.dataset.add === 'video' ? 'allref' : '' });
    render(btn.dataset.add);
  });
  $('#modalBody').querySelectorAll('[data-rm]').forEach(btn => btn.onclick = () => {
    p.models[btn.dataset.rm].splice(parseInt(btn.dataset.i), 1);
    render(btn.dataset.rm);
  });
  const mb = $('#modalBody');
  mb.oninput = e => {
    const t = e.target;
    if (t.dataset.k !== undefined && t.dataset.f) p.models[t.dataset.k][parseInt(t.dataset.i)][t.dataset.f] = t.value;
  };
  mb.onchange = e => {
    const t = e.target;
    if (t.tagName === 'SELECT' && t.dataset.k !== undefined && t.dataset.f) p.models[t.dataset.k][parseInt(t.dataset.i)][t.dataset.f] = t.value;
  };
  $('#mcCancel').onclick = () => { closeModal(); loadAdmin(); };
  $('#mcSave').onclick = async () => {
    try {
      ['text', 'image', 'video'].forEach(k => { p.models[k] = p.models[k].filter(m => m.name && m.baseUrl && m.model); });
      await S.api.adminSaveModels(pid, p.models);
      toast('模型配置已保存', 'ok');
      closeModal(); loadAdmin();
    } catch (e) { toast(e.message, 'err'); }
  };
}
async function renderAdminServer(b) {
  b.innerHTML = '<p class="hint">加载服务状态…</p>';
  const st = await window.mochi.serverStatus();
  const addr = (st.ips && st.ips.length ? st.ips : ['本机IP']).map(ip => 'http://' + ip + ':' + (st.port || 3210)).join(' 或 ');
  b.innerHTML = `
    <div class="admin-section"><h3>协作服务状态</h3>
      <div class="stat-cards">
        <div class="stat-card"><div class="sc-label">本机服务</div><div class="sc-num">${st.running ? '运行中' : '未启动'}</div></div>
        <div class="stat-card"><div class="sc-label">端口</div><div class="sc-num">${st.port || 3210}</div></div>
        <div class="stat-card"><div class="sc-label">当前服务器地址</div><div class="sc-num" style="font-size:15px">${esc(S.base)}</div></div>
      </div>
      <div class="admin-toolbar">
        <input id="svPort" value="${st.port || 3210}" style="width:100px" placeholder="端口">
        <button class="btn primary" id="btnSvStart">${st.running ? '重启服务' : '启动本机服务'}</button>
        ${st.running ? '<button class="btn danger" id="btnSvStop">停止服务</button>' : ''}
      </div>
      ${st.running ? `<p class="hint">✅ 服务运行中。用户端登录页填入：<b>${esc(addr)}</b><br>数据目录：${esc(st.dataDir || '')}</p>` : '<p class="hint">启动后本机即成为协作服务器，其他设备通过局域网（或公网映射）地址连接。当前管理端连接的是 <b>' + esc(S.base) + '</b>。</p>'}
      <p class="hint">⚠️ 跨设备访问需保证网络互通（同一局域网，或在路由器做端口映射 / 使用内网穿透）。Windows 防火墙首次会弹窗，请选择「允许」。</p>
    </div>`;
  $('#btnSvStart').onclick = async () => {
    try {
      const r = await window.mochi.serverStart(parseInt($('#svPort').value) || 3210);
      if (r.ok) { toast('服务已启动（端口 ' + r.port + '）', 'ok'); renderAdminServer(b); }
      else toast(r.error || '启动失败', 'err');
    } catch (e) { toast(e.message, 'err'); }
  };
  const stop = $('#btnSvStop'); if (stop) stop.onclick = async () => { await window.mochi.serverStop(); toast('已停止'); renderAdminServer(b); };
}

function initUpdaterUI() {
  window.mochi.appInfo().then(info => {
    const v = 'v' + info.version;
    ['#verBadge', '#projVerBadge', '#adminVerBadge'].forEach(s => { const el = $(s); if (el) el.textContent = v; });
  });
  window.mochi.onUpdaterEvent('downloaded', d => {
    S.updateReady = d;
    $('#updateBarText').textContent = '新版本 v' + (d.version || '') + ' 已下载';
    $('#updateBar').classList.remove('hidden');
  });
  $('#btnCheckUpdate').onclick = async () => {
    if (S.updateReady) return $('#btnInstallUpdate').click();
    toast('检查更新中…');
    const r = await window.mochi.checkUpdate();
    if (!r.hasUpdate) toast('已是最新版本', 'ok');
  };
  $('#btnInstallUpdate').onclick = () => {
    flushOps(); fullSaveEpisode();
    toast('正在重启安装…', '', 2000);
    setTimeout(() => window.mochi.installUpdate(), 600);
  };
  $('#btnDismissUpdate').onclick = () => $('#updateBar').classList.add('hidden');
}

function init() {
  initLogin();
  initUpdaterUI();
  initShotEvents();
  initCompose();
  $('#modalClose').onclick = closeModal;
  $('#modalMask').addEventListener('click', e => { if (e.target === $('#modalMask')) closeModal(); });
  $('#btnLogout1').onclick = $('#btnLogout2').onclick = () => location.reload();
  $('#btnNewProj') && ($('#btnNewProj').onclick = () => toast('请联系管理员创建项目', '', 2000));
  $('#btnNewEpisode').onclick = newEpisode;
  $('#btnBackProj').onclick = () => loadProjects();
  $('#btnBackEps').onclick = async () => {
    flushOps(); await fullSaveEpisode(); S.collab.leave(); openProject(S.project.id);
  };
  $('#btnToSetup').onclick = () => { flushOps(); showSetup(); };
  $('#btnCompose').onclick = composeVideo;
  $('#btnStartParse').onclick = parseScript;
  $('#btnSkipParse').onclick = skipParse;
  $('#btnSetupBack').onclick = async () => {
    flushOps(); await fullSaveEpisode(); S.collab.leave(); openProject(S.project.id);
  };
  $('#btnStylePicker').onclick = () => {
    const p = $('#stylePanel');
    p.classList.toggle('hidden');
  };
  $('#btnCmdLib').onclick = () => toast('指令库开发中', '', 1500);
  $$('.aspect-btn').forEach(b => b.onclick = () => {
    S.data.aspect = b.dataset.v;
    $$('.aspect-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    emitOp({ kind: 'episode-meta', episodeId: S.episode.id, aspect: b.dataset.v });
  });
  $('#setupScript').addEventListener('input', e => {
    $('#setupCharCount').textContent = e.target.value.length;
    S.data.script = e.target.value;
    clearTimeout(window._scTimer);
    window._scTimer = setTimeout(() => emitOp({ kind: 'episode-meta', episodeId: S.episode.id, script: e.target.value }), 800);
  });
  $('#setupRequire').addEventListener('input', e => {
    $('#setupReqCount').textContent = e.target.value.length;
    S.data.require = e.target.value;
    clearTimeout(window._rqTimer);
    window._rqTimer = setTimeout(() => emitOp({ kind: 'episode-meta', episodeId: S.episode.id, require: e.target.value }), 800);
  });
  $$('.char-tab').forEach(t => t.onclick = () => {
    S.assetTab = t.dataset.tab;
    S.charFilter = '';
    renderCharPanel();
  });
  const charSearch1 = $('#charSearch');
  if (charSearch1) charSearch1.oninput = (e) => { S.charFilter = e.target.value; renderCharPanel(); };
  const charSearch2 = $('#charSearch2');
  if (charSearch2) charSearch2.oninput = (e) => { S.charFilter = e.target.value; renderCharPanel(); };
  $$('.work-tab').forEach(t => t.onclick = () => {
    $$('.work-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
  });
  $$('.proj-tab').forEach(t => t.onclick = () => {
    $$('.proj-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    S.projTab = t.dataset.tab;
  });
  $$('.admin-tab').forEach(t => t.onclick = () => {
    $$('.admin-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active'); adminTab = t.dataset.tab; renderAdmin();
  });
  $('#btnExitProj') && ($('#btnExitProj').onclick = () => loadProjects());
  window.addEventListener('beforeunload', () => { flushOps(); });
  setInterval(() => { if (S.page === 'editor' || S.page === 'setup') fullSaveEpisode(); }, 30000);
}
init();