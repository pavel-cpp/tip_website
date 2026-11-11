# shellcheck shell=bash
# Helpers shared by deploy.sh and rollback.sh. Sourced from the application directory (/opt/tip on the server).

PROJECT="${TIP_PROJECT:-tip}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
EDGE_PORT="${EDGE_PORT:-8080}"
export EDGE_PORT
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${EDGE_PORT}/readyz}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() {
  log "ERROR: $*" >&2
  exit 1
}

# One place that knows which compose files make up the server stack.
compose() {
  docker compose -p "$PROJECT" -f docker-compose.prod.yml -f docker-compose.server.yml --env-file prod.env "$@"
}

# Pins the images of the services we build ourselves; the compose files read these two variables.
set_images() {
  TIPD_IMAGE="$1/tipd:$2"
  BACKUP_IMAGE="$1/backup:$2"
  export TIPD_IMAGE BACKUP_IMAGE
}

probe_edge() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 5 -o /dev/null "$HEALTH_URL"
  else
    wget -q -T 5 -O /dev/null "$HEALTH_URL"
  fi
}

# Healthy = tipd's own /readyz probe passes inside the container AND the request gets through Caddy.
wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while ((SECONDS < deadline)); do
    if compose exec -T tipd /tipd healthcheck >/dev/null 2>&1 && probe_edge; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# Only one deploy or rollback at a time.
take_lock() {
  exec 9>.deploy.lock
  flock -n 9 || die "another deploy or rollback is running"
}

read_state() { # file; empty when missing
  if [[ -f $1 ]]; then tr -d '[:space:]' <"$1"; fi
}
