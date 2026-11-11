#!/usr/bin/env bash
# One-time preparation of the shared production server for TIP. Run as root, copied together with the
# repository's deploy/ directory:
#
#   scripts/bootstrap-server.sh --dry-run --domain D --email E --expect-hostname H --deploy-key-file K
#   scripts/bootstrap-server.sh           --domain D --email E --expect-hostname H --deploy-key-file K [--staging]
#
# What it changes (and nothing else; other projects, certificates and sites on the host are left alone):
#   1. apt: nginx and certbot, only if missing.
#   2. user `deploy` (docker group, no password, no sudo) with the given public key (restricted options).
#   3. /opt/tip (owned by deploy) and /opt/tip/prod.env with secrets generated here (mode 600, never printed).
#   4. /etc/nginx/sites-available/tip.conf (+ symlink in sites-enabled), certificate for DOMAIN only (webroot).
# It opens no other port, does not touch swap/zram/kernel settings and asks no questions.
#
# Flags: --nginx-only   re-install the nginx site only (after nginx/tip.conf changed), step 4
#        --staging      Let's Encrypt staging certificate first (rerun without it for the real one)
#        --force        allow an existing /opt/tip (never overwrites an existing prod.env)
set -euo pipefail

DOMAIN="" EMAIL="" EXPECT_HOST="" KEY_FILE="" DRY=0 STAGING=0 FORCE=0 NGINX_ONLY=0
APP_DIR=/opt/tip
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NGINX_SRC="$HERE/../nginx/tip.conf"
SITE=/etc/nginx/sites-available/tip.conf
WEBROOT=/var/www/certbot

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}
say() { printf '%s\n' "$*"; }
run() {
  if ((DRY)); then printf '  + %s\n' "$*"; else "$@"; fi
}

while (($#)); do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --expect-hostname) EXPECT_HOST="${2:-}"; shift 2 ;;
    --deploy-key-file) KEY_FILE="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --staging) STAGING=1; shift ;;
    --force) FORCE=1; shift ;;
    --nginx-only) NGINX_ONLY=1; shift ;;
    *) die "unknown flag: $1" ;;
  esac
done

[[ $DOMAIN =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || die "--domain is required (lower case host name)"
[[ $EMAIL =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] || die "--email is required (Let's Encrypt notices)"
[[ -n $EXPECT_HOST ]] || die "--expect-hostname is required (guard against the wrong machine)"
if ((!NGINX_ONLY)); then
  [[ -f $KEY_FILE ]] || die "--deploy-key-file must point to the deploy PUBLIC key"
  ssh-keygen -l -f "$KEY_FILE" >/dev/null 2>&1 || die "$KEY_FILE is not a valid public key"
fi
[[ -f $NGINX_SRC ]] || die "nginx/tip.conf not found next to the scripts directory"

# --- preflight (read-only) -------------------------------------------------------------------------------
((DRY)) || [[ $(id -u) -eq 0 ]] || die "run as root"
[[ $(hostname) == "$EXPECT_HOST" ]] || die "this host is '$(hostname)', expected '$EXPECT_HOST'; refusing to continue"
command -v docker >/dev/null || die "docker is not installed (this script does not install it)"
docker compose version >/dev/null 2>&1 || die "docker compose plugin is missing"
if ((!NGINX_ONLY)) && [[ -e $APP_DIR ]] && ((!FORCE)); then
  die "$APP_DIR already exists; use --force to continue (an existing prod.env is never overwritten)"
fi
for port in 80 443; do
  holder="$(ss -ltnpH "( sport = :$port )" 2>/dev/null | head -n1 || true)"
  if [[ $holder == *'users:('* && $holder != *nginx* ]]; then
    die "port $port is held by something other than nginx: $holder"
  fi
done
resolved="$(getent hosts "$DOMAIN" | awk '{print $1; exit}' || true)"
if [[ -z $resolved ]] || ! hostname -I | tr ' ' '\n' | grep -qx "$resolved"; then
  say "NOTE: $DOMAIN resolves to '${resolved:-nothing}', which is not an address of this host; the certificate will fail unless DNS points here."
fi

say "Plan for $(hostname) (domain $DOMAIN, dry-run=$DRY, staging=$STAGING, nginx-only=$NGINX_ONLY):"
say "  - install nginx / certbot via apt if missing"
if ((!NGINX_ONLY)); then
  say "  - create user deploy (docker group, no sudo) and authorize $KEY_FILE"
  say "  - create $APP_DIR and $APP_DIR/prod.env (generated secrets, mode 600) if it does not exist"
fi
say "  - install $SITE for $DOMAIN only, certificate via certbot webroot (lineage $DOMAIN), reload nginx"
say ""

# --- 1. packages -------------------------------------------------------------------------------------------
if ! command -v nginx >/dev/null; then
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y nginx
fi
if ! command -v certbot >/dev/null; then
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y certbot
fi
if ((!DRY)); then
  grep -qs 'sites-enabled' /etc/nginx/nginx.conf || die "/etc/nginx/nginx.conf does not include sites-enabled/*"
fi

# --- 2. deploy user and directory ------------------------------------------------------------------------------
if ((!NGINX_ONLY)); then
  if ! id deploy >/dev/null 2>&1; then
    # No password is set, so the account is locked for password logins; the key below is the only way in.
    run useradd --create-home --shell /bin/bash --groups docker deploy
  else
    run usermod --append --groups docker deploy
  fi
  run install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
  # No pty, no forwarding: the key can only run commands.
  key_line="no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $(tr -d '\r\n' <"$KEY_FILE")"
  if ((DRY)); then
    say "  + add the deploy public key to /home/deploy/.ssh/authorized_keys (restricted options)"
  else
    touch /home/deploy/.ssh/authorized_keys
    grep -qxF "$key_line" /home/deploy/.ssh/authorized_keys || printf '%s\n' "$key_line" >>/home/deploy/.ssh/authorized_keys
    chown deploy:deploy /home/deploy/.ssh/authorized_keys
    chmod 600 /home/deploy/.ssh/authorized_keys
  fi
  run install -d -m 750 -o deploy -g deploy "$APP_DIR" "$APP_DIR/secrets"

  # --- 3. prod.env (secrets stay on the server) ------------------------------------------------------------------------
  if [[ -e $APP_DIR/prod.env ]]; then
    say "  = $APP_DIR/prod.env exists, left untouched"
  elif ((DRY)); then
    say "  + generate $APP_DIR/prod.env with random secrets (mode 600)"
  else
    hex() { openssl rand -hex "$1"; }
    (
      umask 077
      cat >"$APP_DIR/prod.env" <<EOF
# Generated by bootstrap-server.sh on $(date -u +%F). Secrets live only here; do not copy this file into git.
DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
ALLOWED_ORIGINS=https://$DOMAIN
EDGE_PORT=8080

JWT_ACCESS_SECRET=$(hex 32)
JWT_REFRESH_SECRET=$(hex 32)
PASSWORD_PEPPER=$(hex 32)
BOOTSTRAP_ADMIN_LOGIN=admin
BOOTSTRAP_ADMIN_PASSWORD=$(hex 12)
FORCE_PASSWORD_CHANGE=true
SWAGGER_ENABLED=false
REDIS_FAIL_MODE=open
LOG_LEVEL=info
AUTO_MIGRATE=true

POSTGRES_DB=tip
POSTGRES_USER=tip
POSTGRES_PASSWORD=$(hex 24)
REDIS_PASSWORD=$(hex 24)

OBS_RETENTION_DAYS=3
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=$(hex 16)
BACKUP_CRON=30 1 * * *
BACKUP_KEEP=3
BACKUP_MIN_FREE_MB=1500
BACKUP_REMOTE=
EOF
    )
    chown deploy:deploy "$APP_DIR/prod.env"
    chmod 600 "$APP_DIR/prod.env"
    say "  + wrote $APP_DIR/prod.env (not printed)"
  fi
fi

# --- 4. nginx site and certificate -------------------------------------------------------------------------------------
install_site() { # file with the final config
  local src="$1" backup=""
  if ((DRY)); then
    say "  + install $SITE from $src (nginx -t before reload, previous file restored on failure)"
    return
  fi
  [[ -f $SITE ]] && backup="$(mktemp)" && cp "$SITE" "$backup"
  cp "$src" "$SITE"
  ln -sf "$SITE" /etc/nginx/sites-enabled/tip.conf
  if ! nginx -t; then
    if [[ -n $backup ]]; then cp "$backup" "$SITE"; else rm -f "$SITE" /etc/nginx/sites-enabled/tip.conf; fi
    die "nginx -t failed; the previous configuration was restored"
  fi
  systemctl enable nginx >/dev/null 2>&1 || true
  if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl start nginx; fi
}

cert_dir="/etc/letsencrypt/live/$DOMAIN"
want_cert=1
force_renew=()
if [[ -f $cert_dir/fullchain.pem ]]; then
  if openssl x509 -in "$cert_dir/fullchain.pem" -noout -issuer 2>/dev/null | grep -qi 'staging'; then
    if ((STAGING)); then want_cert=0; else force_renew=(--force-renewal); fi
  else
    want_cert=0
  fi
fi

run install -d -m 755 "$WEBROOT"
if ((want_cert)); then
  # Challenge-only site first: the final config needs the certificate files to exist.
  http_conf="$(mktemp)"
  cat >"$http_conf" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 503; }
}
EOF
  install_site "$http_conf"
  rm -f "$http_conf"
  stage_flag=()
  if ((STAGING)); then stage_flag=(--staging); fi
  run certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --cert-name "$DOMAIN" \
    --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring \
    --deploy-hook "systemctl reload nginx" "${stage_flag[@]}" "${force_renew[@]}"
else
  say "  = certificate for $DOMAIN already present"
fi

final="$(mktemp)"
sed "s/__DOMAIN__/$DOMAIN/g" "$NGINX_SRC" >"$final"
if ((DRY)) && [[ ! -f $cert_dir/fullchain.pem ]]; then
  say "  (dry-run: the final nginx config is installed only after the certificate exists)"
fi
install_site "$final"
rm -f "$final"

# --- done ---------------------------------------------------------------------------------------------------------------
say ""
say "Done. Next steps (no secrets are shown here):"
say "  1. Read the first admin password when you need it:  grep BOOTSTRAP_ADMIN_PASSWORD $APP_DIR/prod.env"
say "     (the password change is forced at the first login, FORCE_PASSWORD_CHANGE=true)"
say "  2. Run the GitHub Actions workflow 'cd' (see docs/08-ci-cd.md); it copies the compose files and deploys."
if ((STAGING)); then say "  3. The certificate is from Let's Encrypt STAGING: rerun this script without --staging to get the real one."; fi
say "NOTE (not changed here): on a 2 GB host consider zram (apt install zram-tools) and vm.swappiness=10."
