// UI/detector curves at a fixed 20 Hz: band level relative to a rolling 16-bar median
// ("the track at full EQ") and the spectral edges a HPF/LPF would move.

import { BANDS, type BeatGrid, type Curve, type Curves, type FeatureFrames } from "@cueprint/core";

export const CURVE_RATE = 20;

/** Centered moving average, scipy uniform_filter1d semantics (mode "reflect", even sizes lean left). */
export function boxFilter(x: Float32Array, size: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (n === 0 || size <= 1) { out.set(x); return out; }
  const left = size >> 1, right = size - 1 - left;
  const at = (i: number) => {
    // reflect: (d c b a | a b c d | d c b a)
    while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1;
    return x[i];
  };
  let acc = 0;
  for (let k = -left; k <= right; k++) acc += at(k);
  for (let i = 0; i < n; i++) {
    out[i] = acc / size;
    acc += at(i + right + 1) - at(i - left);
  }
  return out;
}

/** Centered running median of odd window `win`, edges padded with the edge value (scipy mode "nearest"). */
export function movingMedian(x: Float32Array, win: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  win |= 1;
  const h = win >> 1;
  const sorted = new Float64Array(win);
  const at = (i: number) => x[i < 0 ? 0 : i >= n ? n - 1 : i];
  for (let k = 0; k < win; k++) sorted[k] = at(k - h);
  sorted.sort();
  const lowerBound = (v: number) => {
    let lo = 0, hi = win;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
    return lo;
  };
  for (let i = 0; i < n; i++) {
    out[i] = sorted[h];
    if (i === n - 1) break;
    const rm = at(i - h), add = at(i + h + 1);
    if (rm === add) continue;
    const r = lowerBound(rm);
    // remove r, insert add keeping order
    if (add > rm) {
      const p = lowerBound(add) - 1; // last index < add (after removal shift)
      sorted.copyWithin(r, r + 1, p + 1);
      sorted[p] = add;
    } else {
      const p = lowerBound(add);
      sorted.copyWithin(p + 1, p, r);
      sorted[p] = add;
    }
  }
  return out;
}

/** Linear resample of a frame-rate series to `rate` Hz over `duration` seconds. */
export function resample(x: Float32Array, srcRate: number, rate: number, duration: number): Float32Array {
  const m = Math.max(1, Math.floor(duration * rate) + 1);
  const out = new Float32Array(m);
  const n = x.length;
  if (!n) return out;
  for (let i = 0; i < m; i++) {
    const p = (i / rate) * srcRate;
    const j = Math.floor(p);
    if (j >= n - 1) { out[i] = x[n - 1]; continue; }
    const f = p - j;
    out[i] = x[j] + (x[j + 1] - x[j]) * f;
  }
  return out;
}

export function barSeconds(grid: BeatGrid): number {
  return (4 * 60) / (grid.bpm > 0 ? grid.bpm : 126);
}

export function computeCurves(features: FeatureFrames, grid: BeatGrid): Curves {
  const fps = features.rate, dur = features.duration;
  const refWin = Math.floor(barSeconds(grid) * 16 * CURVE_RATE) | 1;
  const band = (x: Float32Array): Curve => {
    const s = resample(boxFilter(x, Math.floor(fps * 0.25)), fps, CURVE_RATE, dur);
    const ref = movingMedian(s, refWin);
    for (let i = 0; i < s.length; i++) s[i] -= ref[i];
    return { rate: CURVE_RATE, values: s };
  };
  const edge = (x: Float32Array, floorHz: number): Curve => {
    const lg = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) lg[i] = Math.log2(x[i] > floorHz ? x[i] : floorHz);
    const s = resample(boxFilter(lg, Math.floor(fps * 0.5)), fps, CURVE_RATE, dur);
    for (let i = 0; i < s.length; i++) s[i] = 2 ** s[i];
    return { rate: CURVE_RATE, values: s };
  };
  const [low, lowmid, himid, hi] = BANDS.map((b) => band(features.bandDb[b]));
  return {
    low, lowmid, himid, hi,
    hpfHz: edge(features.rolloffLoHz, 20),
    lpfHz: edge(features.rolloffHiHz, 50),
  };
}
