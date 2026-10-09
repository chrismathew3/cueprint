import { describe, expect, test } from "bun:test";
import { analyze, analyzeParallel } from "../src/index.ts";
import { hasFixture, loadPcm } from "./reference.ts";

describe.skipIf(!hasFixture("brooklyn"))("performance (600 s Brooklyn clip)", async () => {
  const pcm = await loadPcm("brooklyn");

  test("single-thread analyze < 4 s (target < 2 s)", () => {
    const t0 = performance.now();
    analyze(pcm);
    const cold = performance.now() - t0;
    const t1 = performance.now();
    const a = analyze(pcm);
    const warm = performance.now() - t1;
    console.log(`[perf] analyze 600 s: cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(0)} ms (${(600_000 / warm).toFixed(0)}x realtime), ${a.moves.length} moves`);
    expect(cold).toBeLessThan(4000);
  }, 20_000);

  test("analyzeParallel (Bun workers) matches single-thread", async () => {
    const single = analyze(pcm);
    for (const workers of [1, 4, 8]) {
      const t = performance.now();
      const par = await analyzeParallel(pcm, { workers });
      console.log(`[perf] analyzeParallel ${workers} workers: ${(performance.now() - t).toFixed(0)} ms`);
      expect(par.grid.bpm).toBe(single.grid.bpm);
      expect(par.grid.beats.length).toBe(single.grid.beats.length);
      expect(par.moves.map((m) => m.id)).toEqual(single.moves.map((m) => m.id));
      expect(par.spectrogram.frames).toBe(single.spectrogram.frames);
      expect(Array.from(par.keys!.key)).toEqual(Array.from(single.keys!.key));
    }
  }, 60_000);
});
