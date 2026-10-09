// Single-threaded pipeline: features -> beat grid -> curves -> detectors.
// Runs anywhere (Bun, worker, main thread). The browser pool reuses finishAnalysis.

import { SCHEMA_VERSION, type Analysis, type DetectorContext, type Detector, type Move, type Pcm } from "@cueprint/core";
import { beatGrid } from "./beats.ts";
import { computeCurves } from "./curves.ts";
import { defaultDetectors } from "./detectors/index.ts";
import { computeFeatures, mergeFeatures, type MergedFeatures } from "./features.ts";
import { detectKeys } from "./key.ts";

export type AnalyzeStage = "features" | "beats" | "curves" | "detectors" | "done";
export type ProgressFn = (fraction: number, stage: AnalyzeStage) => void;
export type AudioAnalysis = Omit<Analysis, "vision">;

export interface AnalyzeOptions {
  /** Detectors to run. Default `defaultDetectors`. */
  detectors?: readonly Detector[];
  onProgress?: ProgressFn;
}

/** Share of the progress bar spent in feature extraction (the rest is grid/curves/detectors). */
export const FEATURE_SHARE = 0.85;

export function analyze(pcm: Pcm, opts: AnalyzeOptions = {}): AudioAnalysis {
  const p = opts.onProgress;
  const chunk = computeFeatures(pcm, { onProgress: p && ((f) => p(f * FEATURE_SHARE, "features")) });
  return finishAnalysis(mergeFeatures([chunk]), opts);
}

/** Everything after feature extraction. Returns the analysis plus the detector context. */
export function finishAnalysisWithContext(merged: MergedFeatures, opts: AnalyzeOptions = {}): { analysis: AudioAnalysis; ctx: DetectorContext } {
  const p = opts.onProgress;
  const { features, spectrogram } = merged;
  const grid = beatGrid(features);
  p?.(FEATURE_SHARE + 0.05, "beats");
  const curves = computeCurves(features, grid);
  p?.(FEATURE_SHARE + 0.08, "curves");
  const ctx: DetectorContext = { features, grid, curves };
  const moves = runDetectors(ctx, opts.detectors ?? defaultDetectors);
  const keys = detectKeys(features);
  p?.(1, "done");
  return {
    ctx,
    analysis: { schema: SCHEMA_VERSION, duration: features.duration, grid, curves, spectrogram, moves, keys, tracks: [], annotations: [] },
  };
}

export function finishAnalysis(merged: MergedFeatures, opts: AnalyzeOptions = {}): AudioAnalysis {
  return finishAnalysisWithContext(merged, opts).analysis;
}

/** Run detectors, sort by time, and make ids unique (`eq-123`, then `eq-123-2`, ...). */
export function runDetectors(ctx: DetectorContext, detectors: readonly Detector[], existing: readonly Move[] = []): Move[] {
  const moves: Move[] = [...existing];
  for (const d of detectors) moves.push(...d.detect(ctx));
  return finalizeMoves(moves);
}

export function finalizeMoves(moves: Move[]): Move[] {
  moves.sort((a, b) => a.t0 - b.t0 || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const used = new Set<string>();
  return moves.map((m) => {
    let id = m.id;
    for (let k = 2; used.has(id); k++) id = `${m.id}-${k}`;
    used.add(id);
    return id === m.id ? m : { ...m, id };
  });
}
