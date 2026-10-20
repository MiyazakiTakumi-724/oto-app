import * as db from './db.js';
import * as player from './player.js';
import { readTags } from './tags.js';
import * as fx from './fx.js';
import * as sync from './sync.js';

const $ = (s) => document.querySelector(s);

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path class="fill" d="M7 4l13 8-13 8z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path class="fill" d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
// ジャケットがない曲の画像: 暗い背景にotoのロゴ
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

// ---------- アニメーション ----------
// 動きを減らす設定の端末では、アニメーションをしない
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE_OUT = 'cubic-bezier(.22, 1, .36, 1)';
const PAUSED_SCALE = 0.86; // 一時停止中のジャケットの大きさ(style.css と合わせる)

function showEl(el) {
  clearTimeout(el._closeTimer);
  el.classList.remove('closing', 'hidden');
}

// 閉じるアニメーション(CSS の .closing)が終わってから隠す
function hideAnimated(el) {
  if (el.classList.contains('hidden') || el.classList.contains('closing')) return;
  if (REDUCED) { el.classList.add('hidden'); return; }
  el.classList.add('closing');
  el._closeTimer = setTimeout(() => { el.classList.add('hidden'); el.classList.remove('closing'); }, 200);
}

// 一覧の項目を少しずつずらして浮かび上がらせる(画面に入る最初の数件だけ)
function staggerIn(items) {
  if (REDUCED) return;
  const els = [...items].slice(0, 14);
  els.forEach((el, i) => { el.style.setProperty('--i', i); el.classList.add('enter'); });
  setTimeout(() => els.forEach((el) => el.classList.remove('enter')), 1000);
}

// ジャケットが変わったときに、ふわっと切り替える
function popIn(el) {
  if (REDUCED || !el.animate) return;
  el.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: EASE_OUT });
}

// 長い曲名は横に流す(収まる長さならそのまま)
function setMarquee(el, text) {
  const w = el.clientWidth;
  if (el.dataset.text === text && el._mqW === w) return;
  el.dataset.text = text;
  el._mqW = w;
  el.classList.remove('marquee');
  el.textContent = text;
  if (REDUCED || !w || el.scrollWidth <= w + 1) return;
  const track = document.createElement('span');
  track.className = 'marquee-track';
  const a = document.createElement('span');
  a.textContent = text;
  const b = a.cloneNode(true);
  b.setAttribute('aria-hidden', 'true');
  track.append(a, b);
  el.textContent = '';
  el.append(track);
  el.classList.add('marquee');
  const dist = a.offsetWidth;
  track.style.setProperty('--dist', `${-dist}px`);
  track.style.animationDuration = `${(dist / 32 / 0.8).toFixed(1)}s`;
  el._mqW = el.clientWidth;
}

function refreshMarquees() {
  ['#miniTitle', '#npTitle'].forEach((sel) => {
    const el = $(sel);
    if (el.dataset.text != null) { el._mqW = -1; setMarquee(el, el.dataset.text); }
  });
}

// 削除した行を縮めて消す(下の行が詰まってくる)
function collapseRows(rows) {
  if (REDUCED || !rows.length) return Promise.resolve();
  return Promise.all([...rows].map((el) => {
    const h = el.offsetHeight;
    el.style.overflow = 'hidden';
    return el.animate([
      { height: `${h}px`, minHeight: '0px', opacity: 1, transform: 'none' },
      { height: `${h}px`, minHeight: '0px', opacity: 0, transform: 'translateX(-24px)', offset: 0.45 },
      { height: '0px', minHeight: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0, transform: 'translateX(-24px)' },
    ], { duration: 420, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' }).finished.catch(() => {});
  }));
}

// ミニプレイヤーと再生画面の間で、ジャケットが飛んで大きさを変える
function flyArt(from, to, { radiusFrom, radiusTo, duration = 460 } = {}) {
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (!a.width || !b.width) return null;
  const img = document.createElement('img');
  img.className = 'art-flight';
  img.src = $('#npArt').src;
  Object.assign(img.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
  document.body.append(img);
  const sx = a.width / b.width;
  const sy = a.height / b.height;
  const anim = img.animate([
    { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${sx}, ${sy})`, borderRadius: `${radiusFrom / sx}px` },
    { transform: 'none', borderRadius: `${radiusTo}px` },
  ], { duration, easing: EASE_OUT, fill: 'forwards' });
  return anim.finished.catch(() => {}).then(() => img.remove());
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  showEl(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideAnimated(el), 2600);
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
  const close = () => hideAnimated(sheet);
  sheet.querySelector('.action-backdrop').onclick = close;
  sheet.querySelector('[data-cancel]').onclick = close;
  showEl(sheet);
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
    const finish = (v) => { hideAnimated(box); resolve(v); };
    okBtn.onclick = () => finish(inputs.map((x) => x.value));
    $('#dialogCancel').onclick = () => finish(null);
    box.querySelector('.action-backdrop').onclick = () => finish(null);
    $('#dialogForm').onsubmit = (e) => { e.preventDefault(); okBtn.click(); };
    showEl(box);
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
  li.dataset.id = t.id;
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
  const hideYt = $('#hideYoutube').checked;
  return tracks.filter((t) => !(hideYt && t.type === 'youtube') &&
    (!q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)));
}

function renderLibrary() {
  const list = $('#libraryList');
  const items = filteredTracks();
  list.innerHTML = '';
  items.forEach((t, i) => list.appendChild(trackRow(t, { index: i, onTap: (idx) => player.playList(items, idx) })));
  if (tracks.length && !items.length) list.innerHTML = '<li class="empty small">条件に合う曲はありません</li>';
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

let shownTrackId = null;
let trackSwiping = false; // スワイプで曲を切り替えている最中

function renderNow() {
  const t = player.current();
  $('#miniPlayer').classList.toggle('hidden', !t);
  document.querySelectorAll('.track').forEach((el) => el.classList.remove('playing'));
  if (!t) return;
  setMarquee($('#miniTitle'), t.title);
  $('#miniArtist').textContent = t.artist || '';
  $('#miniArt').src = t.artUrl || ICON_NOTE;
  setMarquee($('#npTitle'), t.title);
  $('#npArtist').textContent = t.artist || '';
  $('#npArt').src = t.artUrl || ICON_NOTE;
  if (shownTrackId && shownTrackId !== t.id) {
    if (!trackSwiping) {
      popIn($('#miniArt'));
      if ($('#nowPlaying').classList.contains('open')) popIn($('#npArt'));
    }
  }
  shownTrackId = t.id;
  $('#artWrap').classList.toggle('video', t.type === 'youtube');
  $('#npArt').classList.toggle('hidden', t.type === 'youtube');
  placeYtDock();
}

function renderControls() {
  const { shuffle, repeat, playing } = player.state;
  // 再生/一時停止が変わったときだけアイコンを差し替える(差し替えたアイコンはCSSでポンと弾む)
  ['#playBtn', '#miniPlayBtn'].forEach((sel) => {
    const b = $(sel);
    if (b.dataset.playing === String(playing)) return;
    b.dataset.playing = String(playing);
    b.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  });
  $('#nowPlaying').classList.toggle('paused', !playing);
  $('#shuffleBtn').classList.toggle('on', shuffle);
  $('#repeatBtn').classList.toggle('on', repeat !== 'off');
  $('#repeatOne').classList.toggle('hidden', repeat !== 'one');
}

function renderView(v) {
  if (v === 'library') renderLibrary();
  else if (v === 'playlists') renderPlaylists();
  else if (v === 'playlist') renderPlaylist();
  else if (v === 'sound') renderSound();
  else if (v === 'add') { updateStorageInfo(); renderSync(); }
}

function rerender() {
  if (view === 'library' || view === 'playlists' || view === 'playlist') renderView(view);
  renderNow();
}

// ---------- 画面切り替え ----------
const TITLES = { library: 'ライブラリ', playlists: 'プレイリスト', sound: 'サウンド', add: '追加' };

function show(v, { swiped = false } = {}) {
  view = v;
  document.querySelectorAll('.view').forEach((el) => el.classList.add('hidden'));
  const el = $(`#view-${v}`);
  // スワイプで来たときは、もう横から入ってきているので、下からの登場はしない
  if (!swiped) el.classList.remove('swiped');
  el.classList.remove('hidden');
  $('#backBtn').classList.toggle('hidden', v !== 'playlist');
  if (TITLES[v]) $('#viewTitle').textContent = TITLES[v];
  window.scrollTo(0, 0);
  if (swiped) { renderNow(); return; }
  if (v === 'add') { updateStorageInfo(); renderSync(); }
  if (v === 'sound') renderSound();
  rerender();
  if (v === 'library') staggerIn($('#libraryList').children);
  else if (v === 'playlists') staggerIn($('#playlistList').children);
  else if (v === 'playlist') staggerIn($('#playlistTracks').children);
  else staggerIn(el.querySelectorAll(':scope > .card'));
}

function switchTab(tab, opts) {
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  show(tab, opts);
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
  await collapseRows(document.querySelectorAll(`#playlistTracks .track[data-id="${CSS.escape(trackId)}"]`));
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
  await collapseRows(document.querySelectorAll(`main .track[data-id="${CSS.escape(t.id)}"]`));
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
  else if (!st.enabled) text = 'ログインすると、曲とプレイリストが自分のGoogleドライブの「oto」フォルダに保存され、同じアカウントでログインした端末どうしで同期されます。';
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
// ジャケットを飛ばせるとき(動画ではなく、ミニプレイヤーが見えている)
function canFly() {
  return !REDUCED && player.current()?.type !== 'youtube' && !$('#miniPlayer').classList.contains('hidden');
}

function openNow() {
  const np = $('#nowPlaying');
  if (np.classList.contains('open')) return;
  np.scrollTop = 0;
  if (canFly()) {
    // 再生画面が開き切ったときのジャケット位置(一時停止中は少し小さい)へ向けて飛ばす
    const offset = new DOMMatrix(getComputedStyle(np).transform).m42;
    const r = $('#artWrap').getBoundingClientRect();
    const scale = np.classList.contains('paused') ? PAUSED_SCALE : 1;
    const target = { getBoundingClientRect: () => new DOMRect(r.left + r.width * (1 - scale) / 2, r.top - offset + r.height * (1 - scale) / 2, r.width * scale, r.height * scale) };
    np.classList.add('flying');
    $('#miniArt').style.visibility = 'hidden';
    flyArt($('#miniArt'), target, { radiusFrom: 6, radiusTo: 12 * scale })?.then(() => {
      np.classList.remove('flying');
      $('#miniArt').style.visibility = '';
    });
  }
  np.classList.add('open');
  np.setAttribute('aria-hidden', 'false');
  refreshMarquees();
  renderQueue();
  startViz();
  setTimeout(placeYtDock, 450);
}

function closeNow() {
  const np = $('#nowPlaying');
  if (canFly() && np.classList.contains('open')) {
    np.classList.add('flying');
    $('#miniArt').style.visibility = 'hidden';
    flyArt($('#npArt'), $('#miniArt'), { radiusFrom: 12, radiusTo: 6, duration: 420 })?.then(() => {
      np.classList.remove('flying');
      $('#miniArt').style.visibility = '';
    });
  }
  np.classList.remove('open');
  np.setAttribute('aria-hidden', 'true');
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

// ---------- 指での操作 ----------
// 指の動きを追い、最初の数pxで縦横どちらの操作かを決める。onLock が false を返すとブラウザに任せる(スクロールなど)
function bindSwipe(el, { canStart, onLock, onMove, onEnd }) {
  let g = null;
  el.addEventListener('touchstart', (e) => {
    g = null;
    if (e.touches.length !== 1 || !canStart(e)) return;
    const t = e.touches[0];
    g = { x: t.clientX, y: t.clientY, dx: 0, dy: 0, axis: null, hist: [] };
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!g) return;
    const t = e.touches[0];
    g.dx = t.clientX - g.x;
    g.dy = t.clientY - g.y;
    if (!g.axis) {
      if (Math.hypot(g.dx, g.dy) < 10) return;
      g.axis = Math.abs(g.dx) > Math.abs(g.dy) ? 'x' : 'y';
      if (onLock(g) === false) { g = null; return; }
    }
    e.preventDefault();
    g.hist.push([e.timeStamp, g.dx, g.dy]);
    if (g.hist.length > 5) g.hist.shift();
    onMove(g);
  }, { passive: false });
  const finish = () => {
    const done = g;
    g = null;
    if (!done?.axis) return;
    const [t0, x0, y0] = done.hist[0] || [0, 0, 0];
    const [t1, x1, y1] = done.hist[done.hist.length - 1] || [0, 0, 0];
    const dt = Math.max(1, t1 - t0);
    done.vx = (x1 - x0) / dt;
    done.vy = (y1 - y0) / dt;
    onEnd(done);
  };
  el.addEventListener('touchend', finish);
  el.addEventListener('touchcancel', finish);
}

const SPRING = 'cubic-bezier(.3, 1.35, .5, 1)';

// 指に合わせて横に動かす
function slideEls(els, dx, fade = 300) {
  els.forEach((el) => {
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / fade));
  });
}

// 指を離した勢いを保ったまま流すための長さ(ms)。速く払うほど短い
const FLING_EASE = 'cubic-bezier(.2, .65, .3, 1)';
function flingDuration(remaining, v) {
  const speed = Math.max(Math.abs(v), 0.6);
  return Math.min(380, Math.max(180, (2.6 * Math.abs(remaining)) / speed));
}

// 指を離したとき: 足りなければバネで戻し、十分なら払った向きへそのまま流し、次の曲を反対側から入れる
function finishSlide(els, g, width, action) {
  const from = els.map((el) => ({ transform: el.style.transform || 'none', opacity: el.style.opacity || '1' }));
  els.forEach((el) => { el.style.transform = ''; el.style.opacity = ''; });
  const go = Math.abs(g.dx) > 80 || (Math.abs(g.vx) > 0.4 && Math.sign(g.vx) === Math.sign(g.dx));
  if (!go) {
    els.forEach((el, i) => el.animate([from[i], { transform: 'none', opacity: 1 }], { duration: 420, easing: SPRING }));
    return;
  }
  const dir = Math.sign(g.dx);
  const duration = flingDuration(width - Math.abs(g.dx), g.vx);
  trackSwiping = true;
  const outs = els.map((el, i) => el.animate([from[i], { transform: `translateX(${dir * width}px)`, opacity: 0 }],
    { duration, easing: FLING_EASE, fill: 'forwards' }));
  // 出ていく途中で次の曲を反対側から追いかけるように入れる
  setTimeout(() => {
    action();
    outs.forEach((a) => a.cancel());
    els.forEach((el) => el.animate([{ transform: `translateX(${-dir * width * 0.5}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 420, easing: EASE_OUT }));
    setTimeout(() => { trackSwiping = false; }, 100);
  }, duration * 0.6);
}

// 再生画面: 下に引くと閉じる(指に追従してバネで戻る)、左にスワイプで次の曲、右で前の曲
function bindSheetGestures() {
  const np = $('#nowPlaying');
  const moving = () => [$('#artWrap'), np.querySelector('.np-text')];
  bindSwipe(np, {
    canStart: (e) => !e.target.closest('input, .queue') && !trackSwiping,
    onLock: (g) => {
      if (g.axis === 'x') return;
      if (g.dy < 0 || np.scrollTop > 0) return false;
      np.classList.add('dragging');
    },
    onMove: (g) => {
      if (g.axis === 'x') slideEls(moving(), g.dx);
      else np.style.transform = `translateY(${Math.max(0, g.dy)}px)`;
    },
    onEnd: (g) => {
      if (g.axis === 'x') { finishSlide(moving(), g, np.clientWidth, g.dx < 0 ? () => player.next() : player.prev); return; }
      const close = g.dy > 140 || g.vy > 0.5;
      np.classList.remove('dragging');
      if (!close) {
        np.classList.add('settling');
        clearTimeout(np._settleTimer);
        np._settleTimer = setTimeout(() => np.classList.remove('settling'), 600);
      }
      np.style.transform = '';
      if (close) closeNow();
    },
  });
}

// ミニプレイヤー: 左にスワイプで次の曲、右で前の曲、上にスワイプで再生画面を開く
let miniSwiped = false;
function bindMiniGestures() {
  const mini = $('#miniPlayer');
  const body = $('#miniBody');
  bindSwipe(mini, {
    canStart: (e) => !e.target.closest('button') && !trackSwiping,
    onLock: (g) => {
      if (g.axis === 'y' && g.dy > 0) return false;
      miniSwiped = true;
    },
    onMove: (g) => {
      if (g.axis === 'x') slideEls([body], g.dx, 260);
      else mini.style.transform = `translateY(${Math.max(-70, g.dy * 0.6)}px)`;
    },
    onEnd: (g) => {
      setTimeout(() => { miniSwiped = false; }, 400);
      if (g.axis === 'x') { finishSlide([body], g, mini.clientWidth, g.dx < 0 ? () => player.next() : player.prev); return; }
      const from = mini.style.transform;
      mini.style.transform = '';
      if (g.dy < -30 || g.vy < -0.4) openNow();
      else mini.animate([{ transform: from }, { transform: 'none' }], { duration: 420, easing: SPRING });
    },
  });
}

// 画面を左右にスワイプしてタブを切り替える(左で右隣のタブへ)。隣のタブが指と一緒に横から見えてくる
const TAB_ORDER = ['library', 'playlists', 'sound', 'add'];
function neighborTab(dx) {
  if (view === 'playlist' && dx > 0) return 'playlists';
  const i = TAB_ORDER.indexOf(view === 'playlist' ? 'playlists' : view);
  return TAB_ORDER[i + (dx < 0 ? 1 : -1)] || null;
}

// 隣のタブを今の画面の横に並べる(今のスクロール位置に合わせて、切り替えたあと位置がずれないように)
function placePeer(name) {
  const cur = $(`#view-${view}`);
  const el = $(`#view-${name}`);
  renderView(name);
  el.classList.add('peer', 'swiped');
  el.classList.remove('hidden');
  Object.assign(el.style, { top: `${cur.offsetTop + window.scrollY}px`, left: `${cur.offsetLeft}px`, width: `${cur.offsetWidth}px` });
  return el;
}

function clearPeer(el) {
  el.classList.remove('peer');
  Object.assign(el.style, { top: '', left: '', width: '', transform: '' });
}

function bindTabSwipe() {
  const cur = () => $(`#view-${view}`);
  const W = () => window.innerWidth;
  // 曲が少なくて画面の下が空いていても効くように、画面全体で受ける
  bindSwipe(document.body, {
    canStart: (e) => !e.target.closest('input, textarea, .chips, .segmented, .mini, .tabbar, .sheet, .action-sheet, .yt-dock'),
    onLock: (g) => (g.axis === 'x' ? undefined : false),
    onMove: (g) => {
      const name = neighborTab(g.dx);
      if (g.peerName !== name) {
        if (g.peer) { clearPeer(g.peer); g.peer.classList.add('hidden'); }
        g.peerName = name;
        g.peer = name ? placePeer(name) : null;
      }
      // 隣のタブがない方向へは重たく少しだけ動く
      const dx = name ? g.dx : g.dx * 0.25;
      cur().style.transform = `translateX(${dx}px)`;
      if (g.peer) g.peer.style.transform = `translateX(${dx + (g.dx < 0 ? W() : -W())}px)`;
    },
    onEnd: (g) => {
      const el = cur();
      const peer = g.peer;
      const fromCur = el.style.transform || 'none';
      el.style.transform = '';
      if (!peer) { el.animate([{ transform: fromCur }, { transform: 'none' }], { duration: 420, easing: SPRING }); return; }
      const fromPeer = peer.style.transform;
      const side = g.dx < 0 ? W() : -W();
      const go = Math.abs(g.dx) > W() * 0.25 || (Math.abs(g.vx) > 0.4 && Math.sign(g.vx) === Math.sign(g.dx));
      if (!go) {
        const opt = { duration: 320, easing: EASE_OUT };
        el.animate([{ transform: fromCur }, { transform: 'none' }], opt);
        peer.animate([{ transform: fromPeer }, { transform: `translateX(${side}px)` }], { ...opt, fill: 'forwards' })
          .finished.then((a) => { a.cancel(); clearPeer(peer); peer.classList.add('hidden'); });
        return;
      }
      const opt = { duration: flingDuration(W() - Math.abs(g.dx), g.vx), easing: FLING_EASE, fill: 'forwards' };
      el.animate([{ transform: fromCur }, { transform: `translateX(${-side}px)` }], opt);
      peer.animate([{ transform: fromPeer }, { transform: 'none' }], opt).finished.then(() => {
        clearPeer(peer);
        switchTab(g.peerName, { swiped: true });
        el.getAnimations().forEach((a) => a.cancel());
        peer.getAnimations().forEach((a) => a.cancel());
      });
    },
  });
}

// ---------- イベント ----------
function bind() {
  bindSound();
  bindSync();
  document.querySelectorAll('.tabbar button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  $('#backBtn').onclick = () => switchTab('playlists');
  $('#searchInput').addEventListener('input', renderLibrary);
  // YouTubeの曲を除くかどうかは次に開いたときも覚えておく
  const hideYt = $('#hideYoutube');
  try { hideYt.checked = localStorage.getItem('oto.hideYoutube') === '1'; } catch { /* 無視 */ }
  hideYt.addEventListener('change', () => {
    try { localStorage.setItem('oto.hideYoutube', hideYt.checked ? '1' : '0'); } catch { /* 無視 */ }
    renderLibrary();
    staggerIn($('#libraryList').children);
  });
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
    if (miniSwiped) { miniSwiped = false; return; }
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

  bindSheetGestures();
  bindMiniGestures();
  bindTabSwipe();

  window.addEventListener('resize', () => { placeYtDock(); refreshMarquees(); });
  $('#nowPlaying').addEventListener('scroll', placeYtDock, { passive: true });

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
    $('#miniProgressBar').style.transform = `scaleX(${pct / 100})`;
    if (!seeking) {
      $('#seekBar').value = dur ? Math.round((cur / dur) * 1000) : 0;
      $('#curTime').textContent = fmt(cur);
    }
    $('#durTime').textContent = fmt(dur);
  });
}

// ---------- アプリの更新 ----------
// sw.js の CACHE の番号と合わせる
const APP_VERSION = 29;

// 新しい版が公開されたら取り込み、再生していなければその場で読み込み直す
function registerUpdates() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  const sw = navigator.serviceWorker;
  const hadController = !!sw.controller;
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    if (player.state.playing) { toast('新しいバージョンがあります。次に開いたときに反映されます'); return; }
    reloading = true;
    location.reload();
  });
  sw.register('sw.js').then((reg) => {
    // ホーム画面のアプリは閉じても裏で残るので、画面に戻ってきたときにも更新を確かめる
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
}

async function init() {
  bind();
  renderControls();
  renderSound();
  await loadAll();
  restoreSession();
  show('library');
  sync.schedule(500);
  $('#appVersion').textContent = `oto バージョン ${APP_VERSION}`;
  registerUpdates();
}

init();
