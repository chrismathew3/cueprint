// Musical key helpers: key index <-> Camelot wheel, names, compatibility, span votes. Pure, no deps.
// Key index: 0..11 = major C..B, 12..23 = minor C..B, -1 = unknown (see KeyCurve).

import type { CamelotKey, KeyCurve } from "./index.ts";

const PITCH = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"] as const;
/** Camelot number of each major key, C..B (C major = 8B). */
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1] as const;

export function toCamelot(keyIndex: number): CamelotKey {
  if (!(keyIndex >= 0 && keyIndex < 24)) throw new RangeError(`toCamelot: bad key index ${keyIndex}`);
  const pc = keyIndex % 12;
  // a minor key sits on the same number as its relative major (3 semitones up): A minor = C major = 8
  return keyIndex < 12
    ? { number: CAMELOT_MAJOR[pc], letter: "B" }
    : { number: CAMELOT_MAJOR[(pc + 3) % 12], letter: "A" };
}

export function fromCamelot(k: CamelotKey): number {
  const majorPc = CAMELOT_MAJOR.indexOf(k.number as (typeof CAMELOT_MAJOR)[number]);
  if (majorPc < 0) throw new RangeError(`fromCamelot: bad number ${k.number}`);
  return k.letter === "B" ? majorPc : 12 + ((majorPc + 9) % 12);
}

export function camelotLabel(k: CamelotKey): string {
  return `${k.number}${k.letter}`;
}

export function keyName(keyIndex: number): string {
  if (!(keyIndex >= 0 && keyIndex < 24)) return "unknown";
  return `${PITCH[keyIndex % 12]} ${keyIndex < 12 ? "major" : "minor"}`;
}

/** Mixable on the Camelot wheel: same key, ±1 with the same letter, or relative major/minor (same number). */
export function camelotCompatible(a: CamelotKey, b: CamelotKey): boolean {
  if (a.number === b.number) return true;
  if (a.letter !== b.letter) return false;
  const d = (((a.number - b.number) % 12) + 12) % 12;
  return d === 1 || d === 11;
}

/**
 * Confidence-weighted vote over the key windows whose centers fall in [t0, t1].
 * confidence = winner's summed confidence / number of windows in the span, so it drops both
 * when windows disagree and when they are individually weak. Null when no window has a key.
 */
export function keyOver(keys: KeyCurve, t0: number, t1: number): { key: number; confidence: number } | null {
  const n = keys.key.length;
  if (!n || !(t1 > t0)) return null;
  const i0 = Math.max(0, Math.ceil(t0 * keys.rate - 0.5));
  const i1 = Math.min(n - 1, Math.floor(t1 * keys.rate - 0.5));
  if (i1 < i0) return null;
  const votes = new Float64Array(24);
  for (let i = i0; i <= i1; i++) {
    const k = keys.key[i];
    if (k >= 0 && k < 24) votes[k] += keys.confidence[i];
  }
  let best = -1, bestW = 0;
  for (let k = 0; k < 24; k++) if (votes[k] > bestW) { bestW = votes[k]; best = k; }
  if (best < 0) return null;
  return { key: best, confidence: Math.min(1, bestW / (i1 - i0 + 1)) };
}
