export type GameType = "letters" | "numbers" | "conundrum";

export const ROUND_ORDER: GameType[] = ["letters", "numbers", "conundrum"];

export function nextGameRotation(last: GameType | null): GameType {
  if (!last) return ROUND_ORDER[0];
  const idx = ROUND_ORDER.indexOf(last);
  return ROUND_ORDER[(idx + 1) % ROUND_ORDER.length];
}

const SCORES_KEY = (roomId: string) => `scores_${roomId}`;
const ROSTER_KEY = (roomId: string) => `roster_${roomId}`;
const ROUND_KEY = (roomId: string) => `round_${roomId}`;
const BEST_OF_KEY = (roomId: string) => `bestOf_${roomId}`;
const LAST_GAME_KEY = (roomId: string) => `lastGame_${roomId}`;

export const SCORES_EVENT = "countdown-scores-updated";

function notifyScoreboardChange(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SCORES_EVENT));
  }
}

function safeSession(): Storage | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage;
}

export function readScores(roomId: string): Record<string, number> {
  const store = safeSession();
  const raw = store?.getItem(SCORES_KEY(roomId));
  return raw ? (JSON.parse(raw) as Record<string, number>) : {};
}

export function writeScores(roomId: string, scores: Record<string, number>): void {
  const store = safeSession();
  if (!store) return;
  store.setItem(SCORES_KEY(roomId), JSON.stringify(scores));
  notifyScoreboardChange();
}

export function readRoster(roomId: string): Record<string, string> {
  const store = safeSession();
  const raw = store?.getItem(ROSTER_KEY(roomId));
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}

export function writeRoster(roomId: string, roster: Record<string, string>): void {
  const store = safeSession();
  if (!store) return;
  store.setItem(ROSTER_KEY(roomId), JSON.stringify(roster));
  notifyScoreboardChange();
}

export function readRound(roomId: string): number {
  const store = safeSession();
  const raw = store?.getItem(ROUND_KEY(roomId));
  return raw ? parseInt(raw, 10) : 0;
}

export function writeRound(roomId: string, round: number): void {
  safeSession()?.setItem(ROUND_KEY(roomId), String(round));
  notifyScoreboardChange();
}

export function readBestOf(roomId: string): number {
  const store = safeSession();
  const raw = store?.getItem(BEST_OF_KEY(roomId));
  return raw ? parseInt(raw, 10) : 5;
}

// Composite raw snapshot of all scoreboard fields for useSyncExternalStore:
// a string stays referentially stable while storage is unchanged.
export function readScoreboardRaw(roomId: string): string {
  const store = safeSession();
  return [
    store?.getItem(SCORES_KEY(roomId)) ?? "",
    store?.getItem(ROSTER_KEY(roomId)) ?? "",
    store?.getItem(ROUND_KEY(roomId)) ?? "",
    store?.getItem(BEST_OF_KEY(roomId)) ?? "",
  ].join("\u001e");
}

export function writeBestOf(roomId: string, bestOf: number): void {
  safeSession()?.setItem(BEST_OF_KEY(roomId), String(bestOf));
  notifyScoreboardChange();
}

export function readLastGame(roomId: string): GameType | null {
  const store = safeSession();
  const raw = store?.getItem(LAST_GAME_KEY(roomId)) as GameType | null;
  return raw && ROUND_ORDER.includes(raw) ? raw : null;
}

export function writeLastGame(roomId: string, game: GameType): void {
  safeSession()?.setItem(LAST_GAME_KEY(roomId), game);
}
