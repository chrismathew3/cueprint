import { describe, expect, test } from "bun:test";
import { BANDS } from "@cueprint/core";
import { computeFeatures, frameCount, HOP, mergeFeatures, N_FFT } from "../src/features.ts";
import { boxFilter, movingMedian } from "../src/curves.ts";
import { findPeaks } from "../src/detectors/section.ts";

function synth(seconds: number, sr = 22050): Float32Array {
  const n = Math.floor(seconds * sr);
  const x = new Float32Array(n);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const t = i / sr;
    const beat = (t * 2.1) % 1; // 126 BPM kick-ish
    x[i] = 0.5 * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-beat * 12) + 0.1 * Math.sin(2 * Math.PI * 440 * t) + 0.02 * (seed / 0x7fffffff - 0.5);
  }
  return x;
}

describe("computeFeatures", () => {
  const sr = 22050;
  const x = synth(20);
  const whole = mergeFeatures([computeFeatures({ sampleRate: sr, samples: x })]);

  test("frame count and duration follow librosa (center=True)", () => {
    expect(whole.features.onset.length).toBe(frameCount(x.length));
    expect(whole.features.duration).toBeCloseTo(20, 6);
  });

  test("chunked + sliced extraction is identical to one pass", () => {
    const total = frameCount(x.length);
    const cuts = [0, 100, 338, 600, total];
    const parts = cuts.slice(0, -1).map((s, i) => {
      const e = cuts[i + 1];
      const s0 = Math.max(0, (s - 1) * HOP - N_FFT / 2), s1 = Math.min(x.length, (e - 1) * HOP + N_FFT / 2);
      return computeFeatures({ sampleRate: sr, samples: x.slice(s0, s1) }, { startFrame: s, endFrame: e, sampleOffset: s0, totalSamples: x.length });
    });
    const m = mergeFeatures(parts.reverse());
    for (const b of BANDS) expect(Array.from(m.features.bandDb[b])).toEqual(Array.from(whole.features.bandDb[b]));
    expect(Array.from(m.features.onset)).toEqual(Array.from(whole.features.onset));
    expect(Array.from(m.features.mel)).toEqual(Array.from(whole.features.mel));
    expect(Array.from(m.features.chroma)).toEqual(Array.from(whole.features.chroma));
    let maxDiff = 0;
    for (let i = 0; i < m.spectrogram.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(m.spectrogram.data[i] - whole.spectrogram.data[i]));
    expect(m.spectrogram.frames).toBe(whole.spectrogram.frames);
    expect(maxDiff).toBeLessThanOrEqual(1); // re-referencing rounds once more
  });

  test("55 Hz content lands in the low band and low mel rows", () => {
    const f = whole.features;
    const mid = Math.floor(f.onset.length / 2);
    expect(f.bandDb.low[mid]).toBeGreaterThan(f.bandDb.hi[mid] + 20);
    expect(whole.spectrogram.data.length).toBe(whole.spectrogram.frames * whole.spectrogram.bins);
  });
});

describe("curve helpers", () => {
  test("movingMedian matches a naive median (nearest padding)", () => {
    const n = 500, win = 31;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.round(Math.sin(i * 0.3) * 10 + ((i * 37) % 11));
    const got = movingMedian(x, win);
    for (let i = 0; i < n; i++) {
      const w: number[] = [];
      for (let k = i - 15; k <= i + 15; k++) w.push(x[Math.max(0, Math.min(n - 1, k))]);
      w.sort((a, b) => a - b);
      expect(Math.abs(got[i] - w[15])).toBe(0);
    }
  });

  test("boxFilter matches scipy uniform_filter1d on a ramp (reflect)", () => {
    const x = Float32Array.from([0, 1, 2, 3, 4, 5]);
    // values from scipy.ndimage.uniform_filter1d(np.arange(6.0), size)
    expect(Array.from(boxFilter(x, 4))).toEqual([0.5, 0.75, 1.5, 2.5, 3.5, 4.25]);
    const five = Array.from(boxFilter(x, 5));
    [0.8, 1.2, 2.0, 3.0, 3.8, 4.2].forEach((v, i) => expect(five[i]).toBeCloseTo(v, 5));
  });

  test("findPeaks enforces height and distance", () => {
    const x = Float64Array.from([0, 1, 0, 5, 0, 2, 0, 0, 3, 0]);
    expect(findPeaks(x, 1.5, 3)).toEqual([3, 8]);
  });
});
