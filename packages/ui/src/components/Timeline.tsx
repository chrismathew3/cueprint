import { useEffect, useRef } from "react";
import type { Analysis, Move, Transition, VisionFrame } from "@cueprint/core";
import { clock, useFrame } from "../clock.ts";
import { defaultLanes, type Lane } from "../lanes.ts";
import { createSpecRenderer, type SpecRenderer } from "../spectrogram.ts";
import { useStudio } from "../store.ts";
import { theme } from "../theme.ts";

const GUTTER = 70;
const PLAYHEAD = 0.3;

export function Timeline({ analysis, frames, transitions, lanes = defaultLanes, hideMoves = false }: {
  analysis: Analysis; frames: readonly VisionFrame[]; transitions: readonly Transition[]; lanes?: readonly Lane[]; hideMoves?: boolean;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const gpuCanvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const mini = useRef<HTMLCanvasElement>(null);
  const spec = useRef<SpecRenderer | null>(null);
  const hover = useRef<Move | null>(null);
  const size = useRef({ w: 0, dpr: 1 });
  const zoom = useStudio((s) => s.zoom);
  const setZoom = useStudio((s) => s.setZoom);
  const active = useStudio((s) => s.practice.transitionId);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const total = lanes.reduce((a, l) => a + l.height, 0);
  const specIdx = lanes.findIndex((l) => l.spectrum);
  const specTop = lanes.slice(0, Math.max(0, specIdx)).reduce((a, l) => a + l.height, 0);
  const specLane = lanes[specIdx];

  useEffect(() => {
    let alive = true;
    void createSpecRenderer(gpuCanvas.current!, analysis.spectrogram, "ink").then((r) => {
      if (!alive) return r.destroy();
      spec.current = r;
      resize();
    });
    return () => { alive = false; spec.current?.destroy(); spec.current = null; };
  }, [analysis.spectrogram]);

  function resize() {
    const el = wrap.current;
    if (!el) return;
    const dpr = devicePixelRatio || 1;
    const w = el.clientWidth;
    size.current = { w, dpr };
    const o = overlay.current!;
    o.width = w * dpr; o.height = total * dpr;
    const m = mini.current!;
    m.width = w * dpr; m.height = m.clientHeight * dpr;
    spec.current?.resize(Math.max(1, (w - GUTTER) * dpr), (specLane?.height ?? 0) * dpr);
  }

  useEffect(() => {
    const ro = new ResizeObserver(resize);
    ro.observe(wrap.current!);
    resize();
    return () => ro.disconnect();
  }, [total]);

  const range = (t: number) => {
    const z = Math.min(zoomRef.current, analysis.duration + 8);
    const t0 = t - z * PLAYHEAD;
    return [t0, t0 + z] as const;
  };

  useFrame((t) => {
    const { w, dpr } = size.current;
    if (!w) return;
    const [t0, t1] = range(t);
    spec.current?.draw(t0, t1);
    const g = overlay.current!.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, total);
    const X = (s: number) => GUTTER + ((s - t0) / (t1 - t0)) * (w - GUTTER);
    const shown = hideMoves ? { ...analysis, moves: [] } : analysis;

    let y = 0;
    for (const lane of lanes) {
      if (!lane.spectrum) { g.fillStyle = theme.plate2; g.fillRect(GUTTER, y, w - GUTTER, lane.height); }
      g.fillStyle = theme.plate; g.fillRect(0, y, GUTTER, lane.height);
      g.fillStyle = theme.soft;
      g.font = `600 9px ${theme.mono}`;
      g.textBaseline = "middle";
      if (lane.label) g.fillText(lane.label, 12, y + lane.height / 2);
      g.save();
      g.beginPath(); g.rect(GUTTER, y, w - GUTTER, lane.height); g.clip();
      lane.draw({
        g, t0, t1, t, x: GUTTER, y, w: w - GUTTER, h: lane.height, X, analysis: shown,
        transitions: hideMoves ? [] : transitions, activeTransition: active, frames, hover: hover.current,
      });
      g.restore();
      g.fillStyle = theme.line;
      g.fillRect(0, y + lane.height - 1, w, 1);
      y += lane.height;
    }
    // practice loop shading
    const loop = clock.loop;
    if (loop) {
      g.fillStyle = theme.hotWash;
      g.fillRect(Math.max(GUTTER, X(loop.t0)), 0, X(loop.t1) - Math.max(GUTTER, X(loop.t0)), total);
    }
    const px = X(t);
    g.fillStyle = theme.hot;
    g.fillRect(px - 1, 0, 2, total);
    g.beginPath(); g.moveTo(px - 6, 0); g.lineTo(px + 6, 0); g.lineTo(px, 8); g.fill();
    g.fillStyle = theme.ink;
    g.fillRect(GUTTER - 1.5, 0, 1.5, total);

    drawMini(t, t0, t1);
  });

  function drawMini(t: number, t0: number, t1: number) {
    const m = mini.current!, g = m.getContext("2d")!;
    const { dpr } = size.current;
    const W = m.width / dpr, H = m.height / dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = theme.plate; g.fillRect(0, 0, W, H);
    const X = (s: number) => GUTTER + (s / analysis.duration) * (W - GUTTER);
    g.fillStyle = theme.soft; g.font = `600 9px ${theme.mono}`; g.textBaseline = "middle";
    g.fillText("SET", 12, H / 2);
    // energy outline from the low band
    const c = analysis.curves.low;
    g.fillStyle = theme.line;
    const step = Math.max(1, Math.floor(c.values.length / (W - GUTTER)));
    for (let i = 0; i < c.values.length; i += step) {
      const v = Math.max(0, (c.values[i] + 30) / 36);
      g.fillRect(X(i / c.rate), H - 4 - v * (H - 10), 1, v * (H - 10));
    }
    if (!hideMoves) for (const tr of transitions) {
      g.fillStyle = tr.id === active ? theme.hot : theme.ink;
      g.fillRect(X(tr.t0), 3, Math.max(2, X(tr.t1) - X(tr.t0)), 4);
    }
    g.strokeStyle = theme.ink;
    g.strokeRect(X(Math.max(0, t0)) + 0.5, 1.5, Math.max(4, X(t1) - X(Math.max(0, t0))), H - 3);
    g.fillStyle = theme.hot; g.fillRect(X(t), 0, 2, H);
  }

  function timeAt(clientX: number) {
    const r = overlay.current!.getBoundingClientRect();
    const [t0, t1] = range(clock.time);
    return t0 + ((clientX - r.left - GUTTER) / (r.width - GUTTER)) * (t1 - t0);
  }

  function moveAt(clientX: number, clientY: number): Move | null {
    if (hideMoves) return null;
    const r = overlay.current!.getBoundingClientRect();
    if (clientY - r.top < specTop || clientX - r.left < GUTTER) return null;
    const t = timeAt(clientX);
    const [t0, t1] = range(clock.time);
    const slop = ((t1 - t0) / (r.width - GUTTER)) * 4;
    return analysis.moves.find((m) => m.kind !== "section" && t >= m.t0 - slop && t <= Math.max(m.t1, m.t0 + slop)) ?? null;
  }

  useEffect(() => {
    const el = overlay.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) setZoom(zoomRef.current * Math.exp(e.deltaY * 0.0025));
      else clock.seek(clock.time + (e.deltaX / el.clientWidth) * zoomRef.current);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setZoom]);

  return (
    <div className="timeline" ref={wrap}>
      <div className="timeline-stack" style={{ height: total }}>
        <canvas ref={gpuCanvas} className="timeline-gpu" style={{ left: GUTTER, top: specTop, height: specLane?.height ?? 0, width: `calc(100% - ${GUTTER}px)` }} />
        <canvas
          ref={overlay}
          className="timeline-overlay"
          style={{ height: total }}
          onPointerDown={(e) => {
            if (e.clientX - e.currentTarget.getBoundingClientRect().left < GUTTER) return;
            const m = moveAt(e.clientX, e.clientY);
            clock.seek(m ? m.t0 - 1.5 : timeAt(e.clientX));
          }}
          onPointerMove={(e) => {
            const m = moveAt(e.clientX, e.clientY);
            hover.current = m;
            e.currentTarget.style.cursor = m ? "pointer" : "crosshair";
          }}
          onPointerLeave={() => { hover.current = null; }}
        />
      </div>
      <canvas
        ref={mini}
        className="timeline-mini"
        onPointerDown={(e) => {
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          const seekTo = (cx: number) => {
            const r = el.getBoundingClientRect();
            clock.seek(Math.max(0, ((cx - r.left - GUTTER) / (r.width - GUTTER))) * analysis.duration);
          };
          seekTo(e.clientX);
          el.onpointermove = (ev) => seekTo(ev.clientX);
          el.onpointerup = () => { el.onpointermove = null; };
        }}
      />
    </div>
  );
}
