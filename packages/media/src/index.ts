// WebCodecs decode via Mediabunny. Streams: never holds more than one decoded
// packet of source-rate audio, so a 2-hour set costs ~600 MB less than decodeAudioData.
import { ALL_FORMATS, AudioSampleSink, BlobSource, CanvasSink, Input } from "mediabunny";
import type { Pcm } from "@cueprint/core";

export const ANALYSIS_RATE = 22050;

export interface MediaInfo {
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
}

export function openInput(file: Blob): Input {
  return new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
}

export async function probe(file: Blob): Promise<MediaInfo> {
  const input = openInput(file);
  const [video, audio, duration] = await Promise.all([
    input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack(), input.computeDuration(),
  ]);
  return {
    duration,
    width: video?.displayWidth ?? 0,
    height: video?.displayHeight ?? 0,
    hasAudio: !!audio,
    hasVideo: !!video,
  };
}

/**
 * Streaming windowed-sinc resampler. Keeps a tail of history between chunks so
 * output is identical to resampling the whole signal at once.
 */
class Resampler {
  private readonly ratio: number; // in / out
  private readonly half = 16;
  private readonly cutoff: number;
  private history = new Float32Array(0);
  private historyStart = 0; // absolute input index of history[0]
  private nextOut = 0; // absolute output index
  private readonly kernelCache: Float32Array;
  private readonly phases = 256;

  constructor(inRate: number, outRate: number) {
    this.ratio = inRate / outRate;
    this.cutoff = Math.min(1, 1 / this.ratio) * 0.95;
    // precompute kernel per fractional phase: (2*half) taps per phase
    const taps = this.half * 2;
    this.kernelCache = new Float32Array(this.phases * taps);
    for (let p = 0; p < this.phases; p++) {
      const frac = p / this.phases;
      let sum = 0;
      for (let k = 0; k < taps; k++) {
        const x = k - this.half + 1 - frac;
        const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (this.half + 1)); // hann
        const s = x === 0 ? this.cutoff : Math.sin(Math.PI * this.cutoff * x) / (Math.PI * x);
        const v = s * w;
        this.kernelCache[p * taps + k] = v;
        sum += v;
      }
      for (let k = 0; k < taps; k++) this.kernelCache[p * taps + k] /= sum;
    }
  }

  /** Push mono input; returns all output samples computable so far. */
  push(chunk: Float32Array, final = false): Float32Array {
    const buf = new Float32Array(this.history.length + chunk.length);
    buf.set(this.history);
    buf.set(chunk, this.history.length);
    const bufEnd = this.historyStart + buf.length; // absolute index past last input
    const taps = this.half * 2;
    const out = new Float32Array(Math.max(0, Math.ceil(bufEnd / this.ratio) - this.nextOut + 2));
    let n = 0;
    for (;;) {
      const pos = this.nextOut * this.ratio;
      const base = Math.floor(pos);
      const last = base + this.half; // last input index needed
      if (last >= bufEnd && !final) break;
      if (base >= bufEnd) break;
      const phase = Math.min(this.phases - 1, Math.floor((pos - base) * this.phases));
      const kOff = phase * taps;
      let acc = 0;
      for (let k = 0; k < taps; k++) {
        const idx = base - this.half + 1 + k - this.historyStart;
        if (idx >= 0 && idx < buf.length) acc += buf[idx] * this.kernelCache[kOff + k];
      }
      if (n >= out.length) break;
      out[n++] = acc;
      this.nextOut++;
    }
    // keep enough history for the next output's left wing
    const keepFrom = Math.max(this.historyStart, Math.floor(this.nextOut * this.ratio) - this.half - 1);
    this.history = buf.slice(keepFrom - this.historyStart);
    this.historyStart = keepFrom;
    return out.subarray(0, n);
  }
}

/** Decode the primary audio track to mono PCM at `sampleRate`. */
export async function decodeMonoPcm(
  file: Blob,
  opts: { sampleRate?: number; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<Pcm> {
  const outRate = opts.sampleRate ?? ANALYSIS_RATE;
  const input = openInput(file);
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error("This file has no audio track.");
  const duration = await input.computeDuration();
  const total = Math.ceil(duration * outRate) + outRate;
  const outBuf = new Float32Array(total);
  let written = 0;
  let resampler: Resampler | null = null;
  let mono = new Float32Array(0);
  let plane = new Float32Array(0);
  let lastReport = 0;

  const sink = new AudioSampleSink(track);
  for await (const sample of sink.samples()) {
    if (opts.signal?.aborted) { sample.close(); throw new DOMException("aborted", "AbortError"); }
    const n = sample.numberOfFrames, ch = sample.numberOfChannels;
    resampler ??= new Resampler(sample.sampleRate, outRate);
    if (mono.length < n) { mono = new Float32Array(n); plane = new Float32Array(n); }
    mono.fill(0, 0, n);
    for (let c = 0; c < ch; c++) {
      sample.copyTo(plane, { planeIndex: c, format: "f32-planar", frameCount: n });
      for (let i = 0; i < n; i++) mono[i] += plane[i];
    }
    const inv = 1 / ch;
    for (let i = 0; i < n; i++) mono[i] *= inv;
    const t = sample.timestamp + sample.duration;
    sample.close();
    const out = resampler.push(mono.subarray(0, n));
    const room = Math.min(out.length, total - written);
    outBuf.set(out.subarray(0, room), written);
    written += room;
    if (opts.onProgress && t - lastReport > 5) { lastReport = t; opts.onProgress(Math.min(1, t / duration)); }
  }
  if (resampler) {
    const tail = resampler.push(new Float32Array(0), true);
    const room = Math.min(tail.length, total - written);
    outBuf.set(tail.subarray(0, room), written);
    written += room;
  }
  opts.onProgress?.(1);
  return { sampleRate: outRate, samples: outBuf.subarray(0, written) };
}

export interface DecodedFrame {
  readonly t: number;
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
}

/** Decoded video frames at a fixed sampling rate, scaled to `width`. Sequential decode, GPU-backed. */
export async function* frames(
  file: Blob,
  opts: { fps: number; width: number; start?: number; end?: number; signal?: AbortSignal },
): AsyncGenerator<DecodedFrame> {
  const input = openInput(file);
  const track = await input.getPrimaryVideoTrack();
  if (!track) return;
  const duration = await input.computeDuration();
  const start = opts.start ?? 0, end = Math.min(opts.end ?? duration, duration);
  const sink = new CanvasSink(track, { width: opts.width, poolSize: 2 });
  const step = 1 / opts.fps;
  function* stamps() { for (let t = start; t < end; t += step) yield t; }
  let i = 0;
  for await (const wrapped of sink.canvasesAtTimestamps(stamps())) {
    const t = start + i++ * step;
    if (opts.signal?.aborted) return;
    if (wrapped) yield { t, canvas: wrapped.canvas };
  }
}
