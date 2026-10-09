// Shared helpers for the reference comparisons against the Python/librosa analyzer.
import { existsSync } from "node:fs";
import type { Move, Pcm } from "@cueprint/core";
import { analyze, type AudioAnalysis } from "../src/index.ts";

const FIX = new URL("./fixtures/", import.meta.url).pathname;

export interface PyEvent {
  type: "eq" | "filter" | "section" | "loop";
  t0: number;
  t1: number;
  band?: string;
  kill?: boolean;
  filter?: "HPF" | "LPF";
  dir?: string;
  strength?: number;
}
export interface PyRef { bpm: number; beats: number[]; events: PyEvent[] }

export function hasFixture(name: string): boolean {
  return existsSync(`${FIX}${name}.f32`);
}

export async function loadPcm(name: string): Promise<Pcm> {
  const buf = await Bun.file(`${FIX}${name}.f32`).arrayBuffer();
  return { sampleRate: 22050, samples: new Float32Array(buf) };
}

export async function loadRef(name: string): Promise<PyRef> {
  return Bun.file(`${FIX}${name}.json`).json();
}

const cache = new Map<string, AudioAnalysis>();
export async function analyzed(name: string): Promise<AudioAnalysis> {
  let a = cache.get(name);
  if (!a) { a = analyze(await loadPcm(name)); cache.set(name, a); }
  return a;
}

/** Tempo implied by Python's beat positions (span / count), immune to its 1-frame IBI quantization. */
export function pyBeatTempo(ref: PyRef): number {
  const b = ref.beats;
  return (60 * (b.length - 1)) / (b[b.length - 1] - b[0]);
}

export interface Rate { matched: number; total: number; rate: number }
const rate = (matched: number, total: number): Rate => ({ matched, total, rate: total ? matched / total : 1 });

/** Fraction of `ref` events matched by some move (interval overlap with `tol` seconds of slack). */
export function recall(ref: PyEvent[], moves: Move[], same: (e: PyEvent, m: Move) => boolean, tol: number): Rate {
  const hit = ref.filter((e) => moves.some((m) => same(e, m) && m.t0 - tol <= e.t1 && e.t0 <= m.t1 + tol));
  return rate(hit.length, ref.length);
}

/** Fraction of `moves` matched by some ref event (the other direction: how many TS moves Python also saw). */
export function precision(ref: PyEvent[], moves: Move[], same: (e: PyEvent, m: Move) => boolean, tol: number): Rate {
  const hit = moves.filter((m) => ref.some((e) => same(e, m) && m.t0 - tol <= e.t1 && e.t0 <= m.t1 + tol));
  return rate(hit.length, moves.length);
}

export function compare(a: AudioAnalysis, ref: PyRef) {
  const barS = 240 / a.grid.bpm;
  const ev = (t: PyEvent["type"]) => ref.events.filter((e) => e.type === t);
  const mv = (k: Move["kind"]) => a.moves.filter((m) => m.kind === k);
  const eqLowKill = ev("eq").filter((e) => e.band === "low" && e.kill);
  const eqSame = (e: PyEvent, m: Move) => m.kind === "eq" && m.band === e.band;
  const filtSame = (e: PyEvent, m: Move) => m.kind === "filter" && m.filter === e.filter && m.dir === e.dir;
  const any = () => true;
  // Python stamps a section at the END of the novelty bar (one bar late) and always uses beat 0 as
  // the downbeat; allow a bar + 0.5 s.
  const secTol = barS + 0.5;
  return {
    eqLowKill: recall(eqLowKill, mv("eq"), eqSame, 1),
    eqAll: recall(ev("eq"), mv("eq"), eqSame, 1),
    eqPrecision: precision(ev("eq"), mv("eq"), eqSame, 1),
    filter: recall(ev("filter"), mv("filter"), filtSame, 1),
    filterPrecision: precision(ev("filter"), mv("filter"), filtSame, 1),
    section: recall(ev("section"), mv("section"), any, secTol),
    sectionPrecision: precision(ev("section"), mv("section"), any, secTol),
    loop: recall(ev("loop"), mv("loop"), any, 1),
    loopPrecision: precision(ev("loop"), mv("loop"), any, 1),
  };
}

export function report(name: string, a: AudioAnalysis, ref: PyRef, cmp: ReturnType<typeof compare>): void {
  const pct = (r: Rate) => `${r.matched}/${r.total} (${(r.rate * 100).toFixed(0)}%)`;
  console.log(
    `[${name}] bpm ${a.grid.bpm} (py ${ref.bpm}, py beat-span ${pyBeatTempo(ref).toFixed(1)}), beats ${a.grid.beats.length} (py ${ref.beats.length}), downbeat phase ${a.grid.downbeat}\n` +
      Object.entries(cmp).map(([k, r]) => `  ${k.padEnd(16)} ${pct(r)}`).join("\n"),
  );
}
