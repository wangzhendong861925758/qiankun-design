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
    $('#edEpisodeName').textContent = S.project.name + ' · ' + S.episode.name;
    const saved = JSON.parse(localStorage.getItem('qk_sel_' + S.project.id) || '{}');
    S.sel = { text: saved.text || '', image: saved.image || '', video: saved.video || '' };
    renderModelSels();
    S.collab.connect(S.base, S.token);
    S.collab.join(S.project.id, S.episode.id);
    setSaveState(true);
    showSetup();
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
  enterEditorPage();
  if (!S.data.shots.length) toast('已跳过，点击「＋」添加分镜', '', 3000);
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
    body.innerHTML = `<div class="story-empty">暂无分镜<br><br>点击下方「＋」或返回剧本分解页开始创作</div>`;
    return;
  }
  body.innerHTML = S.data.shots.map((s, i) => {
    const charList = (s.characterIds || []).map(id => A.characters.find(c => c.id === id)).filter(Boolean);
    const scene = A.scenes.find(c => c.id === s.sceneId);
    const propList = (s.propIds || []).map(id => A.props.find(c => c.id === id)).filter(Boolean);
    const otherList = (s.otherIds || []).map(id => A.others.find(c => c.id === id)).filter(Boolean);
    const charThumbs = charList.slice(0, 3).map(c => `
      <div class="thumb-item" data-act="pick-char" data-sid="${s.id}" data-cid="${c.id}">
        ${assetThumb(c)}
      </div>
    `).join('') + `<div class="thumb-item" data-act="add-char" data-sid="${s.id}"><div class="thumb-add">+</div>${charList.length ? `<div class="badge-cnt">${charList.length}</div>` : ''}</div>`;
    const sceneThumb = scene ? `
      <div class="thumb-item" data-act="pick-scene" data-sid="${s.id}" data-cid="${scene.id}">
        ${assetThumb(scene)}
      </div>
    ` : `<div class="thumb-item" data-act="add-scene" data-sid="${s.id}"><div class="thumb-add">+</div></div>`;
    const propThumbs = propList.slice(0, 3).map(p => `
      <div class="thumb-item" data-act="pick-prop" data-sid="${s.id}" data-cid="${p.id}">
        ${assetThumb(p)}
      </div>
    `).join('') + `<div class="thumb-item" data-act="add-prop" data-sid="${s.id}"><div class="thumb-add">+</div></div>`;
    const otherThumbs = otherList.slice(0, 3).map(o => `
      <div class="thumb-item" data-act="pick-other" data-sid="${s.id}" data-cid="${o.id}">
        ${assetThumb(o)}
      </div>
    `).join('') + `<div class="thumb-item" data-act="add-other" data-sid="${s.id}"><div class="thumb-add">+</div></div>`;
    const frameImg = s.storyboardImg || s.firstImg;
    const frameSlot = frameImg ? `
      <div class="frame-slot-sm" data-act="preview" data-url="${S.api.abs(frameImg)}">
        <img src="${esc(S.api.abs(frameImg))}"><div class="badge-cnt">图</div>
      </div>
    ` : `<div class="frame-slot-sm" data-act="gen-img" data-sid="${s.id}"><div class="slot-add">✨</div></div>`;
    const secondFrame = s.lastImg ? `
      <div class="frame-slot-sm" data-act="preview" data-url="${S.api.abs(s.lastImg)}">
        <img src="${esc(S.api.abs(s.lastImg))}"><div class="badge-cnt">尾</div>
      </div>
    ` : `<div class="frame-slot-sm" data-act="gen-last" data-sid="${s.id}"><div class="slot-add">+</div></div>`;
    const videoSlot = s.videoUrl ? `
      <div class="video-slot" data-act="play" data-url="${S.api.abs(s.videoUrl)}">
        <video preload="none" src="${esc(S.api.abs(s.videoUrl))}"></video>
        <div class="play-icon">▶</div><div class="badge-cnt">${fmtDur(s.duration)}</div>
      </div>
    ` : `<div class="video-slot" data-act="gen-video" data-sid="${s.id}"><div class="play-icon" style="opacity:.4">▶</div></div>`;
    return `
    <div class="shot-row" data-id="${s.id}">
      <div class="sr-cell sr-no">
        <input type="checkbox">
        <div class="sr-no-num">${i + 1}</div>
        <div class="sr-lock">🔓</div>
      </div>
      <div class="sr-cell sr-script">
        <textarea data-f="text" data-sid="${s.id}" placeholder="输入画面描述...">${esc(s.text)}</textarea>
      </div>
      <div class="sr-cell sr-chars"><div class="thumb-grid">${charThumbs}</div></div>
      <div class="sr-cell sr-scene"><div class="thumb-grid">${sceneThumb}</div></div>
      <div class="sr-cell sr-props"><div class="thumb-grid">${propThumbs}</div></div>
      <div class="sr-cell sr-others"><div class="thumb-grid">${otherThumbs}</div></div>
      <div class="sr-cell sr-aux">
        <button class="aux-btn" data-act="gen-img" data-sid="${s.id}">🖼 AI生图</button>
        <button class="aux-btn" data-act="gen-voice" data-sid="${s.id}">🎙 配音${s.voiceUrl ? ' ✓' : ''}</button>
      </div>
      <div class="sr-cell sr-img"><div class="frame-imgs">${frameSlot}${secondFrame}</div></div>
      <div class="sr-cell sr-video">
        ${videoSlot}
        <button class="gen-video-btn" data-act="gen-video-btn" data-sid="${s.id}">${s.videoUrl ? '重新生成' : '生成本镜视频'}</button>
      </div>
      <div class="sr-cell sr-ops">
        <button class="sr-ops-btn" data-act="up" data-sid="${s.id}">↑</button>
        <button class="sr-ops-btn" data-act="del" data-sid="${s.id}">✕</button>
      </div>
    </div>`;
  }).join('');
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
  body.addEventListener('input', e => {
    const ta = e.target.closest('textarea[data-f]'); if (!ta) return;
    const id = ta.dataset.sid, f = ta.dataset.f;
    if (f === 'text') { updShot(id, { [f]: ta.value }, false); }
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  });
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
    if (act === 'del' && s) {
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
function addShot() {
  const s = { id: uid(), text: '', dialogue: '', speaker: '', characterIds: [], sceneId: '', propIds: [], otherIds: [], sfxId: '', duration: 0, storyboardImg: '', firstImg: '', lastImg: '', voiceUrl: '', voice: 'zh-CN-XiaoxiaoNeural' };
  S.data.shots.push(s);
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

async function genShotVideo(id) {
  const s = shotById(id); if (!s) return;
  if (!S.sel.video) return toast('请先选择视频模型', 'err');
  const refImg = s.firstImg || s.storyboardImg;
  if (!refImg) return toast('请先生成分镜图', 'err');
  try {
    toast('视频生成中…');
    const prompt = buildShotPrompt(s);
    const r = await S.api.aiVideo(S.project.id, S.sel.video, prompt, S.api.abs(refImg), S.data.aspect);
    if (r.url) {
      updShot(id, { videoUrl: r.url, duration: r.duration || 3 });
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
  if (ops.length) setSaveState(true);
  localBackup();
}
function localBackup() {
  if (!S.episode || !S.data) return;
  window.mochi.backupSave('episode-' + S.episode.id, S.data);
}
function setSaveState(saved) {
  const el = $('#saveBadge');
  if (!el) return;
  el.textContent = saved ? '已保存' : '保存中…';
  el.classList.toggle('saving', !saved);
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
  if (adminTab === 'stats') b.innerHTML = '<div class="stat-cards"><div class="stat-card"><div class="sc-label">项目数</div><div class="sc-num">' + (adminCache.projects?.length || 0) + '</div></div></div>';
  else if (adminTab === 'users') renderAdminUsers(b);
  else if (adminTab === 'projects') renderAdminProjects(b);
  else b.innerHTML = '<p class="hint center">服务端管理</p>';
}
function renderAdminUsers(b) {
  const codes = adminCache.codes || [];
  b.innerHTML = `
    <div class="admin-toolbar">
      <input id="cuName" placeholder="用户名称">
      <button class="btn primary" id="btnAddCode">＋ 添加校验码</button>
    </div>
    <table class="admin-table"><tr><th>名称</th><th>校验码</th><th>创建时间</th><th>操作</th></tr>
    ${codes.map(c => `<tr><td>${esc(c.name)}</td><td class="code-mono">${esc(c.code)}</td><td>${fmtTime(c.createdAt)}</td><td><button class="btn small danger" data-del="${c.id}">删除</button></td></tr>`).join('')}
    </table>`;
  $('#btnAddCode').onclick = async () => {
    const name = $('#cuName').value.trim();
    if (!name) return toast('请填写名称', 'err');
    try { await S.api.adminCreateCode(name, ''); toast('已创建', 'ok'); loadAdmin(); } catch (e) { toast(e.message, 'err'); }
  };
  b.querySelectorAll('[data-del]').forEach(btn => btn.onclick = async () => {
    try { await S.api.adminDeleteCode(btn.dataset.del); toast('已删除', 'ok'); loadAdmin(); } catch (e) { toast(e.message, 'err'); }
  });
}
function renderAdminProjects(b) {
  const ps = adminCache.projects || [];
  b.innerHTML = `
    <div class="admin-toolbar">
      <input id="npName" placeholder="项目名称">
      <button class="btn primary" id="btnAddProj">＋ 创建项目</button>
    </div>
    <table class="admin-table"><tr><th>项目</th><th>分集数</th><th>创建时间</th><th>操作</th></tr>
    ${ps.map(p => `<tr><td>${esc(p.name)}</td><td>${(adminCache.episodes || []).filter(e => e.projectId === p.id).length}</td><td>${fmtTime(p.createdAt)}</td><td><button class="btn small danger" data-delp="${p.id}">删除</button></td></tr>`).join('')}
    </table>`;
  $('#btnAddProj').onclick = async () => {
    const name = $('#npName').value.trim();
    if (!name) return toast('请填写名称', 'err');
    try { await S.api.adminCreateProject(name); toast('已创建', 'ok'); loadAdmin(); } catch (e) { toast(e.message, 'err'); }
  };
  b.querySelectorAll('[data-delp]').forEach(btn => btn.onclick = async () => {
    if (!confirm('删除项目将删除所有分集，确定？')) return;
    try { await S.api.adminDeleteProject(btn.dataset.delp); toast('已删除', 'ok'); loadAdmin(); } catch (e) { toast(e.message, 'err'); }
  });
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
  $('#btnAddShot').onclick = addShot;
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