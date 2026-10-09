import { useEffect, useRef, useState } from "react";
import { camelotCompatible, camelotLabel, fmtTime, type Analysis, type Transition } from "@cueprint/core";
import { KEY_SURE, trackKey } from "../mix.ts";
import { clock, useFrame } from "../clock.ts";
import { barTime } from "../lanes.ts";
import { useStudio } from "../store.ts";

/** The transition we're practicing, else the one we're in, else the next one up. */
export function useFocusTransition(transitions: readonly Transition[]): Transition | null {
  const pinned = useStudio((s) => s.practice.transitionId);
  const [auto, setAuto] = useState<string | null>(null);
  useFrame((t) => {
    const tr = transitions.find((x) => t >= x.t0 - 2 && t <= x.t1 + 2) ?? transitions.find((x) => x.t0 > t) ?? transitions[transitions.length - 1];
    const id = tr?.id ?? null;
    if (id !== auto) setAuto(id);
  });
  return transitions.find((x) => x.id === (pinned ?? auto)) ?? null;
}

export function practiceRange(a: Analysis, tr: Transition, leadBars: number): { t0: number; t1: number } {
  const t0 = barTime(a, tr.startBar - leadBars) ?? Math.max(0, tr.t0 - leadBars * 2);
  const t1 = barTime(a, tr.startBar + tr.bars + 2) ?? Math.min(a.duration, tr.t1 + 4);
  return { t0: Math.max(0, t0), t1 };
}

export function Recipe({ analysis, transitions, offset }: { analysis: Analysis; transitions: readonly Transition[]; offset: number }) {
  const tr = useFocusTransition(transitions);
  const practice = useStudio((s) => s.practice);
  const setPractice = useStudio((s) => s.setPractice);
  const list = useRef<HTMLOListElement>(null);
  const now = useRef(-1);

  // keep the clock in sync with practice settings
  useEffect(() => {
    clock.setRate(practice.rate);
    const pinned = transitions.find((x) => x.id === practice.transitionId);
    clock.setLoop(practice.looping && pinned ? practiceRange(analysis, pinned, practice.lead) : null);
  }, [practice, transitions, analysis]);
  useEffect(() => () => { clock.setLoop(null); clock.setRate(1); }, []);

  useFrame((t) => {
    if (!tr || !list.current) return;
    let idx = -1;
    tr.steps.forEach((s, i) => { if (s.t <= t + 0.05) idx = i; });
    if (t > tr.t1 + 1 || t < tr.t0 - 1) idx = -1;
    if (idx === now.current) return;
    list.current.children[now.current]?.classList.remove("now");
    now.current = idx;
    list.current.children[idx]?.classList.add("now");
  });

  if (!transitions.length) {
    return (
      <section className="recipe empty">
        <div className="lbl">Transition</div>
        <p>No transitions found yet. Add a tracklist in Notes (or load a set from YouTube with chapters) and the studio will break down each mix.</p>
      </section>
    );
  }
  if (!tr) return null;
  const i = transitions.indexOf(tr);
  const from = analysis.tracks[tr.from], to = analysis.tracks[tr.to];
  const practicing = practice.transitionId === tr.id;
  const ka = trackKey(analysis, tr.from), kb = trackKey(analysis, tr.to);
  const harmonic = ka && kb ? camelotCompatible(ka.key, kb.key) : null;
  const unsure = !!ka && !!kb && Math.min(ka.confidence, kb.confidence) < KEY_SURE;

  const start = (looping: boolean) => {
    setPractice({ transitionId: tr.id, looping });
    clock.seek(practiceRange(analysis, tr, practice.lead).t0, true);
  };

  return (
    <section className="recipe">
      <header>
        <div className="recipe-n">T{i + 1}<small>/{transitions.length}</small></div>
        <div className="recipe-title">
          <div>{from?.title ?? "Outgoing"}</div>
          <div className="arrow">→ {to?.title ?? "Incoming"}</div>
        </div>
      </header>
      <div className="facts">
        <div><b>{tr.startBar + 1}</b><span className="lbl">start bar</span></div>
        <div><b>{tr.bars}</b><span className="lbl">bars long</span></div>
        <div data-ok={String(tr.onPhrase)}><b>{tr.onPhrase ? "ON" : "OFF"}</b><span className="lbl">phrase</span></div>
        <div data-ok={harmonic == null ? "unknown" : String(harmonic)}>
          <b>{ka && kb ? `${camelotLabel(ka.key)}→${camelotLabel(kb.key)}` : "—"}</b>
          <span className="lbl">{harmonic == null ? "keys" : harmonic ? "keys mix" : "clash"}{unsure ? " ?" : ""}</span>
        </div>
      </div>

      <ol className="steps" ref={list}>
        {tr.steps.map((s) => (
          <li key={s.moveId} onClick={() => clock.seek(s.t - 2, true)}>
            <span className="step-bar">{s.bar >= 0 ? "+" : ""}{s.bar.toFixed(0)}</span>
            <span className="step-text">{s.text}</span>
            <span className="step-t">{fmtTime(s.t + offset)}</span>
          </li>
        ))}
        {!tr.steps.length && <li className="muted"><span className="step-text">No EQ or filter moves detected: likely a straight fader blend.</span></li>}
      </ol>

      <div className="practice">
        <button className={`key ${practicing && practice.looping ? "lit" : ""}`} onClick={() => (practicing && practice.looping ? setPractice({ looping: false, transitionId: null }) : start(true))}>
          {practicing && practice.looping ? "■ STOP LOOP" : "↻ LOOP THIS MIX"}
        </button>
        <button className="key" onClick={() => start(false)}>▶ FROM −{practice.lead} BARS</button>
        <div className="seg" role="group" aria-label="Speed">
          {[1, 0.75, 0.5].map((r) => (
            <button key={r} className={practice.rate === r ? "lit" : ""} onClick={() => setPractice({ rate: r })}>{r === 1 ? "100" : r * 100}%</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Lead-in">
          {[4, 8, 16].map((b) => (
            <button key={b} className={practice.lead === b ? "lit" : ""} onClick={() => setPractice({ lead: b })}>{b}</button>
          ))}
        </div>
      </div>
    </section>
  );
}
