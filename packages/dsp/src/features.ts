// Streaming STFT feature extraction. One pass over the audio, nothing per-frame is kept
// except the compact features below, so it runs on hours of audio and can be split by
// frame range across workers (see mergeFeatures).

import { BAND_HZ, BANDS, type Band, type FeatureFrames, type Pcm, type Spectrogram } from "@cueprint/core";
import { RealFFT, hann } from "./fft.ts";
import { chromaBank, melBank, type ChromaBank, type SparseBank } from "./filters.ts";

export const N_FFT = 2048;
export const HOP = 512;
export const MEL_BINS = 96;
export const SPEC_BINS = 128;
export const SPEC_FMIN = 20;
/** Display spectrogram keeps every 2nd STFT frame (power-averaged pair): ~21.5 columns/s at 22050 Hz. */
export const SPEC_DECIMATE = 2;
export const SPEC_RANGE_DB = 70;
/** Spectrogram columns are quantized per block against the block max, then re-referenced at merge. */
const SPEC_BLOCK = 256;
const AMIN = 1e-10;
/** Floor for the onset mel (librosa clamps at global max - 80 dB; a fixed floor keeps chunks independent). */
const ONSET_FLOOR = 1e-7;

export interface FeatureOptions {
  /** First STFT frame to compute (inclusive). Default 0. */
  startFrame?: number;
  /** Last STFT frame (exclusive). Default: all frames. */
  endFrame?: number;
  /** Absolute sample index of `pcm.samples[0]` when pcm is a slice of a longer signal. Default 0. */
  sampleOffset?: number;
  /** Total samples in the full signal when pcm is a slice. Default `pcm.samples.length + sampleOffset`. */
  totalSamples?: number;
  /** Called with 0..1 as frames complete. */
  onProgress?: (fraction: number) => void;
}

/** Features for a contiguous frame range. Plain data: safe to postMessage (transfer the buffers). */
export interface FeatureChunk {
  readonly sampleRate: number;
  readonly totalSamples: number;
  readonly totalFrames: number;
  readonly startFrame: number;
  readonly frames: number;
  readonly bandDb: Record<Band, Float32Array>;
  readonly rolloffLoHz: Float32Array;
  readonly rolloffHiHz: Float32Array;
  readonly onset: Float32Array;
  readonly chroma: Float32Array;
  readonly mel: Float32Array;
  readonly melBins: number;
  /** First display column (absolute) in this chunk and how many. */
  readonly specColStart: number;
  readonly specCols: number;
  /** SPEC_BINS x specCols, column-major, quantized against blockMaxDb of each SPEC_BLOCK columns. */
  readonly spec: Uint8Array;
  readonly specBlockMaxDb: Float32Array;
}

export function frameCount(totalSamples: number): number {
  return 1 + Math.floor(totalSamples / HOP);
}

/** Every transferable buffer in a chunk, for postMessage. */
export function chunkTransferables(c: FeatureChunk): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const b of BANDS) out.push(c.bandDb[b].buffer as ArrayBuffer);
  out.push(c.rolloffLoHz.buffer as ArrayBuffer, c.rolloffHiHz.buffer as ArrayBuffer, c.onset.buffer as ArrayBuffer,
    c.chroma.buffer as ArrayBuffer, c.mel.buffer as ArrayBuffer, c.spec.buffer as ArrayBuffer, c.specBlockMaxDb.buffer as ArrayBuffer);
  return out;
}

interface Tables {
  sr: number;
  fft: RealFFT;
  win: Float64Array;
  mel: SparseBank;
  spec: SparseBank;
  chroma: ChromaBank;
  bandLo: Int32Array;
  bandHi: Int32Array;
}

let cached: Tables | null = null;
function tables(sr: number): Tables {
  if (cached && cached.sr === sr) return cached;
  const bandLo = new Int32Array(4), bandHi = new Int32Array(4);
  BANDS.forEach((b, i) => {
    const [lo, hi] = BAND_HZ[b];
    // bins with lo <= f < hi
    bandLo[i] = Math.ceil((lo * N_FFT) / sr);
    bandHi[i] = Math.min(N_FFT / 2 + 1, Math.ceil((hi * N_FFT) / sr));
  });
  cached = {
    sr,
    fft: new RealFFT(N_FFT),
    win: hann(N_FFT),
    mel: melBank(sr, N_FFT, MEL_BINS, 0, sr / 2),
    spec: melBank(sr, N_FFT, SPEC_BINS, SPEC_FMIN, sr / 2),
    chroma: chromaBank(sr, N_FFT),
    bandLo,
    bandHi,
  };
  return cached;
}

// ---- per-frame kernels: small top-level functions JIT far better than one big closure-heavy loop

function windowFrame(x: Float32Array, s0: number, off: number, totalSamples: number, win: Float64Array, frame: Float64Array): void {
  const n = frame.length;
  if (s0 >= 0 && s0 + n <= x.length) {
    for (let i = 0; i < n; i++) frame[i] = x[s0 + i] * win[i];
    return;
  }
  for (let i = 0; i < n; i++) {
    const j = s0 + i;
    frame[i] = j >= 0 && j < x.length && j + off < totalSamples ? x[j] * win[i] : 0;
  }
}

/** out[o + r] = 10 log10(max(bank_r . power, floor)); optionally keeps the linear values. */
function applyBankDb(power: Float64Array, bank: SparseBank, out: Float32Array | Float64Array, o: number, floor: number, lin: Float64Array | null): void {
  const st = bank.start, cnt = bank.count, off = bank.offset, w = bank.weights;
  for (let r = 0; r < bank.rows; r++) {
    let acc = 0;
    const s = st[r], wo = off[r], c = cnt[r];
    for (let j = 0; j < c; j++) acc += power[s + j] * w[wo + j];
    if (lin !== null) lin[r] = acc;
    out[o + r] = 10 * Math.log10(acc > floor ? acc : floor);
  }
}

function bandsAndRolloff(
  power: Float64Array, lo: Int32Array, hi: Int32Array, bands: Float32Array[],
  rollLo: Float32Array, rollHi: Float32Array, i: number, binHz: number,
): void {
  for (let b = 0; b < 4; b++) {
    let acc = 0;
    for (let k = lo[b], e = hi[b]; k < e; k++) acc += power[k];
    bands[b][i] = 10 * Math.log10(acc > AMIN ? acc : AMIN);
  }
  // rolloff: smallest bin whose cumulative energy reaches the fraction (librosa semantics)
  const bins = power.length;
  let total = 0;
  for (let k = 0; k < bins; k++) total += power[k];
  const tLo = 0.08 * total, tHi = 0.85 * total;
  let cum = 0, kLo = -1, kHi = bins - 1;
  for (let k = 0; k < bins; k++) {
    cum += power[k];
    if (kLo < 0 && cum >= tLo) kLo = k;
    if (cum >= tHi) { kHi = k; break; }
  }
  rollLo[i] = (kLo < 0 ? 0 : kLo) * binHz;
  rollHi[i] = kHi * binHz;
}

/** 12-bin chroma, inf-normalized (librosa chroma_stft norm=inf). */
function chromaFrame(power: Float64Array, bank: ChromaBank, acc: Float64Array, out: Float32Array, o: number): void {
  const ptr = bank.ptr, pc = bank.pc, w = bank.weights;
  for (let c = 0; c < 12; c++) acc[c] = 0;
  for (let k = 0, n = power.length; k < n; k++) {
    const p = power[k];
    for (let e = ptr[k], ee = ptr[k + 1]; e < ee; e++) acc[pc[e]] += p * w[e];
  }
  let mx = 0;
  for (let c = 0; c < 12; c++) if (acc[c] > mx) mx = acc[c];
  if (mx > 0) for (let c = 0; c < 12; c++) out[o + c] = acc[c] / mx;
}

function positiveFlux(cur: Float64Array, prev: Float64Array): number {
  let acc = 0;
  for (let r = 0, n = cur.length; r < n; r++) {
    const d = cur[r] - prev[r];
    if (d > 0) acc += d;
  }
  return acc / cur.length;
}

function copyInto(src: Float64Array, dst: Float32Array, o: number): void {
  for (let r = 0, n = src.length; r < n; r++) dst[o + r] = src[r];
}

/** dst[o + r] = dB of the mean power of a[ao + r] and b[r]. */
function pairDb(a: Float32Array | Float64Array, ao: number, b: Float64Array, dst: Float32Array, o: number): void {
  for (let r = 0, n = b.length; r < n; r++) {
    const v = 0.5 * (a[ao + r] + b[r]);
    dst[o + r] = 10 * Math.log10(v > AMIN ? v : AMIN);
  }
}

export function computeFeatures(pcm: Pcm, opts: FeatureOptions = {}): FeatureChunk {
  const sr = pcm.sampleRate;
  const x = pcm.samples;
  const off = opts.sampleOffset ?? 0;
  const totalSamples = opts.totalSamples ?? x.length + off;
  const totalFrames = frameCount(totalSamples);
  const start = Math.max(0, opts.startFrame ?? 0);
  const end = Math.min(totalFrames, opts.endFrame ?? totalFrames);
  const n = Math.max(0, end - start);
  const T = tables(sr);
  const { fft, win, mel: melB, spec: specB, chroma: chB, bandLo, bandHi } = T;
  const bins = fft.bins;

  const bandDb: Record<Band, Float32Array> = {
    low: new Float32Array(n), lowmid: new Float32Array(n), himid: new Float32Array(n), hi: new Float32Array(n),
  };
  const bandArr = [bandDb.low, bandDb.lowmid, bandDb.himid, bandDb.hi];
  const rollLo = new Float32Array(n), rollHi = new Float32Array(n), onset = new Float32Array(n);
  const chroma = new Float32Array(n * 12), mel = new Float32Array(n * MEL_BINS);

  const specColStart = Math.ceil(start / SPEC_DECIMATE);
  const specColEnd = Math.ceil(end / SPEC_DECIMATE);
  const specCols = Math.max(0, specColEnd - specColStart);
  const specDb = new Float32Array(specCols * SPEC_BINS);

  const frame = new Float64Array(N_FFT);
  const power = new Float64Array(bins);
  const specLin = new Float64Array(SPEC_BINS);
  let onsetDb = new Float64Array(SPEC_BINS);
  let prevOnsetDb = new Float64Array(SPEC_BINS);
  const chromaAcc = new Float64Array(12);
  const binHz = sr / N_FFT;
  const half = N_FFT / 2;

  let havePrev = false;
  let openCol = -1;
  if (start > 0 && n > 0) {
    windowFrame(x, (start - 1) * HOP - half - off, off, totalSamples, win, frame);
    fft.power(frame, power);
    applyBankDb(power, specB, prevOnsetDb, 0, ONSET_FLOOR, specLin);
    havePrev = true;
  }

  const progressEvery = 2048;
  for (let i = 0; i < n; i++) {
    const f = start + i;
    windowFrame(x, f * HOP - half - off, off, totalSamples, win, frame);
    fft.power(frame, power);
    bandsAndRolloff(power, bandLo, bandHi, bandArr, rollLo, rollHi, i, binHz);
    applyBankDb(power, melB, mel, i * MEL_BINS, AMIN, null);
    chromaFrame(power, chB, chromaAcc, chroma, i * 12);
    // onset: positive log-mel flux vs the previous frame, mean over bands (frame 0 has none)
    applyBankDb(power, specB, onsetDb, 0, ONSET_FLOOR, specLin);
    if (havePrev) onset[i] = positiveFlux(onsetDb, prevOnsetDb);
    const t = prevOnsetDb; prevOnsetDb = onsetDb; onsetDb = t;
    havePrev = true;

    // display spectrogram: power-average frame pairs (2c, 2c+1); pairs never straddle chunks
    // as long as chunk boundaries are even (the pool guarantees it)
    if (f % SPEC_DECIMATE === 0) {
      const o = (f / SPEC_DECIMATE - specColStart) * SPEC_BINS;
      if (f + 1 < end) { copyInto(specLin, specDb, o); openCol = o; }
      else pairDb(specLin, 0, specLin, specDb, o);
    } else if (openCol >= 0) {
      pairDb(specDb, openCol, specLin, specDb, openCol);
      openCol = -1;
    }

    if (opts.onProgress && (i + 1) % progressEvery === 0) opts.onProgress((i + 1) / n);
  }
  opts.onProgress?.(1);

  // quantize spectrogram per block
  const nBlocks = Math.ceil(specCols / SPEC_BLOCK);
  const specBlockMaxDb = new Float32Array(nBlocks);
  const spec = new Uint8Array(specCols * SPEC_BINS);
  for (let b = 0; b < nBlocks; b++) {
    const c0 = b * SPEC_BLOCK, c1 = Math.min(specCols, c0 + SPEC_BLOCK);
    let mx = -Infinity;
    for (let j = c0 * SPEC_BINS, e = c1 * SPEC_BINS; j < e; j++) if (specDb[j] > mx) mx = specDb[j];
    specBlockMaxDb[b] = mx;
    const scale = 255 / SPEC_RANGE_DB, base = mx - SPEC_RANGE_DB;
    for (let j = c0 * SPEC_BINS, e = c1 * SPEC_BINS; j < e; j++) {
      const v = (specDb[j] - base) * scale;
      spec[j] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
    }
  }

  return {
    sampleRate: sr, totalSamples, totalFrames, startFrame: start, frames: n, bandDb,
    rolloffLoHz: rollLo, rolloffHiHz: rollHi, onset, chroma, mel, melBins: MEL_BINS,
    specColStart, specCols, spec, specBlockMaxDb,
  };
}

export interface MergedFeatures {
  readonly features: FeatureFrames;
  readonly spectrogram: Spectrogram;
}

/** Concatenate chunks (any order; must tile the frame range without gaps) and normalize the spectrogram. */
export function mergeFeatures(parts: readonly FeatureChunk[]): MergedFeatures {
  if (!parts.length) throw new Error("mergeFeatures: no parts");
  const sorted = [...parts].sort((a, b) => a.startFrame - b.startFrame);
  const sr = sorted[0].sampleRate;
  let n = 0, cols = 0;
  for (const p of sorted) {
    if (p.startFrame !== n) throw new Error(`mergeFeatures: gap/overlap at frame ${n} (next part starts ${p.startFrame})`);
    if (p.specColStart !== cols) throw new Error(`mergeFeatures: spectrogram column gap at ${cols}`);
    n += p.frames;
    cols += p.specCols;
  }
  const one = sorted.length === 1 ? sorted[0] : null;
  const cat = (pick: (p: FeatureChunk) => Float32Array, stride: number) => {
    if (one) return pick(one);
    const out = new Float32Array(n * stride);
    for (const p of sorted) out.set(pick(p), p.startFrame * stride);
    return out;
  };
  const bandDb = {} as Record<Band, Float32Array>;
  for (const b of BANDS) bandDb[b] = cat((p) => p.bandDb[b], 1);

  let gmax = -Infinity;
  for (const p of sorted) for (let i = 0; i < p.specBlockMaxDb.length; i++) if (p.specBlockMaxDb[i] > gmax) gmax = p.specBlockMaxDb[i];
  const data = new Uint8Array(cols * SPEC_BINS);
  const scale = 255 / SPEC_RANGE_DB;
  for (const p of sorted) {
    const base = p.specColStart * SPEC_BINS;
    for (let b = 0; b < p.specBlockMaxDb.length; b++) {
      const shift = (gmax - p.specBlockMaxDb[b]) * scale;
      const j0 = b * SPEC_BLOCK * SPEC_BINS, j1 = Math.min(p.specCols, (b + 1) * SPEC_BLOCK) * SPEC_BINS;
      if (shift < 0.5) { data.set(p.spec.subarray(j0, j1), base + j0); continue; }
      for (let j = j0; j < j1; j++) {
        const v = p.spec[j] - shift;
        data[base + j] = v <= 0 ? 0 : Math.round(v);
      }
    }
  }

  const fps = sr / HOP;
  return {
    features: {
      rate: fps,
      duration: sorted[0].totalSamples / sr,
      bandDb,
      rolloffLoHz: cat((p) => p.rolloffLoHz, 1),
      rolloffHiHz: cat((p) => p.rolloffHiHz, 1),
      onset: cat((p) => p.onset, 1),
      chroma: cat((p) => p.chroma, 12),
      mel: cat((p) => p.mel, MEL_BINS),
      melBins: MEL_BINS,
    },
    spectrogram: { bins: SPEC_BINS, frames: cols, rate: fps / SPEC_DECIMATE, data },
  };
}
