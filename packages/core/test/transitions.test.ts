import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  SCHEMA_VERSION, barClock, camelotCompatible, camelotLabel, deriveTransitions, fromCamelot, keyName, keyOver, toCamelot,
  type Analysis, type BeatGrid, type EqMove, type FilterMove, type KeyCurve, type Move, type SectionMove, type Track,
} from "../src/index.ts";

// ---------- synthetic fixtures: 128 BPM, downbeat at beat 0, beats from t = 0 ----------

const BPM = 128;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT; // 1.875 s

function grid(seconds = 600, downbeat = 0): BeatGrid {
  const n = Math.floor(seconds / BEAT);
  const beats = new Float64Array(n);
  for (let i = 0; i < n; i++) beats[i] = i * BEAT;
  return { bpm: BPM, beats, downbeat, localBpm: new Float32Array(n).fill(BPM) };
}

const at = (bar: number) => bar * BAR;
let nid = 0;
function eq(bar0: number, bar1: number, band: EqMove["band"], kill = false, extra: Partial<EqMove> = {}): EqMove {
  return { id: `eq-${nid++}`, kind: "eq", t0: at(bar0), t1: at(bar1), confidence: 0.8, verdict: "pending", band, depthDb: -20, kill, sharp: true, ...extra };
}
function filt(bar0: number, bar1: number, filter: "HPF" | "LPF", dir: "close" | "open"): FilterMove {
  return { id: `filter-${nid++}`, kind: "filter", t0: at(bar0), t1: at(bar1), confidence: 0.8, verdict: "pending", filter, dir, fromHz: 30, toHz: 800 };
}
function section(bar: number, strength: number): SectionMove {
  return { id: `section-${nid++}`, kind: "section", t0: at(bar), t1: at(bar), confidence: 0.8, verdict: "structure", strength };
}
function keyCurve(seconds: number, keyAt: (t: number) => number): KeyCurve {
  const n = Math.ceil(seconds / 8);
  const key = new Int8Array(n), confidence = new Float32Array(n);
  for (let i = 0; i < n; i++) { key[i] = keyAt((i + 0.5) * 8); confidence[i] = 0.5; }
  return { rate: 1 / 8, key, confidence };
}
function analysis(moves: Move[], tracks: Track[] = [], keys?: KeyCurve, seconds = 600): Analysis {
  const empty = { rate: 20, values: new Float32Array(0) };
  return {
    schema: SCHEMA_VERSION, duration: seconds, grid: grid(seconds),
    curves: { low: empty, lowmid: empty, himid: empty, hi: empty, hpfHz: empty, lpfHz: empty },
    spectrogram: { bins: 0, frames: 0, rate: 1, data: new Uint8Array(0) },
    moves, keys, tracks, annotations: [],
  };
}
const track = (start: number, title: string): Track => ({ start, artist: "x", title, confident: true });

// ---------- keys ----------

describe("key helpers", () => {
  test("camelot mapping", () => {
    expect(camelotLabel(toCamelot(4))).toBe("12B"); // E major
    expect(camelotLabel(toCamelot(5))).toBe("7B"); // F major
    expect(camelotLabel(toCamelot(12 + 9))).toBe("8A"); // A minor
    expect(camelotLabel(toCamelot(0))).toBe("8B"); // C major
    expect(camelotLabel(toCamelot(12 + 10))).toBe("3A"); // Bb minor
    for (let k = 0; k < 24; k++) expect(fromCamelot(toCamelot(k))).toBe(k);
  });
  test("names", () => {
    expect(keyName(12 + 9)).toBe("A minor");
    expect(keyName(4)).toBe("E major");
    expect(keyName(-1)).toBe("unknown");
  });
  test("compatibility", () => {
    const k = (number: number, letter: "A" | "B") => ({ number, letter });
    expect(camelotCompatible(k(8, "A"), k(8, "A"))).toBe(true);
    expect(camelotCompatible(k(8, "A"), k(9, "A"))).toBe(true);
    expect(camelotCompatible(k(12, "B"), k(1, "B"))).toBe(true); // wraps
    expect(camelotCompatible(k(8, "A"), k(8, "B"))).toBe(true); // relative
    expect(camelotCompatible(k(8, "A"), k(9, "B"))).toBe(false);
    expect(camelotCompatible(k(12, "B"), k(7, "B"))).toBe(false);
    expect(camelotCompatible(k(3, "B"), k(5, "B"))).toBe(false);
  });
  test("keyOver votes by confidence", () => {
    const keys: KeyCurve = { rate: 1 / 8, key: Int8Array.from([4, 4, 5, 5, 5, -1]), confidence: Float32Array.from([0.9, 0.9, 0.2, 0.2, 0.2, 0]) };
    const r = keyOver(keys, 0, 48)!;
    expect(r.key).toBe(4);
    expect(r.confidence).toBeCloseTo(1.8 / 6, 5);
    expect(keyOver(keys, 40, 48)).toBeNull();
    expect(keyOver(keys, 16, 40)!.key).toBe(5);
  });
});

// ---------- transitions ----------

describe("deriveTransitions", () => {
  test("bar clock", () => {
    const c = barClock(grid(600, 2));
    expect(c.timeOfBar(0)).toBeCloseTo(2 * BEAT, 9);
    expect(c.barAt(2 * BEAT + 3 * BAR)).toBeCloseTo(3, 9);
    expect(c.barAt(0)).toBeCloseTo(-0.5, 9);
    expect(c.timeOfBar(1000)).toBeCloseTo(2 * BEAT + 1000 * BAR, 6);
  });

  test("tracklist path: one transition per pair, window = cluster nearest the boundary", () => {
    // boundary at bar 100; a far-away early move (bar 40) must not join the cluster
    const moves: Move[] = [
      filt(40, 41, "HPF", "close"),
      filt(88.4, 90, "HPF", "close"),
      eq(96, 97.5, "low", true),
      section(100, 2),
      filt(103, 104.3, "HPF", "open"),
    ];
    const tr = deriveTransitions(analysis(moves, [track(0, "A"), track(at(100) + 20, "B"), track(at(250), "C")]));
    expect(tr).toHaveLength(2);
    const [t] = tr;
    expect(t.from).toBe(0);
    expect(t.to).toBe(1);
    expect(t.startBar).toBe(88);
    expect(t.bars).toBe(105 - 88);
    expect(t.t0).toBeCloseTo(at(88), 9);
    expect(t.t1).toBeCloseTo(at(105), 9);
    expect(t.steps.map((s) => s.bar)).toEqual([0.4, 8, 15]);
    expect(t.steps.map((s) => s.moveId)).toEqual([moves[1].id, moves[2].id, moves[4].id]);
    expect(t.steps.every((s) => !s.moveId.startsWith("section"))).toBe(true);
    // second boundary has no moves near it -> 16-bar minimal window ending at its bar
    expect(tr[1].bars).toBe(16);
    expect(tr[1].startBar).toBe(234);
    expect(tr[1].steps).toHaveLength(0);
  });

  test("no-tracklist path: strong sections backed by an EQ/filter move", () => {
    const moves: Move[] = [
      eq(60, 62, "low", true), section(64, 2.0), // strong + backed -> boundary
      section(120, 2.5), // strong but nothing nearby -> not a boundary
      section(180, 0.8), eq(178, 180, "low", true), // weak -> no
      filt(236, 238, "LPF", "close"), section(240, 1.8), // backed by a filter
      section(250, 3), eq(249, 250, "lowmid"), // too close to the previous boundary
    ];
    const tr = deriveTransitions(analysis(moves));
    expect(tr.map((t) => [t.from, t.to])).toEqual([[-1, -1], [-1, -1]]);
    expect(tr[0].startBar).toBe(60);
    expect(tr[1].startBar).toBe(236);
    expect(tr[0].id).not.toBe(tr[1].id);
  });

  test("phrase alignment", () => {
    const at16 = deriveTransitions(analysis([eq(64, 66, "low", true)], [track(0, "A"), track(at(66), "B")]))[0];
    expect(at16.startBar).toBe(64);
    expect(at16.onPhrase).toBe(true);
    const near = deriveTransitions(analysis([eq(63.2, 66, "low", true)], [track(0, "A"), track(at(66), "B")]))[0];
    expect(near.startBar).toBe(63);
    expect(near.onPhrase).toBe(true);
    const off = deriveTransitions(analysis([eq(70, 72, "low", true)], [track(0, "A"), track(at(72), "B")]))[0];
    expect(off.startBar).toBe(70);
    expect(off.onPhrase).toBe(false);
  });

  test("step text", () => {
    const moves: Move[] = [
      eq(10, 11, "low", true),
      eq(11, 12, "low", false),
      eq(12, 13, "lowmid"),
      eq(13, 14, "hi"),
      eq(14, 15, "himid"),
      filt(15, 16, "HPF", "close"),
      filt(16, 17, "HPF", "open"),
      filt(17, 18, "LPF", "close"),
      filt(18, 19, "LPF", "open"),
      eq(19, 20, "low", true, { verdict: "hand moving", zone: "MIXER L" }),
      eq(20, 21, "low", true, { verdict: "hand moving", zone: "MIXER CENTER" }),
      eq(21, 22, "low", true, { verdict: "hands still", zone: "MIXER R" }),
    ];
    const [t] = deriveTransitions(analysis(moves, [track(0, "A"), track(at(20), "B")]));
    expect(t.steps.map((s) => s.text)).toEqual([
      "Kill the bass",
      "Pull the low EQ down",
      "Cut the low-mids",
      "Cut the highs",
      "Cut the highs",
      "Sweep the high-pass up",
      "Open the high-pass back up",
      "Close the low-pass",
      "Open the low-pass back up",
      "Kill the bass (on camera, mixer left)",
      "Kill the bass (on camera, mixer center)",
      "Kill the bass",
    ]);
  });

  test("keys: harmonic when Camelot-compatible, not otherwise, absent without keys", () => {
    const moves = [eq(96, 100, "low", true)];
    const tracks = [track(0, "A"), track(at(98), "B")];
    // E major (12B) -> C# minor (12A): relative, compatible
    const ok = deriveTransitions(analysis(moves, tracks, keyCurve(600, (t) => (t < at(98) ? 4 : 12 + 1))))[0];
    expect(camelotLabel(ok.fromKey!)).toBe("12B");
    expect(camelotLabel(ok.toKey!)).toBe("12A");
    expect(ok.harmonic).toBe(true);
    // E major (12B) -> F major (7B): clash
    const clash = deriveTransitions(analysis(moves, tracks, keyCurve(600, (t) => (t < at(98) ? 4 : 5))))[0];
    expect(camelotLabel(clash.toKey!)).toBe("7B");
    expect(clash.harmonic).toBe(false);
    const none = deriveTransitions(analysis(moves, tracks))[0];
    expect(none.fromKey).toBeUndefined();
    expect(none.harmonic).toBeUndefined();
  });
});

// ---------- real data smoke test ----------

const FIX = new URL("../../dsp/test/fixtures/", import.meta.url).pathname;
describe.skipIf(!existsSync(`${FIX}brooklyn.f32`))("Brooklyn clip transitions (smoke)", () => {
  test("two transitions with steps", async () => {
    const { analyze } = await import("../../dsp/src/index.ts");
    const samples = new Float32Array(await Bun.file(`${FIX}brooklyn.f32`).arrayBuffer());
    const a: Analysis = {
      ...analyze({ sampleRate: 22050, samples }),
      tracks: [
        { start: 0, artist: "In Parallel", title: "Get On It", confident: true },
        { start: 120, artist: "Uffie", title: "A.D.D. S.U.V.", confident: true },
        { start: 300, artist: "Barry Can't Swim", title: "Still Riding", confident: true },
      ],
    };
    const tr = deriveTransitions(a);
    for (const t of tr) {
      const k = (c?: { number: number; letter: string }) => (c ? `${c.number}${c.letter}` : "?");
      console.log(
        `[transition] ${a.tracks[t.from].title} -> ${a.tracks[t.to].title}: ${t.t0.toFixed(1)}-${t.t1.toFixed(1)} s, ` +
          `bar ${t.startBar} +${t.bars} bars${t.onPhrase ? " (on phrase)" : ""}, keys ${k(t.fromKey)} -> ${k(t.toKey)}` +
          `${t.harmonic === undefined ? "" : t.harmonic ? " harmonic" : " clash"}\n` +
          t.steps.map((s) => `    bar ${s.bar.toFixed(1).padStart(5)}  ${s.text}`).join("\n"),
      );
    }
    expect(tr).toHaveLength(2);
    for (const t of tr) {
      expect(t.steps.length).toBeGreaterThan(0);
      expect(t.t0).toBeLessThan(t.t1);
    }
  }, 20_000);
});
