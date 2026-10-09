// Tempo + beat grid: onset autocorrelation tempo (librosa.feature.tempo style, with a
// log-normal prior), Ellis DP beat tracking (librosa.beat.beat_track), local BPM and
// downbeat phase. Unlike librosa, the beat period is kept fractional (sub-frame), so a
// 134 BPM track is tracked at 134 rather than snapping to 136 (19 frames) or 129 (20 frames).

import type { BeatGrid, FeatureFrames } from "@cueprint/core";

export interface BeatOptions {
  /** Prior centre (BPM). Default 126 (house/techno). */
  startBpm?: number;
  /** Prior width in octaves. Default 1 (librosa). */
  stdOctaves?: number;
  minBpm?: number;
  maxBpm?: number;
  /** DP tightness. Default 400. */
  tightness?: number;
}

/** Hann-windowed autocorrelation of the onset envelope, averaged over (strided) 8 s windows. */
function meanAutocorr(o: Float32Array, win: number, lags: Int32Array, stride: number): Float64Array {
  const n = o.length;
  const w = new Float64Array(win);
  for (let i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);
  const seg = new Float64Array(win);
  const out = new Float64Array(lags.length);
  let count = 0;
  const halfW = win >> 1;
  for (let c = 0; c < n; c += stride) {
    const s0 = c - halfW;
    for (let i = 0; i < win; i++) {
      const j = s0 + i;
      seg[i] = j >= 0 && j < n ? o[j] * w[i] : 0;
    }
    let r0 = 0;
    for (let i = 0; i < win; i++) r0 += seg[i] * seg[i];
    if (r0 <= 0) continue;
    for (let li = 0; li < lags.length; li++) {
      const L = lags[li];
      let acc = 0;
      for (let i = 0, e = win - L; i < e; i++) acc += seg[i] * seg[i + L];
      out[li] += acc / r0;
    }
    count++;
  }
  if (count) for (let i = 0; i < out.length; i++) out[i] /= count;
  return out;
}

function parabolic(ym: number, y0: number, yp: number): number {
  const den = ym - 2 * y0 + yp;
  if (den >= 0) return 0;
  const d = (0.5 * (ym - yp)) / den;
  return d > 0.5 ? 0.5 : d < -0.5 ? -0.5 : d;
}

/** Beat period estimate in (fractional) frames. */
export function estimatePeriod(onset: Float32Array, fps: number, opts: BeatOptions = {}): number {
  const startBpm = opts.startBpm ?? 126, std = opts.stdOctaves ?? 1;
  const minBpm = opts.minBpm ?? 70, maxBpm = opts.maxBpm ?? 180;
  const win = Math.floor(8 * fps);
  const stride = Math.max(4, Math.ceil(onset.length / 3000));
  const lagLo = Math.max(2, Math.floor((60 * fps) / maxBpm)), lagHi = Math.ceil((60 * fps) / minBpm);
  const lags = new Int32Array(lagHi - lagLo + 3);
  for (let i = 0; i < lags.length; i++) lags[i] = lagLo - 1 + i;
  const ac = meanAutocorr(onset, win, lags, stride);
  let best = -1, bestScore = -Infinity;
  const score = new Float64Array(lags.length);
  for (let i = 0; i < lags.length; i++) {
    const bpm = (60 * fps) / lags[i];
    const lp = -0.5 * ((Math.log2(bpm) - Math.log2(startBpm)) / std) ** 2;
    score[i] = Math.log1p(1e6 * Math.max(0, ac[i])) + lp;
    if (i > 0 && i < lags.length - 1 && bpm >= minBpm && bpm <= maxBpm && score[i] > bestScore) { bestScore = score[i]; best = i; }
  }
  if (best < 0) return (60 * fps) / startBpm;
  const L = lags[best];
  let period = L + parabolic(ac[best - 1], ac[best], ac[best + 1]);
  // refine on the 4-beat (bar) lag: 4x the resolution, and periodic music repeats strongly there
  const barLags = new Int32Array(9);
  for (let i = 0; i < 9; i++) barLags[i] = Math.round(4 * period) - 4 + i;
  if (barLags[8] < win - 8) {
    const bac = meanAutocorr(onset, win, barLags, stride);
    let bi = 1;
    for (let i = 1; i < 8; i++) if (bac[i] > bac[bi]) bi = i;
    if (bac[bi] > bac[bi - 1] && bac[bi] >= bac[bi + 1]) {
      const barPeriod = (barLags[bi] + parabolic(bac[bi - 1], bac[bi], bac[bi + 1])) / 4;
      if (Math.abs(barPeriod - period) < 0.75) period = barPeriod;
    }
  }
  return period;
}

/** Ellis DP over the onset envelope with a fractional beat period (frames). Returns beat frames. */
export function trackBeats(onset: Float32Array, period: number, tightness = 400): Int32Array {
  const n = onset.length;
  if (n === 0) return new Int32Array(0);
  // normalize by std (ddof=1)
  let mean = 0;
  for (let i = 0; i < n; i++) mean += onset[i];
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (onset[i] - mean) ** 2;
  const sd = Math.sqrt(v / Math.max(1, n - 1)) || 1;
  // local score: onset convolved with a narrow gaussian (sigma = period / 32)
  const R = Math.max(1, Math.ceil((5 * period) / 32));
  const kern = new Float64Array(2 * R + 1);
  for (let k = -R; k <= R; k++) kern[k + R] = Math.exp(-0.5 * ((k * 32) / period) ** 2);
  const local = new Float64Array(n);
  let lmax = 0;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -R; k <= R; k++) {
      const j = i + k;
      if (j >= 0 && j < n) acc += kern[k + R] * onset[j];
    }
    local[i] = acc / sd;
    if (local[i] > lmax) lmax = local[i];
  }
  // DP
  const dMin = Math.round(period / 2), dMax = Math.floor(2 * period);
  const pen = new Float64Array(dMax + 1);
  const lp = Math.log(period);
  for (let d = 1; d <= dMax; d++) pen[d] = tightness * (Math.log(d) - lp) ** 2;
  const cum = new Float64Array(n);
  const back = new Int32Array(n);
  const thresh = 0.01 * lmax;
  let first = true;
  for (let i = 0; i < n; i++) {
    let best = -Infinity, loc = -1;
    for (let d = dMin; d <= dMax; d++) {
      const j = i - d;
      if (j < 0) break;
      const s = cum[j] - pen[d];
      if (s > best) { best = s; loc = j; }
    }
    cum[i] = loc >= 0 ? local[i] + best : local[i];
    if (first && local[i] < thresh) back[i] = -1;
    else { back[i] = loc; first = false; }
  }
  // last beat: last local max of cum above half the median of local maxima
  const maxima: number[] = [];
  const isMax = (i: number) => {
    const prev = i > 0 ? cum[i - 1] : cum[i];
    const next = i < n - 1 ? cum[i + 1] : cum[i];
    return cum[i] > prev && cum[i] >= next;
  };
  for (let i = 0; i < n; i++) if (isMax(i)) maxima.push(cum[i]);
  maxima.sort((a, b) => a - b);
  const med = maxima.length ? (maxima.length % 2 ? maxima[maxima.length >> 1] : 0.5 * (maxima[maxima.length / 2 - 1] + maxima[maxima.length / 2])) : 0;
  let tail = n - 1;
  for (let i = n - 1; i >= 0; i--) if (isMax(i) && cum[i] >= 0.5 * med) { tail = i; break; }
  const rev: number[] = [];
  for (let i = tail; i >= 0; i = back[i]) rev.push(i);
  rev.reverse();
  // trim spurious leading/trailing beats; threshold = half the RMS of the smoothed beat local scores
  const m = rev.length;
  if (m === 0) return new Int32Array(0);
  const hw = [0.5, 1, 0.5];
  let ss = 0;
  for (let j = 0; j < m; j++) {
    let a = 0;
    for (let k = -1; k <= 1; k++) if (j + k >= 0 && j + k < m) a += hw[k + 1] * local[rev[j + k]];
    ss += a * a;
  }
  const thr = 0.5 * Math.sqrt(ss / m);
  // like librosa: drop beats before the first / after the last *frame* whose local score clears it
  let f0 = 0, f1 = n - 1;
  while (f0 < n && local[f0] <= thr) f0++;
  while (f1 >= 0 && local[f1] <= thr) f1--;
  let a = 0, b = m - 1;
  while (a <= b && rev[a] < f0) a++;
  while (b >= a && rev[b] > f1) b--;
  return Int32Array.from(rev.slice(a, b + 1));
}

/** Per-beat BPM from inter-beat intervals: outlier-rejected mean over a 17-beat window. */
export function localBpm(beats: Float64Array, fallbackBpm: number, size = 17): Float32Array {
  const n = beats.length;
  const out = new Float32Array(n);
  if (n < 2) { out.fill(fallbackBpm); return out; }
  const ibi = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) ibi[i] = beats[i + 1] - beats[i];
  const h = size >> 1;
  const buf: number[] = [];
  for (let j = 0; j < n; j++) {
    const c = Math.min(j, n - 2);
    buf.length = 0;
    for (let k = c - h; k <= c + h; k++) buf.push(ibi[Math.max(0, Math.min(n - 2, k))]);
    const sorted = [...buf].sort((x, y) => x - y);
    const med = sorted[h];
    let s = 0, cnt = 0;
    for (const x of buf) if (Math.abs(x - med) <= 0.15 * med) { s += x; cnt++; }
    out[j] = 60 / (cnt ? s / cnt : med);
  }
  return out;
}

function median(a: ArrayLike<number>): number {
  const s = Array.from(a).sort((x, y) => x - y);
  if (!s.length) return 0;
  return s.length % 2 ? s[s.length >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]);
}

/** Downbeat phase 0..3 maximizing mean onset + low-band attack strength on the bar's first beat. */
export function downbeatPhase(features: FeatureFrames, beatFrames: Int32Array): number {
  const on = features.onset, low = features.bandDb.low, n = on.length;
  const m = beatFrames.length;
  if (m < 8) return 0;
  const a = new Float64Array(m), b = new Float64Array(m);
  let sa = 0, sb = 0;
  for (let j = 0; j < m; j++) {
    const f = beatFrames[j];
    let o = 0;
    for (let k = f - 1; k <= f + 1; k++) if (k >= 0 && k < n && on[k] > o) o = on[k];
    const pre = Math.min(low[Math.max(0, f - 2)], low[Math.max(0, f - 1)]);
    const post = Math.max(low[f], low[Math.min(n - 1, f + 1)]);
    a[j] = o;
    b[j] = Math.max(0, post - pre);
    sa += a[j]; sb += b[j];
  }
  sa = sa / m || 1; sb = sb / m || 1;
  let best = 0, bestScore = -Infinity;
  for (let p = 0; p < 4; p++) {
    let s = 0, c = 0;
    for (let j = p; j < m; j += 4) { s += a[j] / sa + b[j] / sb; c++; }
    if (c && s / c > bestScore) { bestScore = s / c; best = p; }
  }
  return best;
}

export function beatGrid(features: FeatureFrames, opts: BeatOptions = {}): BeatGrid {
  const fps = features.rate;
  const period = estimatePeriod(features.onset, fps, opts);
  const frames = trackBeats(features.onset, period, opts.tightness ?? 400);
  const beats = new Float64Array(frames.length);
  for (let i = 0; i < frames.length; i++) beats[i] = frames[i] / fps;
  const local = localBpm(beats, (60 * fps) / period);
  const bpm = local.length ? median(local) : (60 * fps) / period;
  return { bpm: Math.round(bpm * 10) / 10, beats, downbeat: downbeatPhase(features, frames), localBpm: local };
}
