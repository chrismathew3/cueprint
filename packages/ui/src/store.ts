import { create } from "zustand";
import { SCHEMA_VERSION, type Analysis, type Annotation, type MoveKind, type SetMeta, type Track, type VisionFrame } from "@cueprint/core";
import { analyzeParallel } from "@cueprint/dsp";
import { decodeMonoPcm, probe } from "@cueprint/media";
import { fuse, runVision, type VisionRun } from "@cueprint/vision";
import * as db from "./persist.ts";
import { downloadYouTube, splitTitle, tracksFrom, type YtInfo } from "./youtube.ts";

export type Stage = "download" | "decode" | "analyze" | "vision";
export interface Progress { stage: Stage; fraction: number; detail?: string }
export type LogFilter = MoveKind | "all" | "proof";
export type Mode = "watch" | "drill" | "notes";
export interface Practice { transitionId: string | null; looping: boolean; rate: number; lead: number }

interface Current {
  meta: SetMeta;
  url: string;
  file: Blob;
  analysis: Analysis;
  /** Vision frames streamed in so far (the camera lane fills live). */
  liveFrames: VisionFrame[];
}

interface StudioState {
  library: SetMeta[];
  current: Current | null;
  importing: { name: string; progress: Progress[]; error?: string } | null;
  filter: LogFilter;
  zoom: number;
  mode: Mode;
  timings: Partial<Record<Stage, number>>;
  practice: Practice;
  setPractice(p: Partial<Practice>): void;
  refreshLibrary(): Promise<void>;
  importFile(file: File, meta?: Partial<Pick<SetMeta, "artist" | "venue" | "offset">> & { tracks?: Track[] }, keepProgress?: boolean): Promise<void>;
  importYouTube(info: YtInfo, range: { start?: number; end?: number }): Promise<void>;
  open(id: string): Promise<void>;
  close(): void;
  remove(id: string): Promise<void>;
  setFilter(f: LogFilter): void;
  setZoom(z: number): void;
  setMode(m: Mode): void;
  addAnnotation(t: number, text: string): void;
  setTracks(tracks: Track[]): void;
}

let visionRun: VisionRun | null = null;

function setProgress(stage: Stage, fraction: number, detail?: string) {
  useStudio.setState((s) => {
    if (!s.importing) return s;
    const rest = s.importing.progress.filter((p) => p.stage !== stage);
    return { importing: { ...s.importing, progress: [...rest, { stage, fraction, detail }] } };
  });
}

async function persistCurrent() {
  const c = useStudio.getState().current;
  if (c) await db.saveAnalysis(c.meta.id, c.analysis);
}

function startVision(cur: Current) {
  visionRun?.cancel();
  const started = performance.now();
  visionRun = runVision(cur.file, {
    duration: cur.analysis.duration,
    onFrames: (frames, fraction, fps) => {
      useStudio.setState((s) => (s.current?.meta.id === cur.meta.id
        ? { current: { ...s.current, liveFrames: s.current.liveFrames.concat(frames) } } : s));
      setProgress("vision", fraction, `${fps.toFixed(0)} frames/s`);
    },
  });
  visionRun.done.then(async (track) => {
    const s = useStudio.getState();
    if (s.current?.meta.id !== cur.meta.id) return;
    const moves = s.current.analysis.moves.map((m) => ({ ...m }));
    fuse(moves, track.frames);
    const analysis = { ...s.current.analysis, moves, vision: track };
    useStudio.setState({
      current: { ...s.current, analysis, liveFrames: track.frames as VisionFrame[] },
      importing: null,
      timings: { ...s.timings, vision: (performance.now() - started) / 1000 },
    });
    await persistCurrent();
  }).catch((err) => {
    console.warn("vision failed", err);
    useStudio.setState({ importing: null });
  });
}

export const useStudio = create<StudioState>()((set, get) => ({
  library: [],
  current: null,
  importing: null,
  filter: "all",
  zoom: 48,
  mode: "watch",
  timings: {},
  practice: { transitionId: null, looping: false, rate: 1, lead: 8 },
  setPractice: (p) => set((s) => ({ practice: { ...s.practice, ...p } })),

  async refreshLibrary() { set({ library: await db.listSets() }); },

  async importFile(file, extra, keepProgress) {
    if (!keepProgress) set({ importing: { name: file.name, progress: [] }, timings: {} });
    try {
      const id = await db.setIdFor(file);
      const existing = await db.loadAnalysis(id);
      if (existing) { set({ importing: null }); await db.storeVideo(id, file); return get().open(id); }

      const info = await probe(file);
      const meta: SetMeta = {
        id, name: file.name.replace(/\.[^.]+$/, ""), fileName: file.name, fileSize: file.size,
        artist: extra?.artist ?? "", venue: extra?.venue ?? "", offset: extra?.offset ?? 0, createdAt: Date.now(),
      };
      const stored = db.storeVideo(id, file);

      let t = performance.now();
      setProgress("decode", 0, "WebCodecs");
      const pcm = await decodeMonoPcm(file, { onProgress: (f) => setProgress("decode", f, "WebCodecs") });
      const decodeS = (performance.now() - t) / 1000;
      setProgress("decode", 1, `${decodeS.toFixed(1)}s`);

      t = performance.now();
      const workers = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
      setProgress("analyze", 0, `${workers} workers`);
      const base = await analyzeParallel(pcm, { workers, onProgress: (f: number) => setProgress("analyze", f, `${workers} workers`) });
      const analyzeS = (performance.now() - t) / 1000;
      setProgress("analyze", 1, `${analyzeS.toFixed(1)}s`);

      const analysis: Analysis = { ...base, tracks: extra?.tracks ?? [], annotations: [] } as Analysis;
      await db.saveMeta(meta);
      await db.saveAnalysis(id, analysis);
      await stored;
      const cur: Current = { meta, url: URL.createObjectURL(file), file, analysis, liveFrames: [] };
      set({ current: cur, timings: { decode: decodeS, analyze: analyzeS } });
      await get().refreshLibrary();
      // the studio opens now; hand tracking keeps streaming into the camera lane
      if (info.hasVideo) { setProgress("vision", 0, "GPU"); startVision(cur); }
      else set({ importing: null });
    } catch (err) {
      set((s) => ({ importing: s.importing ? { ...s.importing, error: err instanceof Error ? err.message : String(err) } : null }));
    }
  },

  async importYouTube(info, range) {
    const name = info.title;
    set({ importing: { name, progress: [{ stage: "download", fraction: 0, detail: "yt-dlp" }] }, timings: {} });
    try {
      const t = performance.now();
      const file = await downloadYouTube(info.id, range, (f, detail) => setProgress("download", f, detail));
      setProgress("download", 1, `${((performance.now() - t) / 1000).toFixed(0)}s`);
      const { artist, venue } = splitTitle(info.title, info.channel);
      await get().importFile(file, {
        artist, venue, offset: range.start ?? 0,
        tracks: tracksFrom(info, range.start ?? 0, range.end ?? Infinity),
      }, true);
    } catch (err) {
      set((s) => ({ importing: { name, progress: s.importing?.progress ?? [], error: err instanceof Error ? err.message : String(err) } }));
    }
  },

  async open(id) {
    const [meta] = (await db.listSets()).filter((m) => m.id === id);
    const [analysis, file] = await Promise.all([db.loadAnalysis(id), db.loadVideo(id)]);
    if (!meta || !analysis || !file) return;
    const prev = get().current;
    if (prev) URL.revokeObjectURL(prev.url);
    let analysis2 = analysis;
    if ((analysis.schema ?? 1) < SCHEMA_VERSION) {
      // older analysis (no key curve): re-run the audio side, keep tracks, notes and hand tracking
      set({ importing: { name: meta.name, progress: [{ stage: "analyze", fraction: 0, detail: "upgrading" }] } });
      const pcm = await decodeMonoPcm(file, { onProgress: (f) => setProgress("decode", f, "WebCodecs") });
      const base = await analyzeParallel(pcm, { workers: Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)) });
      const moves = base.moves.map((m) => ({ ...m }));
      if (analysis.vision) fuse(moves, analysis.vision.frames);
      analysis2 = { ...base, moves, tracks: analysis.tracks, annotations: analysis.annotations, vision: analysis.vision } as Analysis;
      await db.saveAnalysis(id, analysis2);
      set({ importing: null });
    }
    const cur: Current = { meta, url: URL.createObjectURL(file), file, analysis: analysis2, liveFrames: (analysis2.vision?.frames ?? []) as VisionFrame[] };
    set({ current: cur, practice: { transitionId: null, looping: false, rate: 1, lead: 8 } });
    if (!analysis2.vision) { set({ importing: { name: meta.name, progress: [] } }); startVision(cur); }
  },

  close() {
    visionRun?.cancel();
    const prev = get().current;
    if (prev) URL.revokeObjectURL(prev.url);
    set({ current: null, importing: null });
  },

  async remove(id) {
    await db.deleteSet(id);
    await get().refreshLibrary();
  },

  setFilter: (filter) => set({ filter }),
  setZoom: (zoom) => set({ zoom: Math.max(8, Math.min(600, zoom)) }),
  setMode: (mode) => set({ mode }),

  addAnnotation(t, text) {
    const c = get().current;
    if (!c) return;
    const a: Annotation = { id: crypto.randomUUID(), t, text };
    const analysis = { ...c.analysis, annotations: [...c.analysis.annotations, a].sort((x, y) => x.t - y.t) };
    set({ current: { ...c, analysis } });
    void persistCurrent();
  },

  setTracks(tracks) {
    const c = get().current;
    if (!c) return;
    set({ current: { ...c, analysis: { ...c.analysis, tracks } } });
    void persistCurrent();
  },
}));
