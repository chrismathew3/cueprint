import type { VisionFrame, VisionTrack } from "@cueprint/core";
import type { VisionMessage, VisionRequest } from "./worker.ts";
import { finalizeTrack } from "./booth.ts";

export * from "./booth.ts";

export const VISION_FPS = 6;

export interface VisionRun {
  /** Resolves with the finished track. Frames also stream through onFrames as they land. */
  readonly done: Promise<VisionTrack>;
  cancel(): void;
}

/** Track the DJ's hands across the whole video in a GPU worker. */
export function runVision(
  file: Blob,
  opts: {
    duration: number;
    assetBase?: string;
    fps?: number;
    onFrames?: (frames: VisionFrame[], progress: number, fps: number) => void;
  },
): VisionRun {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const fps = opts.fps ?? VISION_FPS;
  const all: VisionFrame[] = [];
  const done = new Promise<VisionTrack>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<VisionMessage>) => {
      const m = e.data;
      if (m.type === "frames") {
        for (const f of m.frames) all.push(f);
        opts.onFrames?.(m.frames, m.progress, m.fps);
      } else if (m.type === "done") {
        worker.terminate();
        resolve(finalizeTrack(all, fps, opts.duration));
      } else {
        worker.terminate();
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
  });
  const req: VisionRequest = {
    file, fps, width: 640, duration: opts.duration,
    assetBase: opts.assetBase ?? new URL(import.meta.env?.BASE_URL ?? "/", location.href).href,
  };
  worker.postMessage(req);
  return { done, cancel: () => worker.terminate() };
}
