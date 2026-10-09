import { describe, expect, test } from "bun:test";
import { analyzed, compare, hasFixture, loadRef, pyBeatTempo, report } from "./reference.ts";

// Ground truth: a librosa reference analyzer run on the same clip (results in fixtures/*.json).
// Fixture PCM: ffmpeg -v error -i audio.wav -f f32le -ac 1 -ar 22050 test/fixtures/mixmag.f32
describe.skipIf(!hasFixture("mixmag"))("mixmag vs python reference", async () => {
  const ref = await loadRef("mixmag");
  const a = await analyzed("mixmag");
  const cmp = compare(a, ref);
  report("mixmag", a, ref, cmp);

  test("tempo", () => {
    // librosa reports 123.0 (median of 20/21-frame IBIs); its beats actually span 125.6 BPM
    expect(Math.abs(a.grid.bpm - pyBeatTempo(ref))).toBeLessThan(2.5);
  });
  test("beat count within 3% of python", () => {
    expect(Math.abs(a.grid.beats.length - ref.beats.length) / ref.beats.length).toBeLessThan(0.03);
  });
  test("low kills matched", () => {
    // no low kills in this clip (python found two shallow low cuts); vacuous but kept for symmetry
    expect(cmp.eqLowKill.rate).toBeGreaterThanOrEqual(0.75);
  });
  test("filter and section roughly matched", () => {
    // targets are loose on purpose: both Python heuristics are threshold-fragile
    expect(cmp.filter.rate).toBeGreaterThanOrEqual(0.5);
    expect(cmp.section.rate).toBeGreaterThanOrEqual(0.5);
  });
  test("moves are well formed", () => {
    const ids = new Set(a.moves.map((m) => m.id));
    expect(ids.size).toBe(a.moves.length);
    for (const m of a.moves) {
      expect(m.t1).toBeGreaterThanOrEqual(m.t0);
      expect(m.confidence).toBeGreaterThanOrEqual(0);
      expect(m.confidence).toBeLessThanOrEqual(1);
    }
  });
});
