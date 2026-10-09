// Musical key over time from the shared per-frame chroma.
//
// 1. Per frame: drop the chroma floor (subtract the frame's median bin, clamp at 0) so broadband
//    noise and drums, which light every bin equally, add nothing; then down-weight percussive frames
//    by onset strength (w = 1 / (1 + (onset / median onset)^2)).
// 2. Every KEY_STEP seconds, sum the cleaned chroma over a ±KEY_CONTEXT s context and correlate it
//    (Pearson) with the 24 rotations of a major/minor key profile.
// 3. key = best rotation, confidence = (best - runner-up) / best, clamped 0..1. Windows with no
//    tonal energy or a weak best fit are -1 (unknown).
//
// Default profile is Shaath's (KeyFinder), a Krumhansl variant that does well on electronic music.
// Profiles are swappable for experiments; see KEY_PROFILES.

import type { FeatureFrames, KeyCurve } from "@cueprint/core";

/** Seconds between key windows (curve rate = 1 / KEY_STEP). */
export const KEY_STEP = 8;
/** Seconds of chroma on each side of a window center that feed its estimate. */
export const KEY_CONTEXT = 16;
/** Best correlation below this is reported as unknown. */
const MIN_FIT = 0.2;

export type KeyProfile = readonly [major: readonly number[], minor: readonly number[]];

export const KEY_PROFILES = {
  krumhansl: [
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
  ],
  temperley: [
    [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400],
    [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330],
  ],
  /** Faraldo et al. 2016, automatically derived from EDM ("edma" in Essentia). */
  edma: [
    [0.16519551, 0.04749026, 0.08293076, 0.06687112, 0.09994645, 0.09274123, 0.05294487, 0.13159476, 0.05218986, 0.07443653, 0.06940723, 0.0642515],
    [0.17235348, 0.05336489, 0.07338382, 0.10140005, 0.05917139, 0.09253715, 0.05715209, 0.13132016, 0.07743231, 0.05051538, 0.06177642, 0.05984044],
  ],
  /** Ibrahim Sha'ath, KeyFinder. */
  shaath: [
    [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4],
    [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2],
  ],
} as const satisfies Record<string, KeyProfile>;

export interface KeyOptions {
  profile?: KeyProfile;
  step?: number;
  context?: number;
}

/** 24 zero-mean, unit-norm profile rotations, key-major order (0..11 major, 12..23 minor). */
function templates(profile: KeyProfile): Float64Array {
  const t = new Float64Array(24 * 12);
  for (let m = 0; m < 2; m++) {
    const p = profile[m];
    let mean = 0;
    for (let i = 0; i < 12; i++) mean += p[i];
    mean /= 12;
    let norm = 0;
    for (let i = 0; i < 12; i++) norm += (p[i] - mean) ** 2;
    norm = Math.sqrt(norm);
    for (let k = 0; k < 12; k++) {
      const o = (m * 12 + k) * 12;
      for (let i = 0; i < 12; i++) t[o + i] = (p[(i - k + 12) % 12] - mean) / norm;
    }
  }
  return t;
}

function median(xs: Float32Array): number {
  const s = Float32Array.from(xs).sort();
  return s.length ? s[s.length >> 1] : 0;
}

/** Cumulative cleaned chroma: cum[(i + 1) * 12 + pc] = sum of frames 0..i. */
function cleanedPrefix(f: FeatureFrames): Float64Array {
  const n = f.onset.length;
  const ch = f.chroma;
  const medOnset = median(f.onset) || 1e-9;
  const cum = new Float64Array((n + 1) * 12);
  const sorted = new Float32Array(12);
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    for (let p = 0; p < 12; p++) sorted[p] = ch[o + p];
    sorted.sort();
    const floor = 0.5 * (sorted[5] + sorted[6]);
    const r = f.onset[i] / medOnset;
    const w = 1 / (1 + r * r);
    const prev = i * 12, cur = (i + 1) * 12;
    for (let p = 0; p < 12; p++) {
      const v = ch[o + p] - floor;
      cum[cur + p] = cum[prev + p] + (v > 0 ? v * w : 0);
    }
  }
  return cum;
}

/** Best and runner-up key for a 12-bin chroma vector. */
export function scoreKey(c: ArrayLike<number>, tpl: Float64Array): { key: number; r: number; r2: number } {
  let mean = 0;
  for (let i = 0; i < 12; i++) mean += c[i];
  mean /= 12;
  let norm = 0;
  for (let i = 0; i < 12; i++) norm += (c[i] - mean) ** 2;
  norm = Math.sqrt(norm);
  if (!(norm > 1e-12)) return { key: -1, r: 0, r2: 0 };
  let key = -1, r = -Infinity, r2 = -Infinity;
  for (let k = 0; k < 24; k++) {
    let acc = 0;
    for (let i = 0; i < 12; i++) acc += (c[i] - mean) * tpl[k * 12 + i];
    acc /= norm;
    if (acc > r) { r2 = r; r = acc; key = k; } else if (acc > r2) r2 = acc;
  }
  return { key, r, r2 };
}

export function detectKeys(f: FeatureFrames, opts: KeyOptions = {}): KeyCurve {
  const step = opts.step ?? KEY_STEP, context = opts.context ?? KEY_CONTEXT;
  const tpl = templates(opts.profile ?? KEY_PROFILES.shaath);
  const n = f.onset.length;
  const windows = Math.max(0, Math.ceil(f.duration / step));
  const key = new Int8Array(windows).fill(-1);
  const confidence = new Float32Array(windows);
  if (!n || !windows) return { rate: 1 / step, key, confidence };
  const cum = cleanedPrefix(f);
  const c = new Float64Array(12);
  for (let w = 0; w < windows; w++) {
    const center = (w + 0.5) * step;
    const a = Math.max(0, Math.floor((center - context) * f.rate));
    const b = Math.min(n, Math.ceil((center + context) * f.rate));
    if (b <= a) continue;
    for (let p = 0; p < 12; p++) c[p] = cum[b * 12 + p] - cum[a * 12 + p];
    const s = scoreKey(c, tpl);
    if (s.key < 0 || s.r < MIN_FIT) continue;
    key[w] = s.key;
    confidence[w] = Math.max(0, Math.min(1, (s.r - s.r2) / s.r));
  }
  return { rate: 1 / step, key, confidence };
}
