# Architecture & Decisions

Durable decisions, rationale and measurements for the Countdown project. Rules for
working in this repo live in [`../AGENTS.md`](../AGENTS.md); gameplay rules live in
[`features/`](features/). Open items are tracked in `AGENTS.todo.md`, history in git.

## Tech Stack (version snapshot)

Source of truth is `package.json` / `pnpm-lock.yaml`; the table below is a snapshot.

| Layer | Choice | Version |
|-------|--------|---------|
| Framework | Next.js (App Router) | 16.x |
| Runtime | Node.js | 26 |
| Server | Express (custom server) | 5.2.1 (Express 5) |
| WebRTC Signaling | PeerJS | 1.x |
| Styling | Tailwind CSS v4 + daisyUI v5 | latest |
| Font | Lexend Deca (Google Fonts) | — |
| Language | TypeScript | 6.x |
| Package manager | pnpm | latest |
| Unit tests | Vitest | latest |
| E2E tests | Playwright | latest |
| CI/CD | GitHub Actions + Docker multi-stage | — |
| Registry | GitHub Container Registry (GHCR) | — |
| Deployment trigger | Portainer Webhook | — |

## Single-Artifact Container

All services run in one Docker container on port 3000:

- Express catches `/signaling/*` → forwards to the integrated PeerJS server
- Express catches everything else → forwards to the Next.js request handler
- No CORS needed, no inter-container networking, no external DB

## No Database

All state is in-memory. Multiplayer state lives ephemerally in the host browser.
Word dictionaries are loaded into memory on server start.

## Implicit Lobbies (Leader Election)

- Players join a room URL → each gets a `joinedAt` timestamp
- Oldest `joinedAt` wins the host role
- On host disconnect, the next-oldest takes over within milliseconds
- The host controls timer and round-start logic

## i18n via URL Locale Segment

- `/` → redirects to the browser's preferred locale (e.g., `/de`)
- All pages use the `[locale]` dynamic segment
- SSR-compatible, no cookie-based language switching
- German umlaut mapping: Ä→AE, Ö→OE, Ü→UE, ß→SS (both on board display and input)

## Word Dictionaries (In-Memory)

| Locale | Dictionary |
|--------|-------------|
| en-GB | `word-list` npm (SCOWL) |
| en-US | `word-list` npm (SCOWL) |
| de | igerman98 hunspell dictionary (`dictionary-de`) validated via `nspell` |

German validation runs through `nspell`, so inflected forms ("GEHT", "SPIELTE",
"SCHÖNE") are accepted. The letters game draws A–Z tiles only, so umlauts arrive in
ASCII form ("NATUERLICH"); `isValidWord` maps AE/OE/UE/SS digraphs back to Ä/Ö/Ü/ß
before asking `nspell`. The longest-word solver uses a precomputed index of base forms
plus their ASCII variants.

## UI Theme

The theme is defined in `src/styles/globals.css`:

```css
@import "tailwindcss";
@plugin "daisyui";
@plugin "daisyui/theme" {
  name: "countdown";
  default: true;
  color-scheme: dark;
  --color-base-100: oklch(20% 0.04 260);   /* Deep Space Blue #0a192f */
  --color-primary: oklch(75% 0.18 75);     /* Countdown Gold #f59e0b */
  --color-secondary: oklch(50% 0.19 265);  /* Deep Studio Blue #1d4ed8 */
  /* ... remaining required color vars */
}
```

## React Compiler under Turbopack

The React Compiler must stay enabled with Turbopack's Rust backend. Next.js builds with
Turbopack, which ignores the Babel-based `reactCompiler` transform (it is only wired into
webpack). Without `experimental.turbopackRustReactCompiler: true`, the compiler silently
emits unmemoized code, and any `useEffect` whose deps include render-scoped functions
loops forever. Keep both `reactCompiler: true` and
`experimental.turbopackRustReactCompiler: true` in `next.config.ts`, and verify the
compiler is active by grepping a built client chunk for `react.memo_cache_sentinel`.

## useMultiplayerRound Ref-Delegate Pattern

When a multiplayer page's `handleMessage` needs values from `useMultiplayerRound` (e.g.
`setIsHost`, `myPeerId`, `setHostName`), use this pattern to avoid the temporal dead zone:

```typescript
// 1. Create refs for values needed before the hook call
const realHandlerRef = useRef<(msg: PeerMessage, peer: PeerManager) => void>(() => {});
const myPeerIdRef = useRef<string | null>(null);
const setIsHostFnRef = useRef<(v: boolean) => void>(() => {});

// 2. Call the hook with a wrapper that delegates to the ref
const { peerRef, isHost, setIsHost, myPeerId, ... } = useMultiplayerRound({
  roomId,
  onMessage: (msg, peer) => realHandlerRef.current(msg, peer),
});

// 3. Sync refs after the hook call
useEffect(() => { myPeerIdRef.current = myPeerId; }, [myPeerId]);
useEffect(() => { setIsHostFnRef.current = setIsHost; }, [setIsHost]);

// 4. Define the real handler NOW (after the hook), using refs — plain function,
//    React Compiler memoizes it based on its own dependencies
const handleMessage = (msg, peer) => {
  setIsHostFnRef.current(...);    // safe — via ref
  if (msg.peerId === myPeerIdRef.current) { ... }  // safe — via ref
};

// 5. Wire up
useEffect(() => { realHandlerRef.current = handleMessage; }, [handleMessage]);
```

## CI/CD Pipeline (GitHub Actions)

1. **Trigger**: Push to `main`
2. **Build VM**: Node 26, pnpm, install deps
3. **Test + E2E (parallel)**: Lint + Vitest suite + typecheck (`test` job); Playwright E2E
   (`e2e` job runs inside the official Playwright image
   `mcr.microsoft.com/playwright:v1.61.1-noble` — Chromium + system deps preinstalled, no
   per-run `playwright install`; `pnpm build` → `pnpm test:e2e`, HTML report uploaded as artifact)
4. **Docker Build** (multi-stage, `needs: [test, e2e]`):
   - Stage 1 (Install): `pnpm install --frozen-lockfile`
   - Stage 2 (Build): `pnpm build` (Next.js production build)
   - Stage 3 (Prune): `pnpm install --prod --frozen-lockfile`
   - Stage 4 (Runner): copy build artifacts + `server.js` + prod deps → slim `node:26-slim`
     image (~120–150 MB)
5. **Push**: `docker push` to GHCR (private repo → private image)
6. **Deploy**: POST webhook to Portainer → pull new image → restart container (<10s downtime)
7. **Local deploy**: `cd deploy && docker compose pull && docker compose up -d`

Workflow file: `.github/workflows/build.yml`.
