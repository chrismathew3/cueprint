// Radix-2 real FFT via the half-size complex trick.
// A real signal of length n is packed as n/2 complex samples (even -> re, odd -> im),
// transformed with an iterative complex FFT, then split into the n/2 + 1 real-spectrum bins.
// All tables and scratch buffers are allocated once per instance; hot path allocates nothing.

export class RealFFT {
  readonly size: number;
  readonly bins: number;
  private readonly half: number;
  private readonly rev: Uint32Array;
  // twiddles for the half-size complex FFT: exp(-2*pi*i*k/half), k < half/2
  private readonly cosT: Float64Array;
  private readonly sinT: Float64Array;
  // twiddles for the real split: exp(-2*pi*i*k/size), k <= half
  private readonly cosS: Float64Array;
  private readonly sinS: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(size: number) {
    if (size < 4 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two >= 4, got ${size}`);
    this.size = size;
    this.bins = size / 2 + 1;
    const half = size / 2;
    this.half = half;
    let bits = 0;
    while ((1 << bits) < half) bits++;
    this.rev = new Uint32Array(half);
    for (let i = 0; i < half; i++) {
      let r = 0;
      for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1);
      this.rev[i] = r;
    }
    this.cosT = new Float64Array(half / 2);
    this.sinT = new Float64Array(half / 2);
    for (let k = 0; k < half / 2; k++) {
      this.cosT[k] = Math.cos((2 * Math.PI * k) / half);
      this.sinT[k] = -Math.sin((2 * Math.PI * k) / half);
    }
    this.cosS = new Float64Array(half + 1);
    this.sinS = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      this.cosS[k] = Math.cos((2 * Math.PI * k) / size);
      this.sinS[k] = -Math.sin((2 * Math.PI * k) / size);
    }
    this.re = new Float64Array(half);
    this.im = new Float64Array(half);
  }

  /**
   * Power spectrum |X[k]|^2 for k = 0..size/2 of `input` (length `size`, already windowed).
   * `outPower` must have length >= bins.
   */
  power(input: Float64Array | Float32Array, outPower: Float64Array | Float32Array): void {
    this.transform(input);
    const half = this.half, re = this.re, im = this.im, cs = this.cosS, sn = this.sinS;
    // DC and Nyquist
    const r0 = re[0], i0 = im[0];
    outPower[0] = (r0 + i0) * (r0 + i0);
    outPower[half] = (r0 - i0) * (r0 - i0);
    for (let k = 1; k < half; k++) {
      const ar = re[k], ai = im[k], br = re[half - k], bi = -im[half - k]; // b = conj(Z[N-k])
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi); // even part
      // odd part: (a - b) / (2i) = ( (ai - bi)/2 , -(ar - br)/2 )
      const or = 0.5 * (ai - bi), oi = -0.5 * (ar - br);
      const wr = cs[k], wi = sn[k];
      const xr = er + (wr * or - wi * oi);
      const xi = ei + (wr * oi + wi * or);
      outPower[k] = xr * xr + xi * xi;
    }
  }

  /** Complex spectrum for k = 0..size/2 (used by tests). */
  complex(input: Float64Array | Float32Array, outRe: Float64Array, outIm: Float64Array): void {
    this.transform(input);
    const half = this.half, re = this.re, im = this.im, cs = this.cosS, sn = this.sinS;
    outRe[0] = re[0] + im[0]; outIm[0] = 0;
    outRe[half] = re[0] - im[0]; outIm[half] = 0;
    for (let k = 1; k < half; k++) {
      const ar = re[k], ai = im[k], br = re[half - k], bi = -im[half - k];
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
      const or = 0.5 * (ai - bi), oi = -0.5 * (ar - br);
      const wr = cs[k], wi = sn[k];
      outRe[k] = er + (wr * or - wi * oi);
      outIm[k] = ei + (wr * oi + wi * or);
    }
  }

  private transform(input: Float64Array | Float32Array): void {
    const half = this.half, re = this.re, im = this.im, rev = this.rev;
    for (let i = 0; i < half; i++) {
      const j = rev[i];
      re[j] = input[2 * i];
      im[j] = input[2 * i + 1];
    }
    const cosT = this.cosT, sinT = this.sinT;
    // stages 1+2 fused (len 4): twiddles are 1 and -i, so no multiplies
    for (let i = 0; i < half; i += 4) {
      const r0 = re[i], i0 = im[i], r1 = re[i + 1], i1 = im[i + 1];
      const r2 = re[i + 2], i2 = im[i + 2], r3 = re[i + 3], i3 = im[i + 3];
      const ar = r0 + r1, ai = i0 + i1, br = r0 - r1, bi = i0 - i1;
      const cr = r2 + r3, ci = i2 + i3, dr = r2 - r3, di = i2 - i3;
      re[i] = ar + cr; im[i] = ai + ci;
      re[i + 2] = ar - cr; im[i + 2] = ai - ci;
      // (dr + i di) * (-i) = di - i dr
      re[i + 1] = br + di; im[i + 1] = bi - dr;
      re[i + 3] = br - di; im[i + 3] = bi + dr;
    }
    for (let len = 8; len <= half; len <<= 1) {
      const h = len >> 1;
      const step = half / len;
      // twiddle-outer: one table load per twiddle, contiguous butterflies (16 KB working set fits L1)
      for (let j = 0; j < h; j++) {
        const wr = cosT[j * step], wi = sinT[j * step];
        for (let p = j; p < half; p += len) {
          const q = p + h;
          const qr = re[q], qi = im[q];
          const tr = wr * qr - wi * qi;
          const ti = wr * qi + wi * qr;
          const pr = re[p], pi = im[p];
          re[q] = pr - tr; im[q] = pi - ti;
          re[p] = pr + tr; im[p] = pi + ti;
        }
      }
    }
  }
}

/** Periodic Hann window (scipy `get_window("hann", n, fftbins=True)`, librosa's default). */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
