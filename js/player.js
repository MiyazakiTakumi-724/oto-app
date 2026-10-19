// 再生エンジン: 端末のファイルは <audio>(2台を交互に使い、クロスフェードできる)、
// YouTubeは公式 IFrame Player API で再生する
import { getBlob } from './db.js';
import * as fx from './fx.js';

// ほぼ無音の短いWAV。iOSで2台目のプレイヤーを最初の操作時に再生可能にしておくために使う
const SILENT = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAAAA';

function makeDeck() {
  const el = new Audio();
  el.preload = 'auto';
  el.preservesPitch = true;
  el.webkitPreservesPitch = true;
  return { el, url: null };
}

const decks = [makeDeck(), makeDeck()];
let active = 0;
const deck = () => decks[active];
let unlocked = false;
let fadeTimer = null;
let fading = false;

const listeners = {};
export function on(ev, fn) { (listeners[ev] ||= []).push(fn); }
function emit(ev, ...args) { (listeners[ev] || []).forEach((fn) => fn(...args)); }

export const state = {
  queue: [],        // 再生順の曲
  original: [],     // シャッフル前の並び
  index: -1,
  shuffle: false,
  repeat: 'off',    // off | all | one
  playing: false,
};

let loadToken = 0;

export const current = () => state.queue[state.index] || null;

// ---------- YouTube ----------
let ytReady = null;
let yt = null;
let ytTimer = null;

function loadYouTube() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => {
      yt = new YT.Player('ytPlayer', {
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => resolve(yt),
          onStateChange: onYtState,
          onError: () => { emit('error', 'この動画は埋め込み再生できません'); next(true); },
        },
      });
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytReady = null; reject(new Error('YouTubeを読み込めませんでした')); };
    document.head.appendChild(s);
  });
  return ytReady;
}

function onYtState(e) {
  if (current()?.type !== 'youtube') return;
  if (e.data === YT.PlayerState.PLAYING) setPlaying(true);
  else if (e.data === YT.PlayerState.PAUSED) setPlaying(false);
  else if (e.data === YT.PlayerState.ENDED) ended();
  if (e.data === YT.PlayerState.PLAYING) {
    applyYtSpeed();
    applyVolume();
    const t = current();
    const data = yt.getVideoData?.();
    if (t && data?.title && t.titlePending) emit('yt-title', t, data.title, data.author);
  }
}

// YouTube側の機能で変えられるのは再生速度だけ(音声そのものには手を加えられない)
function applyYtSpeed() {
  if (!yt?.setPlaybackRate) return;
  const speed = Math.min(2, Math.max(0.25, fx.settings.speed));
  if (yt.getPlaybackRate?.() !== speed) yt.setPlaybackRate(speed);
}

function startYtTimer() {
  clearInterval(ytTimer);
  ytTimer = setInterval(() => {
    if (current()?.type === 'youtube' && yt?.getCurrentTime) {
      emit('time', yt.getCurrentTime() || 0, yt.getDuration() || 0);
    }
  }, 500);
}

// ---------- 共通 ----------
function setPlaying(p) {
  state.playing = p;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'playing' : 'paused';
  emit('state', p);
}

const isActive = (d) => d === deck() && current()?.type === 'file';

decks.forEach((d) => {
  d.el.addEventListener('play', () => isActive(d) && setPlaying(true));
  d.el.addEventListener('pause', () => isActive(d) && !fading && setPlaying(false));
  d.el.addEventListener('ended', () => isActive(d) && ended());
  d.el.addEventListener('timeupdate', () => {
    if (!isActive(d)) return;
    emit('time', d.el.currentTime, d.el.duration || current()?.duration || 0);
    updatePositionState();
  });
  d.el.addEventListener('error', () => {
    if (isActive(d) && d.url) emit('error', 'このファイルは再生できません');
  });
});

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const el = deck().el;
  const d = el.duration;
  if (!Number.isFinite(d) || d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({ duration: d, position: Math.min(el.currentTime, d), playbackRate: el.playbackRate });
  } catch { /* 一部ブラウザは未対応 */ }
}

// ユーザー操作の中で呼ぶ: 音声処理の準備と、2台目のプレイヤーの再生許可
function userGesture() {
  if (fx.needsGraph()) fx.ensureGraph(decks);
  else fx.resume();
  applyVolume();
  if (unlocked) return;
  unlocked = true;
  decks.forEach((d) => {
    if (d === deck()) return;
    d.el.src = SILENT;
    d.el.play().then(() => d.el.pause()).catch(() => { unlocked = false; });
  });
}

const startOf = (t) => (fx.settings.trimSilence && t.analysis?.start > 0.3 ? t.analysis.start : 0);

function endOf(t, el) {
  const dur = el.duration;
  if (fx.settings.trimSilence && t.analysis && t.analysis.end < (dur || Infinity) - 0.3) return t.analysis.end;
  return Number.isFinite(dur) ? dur : 0;
}

// デッキに曲をセットし、再生位置の準備ができたら解決する
function prepare(d, t, blob) {
  return new Promise((resolve) => {
    if (d.url) URL.revokeObjectURL(d.url);
    d.url = URL.createObjectURL(blob);
    d.el.src = d.url;
    d.el.playbackRate = fx.settings.speed;
    fx.setNorm(d, t);
    const done = () => {
      d.el.removeEventListener('loadedmetadata', done);
      const s = startOf(t);
      if (s) { try { d.el.currentTime = s; } catch { /* 無視 */ } }
      d.el.playbackRate = fx.settings.speed;
      resolve();
    };
    d.el.addEventListener('loadedmetadata', done);
    d.el.addEventListener('error', () => resolve(), { once: true });
  });
}

function stopFade() {
  clearTimeout(fadeTimer);
  if (!fading) return;
  fading = false;
  decks.forEach((d) => { if (d !== deck()) d.el.pause(); });
  fx.setFade(deck(), 1);
}

function ended() {
  const t = current();
  if (state.repeat === 'one') { seek(t ? startOf(t) : 0); play(); return; }
  next(true);
}

function nextIndex(auto) {
  if (state.index < state.queue.length - 1) return state.index + 1;
  if (state.repeat === 'all' || !auto) return 0;
  return -1;
}

async function load(autoplay = true) {
  const token = ++loadToken;
  stopFade();
  const t = current();
  emit('change', t);
  if (!t) { stopAll(); return; }

  if (t.type === 'file') {
    if (autoplay) userGesture();
    if (yt?.pauseVideo) yt.pauseVideo();
    clearInterval(ytTimer);
    emit('yt-visible', false);
    const blob = await getBlob(t.id);
    if (token !== loadToken) return;
    if (!blob) { emit('error', '音声データが見つかりません'); return; }
    const d = deck();
    d.el.pause();
    fx.setFade(d, 1);
    await prepare(d, t, blob);
    if (token !== loadToken) return;
    if (autoplay) d.el.play().catch(() => setPlaying(false));
    analyzeSoon(t);
  } else {
    decks.forEach((d) => d.el.pause());
    emit('yt-visible', true);
    try {
      const p = await loadYouTube();
      if (token !== loadToken) return;
      if (autoplay) p.loadVideoById(t.ytId); else p.cueVideoById(t.ytId);
      startYtTimer();
    } catch (e) {
      emit('error', e.message);
    }
  }
  updateMediaSession(t);
}

// 再生中の曲の終わりが近づいたら、次の曲を重ねながら切り替える
async function crossfadeTo(ni, seconds) {
  const token = ++loadToken;
  const from = deck();
  fading = true;
  state.index = ni;
  const t = current();
  const blob = await getBlob(t.id);
  if (token !== loadToken) return;
  if (!blob) { fading = false; next(true); return; }
  active = 1 - active;
  const to = deck();
  fx.setFade(to, 0);
  await prepare(to, t, blob);
  if (token !== loadToken) return;
  try {
    await to.el.play();
  } catch {
    // 再生できなければ通常の切り替えにする
    fading = false;
    from.el.pause();
    fx.setFade(to, 1);
    emit('change', t);
    return;
  }
  fx.rampFade(from, 0, seconds);
  fx.rampFade(to, 1, seconds);
  emit('change', t);
  emit('queue');
  updateMediaSession(t);
  analyzeSoon(t);
  fadeTimer = setTimeout(() => {
    from.el.pause();
    fading = false;
  }, seconds * 1000 + 150);
}

function tick() {
  const t = current();
  const d = deck();
  if (!t || t.type !== 'file' || d.el.paused || fading || !d.url) return;
  const end = endOf(t, d.el);
  if (!end) return;
  const remain = (end - d.el.currentTime) / (d.el.playbackRate || 1);
  const cf = fx.settings.crossfade;
  if (cf > 0 && fx.hasGraph() && state.repeat !== 'one' && remain <= cf) {
    const ni = nextIndex(true);
    if (ni >= 0 && ni !== state.index && state.queue[ni].type === 'file') {
      crossfadeTo(ni, Math.max(0.5, remain));
      return;
    }
  }
  // 無音カット: 曲の最後の無音に入ったら次へ
  if (remain <= 0 && end < (d.el.duration || Infinity) - 0.1) ended();
}
setInterval(tick, 200);

// ---------- 音量・無音の解析(結果は曲データに保存される) ----------
let analysisChain = Promise.resolve();
const analyzing = new Set();

function analyzeTrack(t) {
  if (!fx.needsAnalysis(t) || analyzing.has(t.id)) return;
  analyzing.add(t.id);
  analysisChain = analysisChain.then(async () => {
    try {
      const blob = await getBlob(t.id);
      if (!blob) return;
      t.analysis = await fx.analyze(blob);
      emit('analyzed', t);
      if (current() === t) {
        fx.setNorm(deck(), t);
        // 解析が終わる前に再生が始まっていたら、最初の無音をここで飛ばす
        const s = startOf(t);
        if (s && deck().el.currentTime < s - 0.2) deck().el.currentTime = s;
      }
    } catch (e) {
      console.warn('解析できませんでした', e);
    } finally {
      analyzing.delete(t.id);
    }
  });
}

// 今の曲と次の曲を解析する(音量補正か無音カットが有効なときだけ)
function analyzeSoon(t) {
  if (!fx.settings.normalize && !fx.settings.trimSilence) return;
  analyzeTrack(t);
  const ni = nextIndex(true);
  if (ni >= 0) analyzeTrack(state.queue[ni]);
}

// 音量: 音声処理を使っていればその最後で、使っていなければ <audio> で下げる。YouTubeは公式プレイヤーの音量を変える
function applyVolume() {
  const v = fx.elementVolume();
  decks.forEach((d) => { if (d.el.volume !== v) d.el.volume = v; });
  if (yt?.setVolume) yt.setVolume(Math.round(fx.volumeGain() * 100));
}
applyVolume();

fx.onChange(() => {
  if (fx.needsGraph()) fx.ensureGraph(decks);
  applyVolume();
  if (current()?.type === 'youtube') applyYtSpeed();
  decks.forEach((d) => { d.el.playbackRate = fx.settings.speed; });
  const t = current();
  if (t?.type === 'file') {
    fx.setNorm(deck(), t);
    analyzeSoon(t);
  }
});

function stopAll() {
  stopFade();
  decks.forEach((d) => d.el.pause());
  if (yt?.stopVideo) yt.stopVideo();
  emit('yt-visible', false);
  setPlaying(false);
}

function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  // ジャケットがなければ、ロック画面や通知にはotoのアイコンを出す
  const artwork = t.artUrl
    ? [{ src: t.artUrl, sizes: '512x512', type: 'image/jpeg' }]
    : [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist || '', album: t.album || '', artwork,
  });
}

export function play() {
  const t = current();
  if (!t) return;
  if (t.type === 'file') {
    userGesture();
    deck().el.play().catch(() => {});
  } else yt?.playVideo?.();
}

export function pause() {
  const t = current();
  if (!t) return;
  if (t.type === 'file') {
    stopFade();
    deck().el.pause();
  } else yt?.pauseVideo?.();
}

export const toggle = () => (state.playing ? pause() : play());

export function seek(sec) {
  const t = current();
  if (!t) return;
  if (t.type === 'file') {
    stopFade();
    deck().el.currentTime = sec;
  } else yt?.seekTo?.(sec, true);
}

export function currentTime() {
  return current()?.type === 'youtube' ? (yt?.getCurrentTime?.() || 0) : deck().el.currentTime;
}

export function next(auto = false) {
  if (!state.queue.length) return;
  const ni = nextIndex(auto);
  if (ni < 0) { pause(); seek(0); return; }
  state.index = ni;
  load(true);
}

export function prev() {
  if (!state.queue.length) return;
  const t = current();
  if (currentTime() > (t ? startOf(t) : 0) + 3) { seek(t ? startOf(t) : 0); return; }
  state.index = state.index > 0 ? state.index - 1 : state.queue.length - 1;
  load(true);
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// tracks を再生キューにして startIndex の曲から再生する
export function playList(tracks, startIndex = 0, { shuffle = state.shuffle, autoplay = true } = {}) {
  if (!tracks.length) return;
  state.original = tracks.slice();
  state.shuffle = shuffle;
  if (shuffle) {
    const first = tracks[startIndex] ?? tracks[0];
    const rest = shuffled(tracks.filter((t) => t !== first));
    state.queue = startIndex < 0 ? shuffled(tracks) : [first, ...rest];
    state.index = 0;
  } else {
    state.queue = tracks.slice();
    state.index = Math.max(0, startIndex);
  }
  emit('queue');
  load(autoplay);
}

export function setShuffle(on) {
  state.shuffle = on;
  const t = current();
  if (!t) { emit('queue'); return; }
  if (on) {
    const rest = shuffled(state.queue.filter((x) => x !== t));
    state.queue = [t, ...rest];
    state.index = 0;
  } else {
    state.queue = state.original.filter((x) => state.queue.includes(x));
    state.index = Math.max(0, state.queue.indexOf(t));
  }
  emit('queue');
}

export function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  emit('queue');
}

export function playNext(track) {
  if (!state.queue.length) { playList([track]); return; }
  state.queue.splice(state.index + 1, 0, track);
  state.original.push(track);
  emit('queue');
}

export function jumpTo(i) {
  state.index = i;
  load(true);
}

// 曲が削除・編集されたときにキューを更新する
export function removeFromQueue(id) {
  const t = current();
  state.queue = state.queue.filter((x) => x.id !== id);
  state.original = state.original.filter((x) => x.id !== id);
  if (t?.id === id) {
    if (state.index >= state.queue.length) state.index = state.queue.length - 1;
    if (state.queue.length) load(false); else { state.index = -1; stopAll(); emit('change', null); }
  } else {
    state.index = state.queue.indexOf(t);
  }
  emit('queue');
}

export function refreshMeta() {
  const t = current();
  if (t) updateMediaSession(t);
}

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* 未対応 */ } };
  set('play', play);
  set('pause', pause);
  set('previoustrack', prev);
  set('nexttrack', () => next());
  set('seekto', (d) => seek(d.seekTime));
  set('seekbackward', (d) => seek(Math.max(0, currentTime() - (d.seekOffset || 10))));
  set('seekforward', (d) => seek(currentTime() + (d.seekOffset || 10)));
}
