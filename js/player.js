// 再生エンジン: 端末のファイルは <audio>、YouTubeは公式 IFrame Player API で再生する
import { getBlob } from './db.js';

const audio = new Audio();
audio.preload = 'auto';

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

let objectUrl = null;
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
    const t = current();
    const data = yt.getVideoData?.();
    if (t && data?.title && t.titlePending) emit('yt-title', t, data.title, data.author);
  }
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

audio.addEventListener('play', () => current()?.type === 'file' && setPlaying(true));
audio.addEventListener('pause', () => current()?.type === 'file' && setPlaying(false));
audio.addEventListener('ended', () => ended());
audio.addEventListener('timeupdate', () => {
  emit('time', audio.currentTime, audio.duration || current()?.duration || 0);
  updatePositionState();
});
audio.addEventListener('error', () => {
  if (current()?.type === 'file' && audio.src) emit('error', 'このファイルは再生できません');
});

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = audio.duration;
  if (!Number.isFinite(d) || d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: audio.playbackRate });
  } catch { /* 一部ブラウザは未対応 */ }
}

function ended() {
  if (state.repeat === 'one') { seek(0); play(); return; }
  next(true);
}

async function load(autoplay = true) {
  const token = ++loadToken;
  const t = current();
  emit('change', t);
  if (!t) { stopAll(); return; }

  if (t.type === 'file') {
    if (yt?.pauseVideo) yt.pauseVideo();
    clearInterval(ytTimer);
    emit('yt-visible', false);
    const blob = await getBlob(t.id);
    if (token !== loadToken) return;
    if (!blob) { emit('error', '音声データが見つかりません'); return; }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    audio.src = objectUrl;
    if (autoplay) audio.play().catch(() => setPlaying(false));
  } else {
    audio.pause();
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

function stopAll() {
  audio.pause();
  if (yt?.stopVideo) yt.stopVideo();
  emit('yt-visible', false);
  setPlaying(false);
}

function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  const artwork = t.artUrl ? [{ src: t.artUrl, sizes: '512x512', type: 'image/jpeg' }] : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist || '', album: t.album || '', artwork,
  });
}

export function play() {
  const t = current();
  if (!t) return;
  if (t.type === 'file') audio.play().catch(() => {});
  else yt?.playVideo?.();
}

export function pause() {
  const t = current();
  if (!t) return;
  if (t.type === 'file') audio.pause();
  else yt?.pauseVideo?.();
}

export const toggle = () => (state.playing ? pause() : play());

export function seek(sec) {
  const t = current();
  if (!t) return;
  if (t.type === 'file') audio.currentTime = sec;
  else yt?.seekTo?.(sec, true);
}

export function currentTime() {
  return current()?.type === 'youtube' ? (yt?.getCurrentTime?.() || 0) : audio.currentTime;
}

export function next(auto = false) {
  if (!state.queue.length) return;
  if (state.index < state.queue.length - 1) state.index++;
  else if (state.repeat === 'all' || !auto) state.index = 0;
  else { pause(); seek(0); return; }
  load(true);
}

export function prev() {
  if (!state.queue.length) return;
  if (currentTime() > 3) { seek(0); return; }
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
