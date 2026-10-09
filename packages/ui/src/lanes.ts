// Timeline lanes are plugins: { id, label, height, draw }. The studio stacks them
// under the GPU spectrogram. Add a lane to teach a new technique without touching the core.
import { moveArrow, moveLabel, type Analysis, type Move, type Transition, type VisionFrame } from "@cueprint/core";
import { theme, trackColor } from "./theme.ts";

export interface LaneView {
  readonly g: CanvasRenderingContext2D;
  readonly t0: number;
  readonly t1: number;
  readonly t: number;
  /** Lane box in CSS px. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly X: (t: number) => number;
  readonly analysis: Analysis;
  readonly transitions: readonly Transition[];
  readonly activeTransition: string | null;
  readonly frames: readonly VisionFrame[];
  readonly hover: Move | null;
}

export interface Lane {
  readonly id: string;
  readonly label: string;
  readonly height: number;
  /** Draw the spectrogram underneath this lane (the GPU canvas). Only one lane should. */
  readonly spectrum?: boolean;
  draw(v: LaneView): void;
}

export const defineLane = (lane: Lane): Lane => lane;

function lowerBound(arr: ArrayLike<number>, t: number) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < t) lo = m + 1; else hi = m; }
  return lo;
}

/** Bar k starts at beats[downbeat + 4k]. */
export function barTime(a: Analysis, bar: number): number | null {
  const i = a.grid.downbeat + Math.round(bar) * 4;
  return i >= 0 && i < a.grid.beats.length ? a.grid.beats[i] : null;
}

const label = (g: CanvasRenderingContext2D, size = 9.5, weight = 500) => {
  g.font = `${weight} ${size}px ${theme.mono}`;
  g.textBaseline = "middle";
};

/** 16-bar phrase blocks with bar numbers: the grid a DJ mixes on. */
export const phrasesLane = defineLane({
  id: "phrases", label: "PHRASE", height: 20,
  draw({ g, t0, t1, X, y, h, analysis }) {
    const { beats, downbeat } = analysis.grid;
    label(g, 9.5, 600);
    const first = Math.max(0, Math.floor((lowerBound(beats, t0) - downbeat) / 64) - 1);
    for (let p = first; ; p++) {
      const a = barTime(analysis, p * 16), b = barTime(analysis, (p + 1) * 16) ?? analysis.duration;
      if (a == null || a > t1) break;
      if (b < t0) continue;
      g.fillStyle = p % 2 ? theme.plate2 : theme.well;
      g.fillRect(X(a), y + 3, X(b) - X(a) - 1, h - 6);
      g.fillStyle = theme.ink;
      g.fillRect(X(a), y + 3, 1.5, h - 6);
      g.fillText(`${p * 16 + 1}`, X(a) + 5, y + h / 2);
    }
    // bar ticks
    const span = t1 - t0;
    if (span < 120) {
      g.fillStyle = theme.line2;
      for (let i = Math.max(downbeat, lowerBound(beats, t0)); i < beats.length && beats[i] <= t1; i++) {
        if ((i - downbeat) % 4) continue;
        g.fillRect(X(beats[i]), y + h - 6, 1, 3);
      }
    }
  },
});

export const transitionsLane = defineLane({
  id: "transitions", label: "MIX", height: 22,
  draw({ g, t0, t1, X, y, h, transitions, activeTransition, analysis }) {
    label(g, 9.5, 600);
    transitions.forEach((tr, i) => {
      if (tr.t1 < t0 || tr.t0 > t1) return;
      const xa = X(tr.t0), xb = X(tr.t1), on = tr.id === activeTransition;
      g.fillStyle = on ? theme.hot : theme.ink;
      g.fillRect(xa, y + 4, Math.max(3, xb - xa), h - 8);
      g.fillStyle = theme.plate2;
      const from = analysis.tracks[tr.from]?.title, to = analysis.tracks[tr.to]?.title;
      const text = `T${i + 1}${from && to ? `  ${from} → ${to}` : ""} · ${tr.bars} bars${tr.onPhrase ? "" : " · off phrase"}`;
      g.save(); g.beginPath(); g.rect(xa, y, xb - xa, h); g.clip();
      g.fillText(text, xa + 6, y + h / 2);
      g.restore();
    });
  },
});

export const spectrumLane = defineLane({
  id: "spectrum", label: "AUDIO", height: 72, spectrum: true,
  draw({ g, t0, t1, X, y, h, analysis, hover }) {
    for (const m of analysis.moves) {
      if (m.t1 < t0 || m.t0 > t1 || m.kind === "section") continue;
      const xa = X(m.t0), xb = Math.max(X(m.t1), xa + 4);
      const proven = m.verdict === "hand moving";
      g.strokeStyle = proven ? theme.hot : theme.ink;
      g.lineWidth = m === hover ? 2.5 : proven ? 2 : 1;
      g.setLineDash(m.kind === "loop" ? [3, 3] : []);
      g.strokeRect(xa + 0.5, y + 2.5, xb - xa, h - 5);
      g.setLineDash([]);
    }
    g.lineWidth = 1;
  },
});

export const tracksLane = defineLane({
  id: "tracks", label: "TRACK", height: 20,
  draw({ g, t0, t1, X, y, h, w, x, analysis }) {
    const tracks = analysis.tracks;
    label(g, 10, 600);
    if (!tracks.length) {
      g.fillStyle = theme.soft;
      g.fillText("NO TRACKLIST · ADD ONE IN NOTES", x + 8, y + h / 2);
      return;
    }
    tracks.forEach((tr, i) => {
      const a = tr.start, b = tracks[i + 1]?.start ?? analysis.duration;
      if (b < t0 || a > t1) return;
      const xa = Math.max(X(a), x);
      g.strokeStyle = trackColor(i);
      g.lineWidth = 1.5;
      g.strokeRect(xa + 0.75, y + 4.75, Math.min(X(b), x + w) - xa - 3, h - 9.5);
      g.lineWidth = 1;
      g.fillStyle = trackColor(i);
      g.save(); g.beginPath(); g.rect(xa, y, Math.min(X(b), x + w) - xa - 6, h); g.clip();
      g.fillText(`${i % 2 ? "B" : "A"}  ${tr.title}${tr.confident ? "" : " ?"}`.toUpperCase(), xa + 7, y + h / 2);
      g.restore();
    });
  },
});

export const movesLane = defineLane({
  id: "moves", label: "MOVES", height: 32,
  draw({ g, t0, t1, X, y, analysis, hover }) {
    label(g, 9.5, 600);
    for (const m of analysis.moves) {
      if (m.kind === "section" || m.t1 < t0 || m.t0 > t1) continue;
      const row = m.kind === "loop" ? 1 : 0;
      const xa = X(m.t0), xb = Math.max(X(m.t1), xa + 6), yy = y + 3 + row * 15;
      const proven = m.verdict === "hand moving";
      g.fillStyle = proven ? theme.hot : m === hover ? theme.ink : theme.plate2;
      g.fillRect(xa, yy, xb - xa, 13);
      g.strokeStyle = proven ? theme.hot : theme.ink;
      g.strokeRect(xa + 0.5, yy + 0.5, xb - xa - 1, 12);
      g.fillStyle = proven || m === hover ? theme.plate2 : theme.ink;
      g.fillText(`${moveLabel(m)} ${moveArrow(m)}`, xa + 4, yy + 7);
    }
  },
});

export const eqLane = defineLane({
  id: "eq", label: "EQ", height: 40,
  draw({ g, t0, t1, X, y, h, w, analysis }) {
    const yOf = (v: number) => y + 4 + (1 - (Math.max(-40, Math.min(8, v)) + 40) / 48) * (h - 8);
    g.strokeStyle = theme.line;
    g.beginPath(); g.moveTo(X(t0), yOf(0)); g.lineTo(X(t1), yOf(0)); g.stroke();
    const styles: [keyof Analysis["curves"], string, number[], number][] = [
      ["low", theme.ink, [], 1.6], ["lowmid", theme.ink, [4, 3], 1], ["himid", theme.soft, [1, 3], 1], ["hi", theme.soft, [], 1.1],
    ];
    for (const [k, col, dash, lw] of styles) {
      const c = analysis.curves[k];
      const i0 = Math.max(0, Math.floor(t0 * c.rate)), i1 = Math.min(c.values.length - 1, Math.ceil(t1 * c.rate));
      const stride = Math.max(1, Math.floor((i1 - i0) / w));
      g.strokeStyle = col; g.setLineDash(dash); g.lineWidth = lw;
      g.beginPath();
      for (let i = i0; i <= i1; i += stride) { const px = X(i / c.rate), py = yOf(c.values[i]); i === i0 ? g.moveTo(px, py) : g.lineTo(px, py); }
      g.stroke();
    }
    g.setLineDash([]); g.lineWidth = 1;
  },
});

export const cameraLane = defineLane({
  id: "camera", label: "CAMERA", height: 14,
  draw({ g, t0, t1, X, y, h, x, frames }) {
    if (!frames.length) {
      label(g); g.fillStyle = theme.soft;
      g.fillText("HAND TRACKING PENDING", x + 8, y + h / 2);
      return;
    }
    let lo = 0, hi = frames.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (frames[m].t < t0) lo = m + 1; else hi = m; }
    for (let i = Math.max(0, lo - 1); i < frames.length && frames[i].t <= t1; i++) {
      const f = frames[i], nx = frames[i + 1];
      const xa = X(f.t), xb = nx && nx.t - f.t < 1 ? X(nx.t) : xa + 2;
      g.fillStyle = f.view === "front" ? theme.line2 : f.view === "side" ? theme.line : theme.plate2;
      g.fillRect(xa, y + 4, xb - xa + 0.5, h - 8);
      if (f.activity > 0.06) {
        g.fillStyle = theme.hot;
        g.fillRect(xa, y + 4, Math.max(1.5, xb - xa - 0.5), h - 8);
      }
    }
  },
});

export const notesLane = defineLane({
  id: "notes", label: "NOTES", height: 16,
  draw({ g, t0, t1, X, y, h, analysis }) {
    label(g, 10, 500);
    for (const a of analysis.annotations) {
      if (a.t < t0 - 30 || a.t > t1) continue;
      const px = X(a.t);
      g.fillStyle = theme.hot;
      g.fillRect(px, y + 3, 2, h - 6);
      g.fillStyle = theme.ink;
      g.fillText(a.text.slice(0, 48), px + 6, y + h / 2);
    }
  },
});

export const defaultLanes: readonly Lane[] = [phrasesLane, transitionsLane, spectrumLane, tracksLane, movesLane, eqLane, cameraLane, notesLane];
export const drillLanes: readonly Lane[] = [phrasesLane, { ...spectrumLane, draw() {} }, tracksLane, cameraLane];
