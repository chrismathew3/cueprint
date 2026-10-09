import { useEffect, useMemo, useRef, useState } from "react";
import { fmtTime, moveArrow, moveDetail, moveLabel, type Analysis, type Move, type Track } from "@cueprint/core";
import { clock, useFrame } from "../clock.ts";
import { useStudio, type LogFilter } from "../store.ts";
import { VERDICT } from "./verdict.ts";

type Tab = "moves" | "notes" | "tracks";

export function SidePanel({ analysis, offset }: { analysis: Analysis; offset: number }) {
  const [tab, setTab] = useState<Tab>("moves");
  return (
    <section className="panel side">
      <div className="tabs" role="tablist">
        {(["moves", "notes", "tracks"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "moves" ? `Moves ${analysis.moves.filter((m) => m.kind !== "section").length}` : t === "notes" ? `Notes ${analysis.annotations.length}` : `Tracks ${analysis.tracks.length}`}
          </button>
        ))}
      </div>
      {tab === "moves" && <MoveLog analysis={analysis} offset={offset} />}
      {tab === "notes" && <Notes analysis={analysis} offset={offset} />}
      {tab === "tracks" && <Tracks analysis={analysis} />}
    </section>
  );
}

const FILTERS: [LogFilter, string][] = [["all", "All"], ["eq", "EQ"], ["filter", "Filter"], ["loop", "Loops"], ["proof", "On camera"]];

export function MoveLog({ analysis, offset }: { analysis: Analysis; offset: number }) {
  const filter = useStudio((s) => s.filter);
  const setFilter = useStudio((s) => s.setFilter);
  const list = useMemo(() => analysis.moves.filter((m) =>
    m.kind !== "section" && (filter === "all" || (filter === "proof" ? m.verdict === "hand moving" : m.kind === filter))), [analysis.moves, filter]);
  const listRef = useRef<HTMLDivElement>(null);
  const nowIdx = useRef(-1);
  const baseline = analysis.vision?.baseline;

  useFrame((t) => {
    let idx = -1;
    for (let i = 0; i < list.length; i++) if (list[i].t0 <= t + 0.05) idx = i;
    if (idx === nowIdx.current) return;
    const rows = listRef.current?.children;
    if (!rows) return;
    rows[nowIdx.current]?.classList.remove("now");
    nowIdx.current = idx;
    const row = rows[idx] as HTMLElement | undefined;
    row?.classList.add("now");
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  useEffect(() => { nowIdx.current = -1; }, [list]);

  return (
    <>
      <div className="side-head">
        <div className="chips">
          {FILTERS.map(([k, label]) => (
            <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
        <p className="honesty">
          {baseline == null
            ? "Camera check runs after audio: does a hand move on the mixer within ±1.5s of the move?"
            : <>At random moments his hand is moving on the mixer <b>{Math.round(baseline * 100)}%</b> of the time. A camera match is a hint, not proof.</>}
        </p>
      </div>
      <div className="log" ref={listRef}>
        {list.map((m) => <MoveRow key={m.id} m={m} offset={offset} />)}
        {!list.length && <div className="empty">Nothing here yet.</div>}
      </div>
    </>
  );
}

function MoveRow({ m, offset }: { m: Move; offset: number }) {
  const [cls, txt] = VERDICT[m.verdict];
  return (
    <button className="row" onClick={() => clock.seek(m.t0 - 1.5, true)}>
      <span className="row-t">{fmtTime(m.t0 + offset)}</span>
      <span className="row-body">
        <span className="row-name">{moveLabel(m)} {moveArrow(m)}</span>
        <span className="row-detail">{moveDetail(m)}</span>
        <span className={`pill ${cls}`}>{txt}{m.verdict === "hand moving" && m.zone ? ` · ${m.zone}` : ""}</span>
      </span>
    </button>
  );
}

export function Notes({ analysis, offset }: { analysis: Analysis; offset: number }) {
  const add = useStudio((s) => s.addAnnotation);
  const [text, setText] = useState("");
  return (
    <>
      <form className="side-head" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { add(clock.time, text.trim()); setText(""); } }}>
        <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="Note at playhead, e.g. 'watch the bass swap here'" />
        <p className="honesty">Notes pin to the playhead and show on the timeline. Teachers annotate, students follow.</p>
      </form>
      <div className="log">
        {analysis.annotations.map((a) => (
          <button className="row" key={a.id} onClick={() => clock.seek(a.t - 1, true)}>
            <span className="row-t">{fmtTime(a.t + offset)}</span>
            <span className="row-body"><span className="row-name note">{a.text}</span></span>
          </button>
        ))}
        {!analysis.annotations.length && <div className="empty">No notes yet. Pause on a moment and write what to listen for.</div>}
      </div>
    </>
  );
}

function parseTracklist(text: string): Track[] {
  const out: Track[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})\s+(.+?)\s+[-–—]\s+(.+?)(\s*\?)?$/);
    if (!m) continue;
    const start = (Number(m[1] ?? 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
    out.push({ start, artist: m[4], title: m[5], confident: !m[6] });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function Tracks({ analysis }: { analysis: Analysis }) {
  const setTracks = useStudio((s) => s.setTracks);
  const initial = analysis.tracks.map((t) => `${fmtTime(t.start)} ${t.artist} - ${t.title}${t.confident ? "" : " ?"}`).join("\n");
  const [text, setText] = useState(initial);
  return (
    <div className="side-head grow">
      <textarea className="field tracklist" value={text} onChange={(e) => setText(e.target.value)}
        placeholder={"0:05 In Parallel - Get On It\n2:05 Uffie - ADD SUV\n5:05 Barry Can't Swim - Still Riding"} spellCheck={false} />
      <button className="btn" onClick={() => setTracks(parseTracklist(text))}>Save tracklist</button>
      <p className="honesty">One per line: <code>m:ss Artist - Title</code>. Times are from the start of this file. Add <code>?</code> for a guess.</p>
    </div>
  );
}
