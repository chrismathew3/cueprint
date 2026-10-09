// Local YouTube helper, mounted into the Vite dev/preview server. The browser can't
// fetch YouTube media itself (CORS + stream extraction), so yt-dlp does it here and
// serves the result same-origin. Downloads are cached by video id + range.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, createReadStream, renameSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

const YTDLP = process.env.YTDLP ?? "yt-dlp";
const CACHE = resolve(import.meta.dirname, "../.cache/youtube");

export interface YtVideo {
  id: string;
  title: string;
  channel: string;
  duration: number;
  views?: number;
}

export interface YtChapter { start: number; title: string }

export interface YtInfo extends YtVideo {
  chapters: YtChapter[];
  /** Timestamped lines parsed from the description when there are no chapters. */
  tracklist: YtChapter[];
}

interface Job {
  id: string;
  file: string;
  progress: number;
  detail: string;
  done: boolean;
  error?: string;
  listeners: Set<ServerResponse>;
}

const jobs = new Map<string, Job>();

function run(args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(YTDLP, args);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => fail(new Error(`yt-dlp not available: ${e.message}`)));
    p.on("close", (code) => (code === 0 ? ok(out) : fail(new Error(err.trim().split("\n").pop() || `yt-dlp exited ${code}`))));
  });
}

export function videoId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12) || null;
    if (u.hostname.endsWith("youtube.com")) {
      if (u.searchParams.get("v")) return u.searchParams.get("v")!.slice(0, 11);
      const m = u.pathname.match(/\/(?:live|shorts|embed)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch { /* not a URL */ }
  return null;
}

function parseTimestamp(s: string): number {
  return s.split(":").map(Number).reduce((a, n) => a * 60 + n, 0);
}

/** "12:34 Artist - Title" style lines, the usual way DJ uploads list tracks. */
export function tracklistFromDescription(desc: string): YtChapter[] {
  const out: YtChapter[] = [];
  for (const raw of desc.split("\n")) {
    const m = raw.trim().match(/^[[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-–—.|]?\s*(.+)$/);
    if (m && m[2].length > 2) out.push({ start: parseTimestamp(m[1]), title: m[2].trim() });
  }
  // a real tracklist is increasing and has a few entries
  return out.length >= 3 && out.every((c, i) => i === 0 || c.start > out[i - 1].start) ? out : [];
}

async function search(q: string): Promise<YtVideo[]> {
  const json = JSON.parse(await run(["--flat-playlist", "-J", `ytsearch12:${q}`]));
  return (json.entries ?? [])
    .filter((e: { id?: string; live_status?: string }) => e.id && e.live_status !== "is_live")
    .map((e: Record<string, unknown>) => ({
      id: e.id as string, title: e.title as string, channel: (e.channel ?? e.uploader ?? "") as string,
      duration: (e.duration as number) ?? 0, views: e.view_count as number | undefined,
    }));
}

async function info(id: string): Promise<YtInfo> {
  const d = JSON.parse(await run(["-J", "--no-playlist", `https://www.youtube.com/watch?v=${id}`]));
  const chapters: YtChapter[] = (d.chapters ?? []).map((c: { start_time: number; title: string }) => ({ start: c.start_time, title: c.title }));
  return {
    id, title: d.title, channel: d.channel ?? d.uploader ?? "", duration: d.duration ?? 0, views: d.view_count,
    chapters, tracklist: chapters.length ? [] : tracklistFromDescription(d.description ?? ""),
  };
}

function emit(job: Job) {
  const msg = `data: ${JSON.stringify({ progress: job.progress, detail: job.detail, done: job.done, error: job.error })}\n\n`;
  for (const res of job.listeners) res.write(msg);
  if (job.done || job.error) for (const res of job.listeners) res.end();
}

function spawnLines(cmd: string, args: string[], onLine: (l: string) => void): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args);
    let buf = "", lastErr = "";
    const feed = (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split(/[\r\n]/);
      buf = lines.pop() ?? "";
      for (const l of lines) { if (/ERROR|Error/.test(l)) lastErr = l; onLine(l); }
    };
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
    p.on("error", (e) => fail(new Error(`${cmd} not available: ${e.message}`)));
    p.on("close", (code) => (code === 0 ? ok("") : fail(new Error(lastErr.replace(/^.*ERROR:\s*/, "") || `${cmd} exited ${code}`))));
  });
}

/** One full download per video, shared by every range cut from it. */
const fullDownloads = new Map<string, Promise<string>>();

function downloadFull(id: string, onProgress: (f: number, detail: string) => void): Promise<string> {
  const file = join(CACHE, `${id}.full.mp4`);
  if (existsSync(file)) return Promise.resolve(file);
  const running = fullDownloads.get(id);
  if (running) return running;
  const part = `${file}.part.mp4`;
  rmSync(part, { force: true });
  // Whole-file download with 8 parallel fragment connections runs ~100x realtime;
  // yt-dlp's ranged (--download-sections) path goes through ffmpeg at ~1.5x.
  let streams = 0, last = 0;
  const job = spawnLines(YTDLP, [
    "-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[height<=720]",
    "-N", "8", "--merge-output-format", "mp4", "--no-playlist", "--newline", "--no-part",
    "--progress-template", "download:PCT %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
    "-o", part, `https://www.youtube.com/watch?v=${id}`,
  ], (line) => {
    const m = line.match(/PCT\s+([\d.]+)%\|([^|]*)\|(.*)/);
    if (!m) return;
    const f = Number(m[1]) / 100;
    if (f < last - 0.5) streams++; // video stream done, audio starting
    last = f;
    onProgress(Math.min(0.97, (streams + f) / 2), `${m[2].trim()} · ${m[3].trim()} left`);
  }).then(() => { renameSync(part, file); return file; })
    .finally(() => fullDownloads.delete(id));
  fullDownloads.set(id, job);
  return job;
}

const hms = (s: number) => new Date(s * 1000).toISOString().slice(11, 19);

function startDownload(id: string, start?: number, end?: number): Job {
  const key = `${id}-${start ?? 0}-${end ?? "end"}`;
  const existing = jobs.get(key);
  if (existing && !existing.error) return existing;
  mkdirSync(CACHE, { recursive: true });
  const ranged = start != null || end != null;
  const file = ranged ? join(CACHE, `${key}.mp4`) : join(CACHE, `${id}.full.mp4`);
  const job: Job = { id: key, file, progress: 0, detail: "starting", done: false, listeners: new Set() };
  jobs.set(key, job);
  if (existsSync(file)) { job.progress = 1; job.done = true; job.detail = "cached"; return job; }

  void (async () => {
    try {
      const full = await downloadFull(id, (f, detail) => { job.progress = f; job.detail = detail; emit(job); });
      if (ranged) {
        job.progress = 0.98; job.detail = "cutting range"; emit(job);
        // stream copy: instant, starts on the keyframe at or before `start`
        const args = ["-v", "error", "-y"];
        if (start != null) args.push("-ss", String(start));
        if (end != null) args.push("-to", String(end));
        args.push("-i", full, "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", `${file}.part.mp4`);
        if (start != null && end != null) args.splice(args.indexOf("-to"), 2, "-t", String(end - start));
        await spawnLines("ffmpeg", args, () => {});
        renameSync(`${file}.part.mp4`, file);
      }
      job.progress = 1; job.done = true; job.detail = ranged ? `${hms((end ?? 0) - (start ?? 0))} cut` : "done";
    } catch (e) {
      job.error = e instanceof Error ? e.message : String(e);
      jobs.delete(key);
    }
    emit(job);
  })();
  return job;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? "/", "http://local");
  if (!url.pathname.startsWith("/api/yt/")) return next();
  const route = url.pathname.slice("/api/yt/".length);
  try {
    if (route === "health") return send(res, 200, { ok: true });
    if (route === "search") {
      const q = url.searchParams.get("q")?.trim();
      if (!q) return send(res, 400, { error: "missing q" });
      const id = videoId(q);
      return send(res, 200, id ? [await info(id)] : await search(q));
    }
    if (route === "info") {
      const id = videoId(url.searchParams.get("url") ?? "");
      if (!id) return send(res, 400, { error: "That doesn't look like a YouTube link." });
      return send(res, 200, await info(id));
    }
    if (route === "download") {
      const id = videoId(url.searchParams.get("url") ?? "");
      if (!id) return send(res, 400, { error: "That doesn't look like a YouTube link." });
      const num = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : undefined);
      const job = startDownload(id, num("start"), num("end"));
      // Server-sent events: progress until done, then the client fetches /file
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      job.listeners.add(res);
      req.on("close", () => job.listeners.delete(res));
      emit(job);
      return;
    }
    if (route.startsWith("file/")) {
      const job = jobs.get(decodeURIComponent(route.slice(5)));
      if (!job?.done) return send(res, 404, { error: "not ready" });
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": statSync(job.file).size, "Cross-Origin-Resource-Policy": "same-origin" });
      createReadStream(job.file).pipe(res);
      return;
    }
    if (route === "thumb") {
      // proxied so cross-origin isolation (COEP) doesn't block i.ytimg.com
      const id = videoId(url.searchParams.get("id") ?? "");
      if (!id) return send(res, 400, { error: "bad id" });
      const r = await fetch(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`);
      res.writeHead(r.status, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400", "Cross-Origin-Resource-Policy": "same-origin" });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    send(res, 404, { error: "unknown route" });
  } catch (e) {
    send(res, 502, { error: e instanceof Error ? e.message : String(e) });
  }
}

export function youtube(): Plugin {
  return {
    name: "studio-youtube",
    configureServer(server) { server.middlewares.use((req, res, next) => void handle(req, res, next)); },
    configurePreviewServer(server) { server.middlewares.use((req, res, next) => void handle(req, res, next)); },
  };
}
