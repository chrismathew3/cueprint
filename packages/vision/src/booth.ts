// Pure geometry + fusion. No MediaPipe here so it runs anywhere and is easy to test.
import type { BoothZone, HandSample, Move, View, VisionFrame, VisionTrack } from "@cueprint/core";

/** Hand offset from torso center in shoulder widths. Positive = DJ's left. Mixer sits centered. */
const ZONES: readonly [number, number, BoothZone][] = [
  [0.85, 9, "LEFT DECK"],
  [0.28, 0.85, "MIXER L"],
  [-0.28, 0.28, "MIXER CENTER"],
  [-0.85, -0.28, "MIXER R"],
  [-9, -0.85, "RIGHT DECK"],
];

export function zoneFor(off: number): BoothZone | null {
  for (const [lo, hi, z] of ZONES) if (off >= lo && off < hi) return z;
  return null;
}

export const isMixer = (z: BoothZone | null | undefined) =>
  z === "MIXER L" || z === "MIXER CENTER" || z === "MIXER R";

export interface Pt { x: number; y: number; visibility?: number }

export interface PoseInput {
  nose: Pt; ls: Pt; rs: Pt; lh: Pt; rh: Pt;
}

export interface HandInput {
  wrist: Pt; thumbTip: Pt; indexTip: Pt;
}

export interface BodyFrame {
  view: View;
  /** shoulder center x, shoulder y, shoulder width (normalized x units) */
  cx: number; sy: number; sw: number;
}

/** Classify the camera view from the DJ's pose. Facing camera: his left shoulder on image right. */
export function classifyView(pose: PoseInput | null): BodyFrame | null {
  if (!pose) return null;
  const { nose, ls, rs } = pose;
  const sw = Math.abs(ls.x - rs.x);
  const vis = Math.min(ls.visibility ?? 1, rs.visibility ?? 1);
  if (vis < 0.5 || sw < 0.07) return null;
  const frontal = Math.min(ls.x, rs.x) < nose.x && nose.x < Math.max(ls.x, rs.x) && ls.x > rs.x;
  return { view: frontal && sw > 0.12 ? "front" : "side", cx: (ls.x + rs.x) / 2, sy: (ls.y + rs.y) / 2, sw };
}

/** Place one hand in the booth. Only hands near the DJ's body and big enough to be his count. */
export function placeHand(hand: HandInput, body: BodyFrame | null, aspect: number): HandSample {
  const x = (hand.thumbTip.x + hand.indexTip.x) / 2;
  const y = (hand.thumbTip.y + hand.indexTip.y) / 2;
  let zone: BoothZone | null = null;
  if (body && body.view === "front") {
    const span = Math.hypot(hand.indexTip.x - hand.wrist.x, (hand.indexTip.y - hand.wrist.y) * aspect);
    const off = (x - body.cx) / body.sw;
    const below = (y - body.sy) / body.sw;
    if (Math.abs(off) < 2.2 && span > body.sw * 0.25) {
      if (below > 0.55) zone = zoneFor(off);
      else if (below < -0.2) zone = "HANDS UP";
    }
  }
  return { x, y, zone };
}

/** Motion on the mixer since the previous frame of the same shot, in shoulder widths. */
export function mixerActivity(cur: HandSample[], prev: HandSample[] | null, sw: number): number {
  if (!prev || !sw) return 0;
  let best = 0;
  for (const h of cur) {
    if (!isMixer(h.zone)) continue;
    let d = Infinity;
    for (const g of prev) d = Math.min(d, Math.hypot(h.x - g.x, h.y - g.y));
    d /= sw;
    if (d < 0.6 && d > best) best = d; // bigger jumps are tracker swaps, not motion
  }
  return best;
}

// ---------- fusion ----------

export const ACTIVE = 0.06;
const WINDOW = 1.5;

function lowerBound(frames: readonly VisionFrame[], t: number) {
  let lo = 0, hi = frames.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (frames[m].t < t) lo = m + 1; else hi = m; }
  return lo;
}

export interface CameraWindow { nFront: number; active: number; zone: BoothZone | null }

export function cameraAt(frames: readonly VisionFrame[], t0: number, t1: number): CameraWindow {
  const counts = new Map<BoothZone, number>();
  let nFront = 0, active = 0;
  for (let i = lowerBound(frames, t0); i < frames.length && frames[i].t <= t1; i++) {
    const f = frames[i];
    if (f.view !== "front") continue;
    nFront++;
    if (f.activity > ACTIVE) {
      active++;
      for (const h of f.hands) if (isMixer(h.zone)) counts.set(h.zone!, (counts.get(h.zone!) ?? 0) + 1);
    }
  }
  let zone: BoothZone | null = null, best = 0;
  for (const [z, n] of counts) if (n > best) { best = n; zone = z; }
  return { nFront, active, zone };
}

export function verdictFor(w: CameraWindow): { verdict: Move["verdict"]; zone?: BoothZone } {
  if (w.nFront < 3) return { verdict: "no camera" };
  if (w.active >= 2 && w.zone) return { verdict: "hand moving", zone: w.zone };
  return { verdict: "hands still" };
}

/** Stamp camera verdicts onto EQ/filter moves. Loops and sections keep their own verdicts. */
export function fuse(moves: Move[], frames: readonly VisionFrame[]): void {
  for (const m of moves) {
    if (m.kind !== "eq" && m.kind !== "filter") continue;
    const v = verdictFor(cameraAt(frames, m.t0 - WINDOW, m.t0 + WINDOW));
    m.verdict = v.verdict;
    m.zone = v.zone;
  }
}

/** How often a random moment would also "agree". Deterministic sample so it's stable across runs. */
export function baseline(frames: readonly VisionFrame[], duration: number, n = 2000): number {
  let seed = 7, hits = 0, seen = 0;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const t = 2 + rand() * Math.max(0, duration - 4);
    const v = verdictFor(cameraAt(frames, t - WINDOW, t + WINDOW));
    if (v.verdict === "no camera") continue;
    seen++;
    if (v.verdict === "hand moving") hits++;
  }
  return seen ? hits / seen : 0;
}

export function finalizeTrack(frames: VisionFrame[], sampleFps: number, duration: number): VisionTrack {
  return { sampleFps, frames, baseline: baseline(frames, duration) };
}
