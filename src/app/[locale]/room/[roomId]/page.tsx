"use client";
import { useState, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { PeerManager, PeerMessage } from "@/lib/webrtc/peer";
import { acquireSessionPeer, releaseSessionPeer } from "@/lib/webrtc/peer";
import {
  electHost,
} from "@/lib/webrtc/leader-election";
import type { PlayerInfo } from "@/lib/webrtc/leader-election";
import type { PlayerRecord } from "@/lib/db";
import { normalizeGermanWord } from "@/lib/game/letters";
import { ScorePanel } from "@/components/ScorePanel";
import {
  type GameType,
  nextGameRotation,
  readRound,
  readBestOf,
  readLastGame,
  writeRound,
  writeBestOf,
  writeLastGame,
  writeRoster,
  writeScores,
} from "@/lib/scoreboard";

type PlayerEntry = PlayerInfo & { nickname: string };
type NicknameMap = Record<string, string>;

const GAME_NAMES: Record<GameType, string> = {
  letters: "Letters Round",
  numbers: "Numbers Round",
  conundrum: "Conundrum",
};

function generateRoomId(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export default function RoomPage() {
  const params = useParams();
  const router = useRouter();
  const locale = params.locale as string;
  const roomId = params.roomId as string;

  const [players, setPlayers] = useState<PlayerEntry[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [selectedGame, setSelectedGame] = useState<GameType>(() =>
    nextGameRotation(readLastGame(roomId)),
  );
  const [timerEnabled, setTimerEnabled] = useState(true);
  const [timerDuration, setTimerDuration] = useState(30);
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameInput, setNicknameInput] = useState("");
  const [, setScores] = useState<Record<string, number>>({});
  const [roundCount, setRoundCount] = useState<number>(() => readRound(roomId));
  const [bestOf, setBestOf] = useState<number>(() => readBestOf(roomId));
  const [myPeerId, setMyPeerId] = useState<string | null>(null);

  const peerRef = useRef<PeerManager | null>(null);
  const hostIdRef = useRef<string | null>(null);
  const playersRef = useRef<PlayerEntry[]>([]);
  const nicknamesRef = useRef<NicknameMap>({});

  const isHost = hostId !== null && myPeerId !== null && hostId === myPeerId;

  const updateHost = (newHostId: string | null) => {
    hostIdRef.current = newHostId;
    setHostId(newHostId);
  };

  const recalculateHost = (currentPlayers: PlayerEntry[]) => {
    const infoList: PlayerInfo[] = currentPlayers.map((p) => ({
      peerId: p.peerId,
      joinedAt: p.joinedAt,
    }));
    const elected = electHost(infoList);
    updateHost(elected);
  };

  const updatePlayerState = (updatedPlayers: PlayerEntry[]) => {
    playersRef.current = updatedPlayers;
    setPlayers(updatedPlayers);
    recalculateHost(updatedPlayers);
    const roster: Record<string, string> = {};
    for (const p of updatedPlayers) roster[p.peerId] = p.nickname;
    writeRoster(roomId, roster);
  };

  useEffect(() => {
    if (roomId === "new") {
      const newId = generateRoomId();
      router.replace(`/${locale}/room/${newId}`);
      return;
    }

    let peer: PeerManager;
    let disposed = false;

    function broadcastPlayerList(peer: PeerManager, playerList: PlayerEntry[]) {
      const list = playerList.map((p) => ({
        peerId: p.peerId,
        joinedAt: p.joinedAt,
        nickname: p.nickname,
      }));
      peer.broadcast({ type: "player-list", payload: list });
    }

    async function handlePeerJoin(peerId: string, peer: PeerManager) {
      const current = playersRef.current;
      if (current.some((p) => p.peerId === peerId)) return;

      const nickname = nicknamesRef.current[peerId] ?? `Player-${peerId.substring(0, 4)}`;
      const newPlayer: PlayerEntry = {
        peerId,
        joinedAt: Date.now(),
        nickname,
      };

      const updated = [...current, newPlayer];
      updatePlayerState(updated);
      broadcastPlayerList(peer, updated);

      await fetch(`/api/rooms/${roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "join",
          player: { peerId, joinedAt: newPlayer.joinedAt, nickname },
        }),
      }).catch(() => {});
    }

    function handlePeerLeave(peerId: string) {
      const updated = playersRef.current.filter((p) => p.peerId !== peerId);
      updatePlayerState(updated);

      const peer = peerRef.current;
      if (peer) {
        broadcastPlayerList(peer, updated);
      }

      fetch(`/api/rooms/${roomId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "leave", peerId }),
      }).catch(() => {});
    }

    function handleIncomingMessage(msg: PeerMessage, peer: PeerManager) {
      if (!msg.type) return;

      switch (msg.type) {
        case "player-list": {
          const list = msg.payload as PlayerRecord[];
          const entries: PlayerEntry[] = list.map((p) => ({
            peerId: p.peerId,
            joinedAt: p.joinedAt,
            nickname: p.nickname,
          }));
          list.forEach((p) => {
            nicknamesRef.current[p.peerId] = p.nickname;
          });
          const merged = new Map<string, PlayerEntry>();
          for (const e of entries) merged.set(e.peerId, e);
          for (const e of playersRef.current) {
            if (!merged.has(e.peerId)) {
              merged.set(e.peerId, e);
            }
          }
          const mergedList = Array.from(merged.values());
          updatePlayerState(mergedList);
          break;
        }
        case "request-player-list": {
          broadcastPlayerList(peer, playersRef.current);
          break;
        }
        case "game-start": {
          const data = msg.payload as { gameType: GameType; timerEnabled: boolean; timerDuration: number };
          sessionStorage.setItem(`timer_${roomId}`, String(data.timerEnabled ? data.timerDuration : 0));
          router.push(`/${locale}/room/${roomId}/${data.gameType}`);
          break;
        }
        case "scores-update": {
          const s = msg.payload as Record<string, number>;
          writeScores(roomId, s);
          setScores(s);
          break;
        }
        case "nickname": {
          const { peerId: pid, nickname } = msg.payload as { peerId: string; nickname: string };
          if (playersRef.current.some((p) => p.nickname === nickname && p.peerId !== pid)) break;
          nicknamesRef.current[pid] = nickname;
          const updated = playersRef.current.map((p) =>
            p.peerId === pid ? { ...p, nickname } : p,
          );
          updatePlayerState(updated);
          break;
        }
      }
    }

    async function init() {
      try {
        const hostname = window.location.hostname;

        peer = acquireSessionPeer({
          host: hostname,
          port: 3000,
          path: "/signaling",
          onMessage: (msg: PeerMessage) => {
            if (disposed) return;
            handleIncomingMessage(msg, peer);
          },
          onPlayerJoin: (peerId: string) => {
            if (disposed) return;
            handlePeerJoin(peerId, peer);
          },
          onPlayerLeave: (peerId: string) => {
            if (disposed) return;
            handlePeerLeave(peerId);
          },
        });

        peerRef.current = peer;
        setMyPeerId(peer.peerId);

        await peer.connectToRoom();
        if (disposed) return;

        setConnected(true);

        const stored = typeof window !== "undefined" ? localStorage.getItem(`nickname_${roomId}`) : null;
        const localNickname = stored || `Player-${peer.peerId.substring(0, 4)}`;
        const localPlayer: PlayerRecord = {
          peerId: peer.peerId,
          joinedAt: peer.getJoinedAt(),
          nickname: localNickname,
        };
        nicknamesRef.current[peer.peerId] = localPlayer.nickname;

        const res = await fetch(`/api/rooms/${roomId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "join", player: localPlayer }),
        });
        const data = await res.json();

        const roomPlayers: PlayerEntry[] = (data.players as PlayerRecord[]).map(
          (p: PlayerRecord) => ({
            peerId: p.peerId,
            joinedAt: p.joinedAt,
            nickname: p.nickname,
          }),
        );
        playersRef.current = roomPlayers;
        roomPlayers.forEach((p) => {
          nicknamesRef.current[p.peerId] = p.nickname;
        });
        setPlayers(roomPlayers);
        recalculateHost(roomPlayers);
        const initRoster: Record<string, string> = {};
        for (const p of roomPlayers) initRoster[p.peerId] = p.nickname;
        writeRoster(roomId, initRoster);

        for (const p of roomPlayers) {
          if (p.peerId !== peer.peerId) {
            try {
              await peer.connectToPeer(p.peerId);
            } catch {
              // Peer might not be available yet
            }
          }
        }

        const savedScores = sessionStorage.getItem(`scores_${roomId}`);
        if (savedScores) setScores(JSON.parse(savedScores));

        broadcastPlayerList(peer, roomPlayers);
        setLoading(false);
      } catch (err) {
        if (disposed) return;
        setError(err instanceof Error ? err.message : "Failed to connect");
        setLoading(false);
      }
    }

    init();

    function onUnload() {
      const p = peerRef.current;
      if (p) {
        const pid = p.peerId;
        const blob = new Blob([JSON.stringify({ action: "leave", peerId: pid })], { type: "application/json" });
        navigator.sendBeacon(`/api/rooms/${roomId}`, blob);
        releaseSessionPeer();
      }
    }
    window.addEventListener("beforeunload", onUnload);

    const heartbeat = setInterval(() => {
      const p = peerRef.current;
      if (p) {
        fetch(`/api/rooms/${roomId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "heartbeat", peerId: p.peerId }),
        }).catch(() => {});
      }
    }, 10_000);

    // WebRTC peer connections do not close promptly when a peer's tab is
    // killed abruptly, so P2P-close alone can leave the lobby stuck with a
    // vanished host. The signaling server drops the host's socket quickly;
    // detect its absence there and fail over to the next-oldest player.
    let hostMisses = 0;
    const hostWatchdog = setInterval(() => {
      const p = peerRef.current;
      const currentHost = hostIdRef.current;
      if (!p || !currentHost || currentHost === p.peerId) {
        hostMisses = 0;
        return;
      }
      fetch(`/signaling/peerjs/peers`)
        .then((res) => (res.ok ? (res.json() as Promise<string[]>) : Promise.resolve([])))
        .then((peers) => {
          if (peers.includes(currentHost)) {
            hostMisses = 0;
            return;
          }
          hostMisses += 1;
          if (hostMisses >= 2 && hostIdRef.current === currentHost) {
            hostMisses = 0;
            handlePeerLeave(currentHost);
          }
        })
        .catch(() => {});
    }, 1000);

    return () => {
      clearInterval(heartbeat);
      clearInterval(hostWatchdog);
      window.removeEventListener("beforeunload", onUnload);
      disposed = true;
      // Navigation within the room (e.g. starting a round) must NOT wipe the
      // peer identity or disconnect from the signaling server. The shared
      // session peer stays alive and is re-acquired by the round page. Only
      // the actual "Leave Room" link and browser close tear it down.
    };
    // `recalculateHost` / `updateHost` / `updatePlayerState` are intentionally
    // omitted: they only close over stable setters, refs and `roomId`, so the
    // effect no longer depends on the React Compiler memoizing them. Including
    // them would re-run this effect (re-init the peer, respawn intervals) on
    // every render whenever the compiler is inactive.
  }, [roomId, locale, router]);

  const changeNickname = (newName: string) => {
    const peer = peerRef.current;
    if (!peer) return;
    const trimmed = newName.trim().slice(0, 20);
    if (!trimmed) return;
    if (playersRef.current.some((p) => p.nickname === trimmed && p.peerId !== peer.peerId)) return;
    const myPeerId = peer.peerId;
    nicknamesRef.current[myPeerId] = trimmed;
    localStorage.setItem(`nickname_${roomId}`, trimmed);
    const updated = playersRef.current.map((p) =>
      p.peerId === myPeerId ? { ...p, nickname: trimmed } : p,
    );
    updatePlayerState(updated);
    peer.broadcast({ type: "nickname", payload: { peerId: myPeerId, nickname: trimmed } });
    setEditingNickname(false);
  };

  const avatarColor = (peerId: string) => {
    const colors = ["bg-primary", "bg-secondary", "bg-accent", "bg-info", "bg-success", "bg-warning", "bg-error"];
    let hash = 0;
    for (let i = 0; i < peerId.length; i++) hash = peerId.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  };

  const copyInviteLink = async () => {
    const url = `${window.location.origin}/${locale}/room/${roomId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  };

  const startGame = (gameType: GameType) => {
    const peer = peerRef.current;
    if (!peer) return;
    const nextRound = roundCount + 1;
    setRoundCount(nextRound);
    writeRound(roomId, nextRound);
    writeLastGame(roomId, gameType);
    writeBestOf(roomId, bestOf);
    sessionStorage.setItem(`timer_${roomId}`, String(timerEnabled ? timerDuration : 0));
    peer.broadcast({ type: "game-start", payload: { gameType, timerEnabled, timerDuration } });
    router.push(`/${locale}/room/${roomId}/${gameType}`);
  };

  const handleLeaveRoom = () => {
    const peer = peerRef.current;
    if (peer) {
      const pid = peer.peerId;
      peerRef.current = null;
      navigator.sendBeacon(
        `/api/rooms/${roomId}`,
        new Blob([JSON.stringify({ action: "leave", peerId: pid })], { type: "application/json" }),
      );
      releaseSessionPeer();
    }
    router.push(`/${locale}`);
  };

  if (roomId === "new") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="loading loading-spinner loading-lg text-primary" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <span className="loading loading-spinner loading-lg text-primary" />
        <p className="text-base-content/60">Connecting to room...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
        <div className="card bg-error/20 text-error-content max-w-md w-full">
          <div className="card-body items-center text-center">
            <h2 className="card-title text-error">Connection Error</h2>
            <p>{error}</p>
            <div className="card-actions mt-4">
              <button
                className="btn btn-primary"
                onClick={() => window.location.reload()}
              >
                Retry
              </button>
              <Link href={`/${locale}`} className="btn btn-ghost">
                Back to Menu
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col p-4">
      <div className="navbar mb-4">
        <div className="flex-1">
          <h1 className="text-xl sm:text-2xl font-bold text-primary">Countdown</h1>
        </div>
        <div className="flex-none gap-2">
          <span className="badge badge-primary badge-md sm:badge-lg">
            Room: {roomId}
          </span>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 sm:gap-6 flex-1">
        <div className="card bg-base-200 flex-1">
          <div className="card-body">
            <h2 className="card-title">
              Players
              <span className="badge badge-secondary ml-2">
                {players.length}
              </span>
            </h2>

            <div className="divider" />

            {players.length === 0 && (
              <p className="text-base-content/40 text-center py-8">
                Waiting for players...
              </p>
            )}

            <ul className="flex flex-col gap-2">
              {[...players]
                .sort((a, b) => a.joinedAt - b.joinedAt)
                .map((player) => {
                  const isMe = myPeerId === player.peerId;
                  return (
                    <li
                      key={player.peerId}
                      className="flex items-center gap-3 p-3 rounded-box bg-base-300"
                    >
                      <div className="avatar placeholder">
                        <div className={`text-base-content rounded-full w-10 ${avatarColor(player.peerId)}`}>
                          <span className="text-base font-bold">
                            {normalizeGermanWord(player.nickname.charAt(0).toUpperCase()).charAt(0)}
                          </span>
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        {isMe && editingNickname ? (
                          <div className="flex gap-1 items-center">
                            <input
                              type="text"
                              className="input input-bordered input-xs w-28"
                              value={nicknameInput}
                              maxLength={20}
                              onChange={(e) => setNicknameInput(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") changeNickname(nicknameInput); if (e.key === "Escape") setEditingNickname(false); }}
                              autoFocus
                            />
                            <button className="btn btn-ghost btn-xs text-success" onClick={() => changeNickname(nicknameInput)}>OK</button>
                            <button className="btn btn-ghost btn-xs" onClick={() => setEditingNickname(false)}>X</button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-medium">{player.nickname}</span>
                            {isMe && (
                              <button className="btn btn-ghost btn-xs px-1 text-base-content/40 hover:text-base-content" onClick={() => { setNicknameInput(player.nickname); setEditingNickname(true); }}>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path d="M5.433 13.917l1.262-3.155A4 4 0 017.58 9.42l6.92-6.918a2.121 2.121 0 013 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 01-.65-.65z" /><path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0010 3H4.75A2.75 2.75 0 002 5.75v9.5A2.75 2.75 0 004.75 18h9.5A2.75 2.75 0 0017 15.25V10a.75.75 0 00-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5z" /></svg>
                              </button>
                            )}
                            {hostId === player.peerId && (
                              <span className="badge badge-warning badge-sm">Host</span>
                            )}
                            {isMe && (
                              <span className="badge badge-ghost badge-sm">You</span>
                            )}
                          </div>
                        )}
                      </div>
                      {connected && (
                        <div className="w-2 h-2 rounded-full bg-success shrink-0" title="Connected" />
                      )}
                    </li>
                  );
                })}
            </ul>
          </div>
        </div>

        <div className="card bg-base-200 w-full lg:w-80">
          <div className="card-body">
            <h2 className="card-title">Room Controls</h2>
            <div className="divider" />

            <div className="flex items-center justify-between mb-3">
              <div className="text-sm">
                <span className="font-bold text-primary">Round {roundCount + 1}</span>
                <span className="text-base-content/50"> / Best of {bestOf}</span>
              </div>
              {isHost && (
                <label className="flex items-center gap-1.5 text-xs text-base-content/60">
                  Best of
                  <select
                    className="select select-bordered select-xs"
                    value={bestOf}
                    onChange={(e) => setBestOf(Number(e.target.value))}
                  >
                    {[3, 5, 7, 9].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <button
              className="btn btn-outline btn-primary w-full"
              onClick={copyInviteLink}
            >
              {copied ? "Copied!" : "Copy Invite Link"}
            </button>

            <div className="divider" />

            {isHost ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-base-content/60">
                  You are the host
                </p>
                <div className="flex flex-col gap-2">
                  {(["letters", "numbers", "conundrum"] as GameType[]).map(
                    (game) => {
                      const icons: Record<GameType, string> = {
                        letters: "Aa",
                        numbers: "123",
                        conundrum: "?",
                      };
                      return (
                        <button
                          key={game}
                          onClick={() => {
                            setSelectedGame(game);
                          }}
                          className={`flex items-center gap-3 p-3 rounded-btn border-2 text-left transition-all ${
                            selectedGame === game
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-base-content/10 bg-base-300/50 text-base-content hover:border-primary/30"
                          }`}
                        >
                          <span className={`flex h-10 w-10 items-center justify-center rounded-lg text-lg font-bold ${
                            selectedGame === game ? "bg-primary text-primary-content" : "bg-base-content/10"
                          }`}>
                            {icons[game]}
                          </span>
                          <div className="flex-1">
                            <div className="font-medium">{GAME_NAMES[game]}</div>
                            <div className="text-xs text-base-content/40">
                              {game === "letters" ? "Spell the longest word" : game === "numbers" ? "Reach the target" : "Solve the anagram first"}
                            </div>
                          </div>
                          {selectedGame === game && (
                            <span className="text-primary">
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" /></svg>
                            </span>
                          )}
                        </button>
                      );
                    },
                  )}
                </div>

                <p className="text-xs text-base-content/50 text-center">
                  Up next: {GAME_NAMES[nextGameRotation(selectedGame)]}
                </p>

                <div className="divider my-1" />
                <div className="flex items-center justify-between">
                  <span className="text-sm">Timer</span>
                  <input
                    type="checkbox"
                    className="toggle toggle-sm toggle-primary"
                    checked={timerEnabled}
                    onChange={() => {
                      const enabled = !timerEnabled;
                      setTimerEnabled(enabled);
                    }}
                  />
                </div>
                {timerEnabled && (
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-base-content/60">{timerDuration}s</span>
                    <input type="range" min={10} max={120} step={5} value={timerDuration} onChange={(e) => setTimerDuration(Number(e.target.value))} className="range range-primary range-sm flex-1" />
                    <div className="flex gap-1">
                      {[15, 30, 60].map((d) => (
                        <button
                          key={d}
                          className={`btn btn-xs ${timerDuration === d ? "btn-primary" : "btn-ghost"}`}
                          onClick={() => {
                            setTimerDuration(d);
                          }}
                        >
                          {d}s
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="divider my-1" />

                <button
                  className="btn btn-primary w-full"
                  onClick={() => startGame(selectedGame)}
                >
                  Start {GAME_NAMES[selectedGame]}
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 py-4">
                <span className="loading loading-dots loading-md text-primary" />
                <p className="text-base-content/60 text-center">
                  Waiting for host to start...
                </p>
              </div>
            )}

            <div className="divider" />

            <button
              type="button"
              className="btn btn-ghost btn-sm w-full"
              onClick={handleLeaveRoom}
            >
              Leave Room
            </button>
          </div>
        </div>

        <div className="w-full lg:w-96">
          <ScorePanel roomId={roomId} myPeerId={myPeerId} />
        </div>
      </div>
    </div>
  );
}
