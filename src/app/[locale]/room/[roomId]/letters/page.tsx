"use client";
import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { PeerManager, PeerMessage } from "@/lib/webrtc/peer";
import { useMultiplayerRound } from "@/lib/webrtc/useMultiplayerRound";
import { LettersGame } from "@/components/LettersGame";
import { ScorePanel } from "@/components/ScorePanel";
import {
  createLettersGame,
  addVowel,
  addConsonant,
  canFormWord,
  shuffleTiles,
  resetTiles,
  type LetterTile,
} from "@/lib/game/letters";
import { keepBestSubmission, calculateLettersScore, mergeScores } from "@/lib/game/scoring";
import { readScores, writeScores, readRound } from "@/lib/scoreboard";

const TILES = 9;

type WordSubmission = {
  peerId: string;
  word: string;
  valid: boolean;
  length: number;
  nickname: string;
  submittedAt: number;
};

type GamePhase = "drawing" | "playing" | "submitted" | "scoring" | "finished";

export default function MultiplayerLettersPage() {
  const params = useParams();
  const locale = params.locale as string;
  const roomId = params.roomId as string;
  const storedTimer =
    typeof sessionStorage !== "undefined"
      ? parseInt(sessionStorage.getItem(`timer_${roomId}`) ?? "30", 10)
      : 30;
  const timerDuration = Math.max(0, storedTimer);

  const [phase, setPhase] = useState<GamePhase>("drawing");
  const [timeRemaining, setTimeRemaining] = useState(timerDuration || 30);
  const [tiles, setTiles] = useState<LetterTile[]>([]);
  const [playerWord, setPlayerWord] = useState("");
  const [submissions, setSubmissions] = useState<WordSubmission[]>([]);
  const [wordError, setWordError] = useState<string | null>(null);
  const [winner, setWinner] = useState<WordSubmission | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tilesRef = useRef<LetterTile[]>([]);
  const submissionsRef = useRef<Map<string, WordSubmission>>(new Map());
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

  // Keep the unmount cleanup stable without relying on compiler memoization:
  // a render-scoped `stopTimer` in the dep array would otherwise clear the
  // running interval on every render if the compiler is inactive.
  const stopTimerRef = useRef(stopTimer);
  useEffect(() => { stopTimerRef.current = stopTimer; }, [stopTimer]);

  const endRound = (peer: PeerManager) => {
    stopTimer();
    setPhase("scoring");
    const all = Array.from(submissionsRef.current.values());
    const validated = all.map((s) => ({
      ...s,
      valid: canFormWord(tilesRef.current, s.word),
      length: canFormWord(tilesRef.current, s.word) ? s.word.length : 0,
    }));
    const sorted = [...validated].sort(
      (a, b) => b.length - a.length || a.submittedAt - b.submittedAt,
    );
    const w = sorted.length > 0 && sorted[0].length > 0 ? sorted[0] : null;

    if (isHostRef.current) {
      const round = calculateLettersScore(
        sorted.map((s) => ({ peerId: s.peerId, valid: s.length > 0, length: s.length })),
      );
      const merged = mergeScores(readScores(roomId), round);
      writeScores(roomId, merged);
      peer.broadcast({ type: "scores-update", payload: merged });
    }

    peer.broadcast({ type: "round-results", payload: { submissions: sorted, winner: w } });
    setSubmissions(sorted);
    setWinner(w);
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

  useEffect(() => () => stopTimerRef.current(), []);

  function submitWord() {
    const word = playerWord.trim().toUpperCase();
    if (!word) { setWordError("Enter a word"); return; }
    if (!canFormWord(tiles, word)) { setWordError("Cannot form from tiles"); return; }

    setWordError(null);
    setPhase("submitted");

    const pid = myPeerIdRef.current ?? "";
    const nick = myNicknameRef.current;
    const sub: WordSubmission = {
      peerId: pid,
      word,
      valid: true,
      length: word.length,
      nickname: nick,
      submittedAt: Date.now(),
    };
    keepBestSubmission(submissionsRef.current, sub);
    setSubmissions(Array.from(submissionsRef.current.values()));

    if (peerRef.current) {
      peerRef.current.broadcast({ type: "word-submitted", payload: sub });

      if (isHostRef.current && timerDuration <= 0) {
        const all = Array.from(submissionsRef.current.values());
        const uniquePlayers = all
          .map((s) => s.peerId)
          .filter((id, i, arr) => arr.indexOf(id) === i);
        if (uniquePlayers.length >= playerCountRef.current) {
          endRound(peerRef.current);
        }
      }
    }
  }

  function drawTile(type: "vowel" | "consonant") {
    const peer = peerRef.current;
    if (!peer || !isHost || tilesRef.current.length >= TILES) return;

    let g = createLettersGame();
    g = { ...g, tiles: tilesRef.current };
    g = type === "vowel" ? addVowel(g) : addConsonant(g);
    const newTile = g.tiles[g.tiles.length - 1];
    tilesRef.current = g.tiles;
    setTiles(g.tiles);

    if (tilesRef.current.length >= TILES) {
      peer.broadcast({ type: "tiles-complete", payload: g.tiles });
      setPhase("playing");
      startTimer(peer);
    } else {
      peer.broadcast({ type: "tile-drawn", payload: newTile });
    }
  }

  function shuffleTileOrder(peer: PeerManager) {
    if (!isHostRef.current || tilesRef.current.length === 0) return;
    const reordered = shuffleTiles(tilesRef.current);
    tilesRef.current = reordered;
    setTiles(reordered);
    peer.broadcast({ type: "tiles-order", payload: reordered });
  }

  function resetTileOrder(peer: PeerManager) {
    if (!isHostRef.current || tilesRef.current.length === 0) return;
    const reordered = resetTiles(tilesRef.current);
    tilesRef.current = reordered;
    setTiles(reordered);
    peer.broadcast({ type: "tiles-order", payload: reordered });
  }

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
            ? list.reduce((oldest, p) => (p.joinedAt < oldest.joinedAt ? p : oldest))
                .peerId
            : null;
        setIsHostFnRef.current(hostId === peer.peerId);
        const h = list.find((p) => p.peerId === hostId);
        if (h) setHostNameFnRef.current(h.nickname);
        break;
      }
      case "tile-drawn": {
        const tile = msg.payload as LetterTile;
        const newTiles = [...tilesRef.current, tile];
        tilesRef.current = newTiles;
        setTiles(newTiles);
        break;
      }
      case "tiles-complete": {
        const final = msg.payload as LetterTile[];
        tilesRef.current = final;
        setTiles(final);
        setPhase("playing");
        startTimer(peer);
        break;
      }
      case "tiles-order": {
        const reordered = msg.payload as LetterTile[];
        tilesRef.current = reordered;
        setTiles(reordered);
        break;
      }
      case "timer-sync": {
        setTimeRemaining(msg.payload as number);
        break;
      }
      case "word-submitted": {
        const sub = msg.payload as WordSubmission;
        keepBestSubmission(submissionsRef.current, sub);
        const all = Array.from(submissionsRef.current.values());
        setSubmissions(all);

        if (isHostRef.current && timerDuration <= 0) {
          const uniquePlayers = all
            .map((s) => s.peerId)
            .filter((id, i, arr) => arr.indexOf(id) === i);
          if (uniquePlayers.length >= playerCountRef.current) {
            endRound(peer);
          }
        }
        break;
      }
      case "round-results": {
        stopTimer();
        const r = msg.payload as {
          submissions: WordSubmission[];
          winner: WordSubmission | null;
        };
        setSubmissions(r.submissions);
        setWinner(r.winner);
        setPhase("finished");
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
    (a, b) => b.length - a.length || a.submittedAt - b.submittedAt,
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
          <h1 className="text-lg sm:text-xl font-bold text-primary">Letters Round</h1>
          {readRound(roomId) > 0 && (
            <span className="badge badge-secondary badge-sm ml-3">
              Round {readRound(roomId)}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 sm:gap-6 flex-1 justify-center">
        <div className="flex flex-col items-center gap-6 flex-1 max-w-lg mx-auto">
          <LettersGame
            locale={locale}
            tiles={tiles}
            usedIndices={new Set()}
            phase={phase}
            drawMode={isHost ? "host" : "spectator"}
            onDrawVowel={() => drawTile("vowel")}
            onDrawConsonant={() => drawTile("consonant")}
            canDrawVowel={tiles.length < TILES}
            canDrawConsonant={tiles.length < TILES}
            tilesDrawn={tiles.length}
            playerWord={playerWord}
            onPlayerWordChange={(word) => {
              setPlayerWord(word.toUpperCase().replace(/[^A-Z]/g, ""));
              setWordError(null);
            }}
            onSubmitWord={submitWord}
            wordError={wordError}
            timeRemaining={timeRemaining}
            timerDuration={timerDuration}
            showTimer={timerDuration > 0 && phase !== "finished"}
            submissions={submissions.map((s) => ({
              peerId: s.peerId,
              word: s.word,
              length: s.length,
              nickname: s.nickname,
              submittedAt: s.submittedAt,
            }))}
            winner={
              winner
                ? { nickname: winner.nickname, word: winner.word, length: winner.length }
                : null
            }
            hostName={hostName}
            onShuffle={() => peerRef.current && shuffleTileOrder(peerRef.current)}
            onReset={() => peerRef.current && resetTileOrder(peerRef.current)}
            canShuffle={isHost && tiles.length > 0}
          />
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
                <p className="text-base-content/50 text-sm text-center py-4">
                  No submissions yet
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {leaderboard.map((s, i) => (
                    <div
                      key={s.peerId}
                      className={`flex items-center gap-2 p-2 rounded-btn text-sm ${
                        i === 0 && s.length > 0 ? "bg-warning/20" : "bg-base-300"
                      }`}
                    >
                      <span className="font-bold text-warning w-5 text-right">{i + 1}.</span>
                      <span className="flex-1 truncate">{s.nickname}</span>
                      <span className="font-mono font-bold tabular-nums text-base-content/70">
                        {s.length > 0 ? s.length : "\u2014"}
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
                    className="btn btn-primary btn-sm w-full"
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

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
