#!/usr/bin/env bash
# Moves the public site to a new host name without a gap. Run on the server as root or `deploy`, from /opt/tip:
#
#   scripts/change-domain.sh add NEW      # step 1: serve NEW as well; Caddy gets its certificate once DNS points here
#   scripts/change-domain.sh switch NEW   # step 2: NEW becomes the primary host, the previous one only redirects to it
#
# `add` is safe to run before DNS exists: the old host keeps working and Caddy keeps retrying for the new one.
# `switch` refuses to run until NEW resolves to this machine and answers over HTTPS with a certificate.
# Nothing here touches secrets; prod.env is backed up first (prod.env.bak-before-domain).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=lib.sh
source scripts/lib.sh
set_images "$(read_state .image_base)" "$(read_state .current_tag)"

mode="${1:-}"
new="${2:-}"
[[ $mode == add || $mode == switch ]] || die "usage: change-domain.sh add|switch NEW_DOMAIN"
[[ $new =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || die "NEW_DOMAIN must be a lower case host name"
[[ -f prod.env ]] || die "prod.env is missing (run from /opt/tip)"

env_get() { sed -n "s/^$1=//p" prod.env | head -n1; }
env_set() { # key value: replaces the line or appends it, keeping the file's mode
  if grep -q "^$1=" prod.env; then
    sed -i "s|^$1=.*|$1=$2|" prod.env
  else
    printf '%s=%s\n' "$1" "$2" >>prod.env
  fi
}

old="$(env_get DOMAIN)"
[[ -n $old ]] || die "DOMAIN is not set in prod.env"
[[ $old != "$new" ]] || die "DOMAIN is already $new"
origins="$(env_get ALLOWED_ORIGINS)"
cp -p prod.env prod.env.bak-before-domain

reload_edge() {
  # Caddy and Grafana read DOMAIN from their environment, so they are recreated (the volumes keep certificates and data).
  local svcs=(caddy)
  if compose config --services | grep -qx grafana; then svcs+=(grafana); fi
  # tipd learns the allowed origins from the same file.
  compose up -d --no-deps --force-recreate "${svcs[@]}" tipd
}

if [[ $mode == add ]]; then
  env_set DOMAIN_ALIASES "$new"
  case ",$origins," in *",https://$new,"*) ;; *) env_set ALLOWED_ORIGINS "${origins:+$origins,}https://$new" ;; esac
  reload_edge
  log "serving $new next to $old. Once DNS for $new points to this server Caddy issues the certificate on its own;"
  log "run '$0 switch $new' when https://$new answers."
  exit 0
fi

# switch: DNS and certificate must be in place first, or visitors would be redirected to a dead address.
resolved="$(getent hosts "$new" | awk '{print $1; exit}' || true)"
mine="$(getent hosts "$old" | awk '{print $1; exit}' || true)"
[[ -n $resolved ]] || die "$new does not resolve yet; the zone may not be delegated"
[[ -z $mine || $resolved == "$mine" ]] || die "$new resolves to $resolved but $old resolves to $mine"
curl -fsS -m 10 --resolve "$new:443:127.0.0.1" -o /dev/null "https://$new/readyz" ||
  die "https://$new does not answer with a trusted certificate yet (check: docker logs tip-caddy-1)"

env_set DOMAIN "$new"
env_set DOMAIN_ALIASES "$old"
env_set DOMAIN_REDIRECT_HOSTS "$old"
if [[ -n $(env_get GRAFANA_URL) ]]; then env_set GRAFANA_URL "https://$new/grafana/"; fi
case ",$origins," in *",https://$new,"*) ;; *) env_set ALLOWED_ORIGINS "https://$new,${origins}" ;; esac
reload_edge
curl -fsS -m 10 --resolve "$new:443:127.0.0.1" -o /dev/null "https://$new/readyz" || die "the new primary does not answer"
log "$new is the primary host; $old redirects to it. Sessions are per host: everybody signs in once on $new."
log "Remember: GitHub secret DEPLOY_HOST (and DEPLOY_KNOWN_HOSTS) if the deploy should reach the server by the new name."
