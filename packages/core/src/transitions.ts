// Transitions: "how did they get from track A to track B". Pure, derived from an Analysis.
//
// Rules:
// - Boundaries. With >= 2 tracks, every consecutive pair (i, i+1) is a transition centered near
//   tracks[i+1].start (chapter/Shazam starts can be off by ±30 s, hence the wide window below).
//   Without a tracklist, a boundary is a strong section move (strength >= STRONG_SECTION) that has a
//   low/lowmid EQ cut or a filter move within ±16 bars; from/to = -1. Boundaries closer than 32 bars
//   to an earlier one are dropped.
// - Window. EQ/filter moves (not loops or sections) starting in [boundary - 48 bars, boundary + 32 bars],
//   split into clusters wherever the gap between one move's end and the next start exceeds 16 bars;
//   the cluster nearest the boundary is the transition. t0 = first start snapped down to a bar,
//   t1 = last end snapped up. No moves: a 16-bar window ending at the boundary's bar.
// - Bars come from the grid: bar k starts at beats[downbeat + 4k] (extrapolated outside the grid).
//   onPhrase: startBar is within ±1 bar of a multiple of 16.
// - Keys (when analysis.keys exists): outgoing = vote over the 60 s before t0, incoming = 60 s after
//   t1, each clamped to its own track's span when there is a tracklist.

import { camelotCompatible, keyOver, toCamelot } from "./keys.ts";
import type { Analysis, BeatGrid, BoothZone, CamelotKey, EqMove, FilterMove, Move, Transition, TransitionStep } from "./index.ts";

const BEFORE_BARS = 48;
const AFTER_BARS = 32;
const GAP_BARS = 16;
const PHRASE_BARS = 16;
const MIN_BARS = 16;
const SECTION_PAIR_BARS = 16;
const MIN_SPACING_BARS = 32;
/** Section novelty strength that counts as a structural change worth calling a transition. */
const STRONG_SECTION = 1.5;
const KEY_SPAN_S = 60;

type MixMove = EqMove | FilterMove;

/** Bar index <-> time, from the beat grid. */
export interface BarClock {
  readonly barSeconds: number;
  /** Fractional bar index at time t (bar 0 starts at the downbeat). */
  barAt(t: number): number;
  /** Start time of (possibly fractional) bar k. */
  timeOfBar(k: number): number;
}

export function barClock(grid: BeatGrid): BarClock {
  const beats = grid.beats;
  const beatS = grid.bpm > 0 ? 60 / grid.bpm : 0.5;
  const d = Math.min(Math.max(0, grid.downbeat), Math.max(0, beats.length - 1));
  // beat-index <-> time, linear outside the grid
  const timeOfBeat = (b: number): number => {
    const n = beats.length;
    if (!n) return b * beatS;
    if (b <= 0) return beats[0] + b * beatS;
    if (b >= n - 1) return beats[n - 1] + (b - (n - 1)) * beatS;
    const i = Math.floor(b);
    return beats[i] + (b - i) * (beats[i + 1] - beats[i]);
  };
  const beatAt = (t: number): number => {
    const n = beats.length;
    if (!n) return t / beatS;
    if (t <= beats[0]) return (t - beats[0]) / beatS;
    if (t >= beats[n - 1]) return n - 1 + (t - beats[n - 1]) / beatS;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (beats[m] <= t) lo = m; else hi = m; }
    return lo + (t - beats[lo]) / (beats[hi] - beats[lo]);
  };
  return {
    barSeconds: 4 * beatS,
    barAt: (t) => (beatAt(t) - d) / 4,
    timeOfBar: (k) => timeOfBeat(d + 4 * k),
  };
}

const isMix = (m: Move): m is MixMove => m.kind === "eq" || m.kind === "filter";

const ZONE_TEXT: Partial<Record<BoothZone, string>> = {
  "MIXER L": "mixer left",
  "MIXER R": "mixer right",
  "MIXER CENTER": "mixer center",
  "LEFT DECK": "left deck",
  "RIGHT DECK": "right deck",
};

/** Plain-language DJ instruction for one EQ/filter move. */
export function stepText(m: MixMove): string {
  let text: string;
  if (m.kind === "eq") {
    text = m.band === "low" ? (m.kill ? "Kill the bass" : "Pull the low EQ down")
      : m.band === "lowmid" ? "Cut the low-mids"
      : "Cut the highs";
  } else if (m.filter === "HPF") {
    text = m.dir === "close" ? "Sweep the high-pass up" : "Open the high-pass back up";
  } else {
    text = m.dir === "close" ? "Close the low-pass" : "Open the low-pass back up";
  }
  const zone = m.verdict === "hand moving" && m.zone ? ZONE_TEXT[m.zone] : undefined;
  return zone ? `${text} (on camera, ${zone})` : text;
}

interface Boundary { t: number; from: number; to: number }

function boundaries(a: Analysis, clock: BarClock, mix: readonly MixMove[]): Boundary[] {
  if (a.tracks.length >= 2) {
    return a.tracks.slice(1).map((tr, i) => ({ t: tr.start, from: i, to: i + 1 }));
  }
  const pair = SECTION_PAIR_BARS * clock.barSeconds;
  const out: Boundary[] = [];
  const sections = a.moves.filter((m) => m.kind === "section" && m.strength >= STRONG_SECTION).sort((x, y) => x.t0 - y.t0);
  for (const s of sections) {
    const backed = mix.some((m) =>
      (m.kind === "filter" || m.band === "low" || m.band === "lowmid") && m.t0 <= s.t0 + pair && m.t1 >= s.t0 - pair);
    if (!backed) continue;
    const last = out[out.length - 1];
    if (last && s.t0 - last.t < MIN_SPACING_BARS * clock.barSeconds) continue;
    out.push({ t: s.t0, from: -1, to: -1 });
  }
  return out;
}

/** Cluster of moves nearest the boundary, or [] when none fall in the search window. */
function nearestCluster(mix: readonly MixMove[], b: number, clock: BarClock): MixMove[] {
  const lo = b - BEFORE_BARS * clock.barSeconds, hi = b + AFTER_BARS * clock.barSeconds;
  const gap = GAP_BARS * clock.barSeconds;
  const inWin = mix.filter((m) => m.t0 >= lo && m.t0 <= hi).sort((x, y) => x.t0 - y.t0);
  const clusters: MixMove[][] = [];
  let end = -Infinity;
  for (const m of inWin) {
    if (!clusters.length || m.t0 - end > gap) clusters.push([]);
    clusters[clusters.length - 1].push(m);
    end = Math.max(end, m.t1);
  }
  let best: MixMove[] = [], bestD = Infinity;
  for (const c of clusters) {
    const c0 = c[0].t0, c1 = Math.max(...c.map((m) => m.t1));
    const d = b < c0 ? c0 - b : b > c1 ? b - c1 : 0;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function keyAt(a: Analysis, t0: number, t1: number): CamelotKey | undefined {
  if (!a.keys || !(t1 > t0)) return undefined;
  const r = keyOver(a.keys, t0, t1);
  return r ? toCamelot(r.key) : undefined;
}

export function deriveTransitions(analysis: Analysis): Transition[] {
  const clock = barClock(analysis.grid);
  const mix = analysis.moves.filter(isMix);
  const tracks = analysis.tracks;
  const out: Transition[] = [];

  for (const b of boundaries(analysis, clock, mix)) {
    const cluster = nearestCluster(mix, b.t, clock);
    let startBar: number, endBar: number;
    if (cluster.length) {
      startBar = Math.floor(clock.barAt(cluster[0].t0) + 1e-6);
      endBar = Math.ceil(clock.barAt(Math.max(...cluster.map((m) => m.t1))) - 1e-6);
      if (endBar <= startBar) endBar = startBar + 1;
    } else {
      endBar = Math.round(clock.barAt(b.t));
      startBar = endBar - MIN_BARS;
    }
    const t0 = clock.timeOfBar(startBar), t1 = clock.timeOfBar(endBar);
    const phase = ((startBar % PHRASE_BARS) + PHRASE_BARS) % PHRASE_BARS;

    const steps: TransitionStep[] = cluster.map((m) => ({
      moveId: m.id,
      bar: Math.round((clock.barAt(m.t0) - startBar) * 10) / 10,
      t: m.t0,
      text: stepText(m),
    }));

    // key spans: 60 s either side, clamped to the outgoing / incoming track when known
    const fromStart = b.from >= 0 ? tracks[b.from].start : -Infinity;
    const toEnd = b.to >= 0 && b.to + 1 < tracks.length ? tracks[b.to + 1].start : Infinity;
    const fromKey = keyAt(analysis, Math.max(0, fromStart, t0 - KEY_SPAN_S), t0);
    const toKey = keyAt(analysis, t1, Math.min(analysis.duration, toEnd, t1 + KEY_SPAN_S));

    out.push({
      id: b.from >= 0 ? `tr-${b.from}-${b.to}` : `tr-${Math.round(b.t * 10)}`,
      from: b.from,
      to: b.to,
      t0,
      t1,
      startBar,
      bars: endBar - startBar,
      onPhrase: phase <= 1 || phase >= PHRASE_BARS - 1,
      steps,
      ...(fromKey && { fromKey }),
      ...(toKey && { toKey }),
      ...(fromKey && toKey && { harmonic: camelotCompatible(fromKey, toKey) }),
    });
  }
  return out;
}
