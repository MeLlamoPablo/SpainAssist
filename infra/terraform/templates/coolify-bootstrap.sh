#!/usr/bin/env bash
# Configures Coolify for Terraform, after cloud-init installed it on first boot; upgrades or
# (re)installs it when the running version is not COOLIFY_VERSION. Keeps Coolify's ports on
# loopback only (sa-coolify-firewall, re-applied at every boot). bootstrap.tf uploads this
# script, coolify-bootstrap.php, /usr/local/sbin/sa-coolify-firewall and /root/sa-bootstrap.env
# (the secrets), runs it as root and runs it again whenever one of them changes. Idempotent.
set -euo pipefail

ENV_FILE=/root/sa-bootstrap.env
PHP_FILE=/root/sa-bootstrap.php
trap 'rm -f "$ENV_FILE" "$PHP_FILE"' EXIT
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

log() { echo "[coolify-bootstrap] $*"; }

log "Closing Coolify's ports (8000, 6001, 6002) on every interface but loopback"
chmod 755 /usr/local/sbin/sa-coolify-firewall
cat >/etc/systemd/system/sa-coolify-firewall.service <<'UNIT'
[Unit]
Description=Keep Coolify's ports (8000, 6001, 6002) on loopback only
# In place before the network and Docker come up: no window at boot.
Before=network-pre.target docker.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/sa-coolify-firewall

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable sa-coolify-firewall.service >/dev/null 2>&1
systemctl restart sa-coolify-firewall.service

log "Waiting for cloud-init (first boot: package upgrades and the Coolify install)"
cloud-init status --wait >/dev/null || true

# Coolify's installer (and the upgrade.sh it runs) installs the requested image but always
# downloads the newest release's compose files from Coolify's CDN: 4.3.24 got 4.4's, which drop
# the coolify-realtime container that 4.3's health check needs, so it never became healthy. The
# compose files therefore come from the pinned version's git tag, and Coolify restarts with
# them whenever they or the version change (cloud-init's first install gets the CDN's too).
SOURCE=/data/coolify/source
COMPOSE_FILES="docker-compose.yml docker-compose.prod.yml"
restart=0

installed=$(docker inspect --format '{{.Config.Image}}' coolify 2>/dev/null | sed 's/.*://' || true)
if [ "$installed" != "$COOLIFY_VERSION" ]; then
  log "Installing Coolify $COOLIFY_VERSION (installed: ${installed:-none}); log: /var/log/coolify-install.log"
  curl -fsSL https://cdn.coollabs.io/coolify/install.sh -o /root/coolify-install.sh
  # Not final: it fails when the CDN's compose files don't fit this version, which the pinned
  # files below fix. If they don't, the restart below fails instead.
  if ! AUTOUPDATE=false bash /root/coolify-install.sh "$COOLIFY_VERSION" >/var/log/coolify-install.log 2>&1; then
    log "The installer failed; restarting with v$COOLIFY_VERSION's own compose files. Its log ends:"
    tail -n 20 /var/log/coolify-install.log
  fi
  restart=1
fi

# upgrade.sh starts the containers in the background and reports in .upgrade-status (step 6 or
# "error" when done; deleted shortly after). Let it finish, or it could still run `compose up`
# with the CDN's files after we replace them.
for i in $(seq 1 60); do
  status=$(cut -d'|' -f1 "$SOURCE/.upgrade-status" 2>/dev/null || true)
  if [ -z "$status" ] || [ "$status" = 6 ] || [ "$status" = error ]; then break; fi
  sleep 5
done

tmp=$(mktemp -d)
for f in $COMPOSE_FILES; do
  curl -fsSL "https://raw.githubusercontent.com/coollabsio/coolify/v$COOLIFY_VERSION/$f" -o "$tmp/$f"
  if ! cmp -s "$tmp/$f" "$SOURCE/$f"; then
    log "Using $f from Coolify's v$COOLIFY_VERSION tag"
    cat "$tmp/$f" >"$SOURCE/$f" # keeps the installer's owner and mode
    restart=1
  fi
done
rm -rf "$tmp"

# Coolify's nginx only compresses in its HTTPS mode, and it runs plain HTTP behind a proxy.
# Traefik used to gzip the dashboard; Tailscale Serve doesn't, so nginx does it here. Coolify's
# own upgrade.sh applies docker-compose.custom.yml too.
write_if_changed() { # $1: path; content on stdin
  local new
  new=$(mktemp)
  cat >"$new"
  if ! cmp -s "$new" "$1"; then
    log "Writing $1"
    cat "$new" >"$1"
    restart=1
  fi
  rm -f "$new"
}
write_if_changed "$SOURCE/nginx-gzip.conf" <<'CONF'
# Written by infra/terraform/templates/coolify-bootstrap.sh.
gzip            on;
gzip_vary       on;
gzip_proxied    any;
gzip_comp_level 6;
gzip_min_length 1024;
gzip_types      text/plain text/css text/xml application/json application/javascript application/rss+xml application/atom+xml image/svg+xml;
CONF
write_if_changed "$SOURCE/docker-compose.custom.yml" <<'YAML'
# Written by infra/terraform/templates/coolify-bootstrap.sh.
services:
  coolify:
    volumes:
      - /data/coolify/source/nginx-gzip.conf:/etc/nginx/conf.d/sa-gzip.conf:ro
YAML

if [ "$restart" = 1 ]; then
  log "Starting Coolify $COOLIFY_VERSION"
  # LATEST_IMAGE picks the coolify image's tag (the installer also writes it to .env).
  if ! LATEST_IMAGE="$COOLIFY_VERSION" docker compose --env-file "$SOURCE/.env" \
    -f "$SOURCE/docker-compose.yml" -f "$SOURCE/docker-compose.prod.yml" \
    -f "$SOURCE/docker-compose.custom.yml" \
    up -d --remove-orphans --wait --wait-timeout 600; then
    docker ps -a
    exit 1
  fi
fi

running=$(docker inspect --format '{{.Config.Image}}' coolify 2>/dev/null | sed 's/.*://' || true)
if [ "$running" != "$COOLIFY_VERSION" ]; then
  log "The coolify container runs ${running:-nothing}, not $COOLIFY_VERSION"
  exit 1
fi

log "Waiting for Coolify"
for i in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1; then break; fi
  if [ "$i" = 120 ]; then
    log "Coolify did not answer on :8000 within 10 minutes"
    docker ps -a
    exit 1
  fi
  sleep 5
done

log "Configuring root user, API token and instance settings (no instance domain)"
# Through stdin rather than `docker cp`, so the file belongs to the container's (unprivileged)
# user. It holds no secrets: those are passed as environment variables.
docker exec -u root coolify rm -f /tmp/sa-bootstrap.php
docker exec -i coolify sh -c 'cat > /tmp/sa-bootstrap.php' <"$PHP_FILE"
status=0
docker exec \
  -e SA_ROOT_EMAIL -e SA_ROOT_PASSWORD -e SA_API_TOKEN \
  coolify php artisan tinker --execute="require '/tmp/sa-bootstrap.php';" || status=$?
docker exec -u root coolify rm -f /tmp/sa-bootstrap.php
[ "$status" = 0 ] || exit "$status"

log "Checking the API token"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SA_API_TOKEN" http://127.0.0.1:8000/api/v1/version)
if [ "$code" != 200 ]; then
  log "GET /api/v1/version answered $code"
  exit 1
fi

log "Done"
