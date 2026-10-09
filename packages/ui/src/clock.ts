// One rAF loop drives every time-synced surface. Nothing per-frame goes through React.
import { useEffect, useRef } from "react";

type FrameFn = (t: number, playing: boolean) => void;
const subs = new Set<FrameFn>();
let video: HTMLVideoElement | null = null;
let raf = 0;
/** Practice loop: when set, playback wraps from t1 back to t0. */
let loop: { t0: number; t1: number } | null = null;

function tick() {
  if (video && loop && !video.paused && video.currentTime >= loop.t1) video.currentTime = loop.t0;
  const t = video?.currentTime ?? 0;
  const playing = !!video && !video.paused;
  for (const fn of subs) fn(t, playing);
  raf = requestAnimationFrame(tick);
}

export const clock = {
  attach(v: HTMLVideoElement | null) {
    video = v;
    if (!raf) raf = requestAnimationFrame(tick);
  },
  get video() { return video; },
  get time() { return video?.currentTime ?? 0; },
  seek(t: number, play?: boolean) {
    if (!video) return;
    video.currentTime = Math.max(0, Math.min((video.duration || t + 1) - 0.05, t));
    if (play) void video.play();
  },
  setLoop(l: { t0: number; t1: number } | null) { loop = l; },
  get loop() { return loop; },
  setRate(r: number) { if (video) { video.preservesPitch = true; video.playbackRate = r; } },
  toggle() { if (video) video.paused ? void video.play() : video.pause(); },
  play() { void video?.play(); },
  pause() { video?.pause(); },
};

/** Run `fn` every animation frame with the playhead. Latest closure wins without resubscribing. */
export function useFrame(fn: FrameFn) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const sub: FrameFn = (t, p) => ref.current(t, p);
    subs.add(sub);
    return () => { subs.delete(sub); };
  }, []);
}
