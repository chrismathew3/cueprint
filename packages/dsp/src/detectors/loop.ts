// Loops: stretches where 2 or 4 bars repeat near-identically at fine spectral resolution.
// House tracks repeat too, so this is a hint only: verdict "not proven", low confidence.

import type { Detector, LoopMove } from "@cueprint/core";
import { clamp01, moveId, percentile, runs } from "../util.ts";

const LENGTHS = [8, 16]; // beats
const MIN_SIM = 0.97;
const TOP_DB = 80;

export const loopDetector: Detector = {
  kind: "loop",
  name: "Loops",
  detect({ features, grid }) {
    const { mel, melBins: nm, rate } = features;
    const n = mel.length / nm;
    const beats = grid.beats;
    const nb = beats.length;
    if (nb < 2 * LENGTHS[0] + 2) return [];
    let gmax = -Infinity;
    for (let i = 0; i < mel.length; i++) if (mel[i] > gmax) gmax = mel[i];
    const floor = gmax - TOP_DB;
    // beat-synced mean of log-mel; column j = [beat j, beat j+1) (last runs to the end)
    const bv = new Float64Array(nb * nm);
    for (let j = 0; j < nb; j++) {
      const f0 = Math.min(n, Math.round(beats[j] * rate));
      const f1 = j + 1 < nb ? Math.min(n, Math.round(beats[j + 1] * rate)) : n;
      const o = j * nm;
      if (f1 <= f0) continue;
      for (let f = f0; f < f1; f++) {
        const mo = f * nm;
        for (let i = 0; i < nm; i++) bv[o + i] += mel[mo + i] > floor ? mel[mo + i] : floor;
      }
      let mu = 0;
      for (let i = 0; i < nm; i++) { bv[o + i] /= f1 - f0; mu += bv[o + i]; }
      mu /= nm;
      let norm = 0;
      for (let i = 0; i < nm; i++) { bv[o + i] -= mu; norm += bv[o + i] ** 2; }
      norm = Math.sqrt(norm) + 1e-9;
      for (let i = 0; i < nm; i++) bv[o + i] /= norm;
    }
    const out: LoopMove[] = [];
    for (const L of LENGTHS) {
      const m = nb - 2 * L;
      if (m <= 0) continue;
      // dot[i] = <bv_i, bv_{i+L}>, sims[i] = mean(dot[i .. i+L))
      const dot = new Float64Array(nb - L);
      for (let i = 0; i < nb - L; i++) {
        let acc = 0;
        const a = i * nm, b = (i + L) * nm;
        for (let k = 0; k < nm; k++) acc += bv[a + k] * bv[b + k];
        dot[i] = acc;
      }
      const sims = new Float64Array(m);
      let acc = 0;
      for (let i = 0; i < L; i++) acc += dot[i];
      for (let i = 0; i < m; i++) {
        sims[i] = acc / L;
        acc += dot[i + L] - dot[i];
      }
      const thr = Math.max(MIN_SIM, percentile(sims, 98));
      const mask = new Uint8Array(m);
      for (let i = 0; i < m; i++) mask[i] = sims[i] > thr ? 1 : 0;
      for (const [s, e] of runs(mask, 2)) {
        let sim = 0;
        for (let i = s; i < e; i++) if (sims[i] > sim) sim = sims[i];
        const t0 = beats[s], t1 = beats[Math.min(e - 1 + 2 * L, nb - 1)];
        out.push({
          kind: "loop", id: moveId("loop", t0), t0, t1, verdict: "not proven",
          confidence: clamp01(0.15 + 0.35 * ((sim - thr) / Math.max(1e-6, 1 - thr))),
          bars: L / 4, similarity: Math.round(sim * 1000) / 1000,
        });
      }
    }
    return out;
  },
};
