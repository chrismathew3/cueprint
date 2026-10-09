// Browser-parallel analysis: split STFT frame ranges across module workers, then merge and
// run grid/curves/detectors in a worker. The main thread only routes buffers (transferred,
// never copied) and runs custom (non-built-in) detectors, which can't be posted to a worker.

import type { Detector, Pcm } from "@cueprint/core";
import { FEATURE_SHARE, runDetectors, type AudioAnalysis, type ProgressFn } from "./analyze.ts";
import { defaultDetectors } from "./detectors/index.ts";
import { HOP, N_FFT, SPEC_DECIMATE, frameCount, type FeatureChunk } from "./features.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

export interface ParallelOptions {
  /** Worker count. Default: hardwareConcurrency - 1, clamped to 1..8. */
  workers?: number;
  onProgress?: ProgressFn;
  /** Built-ins run in the finishing worker; any other detector runs on the main thread afterwards. */
  detectors?: readonly Detector[];
  signal?: AbortSignal;
}

function defaultWorkers(): number {
  const hc = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(8, hc - 1));
}

function spawn(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

export async function analyzeParallel(pcm: Pcm, opts: ParallelOptions = {}): Promise<AudioAnalysis> {
  const nWorkers = Math.max(1, Math.floor(opts.workers ?? defaultWorkers()));
  const total = pcm.samples.length;
  const totalFrames = frameCount(total);
  // ~2 chunks per worker for load balancing; at least ~30 s of audio per chunk; even boundaries
  const minChunk = 1300;
  const nChunks = Math.max(1, Math.min(nWorkers * 2, Math.floor(totalFrames / minChunk)));
  const bounds: number[] = [0];
  for (let i = 1; i < nChunks; i++) bounds.push(Math.round((totalFrames * i) / nChunks / SPEC_DECIMATE) * SPEC_DECIMATE);
  bounds.push(totalFrames);

  const shared = sharedSamples(pcm.samples);
  const workers = Array.from({ length: Math.min(nWorkers, nChunks) }, spawn);
  const progress = new Float64Array(nChunks);
  const report = () => {
    if (!opts.onProgress) return;
    let done = 0;
    for (let i = 0; i < nChunks; i++) done += progress[i] * (bounds[i + 1] - bounds[i]);
    opts.onProgress((done / totalFrames) * FEATURE_SHARE, "features");
  };

  let aborted = false;
  const onAbort = () => { aborted = true; for (const w of workers) w.terminate(); };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // ---- features: a simple job queue over the workers
    const chunks: FeatureChunk[] = new Array(nChunks);
    let next = 0;
    await Promise.all(workers.map(async (w) => {
      while (next < nChunks) {
        const id = next++;
        const startFrame = bounds[id], endFrame = bounds[id + 1];
        const base = { type: "features" as const, id, sampleRate: pcm.sampleRate, totalSamples: total, startFrame, endFrame };
        let msg: ToWorker, transfer: Transferable[] = [];
        if (shared) {
          msg = { ...base, shared, sampleOffset: 0 };
        } else {
          // frames [start-1, end) touch samples [(start-1)*HOP - N_FFT/2, (end-1)*HOP + N_FFT/2)
          const s0 = Math.max(0, (startFrame - 1) * HOP - N_FFT / 2);
          const s1 = Math.min(total, (endFrame - 1) * HOP + N_FFT / 2);
          const slice = pcm.samples.slice(s0, s1);
          msg = { ...base, slice, sampleOffset: s0 };
          transfer = [slice.buffer];
        }
        chunks[id] = (await call(w, msg, transfer, (m) => {
          if (m.type === "progress") { progress[id] = m.fraction; report(); }
        }, () => aborted)).chunk;
        progress[id] = 1;
        report();
      }
    }).map((p) => p.then(() => undefined)));

    // ---- finish in one worker
    const custom = (opts.detectors ?? defaultDetectors).filter((d) => !defaultDetectors.includes(d));
    const builtin = opts.detectors ? opts.detectors.filter((d) => defaultDetectors.includes(d)).map((d) => d.name) : null;
    const transfer: Transferable[] = [];
    for (const c of chunks) for (const b of chunkBuffers(c)) transfer.push(b);
    const done = await call(workers[0], { type: "finish", id: -1, chunks, detectors: builtin, returnContext: custom.length > 0 }, transfer, (m) => {
      if (m.type === "progress" && m.stage !== "done") opts.onProgress?.(m.fraction, m.stage);
    }, () => aborted);
    let analysis = done.analysis;
    if (custom.length && done.features) {
      const moves = runDetectors({ features: done.features, grid: analysis.grid, curves: analysis.curves }, custom, analysis.moves);
      analysis = { ...analysis, moves };
    }
    opts.onProgress?.(1, "done");
    return analysis;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    for (const w of workers) w.terminate();
  }
}

type Reply<T extends ToWorker["type"]> = T extends "features" ? Extract<FromWorker, { type: "chunk" }> : Extract<FromWorker, { type: "done" }>;

function call<M extends ToWorker>(
  w: Worker, msg: M, transfer: Transferable[], onMsg: (m: FromWorker) => void, isAborted: () => boolean,
): Promise<Reply<M["type"]>> {
  return new Promise((resolve, reject) => {
    if (isAborted()) return reject(new DOMException("Aborted", "AbortError"));
    const cleanup = () => { w.removeEventListener("message", onMessage); w.removeEventListener("error", onError); };
    const onMessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.id !== msg.id) return;
      if (m.type === "error") { cleanup(); reject(new Error(`dsp worker: ${m.message}`)); }
      else if (m.type === "chunk" || m.type === "done") { cleanup(); resolve(m as Reply<M["type"]>); }
      else onMsg(m);
    };
    const onError = (e: ErrorEvent) => { cleanup(); reject(new Error(`dsp worker crashed: ${e.message}`)); };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    w.postMessage(msg, transfer);
  });
}

function chunkBuffers(c: FeatureChunk): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const v of Object.values(c)) {
    if (ArrayBuffer.isView(v)) out.add(v.buffer as ArrayBuffer);
    else if (v && typeof v === "object") for (const x of Object.values(v)) if (ArrayBuffer.isView(x)) out.add(x.buffer as ArrayBuffer);
  }
  return [...out];
}

/** The whole signal in a SharedArrayBuffer when the page is cross-origin isolated, else null. */
function sharedSamples(x: Float32Array): { buffer: SharedArrayBuffer; byteOffset: number; length: number } | null {
  const g = globalThis as { crossOriginIsolated?: boolean };
  if (!g.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") return null;
  if (x.buffer instanceof SharedArrayBuffer) return { buffer: x.buffer, byteOffset: x.byteOffset, length: x.length };
  const buffer = new SharedArrayBuffer(x.length * 4);
  new Float32Array(buffer).set(x);
  return { buffer, byteOffset: 0, length: x.length };
}
