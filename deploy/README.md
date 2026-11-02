# Countdown-Deployment

Der Stack wird aus diesem Repository heraus verwaltet: `deploy/deploy.sh`
synchronisiert die Compose-Datei auf den Host und rollt sie dort per
`docker compose up -d --wait` aus. Portainer ist nicht mehr Teil des Wegs.
Hintergrund und Migration: `strato-vps/docs/plans/portainer-exit.md`.

## Zielbild

| Punkt | Wert |
|---|---|
| Image | `ghcr.io/reisi007/countdown:latest` |
| Stack-Verzeichnis (Host) | `/opt/stacks/countdown` |
| Compose-Projektname | `countdown` (ergibt sich aus dem Verzeichnisnamen) |
| Compose-Datei (Host) | `/opt/stacks/countdown/compose.yaml` |
| Secret-Datei (Host) | `/opt/stacks/countdown/.env`, `root:root 0600` |
| Docker-Netz | `webnet` (extern, vom Proxy-Stack angelegt) |
| Statische IP | `172.18.0.55` |
| Caddy | `countdown.all-the.rest` → `countdown:3000` (Container-IP `172.18.0.55`) |
| Host-Port | keiner — der Dienst ist nur über `webnet` erreichbar |

## Voraussetzungen

- Docker mit Compose-Plugin auf dem Host, `root`-SSH-Zugang zu
  `root@reisinger.pictures` per Key (`BatchMode`, keine Passwort-Abfrage).
- `rsync` lokal und auf dem Host.
- Das externe Netz `webnet` existiert (Proxy-Stack läuft) und die IP
  `172.18.0.55` ist frei.
- Das Stack-Verzeichnis `/opt/stacks/countdown` existiert. Es wird **nicht**
  vom Skript angelegt.

## Deploy

```bash
cd deploy
./deploy.sh --dry-run   # zeigt nur die geplanten Befehle, keine Verbindung
./deploy.sh             # rsync + docker compose up -d --wait
```

Was das Skript tut:

1. prüft, ob `deploy/docker-compose.yml` lokal vorhanden ist,
2. prüft per SSH, ob `/opt/stacks/countdown` auf dem Host existiert,
3. überträgt **ausschließlich** `deploy/docker-compose.yml` per `rsync` nach
   `/opt/stacks/countdown/compose.yaml`,
4. führt auf dem Host `docker compose -f /opt/stacks/countdown/compose.yaml up -d --wait` aus.

Was es bewusst nicht tut:

- kein `docker compose down`, kein `--build`, kein `pull` — laufende Container
  werden nur ersetzt, wenn sich die Service-Definition geändert hat,
- keine `.env` anfassen: die Host-Datei wird weder aus dem Repo erzeugt noch
  überschrieben noch mit-synchronisiert (sie bleibt die einzige Secret-Kopie und
  liegt nicht im Git),
- keine weiteren Dateien übertragen (kein `--delete`, kein Verzeichnis-Sync).

Die SSH-Verbindung nutzt einen ControlMaster
(`ControlMaster=auto`, `ControlPath=/tmp/ssh-sync-%r@%h:%p`,
`ControlPersist=60`), analog zu `caddyfile/sync.sh`. Dadurch teilen sich
Vorab-Prüfung, `rsync` und der Compose-Aufruf eine Verbindung.

## Netzwerk und Caddy

Der Container hängt am externen Docker-Netz `webnet` und hat dort die feste IP
`172.18.0.55`. Caddy läuft im selben Netz und proxyt
`countdown.all-the.rest` auf `countdown:3000`; der Containername löst im Netz
auf die statische IP auf. Ein Host-Port wird nicht veröffentlicht: der Dienst
ist ausschließlich über `webnet` erreichbar, nach außen geht nur Caddy.

## CI/CD

Ein Push auf `main` baut nach grünen Tests das Image und pusht es nach GHCR
(`.github/workflows/build.yml`). Das Skript rollt Compose-Änderungen aus; ein
Image-Pull oder -Build ist nicht Bestandteil des Deploy-Skripts.

## Umgebung

| Variable | Default | Beschreibung |
|---|---|---|
| `NODE_ENV` | `production` | Node-Umgebung, direkt in der Compose-Datei gesetzt |

Weitere Variablen gibt es derzeit nicht; die hostseitige `.env` kann daher leer
bleiben. Sie wird ausschließlich auf dem Host gepflegt und nie aus dem Repo
erzeugt, überschrieben oder mit-synchronisiert.

## Fehlersuche

```bash
ssh root@reisinger.pictures 'docker compose -f /opt/stacks/countdown/compose.yaml ps'
ssh root@reisinger.pictures 'docker compose -f /opt/stacks/countdown/compose.yaml logs -f countdown'
curl -fsS https://countdown.all-the.rest/ >/dev/null && echo OK
```
