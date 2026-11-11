#!/usr/bin/env bash
# Deploys one image tag of the TIP stack on the server (run by CI as the `deploy` user in /opt/tip).
#
#   IMAGE_BASE=ghcr.io/owner/repo [REGISTRY_USER=name] scripts/deploy.sh <tag>
#
# With REGISTRY_USER set, a registry token is read from stdin and the login is removed again on exit.
# Order: pull -> start Postgres/Redis -> migrate with the NEW image (a failure aborts, nothing is swapped)
# -> swap the stack -> wait for /readyz -> on failure go back to the previous tag. Safe to re-run.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib.sh
source scripts/lib.sh

TAG="${1:-}"
[[ $TAG =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || die "usage: IMAGE_BASE=<registry/path> deploy.sh <tag>"
IMAGE_BASE="${IMAGE_BASE:-}"
[[ $IMAGE_BASE =~ ^[a-z0-9._:/-]+$ ]] || die "IMAGE_BASE must look like ghcr.io/owner/repo (lower case)"
[[ -f prod.env ]] || die "prod.env is missing: run bootstrap-server.sh first"

take_lock

REGISTRY="${IMAGE_BASE%%/*}"
if [[ -n ${REGISTRY_USER:-} ]]; then
  docker login "$REGISTRY" -u "$REGISTRY_USER" --password-stdin >/dev/null
  trap 'docker logout "$REGISTRY" >/dev/null 2>&1 || true' EXIT
fi

prev="$(read_state .current_tag)"
prev_base="$(read_state .image_base)"

compose_logs() { compose logs --no-color --tail 30 tipd 2>&1 || true; }

set_images "$IMAGE_BASE" "$TAG"
compose config -q
log "pulling $TAG"
compose pull

# The database and Redis do not depend on the new image; migrations need the database up.
compose up -d --wait postgres redis

log "migrating with $TAG"
compose run --rm --no-deps -T tipd migrate || die "migration failed; the running version was not touched"

log "swapping the stack to $TAG"

# A failing `up` (daemon error, bad image) is handled like an unhealthy start: it falls through to the rollback.
if ! { compose up -d --remove-orphans && wait_healthy; }; then
  log "new version did not start or did not become healthy within ${HEALTH_TIMEOUT}s"
  compose_logs
  if [[ -z $prev || $prev == "$TAG" || -z $prev_base ]]; then
    die "nothing to roll back to (first deploy or same tag); leaving the stack as it is"
  fi
  log "rolling back to $prev"
  set_images "$prev_base" "$prev"
  compose up -d --remove-orphans || die "rollback to $prev failed to start; manual attention needed"
  wait_healthy || die "rollback to $prev is not healthy either; manual attention needed"
  printf '%s\n' "$TAG" >.failed_tag
  die "deploy of $TAG failed, rolled back to $prev"
fi

if [[ -n $prev && $prev != "$TAG" ]]; then printf '%s\n' "$prev" >.previous_tag; fi
printf '%s\n' "$TAG" >.current_tag
printf '%s\n' "$IMAGE_BASE" >.image_base
rm -f .failed_tag

# Keep the current and the previous tag of our own images (rollback), remove the rest. Other projects' images
# and dangling layers are left alone: this host is shared.
keep_prev="$(read_state .previous_tag)"
for repo in tipd backup; do
  docker image ls "$IMAGE_BASE/$repo" --format '{{.Tag}}' | while read -r t; do
    if [[ $t != "$TAG" && $t != "$keep_prev" && $t != "<none>" ]]; then
      docker rmi "$IMAGE_BASE/$repo:$t" >/dev/null 2>&1 || true
    fi
  done
done

# The nginx site is root-owned and installed by bootstrap-server.sh; only warn when it drifted from the repository.
domain="$(sed -n 's/^DOMAIN=//p' prod.env | head -n1)"
if [[ -n $domain && -f nginx/tip.conf && -f /etc/nginx/sites-available/tip.conf ]]; then
  if ! sed "s/__DOMAIN__/$domain/g" nginx/tip.conf | cmp -s - /etc/nginx/sites-available/tip.conf; then
    log "WARNING: /etc/nginx/sites-available/tip.conf differs from nginx/tip.conf; ask root to run bootstrap-server.sh --nginx-only"
  fi
fi

log "deployed $TAG (previous: ${keep_prev:-none})"
compose ps --format 'table {{.Service}}\t{{.Status}}'
df -h / | tail -n 1
