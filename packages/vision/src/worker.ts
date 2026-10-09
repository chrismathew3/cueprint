/// <reference lib="webworker" />
// Hand + pose tracking off the main thread. Frames come straight from WebCodecs into
// MediaPipe's GPU delegate; only small landmark summaries are posted back.
import { FilesetResolver, HandLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";
import { frames } from "@cueprint/media";
import type { HandSample, VisionFrame } from "@cueprint/core";
import { classifyView, mixerActivity, placeHand } from "./booth.ts";

export interface VisionRequest {
  file: Blob;
  fps: number;
  width: number;
  /** Absolute URL base where /mediapipe/*.wasm and /models/*.task are served. */
  assetBase: string;
  duration: number;
}

export type VisionMessage =
  | { type: "frames"; frames: VisionFrame[]; progress: number; fps: number }
  | { type: "done"; delegate: "GPU" | "CPU" }
  | { type: "error"; message: string };

const post = (m: VisionMessage) => (self as DedicatedWorkerGlobalScope).postMessage(m);

async function makeLandmarkers(assetBase: string) {
  const fileset = await FilesetResolver.forVisionTasks(new URL("mediapipe", assetBase).href, true);
  // MediaPipe clears self.ModuleFactory after each task boots, and an ES module import is
  // cached, so the second task would find nothing. Re-arm it from the cached module.
  const loader = (await import(/* @vite-ignore */ fileset.wasmLoaderPath)) as { default: unknown };
  const arm = () => { (self as unknown as { ModuleFactory: unknown }).ModuleFactory = loader.default; };
  for (const delegate of ["GPU", "CPU"] as const) {
    try {
      const canvas = delegate === "GPU" ? new OffscreenCanvas(1, 1) : undefined;
      arm();
      const hands = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: new URL("models/hand_landmarker.task", assetBase).href, delegate },
        runningMode: "IMAGE", numHands: 4, minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, canvas,
      });
      arm();
      const pose = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: new URL("models/pose_landmarker_lite.task", assetBase).href, delegate },
        runningMode: "IMAGE", numPoses: 1, minPoseDetectionConfidence: 0.5, canvas,
      });
      return { hands, pose, delegate };
    } catch (err) {
      if (delegate === "CPU") throw err;
    }
  }
  throw new Error("unreachable");
}

self.onmessage = async (e: MessageEvent<VisionRequest>) => {
  const { file, fps, width, assetBase, duration } = e.data;
  try {
    const { hands, pose, delegate } = await makeLandmarkers(assetBase);
    const thumb = new OffscreenCanvas(32, 18);
    const tctx = thumb.getContext("2d", { willReadFrequently: true })!;
    let prevThumb: Uint8ClampedArray | null = null;
    let shot = 0;
    let prevHands: HandSample[] | null = null;
    let prevShot = -1;
    let batch: VisionFrame[] = [];
    const started = performance.now();
    let count = 0;

    for await (const { t, canvas } of frames(file, { fps, width })) {
      // shot cuts: big change in a tiny color thumbnail
      tctx.drawImage(canvas as OffscreenCanvas, 0, 0, 32, 18);
      const px = tctx.getImageData(0, 0, 32, 18).data;
      if (prevThumb) {
        let diff = 0;
        for (let i = 0; i < px.length; i += 4) diff += Math.abs(px[i] - prevThumb[i]) + Math.abs(px[i + 1] - prevThumb[i + 1]) + Math.abs(px[i + 2] - prevThumb[i + 2]);
        if (diff / (32 * 18 * 3) > 28) shot++;
      }
      prevThumb = px;

      const aspect = canvas.height / canvas.width;
      const pr = pose.detect(canvas as OffscreenCanvas);
      const lm = pr.landmarks[0];
      const body = lm ? classifyView({ nose: lm[0], ls: lm[11], rs: lm[12], lh: lm[23], rh: lm[24] }) : null;
      const hr = hands.detect(canvas as OffscreenCanvas);
      const placed = hr.landmarks.map((h) => placeHand({ wrist: h[0], thumbTip: h[4], indexTip: h[8] }, body, aspect));
      const view = body?.view ?? "crowd";
      const activity = view === "front" && shot === prevShot ? mixerActivity(placed, prevHands, body!.sw) : 0;
      batch.push({
        t: Math.round(t * 1000) / 1000, shot, view, activity: Math.round(activity * 1000) / 1000,
        hands: placed.map((h) => ({ x: Math.round(h.x * 1000) / 1000, y: Math.round(h.y * 1000) / 1000, zone: h.zone })),
      });
      prevHands = view === "front" ? placed : null;
      prevShot = shot;
      count++;
      if (batch.length >= 24) {
        post({ type: "frames", frames: batch, progress: Math.min(1, t / duration), fps: count / ((performance.now() - started) / 1000) });
        batch = [];
      }
    }
    if (batch.length) post({ type: "frames", frames: batch, progress: 1, fps: count / ((performance.now() - started) / 1000) });
    hands.close();
    pose.close();
    post({ type: "done", delegate });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
