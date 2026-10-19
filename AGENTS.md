# AGENTS.md

Countdown — a web-based clone of the TV game show with solo and WebRTC multiplayer modes.

**Rules only, no decisions:** This file contains rules only — instructions that apply to any work in this repo. Lasting decisions, rationale, measurements and history do not belong here; they live in the project docs under `docs/` (feature rules in `docs/features/`, architecture in `docs/architecture.md`). Open items go to `AGENTS.todo.md`, completed work to the git history.

## Tech Stack

- **Framework**: Next.js, App Router only (no Pages Router)
- **Runtime**: Node.js
- **Server**: Express custom server that also hosts the PeerJS signaling server
- **WebRTC**: PeerJS
- **Styling**: Tailwind CSS v4 + daisyUI v5 (daisyUI is mandatory)
- **Font**: Lexend Deca via `next/font/google`
- **Language**: TypeScript, strict mode
- **Package manager**: pnpm
- **Tests**: Vitest (unit), Playwright (E2E)
- **CI/CD**: GitHub Actions + Docker multi-stage → GHCR, deployed via Portainer webhook

Pinned versions live in `package.json` / `pnpm-lock.yaml`.

## Project Structure

```
countdown/
├── server.js              # Express custom server (Next.js + PeerJS on port 3000)
├── Dockerfile             # Multi-stage build
├── deploy/                # docker-compose.yml + deployment instructions
├── src/
│   ├── app/[locale]/      # Localized routes: main menu, solo/{letters,numbers,...}, room/[roomId]
│   ├── lib/game/          # Pure round logic: letters, numbers, conundrum
│   ├── lib/webrtc/        # PeerJS wrapper (peer.ts) + leader election
│   ├── lib/i18n/          # Word dictionaries per locale
│   ├── lib/db.ts          # In-memory store (no persistent DB)
│   └── styles/globals.css # Tailwind v4 imports + daisyUI theme
├── public/locales/        # UI translation files (en-GB, en-US, de)
├── tests/                 # unit/ (Vitest) and e2e/ (Playwright)
└── docs/                  # Project docs (features, architecture)
```

Follow this layout; do not invent new top-level folders.

## Code Conventions

- **Language**: All code, comments, variable names, commit messages in English
- **Types**: Always use strict TypeScript. No `any` except well-documented edge cases.
- **Exports**: Prefer named exports. Default exports only for Next.js pages and layouts.
- **Naming**: camelCase for variables/functions, PascalCase for components/classes, kebab-case for files
- **Imports**: Group imports: (1) Node builtins, (2) third-party, (3) internal `@/` aliases
- **Server components**: Default in Next.js App Router. Use `"use client"` only when needed (state, effects, browser APIs)
- **CSS**: Use Tailwind utility classes exclusively. No custom CSS files. No inline styles.
- **No comments**: Code should be self-documenting. Add comments only for non-obvious business logic.

## UI Conventions (Tailwind CSS v4 + daisyUI v5)

1. Use daisyUI semantic color names (`bg-primary`, `text-base-content`) — never raw Tailwind colors for themed elements
2. Use `base-100` for page backgrounds, `primary` for the single most important element on each page
3. No `dark:` prefix needed for daisyUI colors — they auto-adapt per theme
4. Prefer daisyUI component classes over custom CSS
5. If daisyUI doesn't have a matching component, build with Tailwind utilities
6. Tags are in English. No German in source code.

Key components: `kbd` for letter/number tiles (yellow border via `border-warning`), `radial-progress` for the timer, `btn` for the buzzer, `navbar` for the top bar, responsive `grid` for the game board.

## Testing

- Unit tests run with Vitest (`pnpm test`); component tests use happy-dom + `@testing-library/react`.
- E2E tests run with Playwright (`pnpm test:e2e`) against a built app.
- Keep game logic in pure functions under `src/lib/game/` and cover it with unit tests.

## CI/CD (GitHub Actions)

- A push to `main` runs `lint` + `typecheck` + Vitest (`test` job) and Playwright E2E (`e2e` job, inside the official Playwright image); both must be green before the image is built.
- The Docker image is built multi-stage (install → build → prune → slim runner), pushed to GHCR, and deployed by a Portainer webhook that pulls and restarts the container.
- Local deploy: `cd deploy && docker compose pull && docker compose up -d`.
- The service runs at `countdown.all-the.rest` behind a Caddy reverse proxy.

## Getting Started (Local Dev)

```bash
pnpm install
pnpm dev          # Express + Next.js + PeerJS on :3000
pnpm build        # Production build
pnpm start        # Production start
pnpm test         # Vitest
pnpm test:e2e     # Playwright
```

## Key Rules for Agents

1. Read `AGENTS.md` first before making any changes
2. Follow the project structure exactly
3. Write all code in English (comments, logs, UI strings via i18n)
4. Use daisyUI components whenever possible — read the component docs before coding
5. Always use semantic daisyUI color names, never raw Tailwind colors for themed UI
6. No persistent database — everything is in-memory
7. TypeScript strict mode, no `any`
8. Keep the Docker image under 150 MB
9. All game logic must be pure functions where possible (testable)
10. WebRTC/PeerJS code must handle disconnects gracefully (leader election)
11. Implementation and verification follow skill `build-verify`: verify only after the implementation is finished, always with a separate verifier subagent, and verification runs sequentially
12. **AGENTS.todo.md discipline**: Only open or unverified TODOs live in `AGENTS.todo.md`. Completed items are removed, not checked off. Before any change, run the `#tag: all` tests (or a targeted tag). Have a subagent review any new TODO before adding it.

## Mandatory Verification

The flow itself (pull → delegate → independent verify run → commit after **every** round →
amend on redo → push + CI watch) is defined centrally in skill `build-verify`
(`~/dev/agents-skills`; core rule `.agents/rules/build-verify.md`) — read it there
instead of restating it here. What is repo-specific, and therefore what stays here, are
the commands this project must pass:

```bash
pnpm lint         # ESLint — must exit 0
pnpm typecheck    # TypeScript strict mode — must exit 0
pnpm test         # Vitest unit tests — all must pass
pnpm build        # Production build — must complete without errors
```

## Forbidden Patterns

| Pattern | Why | Fix |
|---------|-----|-----|
| `useMemo` / `useCallback` / `React.memo` / `forwardRef` in components | React Compiler auto-memoizes; manual memoization is an antipattern | Write plain functions/values, let the compiler memoize. Exception: the ref-delegation pattern for hook-order safety stays |
| Calling `useMultiplayerRound` after defining callbacks that use its return values | Temporal dead zone — TypeScript errors and potential runtime crashes | Use the ref-delegation pattern (see `docs/architecture.md`) |
| `<style jsx>` in components | Crashes (`__webpack_require__.n is not a function`) on soft navigation in the Next.js App Router | Define `@keyframes` in `globals.css` and reference by name in inline `style` or a Tailwind `animate-*` utility |
| Inline styles for themed colors | Bypasses daisyUI theming | Use daisyUI color classes (`bg-primary`, `text-base-content`, …) |
| `dark:` prefix for themed elements | daisyUI auto-adapts per theme | Use semantic color names without `dark:` prefix |

> **React Compiler:** Next.js builds with Turbopack, which ignores the Babel-based `reactCompiler` transform. Keep both `reactCompiler: true` and `experimental.turbopackRustReactCompiler: true` in `next.config.ts`, and verify the compiler is active by grepping a built client chunk for `react.memo_cache_sentinel`.
