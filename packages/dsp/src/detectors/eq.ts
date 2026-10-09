// EQ cuts: a band sits well below its rolling "full EQ" reference for at least a bar.
// Deep (< -20 dB) is a kill; a fast drop into the cut is "sharp" (knob/kill switch, not a fade).

import { BANDS, type Band, type Detector, type EqMove } from "@cueprint/core";
import { barSeconds } from "../curves.ts";
import { clamp01, moveId, percentile, runs } from "../util.ts";

/** dB below reference that counts as a cut, per band. */
export const EQ_THRESH_DB: Record<Band, number> = { low: -9, lowmid: -7, himid: -7, hi: -8 };
const KILL_DB = -20;

export const eqDetector: Detector = {
  kind: "eq",
  name: "EQ cuts",
  detect({ curves, grid }) {
    const out: EqMove[] = [];
    for (const band of BANDS) {
      const { rate, values: rel } = curves[band];
      const thresh = EQ_THRESH_DB[band];
      const n = rel.length;
      const minLen = Math.max(1, Math.floor(barSeconds(grid) * rate));
      const mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) mask[i] = rel[i] < thresh ? 1 : 0;
      for (const [s, e] of runs(mask, minLen)) {
        const depth = percentile(rel, 10, s, e);
        const p0 = Math.max(0, s - rate), p1 = Math.min(n, s + Math.floor(rate * 0.5));
        let lo = Infinity, hi = -Infinity;
        for (let i = p0; i < p1; i++) { if (rel[i] < lo) lo = rel[i]; if (rel[i] > hi) hi = rel[i]; }
        const sharp = p1 > p0 && hi - lo > Math.abs(thresh);
        const kill = depth < KILL_DB;
        const t0 = s / rate, t1 = Math.min(e, n - 1) / rate;
        // confidence: how far past the threshold, how abrupt, how long (bars)
        const bars = (t1 - t0) / barSeconds(grid);
        const confidence = clamp01(0.35 + 0.3 * clamp01((thresh - depth) / 12) + (sharp ? 0.2 : 0) + 0.15 * clamp01((bars - 1) / 3));
        out.push({
          kind: "eq", id: moveId("eq", t0), t0, t1, confidence, verdict: "pending",
          band, depthDb: Math.round(depth * 10) / 10, kill, sharp,
        });
      }
    }
    return out;
  },
};
