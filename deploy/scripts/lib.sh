# shellcheck shell=bash
# Helpers shared by deploy.sh and rollback.sh. Sourced from the application directory (/opt/tip on the server).

PROJECT="${TIP_PROJECT:-tip}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() {
  log "ERROR: $*" >&2
  exit 1
}

# One place that knows which compose file makes up the server stack. TIP_COMPOSE_EXTRA is a hook for rehearsals only
# (an extra compose file, for example to remap the published ports on a machine where 80/443 are taken).
compose() {
  local extra=()
  if [[ -n ${TIP_COMPOSE_EXTRA:-} ]]; then extra=(-f "$TIP_COMPOSE_EXTRA"); fi
  docker compose -p "$PROJECT" -f docker-compose.prod.yml "${extra[@]}" --env-file prod.env "$@"
}

# Pins the images of the services we build ourselves; the compose file reads these two variables.
set_images() {
  TIPD_IMAGE="$1/tipd:$2"
  BACKUP_IMAGE="$1/backup:$2"
  export TIPD_IMAGE BACKUP_IMAGE
}

# A request through Caddy to tipd, over the plain-HTTP probe listener inside the caddy container (see Caddyfile).
# It does not depend on the certificate, which Caddy may still be obtaining right after the first start.
probe_edge() {
  compose exec -T caddy wget -q -T 5 -O - http://127.0.0.1:8081/readyz >/dev/null 2>&1
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
