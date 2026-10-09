// Shared contract for every studio package. Plain data only: everything here
// crosses worker boundaries, gets cached to OPFS, and could be served by an API.

export const SCHEMA_VERSION = 2;

/** Mono PCM at a known rate. The DSP engine only ever sees this. */
export interface Pcm {
  readonly sampleRate: number;
  readonly samples: Float32Array;
}

export type Band = "low" | "lowmid" | "himid" | "hi";
export const BANDS: readonly Band[] = ["low", "lowmid", "himid", "hi"];
export const BAND_HZ: Record<Band, readonly [number, number]> = {
  low: [20, 150],
  lowmid: [150, 800],
  himid: [800, 4000],
  hi: [4000, 11000],
};

/** Time series sampled at a fixed rate (Hz), t = i / rate. */
export interface Curve {
  readonly rate: number;
  readonly values: Float32Array;
}

export interface Curves {
  /** Band level relative to its rolling 16-bar reference, dB. 0 = track at full EQ. */
  readonly low: Curve;
  readonly lowmid: Curve;
  readonly himid: Curve;
  readonly hi: Curve;
  /** Spectral edge an HPF would move (8% rolloff), Hz. */
  readonly hpfHz: Curve;
  /** Spectral edge an LPF would move (85% rolloff), Hz. */
  readonly lpfHz: Curve;
}

/** Display spectrogram: `bins` mel rows x `frames` columns, column-major, 0..255 (low freq = row 0). */
export interface Spectrogram {
  readonly bins: number;
  readonly frames: number;
  /** Columns per second. */
  readonly rate: number;
  readonly data: Uint8Array;
}

export interface BeatGrid {
  readonly bpm: number;
  /** Beat times, seconds. */
  readonly beats: Float64Array;
  /** Index into `beats` of the first downbeat; bars start every 4 beats from here. */
  readonly downbeat: number;
  /** BPM per beat (smoothed), same length as beats. */
  readonly localBpm: Float32Array;
}

// ---------- moves ----------

export type Verdict =
  | "hand moving"   // camera saw a hand moving on the mixer at the move
  | "hands still"   // camera on the booth, hands not moving: likely the track itself
  | "no camera"     // edit cut away
  | "not proven"    // heuristic only (loops)
  | "structure"     // section boundary, not a DJ action
  | "pending";      // vision not run yet

export type BoothZone = "LEFT DECK" | "MIXER L" | "MIXER CENTER" | "MIXER R" | "RIGHT DECK" | "HANDS UP";

interface MoveBase {
  readonly id: string;
  readonly t0: number;
  readonly t1: number;
  /** 0..1, detector's own confidence before any camera check. */
  readonly confidence: number;
  verdict: Verdict;
  /** Zone the hand was moving in when verdict === "hand moving". */
  zone?: BoothZone;
}

export interface EqMove extends MoveBase {
  readonly kind: "eq";
  readonly band: Band;
  readonly depthDb: number;
  readonly kill: boolean;
  readonly sharp: boolean;
}

export interface FilterMove extends MoveBase {
  readonly kind: "filter";
  readonly filter: "HPF" | "LPF";
  readonly dir: "close" | "open";
  readonly fromHz: number;
  readonly toHz: number;
}

export interface LoopMove extends MoveBase {
  readonly kind: "loop";
  readonly bars: number;
  readonly similarity: number;
}

export interface SectionMove extends MoveBase {
  readonly kind: "section";
  readonly strength: number;
}

export type Move = EqMove | FilterMove | LoopMove | SectionMove;
export type MoveKind = Move["kind"];

export const BAND_LABEL: Record<Band, string> = { low: "LOW", lowmid: "LOW MID", himid: "HI MID", hi: "HI" };

export function moveLabel(m: Move): string {
  switch (m.kind) {
    case "eq": return `${BAND_LABEL[m.band]} ${m.kill ? "KILL" : "CUT"}`;
    case "filter": return `${m.filter} ${m.dir === "close" ? "CLOSE" : "OPEN"}`;
    case "loop": return `LOOP ${m.bars} BARS`;
    case "section": return "SECTION";
  }
}

export function moveArrow(m: Move): string {
  if (m.kind === "eq") return "↓";
  if (m.kind === "filter") return (m.filter === "HPF") === (m.dir === "close") ? "↑" : "↓";
  return "";
}

export function moveDetail(m: Move): string {
  switch (m.kind) {
    case "eq": return `${m.depthDb.toFixed(1)} dB · ${(m.t1 - m.t0).toFixed(1)}s`;
    case "filter": return `${fmtHz(m.fromHz)} → ${fmtHz(m.toHz)}`;
    case "loop": return `repeat ${(m.similarity * 100).toFixed(1)}%`;
    case "section": return "";
  }
}

export function fmtHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)}k` : `${Math.round(hz)}`;
}

// ---------- vision ----------

export type View = "front" | "side" | "crowd";

export interface HandSample {
  /** Pinch point (thumb + index tip midpoint), normalized 0..1 video coords. */
  readonly x: number;
  readonly y: number;
  readonly zone: BoothZone | null;
}

export interface VisionFrame {
  readonly t: number;
  readonly shot: number;
  readonly view: View;
  readonly hands: readonly HandSample[];
  /** Hand motion on the mixer since previous frame, in shoulder widths. 0 when not measurable. */
  readonly activity: number;
}

export interface VisionTrack {
  readonly sampleFps: number;
  readonly frames: readonly VisionFrame[];
  /** Fraction of random moments where a hand is moving on the mixer: the honesty baseline. */
  readonly baseline: number;
}

// ---------- tracks & lessons ----------

export interface Track {
  readonly start: number;
  readonly artist: string;
  readonly title: string;
  readonly confident: boolean;
}

export interface Annotation {
  readonly id: string;
  readonly t: number;
  readonly text: string;
}

// ---------- harmony ----------

/** Musical key as Camelot wheel position: number 1..12, letter A (minor) / B (major). */
export interface CamelotKey {
  readonly number: number;
  readonly letter: "A" | "B";
}

/** Key estimate over time, one value per window. `key` index 0..23 (0..11 major C..B, 12..23 minor C..B), -1 = unknown. */
export interface KeyCurve {
  readonly rate: number;
  readonly key: Int8Array;
  /** 0..1 strength of the best key vs the runner-up. */
  readonly confidence: Float32Array;
}

// ---------- transitions: the unit a DJ learns ----------

export interface TransitionStep {
  readonly moveId: string;
  /** Bars from transition start (can be fractional; 0 = first bar). */
  readonly bar: number;
  readonly t: number;
  /** Plain-language instruction, e.g. "Sweep the high-pass up on the outgoing track". */
  readonly text: string;
}

export interface Transition {
  readonly id: string;
  /** Index into Analysis.tracks of the outgoing / incoming track, -1 when there is no tracklist. */
  readonly from: number;
  readonly to: number;
  readonly t0: number;
  readonly t1: number;
  /** Bar index (from the grid downbeat) where the transition starts, and its length in bars. */
  readonly startBar: number;
  readonly bars: number;
  /** True when startBar falls on a 16-bar phrase boundary (±1 bar). */
  readonly onPhrase: boolean;
  readonly steps: readonly TransitionStep[];
  /** Keys of outgoing / incoming track at the transition, when known. */
  readonly fromKey?: CamelotKey;
  readonly toKey?: CamelotKey;
  /** Camelot-compatible: same, ±1, or relative major/minor. */
  readonly harmonic?: boolean;
}

// ---------- the whole analysis ----------

export interface Analysis {
  readonly schema: typeof SCHEMA_VERSION;
  readonly duration: number;
  readonly grid: BeatGrid;
  readonly curves: Curves;
  readonly spectrogram: Spectrogram;
  readonly moves: Move[];
  /** Added in schema 2. */
  readonly keys?: KeyCurve;
  vision?: VisionTrack;
  tracks: Track[];
  annotations: Annotation[];
}

export interface SetMeta {
  readonly id: string;
  readonly name: string;
  readonly artist: string;
  readonly venue: string;
  readonly fileName: string;
  readonly fileSize: number;
  /** Seconds into the full set where this file starts (for display). */
  readonly offset: number;
  readonly createdAt: number;
}

// ---------- plugin contracts ----------

/** Per-frame features the detectors share. All arrays are at `rate` Hz. */
export interface FeatureFrames {
  readonly rate: number;
  readonly duration: number;
  /** Band level in dB (absolute), one array per band. */
  readonly bandDb: Record<Band, Float32Array>;
  readonly rolloffLoHz: Float32Array;
  readonly rolloffHiHz: Float32Array;
  readonly onset: Float32Array;
  /** 12 x n chroma, frame-major ([frame * 12 + pc]). */
  readonly chroma: Float32Array;
  /** `melBins` x n log-mel dB, frame-major. */
  readonly mel: Float32Array;
  readonly melBins: number;
}

export interface DetectorContext {
  readonly features: FeatureFrames;
  readonly grid: BeatGrid;
  readonly curves: Curves;
}

/** A detector turns shared features into moves. Register more to teach new techniques. */
export interface Detector {
  readonly kind: MoveKind;
  readonly name: string;
  detect(ctx: DetectorContext): Move[];
}

export function fmtTime(s: number, tenths = false): string {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  const ss = tenths ? sec.toFixed(1).padStart(4, "0") : String(Math.floor(sec)).padStart(2, "0");
  return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m)) + ":" + ss;
}

export { toCamelot, fromCamelot, camelotLabel, keyName, camelotCompatible, keyOver } from "./keys.ts";
export { deriveTransitions, stepText, barClock, type BarClock } from "./transitions.ts";
