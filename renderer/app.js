// 乾坤设计 v2 - 客户端主逻辑
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtTime = ts => { if (!ts) return '-'; const d = new Date(ts); return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const fmtDur = s => { s = Math.round(Number(s) || 0); return Math.floor(s / 60) + '分' + String(s % 60).padStart(2, '0') + '秒'; };

// ---------- 全局状态 ----------
const S = {
  base: localStorage.getItem('qk_base') || 'http://localhost:3210',
  token: '', user: null, admin: null,
  api: null, collab: new Collab(),
  page: 'login', loginMode: 'user',
  projects: [], project: null, episodes: [], episode: null, data: null,
  assetTab: 'characters',
  sel: { text: '', image: '', video: '' },
  composing: false, updateReady: null, wsRetryTimer: null
};
const VOICES = [
  ['zh-CN-XiaoxiaoNeural', '晓晓(女·温柔)'], ['zh-CN-YunxiNeural', '云希(男·阳光)'], ['zh-CN-YunyangNeural', '云扬(男·沉稳)'],
  ['zh-CN-XiaoyiNeural', '晓伊(女·活泼)'], ['zh-CN-YunjianNeural', '云健(男·浑厚)'], ['zh-CN-liaoning-XiaobeiNeural', '小北(东北)'],
  ['zh-TW-HsiaoChenNeural', '晓臻(台湾)'], ['zh-HK-HiuMaanNeural', '曉曼(粤语)']
];
// 画面风格预设（剧本分解页选择，供 AI 拆解与生图参考）
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
const ASPECTS = [['9:16', '9:16 竖屏', 36, 64], ['16:9', '16:9 横屏', 64, 36], ['1:1', '1:1 方形', 48, 48], ['4:3', '4:3 传统', 56, 42]];

// ---------- Toast / 弹窗 ----------
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
$('#modalClose').onclick = closeModal;
$('#modalMask').addEventListener('click', e => { if (e.target === $('#modalMask')) closeModal(); });

// ---------- 页面切换 ----------
function showPage(name) {
  S.page = name;
  ['login', 'projects', 'episodes', 'setup', 'editor', 'admin'].forEach(p => {
    $('#page-' + p).classList.toggle('hidden', p !== name);
  });
}

// ---------- 文件选择 ----------
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
  return r.url; // 相对路径 /assets/xxx
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

// ================================================================
// 登录页
// ================================================================
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
  if (!/^https?:\/\/.+/.test(base)) { hint.textContent = '服务器地址格式不正确（应以 http:// 开头）'; return; }
  $('#btnLogin').disabled = true; $('#btnLogin').textContent = '连接中…';
  try {
    const probe = new Api(base, '');
    await probe.health(); // 探活
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
      ? '无法连接服务器：请检查地址是否正确（本机服务已自动启动，管理员可直接用默认地址登录）'
      : (msg || '连接失败');
  } finally {
    $('#btnLogin').disabled = false; $('#btnLogin').textContent = '登 录';
  }
}

// ================================================================
// 项目页 / 分集页
// ================================================================
async function loadProjects() {
  S.projects = await S.api.projects();
  $('#projUserBadge').textContent = '👤 ' + (S.user ? S.user.name : '');
  renderProjects();
  showPage('projects');
}
function renderProjects() {
  const g = $('#projGrid');
  if (!S.projects.length) { g.innerHTML = '<div class="proj-empty">暂无项目，请联系管理员在管理端创建</div>'; return; }
  g.innerHTML = S.projects.map(p => `
    <div class="proj-card" data-id="${p.id}">
      <div class="pc-icon">📁</div>
      <h3>${esc(p.name)}</h3>
      <div class="pc-meta"><span>🎬 ${p.episodeCount} 集</span><span>🕐 ${fmtTime(p.updatedAt)}</span></div>
      <div class="pc-enter">进入项目 →</div>
    </div>`).join('');
  $$('.proj-card').forEach(c => c.onclick = () => openProject(c.dataset.id));
}
async function openProject(id) {
  try {
    const r = await S.api.project(id);
    S.project = r.project; S.episodes = r.episodes;
    $('#epProjName').textContent = S.project.name;
    renderEpisodes();
    showPage('episodes');
  } catch (e) { toast(e.message, 'err'); }
}
function renderEpisodes() {
  const w = $('#epList');
  if (!S.episodes.length) { w.innerHTML = '<div class="ep-empty">还没有分集，点击右上角「新建分集」开始创作</div>'; return; }
  w.innerHTML = S.episodes.map(e2 => `
    <div class="ep-item" data-id="${e2.id}">
      <div>
        <div class="ep-name">${esc(e2.name)}</div>
        <div class="ep-meta"><span>🕐 更新 ${fmtTime(e2.updatedAt)}</span><span>✍️ ${esc(e2.updatedBy || '-')}</span></div>
      </div>
      <button class="btn primary small">进入编辑 →</button>
    </div>`).join('');
  $$('.ep-item').forEach(el => el.onclick = () => openEpisode(el.dataset.id));
}
function newEpisode() {
  const count = S.episodes.length;
  const defName = '第' + (count + 1) + '集';
  // 注意：Electron 不支持 window.prompt()，必须用应用内弹窗
  openModal('新建分集', `
    <div class="form-row"><label>分集名称</label><input id="neName" value="${esc(defName)}"></div>
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
      await openProject(S.project.id); // 刷新分集列表数据
      toast('已创建分集「' + name + '」，进入编辑…', 'ok');
      openEpisode(r.episode.id); // 创建后直接进入创作界面
    } catch (e) {
      toast(e.message, 'err', 4000);
      btn.disabled = false; btn.textContent = '创建并进入编辑';
    }
  };
}

// ================================================================
// 编辑器
// ================================================================
function videoMode() {
  const vm = (S.project.models.video || []).find(m => m.id === S.sel.video);
  return vm ? (vm.type || 'allref') : 'allref';
}
async function openEpisode(id) {
  try {
    const r = await S.api.episode(id);
    S.episode = r.episode;
    S.data = Object.assign({ aspect: '9:16', style: '', script: '', shots: [] }, r.data);
    if (!Array.isArray(S.data.shots)) S.data.shots = [];
    $('#edEpisodeName').textContent = S.project.name + ' · ' + S.episode.name;
    $('#setupEpName').textContent = S.project.name + ' · ' + S.episode.name + ' · 剧本分解';
    $('#assetProjTag').textContent = '（' + S.project.name + ' 全员共享）';
    // 模型选择恢复
    const saved = JSON.parse(localStorage.getItem('qk_sel_' + S.project.id) || '{}');
    S.sel = { text: saved.text || '', image: saved.image || '', video: saved.video || '' };
    renderModelSels();
    // 实时协作（分解页与编辑页共用一条连接）
    S.collab.connect(S.base, S.token);
    S.collab.join(S.project.id, S.episode.id);
    setSaveState(true);
    showSetup();
  } catch (e) { toast(e.message, 'err'); }
}
// ---------- 剧本分解页 ----------
function showSetup() {
  renderSetup();
  showPage('setup');
}
function renderSetup() {
  $('#setupScript').value = S.data.script || '';
  // 风格
  $('#styleChips').innerHTML = STYLES.map(([name]) =>
    `<button class="style-chip${S.data.style === name ? ' active' : ''}" data-style="${esc(name)}">${esc(name)}</button>`).join('');
  $$('#styleChips .style-chip').forEach(c => c.onclick = () => {
    S.data.style = c.dataset.style;
    emitOp({ kind: 'episode-meta', episodeId: S.episode.id, style: S.data.style });
    $$('#styleChips .style-chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
  });
  // 比例
  $('#aspectOpts').innerHTML = ASPECTS.map(([v, label, w, h]) => `
    <button class="aspect-opt${S.data.aspect === v ? ' active' : ''}" data-v="${v}">
      <span class="ao-box" style="width:${w}px;height:${h}px"></span><span>${label}</span>
    </button>`).join('');
  $$('#aspectOpts .aspect-opt').forEach(b => b.onclick = () => {
    S.data.aspect = b.dataset.v;
    emitOp({ kind: 'episode-meta', episodeId: S.episode.id, aspect: S.data.aspect });
    $$('#aspectOpts .aspect-opt').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
  });
  // 已有分镜提示
  const n = S.data.shots.length;
  const badge = $('#setupExistBadge');
  badge.textContent = n ? '已有 ' + n + ' 个分镜' : '';
  $('#setupHint').textContent = n ? '该分集已有 ' + n + ' 个分镜，重新解析将覆盖现有分镜（剧本与资产不受影响）。' : '';
  $('#btnSkipParse').textContent = n ? '⏭ 直接进入操作界面（保留已有分镜）' : '⏭ 跳过剧本拆解，直接进入';
}
function enterEditorPage() {
  renderEditor();
  showPage('editor');
}
async function skipParse() {
  // 保存分解页填写的剧本/风格/比例
  S.data.script = $('#setupScript').value;
  emitOp({ kind: 'episode-meta', episodeId: S.episode.id, script: S.data.script });
  flushOps();
  enterEditorPage();
  if (!S.data.shots.length) toast('已跳过拆解，点击「＋ 添加分镜」开始手动创作', '', 3500);
}
function renderModelSels() {
  const mk = (elId, list, key, label) => {
    const el = $(elId);
    if (!list.length) { el.innerHTML = '<option value="">未配置' + label + '</option>'; el.disabled = true; return; }
    if (!list.some(m => m.id === S.sel[key])) S.sel[key] = list[0].id;
    el.innerHTML = list.map(m => `<option value="${m.id}">${esc(m.name)}${key === 'video' ? (m.type === 'firstlast' ? '（首尾帧）' : '（全能参考）') : ''}</option>`).join('');
    el.value = S.sel[key];
    el.disabled = false;
    el.onchange = () => {
      S.sel[key] = el.value;
      localStorage.setItem('qk_sel_' + S.project.id, JSON.stringify(S.sel));
      if (key === 'video') renderEditor(); // 切换模式刷新分镜列
    };
  };
  mk('#selTextModel', S.project.models.text || [], 'text', '文本模型');
  mk('#selImageModel', S.project.models.image || [], 'image', '图片模型');
  mk('#selVideoModel', S.project.models.video || [], 'video', '视频模型');
}
function renderEditor() {
  renderShots();
  renderAssets();
}
function shotById(id) { return S.data.shots.find(s => s.id === id); }
function assetsOf(kind) { return (S.project.assets && S.project.assets[kind]) || []; }

// ---------- 分镜渲染（九列操作表格） ----------
function renderShots() {
  const mode = videoMode();
  $('#storyColTitle').textContent = mode === 'firstlast' ? '分镜首尾帧' : '分镜图';
  const wrap = $('#shotsWrap');
  if (!S.data.shots.length) {
    wrap.innerHTML = `<tr class="story-empty-row"><td colspan="9"><div class="story-empty">暂无分镜<br><br>可返回「📄 剧本」分解页解析剧本，<br>或点击下方「＋ 添加分镜」手动创作</div></td></tr>`;
    return;
  }
  const A = S.project.assets || { characters: [], scenes: [], props: [], others: [], sfx: [] };
  wrap.innerHTML = S.data.shots.map((s, i) => {
    const chars = A.characters.map(c => `<option value="${c.id}" ${(s.characterIds || []).includes(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const scenes = A.scenes.map(c => `<option value="${c.id}" ${s.sceneId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const props = A.props.map(c => `<option value="${c.id}" ${(s.propIds || []).includes(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const others = A.others.map(c => `<option value="${c.id}" ${(s.otherIds || []).includes(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const sfx = A.sfx.map(c => `<option value="${c.id}" ${s.sfxId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const frameSlot = (label, field) => `
      <div class="frame-slot" data-shot="${s.id}" data-field="${field}">
        <div class="fs-label">${label}</div>
        ${s[field] ? `<img src="${esc(S.api.abs(s[field]))}" data-act="preview">` : ''}
        <div class="fs-btns">
          <button class="btn small" data-act="upload">上传</button>
          <button class="btn small" data-act="ai" ${!(S.project.models.image || []).length ? 'disabled' : ''}>AI生成</button>
          ${s[field] ? '<button class="btn small danger" data-act="clear">删除</button>' : ''}
        </div>
      </div>`;
    const framesHtml = mode === 'firstlast'
      ? `<div class="frames-row">${frameSlot('首帧图', 'firstImg')}${frameSlot('尾帧图', 'lastImg')}</div>`
      : `<div class="frames-row">${frameSlot('分镜图', 'storyboardImg')}</div>`;
    return `
    <tr class="shot-card" data-id="${s.id}">
      <td class="st-no">
        <div class="shot-no">${i + 1}</div>
        <div class="no-btns">
          <button class="btn ghost small" data-act="up" title="上移">↑</button>
          <button class="btn ghost small" data-act="down" title="下移">↓</button>
          <button class="btn ghost small danger" data-act="del" title="删除">✕</button>
        </div>
      </td>
      <td class="st-script">
        <textarea data-f="text" placeholder="画面描述">${esc(s.text)}</textarea>
        <textarea data-f="dialogue" class="mini" placeholder="台词">${esc(s.dialogue)}</textarea>
        <input data-f="speaker" class="mini" placeholder="说话人" value="${esc(s.speaker)}">
      </td>
      <td class="st-chars"><select data-f="characterIds" multiple size="4"><option value="" disabled>（选择出场人物）</option>${chars}</select></td>
      <td class="st-scene"><select data-f="sceneId"><option value="">（无）</option>${scenes}</select></td>
      <td class="st-props"><select data-f="propIds" multiple size="4">${props}</select></td>
      <td class="st-others"><select data-f="otherIds" multiple size="4">${others}</select></td>
      <td class="st-aux">
        <button class="btn small" data-act="gen-img" ${!(S.project.models.image || []).length ? 'disabled' : ''}>🖼 AI生成分镜图</button>
        <select data-f="voice" class="mini">${VOICES.map(v => `<option value="${v[0]}" ${s.voice === v[0] ? 'selected' : ''}>${v[1]}</option>`).join('')}</select>
        <button class="btn small" data-act="gen-voice">🎙 配音</button>
        ${s.voiceUrl ? `<audio controls preload="none" src="${esc(S.api.abs(s.voiceUrl))}"></audio>` : ''}
        <select data-f="sfxId" class="mini"><option value="">音效（无）</option>${sfx}</select>
      </td>
      <td class="st-img">${framesHtml}</td>
      <td class="st-video">
        ${s.videoUrl ? `<video controls preload="none" src="${esc(s.videoUrl)}"></video>` : '<span class="v-empty">未生成</span>'}
        <button class="btn small" data-act="gen-video">🎬 生成本镜视频</button>
      </td>
    </tr>`;
  }).join('');
}

// ---------- 分镜事件（委托） ----------
function initShotEvents() {
  const wrap = $('#shotsWrap');
  const upd = (id, patch, rerender) => {
    const s = shotById(id); if (!s) return;
    Object.assign(s, patch);
    emitOp({ kind: 'shot-update', episodeId: S.episode.id, shot: s });
    if (rerender) renderShots();
  };
  wrap.addEventListener('input', e => {
    const card = e.target.closest('.shot-card'); if (!card) return;
    const id = card.dataset.id, f = e.target.dataset.f;
    if (!f) return;
    if (['text', 'dialogue', 'speaker'].includes(f)) { upd(id, { [f]: e.target.value }); return; }
    if (f === 'characterIds' || f === 'propIds' || f === 'otherIds') {
      upd(id, { [f]: Array.from(e.target.selectedOptions).map(o => o.value) });
    }
  });
  wrap.addEventListener('change', e => {
    const card = e.target.closest('.shot-card'); if (!card) return;
    const id = card.dataset.id, f = e.target.dataset.f;
    if (f === 'sceneId' || f === 'sfxId' || f === 'voice') upd(id, { [f]: e.target.value });
  });
  wrap.addEventListener('click', async e => {
    const btn = e.target.closest('button'); if (!btn) return;
    const card = btn.closest('.shot-card');
    const slot = btn.closest('.frame-slot');
    const act = btn.dataset.act;
    if (slot && act) return handleFrameAction(slot, act);
    if (!card) return;
    const id = card.dataset.id;
    const idx = S.data.shots.findIndex(s => s.id === id);
    if (act === 'del') {
      if (!confirm('删除该分镜？')) return;
      S.data.shots.splice(idx, 1);
      emitOp({ kind: 'shot-delete', episodeId: S.episode.id, shotId: id });
      renderShots();
    } else if (act === 'up' && idx > 0) {
      const arr = S.data.shots; [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
      emitOp({ kind: 'shot-reorder', episodeId: S.episode.id, shotIds: arr.map(s => s.id) });
      renderShots();
    } else if (act === 'down' && idx < S.data.shots.length - 1) {
      const arr = S.data.shots; [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]];
      emitOp({ kind: 'shot-reorder', episodeId: S.episode.id, shotIds: arr.map(s => s.id) });
      renderShots();
    } else if (act === 'gen-img') {
      await genShotImage(id);
    } else if (act === 'gen-voice') {
      await genShotVoice(id);
    }
  });
}
async function handleFrameAction(slot, act) {
  const id = slot.dataset.shot, field = slot.dataset.field;
  const s = shotById(id); if (!s) return;
  if (act === 'upload') {
    try {
      const url = await uploadPicked('image/*');
      if (url) { updShot(id, { [field]: url }); renderShots(); }
    } catch (e) { toast(e.message, 'err'); }
  } else if (act === 'clear') {
    updShot(id, { [field]: '' }); renderShots();
  } else if (act === 'preview') {
    openModal('预览', `<img src="${esc(S.api.abs(s[field]))}" style="width:100%">`, true);
  } else if (act === 'ai') {
    await genFrameImage(id, field);
  }
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
  renderShots();
  const el = $(`.shot-card[data-id="${s.id}"]`);
  if (el) { el.scrollIntoView({ behavior: 'smooth' }); el.querySelector('textarea').focus(); }
}

// ---------- 资产渲染 ----------
function renderAssets() {
  const kind = S.assetTab;
  const list = assetsOf(kind);
  const w = $('#assetsWrap');
  if (!list.length) { w.innerHTML = `<div class="asset-empty">暂无${tabName(kind)}资产<br>点击右上角「＋ 新增资产」</div>`; return; }
  w.innerHTML = list.map(a => `
    <div class="asset-card" data-id="${a.id}">
      ${a.img ? `<img class="as-img" src="${esc(S.api.abs(a.img))}" data-act="preview-img">` : ''}
      ${a.audio ? `<audio class="as-audio" controls preload="none" src="${esc(S.api.abs(a.audio))}"></audio>` : ''}
      <h4>${esc(a.name)} ${a.voice ? '<span class="as-voice-tag">' + esc((VOICES.find(v => v[0] === a.voice) || ['', a.voice])[1]) + '</span>' : ''}</h4>
      ${a.desc ? `<div class="as-desc">${esc(a.desc)}</div>` : ''}
      <div class="as-btns">
        <button class="btn small" data-act="edit">编辑</button>
        <button class="btn small danger" data-act="del">删除</button>
      </div>
    </div>`).join('');
}
function tabName(k) { return { characters: '人物', scenes: '场景', props: '道具', others: '其他', sfx: '音效' }[k] || k; }
function initAssetEvents() {
  $$('.asset-tab').forEach(t => t.onclick = () => {
    $$('.asset-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active'); S.assetTab = t.dataset.tab; renderAssets();
  });
  $('#assetsWrap').addEventListener('click', async e => {
    const card = e.target.closest('.asset-card'); if (!card) return;
    const id = card.dataset.id;
    const list = assetsOf(S.assetTab);
    const a = list.find(x => x.id === id); if (!a) return;
    if (e.target.dataset.act === 'preview-img') {
      openModal('预览 · ' + a.name, `<img src="${esc(S.api.abs(a.img))}" style="width:100%">`, true);
    } else if (e.target.dataset.act === 'edit') {
      openAssetModal(S.assetTab, a);
    } else if (e.target.dataset.act === 'del') {
      if (!confirm('删除资产「' + a.name + '」？')) return;
      const arr = assetsOf(S.assetTab);
      const i = arr.findIndex(x => x.id === id);
      if (i >= 0) arr.splice(i, 1);
      emitOp({ kind: 'assets-update', assets: S.project.assets });
      renderAssets();
    }
  });
}
function openAssetModal(kind, asset) {
  const isSfx = kind === 'sfx';
  const isChar = kind === 'characters';
  const a = asset || { id: uid(), name: '', desc: '', img: '', audio: '', voice: isChar ? 'zh-CN-XiaoxiaoNeural' : '' };
  openModal((asset ? '编辑' : '新增') + tabName(kind) + '资产', `
    <div class="form-row"><label>名称 *</label><input id="amName" value="${esc(a.name)}"></div>
    <div class="form-row"><label>描述（供 AI 参考）</label><textarea id="amDesc" rows="3">${esc(a.desc)}</textarea></div>
    ${!isSfx ? `<div class="form-row"><label>参考图</label>
      <div class="img-row">
        <img id="amImgPrev" src="${a.img ? esc(S.api.abs(a.img)) : ''}" style="width:86px;height:60px;object-fit:cover;border-radius:8px;background:var(--bg4)">
        <button class="btn small" id="amImgUp">上传图片</button>
        <button class="btn small" id="amImgAi" ${!(S.project.models.image || []).length ? 'disabled' : ''}>✨ AI生成</button>
        ${a.img ? '<button class="btn small danger" id="amImgDel">删除</button>' : ''}
      </div></div>` : ''}
    ${isSfx ? `<div class="form-row"><label>音频文件</label>
      <div class="img-row">${a.audio ? `<audio controls preload="none" src="${esc(S.api.abs(a.audio))}"></audio>` : '<span style="font-size:12px;color:var(--text3)">未上传</span>'}<button class="btn small" id="amAudUp">上传音频</button></div></div>` : ''}
    ${isChar ? `<div class="form-row"><label>绑定配音音色（自动配音时使用）</label><select id="amVoice">${VOICES.map(v => `<option value="${v[0]}" ${a.voice === v[0] ? 'selected' : ''}>${v[1]}</option>`).join('')}</select></div>` : ''}
    <div class="modal-foot-btns"><button class="btn ghost" id="amCancel">取消</button><button class="btn primary" id="amSave">保存</button></div>
  `);
  let img = a.img, audio = a.audio;
  const up = $('#amImgUp'); if (up) up.onclick = async () => {
    try { const u = await uploadPicked('image/*'); if (u) { img = u; $('#amImgPrev').src = S.api.abs(u); } } catch (e) { toast(e.message, 'err'); }
  };
  const ai = $('#amImgAi'); if (ai) ai.onclick = async () => {
    const name = $('#amName').value.trim(), desc = $('#amDesc').value.trim();
    if (!name) return toast('请先填写资产名称', 'err');
    ai.disabled = true; ai.textContent = '生成中…';
    try {
      const prompt = buildAssetPrompt(kind, name, desc);
      const r = await S.api.aiImage(S.project.id, S.sel.image, prompt, '9:16');
      img = r.url; $('#amImgPrev').src = S.api.abs(r.url);
      toast('生成成功', 'ok');
    } catch (e) { toast(e.message, 'err', 4000); }
    finally { ai.disabled = false; ai.textContent = '✨ AI生成'; }
  };
  const del = $('#amImgDel'); if (del) del.onclick = () => { img = ''; $('#amImgPrev').removeAttribute('src'); };
  const au = $('#amAudUp'); if (au) au.onclick = async () => {
    try { const u = await uploadPicked('audio/*'); if (u) { audio = u; toast('音频已上传', 'ok'); } } catch (e) { toast(e.message, 'err'); }
  };
  $('#amCancel').onclick = closeModal;
  $('#amSave').onclick = () => {
    const name = $('#amName').value.trim();
    if (!name) return toast('请填写名称', 'err');
    a.name = name; a.desc = $('#amDesc').value.trim(); a.img = img; a.audio = audio;
    if (isChar) a.voice = $('#amVoice').value;
    if (!asset) {
      if (!S.project.assets) S.project.assets = { characters: [], scenes: [], props: [], others: [], sfx: [] };
      if (!S.project.assets[kind]) S.project.assets[kind] = [];
      S.project.assets[kind].push(a);
    }
    emitOp({ kind: 'assets-update', assets: S.project.assets });
    closeModal(); renderAssets();
  };
}
function buildAssetPrompt(kind, name, desc) {
  const kindName = tabName(kind);
  return `为漫剧生成${kindName}资产设定图：${name}。${desc || ''}。高质量插画风格，主体突出，细节丰富，适合作为动画制作参考图。`;
}

// ---------- AI 拆解剧本（剧本分解页「开始解析」） ----------
async function parseScript() {
  const script = $('#setupScript').value.trim();
  if (!script) return toast('请先输入剧本内容', 'err');
  if (!(S.project.models.text || []).length) return toast('该项目未配置文本模型，请联系管理员', 'err');
  const btn = $('#btnStartParse');
  const hint = $('#setupHint');
  btn.disabled = true; btn.textContent = '⏳ 解析中…';
  hint.textContent = 'AI 正在拆解剧本，请稍候（长剧本可能需要 1-2 分钟）…';
  try {
    const A = S.project.assets || {};
    const assetList = {
      characters: (A.characters || []).map(c => c.name),
      scenes: (A.scenes || []).map(c => c.name),
      props: (A.props || []).map(c => c.name),
      others: (A.others || []).map(c => c.name),
      sfx: (A.sfx || []).map(c => c.name)
    };
    const styleDesc = (STYLES.find(x => x[0] === S.data.style) || ['', ''])[1];
    const sys = `你是专业的漫剧分镜师。将剧本拆解为分镜列表。严格返回JSON：
{"shots":[{"text":"画面描述","dialogue":"台词(无台词则为空串)","speaker":"说话人名(无则空)","characters":["出场人物名"],"scene":"场景名(无则空)","props":["道具名"],"other":["其他参考"],"sfx":"音效名(无则空)"}]}
规则：1.按剧情节奏拆分(通常每镜2-4句旁白/对话) 2.人物/场景/道具尽量从已有资产列表匹配 3.台词=该镜所有对白原文 4.画面描述需符合指定画风 5.只返回JSON。`;
    const usr = `画风：${S.data.style || '未指定'}（${styleDesc || '自由发挥'}）\n画幅：${S.data.aspect || '9:16'}\n已有资产：${JSON.stringify(assetList)}\n\n剧本：\n${script.slice(0, 8000)}`;
    const r = await S.api.aiText(S.project.id, S.sel.text, [{ role: 'system', content: sys }, { role: 'user', content: usr }], true);
    const j = extractJSON(r.content);
    const shots = (j.shots || []).map(o => ({
      id: uid(),
      text: String(o.text || ''), dialogue: String(o.dialogue || ''), speaker: String(o.speaker || ''),
      characterIds: matchAssets(A.characters, o.characters),
      sceneId: matchAssets(A.scenes, o.scene ? [o.scene] : [])[0] || '',
      propIds: matchAssets(A.props, o.props),
      otherIds: matchAssets(A.others, o.other),
      sfxId: matchAssets(A.sfx, o.sfx ? [o.sfx] : [])[0] || '',
      duration: 0, storyboardImg: '', firstImg: '', lastImg: '',
      voiceUrl: '', voice: 'zh-CN-XiaoxiaoNeural'
    }));
    if (!shots.length) throw new Error('AI 未拆解出分镜');
    // 保存剧本/风格/比例并替换分镜（实时同步）
    S.data.script = script;
    S.data.shots = shots;
    emitOp({ kind: 'shots-replace', episodeId: S.episode.id, shots, script });
    emitOp({ kind: 'episode-meta', episodeId: S.episode.id, style: S.data.style, aspect: S.data.aspect });
    flushOps();
    toast('拆解完成：' + shots.length + ' 个分镜，正在进入操作界面…', 'ok');
    enterEditorPage(); // 平滑过渡至九列操作界面
  } catch (e) {
    hint.textContent = '';
    toast('拆解失败：' + (e.message || e), 'err', 4500);
  } finally { btn.disabled = false; btn.textContent = '✨ 开始解析'; }
}
function matchAssets(list, names) {
  if (!list || !names) return [];
  return list.filter(a => names.some(n => n && (a.name === n || a.name.includes(n) || String(n).includes(a.name)))).map(a => a.id);
}

// ---------- AI 生图（分镜图/首尾帧） ----------
function buildShotPrompt(s) {
  const A = S.project.assets || {};
  const parts = [];
  parts.push('漫剧画面：' + (s.text || ''));
  const chars = (A.characters || []).filter(c => (s.characterIds || []).includes(c.id));
  chars.forEach(c => parts.push('人物[' + c.name + ']：' + (c.desc || c.name)));
  const sc = (A.scenes || []).find(c => c.id === s.sceneId);
  if (sc) parts.push('场景[' + sc.name + ']：' + (sc.desc || sc.name));
  (A.props || []).filter(c => (s.propIds || []).includes(c.id)).forEach(c => parts.push('道具[' + c.name + ']'));
  (A.others || []).filter(c => (s.otherIds || []).includes(c.id)).forEach(c => parts.push('其他[' + c.name + ']：' + (c.desc || c.name)));
  if (s.dialogue) parts.push('画面需契合台词情境：' + s.dialogue.slice(0, 50));
  return parts.join('；') + '。高质量动漫风格，构图完整。';
}
async function genFrameImage(id, field) {
  const s = shotById(id); if (!s) return;
  if (!(S.project.models.image || []).length) return toast('该项目未配置图片模型，请联系管理员', 'err');
  const slot = $(`.frame-slot[data-shot="${id}"][data-field="${field}"] .fs-btns [data-act="ai"]`);
  if (slot) { slot.disabled = true; slot.textContent = '生成中…'; }
  try {
    const label = field === 'firstImg' ? '首帧' : field === 'lastImg' ? '尾帧' : '分镜';
    let prompt = buildShotPrompt(s);
    if (field === 'lastImg' && s.dialogue) prompt += ' 画面为该镜头结束时刻的状态。';
    const r = await S.api.aiImage(S.project.id, S.sel.image, prompt, S.data.aspect);
    updShot(id, { [field]: r.url });
    renderShots();
    toast(label + '图已生成', 'ok');
  } catch (e) { toast(e.message, 'err', 4000); renderShots(); }
}
async function genShotImage(id) {
  const mode = videoMode();
  if (mode === 'firstlast') return toast('首尾帧模式请分别生成首帧/尾帧图', 'err');
  await genFrameImage(id, 'storyboardImg');
}

// ---------- 配音 ----------
async function genShotVoice(id) {
  const s = shotById(id); if (!s) return;
  const text = (s.dialogue || s.text || '').trim();
  if (!text) return toast('该分镜没有台词/描述，无法配音', 'err');
  // 优先使用人物绑定音色
  let voice = s.voice || 'zh-CN-XiaoxiaoNeural';
  const A = (S.project.assets || {}).characters || [];
  const c = A.find(x => (s.characterIds || []).includes(x.id) && x.voice);
  if (c) voice = c.voice;
  try {
    toast('配音生成中…');
    const r = await window.mochi.ttsGenerate({ text, voice, rate: '+0%', pitch: '+0Hz' });
    if (!r.dataBase64) throw new Error('TTS 返回为空');
    const up = await S.api.upload('voice.mp3', r.dataBase64);
    updShot(id, { voiceUrl: up.url, voice });
    renderShots();
    toast('配音完成（' + (r.duration || 0).toFixed(1) + 's）', 'ok');
  } catch (e) { toast('配音失败：' + (e.message || e), 'err', 4000); }
}

// ---------- 合成视频（480P） ----------
function initCompose() {
  window.mochi.onComposeProgress(d => {
    const bar = $('#cpBarInner'), txt = $('#cpText');
    if (bar) bar.style.width = Math.round(((d.cur + 1) / Math.max(d.total, 1)) * 100) + '%';
    if (txt) txt.textContent = d.text || '';
  });
}
async function composeVideo() {
  if (S.composing) return;
  const shots = S.data.shots;
  if (!shots.length) return toast('没有分镜可合成', 'err');
  const mode = videoMode();
  const useVideoModel = !!(S.sel.video && (S.project.models.video || []).length);
  // 首尾帧模式校验
  if (useVideoModel && mode === 'firstlast') {
    const bad = shots.filter(s => !s.firstImg || !s.lastImg);
    if (bad.length) {
      const idxs = bad.map(s => shots.indexOf(s) + 1).join('、');
      toast('请完善分镜首尾帧（第 ' + idxs + ' 镜缺少首帧或尾帧图）', 'err', 5000);
      return;
    }
  }
  // 本地方案需有分镜图
  if (!useVideoModel) {
    const bad = shots.filter(s => !(s.storyboardImg || s.firstImg || s.lastImg));
    if (bad.length) {
      const idxs = bad.map(s => shots.indexOf(s) + 1).join('、');
      toast('第 ' + idxs + ' 镜缺少分镜图，请先生成或上传', 'err', 5000);
      return;
    }
  }
  S.composing = true;
  openModal('生成视频（480P）', `
    <div class="compose-progress">
      <div class="progress-bar"><div id="cpBarInner" style="width:0%"></div></div>
      <div class="cp-text" id="cpText">准备中…</div>
      <p class="hint">视频模型：${useVideoModel ? esc(((S.project.models.video || []).find(m => m.id === S.sel.video) || {}).name || '') + '（' + (mode === 'firstlast' ? '首尾帧' : '全能参考') + '）' : '本地方案（分镜图+配音+字幕）'}</p>
    </div>`);
  try {
    const A = S.project.assets || {};
    const spec = {
      name: S.project.name + '-' + S.episode.name,
      aspect: S.data.aspect || '9:16',
      projectId: S.project.id,
      serverBase: S.base, token: S.token,
      videoModelId: useVideoModel ? S.sel.video : null,
      shots: shots.map(s => {
        const chars = (A.characters || []).filter(c => (s.characterIds || []).includes(c.id));
        const sc = (A.scenes || []).find(c => c.id === s.sceneId);
        const props = (A.props || []).filter(c => (s.propIds || []).includes(c.id));
        const oth = (A.others || []).filter(c => (s.otherIds || []).includes(c.id));
        const sfx = (A.sfx || []).find(c => c.id === s.sfxId);
        // 视频模型提示词：综合所有参考
        const vp = [];
        vp.push(s.text || '');
        chars.forEach(c => vp.push('人物「' + c.name + '」' + (c.desc || '')));
        if (sc) vp.push('场景「' + sc.name + '」' + (sc.desc || ''));
        props.forEach(p => vp.push('道具「' + p.name + '」'));
        oth.forEach(o => vp.push('元素「' + o.name + '」'));
        if (s.dialogue) vp.push('剧情台词：' + s.dialogue);
        return {
          id: s.id, text: s.text, dialogue: s.dialogue, speaker: s.speaker,
          voiceUrl: s.voiceUrl ? S.api.abs(s.voiceUrl) : null,
          sfxUrl: sfx && sfx.audio ? S.api.abs(sfx.audio) : null,
          storyboardImgUrl: s.storyboardImg ? S.api.abs(s.storyboardImg) : null,
          firstImgUrl: s.firstImg ? S.api.abs(s.firstImg) : null,
          lastImgUrl: s.lastImg ? S.api.abs(s.lastImg) : null,
          videoPrompt: vp.join('；'), duration: s.duration || 0
        };
      })
    };
    const r = await window.mochi.composeVideo(spec);
    if (!r.ok) throw new Error(r.error);
    // 上传统计（按分镜记录）
    try {
      await S.api.stats({
        projectId: S.project.id, episodeId: S.episode.id, kind: 'video',
        resolution: '480P', durationSec: r.duration,
        items: r.segments.map(g => ({ shotId: g.id, index: g.index, text: (shotById(g.id) || {}).text || '', duration: g.duration }))
      });
    } catch (e) { }
    openModal('生成完成 🎉', `
      <p class="hint">总时长 ${fmtDur(r.duration)} · 480P · ${shots.length} 个分镜</p>
      <video class="preview-video" controls src="${esc(r.url)}"></video>
      <div class="modal-foot-btns">
        <button class="btn ghost" id="pvShow">打开所在文件夹</button>
        <button class="btn primary" id="pvClose">完成</button>
      </div>`);
    $('#pvClose').onclick = closeModal;
    $('#pvShow').onclick = () => window.mochi.showInFolder(r.path);
    toast('视频已生成（480P）', 'ok', 4000);
  } catch (e) {
    openModal('生成失败', `<p class="hint" style="color:var(--err)">${esc(e.message || e)}</p><div class="modal-foot-btns"><button class="btn primary" onclick="document.querySelector('#modalClose').click()">关闭</button></div>`);
  } finally { S.composing = false; }
}

// ================================================================
// 实时保存 / 实时协作
// ================================================================
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
  el.textContent = saved ? '已实时保存' : '保存中…';
  el.classList.toggle('saving', !saved);
}
async function fullSaveEpisode() {
  if (!S.episode || !S.data || !S.api) return;
  try { await S.api.saveEpisode(S.episode.id, { name: S.episode.name, aspect: S.data.aspect, script: S.data.script, shots: S.data.shots }); } catch (e) { }
}
function initCollab() {
  S.collab.onOp = m => {
    const { op, clientId } = m;
    if (clientId === S.collab.clientId) return;
    if (!op || !S.data) return;
    let rerender = false, rerenderAssets = false;
    if (op.kind === 'shot-add') {
      if (!S.data.shots.some(s => s.id === op.shot.id)) { S.data.shots.push(op.shot); rerender = true; }
    } else if (op.kind === 'shot-update') {
      const i = S.data.shots.findIndex(s => s.id === op.shot.id);
      if (i >= 0) { S.data.shots[i] = op.shot; rerender = true; }
    } else if (op.kind === 'shot-delete') {
      S.data.shots = S.data.shots.filter(s => s.id !== op.shotId); rerender = true;
    } else if (op.kind === 'shots-replace') {
      S.data.shots = op.shots; if (op.script !== undefined) { S.data.script = op.script; $('#setupScript').value = op.script; }
      rerender = true;
    } else if (op.kind === 'shot-reorder') {
      const map = new Map(S.data.shots.map(s => [s.id, s]));
      S.data.shots = op.shotIds.map(id => map.get(id)).filter(Boolean); rerender = true;
    } else if (op.kind === 'assets-update') {
      S.project.assets = op.assets; rerenderAssets = true;
    } else if (op.kind === 'episode-meta') {
      if (op.aspect !== undefined) S.data.aspect = op.aspect;
      if (op.style !== undefined) S.data.style = op.style;
      if (op.script !== undefined) { S.data.script = op.script; $('#setupScript').value = op.script; }
      // 分解页打开时同步刷新风格/比例选中态
      if (S.page === 'setup') renderSetup();
    }
    // 焦点保护：正在输入的控件不重绘（避免打断打字）
    const focusEl = document.activeElement;
    const focusInShots = focusEl && focusEl.closest && focusEl.closest('#shotsWrap');
    if (rerender) { if (!focusInShots) renderShots(); }
    if (rerenderAssets) renderAssets();
    if (m.from) toast(m.from.name + ' 更新了内容', '', 1600);
  };
  S.collab.onPresence = users => {
    const el = $('#presenceBadge');
    if (!el) return;
    const mine = S.user ? S.user.id : '';
    const others = users.filter(u => u.userId !== mine);
    if (!others.length) { el.textContent = ''; el.style.display = 'none'; return; }
    el.style.display = '';
    el.textContent = '👥 ' + others.map(u => u.name).join('、') + (others.length > 1 ? ' 正在协作' : ' 正在编辑');
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

// ================================================================
// 管理端
// ================================================================
let adminTab = 'stats', adminCache = null;
function enterAdmin() {
  $('#adminName').textContent = '👤 ' + S.admin.name + '（' + S.admin.username + '）';
  showPage('admin');
  loadAdmin();
}
async function loadAdmin() {
  try {
    adminCache = await S.api.adminData();
    renderAdmin();
  } catch (e) { toast(e.message, 'err'); }
}
function renderAdmin() {
  const b = $('#adminBody');
  if (!adminCache) { b.innerHTML = '<p class="hint">加载中…</p>'; return; }
  if (adminTab === 'stats') renderAdminStats(b);
  else if (adminTab === 'users') renderAdminUsers(b);
  else if (adminTab === 'projects') renderAdminProjects(b);
  else if (adminTab === 'server') renderAdminServer(b);
}
// ---- 统计 ----
function renderAdminStats(b) {
  const st = adminCache.stats.filter(x => x.kind === 'video');
  const groupIds = new Set(st.map(x => x.groupId));
  const totalDur = st.reduce((s, x) => s + (x.durationSec || 0), 0);
  const users = new Set(st.map(x => x.userId));
  // 按用户
  const byUser = {};
  st.forEach(x => {
    byUser[x.userName] = byUser[x.userName] || { count: 0, groups: new Set(), dur: 0 };
    byUser[x.userName].count++; byUser[x.userName].groups.add(x.groupId); byUser[x.userName].dur += x.durationSec || 0;
  });
  // 按分镜（项目/集/镜号）
  const byShot = {};
  st.forEach(x => {
    const k = x.projectId + '|' + x.episodeId + '|' + x.shotIndex;
    byShot[k] = byShot[k] || { projectName: x.projectName, episodeName: x.episodeName, idx: x.shotIndex, text: x.shotText, count: 0, last: 0, dur: 0, res: x.resolution };
    byShot[k].count++; byShot[k].last = Math.max(byShot[k].last, x.ts); byShot[k].dur += x.durationSec || 0;
  });
  const shotRows = Object.values(byShot).sort((a, b2) => b2.last - a.last).slice(0, 300);
  b.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card"><div class="sc-label">生成视频总数</div><div class="sc-num acc">${groupIds.size}</div></div>
      <div class="stat-card"><div class="sc-label">分镜生成次数</div><div class="sc-num">${st.length}</div></div>
      <div class="stat-card"><div class="sc-label">视频总时长</div><div class="sc-num ok">${fmtDur(totalDur)}</div></div>
      <div class="stat-card"><div class="sc-label">参与用户数</div><div class="sc-num warn">${users.size}</div></div>
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
// ---- 用户（校验码） ----
function renderAdminUsers(b) {
  const codes = adminCache.codes || [];
  b.innerHTML = `
    <div class="admin-toolbar">
      <input id="cuName" placeholder="用户名称（如：张三）">
      <input id="cuCode" placeholder="校验码（留空自动生成）" style="width:200px">
      <button class="btn primary" id="btnAddCode">＋ 添加校验码</button>
      <button class="btn ghost" id="btnRefreshAdmin">刷新</button>
    </div>
    <table class="admin-table"><tr><th>用户名称</th><th>校验码</th><th>创建时间</th><th>登录过</th><th>操作</th></tr>
    ${codes.map(c => {
    const used = (adminCache.users || []).some(u => u.codeId === c.id);
    return `<tr><td>${esc(c.name)}</td><td class="code-mono">${esc(c.code)}</td><td>${fmtTime(c.createdAt)}</td><td>${used ? '✅' : '—'}</td>
        <td><button class="btn small danger" data-del="${c.id}">删除</button></td></tr>`;
  }).join('') || '<tr><td colspan="5">暂无校验码</td></tr>'}
    </table>
    <p class="hint">用户在客户端登录页输入校验码即可登录；删除后该校验码立即失效。</p>`;
  $('#btnAddCode').onclick = async () => {
    const name = $('#cuName').value.trim();
    if (!name) return toast('请填写用户名称', 'err');
    try {
      const r = await S.api.adminCreateCode(name, $('#cuCode').value.trim());
      toast('已创建校验码：' + r.code.code, 'ok', 5000);
      loadAdmin();
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#btnRefreshAdmin').onclick = loadAdmin;
  b.querySelectorAll('[data-del]').forEach(btn => btn.onclick = async () => {
    if (!confirm('删除该校验码？该用户将无法再登录。')) return;
    try { await S.api.adminDeleteCode(btn.dataset.del); toast('已删除', 'ok'); loadAdmin(); } catch (e) { toast(e.message, 'err'); }
  });
}
// ---- 项目管理 ----
function renderAdminProjects(b) {
  const ps = adminCache.projects || [];
  b.innerHTML = `
    <div class="admin-toolbar">
      <input id="npName" placeholder="新项目名称">
      <button class="btn primary" id="btnAddProj">＋ 创建项目</button>
      <button class="btn ghost" id="btnRefreshAdmin2">刷新</button>
    </div>
    <table class="admin-table"><tr><th>项目</th><th>分集数</th><th>创建时间</th><th>模型配置</th><th>操作</th></tr>
    ${ps.map(p => {
    const epCount = (adminCache.episodes || []).filter(e2 => e2.projectId === p.id).length;
    const cfgCount = ((p.models.text || []).length) + ((p.models.image || []).length) + ((p.models.video || []).length);
    return `<tr><td>${esc(p.name)}</td><td>${epCount}</td><td>${fmtTime(p.createdAt)}</td>
        <td>${cfgCount ? '已配置 ' + cfgCount + ' 个' : '<span style="color:var(--warn)">未配置</span>'}</td>
        <td>
          <button class="btn small" data-cfg="${p.id}">⚙ 模型配置</button>
          <button class="btn small danger" data-delp="${p.id}">删除</button>
        </td></tr>`;
  }).join('') || '<tr><td colspan="5">暂无项目</td></tr>'}
    </table>
    <p class="hint">用户只能进入项目、创建分集；项目与各项目的模型配置（文本/图片/视频）由管理员在此管理。视频模型分「全能参考」与「首尾帧」两种类型。</p>`;
  $('#btnAddProj').onclick = async () => {
    const name = $('#npName').value.trim();
    if (!name) return toast('请填写项目名称', 'err');
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
      <button class="btn small" data-add="${kind}" style="margin-bottom:10px">＋ 添加${title.replace(/^[📝🖼🎬]+\s*/, '')}</button>
    </div>`;
  openModal('⚙ 模型配置 · ' + p.name, `
    <p class="hint">配置仅保存在服务端，API Key 不会下发给用户；用户只能看到模型名称并进行选择。视频模型可选「全能参考」（综合所有素材生成）或「首尾帧」（必须提供首帧/尾帧图）。</p>
    ${section('text', '📝 文本模型', '负责剧本拆解、台词处理')}
    ${section('image', '🖼 图片模型', '负责资产图与分镜图生成')}
    ${section('video', '🎬 视频模型', '负责最终成片画面')}
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
  $('#modalBody').addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.k !== undefined && t.dataset.f) p.models[t.dataset.k][parseInt(t.dataset.i)][t.dataset.f] = t.value;
  });
  $('#modalBody').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.k !== undefined && t.dataset.f) p.models[t.dataset.k][parseInt(t.dataset.i)][t.dataset.f] = t.value;
  });
  $('#mcCancel').onclick = () => { closeModal(); loadAdmin(); };
  $('#mcSave').onclick = async () => {
    try {
      // 清理空名称项
      ['text', 'image', 'video'].forEach(k => { p.models[k] = p.models[k].filter(m => m.name && m.baseUrl && m.model); });
      await S.api.adminSaveModels(pid, p.models);
      toast('模型配置已保存', 'ok');
      closeModal(); loadAdmin();
    } catch (e) { toast(e.message, 'err'); }
  };
}
// ---- 服务管理 ----
async function renderAdminServer(b) {
  const st = await window.mochi.serverStatus();
  const addr = (st.ips && st.ips.length ? st.ips : ['本机IP']).map(ip => 'http://' + ip + ':' + (st.port || 3210)).join(' 或 ');
  b.innerHTML = `
    <div class="admin-section"><h3>协作服务状态</h3>
      <div class="stat-cards">
        <div class="stat-card"><div class="sc-label">本机服务</div><div class="sc-num ${st.running ? 'ok' : ''}">${st.running ? '运行中' : '未启动'}</div></div>
        <div class="stat-card"><div class="sc-label">端口</div><div class="sc-num">${st.port || 3210}</div></div>
        <div class="stat-card"><div class="sc-label">当前服务器地址</div><div class="sc-num" style="font-size:15px">${esc(S.base)}</div></div>
      </div>
      <div class="admin-toolbar">
        <input id="svPort" value="${st.port || 3210}" style="width:100px" placeholder="端口">
        <button class="btn primary" id="btnSvStart">${st.running ? '重启服务' : '启动本机服务'}</button>
        ${st.running ? '<button class="btn danger" id="btnSvStop">停止服务</button>' : ''}
      </div>
      ${st.running ? `<p class="hint">✅ 服务运行中。用户端登录页填入：<b>${esc(addr)}</b><br>数据目录：${esc(st.dataDir)}</p>` : '<p class="hint">启动后本机即成为协作服务器，其他设备通过局域网（或公网映射）地址连接。当前管理端连接的是 <b>' + esc(S.base) + '</b>。</p>'}
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

// ================================================================
// 自动更新
// ================================================================
function initUpdaterUI() {
  window.mochi.appInfo().then(info => {
    const v = 'v' + info.version + (info.isPackaged ? '' : ' (dev)');
    ['#verBadge', '#projVerBadge', '#adminVerBadge'].forEach(s => { const el = $(s); if (el) el.textContent = v; });
  });
  window.mochi.onUpdaterEvent('available', d => toast('发现新版本 v' + d.version + '，正在后台下载…', '', 4000));
  window.mochi.onUpdaterEvent('downloaded', d => {
    S.updateReady = d;
    $('#updateBarText').textContent = '新版本 v' + (d.version || '') + ' 已下载完成';
    $('#updateBar').classList.remove('hidden');
  });
  window.mochi.onUpdaterEvent('error', () => { });
  $('#btnCheckUpdate').onclick = async () => {
    if (S.updateReady) return $('#btnInstallUpdate').click();
    const fab = $('#btnCheckUpdate');
    fab.textContent = '⏳';
    const r = await window.mochi.checkUpdate();
    fab.textContent = '🔄';
    if (r.dev) return toast('开发模式不支持检查更新', '', 3000);
    if (!r.ok) return toast(r.message || '检查更新失败', 'err');
    if (!r.hasUpdate) toast('已是最新版本', 'ok');
    else toast('发现新版本 v' + r.version + '，正在下载…', '', 3500);
  };
  $('#btnInstallUpdate').onclick = async () => {
    // 更新前自动保存全部内容
    flushOps();
    await fullSaveEpisode();
    localBackup();
    toast('内容已保存，正在重启安装…', '', 2500);
    setTimeout(() => window.mochi.installUpdate(), 600);
  };
  $('#btnDismissUpdate').onclick = () => $('#updateBar').classList.add('hidden');
}

// ================================================================
// 初始化
// ================================================================
function init() {
  initLogin();
  initUpdaterUI();
  initShotEvents();
  initAssetEvents();
  initCompose();
  // 页面导航
  $('#btnLogout1').onclick = $('#btnLogout2').onclick = () => location.reload();
  $('#btnBackProj').onclick = () => loadProjects();
  $('#btnNewEpisode').onclick = newEpisode;
  $('#btnBackEps').onclick = async () => {
    flushOps(); await fullSaveEpisode();
    S.collab.leave();
    openProject(S.project.id);
  };
  // 编辑器
  $('#btnAddShot').onclick = addShot;
  $('#btnAddAsset').onclick = () => openAssetModal(S.assetTab, null);
  $('#btnCompose').onclick = composeVideo;
  // 剧本分解页
  $('#btnStartParse').onclick = parseScript;
  $('#btnSkipParse').onclick = skipParse;
  $('#btnSetupBack').onclick = async () => {
    flushOps(); await fullSaveEpisode();
    S.collab.leave();
    openProject(S.project.id);
  };
  $('#btnToSetup').onclick = () => showSetup(); // 编辑器返回分解页
  $('#btnToggleAssets').onclick = () => $('#assetDrawer').classList.toggle('hidden'); // 资产库抽屉开关
  let setupScriptTimer = null;
  $('#setupScript').addEventListener('input', e => {
    S.data.script = e.target.value;
    clearTimeout(setupScriptTimer);
    setupScriptTimer = setTimeout(() => emitOp({ kind: 'episode-meta', episodeId: S.episode.id, script: e.target.value }), 800);
  });
  // 管理端页签
  $$('.admin-tab').forEach(t => t.onclick = () => {
    $$('.admin-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active'); adminTab = t.dataset.tab; renderAdmin();
  });
  // 关闭前保存
  window.addEventListener('beforeunload', () => { flushOps(); });
  // 每30秒兜底全量保存（分解页与编辑页均保存）
  setInterval(() => { if (S.page === 'editor' || S.page === 'setup') fullSaveEpisode(); }, 30000);
}
init();
