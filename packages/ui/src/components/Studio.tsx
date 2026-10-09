import { useEffect, useMemo, useRef, useState } from "react";
import { fmtTime } from "@cueprint/core";
import { clock, useFrame } from "../clock.ts";
import { defaultLanes, drillLanes, type Lane } from "../lanes.ts";
import { useTransitions } from "../mix.ts";
import { useStudio } from "../store.ts";
import { Decks } from "./Decks.tsx";
import { DrillOverlay, useDrill } from "./Drill.tsx";
import { ImportProgress } from "./Library.tsx";
import { MixerStrip } from "./MixerStrip.tsx";
import { Mixes } from "./Mixes.tsx";
import { Recipe } from "./Recipe.tsx";
import { Notes, Tracks } from "./SidePanel.tsx";
import { Timeline } from "./Timeline.tsx";
import { VideoStage } from "./VideoStage.tsx";

export function Studio({ lanes = defaultLanes }: { lanes?: readonly Lane[] }) {
  const current = useStudio((s) => s.current)!;
  const importing = useStudio((s) => s.importing);
  const mode = useStudio((s) => s.mode);
  const setMode = useStudio((s) => s.setMode);
  const close = useStudio((s) => s.close);
  const setZoom = useStudio((s) => s.setZoom);
  const setPractice = useStudio((s) => s.setPractice);
  const { analysis, meta, url, liveFrames } = current;
  const transitions = useTransitions(analysis);
  const drill = useDrill(analysis);
  const clockEl = useRef<HTMLSpanElement>(null);
  const offset = meta.offset;

  useFrame((t) => {
    const s = fmtTime(t + offset, true);
    if (clockEl.current && clockEl.current.textContent !== s) clockEl.current.textContent = s;
  });

  const jumpable = useMemo(() => [...transitions].sort((a, b) => a.t0 - b.t0), [transitions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea")) return;
      if (e.code === "Space") { e.preventDefault(); clock.toggle(); }
      else if (mode === "watch" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        // arrows jump between mixes: the thing you're here to study
        e.preventDefault();
        const t = clock.time + 2;
        const tr = e.key === "ArrowRight" ? jumpable.find((x) => x.t0 > t + 4) : [...jumpable].reverse().find((x) => x.t0 < t - 6);
        if (tr) { setPractice({ transitionId: tr.id }); clock.seek(Math.max(0, tr.t0 - 16), true); }
      } else if (e.key === "l" && mode === "watch") {
        const p = useStudio.getState().practice;
        setPractice({ looping: !p.looping });
      } else if (e.key === "=" || e.key === "+") setZoom(useStudio.getState().zoom / 1.4);
      else if (e.key === "-") setZoom(useStudio.getState().zoom * 1.4);
      else if (e.key === "1") setMode("watch");
      else if (e.key === "2") setMode("drill");
      else if (e.key === "3") setMode("notes");
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [mode, jumpable, setMode, setZoom, setPractice]);

  const quiz = mode === "drill" && drill.phase !== "revealed";

  return (
    <div className="studio" data-mode={mode} data-quiz={quiz}>
      <header className="topbar">
        <button className="brand" onClick={close} aria-label="Back to library">
          <span className="wordmark">CUEPRINT</span>
          <span className="lbl">{[meta.artist || meta.name, meta.venue].filter(Boolean).join(" — ")}</span>
        </button>
        <span className="clock big" ref={clockEl}>0:00.0</span>
        <div className="topbar-right">
          {importing && !importing.error && <ImportProgress name={importing.name} progress={importing.progress} compact />}
          <div className="modes" role="tablist" aria-label="Mode">
            {(["watch", "drill", "notes"] as const).map((m, i) => (
              <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "lit" : ""} onClick={() => setMode(m)}>
                {m.toUpperCase()}<kbd>{i + 1}</kbd>
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="rack">
        <div className="col-left">
          <Decks analysis={analysis} transitions={transitions} />
          {quiz ? <section className="recipe empty"><div className="lbl">Drill</div><p>Answers are hidden. Name the move by ear, then watch how it was done.</p></section>
            : <Recipe analysis={analysis} transitions={transitions} offset={offset} />}
        </div>
        <div className="col-center">
          <VideoStage url={url} frames={liveFrames} hideAnswers={quiz}>
            {mode === "drill" && <DrillOverlay drill={drill} />}
            <Transport />
          </VideoStage>
          <MixerStrip analysis={analysis} frames={liveFrames} transitions={transitions} hide={quiz} />
        </div>
        <div className="col-right">
          {mode === "watch" && <Mixes analysis={analysis} transitions={transitions} offset={offset} />}
          {mode === "drill" && <DrillStats drill={drill} />}
          {mode === "notes" && <NotesPanel analysis={analysis} offset={offset} />}
        </div>
      </main>

      <Timeline analysis={analysis} frames={liveFrames} transitions={transitions} lanes={quiz ? drillLanes : lanes} hideMoves={quiz} />
    </div>
  );
}

function NotesPanel({ analysis, offset }: { analysis: Parameters<typeof Notes>[0]["analysis"]; offset: number }) {
  const [tab, setTab] = useState<"notes" | "tracks">("notes");
  return (
    <section className="mixes">
      <div className="tabs">
        <button className={tab === "notes" ? "lit" : ""} onClick={() => setTab("notes")}>NOTES {analysis.annotations.length}</button>
        <button className={tab === "tracks" ? "lit" : ""} onClick={() => setTab("tracks")}>TRACKLIST {analysis.tracks.length}</button>
      </div>
      {tab === "notes" ? <Notes analysis={analysis} offset={offset} /> : <Tracks analysis={analysis} />}
    </section>
  );
}

function Transport() {
  const play = useRef<HTMLButtonElement>(null);
  const rate = useStudio((s) => s.practice.rate);
  const looping = useStudio((s) => s.practice.looping);
  useFrame((_, playing) => {
    if (play.current && play.current.dataset.playing !== String(playing)) play.current.dataset.playing = String(playing);
  });
  return (
    <div className="transport">
      <button aria-label="Back 4 bars" onClick={() => clock.seek(clock.time - 7.5)}>◀◀</button>
      <button ref={play} className="play" aria-label="Play or pause" onClick={() => clock.toggle()}>
        <span className="i-play">▶</span><span className="i-pause">❚❚</span>
      </button>
      <button aria-label="Forward 4 bars" onClick={() => clock.seek(clock.time + 7.5)}>▶▶</button>
      {(rate !== 1 || looping) && <span className="transport-tag">{looping ? "LOOP" : ""}{looping && rate !== 1 ? " · " : ""}{rate !== 1 ? `${rate * 100}%` : ""}</span>}
    </div>
  );
}

function DrillStats({ drill }: { drill: ReturnType<typeof useDrill> }) {
  const rows = Object.entries(drill.score.byAnswer);
  return (
    <section className="mixes">
      <div className="tabs"><button className="lit">YOUR EAR</button></div>
      <div className="mix-summary">
        <div><b>{drill.score.attempts ? Math.round((drill.score.correct / drill.score.attempts) * 100) : 0}%</b><span className="lbl">right</span></div>
        <div><b>{drill.score.streak}</b><span className="lbl">streak</span></div>
        <div><b>{drill.score.best}</b><span className="lbl">best</span></div>
      </div>
      <div className="stat-list">
        {rows.length ? rows.map(([k, [n, c]]) => (
          <div className="stat-row" key={k}>
            <span>{k}</span>
            <span className="stat-bar"><span style={{ transform: `scaleX(${n ? c / n : 0})` }} /></span>
            <span className="lbl">{c}/{n}</span>
          </div>
        )) : <p className="muted-p">Answer a few to see which moves your ear catches and which it misses.</p>}
      </div>
    </section>
  );
}
