// Turns an analysis into "what's on each deck right now". Tracks alternate decks
// (track 0 → A, 1 → B, 2 → A...), which is how a two-deck set actually runs.
import { useMemo } from "react";
import { camelotCompatible, deriveTransitions, keyOver, toCamelot, type Analysis, type CamelotKey, type Transition } from "@cueprint/core";

export function useTransitions(a: Analysis): Transition[] {
  return useMemo(() => deriveTransitions(a), [a.moves, a.tracks, a.grid, a.keys]);
}

export type DeckState = "on air" | "cued" | "out" | "idle";

export interface DeckView {
  readonly letter: "A" | "B";
  readonly track: number; // index into analysis.tracks, -1 unknown
  readonly state: DeckState;
  readonly key: CamelotKey | null;
  /** 0..23 key index (see core KeyCurve), -1 unknown. */
  readonly keyIndex: number;
  readonly keyConfidence: number;
}

export interface MixContext {
  readonly a: DeckView;
  readonly b: DeckView;
  readonly transition: Transition | null; // the one we're inside, if any
  readonly next: Transition | null;
  readonly harmonic: boolean | null;
}

/** Below this the key is a guess: show it with a "?". Detector margins run ~0.04–0.25. */
export const KEY_SURE = 0.1;

export function trackSpan(a: Analysis, i: number): [number, number] {
  const tr = a.tracks[i];
  return [tr?.start ?? 0, a.tracks[i + 1]?.start ?? a.duration];
}

export function trackKey(a: Analysis, i: number): { key: CamelotKey; index: number; confidence: number } | null {
  if (!a.keys || i < 0 || i >= a.tracks.length) return null;
  const [s, e] = trackSpan(a, i);
  // skip the blend at each end so the other track doesn't pollute the vote
  const pad = Math.min(30, (e - s) / 4);
  const k = keyOver(a.keys, s + pad, e - pad);
  return k ? { key: toCamelot(k.key), index: k.key, confidence: k.confidence } : null;
}

export function mixAt(a: Analysis, transitions: readonly Transition[], t: number): MixContext {
  const inside = transitions.find((tr) => t >= tr.t0 && t <= tr.t1) ?? null;
  const next = transitions.find((tr) => tr.t0 > t) ?? null;
  let cur = -1;
  a.tracks.forEach((tr, i) => { if (tr.start <= t) cur = i; });
  if (cur < 0 && a.tracks.length) cur = 0;

  const deck = (track: number, state: DeckState): DeckView => {
    const k = trackKey(a, track);
    return { letter: track % 2 === 0 ? "A" : "B", track, state, key: k?.key ?? null, keyIndex: k?.index ?? -1, keyConfidence: k?.confidence ?? 0 };
  };

  let out: DeckView, inn: DeckView;
  if (inside && inside.from >= 0) {
    out = deck(inside.from, "on air");
    inn = deck(inside.to, "on air");
  } else if (cur >= 0) {
    out = deck(cur, "on air");
    inn = cur + 1 < a.tracks.length ? deck(cur + 1, "cued") : { letter: cur % 2 ? "A" : "B", track: -1, state: "idle", key: null, keyIndex: -1, keyConfidence: 0 };
  } else {
    // no tracklist: one anonymous deck, keyed from the last 60 s
    const k = a.keys ? keyOver(a.keys, Math.max(0, t - 60), t + 1) : null;
    out = { letter: "A", track: -1, state: "on air", key: k ? toCamelot(k.key) : null, keyIndex: k?.key ?? -1, keyConfidence: k?.confidence ?? 0 };
    inn = { letter: "B", track: -1, state: "idle", key: null, keyIndex: -1, keyConfidence: 0 };
  }
  const [deckA, deckB] = out.letter === "A" ? [out, inn] : [inn, out];
  const harmonic = deckA.key && deckB.key ? camelotCompatible(deckA.key, deckB.key) : null;
  return { a: deckA, b: deckB, transition: inside, next, harmonic };
}
