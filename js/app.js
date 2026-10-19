import * as db from './db.js';
import * as player from './player.js';
import { readTags } from './tags.js';
import * as fx from './fx.js';

const $ = (s) => document.querySelector(s);

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path class="fill" d="M7 4l13 8-13 8z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path class="fill" d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
const ICON_NOTE = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#2a2a2d"/><path d="M20 32V14l14-3v18" fill="none" stroke="#6b6b70" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="17" cy="32" r="3.5" fill="#6b6b70"/><circle cx="31" cy="29" r="3.5" fill="#6b6b70"/></svg>');

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
  if (v === 'add') updateStorageInfo();
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

async function saveTrackMeta(t) {
  const { artUrl, ...rec } = t;
  await db.putTrack(rec);
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
  $('#fxCrossfade').value = s.crossfade;
  $('#fxCrossfadeVal').textContent = s.crossfade ? `${s.crossfade}秒` : 'オフ';
  $('#fxTrim').checked = s.trimSilence;
  $('#fxNormalize').checked = s.normalize;
  $('#fxNight').checked = s.night;
  $('#fxReverb').value = s.reverb;
  $('#fxReverbVal').textContent = s.reverb ? `${s.reverb}%` : 'オフ';
  $('#fxSpeed').value = s.speed;
  $('#fxSpeedVal').textContent = `${Number(s.speed).toFixed(2)}倍`;

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
  num('#fxCrossfade', 'crossfade');
  num('#fxReverb', 'reverb');
  num('#fxSpeed', 'speed');
  flag('#fxTrim', 'trimSilence');
  flag('#fxNormalize', 'normalize');
  flag('#fxNight', 'night');
  $('#fxReset').onclick = () => { fx.reset(); renderSound(); toast('サウンド設定を元に戻しました'); };
}

// ---------- 再生画面 ----------
function openNow() {
  $('#nowPlaying').classList.add('open');
  $('#nowPlaying').setAttribute('aria-hidden', 'false');
  renderQueue();
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
  player.on('error', toast);
  player.on('analyzed', (t) => saveTrackMeta(t));
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
  await loadAll();
  restoreSession();
  show('library');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
