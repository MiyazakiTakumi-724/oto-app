// ボーカルと伴奏を分ける処理(AudioWorklet の中で動く)。
// 左右の音を短い区間ごとに周波数に分け、左右でそろって鳴っている(中央にある)成分をボーカル、残りを伴奏とみなす。
// それぞれの音量を変えてから、元の音に組み立て直す
const N = 2048;          // 1回に見る長さ(48kHzで約43ms)
const HOP = N / 4;       // 次の区間までのずらし幅(4分の3ずつ重ねる)
const SMOOTH = 0.55;     // 左右のそろい方を、時間方向にならす強さ(ばらつきによる「シュワシュワ」した音を防ぐ)

// 長さ n(2のべき乗)の複素FFT。inverse のときは逆変換(1/n は掛けない)
function makeFFT(n) {
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return (re, im, inverse) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < half; j++) {
          const wr = cos[j * step];
          const wi = sign * sin[j * step];
          const a = start + j;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  };
}

class CenterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'vocal', defaultValue: 1, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
      { name: 'inst', defaultValue: 1, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
      // 0 のあいだは処理を休む(ボーカルと伴奏が同じ音量のときは、この処理を通さない)
      { name: 'active', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.fft = makeFFT(N);
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    this.inL = new Float32Array(N);
    this.inR = new Float32Array(N);
    this.accL = new Float32Array(N);
    this.accR = new Float32Array(N);
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    const bins = N / 2 + 1;
    this.pLL = new Float32Array(bins);
    this.pRR = new Float32Array(bins);
    this.cRe = new Float32Array(bins);
    this.cIm = new Float32Array(bins);
    // ボーカルとみなす帯域: 140Hz〜8kHz(端はなだらかに)。それより低い音と高い音は伴奏として扱う
    this.band = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      const f = (k * sampleRate) / N;
      this.band[k] = Math.min(1, Math.max(0, (f - 90) / 50)) * Math.min(1, Math.max(0, (12000 - f) / 4000));
    }
    this.rest();
  }

  rest() {
    this.resting = true;
    for (const a of [this.inL, this.inR, this.accL, this.accR, this.pLL, this.pRR, this.cRe, this.cIm]) a.fill(0);
    this.count = 0;  // 前の区間から入ってきたサンプル数
    this.read = HOP; // 出し終えた位置(HOP なら、次の区間ができるまで出すものがない)
  }

  process(inputs, outputs, params) {
    const out = outputs[0];
    const oL = out[0];
    const oR = out[1] || out[0];
    const input = inputs[0];
    if (params.active[0] < 0.5 || !input || !input.length) {
      if (!this.resting) this.rest();
      oL.fill(0);
      oR.fill(0);
      return true;
    }
    this.resting = false;
    const iL = input[0];
    const iR = input[1] || input[0];
    const n = iL.length;
    // 新しい音を後ろに足し、古い分を前に詰める
    this.inL.copyWithin(0, n);
    this.inL.set(iL, N - n);
    this.inR.copyWithin(0, n);
    this.inR.set(iR, N - n);
    this.count += n;
    if (this.count >= HOP) {
      this.count = 0;
      this.frame(params.vocal[0], params.inst[0]);
      this.read = 0;
    }
    if (this.read < HOP) {
      oL.set(this.accL.subarray(this.read, this.read + n));
      oR.set(this.accR.subarray(this.read, this.read + n));
      this.read += n;
    } else {
      oL.fill(0);
      oR.fill(0);
    }
    return true;
  }

  frame(vocal, inst) {
    const { re, im, win, accL, accR, pLL, pRR, cRe, cIm, band } = this;
    // 左を実部、右を虚部に入れて、1回の変換で両方を周波数に分ける
    for (let i = 0; i < N; i++) {
      re[i] = this.inL[i] * win[i];
      im[i] = this.inR[i] * win[i];
    }
    this.fft(re, im, false);
    const a = SMOOTH;
    const b = 1 - SMOOTH;
    const amt = vocal - inst;
    for (let k = 0; k <= N / 2; k++) {
      const j = (N - k) & (N - 1);
      const zr = re[k];
      const zi = im[k];
      const wr = re[j];
      const wi = im[j];
      const lr = (zr + wr) * 0.5; // 左
      const li = (zi - wi) * 0.5;
      const rr = (zi + wi) * 0.5; // 右
      const ri = (wr - zr) * 0.5;
      // 左右それぞれの強さと、左右のそろい具合(相互相関)を時間方向にならして求める
      const pl = (pLL[k] = a * pLL[k] + b * (lr * lr + li * li));
      const pr = (pRR[k] = a * pRR[k] + b * (rr * rr + ri * ri));
      const cr = (cRe[k] = a * cRe[k] + b * (lr * rr + li * ri));
      const ci = (cIm[k] = a * cIm[k] + b * (li * rr - lr * ri));
      // 中央の成分の強さ ≒ |相互相関|、左右に分かれた成分の強さ ≒ 左右の平均 − 中央
      const center = Math.sqrt(cr * cr + ci * ci);
      const side = Math.max(0, (pl + pr) * 0.5 - center);
      let g = center / (center + side * 0.5 + 1e-12);
      // はっきり中央にある成分はより中央に、そうでない成分はより伴奏に寄せて、分かれ方をくっきりさせる
      const g3 = g * g * g;
      const h = 1 - g;
      g = g3 / (g3 + h * h * h);
      // 中央の成分 C = g·(左+右)/2。出力 = 伴奏の音量 × 元の音 + (ボーカル − 伴奏) × C
      const m = 0.5 * g * band[k] * amt;
      const centerRe = (lr + rr) * m;
      const centerIm = (li + ri) * m;
      const yLr = inst * lr + centerRe;
      const yLi = inst * li + centerIm;
      const yRr = inst * rr + centerRe;
      const yRi = inst * ri + centerIm;
      // 左を実部、右を虚部にまとめて、1回の逆変換で両方を戻す
      re[k] = yLr - yRi;
      im[k] = yLi + yRr;
      if (k > 0 && k < N / 2) {
        re[j] = yLr + yRi;
        im[j] = yRr - yLi;
      }
    }
    this.fft(re, im, true);
    // 前回出し終えた分を詰めてから重ねて足す。窓を2回掛けて4つ重ねると 1.5 倍になるので、その分と逆変換の 1/N で割る
    const scale = 1 / (1.5 * N);
    accL.copyWithin(0, HOP);
    accL.fill(0, N - HOP);
    accR.copyWithin(0, HOP);
    accR.fill(0, N - HOP);
    for (let i = 0; i < N; i++) {
      accL[i] += re[i] * win[i] * scale;
      accR[i] += im[i] * win[i] * scale;
    }
  }
}

registerProcessor('oto-center', CenterProcessor);
