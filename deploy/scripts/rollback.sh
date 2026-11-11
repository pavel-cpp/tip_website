#!/usr/bin/env bash
# Returns the stack to an earlier image tag (default: the previous successful one). Run as `deploy` in /opt/tip.
#
#   scripts/rollback.sh [tag]
#
# Database migrations are NOT reverted: migrations must stay backward compatible with the previous version.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib.sh
source scripts/lib.sh

[[ -f prod.env ]] || die "prod.env is missing"
take_lock

base="$(read_state .image_base)"
cur="$(read_state .current_tag)"
target="${1:-$(read_state .previous_tag)}"
[[ -n $base && -n $target ]] || die "no previous tag recorded; pass one: rollback.sh <tag>"
[[ $target =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || die "bad tag"
[[ $target != "$cur" ]] || die "$target is already the running tag"

for repo in tipd backup; do
  docker image inspect "$base/$repo:$target" >/dev/null 2>&1 ||
    die "$base/$repo:$target is not on this host (older tags are pruned); redeploy that commit from CI instead"
done

log "rolling back $cur -> $target"
set_images "$base" "$target"
compose up -d --no-build --remove-orphans
wait_healthy || die "$target is not healthy; check: docker compose -p $PROJECT logs tipd"

printf '%s\n' "$target" >.current_tag
if [[ -n $cur ]]; then printf '%s\n' "$cur" >.previous_tag; fi
log "now running $target"
