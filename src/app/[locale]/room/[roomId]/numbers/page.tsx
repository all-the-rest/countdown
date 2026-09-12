"use client";
import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { PeerManager, PeerMessage } from "@/lib/webrtc/peer";
import { useMultiplayerRound } from "@/lib/webrtc/useMultiplayerRound";
import {
  solveNumbers,
  type NumbersSolution,
  type NumbersTileResult,
} from "@/lib/game/numbers";
import { keepBestSubmission, calculateNumbersScore, mergeScores } from "@/lib/game/scoring";
import { readScores, writeScores, readRound } from "@/lib/scoreboard";
import { NumberDrawer } from "@/components/NumberDrawer";
import { NumberPlayInteractive } from "@/components/NumberPlayInteractive";
import { ScorePanel } from "@/components/ScorePanel";

type PlayerSubmission = {
  peerId: string;
  nickname: string;
  result: number | null;
  diff: number;
  submittedAt: number;
};

type GamePhase = "drawing" | "playing" | "scoring" | "finished";

type Op = "+" | "-" | "\u00d7" | "\u00f7";

const T = {
  "en-GB": {
    errPositiveSub: "Subtraction must produce a positive result",
    errExactDiv: "Division must be exact",
    errPositiveResult: "Result must be positive",
    offByTry: "Off by {diff} \u2014 try again!",
  },
  "en-US": {
    errPositiveSub: "Subtraction must produce a positive result",
    errExactDiv: "Division must be exact",
    errPositiveResult: "Result must be positive",
    offByTry: "Off by {diff} \u2014 try again!",
  },
  de: {
    errPositiveSub: "Subtraktion muss positives Ergebnis liefern",
    errExactDiv: "Division muss ganzzahlig sein",
    errPositiveResult: "Ergebnis muss positiv sein",
    offByTry: "Differenz {diff} \u2014 nochmal versuchen!",
  },
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export default function MultiplayerNumbersPage() {
  const params = useParams();
  const locale = (params.locale as string) ?? "en-GB";
  const roomId = params.roomId as string;
  const storedTimer =
    typeof sessionStorage !== "undefined"
      ? parseInt(sessionStorage.getItem(`timer_${roomId}`) ?? "30", 10)
      : 30;
  const timerDuration = Math.max(0, storedTimer);
  const t = T[locale as keyof typeof T] ?? T["en-GB"];

  const [phase, setPhase] = useState<GamePhase>("drawing");
  const [timeRemaining, setTimeRemaining] = useState(timerDuration || 30);
  const [tiles, setTiles] = useState<number[]>([]);
  const [target, setTarget] = useState(0);
  const [submissions, setSubmissions] = useState<PlayerSubmission[]>([]);
  const [solution, setSolution] = useState<NumbersSolution | null>(null);
  const [scoringStarted, setScoringStarted] = useState(false);

  const [results, setResults] = useState<NumbersTileResult[]>([]);
  const [usedIndices, setUsedIndices] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number[]>([]);
  const [pendingOp, setPendingOp] = useState<Op | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [bestAttempt, setBestAttempt] = useState<{ result: number; diff: number } | null>(null);
  const [nextId, setNextId] = useState(1);
  const [mySubmission, setMySubmission] = useState<PlayerSubmission | null>(null);

  const phaseRef = useRef<GamePhase>("drawing");

  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tilesRef = useRef<number[]>([]);
  const targetRef = useRef(0);
  const submissionsRef = useRef<Map<string, PlayerSubmission>>(new Map());
  const allTilesRef = useRef<number[]>([25, 50, 75, 100]);
  const [largeRemaining, setLargeRemaining] = useState(4);
  const smallRef = useRef<number[]>([
    1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
  ]);
  const [smallRemaining, setSmallRemaining] = useState(20);
  const isHostRef = useRef(false);
  const playerCountRef = useRef(1);
  const myPeerIdRef = useRef<string | null>(null);
  const myNicknameRef = useRef<string>("");
  const setIsHostFnRef = useRef<(v: boolean) => void>(() => {});
  const setHostNameFnRef = useRef<(v: string) => void>(() => {});

  const realHandlerRef = useRef<(msg: PeerMessage, peer: PeerManager) => void>(() => {});

  const { peerRef, isHost, setIsHost, myPeerId, myNickname, hostName, setHostName, error } =
    useMultiplayerRound({
      roomId,
      onMessage: (msg, peer) => realHandlerRef.current(msg, peer),
      onPeerJoin: () => {
        if (isHostRef.current && tilesRef.current.length >= 6 && phaseRef.current === "playing") {
          peerRef.current?.broadcast({
            type: "num-tiles-complete",
            payload: { tiles: tilesRef.current, target: targetRef.current },
          });
        }
      },
      onReady: (round) => {
        playerCountRef.current = round.players.length;
      },
    });

  useEffect(() => { isHostRef.current = isHost; }, [isHost]);
  useEffect(() => { myPeerIdRef.current = myPeerId; }, [myPeerId]);
  useEffect(() => { myNicknameRef.current = myNickname; }, [myNickname]);
  useEffect(() => { setIsHostFnRef.current = setIsHost; }, [setIsHost]);
  useEffect(() => { setHostNameFnRef.current = setHostName; }, [setHostName]);

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // Stable unmount cleanup (see letters page): do not depend on compiler
  // memoization of `stopTimer`.
  const stopTimerRef = useRef(stopTimer);
  useEffect(() => { stopTimerRef.current = stopTimer; }, [stopTimer]);

  const endRound = (peer: PeerManager | null) => {
    const p = peer ?? peerRef.current;
    if (!p) return;
    stopTimer();
    setScoringStarted(true);
    const all = Array.from(submissionsRef.current.values());
    const sorted = [...all].sort((a, b) => a.diff - b.diff || a.submittedAt - b.submittedAt);
    setSubmissions(sorted);

    if (isHostRef.current) {
      const sol = solveNumbers(tilesRef.current, targetRef.current);
      setSolution(sol);
      p.broadcast({ type: "num-results", payload: { submissions: sorted, solution: sol } });

      const round = calculateNumbersScore(
        sorted.map((s) => ({ peerId: s.peerId, diff: s.diff })),
      );
      const merged = mergeScores(readScores(roomId), round);
      writeScores(roomId, merged);
      p.broadcast({ type: "scores-update", payload: merged });
    }

    setPhase("finished");
  };

  const startTimer = (peer: PeerManager) => {
    stopTimer();
    setTimeRemaining(timerDuration);
    if (timerDuration <= 0) return;
    timerRef.current = setInterval(() => {
      setTimeRemaining((prev) => {
        const next = prev - 1;
        if (next <= 0) {
          stopTimer();
          if (peerRef.current) endRound(peerRef.current);
          return 0;
        }
        if (isHostRef.current) peer.broadcast({ type: "timer-sync", payload: next });
        return next;
      });
    }, 1000);
  };

  const submitResult = (value: number, diff: number) => {
    const peer = peerRef.current;
    if (!peer) return;

    const pid = myPeerIdRef.current ?? "";
    const nick = myNicknameRef.current;
    const sub: PlayerSubmission = {
      peerId: pid,
      nickname: nick,
      result: value,
      diff,
      submittedAt: Date.now(),
    };

    setMySubmission(sub);
    setScoringStarted(true);

    if (isHostRef.current) {
      const best = keepBestSubmission(submissionsRef.current, sub);
      peer.broadcast({ type: "num-submitted", payload: best });
      const all = Array.from(submissionsRef.current.values());
      setSubmissions(all);

      if (timerDuration <= 0) {
        const uniquePlayers = all
          .map((s) => s.peerId)
          .filter((id, i, arr) => arr.indexOf(id) === i);
        if (diff === 0 || uniquePlayers.length >= playerCountRef.current) {
          endRound(peer);
        }
      }
    } else {
      peer.broadcast({ type: "num-submitted", payload: sub });
    }
  };

  const handleFinish = () => {
    if (results.length === 0) return;
    const lastValue = results[results.length - 1].value;
    const diff = Math.abs(lastValue - target);
    if (diff === 0) {
      submitResult(lastValue, 0);
    } else {
      const currentBest =
        bestAttempt && bestAttempt.diff < diff ? bestAttempt : { result: lastValue, diff };
      setBestAttempt(currentBest);
      if (!bestAttempt) {
        setFeedback(t.offByTry.replace("{diff}", String(diff)));
      }
      submitResult(lastValue, diff);
    }
  };

  const handleGiveUp = () => {
    if (!bestAttempt) return;
    submitResult(bestAttempt.result, bestAttempt.diff);
  };

  const selectNumber = (index: number) => {
    if (phase !== "playing") return;
    if (usedIndices.has(index)) return;
    const allNumbers = [...tiles, ...results.map((r) => r.value)];
    setFeedback(null);

    if (pendingOp) {
      const aIdx = selected[0];
      const bIdx = index;
      const a = allNumbers[aIdx];
      const b = allNumbers[bIdx];
      const op = pendingOp;
      let result: number | null = null;

      switch (op) {
        case "+":
          result = a + b;
          break;
        case "-":
          if (a <= b) {
            setFeedback(t.errPositiveSub);
            setSelected([]);
            setPendingOp(null);
            return;
          }
          result = a - b;
          break;
        case "\u00d7":
          result = a * b;
          break;
        case "\u00f7":
          if (b === 0 || a % b !== 0) {
            setFeedback(t.errExactDiv);
            setSelected([]);
            setPendingOp(null);
            return;
          }
          result = a / b;
          break;
      }

      if (result === null || result <= 0) {
        setFeedback(t.errPositiveResult);
        setSelected([]);
        setPendingOp(null);
        return;
      }

      setUsedIndices((prev) => new Set([...prev, aIdx, bIdx]));
      setResults((prev) => [
        ...prev,
        { id: nextId, value: result, a, b, op, aIdx, bIdx },
      ]);
      setNextId((n) => n + 1);
      setSelected([]);
      setPendingOp(null);

      if (result === target) {
        // `setResults` above has not committed yet, so `handleFinish` would read
        // the previous step. Submit the just-computed exact result directly.
        submitResult(result, 0);
      }
    } else {
      setSelected([index]);
      setPendingOp(null);
    }
  };

  const selectOp = (op: string) => {
    if (phase !== "playing") return;
    if (selected.length !== 1) return;
    setPendingOp(op as Op);
    setFeedback(null);
  };

  const handleUndo = () => {
    if (results.length === 0) return;
    const remaining = results.slice(0, -1);
    setResults(remaining);
    const newUsed = new Set<number>();
    for (const r of remaining) {
      newUsed.add(r.aIdx);
      newUsed.add(r.bIdx);
    }
    setUsedIndices(newUsed);
    setSelected([]);
    setPendingOp(null);
    setFeedback(null);
  };

  const handleResetAll = () => {
    setResults([]);
    setUsedIndices(new Set());
    setSelected([]);
    setPendingOp(null);
    setFeedback(null);
  };

  const completeTiles = () => {
    const t = Math.floor(Math.random() * 899) + 101;
    targetRef.current = t;
    setTarget(t);
    setPhase("playing");
    setResults([]);
    setUsedIndices(new Set());
    setSelected([]);
    setPendingOp(null);
    setFeedback(null);
    setBestAttempt(null);
    setNextId(1);
    setMySubmission(null);
    setSubmissions([]);
    submissionsRef.current = new Map();
    setScoringStarted(false);
    setSolution(null);
    if (peerRef.current) {
      peerRef.current.broadcast({
        type: "num-tiles-complete",
        payload: { tiles: tilesRef.current, target: t },
      });
      if (timerDuration > 0) startTimer(peerRef.current);
    }
  };

  const drawLarge = () => {
    if (!isHost || tilesRef.current.length >= 6 || allTilesRef.current.length === 0) return;
    const bigs = allTilesRef.current;
    const idx = Math.floor(Math.random() * bigs.length);
    const val = bigs[idx];
    allTilesRef.current = bigs.filter((_, i) => i !== idx);
    setLargeRemaining(allTilesRef.current.length);
    const newTiles = [...tilesRef.current, val];
    tilesRef.current = newTiles;
    setTiles(newTiles);
    if (newTiles.length >= 6) completeTiles();
  };

  const drawSmall = () => {
    if (!isHost || tilesRef.current.length >= 6 || smallRef.current.length === 0) return;
    const smalls = smallRef.current;
    const idx = Math.floor(Math.random() * smalls.length);
    const val = smalls[idx];
    smallRef.current = smalls.filter((_, i) => i !== idx);
    setSmallRemaining(smallRef.current.length);
    const newTiles = [...tilesRef.current, val];
    tilesRef.current = newTiles;
    setTiles(newTiles);
    if (newTiles.length >= 6) completeTiles();
  };

  const handleMessage = (msg: PeerMessage, peer: PeerManager) => {
    switch (msg.type) {
      case "player-list": {
        const list = msg.payload as Array<{
          peerId: string;
          joinedAt: number;
          nickname: string;
        }>;
        playerCountRef.current = list.length;
        const hostId =
          list.length > 0
            ? list.reduce((a, p) => (p.joinedAt < a.joinedAt ? p : a)).peerId
            : null;
        setIsHostFnRef.current(hostId === peer.peerId);
        const h = list.find((p) => p.peerId === hostId);
        if (h) setHostNameFnRef.current(h.nickname);
        break;
      }
      case "num-tiles-complete": {
        const data = msg.payload as { tiles: number[]; target: number };
        tilesRef.current = data.tiles;
        targetRef.current = data.target;
        setTiles(data.tiles);
        setTarget(data.target);
        setPhase("playing");
        setResults([]);
        setUsedIndices(new Set());
        setSelected([]);
        setPendingOp(null);
        setFeedback(null);
        setBestAttempt(null);
        setNextId(1);
        setMySubmission(null);
        setSubmissions([]);
        submissionsRef.current = new Map();
        setScoringStarted(false);
        setSolution(null);
        if (timerDuration > 0) startTimer(peer);
        break;
      }
      case "timer-sync": {
        setTimeRemaining(msg.payload as number);
        break;
      }
      case "num-submitted": {
        const sub = msg.payload as PlayerSubmission;
        keepBestSubmission(submissionsRef.current, sub);
        const all = Array.from(submissionsRef.current.values());
        setSubmissions(all);

        if (isHostRef.current && timerDuration <= 0) {
          const uniquePlayers = all
            .map((s) => s.peerId)
            .filter((id, i, arr) => arr.indexOf(id) === i);
          if (sub.diff === 0 || uniquePlayers.length >= playerCountRef.current) {
            endRound(peer);
          }
        }
        if (sub.peerId === myPeerIdRef.current) {
          setScoringStarted(true);
          setMySubmission(sub);
        }
        break;
      }
      case "num-results": {
        stopTimer();
        const r = msg.payload as {
          submissions: PlayerSubmission[];
          solution: NumbersSolution | null;
        };
        setSubmissions(r.submissions);
        setSolution(r.solution);
        setPhase("finished");
        setScoringStarted(true);
        break;
      }
      case "scores-update": {
        const s = msg.payload as Record<string, number>;
        writeScores(roomId, s);
        break;
      }
    }
  };

  useEffect(() => {
    realHandlerRef.current = handleMessage;
  }, [handleMessage]);

  useEffect(() => () => stopTimerRef.current(), []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="card bg-error/20 text-error-content max-w-md w-full">
          <div className="card-body items-center text-center">
            <h2 className="card-title text-error">Connection Error</h2>
            <p>{error}</p>
            <Link href={`/${locale}/room/${roomId}`} className="btn btn-primary mt-4">
              Back to Lobby
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const leaderboard = [...submissions].sort(
    (a, b) => a.diff - b.diff || a.submittedAt - b.submittedAt,
  );

  return (
    <div className="flex min-h-screen flex-col p-4">
      <div className="navbar mb-4">
        <div className="flex-1">
          <Link href={`/${locale}/room/${roomId}`} className="btn btn-ghost btn-sm">
            &larr; Lobby
          </Link>
        </div>
        <div className="flex-none">
          <h1 className="text-lg sm:text-xl font-bold text-warning">Numbers Round</h1>
          {readRound(roomId) > 0 && (
            <span className="badge badge-secondary badge-sm ml-3">
              Round {readRound(roomId)}
            </span>
          )}
        </div>
        <div className="flex-1" />
      </div>

      <div className="flex flex-col lg:flex-row gap-4 sm:gap-6 flex-1 justify-center">
        <div className="flex flex-col items-center gap-6 flex-1 max-w-lg mx-auto">
          {phase === "drawing" && (
            <NumberDrawer
              locale={locale}
              tiles={tiles}
              isHost={isHost}
              onPickLarge={drawLarge}
              onPickSmall={drawSmall}
              canPickLarge={tiles.length < 6 && largeRemaining > 0}
              canPickSmall={tiles.length < 6 && smallRemaining > 0}
              largeRemaining={largeRemaining}
              smallRemaining={smallRemaining}
              hostName={hostName}
            />
          )}

          {(phase === "playing" || phase === "scoring" || phase === "finished") && (
            <>
              {(phase === "playing" || (phase === "scoring" && !mySubmission)) && (
                <NumberPlayInteractive
                  locale={locale}
                  tiles={tiles}
                  target={target}
                  results={results}
                  usedIndices={usedIndices}
                  selected={selected}
                  pendingOp={pendingOp}
                  feedback={feedback}
                  bestAttempt={bestAttempt}
                  onSelectNumber={selectNumber}
                  onSelectOp={selectOp}
                  onUndo={handleUndo}
                  onResetAll={handleResetAll}
                  onFinish={handleFinish}
                  onGiveUp={handleGiveUp}
                  steps={results}
                />
              )}

              {(phase === "playing" || (phase === "scoring" && mySubmission)) &&
                timerDuration > 0 && (
                  <div
                    className="radial-progress timer-radial text-warning"
                    style={
                      {
                        "--value": (timeRemaining / timerDuration) * 100,
                      } as React.CSSProperties
                    }
                  >
                    <span className="text-lg sm:text-xl font-bold">{timeRemaining}</span>
                  </div>
                )}

              {timerDuration <= 0 && !scoringStarted && (
                <p className="text-sm text-base-content/50">
                  No timer &mdash; round ends when all players submit or someone hits the target
                </p>
              )}

              {phase === "scoring" && scoringStarted && (
                <div className="card bg-base-200 w-full max-w-md">
                  <div className="card-body items-center">
                    <div className="text-success text-lg font-bold">Submitted!</div>
                    <p className="text-base-content/60">Waiting for round to end...</p>
                    <span className="loading loading-dots loading-md" />
                  </div>
                </div>
              )}

              {phase === "finished" && solution && (
                <div className="card bg-base-200 w-full max-w-md">
                  <div className="card-body items-center gap-3 p-4">
                    <span className="text-xs uppercase tracking-[0.2em] text-base-content/40">
                      Best solution
                    </span>
                    {solution.steps.length > 0 ? (
                      <div className="space-y-1 w-full">
                        {solution.steps.map((step, i) => (
                          <div
                            key={i}
                            className="font-mono text-sm tabular-nums text-base-content/70 text-center"
                          >
                            {step.a} <span className="text-warning">{step.operator}</span> {step.b}{" "}
                            = {step.result}
                          </div>
                        ))}
                        <div className="border-t border-base-content/15 pt-2 text-center">
                          <span className="text-xl font-bold text-warning">
                            {solution.result}
                          </span>
                          {!solution.exact && (
                            <span className="text-sm text-base-content/50 ml-2">
                              (off by {solution.difference})
                            </span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="text-base-content/50">No solution found</p>
                    )}
                  </div>
                </div>
              )}

              {phase === "finished" && !solution && (
                <div className="card bg-base-200 w-full max-w-md">
                  <div className="card-body items-center">
                    <p className="text-base-content/50">Round finished</p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="w-full max-w-xs lg:max-w-sm">
          <div className="card bg-base-200 sticky top-4">
            <div className="card-body p-4">
              <h2 className="card-title text-sm">
                Leaderboard
                <span className="badge badge-sm">{leaderboard.length}</span>
              </h2>
              <div className="divider my-1" />

              {leaderboard.length === 0 ? (
                <p className="text-base-content/40 text-sm text-center py-4">
                  No submissions yet
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {leaderboard.map((s, i) => (
                    <div
                      key={s.peerId}
                      className={`flex items-center gap-2 p-2 rounded-btn text-sm ${
                        i === 0 && s.result !== null ? "bg-warning/20" : "bg-base-300"
                      }`}
                    >
                      <span className="font-bold text-warning w-5 text-right">{i + 1}.</span>
                      <span className="flex-1 truncate">{s.nickname}</span>
                      <span className="font-mono font-bold tabular-nums">
                        {s.result !== null ? s.result : "\u2014"}
                      </span>
                      <span
                        className={`text-xs font-bold tabular-nums ${s.diff === 0 ? "text-success" : "text-base-content/50"}`}
                      >
                        {s.diff === 0 ? "=0" : `+${s.diff}`}
                      </span>
                      <span className="text-xs text-base-content/30 tabular-nums w-12 text-right">
                        {formatTime(s.submittedAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {phase === "finished" && (
                <>
                  <div className="divider my-1" />
                  <Link
                    href={`/${locale}/room/${roomId}`}
                    className="btn btn-warning btn-sm w-full"
                  >
                    Back to Lobby
                  </Link>
                </>
              )}
            </div>
          </div>

          <ScorePanel roomId={roomId} myPeerId={myPeerId} />
        </div>
      </div>
    </div>
  );
}
