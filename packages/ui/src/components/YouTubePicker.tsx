import { useEffect, useState } from "react";
import { useStudio } from "../store.ts";
import {
  fmtDuration, isYouTubeLink, parseClock, searchYouTube, splitTitle, thumbUrl, tracksFrom, youtubeAvailable, youtubeInfo,
  type YtInfo, type YtVideo,
} from "../youtube.ts";

export function YouTubePicker() {
  const importYouTube = useStudio((s) => s.importYouTube);
  const busy = useStudio((s) => !!s.importing && !s.importing.error);
  const [available, setAvailable] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<YtVideo[]>([]);
  const [picked, setPicked] = useState<YtInfo | null>(null);
  const [loading, setLoading] = useState<"search" | "info" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [checked, setChecked] = useState(false);
  useEffect(() => { void youtubeAvailable().then((ok) => { setAvailable(ok); setChecked(true); }); }, []);
  if (checked && !available) {
    return (
      <div className="yt">
        <div className="yt-bar yt-off">
          <svg viewBox="0 0 24 24" className="yt-icon" aria-hidden><path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4a2.5 2.5 0 0 0-1.8 1.8C2 8.8 2 12 2 12s0 3.2.4 4.8a2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8c.4-1.6.4-4.8.4-4.8s0-3.2-.4-4.8zM10 15V9l5.2 3z" /></svg>
          <span className="yt-input">YouTube import needs the local helper: run <code>bun run dev</code> and open <code>localhost:5173</code></span>
        </div>
      </div>
    );
  }

  const submit = async () => {
    const query = q.trim();
    if (!query) return;
    setError(null); setPicked(null);
    setLoading(isYouTubeLink(query) ? "info" : "search");
    try {
      const res = await searchYouTube(query);
      if (isYouTubeLink(query) && res[0] && "chapters" in res[0]) choose(res[0] as YtInfo);
      else setResults(res);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(null); }
  };

  const choose = (info: YtInfo) => { setPicked(info); setFrom(""); setTo(""); };

  const pick = async (v: YtVideo) => {
    setError(null); setLoading("info");
    try { choose(await youtubeInfo(v.id)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(null); }
  };

  const start = parseClock(from), end = parseClock(to);
  const rangeError = Number.isNaN(start) || Number.isNaN(end) ? "Use m:ss or h:mm:ss"
    : start != null && end != null && end <= start ? "End must be after start"
    : picked && end != null && end > picked.duration ? "End is past the video" : null;
  const length = picked ? (end ?? picked.duration) - (start ?? 0) : 0;
  const tracks = picked ? tracksFrom(picked, start ?? 0, end ?? Infinity) : [];

  return (
    <div className="yt">
      <form className="yt-bar" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <svg viewBox="0 0 24 24" className="yt-icon" aria-hidden><path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4a2.5 2.5 0 0 0-1.8 1.8C2 8.8 2 12 2 12s0 3.2.4 4.8a2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8c.4-1.6.4-4.8.4-4.8s0-3.2-.4-4.8zM10 15V9l5.2 3z" /></svg>
        <input className="yt-input" value={q} onChange={(e) => setQ(e.target.value)} disabled={busy}
          placeholder="Paste a YouTube link, or search: “boiler room fred again”" aria-label="YouTube link or search" />
        <button className="btn primary" disabled={busy || !q.trim() || !!loading}>{loading ? "…" : isYouTubeLink(q) ? "Open" : "Search"}</button>
      </form>
      {error && <div className="yt-error">{error}</div>}

      {picked ? (
        <div className="yt-pick">
          <img src={thumbUrl(picked.id)} alt="" />
          <div className="yt-pick-body">
            <div className="yt-title">{picked.title}</div>
            <div className="yt-sub">{picked.channel} · {fmtDuration(picked.duration)}{picked.views ? ` · ${(picked.views / 1e6).toFixed(1)}M views` : ""}</div>
            <div className="yt-range">
              <label>From<input className="field" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="0:00" /></label>
              <label>To<input className="field" value={to} onChange={(e) => setTo(e.target.value)} placeholder={fmtDuration(picked.duration)} /></label>
              <span className="yt-len">{rangeError ?? `${fmtDuration(Math.max(0, length))} to analyze`}</span>
            </div>
            <p className="honesty">
              {tracks.length
                ? <>Found <b>{tracks.length} tracks</b> in the {picked.chapters.length ? "chapters" : "description"}. They'll label the timeline.</>
                : "No tracklist in the chapters or description. You can paste one later."}
              {length > 1800 && " Long range: hand tracking takes about a minute per 8 minutes of video."}
            </p>
            <div className="row-actions">
              <button className="btn ghost" onClick={() => setPicked(null)}>Back</button>
              <button className="btn primary" disabled={busy || !!rangeError}
                onClick={() => void importYouTube(picked, { start: start ?? undefined, end: end ?? undefined })}>
                Analyze {splitTitle(picked.title, picked.channel).artist}
              </button>
            </div>
          </div>
        </div>
      ) : !!results.length && (
        <div className="yt-results">
          {results.map((v) => (
            <button key={v.id} className="yt-card" onClick={() => void pick(v)} disabled={!!loading}>
              <span className="yt-thumb"><img src={thumbUrl(v.id)} alt="" loading="lazy" /><span className="yt-dur">{fmtDuration(v.duration)}</span></span>
              <span className="yt-title">{v.title}</span>
              <span className="yt-sub">{v.channel}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
