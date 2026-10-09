import { describe, expect, test } from "bun:test";
import { RealFFT } from "../src/fft.ts";

describe("RealFFT", () => {
  test("matches a naive DFT", () => {
    for (const n of [8, 64, 2048]) {
      const x = new Float64Array(n);
      for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.37) + 0.5 * Math.cos(i * 1.91) + ((i * 7919) % 13) / 13 - 0.5;
      const fft = new RealFFT(n);
      const re = new Float64Array(n / 2 + 1), im = new Float64Array(n / 2 + 1), pw = new Float64Array(n / 2 + 1);
      fft.complex(x, re, im);
      fft.power(x, pw);
      for (const k of [0, 1, 2, 3, n / 4, n / 2 - 1, n / 2]) {
        let r = 0, m = 0;
        for (let t = 0; t < n; t++) { r += x[t] * Math.cos((2 * Math.PI * k * t) / n); m -= x[t] * Math.sin((2 * Math.PI * k * t) / n); }
        expect(re[k]).toBeCloseTo(r, 6);
        expect(im[k]).toBeCloseTo(m, 6);
        expect(pw[k]).toBeCloseTo(r * r + m * m, 4);
      }
    }
  });
});
