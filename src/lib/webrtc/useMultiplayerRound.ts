"use client";
import { useEffect, useRef, useState } from "react";
import {
  PeerManager,
  PeerMessage,
  acquireSessionPeer,
  getStoredPeerId,
  getStoredJoinedAt,
  releaseSessionPeer,
} from "./peer";
import type { PlayerRecord } from "@/lib/db";

export type RoundPeer = {
  peer: PeerManager;
  myPeerId: string;
  myNickname: string;
  isHost: boolean;
  hostName: string;
  /**
   * The authoritative room roster fetched from the server on mount. Round
   * pages seed their player count / scoring roster from this so they do not
   * depend on a lobby broadcast that no longer happens after navigation.
   */
  players: RoomPlayer[];
};

export type UseMultiplayerRoundOptions = {
  roomId: string;
  onMessage: (msg: PeerMessage, peer: PeerManager) => void;
  /**
   * Invoked once the roster has been fetched and host identity resolved.
   * Useful for a host that needs to auto-start a round (e.g. conundrum).
   */
  onReady?: (round: RoundPeer) => void;
  /**
   * Invoked when a remote peer establishes a new connection. A round page can
   * use this to re-broadcast its current state, since WebRTC connections can
   * open after the host already advanced the round (message loss otherwise).
   */
  onPeerJoin?: (peerId: string) => void;
};

type RoomPlayer = { peerId: string; joinedAt: number; nickname: string };

function electHostFromList(players: RoomPlayer[]): string | null {
  if (players.length === 0) return null;
  return players.reduce((oldest, p) => (p.joinedAt < oldest.joinedAt ? p : oldest)).peerId;
}

/**
 * Shared connection lifecycle for an in-round multiplayer page
 * (letters / numbers / conundrum).
 *
 * On mount it builds a PeerManager using the identity persisted by the lobby,
 * re-registers that identity with the room roster, re-establishes the
 * peer-to-peer mesh, and keeps the roster warm via heartbeats. Host identity is
 * derived from the server roster so it stays consistent across navigation.
 */
export function useMultiplayerRound({
  roomId,
  onMessage,
  onReady,
  onPeerJoin,
}: UseMultiplayerRoundOptions) {
  const [isHost, setIsHost] = useState(false);
  const [myPeerId, setMyPeerId] = useState<string | null>(null);
  const [myNickname, setMyNickname] = useState("");
  const [hostName, setHostName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const peerRef = useRef<PeerManager | null>(null);
  const messageHandlerRef = useRef(onMessage);
  const readyHandlerRef = useRef(onReady);
  const peerJoinHandlerRef = useRef(onPeerJoin);

  useEffect(() => {
    messageHandlerRef.current = onMessage;
  }, [onMessage]);
  useEffect(() => {
    readyHandlerRef.current = onReady;
  }, [onReady]);
  useEffect(() => {
    peerJoinHandlerRef.current = onPeerJoin;
  }, [onPeerJoin]);

  useEffect(() => {
    const hostname = window.location.hostname;
    let peer: PeerManager;
    let mounted = true;

    async function init() {
      try {
        const storedPeerId = getStoredPeerId();
        const storedJoinedAt = getStoredJoinedAt();

        peer = acquireSessionPeer({
          host: hostname,
          port: 3000,
          path: "/signaling",
          peerId: storedPeerId ?? undefined,
          joinedAt: storedJoinedAt ?? undefined,
          onMessage: (msg: PeerMessage) => {
            if (mounted) messageHandlerRef.current(msg, peer);
          },
          onPlayerJoin: (peerId: string) => {
            if (mounted) peerJoinHandlerRef.current?.(peerId);
          },
          onPlayerLeave: () => {},
          // Tie roster pruning to the real PeerJS signaling connection state:
          // a genuine drop removes us from the server immediately (instead of
          // waiting for the heartbeat timeout), and a recovery re-registers us.
          onSignalingDisconnect: () => {
            if (!peer) return;
            fetch(`/api/rooms/${roomId}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "disconnect", peerId: peer.peerId }),
            }).catch(() => {});
          },
          onSignalingReconnect: () => {
            if (!peer) return;
            fetch(`/api/rooms/${roomId}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "join",
                player: {
                  peerId: peer.peerId,
                  joinedAt: peer.getJoinedAt(),
                  nickname,
                },
              }),
            }).catch(() => {});
          },
        });

        peerRef.current = peer;
        await peer.connectToRoom();
        if (!mounted) return;

        const pid = peer.peerId;
        setMyPeerId(pid);

        // Re-register with the room roster so host election still sees us.
        const storedNick =
          typeof window !== "undefined" ? localStorage.getItem(`nickname_${roomId}`) : null;
        const nickname = storedNick ?? `Player-${pid.substring(0, 4)}`;
        setMyNickname(nickname);

        const joinRes = await fetch(`/api/rooms/${roomId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "join",
            player: {
              peerId: pid,
              joinedAt: peer.getJoinedAt(),
              nickname,
            },
          }),
        });
        const joinData = await joinRes.json();
        const roomPlayers = (joinData.players ?? []) as RoomPlayer[];

        const hostId = electHostFromList(roomPlayers);
        setIsHost(hostId === pid);
        const hostPlayer = roomPlayers.find((p) => p.peerId === hostId);
        if (hostPlayer) setHostName(hostPlayer.nickname);

        // Re-establish the peer-to-peer mesh with everyone already in the room.
        // Both peers dial each other right after mounting, so a dial can fail
        // because the remote peer is not registered with the signaling server
        // yet. Retry so the mesh reliably forms.
        for (const p of roomPlayers) {
          if (p.peerId !== pid) {
            for (let attempt = 0; attempt < 5; attempt++) {
              try {
                await peer.connectToPeer(p.peerId);
                peerJoinHandlerRef.current?.(p.peerId);
                break;
              } catch {
                if (attempt === 4) break;
                await new Promise((r) => setTimeout(r, 1000));
              }
            }
          }
        }

        if (mounted) {
          peer.broadcast({ type: "request-player-list", payload: null });
          readyHandlerRef.current?.({
            peer,
            myPeerId: pid,
            myNickname: nickname,
            isHost: hostId === pid,
            hostName: hostPlayer?.nickname ?? "",
            players: roomPlayers,
          });
        }
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : "Connection failed");
      }
    }

    init();

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

    function onUnload() {
      const p = peerRef.current;
      if (p) {
        const pid = p.peerId;
        navigator.sendBeacon(
          `/api/rooms/${roomId}`,
          new Blob([JSON.stringify({ action: "leave", peerId: pid })], { type: "application/json" }),
        );
        releaseSessionPeer();
      }
    }
    window.addEventListener("beforeunload", onUnload);

    return () => {
      clearInterval(heartbeat);
      window.removeEventListener("beforeunload", onUnload);
      mounted = false;
      // Navigating between rounds / lobby keeps the shared session peer alive.
      // The next page re-acquires it and re-attaches its handlers, so the id
      // never needs to be re-registered with the signaling server. Only a real
      // leave (beforeunload / Leave Room) tears it down via releaseSessionPeer.
    };
  }, [roomId]);

  return {
    peerRef,
    isHost,
    setIsHost,
    myPeerId,
    myNickname,
    hostName,
    setHostName,
    error,
  };
}

export type PlayerListPayload = PlayerRecord[];
