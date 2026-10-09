// Client for the local YouTube helper (apps/web/server/youtube.ts).
import type { Track } from "@cueprint/core";

export interface YtVideo { id: string; title: string; channel: string; duration: number; views?: number }
export interface YtChapter { start: number; title: string }
export interface YtInfo extends YtVideo { chapters: YtChapter[]; tracklist: YtChapter[] }

let health: Promise<boolean> | null = null;
/** The helper only exists when served by the Vite dev/preview server. */
export const youtubeAvailable = () =>
  (health ??= fetch("api/yt/health").then((r) => r.ok && r.headers.get("content-type")?.includes("json") === true).catch(() => false));

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body as T;
}

export const searchYouTube = (q: string) => json<(YtVideo | YtInfo)[]>(`api/yt/search?q=${encodeURIComponent(q)}`);
export const youtubeInfo = (id: string) => json<YtInfo>(`api/yt/info?url=${encodeURIComponent(id)}`);
export const thumbUrl = (id: string) => `api/yt/thumb?id=${id}`;

export function isYouTubeLink(s: string) {
  return /(?:youtube\.com\/(?:watch|live|shorts|embed)|youtu\.be\/)/.test(s) || /^[\w-]{11}$/.test(s.trim());
}

/** Download (or reuse the cached copy) and return it as a File. */
export function downloadYouTube(
  id: string,
  range: { start?: number; end?: number },
  onProgress: (fraction: number, detail: string) => void,
): Promise<File> {
  const qs = new URLSearchParams({ url: id });
  if (range.start != null) qs.set("start", String(range.start));
  if (range.end != null) qs.set("end", String(range.end));
  const key = `${id}-${range.start ?? 0}-${range.end ?? "end"}`;
  return new Promise((resolve, reject) => {
    const es = new EventSource(`api/yt/download?${qs}`);
    es.onmessage = async (e) => {
      const m = JSON.parse(e.data) as { progress: number; detail: string; done: boolean; error?: string };
      if (m.error) { es.close(); return reject(new Error(m.error)); }
      onProgress(m.progress, m.detail);
      if (m.done) {
        es.close();
        try {
          const blob = await (await fetch(`api/yt/file/${encodeURIComponent(key)}`)).blob();
          resolve(new File([blob], `${id}.mp4`, { type: "video/mp4" }));
        } catch (err) { reject(err); }
      }
    };
    es.onerror = () => { es.close(); reject(new Error("Lost connection to the download helper.")); };
  });
}

/** Pull artist + venue out of the common set-title shapes:
 *  "Barry Can't Swim | Mixmag Lab London 2025", "Fred again.. | Boiler Room: London",
 *  "Einmusik b2b Jonas Saalbach live at Preikestolen in Norway for Cercle", "X @ Y". */
export function splitTitle(title: string, channel: string): { artist: string; venue: string } {
  const t = title.replace(/\s*[([]\s*(?:full|dj|live)?\s*(?:set|mix)\s*[)\]]\s*/gi, " ").trim();
  const pipe = t.split(/\s+[|@]\s+/);
  if (pipe.length >= 2) return { artist: pipe[0].trim(), venue: pipe.slice(1).join(" · ").replace(/^boiler room:\s*/i, "Boiler Room ").trim() };
  const at = t.match(/^(.+?)\s+(?:live\s+)?(?:at|in)\s+(.+?)(?:\s+(?:for|x)\s+(cercle|boiler room|mixmag|hör|dekmantel)\b.*)?$/i);
  if (at) return { artist: at[1].trim(), venue: at[3] ? `${at[3].replace(/^./, (c) => c.toUpperCase())} · ${at[2].trim()}` : at[2].trim() };
  const dash = t.split(/\s+[-–—]\s+/);
  if (dash.length >= 2) return { artist: dash[0].trim(), venue: dash.slice(1).join(" · ").trim() };
  return { artist: t, venue: channel };
}

/** Chapters or description timestamps → tracks, shifted into the downloaded range. */
export function tracksFrom(info: YtInfo, start = 0, end = Infinity): Track[] {
  const src = info.chapters.length ? info.chapters : info.tracklist;
  return src
    .filter((c, i) => (src[i + 1]?.start ?? Infinity) > start && c.start < end)
    .map((c) => {
      const m = c.title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
      return { start: Math.max(0, c.start - start), artist: m ? m[1].trim() : "", title: (m ? m[2] : c.title).trim(), confident: true };
    });
}

export const fmtDuration = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

export function parseClock(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  if (!/^\d+(:\d{1,2}){0,2}$/.test(t)) return NaN;
  return t.split(":").map(Number).reduce((a, n) => a * 60 + n, 0);
}
