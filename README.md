# Countdown

Ein Web-Klon der klassischen TV-Show *Countdown* mit Solo-Spiel und
Peer-to-Peer-Multiplayer (WebRTC). Spiele die Runden Letters, Numbers und
Conundrum allein oder mit Freunden in einem Live-Raum — ohne Account.

## Features

- **Solo-Modus** — Letters-, Numbers- und Conundrum-Runden allein spielbar.
- **Multiplayer** — Raum hosten und den Link teilen; gespielt wird über WebRTC.
- **Implizite Lobbys** — Der älteste Teilnehmer im Raum wird automatisch Host.
  Verlässt der Host den Raum, übernimmt der nächste Teilnehmer sofort.
- **International** — Englisch (GB/US) und Deutsch, mit passender
  Wörterbuch-Prüfung pro Sprache.
- **Self-hosted** — Ein einzelner Docker-Container, keine Datenbank, keine
  externen Dienste.

## Tech Stack

| Ebene | Wahl |
|-------|------|
| Framework | Next.js (App Router) 15 |
| Runtime | Node.js 26 |
| Server | Express + PeerJS |
| Styling | Tailwind CSS v4 + daisyUI v5 |
| Sprache | TypeScript (strict) |
| Paketmanager | pnpm |
| Tests | Vitest (Unit) + Playwright (E2E) |
| Deployment | Docker + GitHub Container Registry + Compose (repo-verwaltet) |

## Lokale Entwicklung

```bash
pnpm install
pnpm dev      # Express + Next.js + PeerJS auf http://localhost:3000
```

## Skripte

```bash
pnpm dev        # Dev-Server starten
pnpm build      # Produktions-Build
pnpm start      # Produktions-Server starten
pnpm test       # Vitest-Unit-Tests
pnpm test:e2e   # Playwright-E2E-Tests (benötigt einen Build)
pnpm typecheck  # TypeScript im Strict-Modus prüfen
```

## Projektstruktur

```
countdown/
├── server.js              # Express-Custom-Server (Next.js + PeerJS auf Port 3000)
├── src/
│   ├── app/[locale]/      # Lokalisierte Routen (Hauptmenü, Solo, Raum)
│   ├── lib/game/          # Spiellogik für Letters, Numbers, Conundrum
│   ├── lib/webrtc/        # PeerJS-Wrapper & Leader-Election
│   ├── lib/i18n/          # Wörterbücher (CSW, NWL, Deutsch)
│   └── middleware.ts      # Locale-Redirect & i18n-Routing
├── public/locales/        # UI-Übersetzungen
├── tests/                 # Unit- & E2E-Tests
└── deploy/                # Compose-Datei + Deploy-Skript
```

## Funktionsweise

- **Ein Artefakt** — Express liefert die Next.js-App und den integrierten
  PeerJS-Signaling-Server auf einem Port aus. Kein CORS, kein
  Inter-Container-Netzwerk.
- **Keine Datenbank** — Aller State liegt im Speicher. Multiplayer-State lebt
  flüchtig im Browser des Hosts; die Wörterbücher werden beim Start geladen.
- **Implizite Lobbys (Leader-Election)** — Wer eine Raum-URL öffnet, bekommt
  einen `joinedAt`-Zeitstempel. Der älteste Teilnehmer ist Host und steuert
  Timer und Rundenlogik. Bei einem Host-Disconnect übernimmt der nächstältere
  innerhalb von Millisekunden.
- **i18n** — Das Locale-Segment der URL (`/en-GB`, `/en-US`, `/de`) wählt
  Sprache und Wörterbuch. `/` leitet auf die bevorzugte Sprache des Browsers um.

## Deployment

Das Image wird bei jedem Push auf `main` gebaut und nach GHCR gepusht. Der
Stack läuft repo-verwaltet auf dem Host:

| Punkt | Wert |
|-------|------|
| Stack-Verzeichnis | `/opt/stacks/countdown` |
| Compose-Projektname | `countdown` |
| Compose-Datei | `/opt/stacks/countdown/compose.yaml` |
| Netz | externes Docker-Netz `webnet`, statische IP `172.18.0.55` |
| Caddy | `countdown.all-the.rest` → Service-Port 3000 im Netz |
| Host-Port | keiner — der Dienst ist nur über `webnet` erreichbar |

Ausgerollt wird ausschließlich die Compose-Datei; die `.env` auf dem Host bleibt
unangetastet:

```bash
deploy/deploy.sh --dry-run   # geplante Befehle anzeigen
deploy/deploy.sh             # rsync compose.yaml + docker compose up -d --wait
```

Der Service läuft hinter dem Caddy-Reverse-Proxy unter
`countdown.all-the.rest`. Caddy erreicht ihn unter `countdown:3000` im externen
Netz `webnet` (Container-IP `172.18.0.55`); ein Host-Port wird nicht
veröffentlicht. Details stehen in
[`deploy/README.md`](deploy/README.md); Hintergrund zum Umstieg von Portainer
auf repo-verwaltete Compose-Stacks in `strato-vps/docs/plans/portainer-exit.md`.

## Lizenz

Siehe Repository.
