// Ear training: hear a real move from the set with the picture and answers hidden,
// name it, then see it. The pool is the set's own detected moves.
import { useEffect, useMemo, useRef, useState } from "react";
import { moveDetail, type Analysis, type Move } from "@cueprint/core";
import { clock, useFrame } from "../clock.ts";

export type Answer = "Bass cut" | "Highs cut" | "High-pass sweep" | "Low-pass sweep";
const ANSWERS: readonly Answer[] = ["Bass cut", "Highs cut", "High-pass sweep", "Low-pass sweep"];

export function answerFor(m: Move): Answer | null {
  if (m.kind === "eq") return m.band === "low" || m.band === "lowmid" ? "Bass cut" : "Highs cut";
  if (m.kind === "filter") return m.filter === "HPF" ? "High-pass sweep" : "Low-pass sweep";
  return null;
}

const LEAD = 6, TAIL = 1.2;
type Phase = "ready" | "listening" | "asking" | "revealed";

interface Score { attempts: number; correct: number; streak: number; best: number; byAnswer: Record<string, [number, number]> }
const KEY = "cueprint.drill.v1";
function loadScore(): Score {
  try { const s = JSON.parse(localStorage.getItem(KEY) ?? ""); if (s && typeof s.attempts === "number") return s; } catch { /* fresh */ }
  return { attempts: 0, correct: 0, streak: 0, best: 0, byAnswer: {} };
}

export function useDrill(analysis: Analysis) {
  const pool = useMemo(() => {
    // prefer moves the camera backs up, then confident audio-only ones; skip overlapping duplicates
    const xs = analysis.moves.filter((m) => answerFor(m) && m.confidence >= 0.4)
      .sort((a, b) => a.t0 - b.t0)
      .filter((m, i, arr) => i === 0 || m.t0 - arr[i - 1].t0 > 4);
    return xs;
  }, [analysis.moves]);
  const [phase, setPhase] = useState<Phase>("ready");
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState<Answer | null>(null);
  const [score, setScore] = useState<Score>(loadScore);
  const m = pool[i % Math.max(1, pool.length)];

  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(score)); } catch { /* private mode */ } }, [score]);

  const start = (idx = i) => {
    const mv = pool[idx % pool.length];
    if (!mv) return;
    setPicked(null);
    setPhase("listening");
    clock.seek(Math.max(0, mv.t0 - LEAD), true);
  };

  useFrame((t) => {
    if (phase === "listening" && m && t >= Math.max(m.t1, m.t0 + 2) + TAIL) {
      clock.pause();
      setPhase("asking");
    }
  });

  const answer = (a: Answer) => {
    if (!m || phase !== "asking") return;
    const right = answerFor(m) === a;
    const key = answerFor(m)!;
    setPicked(a);
    setScore((s) => {
      const [n, c] = s.byAnswer[key] ?? [0, 0];
      const streak = right ? s.streak + 1 : 0;
      return { attempts: s.attempts + 1, correct: s.correct + (right ? 1 : 0), streak, best: Math.max(s.best, streak),
        byAnswer: { ...s.byAnswer, [key]: [n + 1, c + (right ? 1 : 0)] } };
    });
    setPhase("revealed");
    clock.seek(Math.max(0, m.t0 - 2), true);
  };

  const next = () => { const n = (i + 1) % pool.length; setI(n); start(n); };
  return { pool, phase, move: m, picked, score, start, answer, next, hidden: phase === "listening" || phase === "asking" };
}

export function DrillOverlay({ drill }: { drill: ReturnType<typeof useDrill> }) {
  const { pool, phase, move, picked, score, start, answer, next } = drill;
  const countdown = useRef<HTMLSpanElement>(null);
  useFrame((t) => {
    if (phase === "listening" && move && countdown.current) {
      const left = move.t0 - t;
      countdown.current.textContent = left > 0 ? `${left.toFixed(1)}s` : "listen…";
    }
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase === "asking" && /^[1-4]$/.test(e.key)) answer(ANSWERS[Number(e.key) - 1]);
      else if (phase === "revealed" && e.key === "Enter") next();
      else if (phase === "ready" && e.key === "Enter") start();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  if (!pool.length) return <div className="drill"><div className="drill-card"><h3>No drillable moves</h3><p>This set has no confident EQ or filter moves yet.</p></div></div>;
  const truth = move ? answerFor(move) : null;
  const pct = score.attempts ? Math.round((score.correct / score.attempts) * 100) : 0;

  return (
    <div className="drill" data-phase={phase}>
      <div className="drill-score">
        <span><b>{score.correct}</b>/{score.attempts} · {pct}%</span>
        <span>streak <b>{score.streak}</b></span>
        <span>best <b>{score.best}</b></span>
      </div>
      {phase === "ready" && (
        <div className="drill-card">
          <div className="eyebrow">Ear training · {pool.length} real moves from this set</div>
          <h3>Name the move by ear</h3>
          <p>The picture goes dark. You'll hear about 8 seconds, and somewhere in there the DJ does one thing. Call it, then watch what really happened.</p>
          <button className="btn primary" onClick={() => start()}>Start <kbd>↵</kbd></button>
        </div>
      )}
      {phase === "listening" && (
        <div className="drill-listen">
          <div className="pulse" />
          <div className="eyebrow">Listening</div>
          <span className="drill-count" ref={countdown} />
        </div>
      )}
      {phase === "asking" && (
        <div className="drill-card">
          <div className="eyebrow">What did the DJ do?</div>
          <div className="answers">
            {ANSWERS.map((a, k) => <button key={a} className="answer" onClick={() => answer(a)}><kbd>{k + 1}</kbd>{a}</button>)}
          </div>
          <button className="btn ghost" onClick={() => start()}>Hear it again</button>
        </div>
      )}
      {phase === "revealed" && move && (
        <div className="drill-card reveal" data-right={picked === truth}>
          <div className="eyebrow">{picked === truth ? "Correct" : `You said ${picked}`}</div>
          <h3>{truth}</h3>
          <p>{moveDetail(move)}{move.verdict === "hand moving" ? ` · on camera, ${move.zone}` : move.verdict === "hands still" ? " · hands looked still: could be the track's own arrangement" : ""}</p>
          <div className="row-actions">
            <button className="btn ghost" onClick={() => clock.seek(Math.max(0, move.t0 - 2), true)}>Replay</button>
            <button className="btn primary" onClick={next}>Next <kbd>↵</kbd></button>
          </div>
        </div>
      )}
    </div>
  );
}
