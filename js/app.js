import * as db from './db.js';
import * as player from './player.js';
import { readTags } from './tags.js';
import * as fx from './fx.js';
import * as sync from './sync.js';
import { YT_API_ENDPOINT } from './config.js';

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
let openPlaylistId = null;  // プレイリスト詳細の画面で開いている一覧(プレイリストのID、または @fav・@artist:名前 など)
let listFrom = 'playlists'; // その一覧をどのタブから開いたか(戻る先)
let libMode = 'songs';      // ライブラリの表示: songs | artists | albums
try { libMode = localStorage.getItem('oto.libMode') || 'songs'; } catch { /* 無視 */ }
// 「元に戻す」を押せる間は、削除した曲・プレイリストを画面にだけ出さないでおく
const hiddenTracks = new Set();
const hiddenPlaylists = new Set();

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
    ], { duration: 420, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' }).finished.catch(() => { });
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
  return anim.finished.catch(() => { }).then(() => img.remove());
}

// ---------- ごほうびアニメーション(達成した瞬間の演出) ----------
const SPARK_COLORS = ['#ff5a5f', '#ffd166', '#5ad1ff'];

// origin の中心から、きらめきが弾ける(動きを減らす設定では出さない)
// ring/vibrate ありの大きめの演出は「達成」した瞬間に、なしの軽い演出はよく使う操作のたびに使う
function spawnBurst(origin, { ring = true, count = 10, vibrate = true, colors = SPARK_COLORS } = {}) {
  if (REDUCED || !origin) return;
  const r = origin.getBoundingClientRect();
  if (!r.width && !r.height) return;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;

  const box = document.createElement('div');
  box.className = 'celebrate-burst';
  box.style.left = `${cx}px`;
  box.style.top = `${cy}px`;
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span');
    s.className = 'spark';
    const a = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4;
    const d = (ring ? 30 : 20) + Math.random() * (ring ? 28 : 16);
    s.style.setProperty('--tx', `${Math.cos(a) * d}px`);
    s.style.setProperty('--ty', `${Math.sin(a) * d}px`);
    s.style.setProperty('--spark-color', colors[i % colors.length]);
    s.style.animationDelay = `${Math.random() * 60}ms`;
    box.appendChild(s);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 900);

  if (ring) {
    const el = document.createElement('div');
    el.className = 'celebrate-ring';
    const size = Math.max(r.width, r.height, 40) * 1.4;
    Object.assign(el.style, { left: `${cx - size / 2}px`, top: `${cy - size / 2}px`, width: `${size}px`, height: `${size}px` });
    document.body.append(el);
    setTimeout(() => el.remove(), 650);
  }

  // 一度も画面に触れていないうちは、ブラウザが振動を止めて警告を出すので鳴らさない
  if (vibrate && navigator.vibrate && navigator.userActivation?.hasBeenActive !== false) {
    try { navigator.vibrate(12); } catch { /* 無視 */ }
  }
}

// よく使うボタン・切り替え用の軽いきらめき(輪や振動なし)
const spark = (origin) => spawnBurst(origin, { ring: false, count: 6, vibrate: false });

// 再生ボタンが光って弾む(再生し始めた瞬間だけ)
function glowPulse(el) {
  if (REDUCED || !el) return;
  el.classList.remove('glow');
  requestAnimationFrame(() => {
    el.classList.add('glow');
    setTimeout(() => el.classList.remove('glow'), 600);
  });
}

let toastTimer;
function toast(msg, { celebrate = false, action = null, duration = 2600 } = {}) {
  const el = $('#toast');
  el.textContent = '';
  const text = document.createElement('span');
  text.textContent = msg;
  el.append(text);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => { clearTimeout(toastTimer); hideAnimated(el); action.run(); };
    el.append(b);
  }
  el.classList.toggle('celebrate', celebrate);
  el.classList.toggle('has-action', !!action);
  showEl(el);
  if (celebrate) spawnBurst(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideAnimated(el), duration);
}

// 削除は確かめずにすぐ画面から消し、トーストの「元に戻す」で取り消せるようにする。
// 本当に消すのは数秒後(アプリを離れるときは、その場で)
const UNDO_MS = 5000;
const pendingCommits = new Set();
function withUndo(message, { commit, undo }) {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    pendingCommits.delete(finish);
    Promise.resolve(commit()).catch((e) => console.error(e));
  };
  const timer = setTimeout(finish, UNDO_MS);
  pendingCommits.add(finish);
  toast(message, {
    duration: UNDO_MS,
    action: {
      label: '元に戻す',
      run: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingCommits.delete(finish);
        Promise.resolve(undo()).catch((e) => console.error(e));
      },
    },
  });
}
const commitPending = () => [...pendingCommits].forEach((f) => f());

function withArt(t) {
  if (t.picture && !t.artUrl) t.artUrl = URL.createObjectURL(t.picture);
  else if (t.ytId && !t.artUrl) t.artUrl = `https://i.ytimg.com/vi/${t.ytId}/hqdefault.jpg`;
  return t;
}

function actionSheet(title, items) {
  const sheet = $('#actionSheet');
  $('#actionTitle').textContent = title;
  const box = $('#actionItems');
  box.innerHTML = '';
  items.forEach((it) => {
    // info: 押せない説明の行(キーボード操作の一覧など)
    if (it.info) {
      const row = document.createElement('div');
      row.className = 'action-item info';
      const k = document.createElement('kbd');
      k.textContent = it.key;
      const d = document.createElement('span');
      d.textContent = it.label;
      row.append(k, d);
      box.appendChild(row);
      return;
    }
    const b = document.createElement('button');
    b.className = 'action-item' + (it.danger ? ' danger' : '') + (it.on ? ' on' : '');
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
  tracks = (await db.getAllTracks()).filter((t) => !hiddenTracks.has(t.id)).map(withArt).sort((a, b) => b.addedAt - a.addedAt);
  byId = new Map(tracks.map((t) => [t.id, t]));
  playlists = (await db.getAllPlaylists()).filter((p) => !hiddenPlaylists.has(p.id)).sort((a, b) => a.createdAt - b.createdAt);
}

// ---------- 描画 ----------
const SVG_MORE = '<svg viewBox="0 0 24 24"><circle class="fill" cx="5" cy="12" r="1.8"/><circle class="fill" cx="12" cy="12" r="1.8"/><circle class="fill" cx="19" cy="12" r="1.8"/></svg>';
const SVG_HANDLE = '<svg viewBox="0 0 24 24"><path d="M5 9h14M5 15h14"/></svg>';
const SVG_REMOVE = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>';
const SVG_HEART = '<svg viewBox="0 0 24 24"><path d="M12 20.5s-7-4.4-9.2-8.7C1.3 8.6 3.2 5 6.6 5c2.1 0 3.8 1.2 5.4 3.2C13.6 6.2 15.3 5 17.4 5c3.4 0 5.3 3.6 3.8 6.8C19 16.1 12 20.5 12 20.5z"/></svg>';
const SVG_CLOUD = '<svg viewBox="0 0 24 24"><path d="M7 18h10.5a4 4 0 00.6-8 6 6 0 00-11.4 1.6A3.3 3.3 0 007 18z"/></svg>';
const SVG_CLOCK = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
const SVG_FLAME = '<svg viewBox="0 0 24 24"><path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.4-5.4 3.6-8.3.4 1.6 1.4 2.6 2.4 3.1.3-2.6 1.7-4.8 3.5-6.1-.2 2.9 3.5 5.4 3.5 10 0 4.2-2.7 7.5-6.5 7.5z"/></svg>';

// t: 曲 / index: 一覧の中の位置 / onTap: 行を押したとき / menu: 「…」メニュー / handle: 並べ替えのつまみ / onRemove: 「×」ボタン
function trackRow(t, { index, onTap, menu = true, handle = false, onRemove = null } = {}) {
  const li = document.createElement('li');
  li.className = 'track' + (player.current()?.id === t.id ? ' playing' : '');
  li.dataset.id = t.id;
  li.tabIndex = 0;
  const marks = (t.favorite ? `<span class="row-mark fav" aria-label="お気に入り">${SVG_HEART}</span>` : '') +
    (t.offloaded ? `<span class="row-mark" aria-label="ドライブにだけ保存">${SVG_CLOUD}</span>` : '');
  li.innerHTML = `
    <img class="art-sm" src="${esc(t.artUrl || ICON_NOTE)}" alt="" loading="lazy">
    <div class="meta">
      <div class="title">${esc(t.title)}</div>
      <div class="sub">${marks}${esc([t.artist, t.duration ? fmt(t.duration) : ''].filter(Boolean).join(' ・ '))}</div>
    </div>
    ${onRemove ? `<button class="icon-btn row-remove" aria-label="キューから外す">${SVG_REMOVE}</button>` : ''}
    ${menu ? `<button class="icon-btn more" aria-label="メニュー">${SVG_MORE}</button>` : ''}
    ${handle ? `<button class="icon-btn drag-handle" aria-label="並べ替え(↑↓キーで移動)">${SVG_HANDLE}</button>` : ''}`;
  li.addEventListener('click', (e) => {
    if (e.target.closest('.drag-handle')) return;
    if (e.target.closest('.row-remove')) { onRemove(li); return; }
    if (e.target.closest('.more')) { trackMenu(t); return; }
    onTap?.(index);
  });
  li.addEventListener('keydown', (e) => {
    if (e.target !== li || (e.key !== 'Enter' && e.key !== ' ') || !li.matches(':focus-visible')) return;
    e.preventDefault();
    onTap?.(index);
  });
  return li;
}

// プレイリスト・アーティストなどの一覧の行
function groupRow({ name, sub, art, artHtml, onOpen }) {
  const li = document.createElement('li');
  li.className = 'playlist-item';
  li.tabIndex = 0;
  const pic = artHtml || `<img class="art-sm" src="${esc(art || ICON_NOTE)}" alt="" loading="lazy">`;
  li.innerHTML = `${pic}
    <div class="meta">
      <div class="title">${esc(name)}</div>
      <div class="sub">${esc(sub)}</div>
    </div>`;
  li.onclick = onOpen;
  li.onkeydown = (e) => {
    if (e.target !== li || (e.key !== 'Enter' && e.key !== ' ') || !li.matches(':focus-visible')) return;
    e.preventDefault();
    onOpen();
  };
  return li;
}

const searchQuery = () => $('#searchInput').value.trim().toLowerCase();
const matches = (t, q) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q);

function filteredTracks() {
  const q = searchQuery();
  return tracks.filter((t) => matches(t, q));
}

const UNKNOWN_ARTIST = '不明なアーティスト';

// アーティスト・アルバムごとにまとめる(ライブラリの並び=追加日の新しい順のまま)
function groupBy(keyOf) {
  const map = new Map();
  for (const t of tracks) {
    const k = keyOf(t);
    if (k === null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return [...map].sort(([a], [b]) => (a === '') - (b === '') || a.localeCompare(b, 'ja'));
}

function renderLibrary() {
  const list = $('#libraryList');
  list.innerHTML = '';
  document.querySelectorAll('#libMode button').forEach((b) => {
    const on = b.dataset.mode === libMode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on);
  });
  $('#libMode').classList.toggle('hidden', !tracks.length);
  $('#libraryEmpty').classList.toggle('hidden', tracks.length > 0);
  const q = searchQuery();
  let count = 0;
  if (libMode === 'songs') {
    const items = filteredTracks();
    items.forEach((t, i) => list.appendChild(trackRow(t, { index: i, onTap: (idx) => player.playList(items, idx) })));
    count = items.length;
  } else {
    const artists = libMode === 'artists';
    const groups = groupBy(artists ? (t) => t.artist || '' : (t) => t.album || null);
    for (const [key, items] of groups) {
      const name = key || UNKNOWN_ARTIST;
      if (q && !name.toLowerCase().includes(q) && !items.some((t) => matches(t, q))) continue;
      const by = new Set(items.map((t) => t.artist || ''));
      const sub = artists ? `${items.length}曲` : `${by.size > 1 ? 'さまざまなアーティスト' : (items[0].artist || UNKNOWN_ARTIST)} ・ ${items.length}曲`;
      const id = artists ? `@artist:${key}` : `@album:${key}`;
      list.appendChild(groupRow({ name, sub, art: items.find((t) => t.artUrl)?.artUrl, onOpen: () => openList(id, 'library') }));
      count++;
    }
    if (!artists && !groups.length && tracks.length) {
      list.innerHTML = '<li class="empty small">アルバムの情報がある曲はまだありません。MP3などのタグにアルバム名があると、ここにまとまります。</li>';
      return;
    }
  }
  if (tracks.length && !count) list.innerHTML = '<li class="empty small">条件に合う曲はありません</li>';
}

// 自動でできる一覧(お気に入り・最近再生した曲・よく聴く曲)
const SMART = {
  '@fav': {
    name: 'お気に入り',
    icon: SVG_HEART,
    tracks: () => tracks.filter((t) => t.favorite).sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0)),
    empty: '再生画面のハートか、曲の「…」メニューからお気に入りに追加できます。',
    always: true,
  },
  '@recent': {
    name: '最近再生した曲',
    icon: SVG_CLOCK,
    tracks: () => tracks.filter((t) => t.lastPlayedAt).sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, 50),
  },
  '@top': {
    name: 'よく聴く曲',
    icon: SVG_FLAME,
    tracks: () => tracks.filter((t) => t.plays > 0).sort((a, b) => b.plays - a.plays || b.lastPlayedAt - a.lastPlayedAt).slice(0, 50),
    sub: (t) => `${t.plays}回`,
  },
};

// 一覧のIDから、名前と曲を求める
function listInfo(id) {
  if (!id) return null;
  if (SMART[id]) return SMART[id];
  if (id.startsWith('@artist:')) {
    const key = id.slice(8);
    return { name: key || UNKNOWN_ARTIST, tracks: () => tracks.filter((t) => (t.artist || '') === key) };
  }
  if (id.startsWith('@album:')) {
    const key = id.slice(7);
    // アルバムは取り込んだ順(=ファイルの並び順になっていることが多い)
    return { name: key, tracks: () => tracks.filter((t) => t.album === key).sort((a, b) => a.addedAt - b.addedAt) };
  }
  const pl = playlists.find((p) => p.id === id);
  return pl && { name: pl.name, tracks: () => playlistTracks(pl), playlist: pl };
}

const currentListTracks = () => listInfo(openPlaylistId)?.tracks() || [];

function renderPlaylists() {
  const smart = $('#smartList');
  smart.innerHTML = '';
  for (const [id, s] of Object.entries(SMART)) {
    const n = s.tracks().length;
    if (!n && !s.always) continue;
    smart.appendChild(groupRow({
      name: s.name,
      sub: `${n}曲`,
      artHtml: `<span class="art-sm smart-art ${id.slice(1)}">${s.icon}</span>`,
      onOpen: () => openList(id, 'playlists'),
    }));
  }
  const list = $('#playlistList');
  list.innerHTML = '';
  playlists.forEach((pl) => {
    const items = playlistTracks(pl);
    list.appendChild(groupRow({ name: pl.name, sub: `${items.length}曲`, art: items.find((t) => t.artUrl)?.artUrl, onOpen: () => openList(pl.id, 'playlists') }));
  });
  $('#playlistEmpty').classList.toggle('hidden', playlists.length > 0);
  renderSummary();
}

function playlistTracks(pl) {
  return pl.trackIds.map((id) => byId.get(id)).filter(Boolean);
}

function totalTime(items) {
  const min = Math.round(items.reduce((s, t) => s + (t.duration || 0), 0) / 60);
  if (!min) return '1分未満';
  return min >= 60 ? `${Math.floor(min / 60)}時間${min % 60}分` : `${min}分`;
}

function renderPlaylist() {
  const info = listInfo(openPlaylistId);
  if (!info) { switchTab(listFrom); return; }
  $('#viewTitle').textContent = info.name;
  const items = info.tracks();
  const list = $('#playlistTracks');
  list.innerHTML = '';
  items.forEach((t, i) => {
    const li = trackRow(t, { index: i, onTap: (idx) => player.playList(items, idx), handle: !!info.playlist && items.length > 1 });
    if (info.sub) li.querySelector('.sub').insertAdjacentHTML('beforeend', ` ・ ${esc(info.sub(t))}`);
    list.appendChild(li);
  });
  $('#plInfo').textContent = items.length ? `${items.length}曲 ・ ${totalTime(items)}` : '';
  $('#plMenuBtn').classList.toggle('hidden', !info.playlist);
  const empty = $('#playlistTracksEmpty');
  empty.textContent = info.empty || (info.playlist ? '曲の「…」メニューから、このプレイリストに追加できます。' : '曲はありません。');
  empty.classList.toggle('hidden', items.length > 0);
}

// プレイリストの曲を並べ替える(表示している並びの from 番目を to 番目へ)
function movePlaylistTrack(from, to) {
  const info = listInfo(openPlaylistId);
  const pl = info?.playlist;
  if (!pl) return;
  const ids = info.tracks().map((t) => t.id);
  const [id] = ids.splice(from, 1);
  ids.splice(to, 0, id);
  // ライブラリにない曲のIDが残っていたら、消さずに後ろに付けておく
  pl.trackIds = [...ids, ...pl.trackIds.filter((x) => !ids.includes(x))];
  renderPlaylist();
  db.putPlaylist(pl);
}

function renderQueue() {
  const { queue, index } = player.state;
  const list = $('#queueList');
  list.innerHTML = '';
  const upcoming = queue.slice(index + 1);
  upcoming.forEach((t, i) => {
    const at = index + 1 + i;
    list.appendChild(trackRow(t, {
      index: at,
      onTap: (idx) => player.jumpTo(idx),
      menu: false,
      handle: upcoming.length > 1,
      onRemove: async (li) => {
        await collapseRows([li]);
        // 縮めている間にキューが変わっていても、押した曲を外す
        const i = player.state.queue.indexOf(t, player.state.index + 1);
        if (i > 0) player.removeAt(i);
      },
    }));
  });
  if (!list.children.length) list.innerHTML = '<li class="empty small">次の曲はありません</li>';
}

let shownTrackId = null;
let trackSwiping = false; // スワイプで曲を切り替えている最中

function renderNow() {
  const t = player.current();
  $('#miniPlayer').classList.toggle('hidden', !t);
  document.body.classList.toggle('has-mini', !!t);
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
  const fav = !!(byId.get(t.id) || t).favorite;
  $('#favBtn').classList.toggle('on', fav);
  $('#favBtn').setAttribute('aria-pressed', fav);
  $('#favBtn').setAttribute('aria-label', fav ? 'お気に入りから外す' : 'お気に入りに追加');
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
    if (playing) glowPulse(b);
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
  if (swiped) { renderNow(); if (v === 'playlists') countUp($('#monthSummary')); return; }
  if (v === 'add') { updateStorageInfo(); renderSync(); }
  if (v === 'sound') renderSound();
  rerender();
  if (v === 'library') staggerIn($('#libraryList').children);
  else if (v === 'playlists') {
    staggerIn([$('#monthSummary'), ...$('#smartList').children, ...$('#playlistList').children].filter((x) => !x.classList.contains('hidden')));
    countUp($('#monthSummary'));
  } else if (v === 'playlist') staggerIn($('#playlistTracks').children);
  else staggerIn(el.querySelectorAll(':scope > .card'));
}

function switchTab(tab, opts) {
  // スワイプで来たときは、下のアイコンを弾ませず色だけ変える
  $('.tabbar').classList.toggle('swiped', !!opts?.swiped);
  if (!opts?.swiped) $('.tabbar').style.removeProperty('--tab-fade');
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  show(tab, opts);
}

function openList(id, from = 'playlists') {
  openPlaylistId = id;
  listFrom = from;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === from));
  show('playlist');
}

// ---------- 曲・プレイリスト操作 ----------
function trackMenu(t) {
  const items = [
    { label: '次に再生', run: () => { player.playNext(t); toast('次に再生します'); } },
    { label: t.favorite ? 'お気に入りから外す' : 'お気に入りに追加', run: () => toggleFavorite(t) },
    { label: 'プレイリストに追加…', run: () => addToPlaylistMenu(t) },
    { label: '曲名・アーティストを編集', run: () => editTrack(t) },
  ];
  if (view === 'playlist' && listInfo(openPlaylistId)?.playlist) {
    items.push({ label: 'このプレイリストから外す', run: () => removeFromPlaylist(openPlaylistId, t.id) });
  }
  if (t.artist && openPlaylistId !== `@artist:${t.artist}`) {
    items.push({ label: `「${t.artist}」の曲を見る`, run: () => openList(`@artist:${t.artist}`, 'library') });
  }
  if (t.ytId) {
    items.push({ label: 'YouTubeで開く', run: () => window.open(`https://www.youtube.com/watch?v=${t.ytId}`, '_blank') });
  }
  // ドライブに保存済みの曲は、この端末から音声だけ消して容量を空けられる
  if (t.type === 'file' && t.driveId && sync.state.enabled) {
    if (t.offloaded) items.push({ label: 'この端末に保存し直す', run: () => restoreToDevice(t) });
    else items.push({ label: 'この端末から音声を消す(ドライブに残す)', run: () => offloadTrack(t) });
  }
  items.push({ label: 'ライブラリから削除', danger: true, run: () => removeTrack(t) });
  actionSheet(t.title, items);
}

// ---------- お気に入り ----------
const HEART_COLORS = ['#ff5a5f', '#ff8fab', '#ffd166'];

async function toggleFavorite(t, origin = null) {
  const rec = byId.get(t.id) || t;
  const on = !rec.favorite;
  for (const x of new Set([rec, t])) { x.favorite = on; x.favoritedAt = on ? Date.now() : 0; }
  renderNow();
  rerender();
  // 再生画面のハートは弾ませ、そこからハート色のきらめきを出す。ほかの場所ではトーストから出す
  const btn = $('#favBtn');
  const onSheet = $('#nowPlaying').classList.contains('open') && player.current()?.id === t.id;
  if (on && onSheet) {
    btn.classList.remove('pop');
    void btn.offsetWidth;
    btn.classList.add('pop');
  }
  const from = origin || (onSheet ? btn : null);
  if (on && from) {
    spawnBurst(from, { count: 12, colors: HEART_COLORS });
    toast('お気に入りに追加しました');
  } else {
    toast(on ? 'お気に入りに追加しました' : 'お気に入りから外しました', { celebrate: on });
  }
  await saveTrackMeta(rec);
}

// ---------- この端末から音声だけを消す(ドライブには残す) ----------
const mbText = (b) => `${(b / 1024 / 1024).toFixed(b >= 100 * 1024 * 1024 ? 0 : 1)}MB`;

async function offloadTrack(t) {
  const rec = byId.get(t.id) || t;
  if (player.current()?.id === t.id) { toast('再生中の曲は消せません。ほかの曲に切り替えてからもう一度お試しください'); return; }
  const blob = await db.getBlob(t.id);
  await db.deleteBlob(t.id);
  for (const x of new Set([rec, t])) x.offloaded = true;
  await saveTrackMeta(rec, { touch: false });
  rerender();
  toast(`この端末の容量を${mbText(blob?.size || t.size || 0)}空けました。再生するときはドライブから読み込みます`, { celebrate: true, duration: 4000 });
  updateStorageInfo();
}

async function downloadToDevice(t) {
  const rec = byId.get(t.id) || t;
  const blob = await sync.fetchTrack(t);
  for (const x of new Set([rec, t])) x.offloaded = false;
  const { artUrl, ...data } = rec;
  await db.putTrack(data, blob, { touch: false });
  return blob;
}

async function restoreToDevice(t) {
  toast('ドライブから読み込み中…', { duration: 60000 });
  try {
    await downloadToDevice(t);
    toast(`「${t.title}」をこの端末に保存しました`, { celebrate: true });
    rerender();
    updateStorageInfo();
  } catch (e) {
    toast(e.message);
  }
}

function addToPlaylistMenu(t) {
  const items = playlists.map((pl) => ({
    label: pl.name + (pl.trackIds.includes(t.id) ? '(追加済み)' : ''),
    run: async () => {
      if (!pl.trackIds.includes(t.id)) {
        pl.trackIds.push(t.id);
        await db.putPlaylist(pl);
      }
      toast(`「${pl.name}」に追加しました`, { celebrate: true });
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
        toast(`「${pl.name}」に追加しました`, { celebrate: true });
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
  const at = pl.trackIds.indexOf(trackId);
  await collapseRows(document.querySelectorAll(`#playlistTracks .track[data-id="${CSS.escape(trackId)}"]`));
  pl.trackIds = pl.trackIds.filter((id) => id !== trackId);
  await db.putPlaylist(pl);
  rerender();
  withUndo(`「${pl.name}」から外しました`, {
    commit: () => { },
    undo: async () => {
      const p = playlists.find((x) => x.id === plId);
      if (!p || p.trackIds.includes(trackId)) return;
      p.trackIds.splice(Math.min(at, p.trackIds.length), 0, trackId);
      await db.putPlaylist(p);
      rerender();
    },
  });
}

async function editTrack(t) {
  const r = await dialog({ title: '曲の情報を編集', fields: [{ label: '曲名', value: t.title }, { label: 'アーティスト', value: t.artist || '' }], ok: '保存' });
  if (!r) return;
  const [title, artist] = r;
  t.title = title.trim() || t.title;
  t.artist = artist.trim();
  t.titlePending = false;
  await saveTrackMeta(t);
  toast('曲の情報を保存しました', { celebrate: true });
  rerender();
  player.refreshMeta();
}

async function saveTrackMeta(t, { touch = true } = {}) {
  const { artUrl, ...rec } = t;
  await db.updateTrack(rec, { touch });
  t.updatedAt = rec.updatedAt;
}

async function removeTrack(t) {
  await collapseRows(document.querySelectorAll(`main .track[data-id="${CSS.escape(t.id)}"]`));
  hiddenTracks.add(t.id);
  player.removeFromQueue(t.id);
  tracks = tracks.filter((x) => x.id !== t.id);
  byId.delete(t.id);
  rerender();
  withUndo(`「${t.title}」を削除しました`, {
    commit: async () => {
      await db.deleteTrack(t.id);
      hiddenTracks.delete(t.id);
      if (t.artUrl?.startsWith('blob:')) URL.revokeObjectURL(t.artUrl);
      await loadAll();
      rerender();
      if (view === 'add') updateStorageInfo();
    },
    undo: async () => {
      hiddenTracks.delete(t.id);
      await loadAll();
      rerender();
    },
  });
}

function playlistMenu() {
  const pl = listInfo(openPlaylistId)?.playlist;
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
      run: () => {
        hiddenPlaylists.add(pl.id);
        playlists = playlists.filter((p) => p.id !== pl.id);
        switchTab('playlists');
        withUndo(`「${pl.name}」を削除しました(曲はライブラリに残ります)`, {
          commit: async () => {
            await db.deletePlaylist(pl.id);
            hiddenPlaylists.delete(pl.id);
          },
          undo: async () => {
            hiddenPlaylists.delete(pl.id);
            await loadAll();
            rerender();
          },
        });
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
  if (ok > 0) toast(`${ok}曲をライブラリに追加しました`, { celebrate: true });
  await loadAll();
  updateStorageInfo();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => { });
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

async function fetchYtThumbnail(id) {
  try {
    const res = await fetch(`${YT_API_ENDPOINT}?thumb=${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

async function addYouTube(e) {
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

  e.preventDefault();
  if (ytAbort) return;
  const input = $('#ytInput');
  const status = $('#ytStatus');
  const submitBtn = $('#ytSubmitBtn');
  const cancelBtn = $('#ytCancelBtn');
  const rawUrl = input.value.trim();
  const id = parseYouTubeId(rawUrl);

  if (!id) { status.textContent = 'YouTubeの動画URLを入力してください'; return; }
  if (tracks.some((t) => t.ytId === id)) { status.textContent = 'この動画はすでに追加されています'; return; }

  const abort = new AbortController();
  ytAbort = abort;
  input.disabled = true;
  submitBtn.disabled = true;
  cancelBtn.classList.remove('hidden');
  $('.tabbar button[data-tab="add"]').classList.add('busy');
  setYtProgress(null);
  status.textContent = 'サーバーに接続中…';
  // サーバーは YouTube から音声を取り終えてから送り始めるので、それまでは待ち時間の目安を出す
  const slow = setTimeout(() => {
    status.textContent = 'サーバーで音声を準備中…(サーバーが止まっていたときは、起動に1分ほどかかります)';
  }, 6000);

  try {
    const res = await fetch(YT_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: rawUrl, id }),
      signal: abort.signal,
    });
    clearTimeout(slow);

    if (!res.ok) {
      let errMsg = `取り込みに失敗しました (${res.status})`;
      try {
        const j = await res.json();
        if (j?.error) errMsg = j.error;
      } catch { /* JSONでない場合 */ }
      throw new Error(errMsg);
    }

    // ストリームを受信しつつ進捗を表示
    const total = Number(res.headers.get('Content-Length')) || 0;
    const mime = res.headers.get('Content-Type') || 'audio/mp4';
    const ext = res.headers.get('X-Track-Ext') || (mime.includes('mp4') ? 'm4a' : 'webm');

    let audioBlob;
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        if (total > 0) {
          const pct = Math.min(99, Math.round((received / total) * 100));
          setYtProgress(pct);
          status.textContent = `音声を受信中… ${pct}%(${mbText(received)} / ${mbText(total)})`;
        } else {
          status.textContent = `音声を受信中… ${mbText(received)}`;
        }
      }
      audioBlob = new Blob(chunks, { type: mime });
    } else {
      audioBlob = await res.blob();
    }

    if (!audioBlob.size) throw new Error('音声データが空でした');

    // ここから先は取り消せないので、キャンセルボタンは隠す
    cancelBtn.classList.add('hidden');
    setYtProgress(null);
    status.textContent = '曲情報を保存中…';
    const decodeHeader = (name) => {
      const v = res.headers.get(name);
      if (!v) return '';
      try { return decodeURIComponent(v); } catch { return v; }
    };

    let title = decodeHeader('X-Track-Title');
    let artist = decodeHeader('X-Track-Artist');
    let duration = Number(res.headers.get('X-Track-Duration')) || 0;

    if (!title) {
      const info = await fetchYtTitle(id);
      title = info?.title || `YouTube動画 (${id})`;
      artist = artist || info?.artist || '';
    }

    const safeName = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || id;
    const fileName = `${safeName}.${ext}`;
    const file = new File([audioBlob], fileName, { type: mime });

    const [picture, tags] = await Promise.all([
      fetchYtThumbnail(id),
      duration ? Promise.resolve(null) : readTags(file).catch(() => null),
    ]);
    if (!duration && tags?.duration) duration = tags.duration;

    const track = {
      id: db.uid(),
      type: 'file',
      ytId: id,
      title,
      artist,
      album: '',
      picture: picture || tags?.picture || null,
      duration,
      size: file.size,
      addedAt: Date.now(),
      fileName,
      mime,
    };

    await db.putTrack(track, file);
    input.value = '';
    setYtProgress(100);
    $('#ytProgress').classList.add('done');
    status.textContent = `「${track.title}」を音声ファイルとして取り込みました`;
    toast(`「${track.title}」を取り込みました`, { celebrate: true });
    await loadAll();
    rerender();
    updateStorageInfo();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => { });
    setTimeout(() => { if (!ytAbort) hideAnimated($('#ytProgress')); }, 1200);
  } catch (err) {
    clearTimeout(slow);
    $('#ytProgress').classList.add('hidden');
    if (abort.signal.aborted) {
      status.textContent = '取り込みをキャンセルしました';
    } else {
      console.error(err);
      // 通信そのものに失敗したとき(圏外・サーバーに届かない)は、ブラウザの英語のメッセージを出さない
      const msg = err instanceof TypeError ? '取り込み用サーバーにつながりませんでした。通信状況を確かめて、もう一度お試しください' : (err.message || '取り込みに失敗しました');
      status.textContent = msg;
      toast(msg);
    }
  } finally {
    ytAbort = null;
    input.disabled = false;
    submitBtn.disabled = false;
    cancelBtn.classList.add('hidden');
    $('.tabbar button[data-tab="add"]').classList.remove('busy');
  }
}

let ytAbort = null; // 取り込み中なら、そのキャンセル用

// 取り込みのプログレスバー。pct が null のときは、終わりが分からない動き(行ったり来たり)にする
function setYtProgress(pct) {
  const bar = $('#ytProgress');
  showEl(bar);
  bar.classList.remove('done');
  bar.classList.toggle('indeterminate', pct === null);
  if (pct === null) {
    bar.removeAttribute('aria-valuenow');
  } else {
    bar.style.setProperty('--p', pct / 100);
    bar.setAttribute('aria-valuenow', pct);
  }
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
  $('#fxKeepPitch').checked = s.keepPitch !== false;
  document.querySelectorAll('#fxVibes .chip').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.speed) === Number(s.speed) &&
      (b.dataset.keep === '1') === (s.keepPitch !== false) && Number(b.dataset.reverb) === s.reverb);
  });
  $('#fxWidth').value = s.width;
  $('#fxWidthVal').textContent = s.width ? `${s.width}%` : 'オフ';
  $('#fxRotation').value = s.rotation;
  $('#fxRotationVal').textContent = `${s.rotation}秒`;
  $('#fxRotationRow').classList.toggle('hidden', s.spatial !== '8d');
  $('#fxSpatialAmountRow').classList.toggle('hidden', s.spatial === 'off');
  $('#fxSpatialAmount').value = s.spatialAmount;
  $('#fxSpatialAmountVal').textContent = `${s.spatialAmount}%`;
  document.querySelectorAll('#fxSpatial button').forEach((b) => {
    const on = b.dataset.mode === s.spatial;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  });
  $('#fxSpatialHelp').textContent = {
    off: '立体音響を使いません。',
    '8d': '音が頭のまわりを回るように聞こえます。後ろを通るときは、後ろから聞こえるように再現します。',
    surround: '部屋に置いたスピーカーに囲まれて聴いているように、音が頭の外から聞こえます。耳が疲れにくくなります。',
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
    b.onclick = () => { spark(b); fx.update({ preset: key, eq: p.eq.slice() }); renderSound(); };
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
      row.innerHTML = `<span>${band.label}</span><input id="fxEq${i}" type="range" min="${-fx.EQ_RANGE}" max="${fx.EQ_RANGE}" step="1" aria-label="${band.label}"><span id="fxEqVal${i}"></span>`;
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
  const flag = (id, key) => $(id).addEventListener('change', (e) => {
    if (e.target.checked) spark(e.target);
    fx.update({ [key]: e.target.checked });
    renderSound();
  });
  num('#fxVolume', 'volume');
  num('#npVolume', 'volume');
  num('#fxCrossfade', 'crossfade');
  num('#fxReverb', 'reverb');
  num('#fxSpeed', 'speed');
  flag('#fxTrim', 'trimSilence');
  flag('#fxNormalize', 'normalize');
  flag('#fxNight', 'night');
  flag('#fxViz', 'visualizer');
  flag('#fxKeepPitch', 'keepPitch');
  document.querySelectorAll('#fxVibes .chip').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.speed !== '1') spark(b);
      fx.update({ speed: Number(b.dataset.speed), keepPitch: b.dataset.keep === '1', reverb: Number(b.dataset.reverb) });
      renderSound();
    };
  });
  num('#fxWidth', 'width');
  num('#fxRotation', 'rotation');
  num('#fxSpatialAmount', 'spatialAmount');
  num('#fxVocal', 'vocal');
  num('#fxInst', 'inst');
  document.querySelectorAll('#fxSpatial button').forEach((b) => {
    b.onclick = () => { if (b.dataset.mode !== 'off') spark(b); fx.update({ spatial: b.dataset.mode }); renderSound(); };
  });
  document.querySelectorAll('#fxVocalPresets .chip').forEach((b) => {
    b.onclick = () => { spark(b); fx.update({ vocal: Number(b.dataset.vocal), inst: Number(b.dataset.inst) }); renderSound(); };
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
  $('#syncNowBtn').onclick = async () => {
    const before = sync.state.lastSync;
    await sync.sync();
    if (!sync.state.error && sync.state.lastSync !== before) toast('同期しました', { celebrate: true });
  };
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
  if (view === 'playlist' && dx > 0) return listFrom;
  const i = TAB_ORDER.indexOf(view === 'playlist' ? listFrom : view);
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

// 上の見出しを指の進み具合に合わせてフェードで入れ替える(半分を過ぎたら隣のタブの名前に)
function fadeTitle(g, p) {
  const t = $('#viewTitle');
  g.title0 ??= t.textContent;
  const text = p > 0.5 && g.peerName ? TITLES[g.peerName] : g.title0;
  if (t.textContent !== text) t.textContent = text;
  t.style.opacity = String(Math.abs(1 - 2 * p));
}

// 下のタブの色も、指の進み具合に合わせて今のタブから隣のタブへ移す
function fadeTabs(g, p) {
  const bar = $('.tabbar');
  bar.classList.add('dragging');
  const cur = bar.querySelector('button.active');
  const next = g.peerName ? bar.querySelector(`button[data-tab="${g.peerName}"]`) : null;
  if (g.tabBtn && g.tabBtn !== next) g.tabBtn.style.color = '';
  g.tabBtn = next;
  const mix = (k) => `color-mix(in srgb, var(--text) ${Math.round(k * 100)}%, var(--muted))`;
  cur.style.color = mix(1 - p);
  if (next) next.style.color = mix(p);
}

// 指を離したら、色の切り替えは CSS の transition に任せる(スワイプの動きと同じ長さで)
function settleTabs(duration) {
  const bar = $('.tabbar');
  bar.classList.remove('dragging');
  bar.style.setProperty('--tab-fade', `${Math.round(duration)}ms`);
  bar.querySelectorAll('button').forEach((b) => { b.style.color = ''; });
}

// 指を離したあと、見出しを最後の名前に落ち着かせる
function settleTitle(text, duration) {
  const t = $('#viewTitle');
  const from = Number(t.style.opacity || 1);
  t.style.opacity = '';
  if (t.textContent === text) {
    t.animate([{ opacity: from }, { opacity: 1 }], { duration, easing: 'ease-out' });
    return;
  }
  // 違う名前が薄く出ているときは、一度消してから入れ替える
  t.animate([{ opacity: from }, { opacity: 0 }], { duration: duration * 0.4, easing: 'ease-in', fill: 'forwards' }).finished.then((a) => {
    t.textContent = text;
    a.cancel();
    t.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration * 0.6, easing: 'ease-out' });
  });
}

function bindTabSwipe() {
  const cur = () => $(`#view-${view}`);
  const W = () => window.innerWidth;
  // 曲が少なくて画面の下が空いていても効くように、画面全体で受ける
  bindSwipe(document.body, {
    canStart: (e) => !e.target.closest('input, textarea, .chips, .segmented, .mini, .tabbar, .sheet, .action-sheet, .yt-dock, .drag-handle, .compare-btn'),
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
      const p = name ? Math.min(1, Math.abs(g.dx) / W()) : 0;
      fadeTitle(g, p);
      fadeTabs(g, p);
    },
    onEnd: (g) => {
      const el = cur();
      const peer = g.peer;
      const fromCur = el.style.transform || 'none';
      el.style.transform = '';
      if (!peer) {
        settleTabs(250);
        el.animate([{ transform: fromCur }, { transform: 'none' }], { duration: 420, easing: SPRING });
        return;
      }
      const fromPeer = peer.style.transform;
      const side = g.dx < 0 ? W() : -W();
      const go = Math.abs(g.dx) > W() * 0.25 || (Math.abs(g.vx) > 0.4 && Math.sign(g.vx) === Math.sign(g.dx));
      if (!go) {
        const opt = { duration: 320, easing: EASE_OUT };
        settleTitle(g.title0, opt.duration);
        settleTabs(opt.duration);
        el.animate([{ transform: fromCur }, { transform: 'none' }], opt);
        peer.animate([{ transform: fromPeer }, { transform: `translateX(${side}px)` }], { ...opt, fill: 'forwards' })
          .finished.then((a) => { a.cancel(); clearPeer(peer); peer.classList.add('hidden'); });
        return;
      }
      const opt = { duration: flingDuration(W() - Math.abs(g.dx), g.vx), easing: FLING_EASE, fill: 'forwards' };
      settleTitle(TITLES[g.peerName], opt.duration);
      settleTabs(opt.duration);
      $('.tabbar').classList.add('swiped');
      document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === g.peerName));
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

// ---------- 並べ替え ----------
// 行の右端のつまみをドラッグして並べ替える(指でもマウスでも)。つまみにフォーカスして ↑↓ キーでも動かせる
function enableReorder(list, onMove) {
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    dragRow(list, handle.closest('li'), e, onMove);
  });
  list.addEventListener('keydown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    e.stopPropagation();
    const rows = [...list.querySelectorAll(':scope > li.track')];
    const from = rows.indexOf(handle.closest('li'));
    const to = from + (e.key === 'ArrowUp' ? -1 : 1);
    if (from < 0 || to < 0 || to >= rows.length) return;
    onMove(from, to);
    list.querySelectorAll(':scope > li.track')[to]?.querySelector('.drag-handle')?.focus();
  });
}

function dragRow(list, row, e, onMove) {
  const rows = [...list.querySelectorAll(':scope > li.track')];
  const from = rows.indexOf(row);
  if (from < 0) return;
  const sheet = list.closest('.sheet');
  const scroller = sheet || document.scrollingElement;
  const top0 = scroller.scrollTop;
  // 位置はスクロールしても変わらない座標(スクロール量を足したもの)で覚えておく
  const boxes = rows.map((r) => { const b = r.getBoundingClientRect(); return { top: b.top + top0, h: b.height }; });
  const h = boxes[from].h;
  const y0 = e.clientY;
  let y = y0;
  let to = from;
  let raf = 0;
  row.classList.add('dragging');
  list.classList.add('reordering');
  if (navigator.vibrate) { try { navigator.vibrate(8); } catch { /* 無視 */ } }

  const update = () => {
    const dy = y - y0 + (scroller.scrollTop - top0);
    row.style.transform = `translateY(${dy}px) scale(1.02)`;
    const center = boxes[from].top + dy + h / 2;
    to = boxes.filter((b, i) => i !== from && b.top + b.h / 2 < center).length;
    rows.forEach((r, i) => {
      if (i === from) return;
      const shift = from < to && i > from && i <= to ? -h : to < from && i >= to && i < from ? h : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  // 画面の上下の端に近づいたら、自動でスクロールする
  const edges = () => {
    if (sheet) { const b = sheet.getBoundingClientRect(); return [b.top, b.bottom]; }
    const mini = $('#miniPlayer');
    const bottom = mini.classList.contains('hidden') ? $('.tabbar').getBoundingClientRect().top : mini.getBoundingClientRect().top;
    return [$('.topbar').getBoundingClientRect().bottom, bottom];
  };
  const autoScroll = () => {
    const [top, bottom] = edges();
    const zone = 56;
    let v = 0;
    if (y < top + zone) v = -Math.min(16, Math.ceil((top + zone - y) / 4));
    else if (y > bottom - zone) v = Math.min(16, Math.ceil((y - (bottom - zone)) / 4));
    if (v) { scroller.scrollTop += v; update(); }
    raf = requestAnimationFrame(autoScroll);
  };
  raf = requestAnimationFrame(autoScroll);

  const move = (ev) => { y = ev.clientY; update(); };
  const finish = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    cancelAnimationFrame(raf);
    // 落ちる場所まで滑らせてから、実際に並べ替える
    const slot = to === from ? 0 : to > from ? boxes[to].top + boxes[to].h - h - boxes[from].top : boxes[to].top - boxes[from].top;
    row.style.transition = 'transform .18s cubic-bezier(.22, 1, .36, 1)';
    row.style.transform = `translateY(${slot}px)`;
    setTimeout(() => {
      row.classList.remove('dragging');
      list.classList.remove('reordering');
      rows.forEach((r) => { r.style.transform = ''; r.style.transition = ''; });
      if (to !== from) {
        onMove(from, to);
        if (navigator.vibrate) { try { navigator.vibrate(6); } catch { /* 無視 */ } }
      }
    }, REDUCED ? 0 : 180);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}

// ---------- 再生回数と聴いた記録 ----------
// 30秒(短い曲は半分)聴いたら1回と数える。回数と記録は端末ごとに保存し、同期はしない
const STATS_KEY = 'oto.stats';
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
let stats = {};
try { stats = JSON.parse(localStorage.getItem(STATS_KEY) || '{}') || {}; } catch { /* 無視 */ }
let statsTimer = 0;

function flushStats() {
  clearTimeout(statsTimer);
  statsTimer = 0;
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch { /* 保存できなくても続ける */ }
}
const saveStatsSoon = () => { if (!statsTimer) statsTimer = setTimeout(flushStats, 5000); };
const thisMonth = () => (stats[monthKey()] ||= { plays: {}, sec: 0 });

let listening = { id: null, sec: 0, last: 0, counted: false };
const PLAY_MILESTONES = [10, 25, 50, 100, 200, 500];

function trackListening(cur, dur) {
  const t = player.current();
  if (!t) return;
  // 別の曲になったか、同じ曲を頭からもう一度聴き始めたら数え直す
  if (listening.id !== t.id || (cur < 2 && listening.last - cur > 5)) listening = { id: t.id, sec: 0, last: cur, counted: false };
  const d = cur - listening.last;
  listening.last = cur;
  if (!player.state.playing || d <= 0 || d > 2) return;
  listening.sec += d;
  thisMonth().sec += d;
  saveStatsSoon();
  if (!listening.counted && listening.sec >= Math.min(30, (dur || 60) * 0.5)) {
    listening.counted = true;
    countPlay(t);
  }
}

async function countPlay(t) {
  const rec = byId.get(t.id) || t;
  const plays = (rec.plays || 0) + 1;
  for (const x of new Set([rec, t])) { x.plays = plays; x.lastPlayedAt = Date.now(); }
  const m = thisMonth();
  m.plays[t.id] = (m.plays[t.id] || 0) + 1;
  flushStats();
  await saveTrackMeta(rec, { touch: false });
  if (PLAY_MILESTONES.includes(plays)) toast(`「${t.title}」の再生が${plays}回になりました`, { celebrate: true });
  if (view === 'playlists') renderPlaylists();
}

// 今月のまとめ: 再生回数・聴いた時間・いちばん聴いた曲とアーティスト
function renderSummary() {
  const box = $('#monthSummary');
  const m = stats[monthKey()];
  const entries = m ? Object.entries(m.plays).filter(([id]) => byId.has(id)) : [];
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (!total) { box.classList.add('hidden'); return; }
  const [topId, topN] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  const top = byId.get(topId);
  const byArtist = new Map();
  for (const [id, n] of entries) {
    const a = byId.get(id).artist;
    if (a) byArtist.set(a, (byArtist.get(a) || 0) + n);
  }
  const topArtist = [...byArtist].sort((a, b) => b[1] - a[1])[0]?.[0];
  const min = Math.round(m.sec / 60);
  const time = min >= 120 ? [Math.floor(min / 60), '時間聴いた'] : [min, '分聴いた'];
  box.innerHTML = `
    <div class="summary-head">${new Date().getMonth() + 1}月のまとめ</div>
    <div class="summary-stats">
      <div><b data-to="${total}">${total}</b><span>回再生</span></div>
      <div><b data-to="${time[0]}">${time[0]}</b><span>${time[1]}</span></div>
      <div><b data-to="${entries.length}">${entries.length}</b><span>曲</span></div>
    </div>
    <button type="button" class="summary-top">
      <img class="art-sm" src="${esc(top.artUrl || ICON_NOTE)}" alt="">
      <span class="meta">
        <span class="muted small">いちばん聴いた曲(${topN}回)</span>
        <span class="title">${esc(top.title)}</span>
        ${topArtist ? `<span class="sub">よく聴いたアーティスト: ${esc(topArtist)}</span>` : ''}
      </span>
    </button>`;
  box.querySelector('.summary-top').onclick = () => player.playList([top], 0);
  box.classList.remove('hidden');
}

// 数字を0から数え上げる
function countUp(box) {
  if (REDUCED || box.classList.contains('hidden')) return;
  box.querySelectorAll('[data-to]').forEach((el) => {
    const to = Number(el.dataset.to);
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / 900);
      el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// ---------- スリープタイマー ----------
let sleepMode = null; // null | 'time' | 'track'
let sleepEnd = 0;
let sleepTimer = 0;

function setSleep(mode, minutes = 0) {
  clearInterval(sleepTimer);
  player.setStopAfterTrack(false);
  sleepMode = mode;
  if (mode === 'time') {
    sleepEnd = Date.now() + minutes * 60000;
    sleepTimer = setInterval(sleepTick, 1000);
    toast(`${minutes >= 60 ? `${Math.floor(minutes / 60)}時間${minutes % 60 ? `${minutes % 60}分` : ''}` : `${minutes}分`}後に止めます`);
    spark($('#sleepBtn'));
  } else if (mode === 'track') {
    player.setStopAfterTrack(true);
    toast('この曲が終わったら止めます');
    spark($('#sleepBtn'));
  } else {
    toast('スリープタイマーをオフにしました');
  }
  renderSleep();
}

function sleepTick() {
  if (Date.now() < sleepEnd) { renderSleep(); return; }
  clearInterval(sleepTimer);
  sleepMode = null;
  renderSleep();
  player.fadeOutAndPause(8).then(() => toast('スリープタイマーで止めました'));
}

function renderSleep() {
  $('#sleepBtn').classList.toggle('on', !!sleepMode);
  const left = Math.max(0, Math.ceil((sleepEnd - Date.now()) / 1000));
  $('#npLabel').textContent = sleepMode === 'time' ? `スリープまで ${fmt(left)}` : sleepMode === 'track' ? 'この曲で止まります' : '再生中';
}

function sleepMenu() {
  const opts = [[15, '15分'], [30, '30分'], [45, '45分'], [60, '1時間'], [90, '1時間30分']];
  const items = opts.map(([m, label]) => ({ label, run: () => setSleep('time', m) }));
  items.push({ label: 'この曲が終わるまで', on: sleepMode === 'track', run: () => setSleep('track') });
  if (sleepMode) items.unshift({ label: 'オフにする', danger: true, run: () => setSleep(null) });
  actionSheet('スリープタイマー', items);
}

// ---------- 元の音と比べる ----------
// ボタン(または B キー)を押している間だけ、効果をすべて止めた元の音を鳴らす
let comparing = false;

function compareOn() {
  if (comparing) return;
  if (!player.current()) { toast('曲を再生すると、元の音と比べられます'); return; }
  if (!fx.hasEffects()) { toast('今はサウンドの効果を使っていないので、元の音のままです'); return; }
  comparing = true;
  fx.setBypass(true);
  const b = $('#compareBtn');
  b.classList.add('on');
  b.querySelector('span').textContent = '元の音を再生中';
  if (navigator.vibrate) { try { navigator.vibrate(8); } catch { /* 無視 */ } }
}

function compareOff() {
  if (!comparing) return;
  comparing = false;
  fx.setBypass(false);
  const b = $('#compareBtn');
  b.classList.remove('on');
  b.querySelector('span').textContent = '長押しで元の音と比べる';
}

function bindCompare() {
  const b = $('#compareBtn');
  b.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 指がボタンから外れても、離すまでは元の音のままにする
    try { b.setPointerCapture(e.pointerId); } catch { /* 無視 */ }
    compareOn();
  });
  ['pointerup', 'pointercancel', 'lostpointercapture', 'blur'].forEach((ev) => b.addEventListener(ev, compareOff));
  b.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); compareOn(); }
  });
  b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') compareOff(); });
  // 長押しでメニューや文字の選択が出ないようにする
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keyup', (e) => { if (e.key === 'b' || e.key === 'B') compareOff(); });
}

// ---------- キーボード操作(PC) ----------
const SHORTCUTS = [
  ['Space', '再生 / 一時停止'],
  ['← / →', '5秒戻る / 進む'],
  ['Shift + ← / →', '前の曲 / 次の曲'],
  ['+ / −', '音量を上げる / 下げる'],
  ['M', 'ミュート'],
  ['L', 'お気に入り'],
  ['S', 'シャッフル'],
  ['R', 'リピート'],
  ['B(押している間)', '元の音と比べる'],
  ['/', '曲を探す'],
  ['Esc', '閉じる・戻る'],
  ['?', 'この一覧'],
];
let volumeBeforeMute = 0;

function changeVolume(d) {
  const v = Math.max(0, Math.min(100, fx.settings.volume + d));
  fx.update({ volume: v });
  renderSound();
  toast(`音量 ${v}%`, { duration: 1000 });
}

function toggleMute() {
  if (fx.settings.volume > 0) {
    volumeBeforeMute = fx.settings.volume;
    fx.update({ volume: 0 });
    toast('ミュートしました', { duration: 1200 });
  } else {
    fx.update({ volume: volumeBeforeMute || 70 });
    toast(`音量 ${fx.settings.volume}%`, { duration: 1200 });
  }
  renderSound();
}

const isOpen = (sel) => !$(sel).classList.contains('hidden') && !$(sel).classList.contains('closing');

// いちばん手前の画面を閉じる
function closeTop() {
  if (isOpen('#dialog')) $('#dialogCancel').click();
  else if (isOpen('#actionSheet')) $('#actionSheet [data-cancel]').click();
  else if ($('#nowPlaying').classList.contains('open')) closeNow();
  else if (view === 'playlist') switchTab(listFrom);
  else return false;
  return true;
}

function onKey(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const el = e.target instanceof Element ? e.target : document.body;
  const typing = el.closest('input, textarea, select, [contenteditable]');
  if (e.key === 'Escape') {
    if (typing && !isOpen('#dialog')) { if (el.id === 'searchInput') el.blur(); return; }
    if (closeTop()) e.preventDefault();
    return;
  }
  if (typing || isOpen('#dialog') || isOpen('#actionSheet')) return;
  const t = player.current();
  switch (e.key) {
    case ' ':
      // キーボードで選んだボタンや曲の行の上では、それを押す操作に任せる(マウスで押したあとのフォーカスなら再生/一時停止)
      if (el !== document.body && el.matches(':focus-visible') && el.closest('button, a, [tabindex]')) return;
      if (!t) return;
      player.toggle();
      break;
    case 'ArrowRight':
    case 'ArrowLeft': {
      if (!t) return;
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (e.shiftKey) { if (dir > 0) player.next(); else player.prev(); }
      else player.seek(Math.max(0, player.currentTime() + dir * 5));
      break;
    }
    case '+': case '=': case ';': changeVolume(5); break;
    case '-': case '_': changeVolume(-5); break;
    case 'm': case 'M': toggleMute(); break;
    case 'l': case 'L': if (!t) return; toggleFavorite(t); break;
    case 's': case 'S': if (!t) return; $('#shuffleBtn').click(); break;
    case 'r': case 'R': if (!t) return; $('#repeatBtn').click(); break;
    case 'b': case 'B': if (!e.repeat) compareOn(); break;
    case '/': switchTab('library'); $('#searchInput').focus(); break;
    case '?': actionSheet('キーボード操作', SHORTCUTS.map(([key, label]) => ({ info: true, key, label }))); break;
    default: return;
  }
  e.preventDefault();
}

// ---------- イベント ----------
function bind() {
  bindSound();
  bindSync();
  bindCompare();
  document.querySelectorAll('.tabbar button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  $('#backBtn').onclick = () => switchTab(listFrom);
  $('#searchInput').addEventListener('input', renderLibrary);
  // 曲・アーティスト・アルバムの切り替えは、次に開いたときも覚えておく
  document.querySelectorAll('#libMode button').forEach((b) => {
    b.onclick = () => {
      if (libMode === b.dataset.mode) return;
      libMode = b.dataset.mode;
      try { localStorage.setItem('oto.libMode', libMode); } catch { /* 無視 */ }
      renderLibrary();
      staggerIn($('#libraryList').children);
    };
  });
  $('#playAllBtn').onclick = () => {
    const items = filteredTracks();
    if (items.length) { spark($('#playAllBtn')); player.playList(items, 0, { shuffle: false }); }
  };
  $('#shuffleAllBtn').onclick = () => {
    const items = filteredTracks();
    if (items.length) { spark($('#shuffleAllBtn')); player.playList(items, -1, { shuffle: true }); }
  };
  $('#newPlaylistBtn').onclick = async () => {
    const pl = await createPlaylist();
    if (pl) { renderPlaylists(); toast(`「${pl.name}」を作成しました`, { celebrate: true }); }
  };
  $('#plPlayBtn').onclick = () => {
    const items = currentListTracks();
    if (items.length) { spark($('#plPlayBtn')); player.playList(items, 0, { shuffle: false }); }
  };
  $('#plShuffleBtn').onclick = () => {
    const items = currentListTracks();
    if (items.length) { spark($('#plShuffleBtn')); player.playList(items, -1, { shuffle: true }); }
  };
  $('#plMenuBtn').onclick = playlistMenu;
  $('#fileInput').addEventListener('change', async (e) => {
    if (e.target.files.length) await importFiles(e.target.files);
    e.target.value = '';
  });
  $('#ytForm').addEventListener('submit', addYouTube);
  $('#ytCancelBtn').onclick = () => ytAbort?.abort();

  $('#miniPlayer').addEventListener('click', (e) => {
    if (miniSwiped) { miniSwiped = false; return; }
    if (e.target.closest('#miniPlayBtn')) player.toggle();
    else if (e.target.closest('#miniNextBtn')) player.next();
    else openNow();
  });
  $('#miniPlayer').addEventListener('keydown', (e) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    openNow();
  });
  $('#favBtn').onclick = () => { const t = player.current(); if (t) toggleFavorite(t, $('#favBtn')); };
  $('#sleepBtn').onclick = sleepMenu;
  $('#closeNowBtn').onclick = closeNow;
  $('#queueBtn').onclick = () => { $('#queuePanel').classList.toggle('hidden'); renderQueue(); };
  $('#playBtn').onclick = player.toggle;
  $('#prevBtn').onclick = player.prev;
  $('#nextBtn').onclick = () => player.next();
  $('#shuffleBtn').onclick = () => {
    const on = !player.state.shuffle;
    player.setShuffle(on);
    if (on) spark($('#shuffleBtn'));
  };
  $('#repeatBtn').onclick = () => {
    player.cycleRepeat();
    if (player.state.repeat !== 'off') spark($('#repeatBtn'));
  };

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
  enableReorder($('#playlistTracks'), movePlaylistTrack);
  enableReorder($('#queueList'), (from, to) => {
    const base = player.state.index + 1;
    player.moveInQueue(base + from, base + to);
  });
  document.addEventListener('keydown', onKey);

  // アプリを離れるときは、「元に戻す」待ちの削除を確定し、聴いた記録を保存する
  const leave = () => { commitPending(); flushStats(); compareOff(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leave(); });
  window.addEventListener('pagehide', leave);

  // この端末から音声を消した曲は、再生するときにドライブから読み込む
  player.setMissingBlobHandler(async (t) => {
    if (!(byId.get(t.id) || t).offloaded) throw new Error('音声データが見つかりません');
    toast('ドライブから読み込み中…', { duration: 60000 });
    const blob = await downloadToDevice(t);
    toast(`「${t.title}」をドライブから読み込みました`);
    rerender();
    return blob;
  });

  window.addEventListener('resize', () => { placeYtDock(); refreshMarquees(); });
  $('#nowPlaying').addEventListener('scroll', placeYtDock, { passive: true });

  player.on('change', () => { renderNow(); renderQueue(); saveSession(); });
  player.on('queue', () => { renderControls(); renderQueue(); saveSession(); });
  player.on('state', renderControls);
  player.on('change', startViz);
  fx.onChange(startViz);
  player.on('error', (msg) => toast(msg));
  player.on('sleep-done', () => {
    sleepMode = null;
    renderSleep();
    toast('スリープタイマーで止めました');
  });
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
    trackListening(cur, dur);
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
const APP_VERSION = 43;

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
      if (document.visibilityState === 'visible') reg.update().catch(() => { });
    });
  }).catch(() => { });
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

  // 取り込み用サーバー(Renderの無料枠は止まっていることがある)を先に起こしておく
  fetch(YT_API_ENDPOINT.replace(/\/api\/youtube$/, '/health')).catch(() => { });
}

init();
