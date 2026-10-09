import { useEffect, useRef } from "react";
import type { Move, VisionFrame } from "@cueprint/core";
import { isMixer } from "@cueprint/vision";
import { clock, useFrame } from "../clock.ts";
import { theme } from "../theme.ts";

function frameAt(frames: readonly VisionFrame[], t: number): VisionFrame | null {
  let lo = 0, hi = frames.length - 1;
  if (hi < 0) return null;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (frames[m].t <= t) lo = m; else hi = m - 1; }
  const f = frames[lo];
  return Math.abs(f.t - t) < 0.35 ? f : null;
}

export function activeMove(moves: readonly Move[], t: number): Move | null {
  let best: Move | null = null;
  for (const m of moves) {
    if (m.kind === "section") continue;
    if (t >= m.t0 - 0.25 && t <= Math.max(m.t1, m.t0 + 3)) {
      if (!best || (best.kind === "loop" && m.kind !== "loop") || (m.kind === best.kind && m.t0 > best.t0)) best = m;
    }
  }
  return best;
}

export function VideoStage({ url, frames, hideAnswers = false, children }: {
  url: string; frames: readonly VisionFrame[]; hideAnswers?: boolean; children?: React.ReactNode;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cam = useRef<HTMLSpanElement>(null);

  useEffect(() => { clock.attach(video.current); return () => clock.attach(null); }, [url]);

  useFrame((t) => {
    const v = video.current, c = canvas.current;
    if (!v || !c) return;
    const dpr = devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = W * dpr; c.height = H * dpr; }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    const s = Math.max(W / vw, H / vh); // cover: the screen is a window into the booth
    const R = { x: (W - vw * s) / 2, y: (H - vh * s) / 2, w: vw * s, h: vh * s };

    const f = frameAt(frames, t);
    if (cam.current) {
      const label = !frames.length ? "CAM · TRACKING…" : f ? `CAM · ${f.view.toUpperCase()}` : "CAM · —";
      if (cam.current.textContent !== label) cam.current.textContent = label;
    }
    if (!f || hideAnswers) return;
    for (const h of f.hands) {
      const px = R.x + h.x * R.w, py = R.y + h.y * R.h;
      const onMixer = isMixer(h.zone);
      if (!onMixer && f.view !== "front") continue;
      const moving = onMixer && f.activity > 0.06;
      g.lineWidth = moving ? 2.5 : 1.5;
      g.strokeStyle = onMixer ? theme.hot : "rgba(239,237,231,.6)";
      g.beginPath(); g.arc(px, py, onMixer ? 16 : 9, 0, Math.PI * 2); g.stroke();
      if (onMixer && h.zone) {
        g.font = `600 10px ${theme.mono}`; g.textBaseline = "middle";
        const tw = g.measureText(h.zone).width;
        g.fillStyle = moving ? theme.hot : "rgba(20,20,20,.75)";
        g.fillRect(px + 20, py - 9, tw + 12, 18);
        g.fillStyle = theme.plate2;
        g.fillText(h.zone, px + 26, py);
      }
    }
  });

  return (
    <div className="screen" data-hide={hideAnswers}>
      <video ref={video} src={url} playsInline preload="auto" onClick={() => clock.toggle()} />
      <canvas ref={canvas} />
      <span className="screen-tag">● REPLAY</span>
      <span className="screen-cam" ref={cam}>CAM</span>
      {children}
    </div>
  );
}
