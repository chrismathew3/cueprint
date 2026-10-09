import { useEffect, useRef, useState } from "react";
import { fmtTime } from "@cueprint/core";
import type { Track } from "@cueprint/core";
import { useStudio, type Progress, type Stage } from "../store.ts";
import { YouTubePicker } from "./YouTubePicker.tsx";

interface Demo { file: string; artist: string; venue: string; offset: number; tracks: Track[] }

const STAGES: [Stage, string][] = [["download", "Download"], ["decode", "Decode audio"], ["analyze", "Find the moves"], ["vision", "Track hands"]];

export function Library() {
  const library = useStudio((s) => s.library);
  const importing = useStudio((s) => s.importing);
  const importFile = useStudio((s) => s.importFile);
  const open = useStudio((s) => s.open);
  const remove = useStudio((s) => s.remove);
  const refresh = useStudio((s) => s.refreshLibrary);
  const [drag, setDrag] = useState(false);
  const [demos, setDemos] = useState<Demo[]>([]);
  const [fetching, setFetching] = useState<string | null>(null);

  useEffect(() => {
    fetch("demo/manifest.json").then((r) => (r.ok ? r.json() : [])).then(setDemos).catch(() => setDemos([]));
  }, []);

  const loadDemo = async (d: Demo) => {
    setFetching(d.file);
    try {
      const blob = await (await fetch(`demo/${d.file}`)).blob();
      await importFile(new File([blob], d.file, { type: "video/mp4" }), { artist: d.artist, venue: d.venue, offset: d.offset, tracks: d.tracks });
    } finally { setFetching(null); }
  };
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { void refresh(); }, [refresh]);

  const take = (files: FileList | null) => {
    const f = files?.[0];
    if (f) void importFile(f);
  };

  return (
    <div className="library"
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files); }}>
      <div className="library-top">
        <span className="wordmark">CUEPRINT</span>
        <span className="lbl">Runs on this machine · nothing uploaded</span>
      </div>
      <div className="library-hero">
        <h1>Steal the <em>mix</em>,<br />not the tracks.</h1>
        <div>
          <p>Pick a set you love. The studio breaks every transition down to the bar: when it started, what came out, what went in, whether the keys fit. Then you loop it slow until your hands know it.</p>
          <div className="steps-mini">
            <div><b>01</b><span className="lbl">Find a set</span></div>
            <div><b>02</b><span className="lbl">Study each mix</span></div>
            <div><b>03</b><span className="lbl">Loop it · drill it</span></div>
          </div>
        </div>
      </div>

      {!importing || importing.error ? <YouTubePicker /> : null}

      <button className={`drop ${drag ? "drag" : ""}`} onClick={() => input.current?.click()} disabled={!!importing && !importing.error}>
        {importing && !importing.error ? (
          <ImportProgress name={importing.name} progress={importing.progress} />
        ) : (
          <>
            <span className="drop-plus">+</span>
            <span className="drop-title">Or drop a set video</span>
            <span className="drop-sub">MP4, MOV or WebM · a Boiler Room or Cercle clip works great</span>
            {importing?.error && <span className="drop-err">{importing.error}</span>}
          </>
        )}
      </button>
      {!!demos.length && !importing && (
        <div className="demos">
          <span className="eyebrow">Or try</span>
          {demos.map((d) => (
            <button key={d.file} className="demo" onClick={() => void loadDemo(d)} disabled={!!fetching}>
              {fetching === d.file ? "Loading…" : `${d.artist} · ${d.venue}`}
            </button>
          ))}
        </div>
      )}
      <input ref={input} type="file" accept="video/*,audio/*" hidden onChange={(e) => take(e.target.files)} />

      {!!library.length && (
        <div className="shelf">
          <div className="eyebrow">Your sets</div>
          <div className="cards">
            {library.map((s) => (
              <div className="card" key={s.id}>
                <button className="card-main" onClick={() => void open(s.id)}>
                  <span className="card-title">{s.artist || s.name}</span>
                  <span className="card-sub">{[s.venue, (s.fileSize / 1e6).toFixed(0) + " MB", s.offset ? `from ${fmtTime(s.offset)}` : ""].filter(Boolean).join(" · ")}</span>
                </button>
                <button className="card-x" aria-label={`Remove ${s.name}`} onClick={() => void remove(s.id)}>×</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ImportProgress({ name, progress, compact = false }: { name: string; progress: Progress[]; compact?: boolean }) {
  return (
    <div className={`progress ${compact ? "compact" : ""}`}>
      {!compact && <div className="progress-name">{name}</div>}
      {STAGES.map(([stage, label]) => {
        const p = progress.find((x) => x.stage === stage);
        const state = !p ? "wait" : p.fraction >= 1 ? "done" : "run";
        if (compact && state !== "run") return null;
        if (stage === "download" && !p) return null;
        return (
          <div className="progress-row" key={stage} data-state={state}>
            <span className="progress-label">{label}</span>
            <span className="progress-track"><span className="progress-fill" style={{ transform: `scaleX(${p?.fraction ?? 0})` }} /></span>
            <span className="progress-detail">{p?.detail ?? ""}</span>
          </div>
        );
      })}
    </div>
  );
}
