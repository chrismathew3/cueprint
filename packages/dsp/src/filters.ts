// Filterbanks (ports of librosa.filters.mel / chroma) stored sparsely for the hot loop.

/** Row-sparse filterbank: output row r sums power[start[r] + j] * weights[offset[r] + j], j < count[r]. */
export interface SparseBank {
  readonly rows: number;
  readonly start: Int32Array;
  readonly count: Int32Array;
  readonly offset: Int32Array;
  readonly weights: Float64Array;
}

function hzToMelSlaney(f: number): number {
  const fSp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fSp, logstep = Math.log(6.4) / 27;
  return f >= minLogHz ? minLogMel + Math.log(f / minLogHz) / logstep : f / fSp;
}

function melToHzSlaney(m: number): number {
  const fSp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fSp, logstep = Math.log(6.4) / 27;
  return m >= minLogMel ? minLogHz * Math.exp(logstep * (m - minLogMel)) : fSp * m;
}

/** Slaney-style, slaney-normalized mel filterbank (librosa defaults). */
export function melBank(sr: number, nFft: number, nMels: number, fmin: number, fmax: number): SparseBank {
  const bins = nFft / 2 + 1;
  const melMin = hzToMelSlaney(fmin), melMax = hzToMelSlaney(fmax);
  const melF = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) melF[i] = melToHzSlaney(melMin + ((melMax - melMin) * i) / (nMels + 1));
  const start = new Int32Array(nMels), count = new Int32Array(nMels), offset = new Int32Array(nMels);
  const w: number[] = [];
  for (let m = 0; m < nMels; m++) {
    const lo = melF[m], c = melF[m + 1], hi = melF[m + 2];
    const enorm = 2 / (hi - lo);
    const weightAt = (k: number) => {
      const f = (k * sr) / nFft;
      return Math.max(0, Math.min((f - lo) / (c - lo), (hi - f) / (hi - c))) * enorm;
    };
    let s = -1, e = -1;
    for (let k = 0; k < bins; k++) if (weightAt(k) > 0) { if (s < 0) s = k; e = k; }
    offset[m] = w.length;
    if (s < 0) continue; // empty filter (very narrow low bands): row stays zero
    start[m] = s; count[m] = e - s + 1;
    for (let k = s; k <= e; k++) w.push(weightAt(k));
  }
  return { rows: nMels, start, count, offset, weights: Float64Array.from(w) };
}

/** Column-sparse chroma bank: for FFT bin k, entries [ptr[k], ptr[k+1]) of (pc, weight). */
export interface ChromaBank {
  readonly ptr: Int32Array;
  readonly pc: Uint8Array;
  readonly weights: Float64Array;
}

/** librosa.filters.chroma (tuning 0, ctroct 5, octwidth 2, L2 norm, base C), pruned below 1e-3 of the max weight. */
export function chromaBank(sr: number, nFft: number): ChromaBank {
  const nChroma = 12;
  const bins = nFft / 2 + 1;
  const a440 = 440;
  const frq = new Float64Array(nFft);
  for (let k = 1; k < nFft; k++) {
    const f = (k * sr) / nFft;
    frq[k] = nChroma * Math.log2(f / (a440 / 16));
  }
  frq[0] = frq[1] - 1.5 * nChroma;
  const width = new Float64Array(nFft);
  for (let k = 0; k < nFft - 1; k++) width[k] = Math.max(frq[k + 1] - frq[k], 1);
  width[nFft - 1] = 1;
  const half = Math.round(nChroma / 2);
  const full = new Float64Array(bins * nChroma);
  let gmax = 0;
  for (let k = 0; k < bins; k++) {
    let norm = 0;
    for (let c = 0; c < nChroma; c++) {
      let d = frq[k] - c;
      d = (((d + half + 10 * nChroma) % nChroma) + nChroma) % nChroma - half;
      const v = Math.exp(-0.5 * ((2 * d) / width[k]) ** 2);
      full[k * nChroma + c] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    const oct = Math.exp(-0.5 * ((frq[k] / nChroma - 5) / 2) ** 2);
    for (let c = 0; c < nChroma; c++) {
      const v = (full[k * nChroma + c] / norm) * oct;
      full[k * nChroma + c] = v;
      if (v > gmax) gmax = v;
    }
  }
  const ptr = new Int32Array(bins + 1);
  const pcs: number[] = [], ws: number[] = [];
  const floor = gmax * 1e-3;
  for (let k = 0; k < bins; k++) {
    ptr[k] = pcs.length;
    for (let c = 0; c < nChroma; c++) {
      const v = full[k * nChroma + c];
      // base_c: roll by -3 so row 0 is C
      if (v > floor) { pcs.push((c - 3 + nChroma) % nChroma); ws.push(v); }
    }
  }
  ptr[bins] = pcs.length;
  return { ptr, pc: Uint8Array.from(pcs), weights: Float64Array.from(ws) };
}
