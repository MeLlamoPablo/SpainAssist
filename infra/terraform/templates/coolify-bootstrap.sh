#!/usr/bin/env bash
# Configures Coolify for Terraform, after cloud-init installed it on first boot; upgrades or
# (re)installs it when the running version is not COOLIFY_VERSION. bootstrap.tf uploads this
# script, coolify-bootstrap.php and /root/sa-bootstrap.env (the secrets), runs it as root and
# runs it again whenever one of them changes. Idempotent.
set -euo pipefail

ENV_FILE=/root/sa-bootstrap.env
PHP_FILE=/root/sa-bootstrap.php
trap 'rm -f "$ENV_FILE" "$PHP_FILE"' EXIT
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

log() { echo "[coolify-bootstrap] $*"; }

log "Waiting for cloud-init (first boot: package upgrades and the Coolify install)"
cloud-init status --wait >/dev/null || true

installed=$(docker inspect --format '{{.Config.Image}}' coolify 2>/dev/null | sed 's/.*://' || true)
if [ "$installed" != "$COOLIFY_VERSION" ]; then
  log "Installing Coolify $COOLIFY_VERSION (installed: ${installed:-none}); log: /var/log/coolify-install.log"
  curl -fsSL https://cdn.coollabs.io/coolify/install.sh -o /root/coolify-install.sh
  if ! AUTOUPDATE=false bash /root/coolify-install.sh "$COOLIFY_VERSION" >/var/log/coolify-install.log 2>&1; then
    tail -n 40 /var/log/coolify-install.log
    exit 1
  fi
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

log "Configuring root user, API token and instance domain ($SA_COOLIFY_URL)"
# Through stdin rather than `docker cp`, so the file belongs to the container's (unprivileged)
# user. It holds no secrets: those are passed as environment variables.
docker exec -u root coolify rm -f /tmp/sa-bootstrap.php
docker exec -i coolify sh -c 'cat > /tmp/sa-bootstrap.php' <"$PHP_FILE"
status=0
docker exec \
  -e SA_ROOT_EMAIL -e SA_ROOT_PASSWORD -e SA_API_TOKEN -e SA_COOLIFY_URL \
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
