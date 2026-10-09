// Messages between analyzeParallel (main thread) and worker.ts. Plain data only.
import type { FeatureFrames } from "@cueprint/core";
import type { AnalyzeStage, AudioAnalysis } from "./analyze.ts";
import type { FeatureChunk } from "./features.ts";

export type ToWorker =
  | {
      type: "features";
      id: number;
      sampleRate: number;
      /** Either a shared buffer holding the whole signal (crossOriginIsolated) or a copied slice. */
      shared?: { buffer: SharedArrayBuffer; byteOffset: number; length: number };
      slice?: Float32Array;
      sampleOffset: number;
      totalSamples: number;
      startFrame: number;
      endFrame: number;
    }
  | {
      type: "finish";
      id: number;
      chunks: FeatureChunk[];
      /** Names of built-in detectors to run in the worker (null = all defaults). */
      detectors: string[] | null;
      /** Send the merged features back (needed to run custom detectors on the main thread). */
      returnContext: boolean;
    };

export type FromWorker =
  | { type: "progress"; id: number; fraction: number; stage: AnalyzeStage }
  | { type: "chunk"; id: number; chunk: FeatureChunk }
  | { type: "done"; id: number; analysis: AudioAnalysis; features?: FeatureFrames }
  | { type: "error"; id: number; message: string };
