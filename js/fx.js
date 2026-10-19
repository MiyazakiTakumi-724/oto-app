// 音質・加工の設定と Web Audio の処理グラフ
// 曲(<audio>) → 音量補正 → フェード → イコライザー → ナイトモード(コンプレッサー) → リバーブ → スピーカー

const KEY = 'oto.fx';

export const BANDS = [
  { f: 60, type: 'lowshelf', label: '60Hz' },
  { f: 230, type: 'peaking', label: '230Hz' },
  { f: 910, type: 'peaking', label: '910Hz' },
  { f: 3600, type: 'peaking', label: '3.6kHz' },
  { f: 14000, type: 'highshelf', label: '14kHz' },
];

export const PRESETS = {
  flat: { name: 'フラット', eq: [0, 0, 0, 0, 0] },
  bass: { name: '低音強調', eq: [6, 3, 0, 0, 0] },
  vocal: { name: 'ボーカル', eq: [-2, -1, 3, 4, 1] },
  clear: { name: 'クリア', eq: [0, 0, 0, 3, 5] },
  rock: { name: 'ロック', eq: [4, 2, -1, 2, 4] },
  acoustic: { name: 'アコースティック', eq: [2, 1, 1, 2, 2] },
};

const DEFAULTS = {
  crossfade: 0,        // 秒。0 でオフ
  trimSilence: false,  // 曲の最初と最後の無音を飛ばす
  normalize: false,    // 曲ごとの音量差をならす
  preset: 'flat',
  eq: [0, 0, 0, 0, 0], // dB
  night: false,        // 小さい音を持ち上げ、大きい音を抑える
  reverb: 0,           // 0〜100
  speed: 1,            // 再生速度(音程はそのまま)
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...s, eq: Array.isArray(s.eq) && s.eq.length === 5 ? s.eq : DEFAULTS.eq.slice() };
  } catch {
    return { ...DEFAULTS, eq: DEFAULTS.eq.slice() };
  }
}

export const settings = loadSettings();

const listeners = [];
export const onChange = (fn) => listeners.push(fn);

export function update(patch) {
  Object.assign(settings, patch);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* 保存できなくても今回は反映する */ }
  apply();
  listeners.forEach((fn) => fn());
}

export function reset() {
  update({ ...DEFAULTS, eq: DEFAULTS.eq.slice() });
}

// 音声処理グラフが必要な設定か(再生速度と無音カットは <audio> だけで実現できる)
export const needsGraph = () => !!graph || settings.crossfade > 0 || settings.normalize ||
  settings.night || settings.reverb > 0 || settings.eq.some((g) => g !== 0);

export const hasGraph = () => !!graph;

const dbToGain = (db) => Math.pow(10, db / 20);

let graph = null;

// 残響を作るためのインパルス応答(ホールのような減衰するノイズ)
function makeImpulse(ctx, seconds = 2.4) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}

// decks: [{ el: HTMLAudioElement }, ...]。ユーザー操作の中で呼ぶこと(AudioContext の起動制限のため)
export function ensureGraph(decks) {
  if (!graph) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      const ctx = new AC();
      const input = ctx.createGain();
      const eq = BANDS.map((b) => {
        const f = ctx.createBiquadFilter();
        f.type = b.type;
        f.frequency.value = b.f;
        if (b.type === 'peaking') f.Q.value = 1.1;
        return f;
      });
      const comp = ctx.createDynamicsCompressor();
      const makeup = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const conv = ctx.createConvolver();
      const master = ctx.createGain();

      let node = input;
      eq.forEach((f) => { node.connect(f); node = f; });
      node.connect(comp).connect(makeup);
      makeup.connect(dry).connect(master);
      makeup.connect(conv).connect(wet).connect(master);
      master.connect(ctx.destination);

      graph = { ctx, input, eq, comp, makeup, dry, wet, conv, impulse: false };
      decks.forEach((d) => {
        d.src = ctx.createMediaElementSource(d.el);
        d.norm = ctx.createGain();
        d.fade = ctx.createGain();
        d.src.connect(d.norm).connect(d.fade).connect(input);
      });
      apply();
    } catch (e) {
      console.warn(e);
      graph = null;
      return false;
    }
  }
  if (graph.ctx.state !== 'running') graph.ctx.resume().catch(() => {});
  return true;
}

export function resume() {
  if (graph && graph.ctx.state !== 'running') graph.ctx.resume().catch(() => {});
}

function apply() {
  if (!graph) return;
  const { ctx, eq, comp, makeup, wet, conv } = graph;
  const now = ctx.currentTime;
  eq.forEach((f, i) => f.gain.setTargetAtTime(settings.eq[i] || 0, now, 0.05));
  if (settings.night) {
    comp.threshold.value = -30;
    comp.knee.value = 12;
    comp.ratio.value = 5;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    makeup.gain.setTargetAtTime(dbToGain(9), now, 0.05);
  } else {
    comp.threshold.value = 0;
    comp.ratio.value = 1;
    makeup.gain.setTargetAtTime(1, now, 0.05);
  }
  if (settings.reverb > 0 && !graph.impulse) {
    conv.buffer = makeImpulse(ctx);
    graph.impulse = true;
  }
  wet.gain.setTargetAtTime((settings.reverb / 100) * 0.6, now, 0.05);
}

// 曲ごとの音量補正(解析結果の dB)
export function setNorm(deck, track) {
  if (!graph || !deck.norm) return;
  const db = settings.normalize ? (track?.analysis?.gainDb || 0) : 0;
  deck.norm.gain.setTargetAtTime(dbToGain(db), graph.ctx.currentTime, 0.15);
}

export function setFade(deck, v) {
  if (!graph || !deck.fade) return;
  const p = deck.fade.gain;
  p.cancelScheduledValues(graph.ctx.currentTime);
  p.setValueAtTime(v, graph.ctx.currentTime);
}

export function rampFade(deck, to, seconds) {
  if (!graph || !deck.fade) return;
  const p = deck.fade.gain;
  const now = graph.ctx.currentTime;
  p.cancelScheduledValues(now);
  p.setValueAtTime(p.value, now);
  p.linearRampToValueAtTime(to, now + seconds);
}

// ---------- 解析(音量と無音区間) ----------
const ANALYSIS_VERSION = 1;

export const needsAnalysis = (t) => t?.type === 'file' && t.analysis?.v !== ANALYSIS_VERSION;

export async function analyze(blob) {
  const rate = 22050;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(1, 1, rate);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const block = Math.floor(buf.sampleRate * 0.05);
  const blocks = Math.floor(buf.length / block);
  const levels = new Float32Array(blocks);
  let peak = 0;
  for (let b = 0; b < blocks; b++) {
    let sum = 0;
    for (const d of chans) {
      for (let i = b * block, e = i + block; i < e; i++) {
        const x = d[i];
        sum += x * x;
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
      }
    }
    levels[b] = sum / (block * chans.length);
  }
  const toDb = (p) => 10 * Math.log10(p + 1e-12);
  let first = 0;
  while (first < blocks && toDb(levels[first]) < -60) first++;
  let last = blocks - 1;
  while (last > first && toDb(levels[last]) < -60) last--;

  // 平均の大きさ(ゲート付き): まず -70dB 以上の区間の平均を出し、それより 20dB 以上小さい区間は除いて測り直す
  const gatedMean = (gateDb) => {
    let sum = 0;
    let n = 0;
    for (let b = first; b <= last; b++) {
      if (toDb(levels[b]) > gateDb) { sum += levels[b]; n++; }
    }
    return n ? toDb(sum / n) : null;
  };
  const rough = gatedMean(-70);
  const loud = rough === null ? -18 : (gatedMean(rough - 20) ?? rough);
  const peakDb = 20 * Math.log10(peak + 1e-9);
  const target = -18;
  const gainDb = Math.max(-12, Math.min(9, target - loud, -0.5 - peakDb));

  const sec = (b) => (b * block) / buf.sampleRate;
  return {
    v: ANALYSIS_VERSION,
    gainDb: Math.round(gainDb * 10) / 10,
    start: Math.max(0, sec(first) - 0.05),
    end: Math.min(buf.duration, sec(last + 1) + 0.15),
    duration: buf.duration,
  };
}
