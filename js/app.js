import * as db from './db.js';
import * as player from './player.js';
import { readTags } from './tags.js';
import * as fx from './fx.js';
import * as sync from './sync.js';

const $ = (s) => document.querySelector(s);

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path class="fill" d="M7 4l13 8-13 8z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path class="fill" d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
// ジャケットがない曲の画像: 暗い背景にOtoのロゴ
const ICON_NOTE = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a5b"/><stop offset="1" stop-color="#e8336d"/></linearGradient></defs>' +
  '<rect width="512" height="512" fill="#2a2a2d"/><g transform="translate(256 256) scale(.78) translate(-256 -256)" fill="none" stroke="url(#g)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M184 268V158Q243 118 302 146T420 134V292"/><circle cx="138" cy="268" r="46"/><circle cx="374" cy="292" r="46"/><path d="M230 234H282M256 234V326"/></g></svg>');

let tracks = [];      // ライブラリ(追加日の新しい順)
let playlists = [];
let byId = new Map();
let view = 'library';
let openPlaylistId = null;

// ---------- ユーティリティ ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function withArt(t) {
  if (t.type === 'youtube') t.artUrl = `https://i.ytimg.com/vi/${t.ytId}/hqdefault.jpg`;
  else if (t.picture && !t.artUrl) t.artUrl = URL.createObjectURL(t.picture);
  return t;
}

function actionSheet(title, items) {
  const sheet = $('#actionSheet');
  $('#actionTitle').textContent = title;
  const box = $('#actionItems');
  box.innerHTML = '';
  items.forEach((it) => {
    const b = document.createElement('button');
    b.className = 'action-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.onclick = () => { close(); it.run(); };
    box.appendChild(b);
  });
  const close = () => sheet.classList.add('hidden');
  sheet.querySelector('.action-backdrop').onclick = close;
  sheet.querySelector('[data-cancel]').onclick = close;
  sheet.classList.remove('hidden');
}

// ブラウザ標準の prompt/confirm の代わりに使う画面内ダイアログ
function dialog({ title, fields = [], ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const box = $('#dialog');
    $('#dialogTitle').textContent = title;
    const body = $('#dialogFields');
    body.innerHTML = '';
    const inputs = fields.map((f, i) => {
      const label = document.createElement('label');
      label.textContent = f.label;
      const input = document.createElement('input');
      input.id = `dialogField${i}`;
      input.value = f.value ?? '';
      input.autocomplete = 'off';
      label.appendChild(input);
      body.appendChild(label);
      return input;
    });
    const okBtn = $('#dialogOk');
    okBtn.textContent = ok;
    okBtn.classList.toggle('danger', danger);
    const finish = (v) => { box.classList.add('hidden'); resolve(v); };
    okBtn.onclick = () => finish(inputs.map((x) => x.value));
    $('#dialogCancel').onclick = () => finish(null);
    box.querySelector('.action-backdrop').onclick = () => finish(null);
    $('#dialogForm').onsubmit = (e) => { e.preventDefault(); okBtn.click(); };
    box.classList.remove('hidden');
    inputs[0]?.focus();
    inputs[0]?.select();
  });
}

async function promptText(label, value) {
  const r = await dialog({ title: label, fields: [{ label, value }] });
  return r ? r[0] : null;
}

const confirmDanger = async (title, ok) => !!(await dialog({ title, ok, danger: true }));

// ---------- データ読み込み ----------
async function loadAll() {
  tracks = (await db.getAllTracks()).map(withArt).sort((a, b) => b.addedAt - a.addedAt);
  byId = new Map(tracks.map((t) => [t.id, t]));
  playlists = (await db.getAllPlaylists()).sort((a, b) => a.createdAt - b.createdAt);
}

// ---------- 描画 ----------
function trackRow(t, { index, onTap, menu = true } = {}) {
  const li = document.createElement('li');
  li.className = 'track' + (player.current()?.id === t.id ? ' playing' : '');
  li.innerHTML = `
    <img class="art-sm" src="${esc(t.artUrl || ICON_NOTE)}" alt="" loading="lazy">
    <div class="meta">
      <div class="title">${t.type === 'youtube' ? '<span class="yt-mark">YT</span>' : ''}${esc(t.title)}</div>
      <div class="sub">${esc([t.artist, t.duration ? fmt(t.duration) : ''].filter(Boolean).join(' ・ '))}</div>
    </div>
    ${menu ? '<button class="icon-btn more" aria-label="メニュー"><svg viewBox="0 0 24 24"><circle class="fill" cx="5" cy="12" r="1.8"/><circle class="fill" cx="12" cy="12" r="1.8"/><circle class="fill" cx="19" cy="12" r="1.8"/></svg></button>' : ''}`;
  li.addEventListener('click', (e) => {
    if (e.target.closest('.more')) { trackMenu(t); return; }
    onTap?.(index);
  });
  return li;
}

function filteredTracks() {
  const q = $('#searchInput').value.trim().toLowerCase();
  if (!q) return tracks;
  return tracks.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));
}

function renderLibrary() {
  const list = $('#libraryList');
  const items = filteredTracks();
  list.innerHTML = '';
  items.forEach((t, i) => list.appendChild(trackRow(t, { index: i, onTap: (idx) => player.playList(items, idx) })));
  $('#libraryEmpty').classList.toggle('hidden', tracks.length > 0);
}

function renderPlaylists() {
  const list = $('#playlistList');
  list.innerHTML = '';
  playlists.forEach((pl) => {
    const first = pl.trackIds.map((id) => byId.get(id)).find(Boolean);
    const li = document.createElement('li');
    li.className = 'playlist-item';
    li.innerHTML = `
      <img class="art-sm" src="${esc(first?.artUrl || ICON_NOTE)}" alt="">
      <div class="meta" style="flex:1;min-width:0">
        <div class="title">${esc(pl.name)}</div>
        <div class="sub">${pl.trackIds.length}曲</div>
      </div>`;
    li.onclick = () => openPlaylist(pl.id);
    list.appendChild(li);
  });
  $('#playlistEmpty').classList.toggle('hidden', playlists.length > 0);
}

function playlistTracks(pl) {
  return pl.trackIds.map((id) => byId.get(id)).filter(Boolean);
}

function renderPlaylist() {
  const pl = playlists.find((p) => p.id === openPlaylistId);
  if (!pl) { switchTab('playlists'); return; }
  $('#viewTitle').textContent = pl.name;
  const items = playlistTracks(pl);
  const list = $('#playlistTracks');
  list.innerHTML = '';
  items.forEach((t, i) => list.appendChild(trackRow(t, { index: i, onTap: (idx) => player.playList(items, idx) })));
  $('#playlistTracksEmpty').classList.toggle('hidden', items.length > 0);
}

function renderQueue() {
  const { queue, index } = player.state;
  const list = $('#queueList');
  list.innerHTML = '';
  queue.slice(index + 1).forEach((t, i) => {
    list.appendChild(trackRow(t, { index: index + 1 + i, onTap: (idx) => player.jumpTo(idx), menu: false }));
  });
  if (!list.children.length) list.innerHTML = '<li class="empty small">次の曲はありません</li>';
}

function renderNow() {
  const t = player.current();
  $('#miniPlayer').classList.toggle('hidden', !t);
  document.querySelectorAll('.track').forEach((el) => el.classList.remove('playing'));
  if (!t) return;
  $('#miniTitle').textContent = t.title;
  $('#miniArtist').textContent = t.artist || '';
  $('#miniArt').src = t.artUrl || ICON_NOTE;
  $('#npTitle').textContent = t.title;
  $('#npArtist').textContent = t.artist || '';
  $('#npArt').src = t.artUrl || ICON_NOTE;
  $('#artWrap').classList.toggle('video', t.type === 'youtube');
  $('#npArt').classList.toggle('hidden', t.type === 'youtube');
  placeYtDock();
}

function renderControls() {
  const { shuffle, repeat, playing } = player.state;
  $('#playBtn').innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  $('#miniPlayBtn').innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  $('#shuffleBtn').classList.toggle('on', shuffle);
  $('#repeatBtn').classList.toggle('on', repeat !== 'off');
  $('#repeatOne').classList.toggle('hidden', repeat !== 'one');
}

function rerender() {
  if (view === 'library') renderLibrary();
  else if (view === 'playlists') renderPlaylists();
  else if (view === 'playlist') renderPlaylist();
  renderNow();
}

// ---------- 画面切り替え ----------
const TITLES = { library: 'ライブラリ', playlists: 'プレイリスト', sound: 'サウンド', add: '追加' };

function show(v) {
  view = v;
  document.querySelectorAll('.view').forEach((el) => el.classList.add('hidden'));
  $(`#view-${v}`).classList.remove('hidden');
  $('#backBtn').classList.toggle('hidden', v !== 'playlist');
  if (TITLES[v]) $('#viewTitle').textContent = TITLES[v];
  window.scrollTo(0, 0);
  if (v === 'add') { updateStorageInfo(); renderSync(); }
  if (v === 'sound') renderSound();
  rerender();
}

function switchTab(tab) {
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  show(tab);
}

function openPlaylist(id) {
  openPlaylistId = id;
  show('playlist');
}

// ---------- 曲・プレイリスト操作 ----------
function trackMenu(t) {
  const items = [
    { label: '次に再生', run: () => { player.playNext(t); toast('次に再生します'); } },
    { label: 'プレイリストに追加…', run: () => addToPlaylistMenu(t) },
    { label: '曲名・アーティストを編集', run: () => editTrack(t) },
  ];
  if (view === 'playlist') {
    items.push({ label: 'このプレイリストから外す', run: () => removeFromPlaylist(openPlaylistId, t.id) });
  }
  if (t.type === 'youtube') {
    items.push({ label: 'YouTubeで開く', run: () => window.open(`https://www.youtube.com/watch?v=${t.ytId}`, '_blank') });
  }
  items.push({ label: 'ライブラリから削除', danger: true, run: () => removeTrack(t) });
  actionSheet(t.title, items);
}

function addToPlaylistMenu(t) {
  const items = playlists.map((pl) => ({
    label: pl.name + (pl.trackIds.includes(t.id) ? '(追加済み)' : ''),
    run: async () => {
      if (!pl.trackIds.includes(t.id)) {
        pl.trackIds.push(t.id);
        await db.putPlaylist(pl);
      }
      toast(`「${pl.name}」に追加しました`);
      rerender();
    },
  }));
  items.unshift({
    label: '＋ 新しいプレイリスト',
    run: async () => {
      const pl = await createPlaylist();
      if (pl) {
        pl.trackIds.push(t.id);
        await db.putPlaylist(pl);
        toast(`「${pl.name}」に追加しました`);
        rerender();
      }
    },
  });
  actionSheet('プレイリストに追加', items);
}

async function createPlaylist() {
  const name = await promptText('プレイリスト名', '新しいプレイリスト');
  if (!name?.trim()) return null;
  const pl = { id: db.uid(), name: name.trim(), trackIds: [], createdAt: Date.now() };
  await db.putPlaylist(pl);
  playlists.push(pl);
  return pl;
}

async function removeFromPlaylist(plId, trackId) {
  const pl = playlists.find((p) => p.id === plId);
  if (!pl) return;
  pl.trackIds = pl.trackIds.filter((id) => id !== trackId);
  await db.putPlaylist(pl);
  rerender();
}

async function editTrack(t) {
  const r = await dialog({ title: '曲の情報を編集', fields: [{ label: '曲名', value: t.title }, { label: 'アーティスト', value: t.artist || '' }], ok: '保存' });
  if (!r) return;
  const [title, artist] = r;
  t.title = title.trim() || t.title;
  t.artist = artist.trim();
  t.titlePending = false;
  await saveTrackMeta(t);
  rerender();
  player.refreshMeta();
}

async function saveTrackMeta(t, { touch = true } = {}) {
  const { artUrl, ...rec } = t;
  await db.putTrack(rec, null, { touch });
  t.updatedAt = rec.updatedAt;
}

async function removeTrack(t) {
  if (!(await confirmDanger(`「${t.title}」をライブラリから削除しますか?`, '削除'))) return;
  await db.deleteTrack(t.id);
  if (t.artUrl?.startsWith('blob:')) URL.revokeObjectURL(t.artUrl);
  player.removeFromQueue(t.id);
  await loadAll();
  rerender();
}

function playlistMenu() {
  const pl = playlists.find((p) => p.id === openPlaylistId);
  if (!pl) return;
  actionSheet(pl.name, [
    {
      label: '名前を変更',
      run: async () => {
        const name = await promptText('プレイリスト名', pl.name);
        if (!name?.trim()) return;
        pl.name = name.trim();
        await db.putPlaylist(pl);
        rerender();
      },
    },
    {
      label: 'プレイリストを削除',
      danger: true,
      run: async () => {
        if (!(await confirmDanger(`「${pl.name}」を削除しますか?曲はライブラリに残ります。`, '削除'))) return;
        await db.deletePlaylist(pl.id);
        playlists = playlists.filter((p) => p !== pl);
        switchTab('playlists');
      },
    },
  ]);
}

// ---------- 追加 ----------
async function importFiles(files) {
  const status = $('#importStatus');
  let ok = 0;
  const list = [...files];
  for (const [i, file] of list.entries()) {
    status.textContent = `読み込み中… ${i + 1} / ${list.length}`;
    try {
      const tags = await readTags(file);
      const track = {
        id: db.uid(), type: 'file', title: tags.title, artist: tags.artist, album: tags.album,
        picture: tags.picture, duration: tags.duration, size: file.size, addedAt: Date.now() + i,
        fileName: file.name, mime: file.type,
      };
      await db.putTrack(track, file);
      ok++;
    } catch (e) {
      console.error(e);
    }
  }
  status.textContent = `${ok}曲を追加しました` + (ok < list.length ? `(${list.length - ok}件は失敗)` : '');
  await loadAll();
  updateStorageInfo();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

export function parseYouTubeId(input) {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') return u.pathname.slice(1, 12) || null;
  if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    const v = u.searchParams.get('v');
    if (v) return v.slice(0, 11);
    const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
    if (m) return m[1];
  }
  return null;
}

async function fetchYtTitle(id) {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = await res.json();
    return { title: j.title, artist: j.author_name };
  } catch {
    return null;
  }
}

async function addYouTube(e) {
  e.preventDefault();
  const input = $('#ytInput');
  const status = $('#ytStatus');
  const id = parseYouTubeId(input.value);
  if (!id) { status.textContent = 'YouTubeの動画URLを入力してください'; return; }
  if (tracks.some((t) => t.ytId === id)) { status.textContent = 'この動画はすでに追加されています'; return; }
  status.textContent = '追加中…';
  const info = await fetchYtTitle(id);
  const track = {
    id: db.uid(), type: 'youtube', ytId: id,
    title: info?.title || `YouTube動画 (${id})`, artist: info?.artist || '',
    titlePending: !info, addedAt: Date.now(),
  };
  await db.putTrack(track);
  input.value = '';
  status.textContent = `「${track.title}」を追加しました`;
  await loadAll();
}

async function updateStorageInfo() {
  const el = $('#storageInfo');
  const n = tracks.length;
  if (!navigator.storage?.estimate) { el.textContent = `${n}曲`; return; }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const mb = (b) => (b / 1024 / 1024).toFixed(b > 1024 ** 3 ? 0 : 1);
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  el.textContent = `${n}曲 ・ 使用中 ${mb(usage)}MB / 上限の目安 ${mb(quota)}MB` +
    (persisted ? '' : '\nホーム画面に追加して使うと、データが消されにくくなります。');
  el.style.whiteSpace = 'pre-line';
}

// ---------- YouTube 埋め込みの配置 ----------
let ytVisible = false;
function placeYtDock() {
  const dock = $('#ytDock');
  const isYt = player.current()?.type === 'youtube';
  dock.classList.toggle('hidden', !(ytVisible && isYt));
  const open = $('#nowPlaying').classList.contains('open');
  dock.classList.toggle('in-sheet', open);
  if (open) {
    const r = $('#artWrap').getBoundingClientRect();
    Object.assign(dock.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px' });
  } else {
    Object.assign(dock.style, { left: '', top: '', width: '' });
  }
}

// ---------- サウンド設定 ----------
function renderSound() {
  const s = fx.settings;
  $('#fxVolume').value = s.volume;
  $('#fxVolumeVal').textContent = `${s.volume}%`;
  $('#npVolume').value = s.volume;
  $('#fxCrossfade').value = s.crossfade;
  $('#fxCrossfadeVal').textContent = s.crossfade ? `${s.crossfade}秒` : 'オフ';
  $('#fxTrim').checked = s.trimSilence;
  $('#fxNormalize').checked = s.normalize;
  $('#fxNight').checked = s.night;
  $('#fxReverb').value = s.reverb;
  $('#fxReverbVal').textContent = s.reverb ? `${s.reverb}%` : 'オフ';
  $('#fxSpeed').value = s.speed;
  $('#fxSpeedVal').textContent = `${Number(s.speed).toFixed(2)}倍`;
  $('#fxWidth').value = s.width;
  $('#fxWidthVal').textContent = s.width ? `${s.width}%` : 'オフ';
  $('#fxRotation').value = s.rotation;
  $('#fxRotationVal').textContent = `${s.rotation}秒`;
  $('#fxRotationRow').classList.toggle('hidden', s.spatial !== '8d');
  document.querySelectorAll('#fxSpatial button').forEach((b) => {
    const on = b.dataset.mode === s.spatial;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  });
  $('#fxSpatialHelp').textContent = {
    off: '立体音響を使いません。',
    '8d': '音が頭のまわりをゆっくり回るように聞こえます。',
    surround: '部屋に置いたスピーカーで聴いているように、音が頭の外から聞こえます。耳が疲れにくくなります。',
  }[s.spatial] || '';
  $('#fxVocal').value = s.vocal;
  $('#fxVocalVal').textContent = `${s.vocal}%`;
  $('#fxInst').value = s.inst;
  $('#fxInstVal').textContent = `${s.inst}%`;
  document.querySelectorAll('#fxVocalPresets .chip').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.vocal) === s.vocal && Number(b.dataset.inst) === s.inst);
  });
  $('#fxViz').checked = s.visualizer;

  const chips = $('#fxPresets');
  chips.innerHTML = '';
  Object.entries(fx.PRESETS).forEach(([key, p]) => {
    const b = document.createElement('button');
    b.className = 'chip' + (s.preset === key ? ' on' : '');
    b.textContent = p.name;
    b.onclick = () => { fx.update({ preset: key, eq: p.eq.slice() }); renderSound(); };
    chips.appendChild(b);
  });
  if (s.preset === 'custom') {
    const c = document.createElement('span');
    c.className = 'chip on';
    c.style.display = 'inline-grid';
    c.style.placeItems = 'center';
    c.textContent = 'カスタム';
    chips.appendChild(c);
  }

  const eq = $('#fxEq');
  if (!eq.children.length) {
    fx.BANDS.forEach((band, i) => {
      const row = document.createElement('div');
      row.className = 'eq-row';
      row.innerHTML = `<span>${band.label}</span><input id="fxEq${i}" type="range" min="-12" max="12" step="1" aria-label="${band.label}"><span id="fxEqVal${i}"></span>`;
      eq.appendChild(row);
      row.querySelector('input').addEventListener('input', (e) => {
        const g = fx.settings.eq.slice();
        g[i] = Number(e.target.value);
        fx.update({ eq: g, preset: 'custom' });
        renderSound();
      });
    });
  }
  s.eq.forEach((g, i) => {
    $(`#fxEq${i}`).value = g;
    $(`#fxEqVal${i}`).textContent = `${g > 0 ? '+' : ''}${g}dB`;
  });
}

function bindSound() {
  const num = (id, key) => $(id).addEventListener('input', (e) => { fx.update({ [key]: Number(e.target.value) }); renderSound(); });
  const flag = (id, key) => $(id).addEventListener('change', (e) => { fx.update({ [key]: e.target.checked }); renderSound(); });
  num('#fxVolume', 'volume');
  num('#npVolume', 'volume');
  num('#fxCrossfade', 'crossfade');
  num('#fxReverb', 'reverb');
  num('#fxSpeed', 'speed');
  flag('#fxTrim', 'trimSilence');
  flag('#fxNormalize', 'normalize');
  flag('#fxNight', 'night');
  flag('#fxViz', 'visualizer');
  num('#fxWidth', 'width');
  num('#fxRotation', 'rotation');
  num('#fxVocal', 'vocal');
  num('#fxInst', 'inst');
  document.querySelectorAll('#fxSpatial button').forEach((b) => {
    b.onclick = () => { fx.update({ spatial: b.dataset.mode }); renderSound(); };
  });
  document.querySelectorAll('#fxVocalPresets .chip').forEach((b) => {
    b.onclick = () => { fx.update({ vocal: Number(b.dataset.vocal), inst: Number(b.dataset.inst) }); renderSound(); };
  });
  $('#fxReset').onclick = () => { fx.reset(); renderSound(); toast('サウンド設定を元に戻しました'); };
}

// ---------- ビジュアライザー ----------
let vizRaf = 0;
let vizData = null;
const VIZ_BARS = 40;

function vizActive() {
  return fx.settings.visualizer && fx.hasGraph() && player.current()?.type === 'file' &&
    $('#nowPlaying').classList.contains('open');
}

function drawViz() {
  vizRaf = 0;
  const canvas = $('#viz');
  const on = vizActive();
  canvas.classList.toggle('hidden', !on);
  if (!on) return;
  const n = fx.spectrumSize();
  if (!vizData || vizData.length !== n) vizData = new Uint8Array(n);
  fx.readSpectrum(vizData);

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff5a5f';
  const gap = 3;
  const bw = (w - gap * (VIZ_BARS - 1)) / VIZ_BARS;
  // 低音から高音まで、耳の感じ方に近い対数の間隔でバーに割り当てる
  const lo = 2;
  const hi = Math.min(n - 1, Math.floor(n * 0.7));
  for (let i = 0; i < VIZ_BARS; i++) {
    const a = Math.floor(lo * Math.pow(hi / lo, i / VIZ_BARS));
    const b = Math.max(a + 1, Math.floor(lo * Math.pow(hi / lo, (i + 1) / VIZ_BARS)));
    let m = 0;
    for (let k = a; k < b; k++) m = Math.max(m, vizData[k]);
    const v = Math.pow(m / 255, 1.6);
    const bh = Math.max(2, v * h);
    g.globalAlpha = 0.35 + 0.65 * v;
    g.fillStyle = accent;
    g.beginPath();
    const x = i * (bw + gap);
    if (g.roundRect) g.roundRect(x, h - bh, bw, bh, Math.min(3, bw / 2));
    else g.rect(x, h - bh, bw, bh);
    g.fill();
  }
  g.globalAlpha = 1;
  vizRaf = requestAnimationFrame(drawViz);
}

function startViz() {
  if (!vizRaf) vizRaf = requestAnimationFrame(drawViz);
}

// ---------- Googleドライブ同期 ----------
function timeAgo(ms) {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return 'たった今';
  if (sec < 3600) return `${Math.floor(sec / 60)}分前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間前`;
  return new Date(ms).toLocaleDateString('ja-JP');
}

function renderSync() {
  const st = sync.state;
  const status = $('#syncStatus');
  const on = sync.configured();
  $('#syncLoginBtn').classList.toggle('hidden', !on || (st.enabled && !st.needsLogin));
  $('#syncLoginBtn').textContent = st.enabled ? 'Googleにログインし直す' : 'Googleでログインして同期';
  $('#syncNowBtn').classList.toggle('hidden', !on || !st.enabled || st.needsLogin);
  $('#syncNowBtn').disabled = st.busy;
  $('#syncLogoutBtn').classList.toggle('hidden', !on || !st.enabled);
  let text;
  if (!on) text = '同期機能は準備中です。';
  else if (!st.enabled) text = 'ログインすると、曲とプレイリストが自分のGoogleドライブの「Oto」フォルダに保存され、同じアカウントでログインした端末どうしで同期されます。';
  else if (st.busy) text = st.progress || '同期中…';
  else if (st.needsLogin) text = 'ログインの有効期限が切れました。同期を続けるにはログインし直してください。';
  else if (st.error) text = st.error;
  else text = `${st.email ? `${st.email} ・ ` : ''}${st.lastSync ? `最終同期 ${timeAgo(st.lastSync)}` : 'まだ同期していません'}`;
  status.textContent = text;
  status.classList.toggle('error', !!st.error && !st.busy);
  $('#syncBanner').classList.toggle('hidden', !(on && st.enabled && st.needsLogin));
}

function startSignIn() {
  sync.signIn().catch((e) => toast(e.message));
  renderSync();
}

function bindSync() {
  $('#syncLoginBtn').onclick = startSignIn;
  $('#syncBannerBtn').onclick = startSignIn;
  $('#syncNowBtn').onclick = () => sync.sync();
  $('#syncLogoutBtn').onclick = async () => {
    if (!(await confirmDanger('Googleドライブとの同期をやめますか?この端末の曲とドライブの曲はどちらも残ります。', '同期をやめる'))) return;
    sync.signOut();
  };
  sync.onChange(renderSync);
  sync.onSynced(async () => {
    await loadAll();
    rerender();
    if (view === 'add') updateStorageInfo();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sync.schedule(1000);
  });
  sync.preload();
  renderSync();
  setInterval(() => { if (view === 'add') renderSync(); }, 30000);
}

// ---------- 再生画面 ----------
function openNow() {
  $('#nowPlaying').classList.add('open');
  $('#nowPlaying').setAttribute('aria-hidden', 'false');
  renderQueue();
  startViz();
  setTimeout(placeYtDock, 300);
}

function closeNow() {
  $('#nowPlaying').classList.remove('open');
  $('#nowPlaying').setAttribute('aria-hidden', 'true');
  $('#queuePanel').classList.add('hidden');
  placeYtDock();
}

let seeking = false;
let lastDur = 0;

// ---------- 状態の保存(次回起動時にキューを復元) ----------
function saveSession() {
  try {
    const s = player.state;
    localStorage.setItem('oto.session', JSON.stringify({
      queue: s.queue.map((t) => t.id), original: s.original.map((t) => t.id),
      index: s.index, shuffle: s.shuffle, repeat: s.repeat,
    }));
  } catch { /* 保存できなくても動作には影響しない */ }
}

function restoreSession() {
  try {
    const s = JSON.parse(localStorage.getItem('oto.session') || 'null');
    if (!s) return;
    player.state.repeat = s.repeat || 'off';
    const q = s.queue.map((id) => byId.get(id)).filter(Boolean);
    if (!q.length) return;
    const cur = byId.get(s.queue[s.index]);
    player.playList(q, Math.max(0, q.indexOf(cur)), { shuffle: false, autoplay: false });
    player.state.shuffle = !!s.shuffle;
    player.state.original = (s.original || []).map((id) => byId.get(id)).filter(Boolean);
    renderControls();
  } catch { /* 無視 */ }
}

// ---------- イベント ----------
function bind() {
  bindSound();
  bindSync();
  document.querySelectorAll('.tabbar button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  $('#backBtn').onclick = () => switchTab('playlists');
  $('#searchInput').addEventListener('input', renderLibrary);
  $('#playAllBtn').onclick = () => player.playList(filteredTracks(), 0, { shuffle: false });
  $('#shuffleAllBtn').onclick = () => player.playList(filteredTracks(), -1, { shuffle: true });
  $('#newPlaylistBtn').onclick = async () => { const pl = await createPlaylist(); if (pl) renderPlaylists(); };
  $('#plPlayBtn').onclick = () => {
    const pl = playlists.find((p) => p.id === openPlaylistId);
    if (pl) player.playList(playlistTracks(pl), 0, { shuffle: false });
  };
  $('#plShuffleBtn').onclick = () => {
    const pl = playlists.find((p) => p.id === openPlaylistId);
    if (pl) player.playList(playlistTracks(pl), -1, { shuffle: true });
  };
  $('#plMenuBtn').onclick = playlistMenu;
  $('#fileInput').addEventListener('change', async (e) => {
    if (e.target.files.length) await importFiles(e.target.files);
    e.target.value = '';
  });
  $('#ytForm').addEventListener('submit', addYouTube);

  $('#miniPlayer').addEventListener('click', (e) => {
    if (e.target.closest('#miniPlayBtn')) player.toggle();
    else if (e.target.closest('#miniNextBtn')) player.next();
    else openNow();
  });
  $('#closeNowBtn').onclick = closeNow;
  $('#queueBtn').onclick = () => { $('#queuePanel').classList.toggle('hidden'); renderQueue(); };
  $('#playBtn').onclick = player.toggle;
  $('#prevBtn').onclick = player.prev;
  $('#nextBtn').onclick = () => player.next();
  $('#shuffleBtn').onclick = () => player.setShuffle(!player.state.shuffle);
  $('#repeatBtn').onclick = player.cycleRepeat;

  const seek = $('#seekBar');
  seek.addEventListener('input', () => {
    seeking = true;
    $('#curTime').textContent = fmt((seek.value / 1000) * lastDur);
  });
  seek.addEventListener('change', () => {
    player.seek((seek.value / 1000) * lastDur);
    seeking = false;
  });

  // 下に引いて再生画面を閉じる
  let startY = null;
  const np = $('#nowPlaying');
  np.addEventListener('touchstart', (e) => { startY = np.scrollTop <= 0 && !e.target.closest('input') ? e.touches[0].clientY : null; }, { passive: true });
  np.addEventListener('touchend', (e) => {
    if (startY !== null && e.changedTouches[0].clientY - startY > 90) closeNow();
    startY = null;
  });

  window.addEventListener('resize', placeYtDock);
  np.addEventListener('scroll', placeYtDock, { passive: true });

  player.on('change', () => { renderNow(); renderQueue(); saveSession(); });
  player.on('queue', () => { renderControls(); renderQueue(); saveSession(); });
  player.on('state', renderControls);
  player.on('change', startViz);
  fx.onChange(startViz);
  player.on('error', toast);
  player.on('analyzed', (t) => saveTrackMeta(t, { touch: false }));
  player.on('yt-visible', (v) => { ytVisible = v; placeYtDock(); });
  player.on('yt-title', async (t, title, author) => {
    t.title = title;
    if (!t.artist) t.artist = author || '';
    t.titlePending = false;
    await saveTrackMeta(t);
    rerender();
    player.refreshMeta();
  });
  player.on('time', (cur, dur) => {
    lastDur = dur;
    const pct = dur ? (cur / dur) * 100 : 0;
    $('#miniProgressBar').style.width = pct + '%';
    if (!seeking) {
      $('#seekBar').value = dur ? Math.round((cur / dur) * 1000) : 0;
      $('#curTime').textContent = fmt(cur);
    }
    $('#durTime').textContent = fmt(dur);
  });
}

async function init() {
  bind();
  renderControls();
  renderSound();
  await loadAll();
  restoreSession();
  show('library');
  sync.schedule(500);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
