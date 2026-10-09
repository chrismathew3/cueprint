// Spectrogram renderer. WebGPU path: the whole set lives in one r8 texture
// (columns wrapped into row blocks to dodge the max texture width) and each
// frame is one full-screen triangle sampling [t0, t1]. Canvas2D fallback otherwise.
import type { Spectrogram } from "@cueprint/core";

const BLOCK = 4096; // columns per row block

// Polynomial fit of matplotlib's magma (Matt Zucker), shared by both paths.
const MAGMA = [
  [-0.002136485053939582, -0.000749655052795221, -0.005386127855323933],
  [0.2516605407371642, 0.6775232436837668, 2.494026599312351],
  [8.353717279216625, -3.577719514958484, 0.3144679030132573],
  [-27.66873308576866, 14.26473078096533, -13.64921318813922],
  [52.17613981234068, -27.94360607168351, 12.94416944238394],
  [-50.76852536473588, 29.04658282127291, 4.23415299384598],
  [18.65570506591883, -11.48977351997711, -5.601961508734096],
];

export function magma(t: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let v = 0;
    for (let k = 6; k >= 0; k--) v = v * t + MAGMA[k][c];
    out[c] = Math.max(0, Math.min(1, v));
  }
  return out;
}

const WGSL = /* wgsl */ `
struct U { t0: f32, t1: f32, rate: f32, frames: f32, bins: f32, block: f32, gain: f32, ink: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
  return o;
}

fn magma(t: f32) -> vec3f {
  let c0 = vec3f(-0.002136485053939582, -0.000749655052795221, -0.005386127855323933);
  let c1 = vec3f(0.2516605407371642, 0.6775232436837668, 2.494026599312351);
  let c2 = vec3f(8.353717279216625, -3.577719514958484, 0.3144679030132573);
  let c3 = vec3f(-27.66873308576866, 14.26473078096533, -13.64921318813922);
  let c4 = vec3f(52.17613981234068, -27.94360607168351, 12.94416944238394);
  let c5 = vec3f(-50.76852536473588, 29.04658282127291, 4.23415299384598);
  let c6 = vec3f(18.65570506591883, -11.48977351997711, -5.601961508734096);
  return clamp(c0 + t*(c1 + t*(c2 + t*(c3 + t*(c4 + t*(c5 + t*c6))))), vec3f(0.0), vec3f(1.0));
}

fn sampleCol(col: i32, bin: i32) -> f32 {
  if (col < 0 || f32(col) >= u.frames) { return 0.0; }
  let blk = col / i32(u.block);
  let x = col - blk * i32(u.block);
  let y = blk * i32(u.bins) + bin;
  return textureLoad(tex, vec2i(x, y), 0).r;
}

@fragment fn fs(in: VO) -> @location(0) vec4f {
  let t = mix(u.t0, u.t1, in.uv.x);
  let colF = t * u.rate;
  // low frequencies at the bottom
  let binF = (1.0 - in.uv.y) * (u.bins - 1.0);
  let c0 = i32(floor(colF));
  let b0 = i32(floor(binF));
  let fx = fract(colF);
  let fy = fract(binF);
  let b1 = min(b0 + 1, i32(u.bins) - 1);
  let v = mix(mix(sampleCol(c0, b0), sampleCol(c0 + 1, b0), fx), mix(sampleCol(c0, b1), sampleCol(c0 + 1, b1), fx), fy);
  let x = clamp(v * u.gain, 0.0, 1.0);
  let paper = vec3f(0.937, 0.929, 0.906);
  let inkc = mix(paper, vec3f(0.078, 0.078, 0.078), pow(smoothstep(0.18, 1.0, x), 1.25));
  let c = select(magma(x), inkc, u.ink > 0.5);
  let inRange = t >= 0.0 && colF < u.frames;
  return vec4f(select(select(vec3f(0.0), paper, u.ink > 0.5), c, inRange), 1.0);
}
`;

export interface SpecRenderer {
  readonly kind: "webgpu" | "canvas2d";
  draw(t0: number, t1: number): void;
  resize(width: number, height: number): void;
  destroy(): void;
}

export type Palette = "ink" | "magma";

export async function createSpecRenderer(canvas: HTMLCanvasElement, spec: Spectrogram, palette: Palette = "ink"): Promise<SpecRenderer> {
  try {
    const gpu = await createWebGpu(canvas, spec, palette);
    if (gpu) return gpu;
  } catch (err) {
    console.warn("WebGPU spectrogram unavailable, falling back", err);
  }
  return createCanvas2d(canvas, spec, palette);
}

async function createWebGpu(canvas: HTMLCanvasElement, spec: Spectrogram, palette: Palette): Promise<SpecRenderer | null> {
  if (!("gpu" in navigator)) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext("webgpu");
  if (!ctx) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });

  const blocks = Math.max(1, Math.ceil(spec.frames / BLOCK));
  const texW = Math.min(BLOCK, Math.max(1, spec.frames));
  const texH = blocks * spec.bins;
  if (texH > device.limits.maxTextureDimension2D) return null;
  const texture = device.createTexture({ size: [texW, texH], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  // re-layout column-major [frame*bins + bin] into row blocks of [bin row][column]
  const bytesPerRow = Math.ceil(texW / 256) * 256;
  const staging = new Uint8Array(bytesPerRow * texH);
  for (let f = 0; f < spec.frames; f++) {
    const blk = (f / BLOCK) | 0, x = f - blk * BLOCK, src = f * spec.bins, rowBase = blk * spec.bins;
    for (let b = 0; b < spec.bins; b++) staging[(rowBase + b) * bytesPerRow + x] = spec.data[src + b];
  }
  device.queue.writeTexture({ texture }, staging, { bytesPerRow }, [texW, texH]);

  const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const module = device.createShaderModule({ code: WGSL });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: texture.createView() }],
  });
  const u = new Float32Array(8);

  return {
    kind: "webgpu",
    draw(t0, t1) {
      if (!canvas.width || !canvas.height) return;
      u.set([t0, t1, spec.rate, spec.frames, spec.bins, BLOCK, 1.08, palette === "ink" ? 1 : 0]);
      device.queue.writeBuffer(uniform, 0, u);
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: palette === "ink" ? { r: 0.937, g: 0.929, b: 0.906, a: 1 } : { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
      device.queue.submit([enc.finish()]);
    },
    resize(w, h) { canvas.width = w; canvas.height = h; },
    destroy() { texture.destroy(); uniform.destroy(); device.destroy(); },
  };
}

function inkColor(x: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (x - 0.18) / 0.82));
  const k = Math.pow(t * t * (3 - 2 * t), 1.25);
  return [0.937 + (0.078 - 0.937) * k, 0.929 + (0.078 - 0.929) * k, 0.906 + (0.078 - 0.906) * k];
}

function createCanvas2d(canvas: HTMLCanvasElement, spec: Spectrogram, palette: Palette): SpecRenderer {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) { const [r, g, b] = palette === "ink" ? inkColor(i / 255) : magma(i / 255); lut[i * 3] = r * 255; lut[i * 3 + 1] = g * 255; lut[i * 3 + 2] = b * 255; }
  const tiles: HTMLCanvasElement[] = [];
  for (let start = 0; start < spec.frames; start += BLOCK) {
    const w = Math.min(BLOCK, spec.frames - start);
    const tile = document.createElement("canvas");
    tile.width = w; tile.height = spec.bins;
    const img = new ImageData(w, spec.bins);
    for (let x = 0; x < w; x++) {
      const src = (start + x) * spec.bins;
      for (let b = 0; b < spec.bins; b++) {
        const v = spec.data[src + b], o = ((spec.bins - 1 - b) * w + x) * 4;
        img.data[o] = lut[v * 3]; img.data[o + 1] = lut[v * 3 + 1]; img.data[o + 2] = lut[v * 3 + 2]; img.data[o + 3] = 255;
      }
    }
    tile.getContext("2d")!.putImageData(img, 0, 0);
    tiles.push(tile);
  }
  const g = canvas.getContext("2d")!;
  return {
    kind: "canvas2d",
    draw(t0, t1) {
      const W = canvas.width, H = canvas.height;
      g.fillStyle = palette === "ink" ? "#efede7" : "#000"; g.fillRect(0, 0, W, H);
      g.imageSmoothingEnabled = true;
      const pxPerCol = W / ((t1 - t0) * spec.rate);
      tiles.forEach((tile, i) => {
        const c0 = i * BLOCK, c1 = c0 + tile.width;
        const x0 = (c0 / spec.rate - t0) / (t1 - t0) * W, x1 = (c1 / spec.rate - t0) / (t1 - t0) * W;
        if (x1 < 0 || x0 > W) return;
        g.drawImage(tile, x0, 0, tile.width * pxPerCol, H);
      });
    },
    resize(w, h) { canvas.width = w; canvas.height = h; },
    destroy() { tiles.length = 0; },
  };
}
