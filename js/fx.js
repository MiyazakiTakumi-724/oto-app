// 音質・加工の設定と Web Audio の処理グラフ
// 曲(<audio>) → 音量補正 → フェード → ボーカル/伴奏 → ステレオ拡張 → イコライザー → ナイトモード(コンプレッサー)
//   → 立体音響(8D・バーチャルサラウンド) → リバーブ → ビジュアライザー用の解析 → スピーカー

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
  bass: { name: '低音強調', eq: [5, 2, 0, 0, 0] },
  vocal: { name: 'ボーカル', eq: [-1, -1, 2, 3, 1] },
  clear: { name: 'クリア', eq: [0, 0, 0, 2, 4] },
  rock: { name: 'ロック', eq: [3, 1, -1, 1, 3] },
  acoustic: { name: 'アコースティック', eq: [2, 1, 0, 1, 2] },
};

const DEFAULTS = {
  volume: 70,          // 音量 % (0〜100)。100で元の大きさ
  crossfade: 0,        // 秒。0 でオフ
  trimSilence: false,  // 曲の最初と最後の無音を飛ばす
  normalize: false,    // 曲ごとの音量差をならす
  preset: 'flat',
  eq: [0, 0, 0, 0, 0], // dB
  night: false,        // 小さい音を持ち上げ、大きい音を抑える
  reverb: 0,           // 0〜100
  speed: 1,            // 再生速度(音程はそのまま)
  vocal: 100,          // ボーカルの音量 % (0〜200)
  inst: 100,           // 伴奏の音量 % (0〜200)
  width: 0,            // ステレオ拡張 0〜100
  spatial: 'off',      // off | 8d | surround
  rotation: 8,         // 8Dオーディオが1周する秒数
  visualizer: false,
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

// 音量はそのままにして、ほかの設定を元に戻す
export function reset() {
  update({ ...DEFAULTS, eq: DEFAULTS.eq.slice(), volume: settings.volume });
}

// スライダーの位置(%)を音量の倍率にする。耳の感じ方に合わせて2乗のカーブにする(70%で約−6dB)
export const volumeGain = (v = settings.volume) => Math.pow(Math.max(0, Math.min(100, v)) / 100, 2);

// <audio> の volume が効くか(iPhone・iPadでは無視されるので、音声処理の側で下げる)
export const nativeVolume = (() => {
  try {
    const a = new Audio();
    a.volume = 0.5;
    return Math.abs(a.volume - 0.5) < 0.01;
  } catch {
    return false;
  }
})();

// <audio> に設定する音量。音声処理を使っているときは処理の最後で下げるので 1
export const elementVolume = () => (graph || !nativeVolume ? 1 : volumeGain());

// 音声処理グラフが必要な設定か(再生速度と無音カットは <audio> だけで実現できる)
export const needsGraph = () => !!graph || settings.crossfade > 0 || settings.normalize ||
  settings.night || settings.reverb > 0 || settings.eq.some((g) => g !== 0) ||
  settings.vocal !== 100 || settings.inst !== 100 || settings.width > 0 ||
  settings.spatial !== 'off' || settings.visualizer || (!nativeVolume && settings.volume !== 100);

export const hasGraph = () => !!graph;

const dbToGain = (db) => Math.pow(10, db / 20);
const LIMITER_MAKEUP = dbToGain(-0.8);

let graph = null;

// 残響のインパルス応答: 初期反射(壁からの最初の跳ね返り)と、高音ほど早く消える残響を作る
function makeImpulse(ctx, { seconds, predelay, rt60, reflections, damping }) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  const pre = Math.floor(rate * predelay);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // 初期反射: 左右で少しずつ違う時間・強さにする
    reflections.forEach(([ms, g], k) => {
      const i = Math.floor(rate * (ms + (ch ? 1.7 : 0) * ((k % 3) - 1)) / 1000);
      if (i >= 0 && i < len) d[i] += g * (k % 2 ? -1 : 1);
    });
    // 残響: 指数的に減衰するノイズを、時間とともに強くなるローパスに通す
    let y = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / rate;
      const env = Math.pow(10, (-3 * t) / rt60);
      const fade = Math.min(1, t / 0.03); // 立ち上がりを滑らかに
      const a = Math.max(0.08, 0.85 * Math.exp(-t * damping));
      y += a * ((Math.random() * 2 - 1) - y);
      d[i] += y * env * fade * 0.6;
    }
    // 終わりを滑らかに
    const tail = Math.floor(rate * 0.05);
    for (let i = 0; i < tail; i++) d[len - 1 - i] *= i / tail;
  }
  // 残響の大きさを一定にする(エネルギーを1に)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let e = 0;
    for (let i = 0; i < len; i++) e += d[i] * d[i];
    const k = 1 / Math.sqrt(e || 1);
    for (let i = 0; i < len; i++) d[i] *= k;
  }
  return buf;
}

const HALL = {
  seconds: 2.6, predelay: 0.022, rt60: 1.8, damping: 2.2,
  reflections: [[11, 0.5], [19, 0.42], [27, 0.36], [36, 0.3], [48, 0.25], [61, 0.2], [77, 0.16]],
};
const ROOM = {
  seconds: 0.6, predelay: 0.008, rt60: 0.3, damping: 4,
  reflections: [[7, 0.32], [10.5, 0.27], [13, 0.24], [17, 0.2], [22, 0.17], [28, 0.14], [35, 0.11]],
};

function biquad(ctx, type, f, q) {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  if (q !== undefined) b.Q.value = q;
  return b;
}

// 2次バターワースを2段重ねた急な(24dB/oct)フィルター。低域側と高域側を足すと、位相だけが回る素通しになる
function lr4(ctx, type, f) {
  const a = biquad(ctx, type, f, Math.SQRT1_2);
  const b = biquad(ctx, type, f, Math.SQRT1_2);
  a.connect(b);
  return { in: a, out: b };
}

// ボーカル/伴奏: 左右の中央にある声の帯域(150Hz〜6kHz)をボーカルとみなし、残りを伴奏として音量を分ける
// 出力 = 位相をそろえた入力 × 伴奏 + 中央の声帯域 × (ボーカル − 伴奏)。
// 声帯域を取り出すフィルターと同じだけ入力側の位相も回すので、引き算しても音がにごらない
function buildVocalStage(ctx, input) {
  const out = ctx.createGain();
  const inst = ctx.createGain();
  const ap1 = biquad(ctx, 'allpass', 150, Math.SQRT1_2);
  const ap2 = biquad(ctx, 'allpass', 6000, Math.SQRT1_2);
  input.connect(ap1).connect(ap2).connect(inst).connect(out);
  // ボーカルと伴奏が同じ音量なら、位相を回さずにそのまま通す
  const direct = ctx.createGain();
  input.connect(direct).connect(out);

  const split = ctx.createChannelSplitter(2);
  const mid = ctx.createGain();
  mid.gain.value = 0.5;
  input.connect(split);
  split.connect(mid, 0);
  split.connect(mid, 1);
  const hp = lr4(ctx, 'highpass', 150);
  const lp = lr4(ctx, 'lowpass', 6000);
  mid.connect(hp.in);
  hp.out.connect(lp.in);
  const merge = ctx.createChannelMerger(2);
  lp.out.connect(merge, 0, 0);
  lp.out.connect(merge, 0, 1);
  const diff = ctx.createGain();
  merge.connect(diff).connect(out);
  return { out, inst, diff, direct };
}

// ステレオ拡張: 左右の差(サイド成分 (L−R)/2)のうち 300Hz より上だけを強める。低音は中央のままなので自然に広がる
function buildWidthStage(ctx, input) {
  const out = ctx.createChannelMerger(2);
  const split = ctx.createChannelSplitter(2);
  input.connect(split);
  const side = ctx.createGain();
  const l = ctx.createGain();
  const r = ctx.createGain();
  l.gain.value = 0.5;
  r.gain.value = -0.5;
  split.connect(l, 0).connect(side);
  split.connect(r, 1).connect(side);
  const hp = biquad(ctx, 'highpass', 300, Math.SQRT1_2);
  const amount = ctx.createGain();
  amount.gain.value = 0;
  const neg = ctx.createGain();
  neg.gain.value = -1;
  side.connect(hp).connect(amount);
  amount.connect(out, 0, 0);
  amount.connect(neg).connect(out, 0, 1);
  split.connect(out, 0, 0);
  split.connect(out, 1, 1);
  // 広げた分だけ音が大きく聞こえるので、少し下げる
  const level = ctx.createGain();
  out.connect(level);
  return { out: level, amount, level };
}

// 発振器の値(-1〜1)を、曲線 fn で変換した信号にする
function shaper(ctx, fn) {
  const ws = ctx.createWaveShaper();
  const n = 1025;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = fn((i / (n - 1)) * 2 - 1);
  ws.curve = curve;
  return ws;
}

// 立体音響: 何もしない経路・8Dオーディオ・バーチャルサラウンドを用意して、音量で切り替える
const SUR_XOVER = 160;  // これより下の低音は仮想スピーカーを通さない
const SUR_REAR = 0.6;   // 後ろのスピーカーの大きさ
const SUR_MAKEUP = 0.85;   // HRTFで変わった音量の補正
// HRTFを通すと200Hz付近がふくらみ、高音が少しこもるので、元の音色に近づける補正
const SUR_EQ = [['peaking', 160, 1, -14], ['peaking', 420, 1, -2], ['peaking', 1400, 1, 3.5], ['peaking', 6500, 1.5, 2.5], ['peaking', 10500, 1.2, 4.5]];

function buildSpatialStage(ctx, input) {
  const out = ctx.createGain();
  const dry = ctx.createGain();
  input.connect(dry).connect(out);

  // 8D: 左右の音はそのまま残し、音全体をゆっくり左右に振る。後ろを通るときは高音を少し落として遠く感じさせる
  // 位置は発振器で動かすので、画面を閉じても滑らかに回る
  const d8 = ctx.createGain();
  const sin = ctx.createOscillator();
  const cos = ctx.createOscillator();
  cos.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0])));
  const depth = ctx.createGain();
  depth.gain.value = 0.7; // 振る幅(1で片側に寄り切る)
  sin.connect(depth);
  // 一定パワーのパン: 中央で左右とも1、片側に寄ると最大 √2 と 0 に近づく
  const gainL = shaper(ctx, (p) => Math.SQRT2 * Math.cos(((p + 1) * Math.PI) / 4));
  const gainR = shaper(ctx, (p) => Math.SQRT2 * Math.sin(((p + 1) * Math.PI) / 4));
  depth.connect(gainL);
  depth.connect(gainR);
  // 元のステレオを少し中央に寄せてから振る(左右が逆になっても違和感が出ないように)
  const split8 = ctx.createChannelSplitter(2);
  input.connect(split8);
  const merge8 = ctx.createChannelMerger(2);
  const narrow = (a, b) => {
    const g = ctx.createGain();
    const ga = ctx.createGain();
    const gb = ctx.createGain();
    ga.gain.value = 0.75;
    gb.gain.value = 0.25;
    split8.connect(ga, a).connect(g);
    split8.connect(gb, b).connect(g);
    return g;
  };
  const vl = ctx.createGain();
  const vr = ctx.createGain();
  vl.gain.value = 0;
  vr.gain.value = 0;
  gainL.connect(vl.gain);
  gainR.connect(vr.gain);
  narrow(0, 1).connect(vl).connect(merge8, 0, 0);
  narrow(1, 0).connect(vr).connect(merge8, 0, 1);
  const behind = biquad(ctx, 'highshelf', 3000);
  behind.gain.value = -2.5;
  const shelfMod = ctx.createGain();
  shelfMod.gain.value = 2.5; // 正面で 0dB、真後ろで −5dB
  cos.connect(shelfMod).connect(behind.gain);
  merge8.connect(behind).connect(d8).connect(out);
  sin.start();
  cos.start();

  // バーチャルサラウンド: 頭のまわりに仮想のスピーカーを置き、そこから鳴っているように聞かせる(HRTF)
  // 前の2本(左右30°)に元の左右、後ろの2本(左右110°)に左右の差(響きや広がりの成分)を少し遅らせて送る。
  // 低音は向きが分かりにくく、HRTFを通すと痩せるので、そのまま通す
  const sur = ctx.createGain();
  const virt = ctx.createGain();
  const splitS = ctx.createChannelSplitter(2);
  input.connect(splitS);
  const mergeLow = ctx.createChannelMerger(2);
  const high = [0, 1].map((c) => {
    const lo = lr4(ctx, 'lowpass', SUR_XOVER);
    const hi = lr4(ctx, 'highpass', SUR_XOVER);
    splitS.connect(lo.in, c);
    splitS.connect(hi.in, c);
    lo.out.connect(mergeLow, 0, c);
    return hi.out;
  });
  // 仮想スピーカーとの境目(160Hz付近)で低音が少しふくらむので抑える
  const lowTrim = biquad(ctx, 'peaking', 120, 0.8);
  lowTrim.gain.value = -3;
  const surOut = ctx.createGain();
  sur.connect(lowTrim).connect(surOut);
  mergeLow.connect(sur);
  const speaker = (src, deg, gain) => {
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'linear';
    p.rolloffFactor = 0; // 距離で小さくしない
    p.channelCount = 1;
    p.channelCountMode = 'explicit';
    const a = (deg * Math.PI) / 180;
    if (p.positionX) {
      p.positionX.value = Math.sin(a);
      p.positionY.value = 0;
      p.positionZ.value = -Math.cos(a);
    } else {
      p.setPosition(Math.sin(a), 0, -Math.cos(a));
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(p).connect(virt);
  };
  speaker(high[0], -30, 1);
  speaker(high[1], 30, 1);
  // 後ろ: 左右の差を取り出し、左右で遅れをずらして(15ms / 21ms)前の音と混ざらないようにする
  const side = ctx.createGain();
  side.gain.value = 0.5;
  const invR = ctx.createGain();
  invR.gain.value = -1;
  high[0].connect(side);
  high[1].connect(invR).connect(side);
  const rear = (ms, sign, deg) => {
    const d = ctx.createDelay(0.05);
    d.delayTime.value = ms / 1000;
    const lp = biquad(ctx, 'lowpass', 7000);
    const g = ctx.createGain();
    g.gain.value = sign;
    side.connect(d).connect(lp).connect(g);
    speaker(g, deg, SUR_REAR);
  };
  rear(15, 1, -110);
  rear(21, -1, 110);
  let tone = virt;
  SUR_EQ.forEach(([type, f, q, gain]) => {
    const b = biquad(ctx, type, f, q);
    b.gain.value = gain;
    tone = tone.connect(b);
  });
  const comp = ctx.createGain();
  comp.gain.value = SUR_MAKEUP;
  tone.connect(comp).connect(sur);
  // 小さな部屋の反射を少し足して、スピーカーに囲まれている感じを出す
  const room = ctx.createConvolver();
  room.normalize = false;
  room.buffer = makeImpulse(ctx, ROOM);
  const roomGain = ctx.createGain();
  roomGain.gain.value = 0.12;
  comp.connect(room).connect(roomGain).connect(sur);
  surOut.connect(out);

  return { out, dry, d8, sur: surOut, osc: [sin, cos] };
}

// decks: [{ el: HTMLAudioElement }, ...]。ユーザー操作の中で呼ぶこと(AudioContext の起動制限のため)
export function ensureGraph(decks) {
  if (!graph) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      const ctx = new AC();
      const input = ctx.createGain();
      const preamp = ctx.createGain();
      const eq = BANDS.map((b) => {
        const f = biquad(ctx, b.type, b.f);
        if (b.type === 'peaking') f.Q.value = 0.9;
        return f;
      });
      const comp = ctx.createDynamicsCompressor();
      const makeup = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const revHp = biquad(ctx, 'highpass', 180, Math.SQRT1_2);
      const conv = ctx.createConvolver();
      conv.normalize = false;
      const mix = ctx.createGain();
      // 最後の安全装置: 加工で音が大きくなりすぎたときだけ、割れないように抑える
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1.5;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.15;
      const volume = ctx.createGain();

      const vocal = buildVocalStage(ctx, input);
      const width = buildWidthStage(ctx, vocal.out);
      let node = width.out.connect(preamp);
      eq.forEach((f) => { node.connect(f); node = f; });
      node.connect(comp).connect(makeup);
      const spatial = buildSpatialStage(ctx, makeup);
      spatial.out.connect(dry).connect(mix);
      spatial.out.connect(revHp).connect(conv).connect(wet).connect(mix);
      mix.connect(volume).connect(limiter).connect(ctx.destination);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      mix.connect(analyser);

      graph = { ctx, input, preamp, eq, comp, makeup, dry, wet, conv, vocal, width, spatial, analyser, volume, impulse: false };
      decks.forEach((d) => {
        d.src = ctx.createMediaElementSource(d.el);
        d.norm = ctx.createGain();
        d.fade = ctx.createGain();
        d.src.connect(d.norm).connect(d.fade).connect(input);
        d.el.volume = 1;
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
  const { ctx, eq, comp, makeup, wet, dry, conv } = graph;
  const now = ctx.currentTime;
  const glide = (p, v, t = 0.05) => p.setTargetAtTime(v, now, t);

  // ブラウザのリミッターは常に少し(約0.8dB)持ち上げるので、その分を差し引く
  glide(graph.volume.gain, volumeGain() * LIMITER_MAKEUP, 0.03);

  // イコライザーで持ち上げた分だけ先に下げて、音割れを防ぐ
  const boost = Math.max(0, ...settings.eq);
  glide(graph.preamp.gain, dbToGain(-boost * 0.8));
  eq.forEach((f, i) => glide(f.gain, settings.eq[i] || 0));

  // ナイトモード: ゆるやかに圧縮する(ブラウザの圧縮器は自動で音量を持ち上げるので、補正は控えめ)
  if (settings.night) {
    comp.threshold.value = -26;
    comp.knee.value = 18;
    comp.ratio.value = 3;
    comp.attack.value = 0.02;
    comp.release.value = 0.35;
    glide(makeup.gain, dbToGain(-2));
  } else {
    comp.threshold.value = 0;
    comp.knee.value = 0;
    comp.ratio.value = 1;
    glide(makeup.gain, 1);
  }

  if (settings.reverb > 0 && !graph.impulse) {
    conv.buffer = makeImpulse(ctx, HALL);
    graph.impulse = true;
  }
  const r = settings.reverb / 100;
  glide(wet.gain, r * 0.32);
  glide(dry.gain, 1 - r * 0.2);

  const { vocal, width, spatial } = graph;
  const v = settings.vocal / 100;
  const i = settings.inst / 100;
  const same = v === i;
  glide(vocal.direct.gain, same ? i : 0);
  glide(vocal.inst.gain, same ? 0 : i);
  glide(vocal.diff.gain, same ? 0 : v - i);

  glide(width.amount.gain, (settings.width / 100) * 0.7);
  glide(width.level.gain, dbToGain((-settings.width / 100) * 1.5));

  const mode = settings.spatial;
  glide(spatial.dry.gain, mode === 'off' ? 1 : 0, 0.08);
  glide(spatial.d8.gain, mode === '8d' ? 1 : 0, 0.08);
  glide(spatial.sur.gain, mode === 'surround' ? 1 : 0, 0.08);
  spatial.osc.forEach((o) => o.frequency.setValueAtTime(1 / Math.max(2, settings.rotation), now));
}

// ビジュアライザー用: 周波数ごとの大きさ(0〜255)を buf に入れる。音声処理を使っていなければ false
export function readSpectrum(buf) {
  if (!graph) return false;
  graph.analyser.getByteFrequencyData(buf);
  return true;
}

export const spectrumSize = () => (graph ? graph.analyser.frequencyBinCount : 0);

// 曲ごとの音量補正: 平均の大きさを目標にそろえる。小さい曲を持ち上げるのは控えめにし、音が割れない範囲にとどめる
const NORM_TARGET = -20;
function normGain(a) {
  if (!a || typeof a.loud !== 'number') return 0;
  return Math.max(-12, Math.min(6, NORM_TARGET - a.loud, -1 - a.peakDb));
}
// 曲ごとの音量補正(解析結果の dB)
export function setNorm(deck, track) {
  if (!graph || !deck.norm) return;
  const db = settings.normalize ? normGain(track?.analysis) : 0;
  deck.norm.gain.setTargetAtTime(dbToGain(db), graph.ctx.currentTime, 0.15);
}

export function setFade(deck, v) {
  if (!graph || !deck.fade) return;
  const p = deck.fade.gain;
  p.cancelScheduledValues(graph.ctx.currentTime);
  p.setValueAtTime(v, graph.ctx.currentTime);
}

// 一定パワーのカーブでフェードする(直線だと重なりの真ん中で音が痩せて聞こえる)
export function rampFade(deck, to, seconds) {
  if (!graph || !deck.fade) return;
  const p = deck.fade.gain;
  const now = graph.ctx.currentTime;
  const from = p.value;
  p.cancelScheduledValues(now);
  const n = 64;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const shape = to > from ? Math.sin((x * Math.PI) / 2) : 1 - Math.cos((x * Math.PI) / 2);
    curve[i] = from + (to - from) * shape;
  }
  try {
    p.setValueCurveAtTime(curve, now, seconds);
  } catch {
    p.setValueAtTime(from, now);
    p.linearRampToValueAtTime(to, now + seconds);
  }
}

// ---------- 解析(音量と無音区間) ----------
const ANALYSIS_VERSION = 2;

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

  const sec = (b) => (b * block) / buf.sampleRate;
  return {
    v: ANALYSIS_VERSION,
    loud: Math.round(loud * 10) / 10,
    peakDb: Math.round(peakDb * 10) / 10,
    start: Math.max(0, sec(first) - 0.05),
    end: Math.min(buf.duration, sec(last + 1) + 0.15),
    duration: buf.duration,
  };
}
