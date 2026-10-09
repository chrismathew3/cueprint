// Structure: bar-synced chroma + MFCC, self-similarity, 4-bar checkerboard novelty.
// Peaks above the 85th percentile, at least 8 bars apart, are section boundaries.

import type { Detector, SectionMove } from "@cueprint/core";
import { barTimes, clamp01, moveId, percentile } from "../util.ts";

const K = 4;
const MIN_DIST_BARS = 8;
const N_MFCC = 13;

/** DCT-II (ortho) rows 1..N_MFCC-1 for an n-bin log-mel frame. */
function dctBasis(n: number): Float64Array {
  const b = new Float64Array((N_MFCC - 1) * n);
  const scale = Math.sqrt(2 / n);
  for (let k = 1; k < N_MFCC; k++)
    for (let i = 0; i < n; i++) b[(k - 1) * n + i] = scale * Math.cos((Math.PI * k * (2 * i + 1)) / (2 * n));
  return b;
}

/** out[o + k] = MFCC_{k+1} / 50 of the log-mel frame at mel[mo, mo + nm). Kept tiny so it JITs tight. */
function mfccInto(mel: Float32Array, mo: number, nm: number, basis: Float64Array, out: Float64Array, o: number): void {
  for (let k = 0; k < N_MFCC - 1; k++) {
    let acc = 0;
    const bo = k * nm;
    for (let i = 0; i < nm; i++) acc += basis[bo + i] * mel[mo + i];
    out[o + k] = acc / 50;
  }
}

/** scipy.signal.find_peaks(x, height, distance) for plateau-free float data. */
export function findPeaks(x: Float64Array, height: number, distance: number): number[] {
  const cand: number[] = [];
  for (let i = 1; i < x.length - 1; i++) {
    if (x[i] > x[i - 1]) {
      // handle plateaus: find the right edge
      let j = i;
      while (j + 1 < x.length && x[j + 1] === x[i]) j++;
      if (j + 1 < x.length && x[j + 1] < x[i]) {
        const mid = (i + j) >> 1;
        if (x[mid] >= height) cand.push(mid);
      }
      i = j;
    }
  }
  const keep = new Uint8Array(cand.length).fill(1);
  const order = cand.map((_, k) => k).sort((a, b) => x[cand[b]] - x[cand[a]]);
  for (const k of order) {
    if (!keep[k]) continue;
    for (let j = k - 1; j >= 0 && cand[k] - cand[j] < distance; j--) keep[j] = 0;
    for (let j = k + 1; j < cand.length && cand[j] - cand[k] < distance; j++) keep[j] = 0;
  }
  return cand.filter((_, k) => keep[k]);
}

export const sectionDetector: Detector = {
  kind: "section",
  name: "Sections",
  detect({ features, grid }) {
    const { chroma, mel, melBins: nm, rate, onset } = features;
    const n = onset.length;
    const bars = barTimes(grid.beats, grid.downbeat);
    // segments: [0, bar0), [bar0, bar1), ..., [barLast, end)
    const edgesF: number[] = [0];
    for (const t of bars) {
      const f = Math.min(n, Math.max(0, Math.round(t * rate)));
      if (f > edgesF[edgesF.length - 1]) edgesF.push(f);
    }
    if (edgesF[edgesF.length - 1] < n) edgesF.push(n);
    const nSeg = edgesF.length - 1;
    if (nSeg <= 2 * K) return [];
    const D = 12 + N_MFCC - 1;
    const basis = dctBasis(nm);
    const bf = new Float64Array(nSeg * D);
    for (let s = 0; s < nSeg; s++) {
      const f0 = edgesF[s], f1 = edgesF[s + 1], len = f1 - f0;
      const vals = new Float64Array(len * D);
      for (let f = f0; f < f1; f++) {
        const r = (f - f0) * D;
        for (let c = 0; c < 12; c++) vals[r + c] = chroma[f * 12 + c];
        mfccInto(mel, f * nm, nm, basis, vals, r + 12);
      }
      // per-dim median, then inf-normalize the column
      const dim = new Float64Array(len);
      let mx = 0;
      for (let d = 0; d < D; d++) {
        for (let j = 0; j < len; j++) dim[j] = vals[j * D + d];
        dim.sort();
        const med = len % 2 ? dim[len >> 1] : 0.5 * (dim[len / 2 - 1] + dim[len / 2]);
        bf[s * D + d] = med;
        if (Math.abs(med) > mx) mx = Math.abs(med);
      }
      if (mx > 0) for (let d = 0; d < D; d++) bf[s * D + d] /= mx;
    }
    // novelty only touches |i - j| < 2K, so keep a band of the self-similarity matrix (O(n), not O(n^2))
    const W = 2 * K;
    const band = new Float64Array(nSeg * W);
    for (let i = 0; i < nSeg; i++)
      for (let o = 0; o < W && i + o < nSeg; o++) {
        let acc = 0;
        const a = i * D, b = (i + o) * D;
        for (let d = 0; d < D; d++) acc += bf[a + d] * bf[b + d];
        band[i * W + o] = acc;
      }
    const sim = (r: number, c: number) => (r <= c ? band[r * W + (c - r)] : band[c * W + (r - c)]);
    const blockMean = (r0: number, c0: number) => {
      let acc = 0;
      for (let r = r0; r < r0 + K; r++) for (let c = c0; c < c0 + K; c++) acc += sim(r, c);
      return acc / (K * K);
    };
    const nov = new Float64Array(nSeg);
    for (let i = K; i < nSeg - K; i++) nov[i] = (blockMean(i - K, i - K) + blockMean(i, i)) / 2 - blockMean(i - K, i);
    const height = percentile(nov, 85);
    let nmax = -Infinity;
    for (const v of nov) if (v > nmax) nmax = v;
    const out: SectionMove[] = [];
    for (const p of findPeaks(nov, height, MIN_DIST_BARS)) {
      // boundary sits between segment p-1 and p: the start of segment p
      const t = edgesF[p] / rate;
      const confidence = clamp01(0.3 + 0.7 * ((nov[p] - height) / Math.max(1e-9, nmax - height)));
      out.push({ kind: "section", id: moveId("section", t), t0: t, t1: t, confidence, verdict: "structure", strength: Math.round(nov[p] * 1000) / 1000 });
    }
    return out;
  },
};
