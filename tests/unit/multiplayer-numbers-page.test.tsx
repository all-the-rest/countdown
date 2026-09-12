// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { PeerMessage, PeerManager } from "@/lib/webrtc/peer";

import MultiplayerNumbersPage from "@/app/[locale]/room/[roomId]/numbers/page";

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

type FakePeer = PeerManager & { broadcast: ReturnType<typeof vi.fn> };

const ctl = vi.hoisted(() => ({
  onMessage: undefined as unknown as (msg: PeerMessage, peer: PeerManager) => void,
  fakePeer: undefined as unknown as FakePeer,
  state: { isHost: true, myPeerId: "host", myNickname: "Host", error: null as string | null },
}));

vi.mock("@/lib/webrtc/useMultiplayerRound", () => ({
  useMultiplayerRound: (options: {
    roomId: string;
    onMessage: (msg: PeerMessage, peer: PeerManager) => void;
    onReady?: (round: unknown) => void;
  }) => {
    ctl.onMessage = options.onMessage;
    if (!ctl.fakePeer) {
      ctl.fakePeer = {
        peerId: "host",
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
      hostName: "Host",
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

function numSubmittedCalls() {
  return ctl.fakePeer.broadcast.mock.calls.filter(
    (c) => (c[0] as { type: string }).type === "num-submitted",
  );
}

describe("MultiplayerNumbersPage — exact target auto-finish", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ctl.state = { isHost: true, myPeerId: "host", myNickname: "Host", error: null };
    if (ctl.fakePeer) ctl.fakePeer.broadcast.mockClear();
    ctl.onMessage = undefined as unknown as (msg: PeerMessage, peer: PeerManager) => void;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("submits the just-computed exact result instead of the stale previous step", () => {
    render(<MultiplayerNumbersPage />);

    dispatch({
      type: "num-tiles-complete",
      payload: { tiles: [100, 1, 2, 3, 4, 5], target: 101 },
      senderId: "host",
      timestamp: 1,
    });

    // 100 + 1 = 101 (exact target) in a single step.
    fireEvent.click(screen.getByRole("button", { name: "100" }));
    fireEvent.click(screen.getByRole("button", { name: "+" }));
    fireEvent.click(screen.getByRole("button", { name: "1" }));

    const submissions = numSubmittedCalls();
    expect(submissions.length).toBeGreaterThan(0);
    const payload = submissions[submissions.length - 1][0].payload as { result: number; diff: number };
    expect(payload.result).toBe(101);
    expect(payload.diff).toBe(0);
  });

  it("submits the exact result when it is reached after earlier steps", () => {
    render(<MultiplayerNumbersPage />);

    dispatch({
      type: "num-tiles-complete",
      payload: { tiles: [50, 5, 2, 3, 4, 6], target: 101 },
      senderId: "host",
      timestamp: 1,
    });

    // 50 * 2 = 100 (not the target)
    fireEvent.click(screen.getByRole("button", { name: "50" }));
    fireEvent.click(screen.getByRole("button", { name: "×" }));
    fireEvent.click(screen.getByRole("button", { name: "2" }));

    // 100 + 5 = 105
    fireEvent.click(screen.getByRole("button", { name: "100" }));
    fireEvent.click(screen.getByRole("button", { name: "+" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));

    // 105 - 4 = 101 (exact target on a later step)
    fireEvent.click(screen.getByRole("button", { name: "105" }));
    fireEvent.click(screen.getByRole("button", { name: "−" }));
    fireEvent.click(screen.getByRole("button", { name: "4" }));

    const submissions = numSubmittedCalls();
    expect(submissions.length).toBeGreaterThan(0);
    const payload = submissions[submissions.length - 1][0].payload as { result: number; diff: number };
    expect(payload.result).toBe(101);
    expect(payload.diff).toBe(0);
  });
});
