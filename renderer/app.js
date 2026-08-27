/* 乾坤设计 渲染进程逻辑 */
'use strict';

// ================= 状态 =================
const state = {
  project: null,
  config: null,
  voices: [],
  activeTab: 'characters',
  picker: null,
  editingAsset: null,
  composing: false,
  saveTimer: null,
  updateState: null // {version} 当有已下载的更新
};

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
const TYPE_META = {
  characters: { label: '人物', ico: '🧑' },
  scenes: { label: '场景', ico: '🏞' },
  props: { label: '道具', ico: '📦' },
  others: { label: '其他', ico: '✨' },
  sfx: { label: '音效', ico: '🎵' }
};

// ================= 工具 =================
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, type = '', ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  clearTimeout(t._tm);
  t._tm = setTimeout(() => t.classList.add('hidden'), ms);
}

function defaultProject() {
  return {
    id: uid(), name: '未命名漫剧', aspect: '9:16',
    createdAt: Date.now(), updatedAt: Date.now(),
    script: '', shots: [],
    assets: { characters: [], scenes: [], props: [], others: [], sfx: [] },
    lastCompose: null
  };
}

function getAsset(type, id) {
  return (state.project.assets[type] || []).find(a => a.id === id) || null;
}
function getShot(id) {
  return state.project.shots.find(s => s.id === id) || null;
}
function countAssetUsed(type, id) {
  let n = 0;
  for (const s of state.project.shots) {
    if (type === 'characters' && s.characters.includes(id)) n++;
    if (type === 'scenes' && s.scene === id) n++;
    if (type === 'props' && s.props.includes(id)) n++;
    if (type === 'others' && s.others.includes(id)) n++;
    if (type === 'sfx' && s.sfxId === id) n++;
  }
  return n;
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    window.mochi.saveProject(state.project);
  }, 800);
}

// ================= 渲染：分镜表 =================
function renderAll() {
  renderShots();
  renderAssets();
  renderMeta();
}

function renderMeta() {
  const p = state.project;
  const totalAssets = Object.values(p.assets).reduce((s, l) => s + l.length, 0);
  $('#projMeta').textContent = `${p.shots.length} 个分镜 · ${totalAssets} 个资产`;
  $('#cntCharacters').textContent = p.assets.characters.length;
  $('#cntScenes').textContent = p.assets.scenes.length;
  $('#cntProps').textContent = p.assets.props.length;
  $('#cntOthers').textContent = p.assets.others.length;
  $('#cntSfx').textContent = p.assets.sfx.length;
  $('#btnCompose').disabled = state.composing || p.shots.length === 0;
}

function chipHTML(type, a) {
  const img = a.img ? `<img src="${esc(a.img)}">` : `<span class="chip-ico">${TYPE_META[type].ico}</span>`;
  const voice = type === 'characters' ? (a.voice && a.voice.voiceId ? ' has-voice' : '') : '';
  return `<span class="slot-chip${voice}" data-chip="${a.id}" data-type="${type}" title="${esc(a.desc || a.name)}">${img}<span class="chip-name">${esc(a.name)}</span><span class="chip-x" data-unbind="${a.id}" data-type="${type}">✕</span></span>`;
}

function renderShots() {
  const body = $('#shotsBody');
  const shots = state.project.shots;
  $('#emptyTip').style.display = shots.length ? 'none' : 'block';

  body.innerHTML = shots.map((shot, i) => {
    const chars = shot.characters.map(id => getAsset('characters', id)).filter(Boolean);
    const scene = getAsset('scenes', shot.scene);
    const props = shot.props.map(id => getAsset('props', id)).filter(Boolean);
    const others = shot.others.map(id => getAsset('others', id)).filter(Boolean);
    const sfx = getAsset('sfx', shot.sfxId);

    const charChips = chars.map(a => chipHTML('characters', a)).join('');
    const sceneChip = scene ? chipHTML('scenes', scene) : '';
    const propChips = props.map(a => chipHTML('props', a)).join('');
    const otherChips = others.map(a => chipHTML('others', a)).join('');

    // 辅助列
    let voiceHTML;
    if (shot.voicePath) {
      voiceHTML = `<div class="aux-item">🎙<span class="aux-status ok">配音 ${shot.voiceDuration || '?'}s</span><span class="aux-play" data-action="play-voice" data-shot="${shot.id}" title="播放">▶</span><span class="aux-x" data-action="clear-voice" data-shot="${shot.id}" title="删除配音">✕</span></div>`;
    } else {
      voiceHTML = `<button class="op-icon voice-gen" data-action="gen-voice" data-shot="${shot.id}">🎙 生成配音</button>`;
    }
    let sfxHTML;
    if (sfx) {
      sfxHTML = `<div class="aux-item">🎵<span>${esc(sfx.name)}</span><span class="aux-play" data-action="play-sfx" data-sfx="${sfx.id}" title="播放">▶</span><span class="aux-x" data-action="unbind-sfx" data-shot="${shot.id}" title="解除绑定">✕</span></div>`;
    } else {
      sfxHTML = `<button class="aux-add" data-action="pick" data-type="sfx" data-shot="${shot.id}">＋ 绑定音效</button>`;
    }

    // 分镜图（含悬停操作按钮）
    const storyHTML = shot.storyboardImg
      ? `<img src="${esc(shot.storyboardImg)}" data-action="preview-story" data-shot="${shot.id}">`
      : `<span>点击上传<br>或AI生成分镜图</span>`;
    const storyBtns = `<div class="story-mini">
        <button data-action="upload-story" data-shot="${shot.id}" title="上传本地图片">⬆</button>
        <button data-action="ai-story" data-shot="${shot.id}" title="AI生成分镜图（综合人物/场景/道具/剧本）">✨</button>
      </div>`;

    // 视频槽
    const videoHTML = shot.videoUrl
      ? `<span class="video-slot done" data-action="preview-video" data-shot="${shot.id}" title="播放该分镜视频">▶</span>`
      : `<span class="video-slot" title="生成视频后可用">—</span>`;

    return `<tr data-shot="${shot.id}">
      <td class="col-idx"><span class="shot-idx">${i + 1}</span></td>
      <td class="col-script">
        <textarea class="shot-script" data-shot="${shot.id}" placeholder="分镜剧本…">${esc(shot.text)}</textarea>
        <div class="shot-dialogue" contenteditable="true" data-dialogue="${shot.id}" title="台词（用于配音，可编辑）">${esc(shot.dialogue || '（点击填写台词）')}</div>
      </td>
      <td class="col-char"><div class="slot-wrap" data-slot="characters" data-shot="${shot.id}">${charChips}<button class="slot-add" data-action="pick" data-type="characters" data-shot="${shot.id}" title="添加人物">＋</button></div></td>
      <td class="col-scene"><div class="slot-wrap" data-slot="scenes" data-shot="${shot.id}">${sceneChip}<button class="slot-add" data-action="pick" data-type="scenes" data-shot="${shot.id}" title="设置场景">＋</button></div></td>
      <td class="col-prop"><div class="slot-wrap" data-slot="props" data-shot="${shot.id}">${propChips}<button class="slot-add" data-action="pick" data-type="props" data-shot="${shot.id}" title="添加道具">＋</button></div></td>
      <td class="col-other"><div class="slot-wrap" data-slot="others" data-shot="${shot.id}">${otherChips}<button class="slot-add" data-action="pick" data-type="others" data-shot="${shot.id}" title="添加其他">＋</button></div></td>
      <td class="col-aux"><div class="aux-box">${voiceHTML}${sfxHTML}</div></td>
      <td class="col-story"><div class="story-slot" data-action="story-click" data-shot="${shot.id}">${storyHTML}${storyBtns}</div></td>
      <td class="col-video">${videoHTML}</td>
      <td class="col-op"><div class="op-btns">
        <button class="op-icon" data-action="up" data-shot="${shot.id}">↑ 上移</button>
        <button class="op-icon" data-action="down" data-shot="${shot.id}">↓ 下移</button>
        <button class="op-icon" data-action="del" data-shot="${shot.id}" style="color:#ff5c7a">✕ 删除</button>
      </div></td>
    </tr>`;
  }).join('');
}

// ================= 渲染：资产面板 =================
function renderAssets() {
  const grid = $('#assetGrid');
  const list = state.project.assets[state.activeTab] || [];
  if (!list.length) {
    grid.innerHTML = `<div class="picker-empty" style="grid-column:1/-1">暂无${TYPE_META[state.activeTab].label}资产<br><br>AI拆解剧本会自动创建，<br>或点击右上角「＋ 新建」</div>`;
    return;
  }
  grid.innerHTML = list.map(a => {
    const used = countAssetUsed(state.activeTab, a.id);
    const img = a.img
      ? `<img src="${esc(a.img)}">`
      : (a.audio ? `🎵` : TYPE_META[state.activeTab].ico);
    let voiceLine = '';
    if (state.activeTab === 'characters') {
      const v = a.voice && a.voice.voiceId ? (state.voices.find(x => x.id === a.voice.voiceId) || {}).name || a.voice.voiceId : null;
      voiceLine = `<div class="ac-voice ${v ? '' : 'none'}">${v ? '🎙 ' + esc(v) : '未绑定配音'}</div>`;
    }
    if (state.activeTab === 'sfx') {
      voiceLine = `<div class="ac-voice ${a.audio ? '' : 'none'}">${a.audio ? '已上传音频' : '未上传音频'}</div>`;
    }
    return `<div class="asset-card" draggable="true" data-asset="${a.id}" data-type="${state.activeTab}" title="拖拽到分镜槽位绑定，点击编辑">
      <div class="ac-img">${img}</div>
      ${used ? `<span class="ac-used">出镜${used}次</span>` : ''}
      <div class="ac-name">${esc(a.name)}</div>
      <div class="ac-desc">${esc(a.desc || '暂无描述')}</div>
      ${voiceLine}
    </div>`;
  }).join('');
}

// ================= AI 剧本拆解（文本模型） =================
function findOrCreateAsset(type, name) {
  name = (name || '').trim();
  if (!name) return null;
  const list = state.project.assets[type];
  let a = list.find(x => x.name === name);
  if (!a) {
    a = { id: uid(), name, desc: '', img: null };
    if (type === 'characters') a.voice = null;
    if (type === 'sfx') a.audio = null;
    list.push(a);
  }
  return a;
}

function autoMatchShot(shot) {
  const meta = shot.aiMeta;
  if (!meta) return;
  const uniq = (arr) => [...new Set(arr)];
  shot.characters = uniq((meta.characters || []).map(n => { const a = findOrCreateAsset('characters', n); return a && a.id; }).filter(Boolean));
  shot.scene = (findOrCreateAsset('scenes', meta.scene) || {}).id || null;
  shot.props = uniq((meta.props || []).map(n => { const a = findOrCreateAsset('props', n); return a && a.id; }).filter(Boolean));
  shot.others = uniq((meta.others || []).map(n => { const a = findOrCreateAsset('others', n); return a && a.id; }).filter(Boolean));
}

async function doParseScript() {
  const script = $('#scriptInput').value.trim();
  if (!script) { toast('请先粘贴剧本文本', 'err'); return; }
  if (!state.config.text.baseUrl || !state.config.text.model) {
    toast('请先在「模型配置」中配置文本模型', 'err');
    openModal('modalScript'); closeModal('modalScript');
    openModelModal();
    return;
  }
  const btn = $('#btnDoParse');
  btn.disabled = true; btn.textContent = 'AI拆解中…';
  try {
    const result = await window.mochi.aiParseScript(script, {
      characters: state.project.assets.characters.map(a => ({ name: a.name })),
      scenes: state.project.assets.scenes.map(a => ({ name: a.name })),
      props: state.project.assets.props.map(a => ({ name: a.name }))
    });
    const aiShots = (result.shots || []).map(s => ({
      id: uid(),
      text: s.text || '',
      dialogue: s.dialogue || '',
      characters: [], scene: null, props: [], others: [],
      sfxId: null, voicePath: null, voiceDuration: 0,
      storyboardImg: null, videoUrl: null, duration: 3,
      aiMeta: { characters: s.characters || [], scene: s.scene || '', props: s.props || [], others: s.others || [] }
    }));
    if (!aiShots.length) { toast('AI未拆解出分镜，请检查剧本内容', 'err'); return; }
    aiShots.forEach(autoMatchShot);
    state.project.script = script;
    if ($('#chkReplace').checked) state.project.shots = aiShots;
    else state.project.shots = state.project.shots.concat(aiShots);
    scheduleSave();
    renderAll();
    closeModal('modalScript');
    toast(`拆解完成：${aiShots.length} 个分镜，已自动识别人物/场景/道具并匹配资产`, 'ok', 4000);
  } catch (e) {
    toast('拆解失败：' + e.message, 'err', 5000);
  } finally {
    btn.disabled = false; btn.textContent = '开始拆解';
  }
}

// ================= 配音 =================
function shotVoiceConfig(shot) {
  for (const id of shot.characters) {
    const a = getAsset('characters', id);
    if (a && a.voice && a.voice.voiceId) {
      return { voiceId: a.voice.voiceId, rate: a.voice.rate || 0, pitch: a.voice.pitch || 0, from: a.name };
    }
  }
  return { voiceId: DEFAULT_VOICE, rate: 0, pitch: 0, from: '旁白' };
}

function shotVoiceText(shot) {
  const d = (shot.dialogue || '').trim();
  if (d && d !== '（点击填写台词）') return d;
  return (shot.text || '').trim();
}

async function generateVoice(shot) {
  const text = shotVoiceText(shot);
  if (!text) { toast('该分镜没有可配音的文本', 'err'); return; }
  try {
    const vc = shotVoiceConfig(shot);
    const r = await window.mochi.ttsGenerate(text, vc.voiceId, vc.rate, vc.pitch);
    shot.voicePath = r.url;
    shot.voiceDuration = r.duration;
    scheduleSave();
    renderShots();
  } catch (e) {
    toast('配音失败：' + e.message, 'err', 4000);
  }
}

async function batchVoice() {
  const shots = state.project.shots;
  if (!shots.length) { toast('没有分镜', 'err'); return; }
  const btn = $('#btnBatchVoice');
  btn.disabled = true;
  try {
    for (let i = 0; i < shots.length; i++) {
      btn.textContent = `🎙 配音中 ${i + 1}/${shots.length}`;
      const text = shotVoiceText(shots[i]);
      if (!text) continue;
      try {
        const vc = shotVoiceConfig(shots[i]);
        const r = await window.mochi.ttsGenerate(text, vc.voiceId, vc.rate, vc.pitch);
        shots[i].voicePath = r.url;
        shots[i].voiceDuration = r.duration;
      } catch (e) { console.error(e); }
      renderShots();
    }
    scheduleSave();
    toast('批量配音完成', 'ok');
  } finally {
    btn.disabled = false; btn.textContent = '🎙 批量生成配音';
  }
}

// ================= AI 生图（图片模型） =================
function buildShotPrompt(shot) {
  const parts = [];
  const chars = shot.characters.map(id => getAsset('characters', id)).filter(Boolean);
  const scene = getAsset('scenes', shot.scene);
  const props = shot.props.map(id => getAsset('props', id)).filter(Boolean);
  const others = shot.others.map(id => getAsset('others', id)).filter(Boolean);
  if (chars.length) parts.push('登场人物：' + chars.map(c => c.name + (c.desc ? '（' + c.desc + '）' : '')).join('、'));
  if (scene) parts.push('场景：' + scene.name + (scene.desc ? '（' + scene.desc + '）' : ''));
  if (props.length) parts.push('道具：' + props.map(p => p.name).join('、'));
  if (others.length) parts.push('氛围元素：' + others.map(o => o.name).join('、'));
  parts.push('画面情节：' + (shot.text || ''));
  return `高质量漫剧风格插画，${state.project.aspect === '16:9' ? '横屏' : '竖屏'}构图，色彩鲜明，电影感光影。` + parts.join('；');
}

function ensureImageModel() {
  if (!state.config.image.baseUrl || !state.config.image.model) {
    toast('请先在「模型配置」中配置图片模型', 'err', 3500);
    return false;
  }
  return true;
}

async function aiGenerateStoryboard(shot) {
  if (!ensureImageModel()) return;
  toast('正在AI生成分镜图（综合人物/场景/道具/剧本）…', '', 8000);
  try {
    const url = await window.mochi.aiGenImage(buildShotPrompt(shot), state.project.aspect);
    shot.storyboardImg = url;
    scheduleSave();
    renderShots();
    toast('分镜图生成完成', 'ok');
  } catch (e) {
    toast('AI生图失败：' + e.message, 'err', 5000);
  }
}

async function aiGenAssetImg() {
  if (!ensureImageModel()) return;
  const name = $('#assetName').value.trim();
  const desc = $('#assetDesc').value.trim();
  if (!name) { toast('请先填写资产名称', 'err'); return; }
  const type = $('#assetType').value;
  const btn = $('#btnAiGenAssetImg');
  btn.disabled = true; btn.textContent = '生成中…';
  try {
    const prompt = `${TYPE_META[type].label}设定图：${name}${desc ? '，' + desc : ''}。高质量漫剧风格，细节丰富，主体居中，干净背景，${type === 'characters' ? '全身立绘' : type === 'scenes' ? '场景全景' : '物品特写'}`;
    const url = await window.mochi.aiGenImage(prompt, '9:16');
    $('#assetImgPreview').src = url;
    $('#assetImgPreview').classList.remove('hidden');
    $('#assetImgPlaceholder').textContent = '点击更换图片';
    toast('资产图生成完成（保存资产后生效）', 'ok');
  } catch (e) {
    toast('AI生图失败：' + e.message, 'err', 5000);
  } finally {
    btn.disabled = false; btn.textContent = '✨ AI生成';
  }
}

// ================= 文件上传 =================
async function pickAndSaveImage() {
  const p = await window.mochi.pickFile([{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]);
  if (!p) return null;
  const b64 = await window.mochi.readAsBase64(p);
  return await window.mochi.saveAsset(p.split(/[\\/]/).pop(), b64);
}
async function pickAndSaveAudio() {
  const p = await window.mochi.pickFile([{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac'] }]);
  if (!p) return null;
  const b64 = await window.mochi.readAsBase64(p);
  return await window.mochi.saveAsset(p.split(/[\\/]/).pop(), b64);
}

// ================= 槽位选择器 =================
function openPicker(type, shotId, x, y) {
  state.picker = { type, shotId };
  const pop = $('#pickerPop');
  const shot = getShot(shotId);
  const bound = type === 'characters' ? shot.characters
    : type === 'scenes' ? (shot.scene ? [shot.scene] : [])
      : type === 'props' ? shot.props
        : type === 'others' ? shot.others
          : (shot.sfxId ? [shot.sfxId] : []);
  $('#pickerTitle').textContent = '选择' + TYPE_META[type].label;
  const list = state.project.assets[type];
  $('#pickerList').innerHTML = (list.length ? list.map(a => `
    <div class="picker-item" data-pick-asset="${a.id}">
      ${a.img ? `<img src="${esc(a.img)}">` : `<span class="p-ico">${a.audio ? '🎵' : TYPE_META[type].ico}</span>`}
      <div><div>${esc(a.name)}</div><div class="p-sub">${esc(a.desc || '')}</div></div>
      ${bound.includes(a.id) ? '<span class="p-check">✓</span>' : ''}
    </div>`).join('') : `<div class="picker-empty">暂无${TYPE_META[type].label}资产</div>`)
    + `<div class="picker-create" data-picker-create="1">＋ 新建${TYPE_META[type].label}</div>`;

  pop.classList.remove('hidden');
  const pw = 280, ph = Math.min(340, pop.offsetHeight || 300);
  let px = Math.min(Math.max(8, x), window.innerWidth - pw - 8);
  let py = y;
  if (py + ph > window.innerHeight - 8) py = Math.max(8, window.innerHeight - ph - 8);
  pop.style.left = px + 'px';
  pop.style.top = py + 'px';
}
function closePicker() {
  state.picker = null;
  $('#pickerPop').classList.add('hidden');
}

function bindAsset(type, id, shotId) {
  const shot = getShot(shotId);
  if (!shot) return;
  if (type === 'characters') { if (!shot.characters.includes(id)) shot.characters.push(id); }
  else if (type === 'scenes') { shot.scene = id; }
  else if (type === 'props') { if (!shot.props.includes(id)) shot.props.push(id); }
  else if (type === 'others') { if (!shot.others.includes(id)) shot.others.push(id); }
  else if (type === 'sfx') { shot.sfxId = id; }
  scheduleSave();
  renderShots();
  renderAssets();
  renderMeta();
}
function unbindAsset(type, id, shotId) {
  const shot = getShot(shotId);
  if (!shot) return;
  if (type === 'characters') shot.characters = shot.characters.filter(x => x !== id);
  else if (type === 'scenes') { if (shot.scene === id) shot.scene = null; }
  else if (type === 'props') shot.props = shot.props.filter(x => x !== id);
  else if (type === 'others') shot.others = shot.others.filter(x => x !== id);
  else if (type === 'sfx') { if (shot.sfxId === id) shot.sfxId = null; }
  scheduleSave();
  renderShots();
  renderAssets();
}

// ================= 资产编辑弹窗 =================
function openAssetModal(type, asset) {
  state.editingAsset = { type, asset: asset || null };
  $('#assetModalTitle').textContent = (asset ? '编辑' : '新建') + TYPE_META[type].label;
  $('#assetType').value = type;
  $('#assetType').disabled = !!asset;
  $('#assetName').value = asset ? asset.name : '';
  $('#assetDesc').value = asset ? (asset.desc || '') : '';
  $('#assetImgPreview').src = asset && asset.img ? asset.img : '';
  $('#assetImgPreview').classList.toggle('hidden', !(asset && asset.img));
  $('#assetImgPlaceholder').textContent = asset && asset.img ? '点击更换图片' : '点击上传图片';
  $('#rowAssetAudio').classList.toggle('hidden', type !== 'sfx');
  $('#assetAudioPreview').src = asset && asset.audio ? asset.audio : '';
  $('#assetAudioPreview').classList.toggle('hidden', !(asset && asset.audio));
  $('#assetAudioPlaceholder').textContent = asset && asset.audio ? '点击更换音频' : '点击上传音频(mp3/wav)';
  const isChar = (type === 'characters');
  $('#voiceBindSection').classList.toggle('hidden', !isChar);
  if (isChar) {
    const v = (asset && asset.voice) || { voiceId: DEFAULT_VOICE, rate: 0, pitch: 0 };
    $('#voiceSelect').value = v.voiceId || DEFAULT_VOICE;
    $('#voiceRate').value = v.rate || 0;
    $('#voicePitch').value = v.pitch || 0;
    $('#rateVal').textContent = (v.rate || 0) + '%';
    $('#pitchVal').textContent = v.pitch || 0;
  }
  $('#btnDeleteAsset').style.visibility = asset ? 'visible' : 'hidden';
  openModal('modalAsset');
}

async function saveAssetModal() {
  const { type, asset } = state.editingAsset || {};
  if (!type) return;
  const name = $('#assetName').value.trim();
  if (!name) { toast('请填写资产名称', 'err'); return; }
  const img = $('#assetImgPreview').src || null;
  const audio = $('#assetAudioPreview').src || null;
  let target = asset;
  if (!target) {
    target = { id: uid(), name, desc: '', img: null };
    if (type === 'characters') target.voice = null;
    if (type === 'sfx') target.audio = null;
    state.project.assets[type].push(target);
  }
  target.name = name;
  target.desc = $('#assetDesc').value.trim();
  if (img && String(img).startsWith('mochi-file:')) target.img = img;
  if (type === 'sfx' && audio && String(audio).startsWith('mochi-file:')) target.audio = audio;
  if (type === 'characters') {
    target.voice = { voiceId: $('#voiceSelect').value, rate: parseInt($('#voiceRate').value) || 0, pitch: parseInt($('#voicePitch').value) || 0 };
  }
  scheduleSave();
  renderAll();
  closeModal('modalAsset');
  toast(TYPE_META[type].label + '已保存', 'ok');
}

// ================= 模型配置 =================
function openModelModal() {
  const c = state.config;
  $('#txtBaseUrl').value = c.text.baseUrl || '';
  $('#txtApiKey').value = c.text.apiKey || '';
  $('#txtModel').value = c.text.model || '';
  $('#imgBaseUrl').value = c.image.baseUrl || '';
  $('#imgApiKey').value = c.image.apiKey || '';
  $('#imgModel').value = c.image.model || '';
  $('#vidBaseUrl').value = c.video.baseUrl || '';
  $('#vidApiKey').value = c.video.apiKey || '';
  $('#vidModel').value = c.video.model || '';
  $('#apiTestResult').textContent = '';
  openModal('modalModel');
}

async function saveModelModal() {
  const c = state.config;
  c.text = { baseUrl: $('#txtBaseUrl').value.trim(), apiKey: $('#txtApiKey').value.trim(), model: $('#txtModel').value.trim() };
  c.image = { baseUrl: $('#imgBaseUrl').value.trim(), apiKey: $('#imgApiKey').value.trim(), model: $('#imgModel').value.trim() };
  c.video = { baseUrl: $('#vidBaseUrl').value.trim(), apiKey: $('#vidApiKey').value.trim(), model: $('#vidModel').value.trim() };
  await window.mochi.saveConfig(c);
  closeModal('modalModel');
  toast('模型配置已保存', 'ok');
}

async function testTextModel() {
  const r = $('#apiTestResult');
  r.className = 'test-result'; r.textContent = '测试中…';
  const tmp = {
    baseUrl: $('#txtBaseUrl').value.trim(),
    apiKey: $('#txtApiKey').value.trim(),
    model: $('#txtModel').value.trim()
  };
  if (!tmp.baseUrl || !tmp.model) {
    r.className = 'test-result err'; r.textContent = '✗ 请先填写文本模型的地址和模型名';
    return;
  }
  // 临时保存再测试（aiCall 使用已保存配置）
  const old = JSON.parse(JSON.stringify(state.config));
  state.config.text = tmp;
  await window.mochi.saveConfig(state.config);
  try {
    const out = await window.mochi.aiCall([{ role: 'user', content: '回复"ok"两个字母即可' }], false);
    r.className = 'test-result ok'; r.textContent = '✓ 连接成功：' + String(out).slice(0, 40);
  } catch (e) {
    r.className = 'test-result err'; r.textContent = '✗ ' + e.message.slice(0, 120);
    state.config = old;
    await window.mochi.saveConfig(old);
  }
}

// ================= 视频合成 =================
function composeReferenceSummary() {
  const p = state.project;
  const cfg = state.config;
  const charIds = new Set(), sceneIds = new Set(), propIds = new Set(), otherIds = new Set();
  let voiceCount = 0, sfxCount = 0, imgCount = 0;
  p.shots.forEach(s => {
    s.characters.forEach(id => charIds.add(id));
    if (s.scene) sceneIds.add(s.scene);
    s.props.forEach(id => propIds.add(id));
    s.others.forEach(id => otherIds.add(id));
    if (s.voicePath) voiceCount++;
    if (s.sfxId) sfxCount++;
    if (s.storyboardImg) imgCount++;
  });
  const useVideoApi = !!(cfg.video.baseUrl && cfg.video.model);
  return `共同参考：剧本 ${p.shots.length} 段 · 人物 ${charIds.size} · 场景 ${sceneIds.size} · 道具 ${propIds.size} · 其他 ${otherIds.size} · 配音 ${voiceCount} · 音效 ${sfxCount} · 分镜图 ${imgCount}
生成方式：${useVideoApi ? '视频模型「' + cfg.video.model + '」逐镜生成画面 + 配音混音' : '本地方案（分镜图+配音+字幕，未配置视频模型）'}`;
}

async function doCompose() {
  if (state.composing) return;
  const p = state.project;
  if (!p.shots.length) { toast('没有分镜', 'err'); return; }
  state.composing = true;
  renderMeta();
  $('#composeBar').style.width = '0%';
  $('#composeBar').querySelector('span').textContent = '0%';
  $('#composeMsg').textContent = '准备中…';
  $('#composeRef').textContent = composeReferenceSummary();
  openModal('modalCompose');
  try {
    const result = await window.mochi.composeVideo(p);
    (result.segments || []).forEach(seg => {
      const shot = getShot(seg.shotId);
      if (shot) shot.videoUrl = seg.url;
    });
    p.lastCompose = { path: result.path, name: result.name, duration: result.duration, at: Date.now() };
    scheduleSave();
    renderShots();
    closeModal('modalCompose');
    openPreview('成片预览', `
      <video class="preview-video" src="mochi-file://exports/${encodeURIComponent(result.name)}" controls autoplay></video>
      <p class="hint center" style="margin-top:12px">时长 ${result.duration}s · 已保存到本机</p>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:8px">
        <button class="btn primary" id="btnOpenFolder">📂 打开文件夹</button>
      </div>`);
    $('#btnOpenFolder').addEventListener('click', () => window.mochi.showInFolder(result.path));
    toast('视频生成完成！', 'ok', 4000);
  } catch (e) {
    closeModal('modalCompose');
    toast('视频生成失败：' + e.message, 'err', 6000);
  } finally {
    state.composing = false;
    renderMeta();
  }
}

// ================= 自动更新 =================
function initUpdaterUI() {
  window.mochi.appInfo().then(info => {
    $('#verBadge').textContent = 'v' + info.version + (info.isPackaged ? '' : ' (dev)');
  });

  window.mochi.onUpdaterEvent('available', (d) => {
    toast('发现新版本 v' + d.version + '，正在后台下载…', '', 4000);
  });
  window.mochi.onUpdaterEvent('not-available', () => {
    toast('已是最新版本', 'ok');
  });
  window.mochi.onUpdaterEvent('progress', (d) => {
    $('#updateBtnText').textContent = '下载中 ' + d.percent + '%';
  });
  window.mochi.onUpdaterEvent('downloaded', (d) => {
    state.updateState = d;
    $('#updateBarText').textContent = `新版本 v${d.version} 已下载完成`;
    $('#updateBar').classList.remove('hidden');
    $('#updateBtnText').textContent = '重启安装';
  });
  window.mochi.onUpdaterEvent('error', (d) => {
    $('#updateBtnText').textContent = '检查更新';
  });

  $('#btnCheckUpdate').addEventListener('click', async () => {
    if (state.updateState) {
      window.mochi.installUpdate();
      return;
    }
    $('#updateBtnText').textContent = '检查中…';
    const r = await window.mochi.checkUpdate();
    if (!r.ok) {
      $('#updateBtnText').textContent = '检查更新';
      toast(r.message || '检查更新失败（仅安装版支持自动更新）', 'err', 3500);
    }
  });
  $('#btnInstallUpdate').addEventListener('click', () => window.mochi.installUpdate());
  $('#btnDismissUpdate').addEventListener('click', () => $('#updateBar').classList.add('hidden'));
}

// ================= 弹窗控制 =================
function openModal(id) { $('#' + id).classList.remove('hidden'); }
function closeModal(id) { $('#' + id).classList.add('hidden'); }
$$('.modal-mask').forEach(m => {
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-close]')) m.classList.add('hidden');
  });
});

function openPreview(title, html) {
  $('#previewTitle').textContent = title;
  $('#previewBody').innerHTML = html;
  openModal('modalPreview');
}

// ================= 事件绑定 =================
function bindEvents() {
  $('#projectName').addEventListener('input', (e) => { state.project.name = e.target.value; scheduleSave(); });
  $$('#aspectSwitch button').forEach(b => b.addEventListener('click', () => {
    $$('#aspectSwitch button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.project.aspect = b.dataset.v;
    scheduleSave();
  }));

  // 工具栏
  $('#btnParseScript').addEventListener('click', () => {
    $('#scriptInput').value = state.project.script || '';
    openModal('modalScript');
  });
  $('#btnDoParse').addEventListener('click', doParseScript);
  $('#btnAddShot').addEventListener('click', () => {
    state.project.shots.push({
      id: uid(), text: '', dialogue: '', characters: [], scene: null, props: [], others: [],
      sfxId: null, voicePath: null, voiceDuration: 0, storyboardImg: null, videoUrl: null, duration: 3
    });
    scheduleSave(); renderAll();
    $('#shotsTableWrap').scrollTop = 1e9;
  });
  $('#btnAutoMatch').addEventListener('click', () => {
    let n = 0;
    state.project.shots.forEach(s => { if (s.aiMeta) { autoMatchShot(s); n++; } });
    scheduleSave(); renderAll();
    toast(n ? `已对 ${n} 个AI拆解的分镜重新匹配资产` : '没有带AI识别信息的分镜（仅AI拆解的剧本可自动匹配）', n ? 'ok' : 'err');
  });
  $('#btnBatchVoice').addEventListener('click', batchVoice);
  $('#btnSaveProject').addEventListener('click', async () => {
    await window.mochi.saveProject(state.project);
    toast('项目已保存到本地', 'ok');
  });

  // 模型配置
  $('#btnModelCfg').addEventListener('click', openModelModal);
  $('#btnTestApi').addEventListener('click', testTextModel);
  $('#btnSaveCfg').addEventListener('click', saveModelModal);

  // 生成视频
  $('#btnCompose').addEventListener('click', doCompose);
  window.mochi.onVideoProgress((d) => {
    $('#composeBar').style.width = d.pct + '%';
    $('#composeBar').querySelector('span').textContent = d.pct + '%';
    $('#composeMsg').textContent = d.msg;
  });

  // 分镜表格事件委托
  $('#shotsBody').addEventListener('click', (e) => {
    // 解绑 chip 优先
    const un = e.target.closest('[data-unbind]');
    if (un) {
      e.stopPropagation();
      unbindAsset(un.dataset.type, un.dataset.unbind, un.closest('tr').dataset.shot);
      return;
    }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const shotId = el.dataset.shot;
    const shot = shotId ? getShot(shotId) : null;
    switch (action) {
      case 'pick': {
        e.stopPropagation();
        const rect = el.getBoundingClientRect();
        openPicker(el.dataset.type, shotId, rect.left, rect.bottom + 4);
        break;
      }
      case 'gen-voice': if (shot) generateVoice(shot); break;
      case 'play-voice': {
        e.stopPropagation();
        if (shot) new Audio(shot.voicePath).play();
        break;
      }
      case 'clear-voice': if (shot) { shot.voicePath = null; shot.voiceDuration = 0; scheduleSave(); renderShots(); } break;
      case 'play-sfx': {
        const a = getAsset('sfx', el.dataset.sfx);
        if (a && a.audio) new Audio(a.audio).play();
        break;
      }
      case 'unbind-sfx': if (shot) { shot.sfxId = null; scheduleSave(); renderShots(); renderAssets(); } break;
      case 'story-click': {
        if (!shot) break;
        if (shot.storyboardImg) openPreview('分镜图', `<img src="${esc(shot.storyboardImg)}" style="max-width:100%;max-height:62vh;border-radius:10px">`);
        else pickAndSaveImage().then(url => { if (url) { shot.storyboardImg = url; scheduleSave(); renderShots(); } });
        break;
      }
      case 'upload-story': {
        e.stopPropagation();
        if (shot) pickAndSaveImage().then(url => { if (url) { shot.storyboardImg = url; scheduleSave(); renderShots(); } });
        break;
      }
      case 'ai-story': { e.stopPropagation(); if (shot) aiGenerateStoryboard(shot); break; }
      case 'preview-video': {
        if (shot && shot.videoUrl) openPreview('分镜 ' + (state.project.shots.indexOf(shot) + 1) + ' 视频', `<video class="preview-video" src="${esc(shot.videoUrl)}" controls autoplay></video>`);
        break;
      }
      case 'up': {
        if (!shot) break;
        const i = state.project.shots.indexOf(shot);
        if (i > 0) { state.project.shots.splice(i - 1, 0, state.project.shots.splice(i, 1)[0]); scheduleSave(); renderShots(); }
        break;
      }
      case 'down': {
        if (!shot) break;
        const i = state.project.shots.indexOf(shot);
        if (i < state.project.shots.length - 1) { state.project.shots.splice(i + 1, 0, state.project.shots.splice(i, 1)[0]); scheduleSave(); renderShots(); }
        break;
      }
      case 'del': {
        if (!shot) break;
        if (confirm('确定删除该分镜？')) {
          state.project.shots = state.project.shots.filter(s => s.id !== shotId);
          scheduleSave(); renderAll();
        }
        break;
      }
    }
  });

  // 剧本文本 / 台词编辑
  $('#shotsBody').addEventListener('input', (e) => {
    const ta = e.target.closest('.shot-script');
    if (ta) {
      const shot = getShot(ta.dataset.shot);
      if (shot) { shot.text = ta.value; scheduleSave(); }
    }
    const dlg = e.target.closest('[data-dialogue]');
    if (dlg) {
      const shot = getShot(dlg.dataset.dialogue);
      if (shot) { shot.dialogue = dlg.textContent.trim(); scheduleSave(); }
    }
  });

  // 资产面板
  $$('#assetTabs button').forEach(b => b.addEventListener('click', () => {
    $$('#assetTabs button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.activeTab = b.dataset.tab;
    renderAssets();
  }));
  $('#btnNewAsset').addEventListener('click', () => openAssetModal(state.activeTab, null));
  $('#assetGrid').addEventListener('click', (e) => {
    const card = e.target.closest('.asset-card');
    if (!card) return;
    const asset = getAsset(card.dataset.type, card.dataset.asset);
    if (asset) openAssetModal(card.dataset.type, asset);
  });

  // 资产编辑弹窗
  $('#assetImgUploader').addEventListener('click', async (e) => {
    if (e.target.closest('#btnAiGenAssetImg')) return;
    const url = await pickAndSaveImage();
    if (url) {
      $('#assetImgPreview').src = url;
      $('#assetImgPreview').classList.remove('hidden');
      $('#assetImgPlaceholder').textContent = '点击更换图片';
    }
  });
  $('#btnAiGenAssetImg').addEventListener('click', (e) => { e.stopPropagation(); aiGenAssetImg(); });
  $('#assetAudioUploader').addEventListener('click', async () => {
    const url = await pickAndSaveAudio();
    if (url) {
      $('#assetAudioPreview').src = url;
      $('#assetAudioPreview').classList.remove('hidden');
      $('#assetAudioPlaceholder').textContent = '点击更换音频';
    }
  });
  $('#btnSaveAsset').addEventListener('click', saveAssetModal);
  $('#btnDeleteAsset').addEventListener('click', () => {
    const { type, asset } = state.editingAsset || {};
    if (!asset) return;
    if (!confirm(`确定删除「${asset.name}」？已绑定的分镜槽位将一并解除。`)) return;
    state.project.assets[type] = state.project.assets[type].filter(a => a.id !== asset.id);
    state.project.shots.forEach(s => {
      if (type === 'characters') s.characters = s.characters.filter(x => x !== asset.id);
      if (type === 'scenes' && s.scene === asset.id) s.scene = null;
      if (type === 'props') s.props = s.props.filter(x => x !== asset.id);
      if (type === 'others') s.others = s.others.filter(x => x !== asset.id);
      if (type === 'sfx' && s.sfxId === asset.id) s.sfxId = null;
    });
    scheduleSave(); renderAll(); closeModal('modalAsset');
    toast('资产已删除', 'ok');
  });
  $('#voiceRate').addEventListener('input', (e) => $('#rateVal').textContent = e.target.value + '%');
  $('#voicePitch').addEventListener('input', (e) => $('#pitchVal').textContent = e.target.value);
  $('#btnTryVoice').addEventListener('click', async () => {
    const text = $('#tryText').value.trim() || '你好';
    const btn = $('#btnTryVoice');
    btn.disabled = true; btn.textContent = '生成中…';
    try {
      const r = await window.mochi.ttsGenerate(text, $('#voiceSelect').value, parseInt($('#voiceRate').value) || 0, parseInt($('#voicePitch').value) || 0);
      new Audio(r.url).play();
    } catch (e) {
      toast('试听失败：' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = '试听';
    }
  });

  // 选择器浮层
  $('#pickerClose').addEventListener('click', closePicker);
  $('#pickerPop').addEventListener('click', (e) => {
    e.stopPropagation();
    const item = e.target.closest('[data-pick-asset]');
    if (item && state.picker) {
      bindAsset(state.picker.type, item.dataset.pickAsset, state.picker.shotId);
      if (state.picker.type === 'scenes' || state.picker.type === 'sfx') closePicker();
      else openPicker(state.picker.type, state.picker.shotId, parseInt($('#pickerPop').style.left), parseInt($('#pickerPop').style.top));
      return;
    }
    if (e.target.closest('[data-picker-create]') && state.picker) {
      const t = state.picker.type, sid = state.picker.shotId;
      closePicker();
      openAssetModal(t, null);
      // 新建保存后自动绑定最新资产
      const checkNew = setInterval(() => {
        if ($('#modalAsset').classList.contains('hidden')) {
          clearInterval(checkNew);
          const latest = state.project.assets[t][state.project.assets[t].length - 1];
          if (latest && !state._pickedNew) {
            state._pickedNew = true;
            bindAsset(t, latest.id, sid);
            setTimeout(() => state._pickedNew = false, 500);
          }
        }
      }, 300);
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#pickerPop') && !e.target.closest('[data-action="pick"]')) closePicker();
  });

  // 拖拽绑定
  $('#assetGrid').addEventListener('dragstart', (e) => {
    const card = e.target.closest('.asset-card');
    if (!card) return;
    e.dataTransfer.setData('application/x-asset', JSON.stringify({ type: card.dataset.type, id: card.dataset.asset }));
    e.dataTransfer.effectAllowed = 'copy';
  });
  $('#shotsBody').addEventListener('dragover', (e) => {
    const slot = e.target.closest('.slot-wrap');
    if (slot) { e.preventDefault(); slot.classList.add('drag-over'); }
  });
  $('#shotsBody').addEventListener('dragleave', (e) => {
    const slot = e.target.closest('.slot-wrap');
    if (slot) slot.classList.remove('drag-over');
  });
  $('#shotsBody').addEventListener('drop', (e) => {
    const slot = e.target.closest('.slot-wrap');
    if (!slot) return;
    e.preventDefault();
    slot.classList.remove('drag-over');
    let data;
    try { data = JSON.parse(e.dataTransfer.getData('application/x-asset')); } catch (err) { return; }
    const slotType = slot.dataset.slot;
    const shotId = slot.dataset.shot;
    if (data.type === slotType) {
      bindAsset(data.type, data.id, shotId);
      toast(`已绑定「${getAsset(data.type, data.id).name}」`, 'ok', 1500);
    } else {
      toast(`类型不匹配：该槽位只接受${TYPE_META[slotType].label}`, 'err');
    }
  });

  window.addEventListener('beforeunload', () => {
    window.mochi.saveProject(state.project);
  });
}

// ================= 启动 =================
async function init() {
  state.config = await window.mochi.loadConfig();
  state.project = (await window.mochi.loadProject()) || defaultProject();
  state.voices = await window.mochi.ttsVoices();
  $('#voiceSelect').innerHTML = state.voices.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
  $('#projectName').value = state.project.name || '未命名漫剧';
  $$('#aspectSwitch button').forEach(b => b.classList.toggle('active', b.dataset.v === state.project.aspect));

  // 数据迁移（补全缺失字段）
  const p = state.project;
  p.assets = p.assets || { characters: [], scenes: [], props: [], others: [], sfx: [] };
  ['characters', 'scenes', 'props', 'others', 'sfx'].forEach(k => { if (!p.assets[k]) p.assets[k] = []; });
  p.shots = (p.shots || []).map(s => Object.assign({
    id: uid(), text: '', dialogue: '', characters: [], scene: null, props: [], others: [],
    sfxId: null, voicePath: null, voiceDuration: 0, storyboardImg: null, videoUrl: null, duration: 3
  }, s));

  // 确保所有弹窗初始隐藏（防止叠加）
  $$('.modal-mask').forEach(m => m.classList.add('hidden'));

  bindEvents();
  initUpdaterUI();
  renderAll();
}

init();
