// Module worker for analyzeParallel: computes STFT feature chunks, or merges chunks and runs
// grid/curves/detectors. Loaded via `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`.

import { BANDS } from "@cueprint/core";
import { finishAnalysisWithContext } from "./analyze.ts";
import { defaultDetectors } from "./detectors/index.ts";
import { chunkTransferables, computeFeatures, mergeFeatures } from "./features.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

interface WorkerScope {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  postMessage(msg: FromWorker, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === "features") {
      const samples = msg.shared
        ? new Float32Array(msg.shared.buffer, msg.shared.byteOffset, msg.shared.length)
        : (msg.slice ?? new Float32Array(0));
      let last = 0;
      const chunk = computeFeatures(
        { sampleRate: msg.sampleRate, samples },
        {
          startFrame: msg.startFrame,
          endFrame: msg.endFrame,
          sampleOffset: msg.sampleOffset,
          totalSamples: msg.totalSamples,
          onProgress: (fraction) => {
            if (fraction - last < 0.05 && fraction < 1) return;
            last = fraction;
            scope.postMessage({ type: "progress", id: msg.id, fraction, stage: "features" });
          },
        },
      );
      scope.postMessage({ type: "chunk", id: msg.id, chunk }, chunkTransferables(chunk));
    } else if (msg.type === "finish") {
      const detectors = msg.detectors ? defaultDetectors.filter((d) => msg.detectors!.includes(d.name)) : defaultDetectors;
      const { analysis, ctx } = finishAnalysisWithContext(mergeFeatures(msg.chunks), {
        detectors,
        onProgress: (fraction, stage) => scope.postMessage({ type: "progress", id: msg.id, fraction, stage }),
      });
      const transfer: Transferable[] = [analysis.spectrogram.data.buffer as ArrayBuffer, analysis.grid.beats.buffer as ArrayBuffer, analysis.grid.localBpm.buffer as ArrayBuffer];
      for (const c of Object.values(analysis.curves)) transfer.push(c.values.buffer as ArrayBuffer);
      if (analysis.keys) transfer.push(analysis.keys.key.buffer as ArrayBuffer, analysis.keys.confidence.buffer as ArrayBuffer);
      if (msg.returnContext) {
        const f = ctx.features;
        for (const b of BANDS) transfer.push(f.bandDb[b].buffer as ArrayBuffer);
        transfer.push(f.rolloffLoHz.buffer as ArrayBuffer, f.rolloffHiHz.buffer as ArrayBuffer, f.onset.buffer as ArrayBuffer, f.chroma.buffer as ArrayBuffer, f.mel.buffer as ArrayBuffer);
      }
      scope.postMessage({ type: "done", id: msg.id, analysis, features: msg.returnContext ? ctx.features : undefined }, dedupe(transfer));
    }
  } catch (err) {
    scope.postMessage({ type: "error", id: msg.id, message: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) });
  }
};

function dedupe(t: Transferable[]): Transferable[] {
  return [...new Set(t)];
}
