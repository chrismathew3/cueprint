import { useRef, useState } from "react";
import { camelotLabel, keyName, fmtTime, type Analysis, type Transition } from "@cueprint/core";
import { useFrame } from "../clock.ts";
import { KEY_SURE, mixAt, trackSpan, type DeckView, type MixContext } from "../mix.ts";

const sameView = (x: MixContext, y: MixContext) =>
  x.a.track === y.a.track && x.b.track === y.b.track && x.a.state === y.a.state && x.b.state === y.b.state &&
  x.transition?.id === y.transition?.id && x.a.key?.number === y.a.key?.number && x.b.key?.number === y.b.key?.number;

export function Decks({ analysis, transitions }: { analysis: Analysis; transitions: readonly Transition[] }) {
  const [ctx, setCtx] = useState<MixContext>(() => mixAt(analysis, transitions, 0));
  const ctxRef = useRef(ctx);
  const bpm = useRef<HTMLSpanElement>(null);
  const pos = useRef<HTMLSpanElement>(null);
  const dots = useRef<HTMLSpanElement>(null);
  const left = useRef<Record<string, HTMLSpanElement | null>>({});

  useFrame((t, playing) => {
    const next = mixAt(analysis, transitions, t);
    if (!sameView(next, ctxRef.current)) { ctxRef.current = next; setCtx(next); }

    const { beats, localBpm, downbeat } = analysis.grid;
    let lo = 0, hi = beats.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (beats[m] <= t) lo = m; else hi = m - 1; }
    const b = localBpm[Math.min(lo, localBpm.length - 1)] || analysis.grid.bpm;
    if (bpm.current) bpm.current.textContent = b.toFixed(1);
    const rel = lo - downbeat;
    const bar = Math.floor(rel / 4) + 1, beat = ((rel % 4) + 4) % 4;
    if (pos.current) pos.current.textContent = rel >= 0 ? `BAR ${bar}.${beat + 1} · PHRASE ${Math.floor((bar - 1) / 16) + 1}` : "—";
    const since = t - beats[lo];
    const kids = dots.current?.children;
    if (kids) for (let i = 0; i < 4; i++) kids[i].classList.toggle("on", playing && i === beat && since >= 0 && since < 0.15);

    for (const d of [ctxRef.current.a, ctxRef.current.b]) {
      const el = left.current[d.letter];
      if (!el) continue;
      if (d.track < 0) { el.textContent = ""; continue; }
      const [s, e] = trackSpan(analysis, d.track);
      el.textContent = d.state === "cued" ? `IN ${fmtTime(Math.max(0, s - t))}` : t < e ? `−${fmtTime(Math.max(0, e - t))}` : "";
    }
  });

  return (
    <section className="decks">
      <DeckCard d={ctx.a} analysis={analysis} leftRef={(el) => (left.current.A = el)} />
      <div className="link" data-ok={ctx.harmonic == null ? "unknown" : String(ctx.harmonic)}>
        <span className="lbl">{ctx.transition ? "Mixing" : "Next"}</span>
        <span className="link-keys">
          {ctx.a.key ? camelotLabel(ctx.a.key) : "—"} <i>→</i> {ctx.b.key ? camelotLabel(ctx.b.key) : "—"}
        </span>
        <span className="lbl">{ctx.harmonic == null ? "key unknown" : ctx.harmonic ? "keys mix" : "key clash"}{ctx.harmonic != null && Math.min(ctx.a.keyConfidence, ctx.b.keyConfidence) < KEY_SURE ? " ?" : ""}</span>
      </div>
      <DeckCard d={ctx.b} analysis={analysis} leftRef={(el) => (left.current.B = el)} />
      <div className="tempo">
        <span className="big" ref={bpm}>—</span><span className="lbl">BPM</span>
        <span className="beats" ref={dots}><i /><i /><i /><i /></span>
        <span className="lbl tempo-pos" ref={pos} />
      </div>
    </section>
  );
}

function DeckCard({ d, analysis, leftRef }: { d: DeckView; analysis: Analysis; leftRef: (el: HTMLSpanElement | null) => void }) {
  const tr = analysis.tracks[d.track];
  return (
    <div className="deck-card" data-state={d.state}>
      <div className="deck-letter">{d.letter}</div>
      <div className="deck-body">
        <div className="deck-row">
          <span className="lbl">Deck {d.letter} · {d.state}</span>
          <span className="lbl deck-left" ref={leftRef} />
        </div>
        <div className="deck-title">{tr ? tr.title : d.state === "idle" ? "Empty" : "Unknown track"}</div>
        <div className="deck-artist">{tr ? tr.artist || "—" : d.track < 0 && analysis.tracks.length === 0 ? "Add a tracklist in Notes" : "—"}</div>
      </div>
      <div className="deck-key" title={d.key ? `${keyName(d.keyIndex)} · confidence ${(d.keyConfidence * 100).toFixed(0)}%` : "No key yet"}>
        <span className="big">{d.key ? camelotLabel(d.key) : "—"}{d.key && d.keyConfidence < KEY_SURE ? <sup>?</sup> : null}</span>
        <span className="lbl">{d.key ? keyName(d.keyIndex) : "key"}</span>
      </div>
    </div>
  );
}
