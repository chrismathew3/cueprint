// Small numeric helpers shared by detectors.

/** [start, end) index pairs where mask holds for at least minLen consecutive entries. */
export function runs(mask: ArrayLike<boolean | number>, minLen: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = -1;
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && !!mask[i];
    if (on && s < 0) s = i;
    else if (!on && s >= 0) {
      if (i - s >= minLen) out.push([s, i]);
      s = -1;
    }
  }
  return out;
}

/** numpy.percentile (linear interpolation) over x[start, end). */
export function percentile(x: ArrayLike<number>, q: number, start = 0, end = x.length): number {
  const n = end - start;
  if (n <= 0) return NaN;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = x[start + i];
  s.sort();
  const p = (q / 100) * (n - 1);
  const lo = Math.floor(p), hi = Math.min(n - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (p - lo);
}

export function mean(x: ArrayLike<number>, start = 0, end = x.length): number {
  start = Math.max(0, start);
  end = Math.min(x.length, end);
  if (end <= start) return NaN;
  let s = 0;
  for (let i = start; i < end; i++) s += x[i];
  return s / (end - start);
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function moveId(kind: string, t0: number): string {
  return `${kind}-${Math.round(t0 * 10)}`;
}

/** Bar start times from the grid (every 4th beat from the downbeat). */
export function barTimes(beats: Float64Array, downbeat: number): Float64Array {
  const n = Math.max(0, Math.ceil((beats.length - downbeat) / 4));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = beats[downbeat + 4 * i];
  return out;
}
