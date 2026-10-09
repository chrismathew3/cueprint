import { describe, expect, test } from "bun:test";
import { camelotLabel, keyName, keyOver, toCamelot, type KeyCurve } from "@cueprint/core";
import { detectKeys } from "../src/index.ts";
import { analyzed, hasFixture } from "./reference.ts";

const label = (keys: KeyCurve, t0: number, t1: number) => {
  const r = keyOver(keys, t0, t1);
  return r ? camelotLabel(toCamelot(r.key)) : "none";
};

function describeSpan(name: string, keys: KeyCurve, t0: number, t1: number): void {
  const r = keyOver(keys, t0, t1);
  console.log(`[key] ${name} ${t0}-${t1}s: ${r ? `${camelotLabel(toCamelot(r.key))} (${keyName(r.key)}) conf ${r.confidence.toFixed(2)}` : "none"}`);
}

describe("detectKeys on synthetic chroma", () => {
  // 60 s of chroma at 43 fps that is a pure triad + scale tones for a given key
  function fakeFeatures(pcs: number[]) {
    const rate = 43, n = 60 * rate;
    const chroma = new Float32Array(n * 12);
    for (let i = 0; i < n; i++) for (const [j, pc] of pcs.entries()) chroma[i * 12 + pc] = j < 3 ? 1 : 0.5;
    const z = new Float32Array(n);
    return { rate, duration: n / rate, chroma, onset: z.fill(1), bandDb: { low: z, lowmid: z, himid: z, hi: z }, rolloffLoHz: z, rolloffHiHz: z, mel: z, melBins: 1 };
  }
  test("E major triad + scale -> 12B", () => {
    // E G# B, then F# A C# D#
    const k = detectKeys(fakeFeatures([4, 8, 11, 6, 9, 1, 3]));
    expect(label(k, 10, 50)).toBe("12B");
  });
  test("A minor triad + scale -> 8A", () => {
    const k = detectKeys(fakeFeatures([9, 0, 4, 11, 2, 5, 7]));
    expect(label(k, 10, 50)).toBe("8A");
  });
  test("silence -> unknown", () => {
    const k = detectKeys(fakeFeatures([]));
    expect(Array.from(k.key).every((x) => x === -1)).toBe(true);
    expect(keyOver(k, 0, 60)).toBeNull();
  });
});

// Ground truth from the DJ's Rekordbox screen in the source video.
describe.skipIf(!hasFixture("brooklyn"))("key detection on the Brooklyn clip", async () => {
  const a = await analyzed("brooklyn");
  const keys = a.keys!;
  describeSpan("brooklyn Get On It", keys, 0, 100);
  describeSpan("brooklyn A.D.D. S.U.V.", keys, 140, 270);
  describeSpan("brooklyn Still Riding", keys, 340, 590);

  test("curve shape", () => {
    expect(keys.rate).toBeCloseTo(1 / 8, 6);
    expect(keys.key.length).toBe(Math.ceil(a.duration * keys.rate));
    expect(keys.confidence.length).toBe(keys.key.length);
    for (const c of keys.confidence) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(1); }
  });

  test("Uffie - A.D.D. S.U.V. is 12B (E major)", () => {
    expect(label(keys, 140, 270)).toBe("12B");
  });

  // Known miss: every profile (Krumhansl, Temperley, EDMA, Shaath) hears this span as 3A (Bb minor),
  // swinging to 7B/4A in places, and librosa's harmonic CQT chroma agrees (F, Bb, Db strongest; A, D, G
  // weak). Rekordbox says 7B. Kept as a failing expectation rather than tuned to the clip.
  test.failing("Barry Can't Swim - Still Riding is 7B (F major)  [known miss: detects 3A]", () => {
    expect(label(keys, 340, 590)).toBe("7B");
  });
});

describe.skipIf(!hasFixture("mixmag"))("key detection on the Mixmag clip (no ground truth)", async () => {
  const a = await analyzed("mixmag");
  test("produces keys", () => {
    for (const [t0, t1] of [[0, 120], [120, 240]] as const) describeSpan("mixmag", a.keys!, t0, t1);
    expect(keyOver(a.keys!, 0, a.duration)).not.toBeNull();
  });
});
