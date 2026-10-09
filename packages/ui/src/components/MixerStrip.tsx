import { useRef } from "react";
import { moveArrow, moveDetail, moveLabel, type Analysis, type Band, type Move, type Transition, type VisionFrame } from "@cueprint/core";
import { isMixer } from "@cueprint/vision";
import { useFrame } from "../clock.ts";
import { activeMove } from "./VideoStage.tsx";

const valueAt = (c: { rate: number; values: Float32Array }, t: number) =>
  c.values[Math.min(c.values.length - 1, Math.max(0, Math.floor(t * c.rate)))] ?? 0;

/** EQ knob angle: 12 o'clock = flat, full left = kill. */
function eqAngle(db: number) {
  return db >= 0 ? Math.min(60, (db / 6) * 60) : Math.max(-135, (db / 30) * 135);
}

/** Filter knob only turns inside a detected sweep, interpolated from its start to end frequency. */
function filterAngle(moves: readonly Move[], t: number): number {
  for (const m of moves) {
    if (m.kind !== "filter" || t < m.t0 - 0.2 || t > m.t1 + 1.5) continue;
    const p = Math.max(0, Math.min(1, (t - m.t0) / Math.max(0.5, m.t1 - m.t0)));
    const closed = m.dir === "close" ? p : 1 - p;
    // HPF turns right, LPF turns left, the way a single-knob DJ filter works
    return (m.filter === "HPF" ? 1 : -1) * closed * 120;
  }
  return 0;
}

function frameAt(frames: readonly VisionFrame[], t: number) {
  let lo = 0, hi = frames.length - 1;
  if (hi < 0) return null;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (frames[m].t <= t) lo = m; else hi = m - 1; }
  return Math.abs(frames[lo].t - t) < 0.4 ? frames[lo] : null;
}

const KNOBS: [Band | "filter", string][] = [["hi", "HI"], ["himid", "MID"], ["low", "LOW"], ["filter", "FILTER"]];
const HOT: Record<string, (m: Move) => boolean> = {
  hi: (m) => m.kind === "eq" && (m.band === "hi" || m.band === "himid"),
  himid: (m) => m.kind === "eq" && m.band === "lowmid",
  low: (m) => m.kind === "eq" && m.band === "low",
  filter: (m) => m.kind === "filter",
};

export function MixerStrip({ analysis, frames, transitions, hide }: {
  analysis: Analysis; frames: readonly VisionFrame[]; transitions: readonly Transition[]; hide?: boolean;
}) {
  const knobs = useRef<Record<string, HTMLDivElement | null>>({});
  const dbs = useRef<Record<string, HTMLSpanElement | null>>({});
  const zones = useRef<Record<string, HTMLElement | null>>({});
  const nowBig = useRef<HTMLDivElement>(null);
  const nowText = useRef<HTMLParagraphElement>(null);
  const nowLbl = useRef<HTMLSpanElement>(null);
  const nowCam = useRef<HTMLDivElement>(null);
  const last = useRef("");

  useFrame((t) => {
    const mv = hide ? null : activeMove(analysis.moves, t);
    for (const [k] of KNOBS) {
      const el = knobs.current[k];
      if (!el) continue;
      const angle = hide ? 0 : k === "filter" ? filterAngle(analysis.moves, t) : eqAngle(valueAt(analysis.curves[k], t));
      el.style.setProperty("--a", `${angle.toFixed(1)}deg`);
      const hot = !!mv && HOT[k](mv);
      if (el.dataset.hot !== String(hot)) el.dataset.hot = String(hot);
      const d = dbs.current[k];
      if (d) {
        const txt = hide ? "··" : k === "filter" ? (angle > 3 ? "HPF" : angle < -3 ? "LPF" : "OFF") : `${valueAt(analysis.curves[k as Band], t) > 0 ? "+" : ""}${valueAt(analysis.curves[k as Band], t).toFixed(0)}`;
        if (d.textContent !== txt) d.textContent = txt;
      }
    }

    const f = frameAt(frames, t);
    for (const z of ["MIXER L", "MIXER CENTER", "MIXER R"]) {
      const el = zones.current[z];
      if (!el) continue;
      const on = !!f && f.view === "front" && f.hands.some((h) => h.zone === z);
      const moving = on && f!.activity > 0.06;
      el.dataset.state = moving ? "moving" : on ? "on" : f?.view === "front" ? "off" : "nocam";
    }

    // NOW panel: the step we're on inside a transition, else the live move, else what's next
    const tr = transitions.find((x) => t >= x.t0 - 1 && t <= x.t1 + 1);
    let key: string, big: string, text: string, lbl: string, cam = "";
    if (hide) { key = "hide"; big = "?"; text = "Listen. What's the DJ doing?"; lbl = "Drill"; }
    else if (mv) {
      const step = tr?.steps.find((s) => s.moveId === mv.id);
      key = mv.id + mv.verdict;
      big = `${moveLabel(mv)} ${moveArrow(mv)}`;
      text = step?.text ?? moveDetail(mv);
      lbl = tr ? `Now · bar ${step ? step.bar.toFixed(0) : "?"} of ${tr.bars}` : "Now";
      cam = mv.verdict === "hand moving" ? `On camera · ${mv.zone ?? "mixer"}` : mv.verdict === "hands still" ? "Hands still · may be the track" : mv.verdict === "no camera" ? "Camera cut away" : mv.verdict === "not proven" ? "Repeat heard · not proven" : "";
    } else {
      const next = analysis.moves.find((m) => m.t0 > t && m.kind !== "section" && m.kind !== "loop");
      key = `next-${next?.id ?? "none"}-${tr?.id ?? ""}`;
      big = tr ? "BLEND" : "—";
      text = next ? `Next: ${moveLabel(next).toLowerCase()} in ${Math.max(0, next.t0 - t).toFixed(0)}s` : "No more moves";
      lbl = tr ? `In transition · ${tr.bars} bars` : "Listening";
    }
    if (key !== last.current || !mv) {
      last.current = key;
      if (nowBig.current && nowBig.current.textContent !== big) nowBig.current.textContent = big;
      if (nowText.current && nowText.current.textContent !== text) nowText.current.textContent = text;
      if (nowLbl.current && nowLbl.current.textContent !== lbl) nowLbl.current.textContent = lbl;
      if (nowCam.current) { nowCam.current.textContent = cam; nowCam.current.dataset.on = String(cam.startsWith("On camera")); }
    }
  });

  return (
    <section className="mixer">
      <div className="mixer-eq">
        <div className="lbl mixer-cap">EQ · read from the audio</div>
        <div className="knob-row">
          {KNOBS.map(([k, name]) => (
            <div className="knob-cell" key={k}>
              <div className={`knob ${k === "filter" ? "knob-filter" : ""}`} ref={(el) => { knobs.current[k] = el; }} />
              <span className="lbl">{name}</span>
              <span className="knob-db" ref={(el) => { dbs.current[k] = el; }} />
            </div>
          ))}
        </div>
      </div>
      <div className="mixer-hands">
        <div className="lbl mixer-cap">Hands · camera</div>
        <div className="zones">
          {["MIXER L", "MIXER CENTER", "MIXER R"].map((z) => (
            <span key={z} className="zone" ref={(el) => { zones.current[z] = el; }}><i />{z.replace("MIXER ", "").replace("CENTER", "C")}</span>
          ))}
        </div>
        <div className="lbl zones-note">lights when a hand is on that side of the mixer; orange = moving</div>
      </div>
      <div className="now">
        <span className="lbl" ref={nowLbl}>Now</span>
        <div className="now-big" ref={nowBig}>—</div>
        <p ref={nowText} />
        <div className="now-cam" ref={nowCam} />
      </div>
    </section>
  );
}
