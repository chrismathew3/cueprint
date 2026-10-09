// @cueprint/dsp: pure-TS audio analysis for DJ sets. No runtime deps, no DOM in the core path.

export { RealFFT, hann } from "./fft.ts";
export {
  computeFeatures, mergeFeatures, frameCount, chunkTransferables,
  N_FFT, HOP, MEL_BINS, SPEC_BINS, SPEC_DECIMATE,
  type FeatureChunk, type FeatureOptions, type MergedFeatures,
} from "./features.ts";
export { beatGrid, estimatePeriod, trackBeats, localBpm, downbeatPhase, type BeatOptions } from "./beats.ts";
export { computeCurves, CURVE_RATE, barSeconds } from "./curves.ts";
export { defaultDetectors, eqDetector, filterDetector, sectionDetector, loopDetector } from "./detectors/index.ts";
export {
  analyze, finishAnalysis, finishAnalysisWithContext, runDetectors, finalizeMoves, FEATURE_SHARE,
  type AnalyzeOptions, type AnalyzeStage, type AudioAnalysis, type ProgressFn,
} from "./analyze.ts";
export { analyzeParallel, type ParallelOptions } from "./pool.ts";
export { detectKeys, scoreKey, KEY_PROFILES, KEY_STEP, KEY_CONTEXT, type KeyOptions, type KeyProfile } from "./key.ts";
