// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { PeerMessage, PeerManager } from "@/lib/webrtc/peer";

import MultiplayerConundrumPage from "@/app/[locale]/room/[roomId]/conundrum/page";
import { scrambleWord } from "@/lib/game/conundrum";

const WORD = "ADVENTURE";
const SCRAMBLED = scrambleWord(WORD);

function tileText(): string {
  return Array.from(document.querySelectorAll("kbd"))
    .map((k) => k.textContent ?? "")
    .join("");
}

vi.mock("next/navigation", () => ({
  useParams: () => ({ locale: "en-GB", roomId: "ROOM1" }),
}));

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
      React.createElement("a", { href: props.href, className: props.className }, props.children),
  };
});

vi.mock("@/lib/game/conundrum", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/game/conundrum")>();
  return {
    ...actual,
    getConundrumWord: () => WORD,
  };
});

type FakePeer = PeerManager & { broadcast: ReturnType<typeof vi.fn> };

const ctl = vi.hoisted(() => ({
  onMessage: undefined as unknown as (msg: PeerMessage, peer: PeerManager) => void,
  onReady: undefined as unknown as (round: {
    peer: PeerManager;
    myPeerId: string;
    myNickname: string;
    isHost: boolean;
    hostName: string;
    players: Array<{ peerId: string; joinedAt: number; nickname: string }>;
  }) => void,
  fakePeer: undefined as unknown as FakePeer,
  state: { isHost: false, myPeerId: "guest", myNickname: "Guest", error: null as string | null },
}));

vi.mock("@/lib/webrtc/useMultiplayerRound", () => ({
  useMultiplayerRound: (options: {
    roomId: string;
    onMessage: (msg: PeerMessage, peer: PeerManager) => void;
    onReady?: (round: unknown) => void;
  }) => {
    ctl.onMessage = options.onMessage;
    ctl.onReady = options.onReady as typeof ctl.onReady;
    if (!ctl.fakePeer) {
      ctl.fakePeer = {
        peerId: "guest",
        getJoinedAt: () => 0,
        broadcast: vi.fn(),
      } as unknown as FakePeer;
    }
    return {
      peerRef: { current: ctl.fakePeer },
      isHost: ctl.state.isHost,
      setIsHost: vi.fn(),
      myPeerId: ctl.state.myPeerId,
      myNickname: ctl.state.myNickname,
      hostName: "",
      setHostName: vi.fn(),
      error: ctl.state.error,
    };
  },
}));

function dispatch(msg: PeerMessage) {
  act(() => {
    ctl.onMessage(msg, ctl.fakePeer);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  ctl.state = { isHost: false, myPeerId: "guest", myNickname: "Guest", error: null };
  if (ctl.fakePeer) ctl.fakePeer.broadcast.mockClear();
  ctl.onMessage = undefined as unknown as (msg: PeerMessage, peer: PeerManager) => void;
  ctl.onReady = undefined as unknown as (round: {
    peer: PeerManager;
    myPeerId: string;
    myNickname: string;
    isHost: boolean;
    hostName: string;
    players: Array<{ peerId: string; joinedAt: number; nickname: string }>;
  }) => void;
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("MultiplayerConundrumPage — message-driven flow", () => {
  it("enters the playing phase with scrambled tiles on conundrum-start", () => {
    render(<MultiplayerConundrumPage />);

    dispatch({
      type: "conundrum-start",
      payload: { scrambled: SCRAMBLED },
      senderId: "host",
      timestamp: 1,
    });

    expect(screen.getByRole("button", { name: "Buzzer" })).toBeTruthy();
    expect(tileText()).toBe(SCRAMBLED);
  });

  it("transitions the buzzing player to the answering phase on buzzer-granted", () => {
    render(<MultiplayerConundrumPage />);

    dispatch({
      type: "conundrum-start",
      payload: { scrambled: SCRAMBLED },
      senderId: "host",
      timestamp: 1,
    });
    dispatch({
      type: "buzzer-granted",
      payload: { peerId: "guest", nickname: "Guest" },
      senderId: "host",
      timestamp: 2,
    });

    expect(screen.getByText("You have the floor!")).toBeTruthy();
    expect(screen.getByPlaceholderText("Type the answer...")).toBeTruthy();
  });

  it("submits a guess over the wire when the player solves", () => {
    render(<MultiplayerConundrumPage />);

    dispatch({
      type: "conundrum-start",
      payload: { scrambled: SCRAMBLED },
      senderId: "host",
      timestamp: 1,
    });
    dispatch({
      type: "buzzer-granted",
      payload: { peerId: "guest", nickname: "Guest" },
      senderId: "host",
      timestamp: 2,
    });

    const input = screen.getByPlaceholderText("Type the answer...");
    fireEvent.change(input, { target: { value: WORD } });
    fireEvent.click(screen.getByRole("button", { name: "Solve" }));

    expect(ctl.fakePeer.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "conundrum-guess",
        payload: expect.objectContaining({ guess: WORD, nickname: "Guest" }),
      }),
    );
  });

  it("shows the solved result when a correct conundrum-result arrives", () => {
    render(<MultiplayerConundrumPage />);

    dispatch({
      type: "conundrum-start",
      payload: { scrambled: SCRAMBLED },
      senderId: "host",
      timestamp: 1,
    });
    dispatch({
      type: "buzzer-granted",
      payload: { peerId: "guest", nickname: "Guest" },
      senderId: "host",
      timestamp: 2,
    });
    dispatch({
      type: "conundrum-result",
      payload: { peerId: "guest", guess: WORD, correct: true, nickname: "Guest", answer: WORD },
      senderId: "host",
      timestamp: 3,
    });

    expect(screen.getByText("Solved!")).toBeTruthy();
    expect(screen.getByText(WORD)).toBeTruthy();
    expect(screen.getByText(/Solved by you/)).toBeTruthy();
  });

  it("shows the timeout result with the answer when conundrum-timeout arrives", () => {
    render(<MultiplayerConundrumPage />);

    dispatch({
      type: "conundrum-start",
      payload: { scrambled: SCRAMBLED },
      senderId: "host",
      timestamp: 1,
    });
    dispatch({
      type: "conundrum-timeout",
      payload: { answer: WORD },
      senderId: "host",
      timestamp: 2,
    });

    expect(screen.getByText("Time's Up!")).toBeTruthy();
    expect(screen.getByText(WORD)).toBeTruthy();
  });

  it("host auto-starts a round and grants the first buzz", () => {
    ctl.state = { isHost: true, myPeerId: "host", myNickname: "Host", error: null };

    render(<MultiplayerConundrumPage />);

    act(() => {
      ctl.onReady({
        peer: ctl.fakePeer,
        myPeerId: "host",
        myNickname: "Host",
        isHost: true,
        hostName: "Host",
        players: [
          { peerId: "host", joinedAt: 1, nickname: "Host" },
          { peerId: "guest", joinedAt: 2, nickname: "Guest" },
        ],
      });
    });

    expect(tileText()).toBe(SCRAMBLED);
    expect(screen.getByRole("button", { name: "Buzzer" })).toBeTruthy();
    expect(ctl.fakePeer.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "conundrum-start",
        payload: expect.objectContaining({ scrambled: SCRAMBLED }),
      }),
    );

    dispatch({
      type: "buzz",
      payload: { peerId: "guest", timestamp: 5, nickname: "Guest" },
      senderId: "guest",
      timestamp: 5,
    });

    expect(screen.getByText(/Guest pressed the buzzer!/)).toBeTruthy();
    expect(ctl.fakePeer.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "buzzer-granted",
        payload: expect.objectContaining({ peerId: "guest" }),
      }),
    );
  });

  it("host evaluates a guess and broadcasts the correct result", () => {
    ctl.state = { isHost: true, myPeerId: "host", myNickname: "Host", error: null };

    render(<MultiplayerConundrumPage />);

    act(() => {
      ctl.onReady({
        peer: ctl.fakePeer,
        myPeerId: "host",
        myNickname: "Host",
        isHost: true,
        hostName: "Host",
        players: [
          { peerId: "host", joinedAt: 1, nickname: "Host" },
          { peerId: "guest", joinedAt: 2, nickname: "Guest" },
        ],
      });
    });

    dispatch({
      type: "conundrum-guess",
      payload: { peerId: "guest", guess: WORD, nickname: "Guest" },
      senderId: "guest",
      timestamp: 5,
    });

    const resultCall = ctl.fakePeer.broadcast.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "conundrum-result",
    );
    expect(resultCall).toBeTruthy();
    expect((resultCall![0] as { payload: { correct: boolean; answer: string } }).payload.correct).toBe(
      true,
    );
    expect((resultCall![0] as { payload: { answer: string } }).payload.answer).toBe(WORD);
  });
});

describe("MultiplayerConundrumPage — solo host", () => {
  it("lets a lone host solve the conundrum directly without a buzzer", () => {
    ctl.state = { isHost: true, myPeerId: "host", myNickname: "Host", error: null };

    render(<MultiplayerConundrumPage />);

    dispatch({
      type: "player-list",
      payload: [{ peerId: "host", joinedAt: 1, nickname: "Host" }],
      senderId: "lobby",
      timestamp: 1,
    });

    act(() => {
      ctl.onReady({
        peer: ctl.fakePeer,
        myPeerId: "host",
        myNickname: "Host",
        isHost: true,
        hostName: "Host",
        players: [{ peerId: "host", joinedAt: 1, nickname: "Host" }],
      });
    });

    // Solo: scrambled tiles appear, but there is no Buzzer button to press.
    expect(tileText()).toBe(SCRAMBLED);
    expect(screen.queryByRole("button", { name: "Buzzer" })).toBeNull();
    expect(screen.getByPlaceholderText("Type the answer...")).toBeTruthy();

    // The host types the answer and submits directly (no relay over the wire).
    const input = screen.getByPlaceholderText("Type the answer...");
    fireEvent.change(input, { target: { value: WORD } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(ctl.fakePeer.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "conundrum-guess" }),
    );
    expect(screen.getByText("Solved!")).toBeTruthy();
    expect(screen.getByText(WORD)).toBeTruthy();
    expect(screen.getByText(/Solved by you/)).toBeTruthy();
  });
});
