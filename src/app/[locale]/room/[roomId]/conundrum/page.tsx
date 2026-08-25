"use client";
import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { PeerManager, PeerMessage } from "@/lib/webrtc/peer";
import { useMultiplayerRound } from "@/lib/webrtc/useMultiplayerRound";
import { ConundrumGame } from "@/components/ConundrumGame";
import { ScorePanel } from "@/components/ScorePanel";
import {
  checkSolution,
  getConundrumWord,
  scrambleWord,
  shuffleScrambled,
  resetScrambled,
  type ConundrumState,
} from "@/lib/game/conundrum";
import { calculateConundrumScore, mergeScores } from "@/lib/game/scoring";
import { readScores, writeScores, readRound } from "@/lib/scoreboard";

const BUZZER_TIMEOUT = 5;
const ROUND_TIMEOUT = 30;

type BuzzEntry = {
  peerId: string;
  timestamp: number;
  nickname: string;
};

type GamePhase =
  | "waiting"
  | "playing"
  | "buzzed"
  | "answering"
  | "solved"
  | "timeout";

export default function MultiplayerConundrumPage() {
  const params = useParams();
  const locale = params.locale as string;
  const roomId = params.roomId as string;

  const [phase, setPhase] = useState<GamePhase>("waiting");
  const [scrambled, setScrambled] = useState("");
  const [timeRemaining, setTimeRemaining] = useState(ROUND_TIMEOUT);
  const [buzzerName, setBuzzerName] = useState("");
  const [answerReveal, setAnswerReveal] = useState("");
  const [solvedByName, setSolvedByName] = useState("");
  const [guess, setGuess] = useState("");
  const [guessError, setGuessError] = useState<string | null>(null);
  const [hasBuzzed, setHasBuzzed] = useState(false);
  const [buzzerId, setBuzzerId] = useState<string | null>(null);
  const [rosterSize, setRosterSize] = useState(0);

  const roundTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const answerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answerRef = useRef("");
  const buzzerIdRef = useRef<string | null>(null);
  const buzzerNameRef = useRef("");
  const hasBuzzedRef = useRef(false);
  const originalScrambledRef = useRef("");
  const roundActiveRef = useRef(false);
  const phaseRef = useRef<GamePhase>("waiting");
  const isHostRef = useRef(false);
  const myPeerIdRef = useRef<string | null>(null);
  const myNicknameRef = useRef<string>("");
  const setIsHostFnRef = useRef<(v: boolean) => void>(() => {});
  const rosterRef = useRef<string[]>([]);

  const realHandlerRef = useRef<(msg: PeerMessage, peer: PeerManager) => void>(() => {});

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const { peerRef, isHost, setIsHost, myPeerId, myNickname, error } = useMultiplayerRound({
    roomId,
    onMessage: (msg, peer) => realHandlerRef.current(msg, peer),
    onReady: (round) => {
      if (round.isHost) startRound(round.peer);
    },
  });

  const clearAllTimers = () => {
    if (roundTimerRef.current) {
      clearInterval(roundTimerRef.current);
      roundTimerRef.current = null;
    }
    if (answerTimerRef.current) {
      clearTimeout(answerTimerRef.current);
      answerTimerRef.current = null;
    }
  };

  const stopRoundTimer = () => {
    if (roundTimerRef.current) {
      clearInterval(roundTimerRef.current);
      roundTimerRef.current = null;
    }
  };

  const startAnswerTimer = (peer: PeerManager) => {
    if (answerTimerRef.current) clearTimeout(answerTimerRef.current);

    answerTimerRef.current = setTimeout(() => {
      clearAllTimers();
      roundActiveRef.current = false;
      peer.broadcast({
        type: "conundrum-result",
        payload: {
          peerId: buzzerIdRef.current,
          guess: "",
          correct: false,
          nickname: buzzerNameRef.current,
          answer: answerRef.current,
        },
      });
    }, BUZZER_TIMEOUT * 1000);
  };

  const startRoundTimer = () => {
    clearAllTimers();
    setTimeRemaining(ROUND_TIMEOUT);

    const peer = peerRef.current;
    roundTimerRef.current = setInterval(() => {
      setTimeRemaining((prev) => {
        const next = prev - 1;
        if (next <= 0) {
          if (peer && isHostRef.current) {
            roundActiveRef.current = false;
            peer.broadcast({ type: "conundrum-timeout", payload: { answer: answerRef.current } });
          }
          clearAllTimers();
          return 0;
        }
        if (peer && isHostRef.current) {
          peer.broadcast({ type: "timer-sync", payload: next });
        }
        return next;
      });
    }, 1000);
  };

  const startRound = (peer: PeerManager) => {
    const word = getConundrumWord(locale);
    const scrambledWord = scrambleWord(word);

    answerRef.current = word;
    roundActiveRef.current = true;
    setBuzzerId(null);
    buzzerIdRef.current = null;
    setHasBuzzed(false);
    hasBuzzedRef.current = false;

    setScrambled(scrambledWord);
    originalScrambledRef.current = scrambledWord;
    setBuzzerName("");
    setAnswerReveal("");
    setSolvedByName("");
    setGuess("");
    setGuessError(null);
    setPhase("playing");
    startRoundTimer();

    peer.broadcast({
      type: "conundrum-start",
      payload: { scrambled: scrambledWord },
    });
  };

  const shuffleScramble = (peer: PeerManager) => {
    if (!isHostRef.current || !originalScrambledRef.current) return;
    const next = shuffleScrambled(scrambled);
    setScrambled(next);
    peer.broadcast({ type: "conundrum-shuffle", payload: { scrambled: next } });
  };

  const resetScramble = (peer: PeerManager) => {
    if (!isHostRef.current || !originalScrambledRef.current) return;
    const next = resetScrambled(originalScrambledRef.current);
    setScrambled(next);
    peer.broadcast({ type: "conundrum-shuffle", payload: { scrambled: next } });
  };

  const finalizeConundrum = (peer: PeerManager, winnerPeerId: string | null) => {
    if (!isHostRef.current) return;
    const round = calculateConundrumScore(winnerPeerId, rosterRef.current);
    const merged = mergeScores(readScores(roomId), round);
    writeScores(roomId, merged);
    peer.broadcast({ type: "scores-update", payload: merged });
  };

  const resolveConundrum = (
    peer: PeerManager,
    peerId: string,
    guessWord: string,
    nickname: string,
  ) => {
    const correct = checkSolution(
      { answer: answerRef.current } as ConundrumState,
      guessWord,
    );
    clearAllTimers();
    roundActiveRef.current = false;
    setAnswerReveal(answerRef.current);
    if (correct) {
      setSolvedByName(peerId === myPeerIdRef.current ? "you" : nickname);
      setPhase("solved");
    } else {
      setPhase("timeout");
    }
    peer.broadcast({
      type: "conundrum-result",
      payload: { peerId, guess: guessWord, correct, nickname, answer: answerRef.current },
    });
    finalizeConundrum(peer, correct ? peerId : null);
  };

  const handleMessage = (msg: PeerMessage, peer: PeerManager) => {
    switch (msg.type) {
      case "player-list": {
        const list = msg.payload as Array<{ peerId: string; joinedAt: number; nickname: string }>;
        rosterRef.current = list.map((p) => p.peerId);
        setRosterSize(list.length);
        const hostPeerId = list.length > 0
          ? list.reduce((oldest, p) => (p.joinedAt < oldest.joinedAt ? p : oldest)).peerId
          : null;
        setIsHostFnRef.current(hostPeerId === peer.peerId);
        if (phaseRef.current === "waiting" && hostPeerId === peer.peerId) {
          startRound(peer);
        }
        break;
      }
      case "conundrum-start": {
        const payload = msg.payload as { scrambled: string };
        setScrambled(payload.scrambled);
        originalScrambledRef.current = payload.scrambled;
        setBuzzerId(null);
        buzzerIdRef.current = null;
        setHasBuzzed(false);
        hasBuzzedRef.current = false;
        roundActiveRef.current = true;
        setBuzzerName("");
        setAnswerReveal("");
        setSolvedByName("");
        setGuess("");
        setGuessError(null);
        setPhase("playing");
        startRoundTimer();
        break;
      }
      case "conundrum-shuffle": {
        const payload = msg.payload as { scrambled: string };
        setScrambled(payload.scrambled);
        break;
      }
      case "buzz": {
        if (!roundActiveRef.current) return;
        const buzz = msg.payload as BuzzEntry;
        if (isHostRef.current && buzzerIdRef.current === null) {
          setBuzzerId(buzz.peerId);
          buzzerIdRef.current = buzz.peerId;
          setBuzzerName(buzz.nickname);
          buzzerNameRef.current = buzz.nickname;
          setPhase("buzzed");
          stopRoundTimer();
          peer.broadcast({
            type: "buzzer-granted",
            payload: { peerId: buzz.peerId, nickname: buzz.nickname },
          });
          startAnswerTimer(peer);
        }
        break;
      }
      case "buzzer-granted": {
        if (!roundActiveRef.current) return;
        const granted = msg.payload as { peerId: string; nickname: string };
        setBuzzerId(granted.peerId);
        buzzerIdRef.current = granted.peerId;
        setBuzzerName(granted.nickname);
        buzzerNameRef.current = granted.nickname;
        setPhase("buzzed");
        stopRoundTimer();
        if (granted.peerId === myPeerIdRef.current) {
          setPhase("answering");
          setTimeRemaining(BUZZER_TIMEOUT);
          startAnswerTimer(peer);
        }
        break;
      }
      case "conundrum-guess": {
        const guessPayload = msg.payload as { peerId: string; guess: string; nickname: string };
        if (!isHostRef.current) return;
        resolveConundrum(peer, guessPayload.peerId, guessPayload.guess, guessPayload.nickname);
        break;
      }
      case "conundrum-result": {
        clearAllTimers();
        roundActiveRef.current = false;
        const result = msg.payload as {
          peerId: string;
          guess: string;
          correct: boolean;
          nickname: string;
          answer: string;
        };
        setAnswerReveal(result.answer);
        if (result.correct) {
          setSolvedByName(result.peerId === myPeerIdRef.current ? "you" : result.nickname);
          setPhase("solved");
        } else {
          setPhase("timeout");
        }
        finalizeConundrum(peer, result.correct ? result.peerId : null);
        break;
      }
      case "conundrum-timeout": {
        clearAllTimers();
        roundActiveRef.current = false;
        setAnswerReveal((msg.payload as { answer: string }).answer);
        setPhase("timeout");
        finalizeConundrum(peer, null);
        break;
      }
      case "scores-update": {
        const s = msg.payload as Record<string, number>;
        writeScores(roomId, s);
        break;
      }
      case "timer-sync": {
        if (phaseRef.current === "playing") {
          setTimeRemaining(msg.payload as number);
        }
        break;
      }
    }
  };

  useEffect(() => {
    realHandlerRef.current = handleMessage;
  }, [handleMessage]);

  useEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);

  useEffect(() => { myPeerIdRef.current = myPeerId; }, [myPeerId]);
  useEffect(() => { myNicknameRef.current = myNickname; }, [myNickname]);
  useEffect(() => { setIsHostFnRef.current = setIsHost; }, [setIsHost]);
  useEffect(() => { buzzerNameRef.current = buzzerName; }, [buzzerName]);

  function buzz() {
    const peer = peerRef.current;
    if (!peer || !roundActiveRef.current || hasBuzzedRef.current) return;

    setHasBuzzed(true);
    hasBuzzedRef.current = true;

    const entry: BuzzEntry = {
      peerId: peer.peerId,
      timestamp: Date.now(),
      nickname: myNicknameRef.current,
    };

    peer.broadcast({ type: "buzz", payload: entry });
  }

  function submitGuess() {
    const word = guess.trim().toUpperCase();
    if (!word) {
      setGuessError("Enter your answer");
      return;
    }
    setGuessError(null);

    const peer = peerRef.current;
    if (!peer) return;

    // A solo host has no opponent to relay a guess to, so evaluate locally.
    const solo = isHostRef.current && rosterRef.current.length === 1;
    if (solo) {
      resolveConundrum(peer, myPeerIdRef.current ?? peer.peerId, word, myNicknameRef.current);
    } else {
      peer.broadcast({
        type: "conundrum-guess",
        payload: { peerId: peer.peerId, guess: word, nickname: myNicknameRef.current },
      });
    }
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
        <div className="card bg-error/20 text-error-content max-w-md w-full">
          <div className="card-body items-center text-center">
            <h2 className="card-title text-error">Connection Error</h2>
            <p>{error}</p>
            <Link
              href={`/${locale}/room/${roomId}`}
              className="btn btn-primary mt-4"
            >
              Back to Lobby
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // A solo host (only themselves in the roster) has no opponent to buzz
  // against, so they solve the conundrum directly instead of using the buzzer.
  const isSolo = isHost && rosterSize === 1;

  return (
    <div className="flex min-h-screen flex-col p-4">
      <div className="navbar mb-4">
        <div className="flex-1">
          <Link
            href={`/${locale}/room/${roomId}`}
            className="btn btn-ghost btn-sm"
          >
            &larr; Lobby
          </Link>
        </div>
        <div className="flex-none">
          <h1 className="text-lg sm:text-xl font-bold text-primary">Conundrum</h1>
          {readRound(roomId) > 0 && (
            <span className="badge badge-secondary badge-sm ml-3">
              Round {readRound(roomId)}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 sm:gap-6 flex-1 justify-center">
        <div className="flex flex-col items-center gap-6 flex-1 max-w-lg mx-auto">
          <ConundrumGame
            locale={locale}
            scrambled={scrambled}
            phase={phase}
            guess={guess}
            onGuessChange={(value) => { setGuess(value.toUpperCase()); setGuessError(null); }}
            onSubmitGuess={submitGuess}
            guessError={guessError}
            timeRemaining={timeRemaining}
            timerDuration={phase === "answering" ? BUZZER_TIMEOUT : ROUND_TIMEOUT}
            onBuzz={buzz}
            hasBuzzed={hasBuzzed}
            buzzerName={buzzerName}
            isBuzzer={buzzerId === myPeerId}
            answerReveal={answerReveal}
            solvedByName={solvedByName}
            showBuzzButton={phase === "playing" && !isSolo}
            backLink={`/${locale}/room/${roomId}`}
            onShuffle={() => peerRef.current && shuffleScramble(peerRef.current)}
            onReset={() => peerRef.current && resetScramble(peerRef.current)}
            canShuffle={isHost && (phase === "playing" || phase === "buzzed" || phase === "answering")}
          />
        </div>

        <div className="w-full max-w-xs lg:max-w-sm">
          <ScorePanel roomId={roomId} myPeerId={myPeerId} />
        </div>
      </div>
    </div>
  );
}
