// Googleドライブ同期: 各自のドライブの「oto」フォルダに曲ファイルとライブラリ情報(oto-library.json)を置き、
// スマホとPCで同じ曲・プレイリストを使えるようにする。アプリが作ったファイルだけを扱う drive.file 権限を使う
import * as db from './db.js';
import { GOOGLE_CLIENT_ID } from './config.js';
import { readTags } from './tags.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const KEY = 'oto.sync';
const LIBRARY_NAME = 'oto-library.json';
const DELETED_KEEP_MS = 90 * 24 * 3600 * 1000;

// ドライブに保存する曲の項目(ジャケット画像や解析結果は各端末で作り直す)
const TRACK_FIELDS = ['id', 'type', 'title', 'artist', 'album', 'duration', 'ytId', 'addedAt', 'updatedAt',
  'driveId', 'mime', 'size', 'fileName', 'titlePending'];
const PLAYLIST_FIELDS = ['id', 'name', 'trackIds', 'createdAt', 'updatedAt'];

const pickFields = (o, fields) => Object.fromEntries(fields.filter((f) => o[f] !== undefined).map((f) => [f, o[f]]));

export const configured = () => !!GOOGLE_CLIENT_ID;

// ---------- 状態 ----------
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
const saved = loadSaved();

export const state = {
  enabled: !!saved.enabled,   // 一度ログインして同期を有効にしたか
  email: saved.email || '',
  lastSync: saved.lastSync || 0,
  busy: false,
  progress: '',
  error: '',
  needsLogin: false,
};

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      enabled: state.enabled, email: state.email, lastSync: state.lastSync,
      token: token && { value: token, expiresAt },
    }));
  } catch { /* 保存できなくても続ける */ }
}

const listeners = [];
export const onChange = (fn) => listeners.push(fn);
const emit = () => listeners.forEach((fn) => fn(state));
const syncedListeners = [];
export const onSynced = (fn) => syncedListeners.push(fn);

// ---------- ログイン(Google Identity Services) ----------
let token = saved.token?.value || null;
let expiresAt = saved.token?.expiresAt || 0;
let gisPromise = null;
let tokenClient = null;
let pendingToken = null;

class AuthError extends Error {}

function loadGis() {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gisPromise = null; reject(new Error('Googleのログイン画面を読み込めませんでした')); };
    document.head.appendChild(s);
  });
  return gisPromise;
}

function ensureTokenClient() {
  if (tokenClient) return tokenClient;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: (r) => {
      const p = pendingToken;
      pendingToken = null;
      if (r.error) { p?.reject(new AuthError(r.error_description || r.error)); return; }
      token = r.access_token;
      expiresAt = Date.now() + (Number(r.expires_in) || 3600) * 1000;
      persist();
      p?.resolve(token);
    },
    error_callback: (e) => {
      const p = pendingToken;
      pendingToken = null;
      p?.reject(new AuthError(e?.type === 'popup_closed' ? 'ログインがキャンセルされました' : 'ログインできませんでした'));
    },
  });
  return tokenClient;
}

const tokenValid = () => token && Date.now() < expiresAt - 60_000;

// アプリ起動時に読み込んでおく。ボタンを押した瞬間にログイン画面を開けるようにするため
export function preload() {
  if (configured()) loadGis().catch(() => {});
}

// ボタンのクリック処理の中から同期的に呼ぶこと(ポップアップのブロックを避けるため)
export function signIn() {
  if (!configured()) return Promise.reject(new Error('GoogleのクライアントIDが設定されていません'));
  if (!window.google?.accounts?.oauth2) {
    return loadGis().then(() => Promise.reject(new Error('準備ができました。もう一度ボタンを押してください')));
  }
  return new Promise((resolve, reject) => {
    pendingToken = { resolve, reject };
    ensureTokenClient().requestAccessToken({ prompt: state.enabled ? '' : 'consent', hint: state.email || undefined });
  }).then(async () => {
    state.enabled = true;
    state.needsLogin = false;
    state.error = '';
    persist();
    emit();
    await sync();
  });
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  token = null;
  expiresAt = 0;
  state.enabled = false;
  state.email = '';
  state.needsLogin = false;
  state.error = '';
  persist();
  emit();
}

// ---------- Drive API ----------
async function api(url, opts = {}) {
  if (!tokenValid()) throw new AuthError('ログインの有効期限が切れました');
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (res.status === 401) { token = null; persist(); throw new AuthError('ログインの有効期限が切れました'); }
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error?.message || msg; } catch { /* 本文なし */ }
    const e = new Error(`Googleドライブとの通信に失敗しました(${msg})`);
    e.status = res.status;
    throw e;
  }
  return res;
}

const q = (s) => encodeURIComponent(s);

async function findOne(query) {
  const res = await api(`${API}/files?q=${q(query)}&fields=files(id,name)&pageSize=1&spaces=drive`);
  return (await res.json()).files?.[0] || null;
}

async function createMeta(meta) {
  const res = await api(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
  });
  return (await res.json()).id;
}

async function ensureFolder() {
  const found = await findOne("mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='oto' and value='root' }");
  if (found) return found.id;
  return createMeta({ name: 'oto', mimeType: 'application/vnd.google-apps.folder', appProperties: { oto: 'root' } });
}

// 大きなファイルも送れるよう、再開可能アップロードを使う
async function uploadFile(meta, blob, existingId = null) {
  const url = existingId
    ? `${UPLOAD}/files/${existingId}?uploadType=resumable&fields=id`
    : `${UPLOAD}/files?uploadType=resumable&fields=id`;
  const start = await api(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': blob.type || 'application/octet-stream',
      'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify(existingId ? {} : meta),
  });
  const location = start.headers.get('Location');
  if (!location) throw new Error('アップロードを開始できませんでした');
  const res = await api(location, { method: 'PUT', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
  return (await res.json()).id;
}

async function download(id) {
  const res = await api(`${API}/files/${id}?alt=media`);
  return res.blob();
}

async function trash(id) {
  try {
    await api(`${API}/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  } catch (e) {
    if (e.status !== 404) throw e;
  }
}

async function fetchEmail() {
  try {
    const res = await api(`${API}/about?fields=user(emailAddress)`);
    return (await res.json()).user?.emailAddress || '';
  } catch {
    return '';
  }
}

// ---------- 統合(テストしやすいよう、副作用のない関数にしている) ----------
const newer = (a, b) => (!a ? b : !b ? a : (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a);

function mergeDeleted(a = {}, b = {}, now) {
  const out = {};
  for (const [id, t] of [...Object.entries(a), ...Object.entries(b)]) {
    if (now - t > DELETED_KEEP_MS) continue;
    out[id] = Math.max(out[id] || 0, t);
  }
  return out;
}

// 端末とドライブの内容を合わせる。同じ曲が両方で変わっていたら、新しく変更した方を使う
export function merge(local, remote, now = Date.now()) {
  const deleted = {
    tracks: mergeDeleted(local.deleted?.tracks, remote.deleted?.tracks, now),
    playlists: mergeDeleted(local.deleted?.playlists, remote.deleted?.playlists, now),
  };
  const byId = (arr) => new Map((arr || []).map((x) => [x.id, x]));

  const lt = byId(local.tracks);
  const rt = byId(remote.tracks);
  const tracks = [];
  for (const id of new Set([...lt.keys(), ...rt.keys()])) {
    const l = lt.get(id);
    const r = rt.get(id);
    let t = newer(l, r);
    t = t === r && l ? { ...l, ...r } : { ...t };
    if (!t.driveId) t = { ...t, driveId: l?.driveId || r?.driveId };
    if (!t.driveId) delete t.driveId;
    if ((deleted.tracks[id] || 0) >= (t.updatedAt || 0)) continue;
    tracks.push(t);
  }
  const alive = new Set(tracks.map((t) => t.id));

  const lp = byId(local.playlists);
  const rp = byId(remote.playlists);
  const playlists = [];
  for (const id of new Set([...lp.keys(), ...rp.keys()])) {
    const p = newer(lp.get(id), rp.get(id));
    if ((deleted.playlists[id] || 0) >= (p.updatedAt || 0)) continue;
    playlists.push({ ...p, trackIds: (p.trackIds || []).filter((t) => alive.has(t)) });
  }
  return { tracks, playlists, deleted };
}

// ---------- 同期 ----------
let running = null;
let again = false;
let timer = null;

const extOf = (t) => (t.fileName?.match(/\.[A-Za-z0-9]{1,5}$/)?.[0] || '');

export function sync() {
  if (!configured() || !state.enabled) return Promise.resolve();
  if (running) { again = true; return running; }
  running = doSync()
    .catch((e) => {
      if (e instanceof AuthError) { state.needsLogin = true; state.error = ''; }
      else state.error = e.message || '同期できませんでした';
      console.warn(e);
    })
    .finally(() => {
      state.busy = false;
      state.progress = '';
      running = null;
      emit();
      if (again) { again = false; schedule(500); }
    });
  return running;
}

// 変更のたびに少し待ってから同期する(続けて操作したときにまとめるため)
export function schedule(ms = 4000) {
  if (!configured() || !state.enabled) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!tokenValid()) { state.needsLogin = true; emit(); return; }
    sync();
  }, ms);
}

async function doSync() {
  if (!tokenValid()) throw new AuthError('ログインが必要です');
  state.busy = true;
  state.error = '';
  state.needsLogin = false;
  state.progress = 'ドライブを確認中…';
  emit();

  if (!state.email) state.email = await fetchEmail();
  const folder = await ensureFolder();
  const libFile = await findOne(`'${folder}' in parents and trashed=false and appProperties has { key='oto' and value='library' }`);
  const remote = libFile ? await (await api(`${API}/files/${libFile.id}?alt=media`)).json() : { tracks: [], playlists: [], deleted: {} };

  const localTracks = await db.getAllTracks();
  const localPlaylists = await db.getAllPlaylists();
  const local = { tracks: localTracks, playlists: localPlaylists, deleted: db.getDeleted() };
  const m = merge(local, remote);

  // 削除された曲のファイルをドライブのゴミ箱へ
  const remoteById = new Map((remote.tracks || []).map((t) => [t.id, t]));
  for (const id of Object.keys(m.deleted.tracks)) {
    const r = remoteById.get(id);
    if (r?.driveId) await trash(r.driveId);
  }

  const localById = new Map(localTracks.map((t) => [t.id, t]));
  const files = m.tracks.filter((t) => t.type === 'file');

  // この端末にしかない曲をアップロード
  const toUpload = [];
  for (const t of files) if (!t.driveId && await db.hasBlob(t.id)) toUpload.push(t);
  for (const [i, t] of toUpload.entries()) {
    state.progress = `アップロード中 ${i + 1} / ${toUpload.length}「${t.title}」`;
    emit();
    const blob = await db.getBlob(t.id);
    t.driveId = await uploadFile({
      name: t.fileName || `${t.artist ? `${t.artist} - ` : ''}${t.title}${extOf(t)}`,
      parents: [folder],
      mimeType: blob.type || t.mime || 'audio/mpeg',
      appProperties: { oto: 'track', otoId: t.id },
    }, blob);
  }

  // ほかの端末で追加された曲をダウンロード
  const toDownload = [];
  for (const t of files) if (t.driveId && !await db.hasBlob(t.id)) toDownload.push(t);
  for (const [i, t] of toDownload.entries()) {
    state.progress = `ダウンロード中 ${i + 1} / ${toDownload.length}「${t.title}」`;
    emit();
    const blob = await download(t.driveId);
    const typed = blob.type ? blob : new Blob([blob], { type: t.mime || 'audio/mpeg' });
    if (!t.picture) {
      try {
        const tags = await readTags(new File([typed], t.fileName || 'track', { type: typed.type }));
        if (tags.picture) t.picture = tags.picture;
        if (!t.duration && tags.duration) t.duration = tags.duration;
      } catch { /* タグが読めなくても続ける */ }
    }
    await db.putTrack(t, typed, { touch: false });
    localById.set(t.id, t);
  }

  // 端末側のデータを統合結果にそろえる
  state.progress = '仕上げ中…';
  emit();
  const keepTracks = new Set(m.tracks.map((t) => t.id));
  for (const t of localTracks) if (!keepTracks.has(t.id)) await db.deleteTrack(t.id, { touch: false });
  for (const t of m.tracks) {
    const before = localById.get(t.id);
    if (toDownload.includes(t)) continue;
    if (!before || JSON.stringify(pickFields(before, TRACK_FIELDS)) !== JSON.stringify(pickFields(t, TRACK_FIELDS))) {
      if (t.type === 'file' && !before && !t.driveId) continue;
      await db.putTrack(t, null, { touch: false });
    }
  }
  const keepPl = new Set(m.playlists.map((p) => p.id));
  for (const p of localPlaylists) if (!keepPl.has(p.id)) await db.deletePlaylist(p.id, { touch: false });
  for (const p of m.playlists) await db.putPlaylist(p, { touch: false });
  db.setDeleted(m.deleted);

  // ドライブ側のライブラリ情報を更新
  const library = {
    app: 'oto',
    version: 1,
    updatedAt: Date.now(),
    tracks: m.tracks.filter((t) => t.type !== 'file' || t.driveId).map((t) => pickFields(t, TRACK_FIELDS)),
    playlists: m.playlists.map((p) => pickFields(p, PLAYLIST_FIELDS)),
    deleted: m.deleted,
  };
  const body = new Blob([JSON.stringify(library)], { type: 'application/json' });
  await uploadFile({ name: LIBRARY_NAME, parents: [folder], mimeType: 'application/json', appProperties: { oto: 'library' } }, body, libFile?.id);

  state.lastSync = Date.now();
  persist();
  syncedListeners.forEach((fn) => fn());
}

// 書き込みがあったら同期を予約する
db.setWriteListener(() => schedule());
