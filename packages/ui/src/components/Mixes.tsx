import { useState } from "react";
import { camelotCompatible, camelotLabel, fmtTime, type Analysis, type Transition } from "@cueprint/core";
import { clock } from "../clock.ts";
import { useStudio } from "../store.ts";
import { trackKey } from "../mix.ts";
import { practiceRange, useFocusTransition } from "./Recipe.tsx";
import { MoveLog } from "./SidePanel.tsx";

export function Mixes({ analysis, transitions, offset }: { analysis: Analysis; transitions: readonly Transition[]; offset: number }) {
  const [tab, setTab] = useState<"mixes" | "moves">("mixes");
  const focus = useFocusTransition(transitions);
  const practice = useStudio((s) => s.practice);
  const setPractice = useStudio((s) => s.setPractice);
  const onPhrase = transitions.filter((t) => t.onPhrase).length;
  const keyPair = (tr: Transition) => { const a = trackKey(analysis, tr.from), b = trackKey(analysis, tr.to); return a && b ? { a: a.key, b: b.key, ok: camelotCompatible(a.key, b.key) } : null; };
  const pairs = transitions.map(keyPair);
  const harmonic = pairs.filter((p) => p?.ok).length;
  const keyed = pairs.filter(Boolean).length;

  return (
    <section className="mixes">
      <div className="tabs">
        <button className={tab === "mixes" ? "lit" : ""} onClick={() => setTab("mixes")}>MIXES {transitions.length}</button>
        <button className={tab === "moves" ? "lit" : ""} onClick={() => setTab("moves")}>ALL MOVES {analysis.moves.filter((m) => m.kind !== "section").length}</button>
      </div>
      {tab === "mixes" ? (
        <>
          <div className="mix-summary">
            <div><b>{onPhrase}/{transitions.length}</b><span className="lbl">on phrase</span></div>
            <div><b>{keyed ? `${harmonic}/${keyed}` : "—"}</b><span className="lbl">in key</span></div>
            <div><b>{transitions.length ? Math.round(transitions.reduce((a, t) => a + t.bars, 0) / transitions.length) : "—"}</b><span className="lbl">avg bars</span></div>
          </div>
          <ol className="mix-list">
            {transitions.map((tr, i) => {
              const from = analysis.tracks[tr.from], to = analysis.tracks[tr.to];
              return (
                <li key={tr.id} className={tr.id === focus?.id ? "on" : ""}>
                  <button onClick={() => {
                    setPractice({ transitionId: tr.id, looping: practice.looping });
                    clock.seek(practiceRange(analysis, tr, practice.lead).t0, true);
                  }}>
                    <span className="mix-n">T{i + 1}</span>
                    <span className="mix-body">
                      <span className="mix-title">{from?.title ?? "—"} <i>→</i> {to?.title ?? "—"}</span>
                      <span className="mix-meta">
                        {fmtTime(tr.t0 + offset)} · {tr.bars} bars · {tr.steps.length} moves
                        {pairs[i] ? ` · ${camelotLabel(pairs[i]!.a)}→${camelotLabel(pairs[i]!.b)}` : ""}
                      </span>
                    </span>
                    <span className="mix-flags">
                      <span data-ok={String(tr.onPhrase)}>PHR</span>
                      <span data-ok={pairs[i] == null ? "unknown" : String(pairs[i]!.ok)}>KEY</span>
                    </span>
                  </button>
                </li>
              );
            })}
            {!transitions.length && <li className="muted">No mixes yet: add a tracklist in Notes.</li>}
          </ol>
        </>
      ) : (
        <MoveLog analysis={analysis} offset={offset} />
      )}
    </section>
  );
}
