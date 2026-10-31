#!/usr/bin/env bash
# JusPol EDRMS — install or update one environment on an Ubuntu server.
#
#   sudo deploy/install.sh install --env staging --domain edrms-test.juspol.sr \
#        --port 4611 --release juspol-edrms-0.4.0.tar.gz [--email ict@juspol.sr] [--no-tls]
#   sudo deploy/install.sh status  --env staging
#
# Shared-server rule: the script only creates and changes its own names — the
# service user juspol-<env>, the folder /opt/juspol/<env>, the settings folder
# /etc/juspol/<env>, the unit juspol-api-<env>.service and one nginx site file
# that starts with its marker line. It checks before it creates, never edits
# another site, and stops at the first problem with a clear message.
#
# Safe to run again: an existing settings file is kept; a failed certificate is
# retried on the next run; a new version that does not start is rolled back.
#
# The release is made with deploy/pack.sh (built backend and frontend, no
# secrets). The AI key is asked hidden and written only to the settings file.
set -Eeuo pipefail
umask 027

# Paths can be moved for the stubbed test (deploy/test-install.sh); never on a real server.
PREFIX="${JUSPOL_PREFIX:-}"
OPT="$PREFIX/opt/juspol"
ETC="$PREFIX/etc/juspol"
SYSTEMD_DIR="$PREFIX/etc/systemd/system"
NGINX_AVAILABLE="$PREFIX/etc/nginx/sites-available"
NGINX_ENABLED="$PREFIX/etc/nginx/sites-enabled"
NGINX_CONFD="$PREFIX/etc/nginx/conf.d"
HEALTH_WAIT="${JUSPOL_HEALTH_WAIT:-60}"

STEP=0
step() { STEP=$((STEP + 1)); printf '\n[%d] %s\n' "$STEP" "$*"; }
die() { printf '\n=== STOPPED: %s\n' "$*" >&2; exit 1; }
trap 'die "unexpected error on line $LINENO (nothing else was changed after this step)"' ERR

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

ACTION="${1:-}"
[[ "$ACTION" == "install" || "$ACTION" == "status" ]] || usage
shift
ENV_NAME="" DOMAIN="" PORT="" RELEASE="" EMAIL="" TLS=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --release) RELEASE="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --no-tls) TLS=0; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

# ------------------------------------------------------------------ validation (no shell injection)
[[ "$ENV_NAME" =~ ^(staging|production)$ ]] || die "--env must be staging or production"
USER_NAME="juspol-$ENV_NAME"
UNIT="juspol-api-$ENV_NAME.service"
APP_DIR="$OPT/$ENV_NAME"
SETTINGS_DIR="$ETC/$ENV_NAME"
SETTINGS="$SETTINGS_DIR/settings.env"
MARKER="# managed-by: juspol-edrms $ENV_NAME"

health() { curl -fsS --max-time 5 "$1" 2>/dev/null; }

# Settings are read and written with shell builtins only, so no value (key,
# password) ever appears on a command line or in the process list.
get_setting() { # file key
  local line
  [[ -f "$1" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$2="* ]]; then printf '%s' "${line#*=}"; return 0; fi
  done < "$1"
}
put_setting() { # file key value
  local file="$1" k="$2" v="$3" line found=0 tmp="$1.tmp"
  : > "$tmp"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$k="* ]]; then printf '%s=%s\n' "$k" "$v" >> "$tmp"; found=1; else printf '%s\n' "$line" >> "$tmp"; fi
  done < "$file"
  [[ $found -eq 1 ]] || printf '%s=%s\n' "$k" "$v" >> "$tmp"
  mv "$tmp" "$file"
}

if [[ "$ACTION" == "status" ]]; then
  step "Service $UNIT"
  systemctl --no-pager status "$UNIT" | head -n 5 || true
  step "Last log lines"
  journalctl -u "$UNIT" -n 15 --no-pager 2>/dev/null || true
  step "Health"
  if [[ ! -f "$SETTINGS" ]]; then echo "not installed ($SETTINGS does not exist)"; exit 0; fi
  port="$(get_setting "$SETTINGS" PORT)"
  health "http://127.0.0.1:${port:-0}/api/v1/health" || echo "not answering"
  echo
  echo "Version: $(readlink "$APP_DIR/current" 2>/dev/null || echo none); previous: $(readlink "$APP_DIR/previous" 2>/dev/null || echo none)"
  exit 0
fi

[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] || die "--domain is not a valid host name: $DOMAIN"
[[ "$PORT" =~ ^[0-9]{4,5}$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || die "--port must be a number from 1024 to 65535"
[[ -f "$RELEASE" ]] || die "release file not found: $RELEASE"
[[ -z "$EMAIL" || "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "--email is not an e-mail address"
[[ $TLS -eq 0 || -n "$EMAIL" ]] || die "--email is needed for the certificate (or use --no-tls)"
NGINX_SITE="$NGINX_AVAILABLE/juspol-$ENV_NAME.conf"

echo "JusPol EDRMS — $ACTION $ENV_NAME on https://$DOMAIN (port $PORT)"

# ------------------------------------------------------------------ checks before anything is created
step "Checking that $DOMAIN and port $PORT are not used by another site"
for dir in "$NGINX_ENABLED" "$NGINX_CONFD" "$NGINX_AVAILABLE"; do
  [[ -d "$dir" ]] || continue
  while IFS= read -r file; do
    [[ "$file" -ef "$NGINX_SITE" ]] && continue
    head -n 1 "$file" | grep -qxF "$MARKER" && continue
    die "the address $DOMAIN is already used by another site ($file). Nothing was installed."
  done < <(grep -rlE "server_name[^;]*[[:space:]]$DOMAIN([[:space:];]|$)" "$dir" 2>/dev/null || true)
done
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$PORT\$"; then
  [[ "$(get_setting "$SETTINGS" PORT)" == "$PORT" ]] || die "port $PORT is already in use by another program. Nothing was installed."
fi
echo "ok"

step "Reading the release"
WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap 'cleanup' EXIT
tar -xzf "$RELEASE" -C "$WORK"
[[ -f "$WORK/backend/dist/main.js" && -f "$WORK/frontend/dist/index.html" && -f "$WORK/VERSION" ]] || die "the release is incomplete (backend/dist, frontend/dist and VERSION expected)"
VERSION="$(tr -cd '0-9A-Za-z.+-' < "$WORK/VERSION")"
[[ -n "$VERSION" ]] || die "the release has no version"
if grep -rqsE 'AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----' "$WORK"; then
  die "the release contains what looks like a key or private key. Rebuild it with deploy/pack.sh."
fi
echo "version $VERSION"

# ------------------------------------------------------------------ service user and folders
step "Service user $USER_NAME"
if id "$USER_NAME" >/dev/null 2>&1; then echo "exists"; else useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"; echo "created"; fi
install -d -m 750 -o root -g "$USER_NAME" "$SETTINGS_DIR"
install -d -m 755 "$APP_DIR" "$APP_DIR/releases"
install -d -m 750 -o "$USER_NAME" -g "$USER_NAME" "$APP_DIR/storage"

# ------------------------------------------------------------------ settings
step "Settings ($SETTINGS)"
if [[ -f "$SETTINGS" ]]; then
  echo "kept (existing file)"
  [[ "$(get_setting "$SETTINGS" APP_ENV)" == "$ENV_NAME" ]] || die "the settings file says another environment than $ENV_NAME. Check $SETTINGS."
  put_setting "$SETTINGS" PORT "$PORT"
  chmod 640 "$SETTINGS"
  chown "root:$USER_NAME" "$SETTINGS"
else
  cp "$WORK/backend/.env.example" "$SETTINGS.new"
  set_value() { put_setting "$SETTINGS.new" "$1" "$2"; }
  set_value APP_ENV "$ENV_NAME"
  set_value NODE_ENV production
  set_value PORT "$PORT"
  set_value TRUST_PROXY 1
  set_value CORS_ORIGIN "https://$DOMAIN"
  set_value ALLOWED_ORIGINS "https://$DOMAIN"
  set_value SESSION_SECRET "$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | head -c 64)"
  set_value STORAGE_DIR "$APP_DIR/storage"
  key="${JUSPOL_AI_KEY-__ask__}"
  if [[ "$key" == "__ask__" && -t 0 ]]; then
    read -r -s -p "Gemini key for $ENV_NAME (empty: the assistant runs offline): " key; echo
  elif [[ "$key" == "__ask__" ]]; then key=""; fi
  if [[ -n "$key" ]]; then
    [[ "$key" =~ ^[A-Za-z0-9_-]{20,200}$ ]] || { rm -f "$SETTINGS.new"; die "that does not look like an API key"; }
    set_value AI_PROVIDER gemini
    set_value AI_MODEL gemini-flash-latest
    set_value AI_FALLBACK_MODELS gemini-flash-lite-latest
    set_value AI_API_KEY "$key"
  fi
  unset key
  chmod 640 "$SETTINGS.new"
  chown "root:$USER_NAME" "$SETTINGS.new"
  mv "$SETTINGS.new" "$SETTINGS"
  echo "written; fill in the database settings (DB_*) and SEED_PASSWORD, then run this again"
fi
for k in DB_HOST DB_DATABASE DB_USERNAME DB_PASSWORD SESSION_SECRET; do
  [[ -n "$(get_setting "$SETTINGS" "$k")" ]] || die "$k is empty in $SETTINGS. Fill it in and run the script again."
done
# A staging server must not hold the production key or database (the API also refuses to start).
if [[ "$ENV_NAME" == "staging" && -f "$ETC/production/settings.env" ]]; then
  pk="$(get_setting "$ETC/production/settings.env" AI_API_KEY)"
  sk="$(get_setting "$SETTINGS" AI_API_KEY)"
  [[ -z "$pk" || "$pk" != "$sk" ]] || die "staging has the production AI key. Use a separate key for staging."
  pd="$(get_setting "$ETC/production/settings.env" DB_DATABASE)"
  sd="$(get_setting "$SETTINGS" DB_DATABASE)"
  [[ -z "$pd" || "$pd" != "$sd" ]] || die "staging points at the production database ($sd)."
fi

# ------------------------------------------------------------------ code
step "Installing version $VERSION"
TARGET="$APP_DIR/releases/$VERSION-$(date +%Y%m%d%H%M%S)"
mkdir -p "$TARGET"
cp -a "$WORK/." "$TARGET/"
# No install scripts: none of the production dependencies needs one, and nothing runs as root that the release did not ship.
(cd "$TARGET/backend" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
chown -R root:root "$TARGET"
chmod -R go-w "$TARGET"
PREVIOUS="$(readlink "$APP_DIR/current" 2>/dev/null || true)"
DUMP=""
if [[ -n "$PREVIOUS" ]]; then
  # Migrations only go forward: keep a copy of the database from before this version.
  step "Database copy before the update"
  install -d -m 750 "$APP_DIR/backups"
  DUMP="$APP_DIR/backups/before-$VERSION-$(date +%Y%m%d%H%M%S).dump"
  PGPASSWORD="$(get_setting "$SETTINGS" DB_PASSWORD)" pg_dump -Fc -h "$(get_setting "$SETTINGS" DB_HOST)" -p "$(get_setting "$SETTINGS" DB_PORT)" \
    -U "$(get_setting "$SETTINGS" DB_USERNAME)" "$(get_setting "$SETTINGS" DB_DATABASE)" > "$DUMP" || die "the database copy failed; nothing was changed. See the message above."
  echo "$DUMP"
  ln -sfn "$PREVIOUS" "$APP_DIR/previous"
fi
ln -sfn "$TARGET" "$APP_DIR/current"

step "Service $UNIT"
cat > "$SYSTEMD_DIR/$UNIT.new" <<UNIT
[Unit]
Description=JusPol EDRMS API ($ENV_NAME)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$APP_DIR/current/backend
EnvironmentFile=$SETTINGS
ExecStartPre=/usr/bin/node dist/migrate.js
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$APP_DIR/storage

[Install]
WantedBy=multi-user.target
UNIT
mv "$SYSTEMD_DIR/$UNIT.new" "$SYSTEMD_DIR/$UNIT"
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null 2>&1 || true
systemctl restart "$UNIT"

step "Local health check (up to ${HEALTH_WAIT}s)"
ok=0
for ((i = 0; i < HEALTH_WAIT; i += 2)); do
  if body="$(health "http://127.0.0.1:$PORT/api/v1/health")" && grep -q '"success":true' <<<"$body" && grep -q "\"env\":\"$ENV_NAME\"" <<<"$body"; then ok=1; break; fi
  sleep 2
done
if [[ $ok -ne 1 ]]; then
  if [[ -n "$PREVIOUS" ]]; then
    ln -sfn "$PREVIOUS" "$APP_DIR/current"
    systemctl restart "$UNIT" || true
    die "version $VERSION did not start; rolled back to $(basename "$PREVIOUS"). Its database changes may already be applied: if the previous version shows errors, restore $DUMP with pg_restore. See: journalctl -u $UNIT"
  fi
  die "version $VERSION did not start and there is no previous version. See: journalctl -u $UNIT"
fi
echo "ok: $body"
# Keep the three newest releases.
ls -1dt "$APP_DIR"/releases/* 2>/dev/null | tail -n +4 | while read -r old; do
  [[ "$old" -ef "$APP_DIR/current" || "$old" -ef "$APP_DIR/previous" ]] || rm -rf "$old"
done

# ------------------------------------------------------------------ nginx and https
step "nginx site for $DOMAIN"
if [[ -f "$NGINX_SITE" ]] && ! head -n 1 "$NGINX_SITE" | grep -qxF "$MARKER"; then
  die "$NGINX_SITE exists but was not written by this script. Nothing was changed there."
fi
cat > "$NGINX_SITE.new" <<SITE
$MARKER
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 45m;
    root $APP_DIR/current/frontend/dist;
    index index.html;
    include /etc/nginx/mime.types;
    types { application/javascript mjs; application/manifest+json webmanifest; }
    location /api/ {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 180s;
    }
    location / {
        try_files \$uri /index.html;
    }
}
SITE
if [[ -f "$NGINX_SITE" ]] && grep -q "managed-certificate" "$NGINX_SITE"; then
  # certbot added https to our file earlier: keep that file, only follow a new port.
  rm -f "$NGINX_SITE.new"
  cp "$NGINX_SITE" "$NGINX_SITE.bak"
  follow_port() { local line tmp="$NGINX_SITE.tmp"; : > "$tmp"; while IFS= read -r line || [[ -n "$line" ]]; do if [[ "$line" =~ proxy_pass\ http://127\.0\.0\.1:[0-9]+\; ]]; then printf '        proxy_pass http://127.0.0.1:%s;\n' "$PORT" >> "$tmp"; else printf '%s\n' "$line" >> "$tmp"; fi; done < "$NGINX_SITE"; mv "$tmp" "$NGINX_SITE"; }
  follow_port
elif [[ -f "$NGINX_SITE" ]]; then
  cp "$NGINX_SITE" "$NGINX_SITE.bak"
  mv "$NGINX_SITE.new" "$NGINX_SITE"
else
  mv "$NGINX_SITE.new" "$NGINX_SITE"
fi
ln -sfn "$NGINX_SITE" "$NGINX_ENABLED/juspol-$ENV_NAME.conf"
if ! nginx -t >/dev/null 2>&1; then
  if [[ -f "$NGINX_SITE.bak" ]]; then mv "$NGINX_SITE.bak" "$NGINX_SITE"; else rm -f "$NGINX_ENABLED/juspol-$ENV_NAME.conf" "$NGINX_SITE"; fi
  die "nginx refused the site file; the previous one was put back. The API runs; see nginx -t."
fi
rm -f "$NGINX_SITE.bak"
systemctl reload nginx
echo "written; proxy to port $PORT"

URL="http://$DOMAIN"
if [[ $TLS -eq 1 ]]; then
  step "Certificate for $DOMAIN"
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect >/dev/null 2>&1; then
    grep -q "managed-certificate" "$NGINX_SITE" || printf '# managed-certificate: https added by certbot\n' >> "$NGINX_SITE"
    URL="https://$DOMAIN"; echo "ok"
  else
    echo "the certificate could not be obtained now (DNS not ready?). Run this script again to retry."
  fi
fi

step "Public health check"
if body="$(health "$URL/api/v1/health")" && grep -q "\"env\":\"$ENV_NAME\"" <<<"$body"; then echo "ok"; else echo "not reachable from here yet: $URL/api/v1/health"; fi

printf '\n=== DONE (%s): %s — version %s\n' "$ENV_NAME" "$URL" "$VERSION"
