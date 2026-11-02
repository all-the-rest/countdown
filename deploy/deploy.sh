#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
SSH_TARGET="root@reisinger.pictures"
STACK_DIR="/opt/stacks/countdown"
REMOTE_COMPOSE="$STACK_DIR/compose.yaml"
RSYNC_BIN="${RSYNC_BIN:-rsync}"
CONTROL_PATH="/tmp/ssh-sync-%r@%h:%p"
SSH_OPTS=(-o ControlMaster=auto -o "ControlPath=$CONTROL_PATH" -o ControlPersist=60 -o BatchMode=yes)
RSYNC_RSH="ssh ${SSH_OPTS[*]}"

DRY_RUN=false
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=true ;;
  *)
    printf 'Usage: %s [--dry-run]\n' "$0" >&2
    exit 2
    ;;
esac

if [[ $# -gt 1 ]]; then
  printf 'Usage: %s [--dry-run]\n' "$0" >&2
  exit 2
fi

[[ -f "$COMPOSE_FILE" ]] || {
  printf 'ERROR: compose file missing: %s\n' "$COMPOSE_FILE" >&2
  exit 1
}

# Only the compose file is shipped. The host keeps its own .env
# (root:root 0600); it is never created, overwritten or synced from here.
REMOTE_PREFLIGHT="if [ ! -d '$STACK_DIR' ]; then echo 'ERROR: stack directory missing: $STACK_DIR' >&2; exit 1; fi"
REMOTE_UP="cd '$STACK_DIR' && docker compose -f '$REMOTE_COMPOSE' up -d --wait"

print_command() {
  printf '  '
  printf '%q ' "$@"
  printf '\n'
}

if [[ "$DRY_RUN" == true ]]; then
  printf 'Dry-run: no connection, no changes on the host. Planned commands:\n'
  print_command ssh "${SSH_OPTS[@]}" -T "$SSH_TARGET" "$REMOTE_PREFLIGHT"
  print_command "$RSYNC_BIN" --archive --no-owner --no-group --rsh="$RSYNC_RSH" -- "$COMPOSE_FILE" "$SSH_TARGET:$REMOTE_COMPOSE"
  print_command ssh "${SSH_OPTS[@]}" -T "$SSH_TARGET" "$REMOTE_UP"
  exit 0
fi

printf 'Checking stack directory on %s ...\n' "$SSH_TARGET"
ssh "${SSH_OPTS[@]}" -T "$SSH_TARGET" "$REMOTE_PREFLIGHT"

printf 'Syncing deploy/docker-compose.yml only (host .env stays untouched) ...\n'
"$RSYNC_BIN" --archive --no-owner --no-group --rsh="$RSYNC_RSH" -- "$COMPOSE_FILE" "$SSH_TARGET:$REMOTE_COMPOSE"

printf 'Updating stack %s ...\n' "$STACK_DIR"
ssh "${SSH_OPTS[@]}" -T "$SSH_TARGET" "$REMOTE_UP"

printf 'Deploy finished.\n'
