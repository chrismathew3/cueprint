// Filter sweeps: consistent movement of a spectral edge (8% rolloff for HPF, 85% for LPF)
// over >= 2 s. A real filter moves one edge while the other side of the spectrum holds; an
// arrangement change (breakdown, drop) moves everything at once, so those are rejected.

import type { Band, Curves, Detector, FilterMove } from "@cueprint/core";
import { clamp01, mean, moveId, runs } from "../util.ts";

const STEP_S = 0.5;
const MIN_SLOPE_OCT = 0.04; // octaves per step
const MIN_STEPS = 4;
const MIN_SPAN_OCT = { HPF: 1.2, LPF: 1.0 } as const;
const MIN_MOVED_DB = 6;
const MAX_HOLD_DB = 5;

const PHASE_STEP = 2; // curve samples (0.1 s at 20 Hz)
/** A sweep must show up on at least this many sampling phases (of 5) to count. */
const MIN_VOTES = 2;

function sweeps(curves: Curves, kind: "HPF" | "LPF", step: number, phase: number): FilterMove[] {
  const out: FilterMove[] = [];
  const src = kind === "HPF" ? curves.hpfHz : curves.lpfHz;
  const rate = src.rate;
  const m = Math.ceil((src.values.length - phase) / step);
  if (m < 2) return out;
  const c = new Float64Array(m);
  for (let i = 0; i < m; i++) c[i] = Math.log2(src.values[phase + i * step]);
  const d = new Float64Array(m - 1);
  for (let i = 0; i < m - 1; i++) d[i] = c[i + 1] - c[i];
  const sign = kind === "HPF" ? 1 : -1; // closing a HPF raises the low edge; closing a LPF lowers the high edge
  const [moving, holding]: [Band, Band] = kind === "HPF" ? ["low", "himid"] : ["hi", "low"];
  const w = Math.round(rate * 0.5);
  for (const direction of [1, -1]) {
    const mask = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i++) mask[i] = sign * direction * d[i] > MIN_SLOPE_OCT ? 1 : 0;
    for (const [s, e] of runs(mask, MIN_STEPS)) {
      const eIdx = Math.min(e, m - 1);
      const span = c[eIdx] - c[s];
      if (Math.abs(span) < MIN_SPAN_OCT[kind]) continue;
      const i0 = phase + s * step, i1 = phase + eIdx * step;
      const delta = (b: Band) => mean(curves[b].values, i1, i1 + w) - mean(curves[b].values, i0 - w, i0);
      const dMove = delta(moving), dHold = delta(holding);
      if (!Number.isFinite(dMove) || !Number.isFinite(dHold)) continue;
      const closing = direction === 1;
      const moved = closing ? -dMove : dMove;
      if (moved < MIN_MOVED_DB || Math.abs(dHold) > MAX_HOLD_DB) continue;
      const t0 = i0 / rate, t1 = i1 / rate;
      const confidence = clamp01(
        0.3 + 0.25 * clamp01((Math.abs(span) - MIN_SPAN_OCT[kind]) / 2) + 0.25 * clamp01((moved - MIN_MOVED_DB) / 10) + 0.2 * (1 - Math.abs(dHold) / MAX_HOLD_DB),
      );
      out.push({
        kind: "filter", id: moveId("filter", t0), t0, t1, confidence, verdict: "pending",
        filter: kind, dir: closing ? "close" : "open",
        fromHz: Math.round(2 ** c[s]), toHz: Math.round(2 ** c[eIdx]),
      });
    }
  }
  return out;
}

export const filterDetector: Detector = {
  kind: "filter",
  name: "Filter sweeps",
  detect({ curves }) {
    const out: FilterMove[] = [];
    for (const kind of ["LPF", "HPF"] as const) {
      const src = kind === "HPF" ? curves.hpfHz : curves.lpfHz;
      const rate = src.rate;
      const step = Math.max(1, Math.round(rate * STEP_S));
      const found: FilterMove[] = [];
      // The step-sampled slope test depends on where the 0.5 s grid falls; run every phase
      // and keep the strongest of overlapping hits so results don't hinge on sampling luck.
      let phases = 0;
      for (let phase = 0; phase < step; phase += PHASE_STEP, phases++) found.push(...sweeps(curves, kind, step, phase));
      found.sort((a, b) => b.confidence - a.confidence);
      const overlaps = (a: FilterMove, b: FilterMove) => a.filter === b.filter && a.dir === b.dir && a.t0 < b.t1 && b.t0 < a.t1;
      for (const f of found) {
        if (out.some((o) => o.kind === "filter" && overlaps(o, f))) continue;
        const votes = found.filter((g) => overlaps(g, f)).length;
        // phase-stable sweeps are the trustworthy ones: fold the vote share into confidence
        if (votes >= MIN_VOTES) out.push({ ...f, confidence: f.confidence * (0.5 + (0.5 * Math.min(votes, phases)) / phases) });
      }
    }
    return out;
  },
};
