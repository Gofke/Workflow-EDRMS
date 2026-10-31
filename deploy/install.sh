#!/usr/bin/env bash
# JusPol EDRMS — install or update one environment on an Ubuntu server.
#
#   sudo bash install.sh install --env staging --domain edrms-test.juspol.sr \
#        --port 4611 --release juspol-edrms-0.5.0.tar.gz --email ict@juspol.sr [--no-tls]
#   sudo bash install.sh demo    --env staging [--reset]   (demonstration data; never production)
#   sudo bash install.sh status  --env staging
#
# Shared-server rule: the script only creates and changes its own names — the
# service user juspol-<env>, the folder /opt/juspol/<env>, the settings folder
# /etc/juspol/<env>, the PostgreSQL role and database juspol_<env>, the unit
# juspol-api-<env>.service, the nginx snippet juspol-security-headers.conf and
# one nginx site file that starts with its marker line. It checks before it
# creates, never edits another site, and stops at the first problem with a
# clear message.
#
# Safe to run again: an existing settings file is kept; a failed certificate is
# retried on the next run; a new version that does not start is rolled back.
#
# The release is made with deploy/pack.sh (built backend and frontend, no
# secrets). The AI key is asked hidden and written only to the settings file;
# the database password is generated and written only there.
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
NGINX_SNIPPETS="$PREFIX/etc/nginx/snippets"
NODE_BIN="${JUSPOL_NODE:-/usr/bin/node}"
HEALTH_WAIT="${JUSPOL_HEALTH_WAIT:-60}"

STEP=0
step() { STEP=$((STEP + 1)); printf '\n[%d] %s\n' "$STEP" "$*"; }
die() { printf '\n=== STOPPED: %s\n' "$*" >&2; exit 1; }
trap 'die "unexpected error on line $LINENO (nothing else was changed after this step)"' ERR

usage() {
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

ACTION="${1:-}"
[[ "$ACTION" =~ ^(install|status|demo)$ ]] || usage
shift
ENV_NAME="" DOMAIN="" PORT="" RELEASE="" EMAIL="" TLS=1 RESET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --release) RELEASE="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --no-tls) TLS=0; shift ;;
    --reset) RESET=1; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

# ------------------------------------------------------------------ validation (no shell injection)
[[ "$ENV_NAME" =~ ^(staging|production)$ ]] || die "--env must be staging or production"
USER_NAME="juspol-$ENV_NAME"
DB_OWN="juspol_$ENV_NAME"
UNIT="juspol-api-$ENV_NAME.service"
APP_DIR="$OPT/$ENV_NAME"
SETTINGS_DIR="$ETC/$ENV_NAME"
SETTINGS="$SETTINGS_DIR/settings.env"
MARKER="# managed-by: juspol-edrms $ENV_NAME"

health() { curl -fsS --max-time 5 "$1" 2>/dev/null; }
random() { head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

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
# The template's example values ("change_me…", "choose_a_…") count as empty.
unset_value() { [[ -z "$1" || "$1" == change_me* || "$1" == choose_a_* ]]; }
# Exports the settings the way systemd reads them (KEY=value, optional quotes), without running them.
load_settings() {
  local line k v
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    k="${line%%=*}"; v="${line#*=}"
    if [[ ${#v} -ge 2 && "$v" == \"*\" ]]; then v="${v:1:${#v}-2}"; fi
    export "$k=$v"
  done < "$SETTINGS"
}
wait_healthy() { # port → 0 when the API answers for this environment
  local i body
  for ((i = 0; i < HEALTH_WAIT; i += 2)); do
    if body="$(health "http://127.0.0.1:$1/api/v1/health")" && grep -q '"success":true' <<<"$body" && grep -q "\"env\":\"$ENV_NAME\"" <<<"$body"; then
      HEALTH_BODY="$body"; return 0
    fi
    sleep 2
  done
  return 1
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
  echo "Address: $(get_setting "$SETTINGS" PUBLIC_BASE_URL)"
  echo "Version: $(readlink "$APP_DIR/current" 2>/dev/null || echo none); previous: $(readlink "$APP_DIR/previous" 2>/dev/null || echo none)"
  exit 0
fi

# ------------------------------------------------------------------ demonstration data (staging only)
if [[ "$ACTION" == "demo" ]]; then
  [[ "$ENV_NAME" != "production" ]] || die "demonstration data is never loaded on production."
  [[ -f "$SETTINGS" && -f "$APP_DIR/current/backend/dist/seed/demo.js" ]] || die "$ENV_NAME is not installed yet. Run the install first."
  step "Checking the tools the demonstration documents need"
  missing=()
  for tool in pdftoppm identify convert; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
  [[ ${#missing[@]} -eq 0 ]] || die "missing ${missing[*]}. Install them with: sudo apt-get install -y poppler-utils imagemagick — then run this again."
  echo "ok"

  step "Password for every demonstration account"
  pw="${JUSPOL_DEMO_PASSWORD-}"
  if [[ -z "$pw" ]]; then
    [[ -t 0 ]] || die "run this in a terminal: it asks for the password of the demonstration accounts."
    read -r -s -p "Password (at least 12 characters, three of: a-z, A-Z, 0-9, symbol; not shown): " pw; echo
    read -r -s -p "Same password again: " pw2; echo
    [[ "$pw" == "$pw2" ]] || die "the two passwords differ. Nothing was changed."
    unset pw2
  fi
  # The application's own password rule (Beheer → Beveiliging): 12 characters, three kinds of character.
  [[ ${#pw} -ge 12 ]] || die "the password needs at least 12 characters. Nothing was changed."
  kinds=0
  for re in '[a-z]' '[A-Z]' '[0-9]' '[^A-Za-z0-9]'; do [[ "$pw" =~ $re ]] && kinds=$((kinds + 1)); done
  (( kinds >= 3 )) || die "the password needs three of: lower case, upper case, digits, symbols. Nothing was changed."
  echo "ok (used only now, not stored)"

  step "Helper for loading the data"
  TOOLS="$APP_DIR/demo-tools"
  if [[ ! -f "$TOOLS/node_modules/supertest/package.json" ]]; then
    st="$("$NODE_BIN" -p "require('$APP_DIR/current/backend/package-lock.json').packages['node_modules/supertest'].version")"
    [[ "$st" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the release does not name the helper's version."
    install -d -m 755 "$TOOLS"
    npm install --prefix "$TOOLS" --no-save --no-package-lock --ignore-scripts --no-audit --no-fund "supertest@$st" >/dev/null
    chmod -R u=rwX,go=rX "$TOOLS"
  fi
  echo "ok"

  step "Loading the demonstration ministry (takes a few minutes)"
  (
    load_settings
    export SEED_PASSWORD="$pw" NODE_PATH="$TOOLS/node_modules"
    cd "$APP_DIR/current/backend"
    if [[ $RESET -eq 1 ]]; then runuser -u "$USER_NAME" -- "$NODE_BIN" dist/seed/demo.js --reset
    else runuser -u "$USER_NAME" -- "$NODE_BIN" dist/seed/demo.js; fi
  ) || die "the demonstration data could not be loaded (message above). If the database already holds letters, add --reset to replace everything."
  unset pw
  systemctl restart "$UNIT"
  wait_healthy "$(get_setting "$SETTINGS" PORT)" || die "the API did not come back after loading. See: journalctl -u $UNIT"
  printf '\n=== DONE: sign in at %s with minister@juspol.test, directeur@juspol.test, onderdirecteur@juspol.test, assistant1@juspol.test or sysadmin@juspol.test and the password you just typed.\n' "$(get_setting "$SETTINGS" PUBLIC_BASE_URL)"
  exit 0
fi

# ------------------------------------------------------------------ install
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] || die "--domain is not a valid host name: $DOMAIN"
[[ "$PORT" =~ ^[0-9]{4,5}$ ]] && (( PORT >= 1024 && PORT <= 65535 )) || die "--port must be a number from 1024 to 65535"
[[ -f "$RELEASE" ]] || die "release file not found: $RELEASE"
[[ -z "$EMAIL" || "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "--email is not an e-mail address"
[[ $TLS -eq 0 || -n "$EMAIL" ]] || die "--email is needed for the certificate (or use --no-tls)"
NGINX_SITE="$NGINX_AVAILABLE/juspol-$ENV_NAME.conf"

echo "JusPol EDRMS — $ACTION $ENV_NAME on $DOMAIN (port $PORT)"

# ------------------------------------------------------------------ checks before anything is created
step "Checking the server"
missing=()
if [[ -x "$NODE_BIN" ]]; then
  major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  (( major >= 20 )) || missing+=("Node.js 20 or newer (found $major)")
else
  missing+=("Node.js 20 or newer at $NODE_BIN")
fi
for tool in npm nginx curl pg_dump; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
[[ $TLS -eq 0 ]] || command -v certbot >/dev/null 2>&1 || missing+=("certbot")
if [[ ${#missing[@]} -gt 0 ]]; then
  die "missing: ${missing[*]}.
Install them, then run this again:
  sudo apt-get update && sudo apt-get install -y nginx postgresql certbot python3-certbot-nginx curl
  Node.js 22 (if missing or older):
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
fi
[[ -d "$NGINX_AVAILABLE" && -d "$NGINX_ENABLED" ]] || die "nginx has no $NGINX_AVAILABLE and $NGINX_ENABLED folders (this script expects Ubuntu's nginx layout). Nothing was installed."
echo "ok (Node.js $major)"

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
  [[ "$(get_setting "$SETTINGS" PORT)" == "$PORT" ]] || die "port $PORT is already in use by another program. Choose another --port. Nothing was installed."
fi
echo "ok"

step "Reading the release"
WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap 'cleanup' EXIT
tar -xzf "$RELEASE" -C "$WORK"
[[ -f "$WORK/backend/dist/main.js" && -f "$WORK/backend/assets/fonts/LiberationSans-Regular.ttf" && -f "$WORK/frontend/dist/index.html" && -f "$WORK/VERSION" ]] \
  || die "the release is incomplete (backend/dist, backend/assets, frontend/dist and VERSION expected). Rebuild it with deploy/pack.sh."
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
install -d -m 750 -o "$USER_NAME" -g "$USER_NAME" "$APP_DIR/storage" "$APP_DIR/storage/documents"
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$APP_DIR/storage/keys"

# ------------------------------------------------------------------ settings
step "Settings ($SETTINGS)"
if [[ -f "$SETTINGS" ]]; then
  echo "kept (existing file)"
  [[ "$(get_setting "$SETTINGS" APP_ENV)" == "$ENV_NAME" ]] || die "the settings file says another environment than $ENV_NAME. Check $SETTINGS."
  put_setting "$SETTINGS" PORT "$PORT"
else
  cp "$WORK/backend/.env.example" "$SETTINGS.new"
  set_value() { put_setting "$SETTINGS.new" "$1" "$2"; }
  set_value APP_ENV "$ENV_NAME"
  set_value NODE_ENV production
  set_value PORT "$PORT"
  set_value TRUST_PROXY 1
  set_value CORS_ORIGIN "https://$DOMAIN"
  set_value ALLOWED_ORIGINS "https://$DOMAIN"
  set_value PUBLIC_BASE_URL "https://$DOMAIN"
  set_value SESSION_SECRET "$(random 64)"
  set_value MFA_ENCRYPTION_KEY "$(random 64)"
  set_value SEED_PASSWORD ""
  key="${JUSPOL_AI_KEY-__ask__}"
  if [[ "$key" == "__ask__" && -t 0 ]]; then
    read -r -s -p "Gemini key for $ENV_NAME (empty: the assistant runs offline; it can be added later): " key; echo
  elif [[ "$key" == "__ask__" ]]; then key=""; fi
  if [[ -n "$key" ]]; then
    [[ "$key" =~ ^[A-Za-z0-9_.-]{20,200}$ ]] || { rm -f "$SETTINGS.new"; die "that does not look like an API key"; }
    set_value AI_PROVIDER gemini
    set_value AI_MODEL gemini-flash-latest
    set_value AI_FALLBACK_MODELS gemini-flash-lite-latest
    set_value AI_API_KEY "$key"
  fi
  unset key
  mv "$SETTINGS.new" "$SETTINGS"
  echo "written"
fi
# Every run: documents and keys live in the writable storage folder (the
# release folder is read-only for the service), and no example secret is kept.
put_setting "$SETTINGS" DOCUMENT_STORAGE_PATH "$APP_DIR/storage/documents"
put_setting "$SETTINGS" KEYS_DIR "$APP_DIR/storage/keys"
unset_value "$(get_setting "$SETTINGS" SESSION_SECRET)" && put_setting "$SETTINGS" SESSION_SECRET "$(random 64)"
unset_value "$(get_setting "$SETTINGS" MFA_ENCRYPTION_KEY)" && put_setting "$SETTINGS" MFA_ENCRYPTION_KEY "$(random 64)"
chmod 640 "$SETTINGS"
chown "root:$USER_NAME" "$SETTINGS"

# ------------------------------------------------------------------ database
db_host="$(get_setting "$SETTINGS" DB_HOST)"
if unset_value "$(get_setting "$SETTINGS" DB_PASSWORD)"; then
  step "Database $DB_OWN (local PostgreSQL)"
  [[ "$db_host" =~ ^(localhost|127\.0\.0\.1|::1)?$ ]] || die "DB_PASSWORD is empty in $SETTINGS for the database server $db_host. Fill in DB_* there and run this again."
  command -v psql >/dev/null 2>&1 && id postgres >/dev/null 2>&1 || die "no local PostgreSQL found. Install it (sudo apt-get install -y postgresql), or fill in DB_* in $SETTINGS for another database server, then run this again."
  pg() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"; }
  [[ "$(pg -tAc 'SELECT 1' 2>/dev/null)" == "1" ]] || die "PostgreSQL does not answer. Start it (sudo systemctl start postgresql) and run this again."
  [[ -z "$(pg -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$DB_OWN' UNION ALL SELECT 1 FROM pg_database WHERE datname = '$DB_OWN'")" ]] \
    || die "PostgreSQL already has a role or database $DB_OWN, but $SETTINGS has no password for it. Put its password in DB_PASSWORD (or remove the old one), then run this again."
  dbpw="$(random 40)"
  # The password goes in on standard input, never on a command line.
  printf "CREATE ROLE %s LOGIN PASSWORD '%s';\n" "$DB_OWN" "$dbpw" | pg
  pg -c "CREATE DATABASE $DB_OWN OWNER $DB_OWN ENCODING 'UTF8' TEMPLATE template0"
  pg -d "$DB_OWN" -c 'CREATE EXTENSION IF NOT EXISTS "pgcrypto"'
  put_setting "$SETTINGS" DB_HOST 127.0.0.1
  put_setting "$SETTINGS" DB_PORT 5432
  put_setting "$SETTINGS" DB_USERNAME "$DB_OWN"
  put_setting "$SETTINGS" DB_DATABASE "$DB_OWN"
  put_setting "$SETTINGS" DB_PASSWORD "$dbpw"
  unset dbpw
  echo "created; the password is only in $SETTINGS"
fi
for k in DB_HOST DB_DATABASE DB_USERNAME DB_PASSWORD SESSION_SECRET; do
  unset_value "$(get_setting "$SETTINGS" "$k")" && die "$k is empty in $SETTINGS. Fill it in and run the script again."
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
# Readable for the service and for nginx, writable only by root (the release holds no secrets).
chmod -R u=rwX,go=rX "$TARGET"
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
ExecStartPre=$NODE_BIN dist/migrate.js
ExecStart=$NODE_BIN dist/main.js
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
if ! wait_healthy "$PORT"; then
  if [[ -n "$PREVIOUS" ]]; then
    ln -sfn "$PREVIOUS" "$APP_DIR/current"
    systemctl restart "$UNIT" || true
    die "version $VERSION did not start; rolled back to $(basename "$PREVIOUS"). Its database changes may already be applied: if the previous version shows errors, restore $DUMP with pg_restore. See: journalctl -u $UNIT"
  fi
  die "version $VERSION did not start and there is no previous version. See: journalctl -u $UNIT -n 50"
fi
echo "ok: $HEALTH_BODY"
# Keep the three newest releases.
ls -1dt "$APP_DIR"/releases/* 2>/dev/null | tail -n +4 | while read -r old; do
  [[ "$old" -ef "$APP_DIR/current" || "$old" -ef "$APP_DIR/previous" ]] || rm -rf "$old"
done

# ------------------------------------------------------------------ nginx and https
step "nginx site for $DOMAIN"
if [[ -f "$NGINX_SITE" ]] && ! head -n 1 "$NGINX_SITE" | grep -qxF "$MARKER"; then
  die "$NGINX_SITE exists but was not written by this script. Nothing was changed there."
fi
HEADERS="$NGINX_SNIPPETS/juspol-security-headers.conf"
install -d -m 755 "$NGINX_SNIPPETS"
cp "$APP_DIR/current/deploy/juspol-security-headers.conf" "$HEADERS.new" && chmod 644 "$HEADERS.new" && mv "$HEADERS.new" "$HEADERS"
cat > "$NGINX_SITE.new" <<SITE
$MARKER
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 45m;
    root $APP_DIR/current/frontend/dist;
    index index.html;
    # nginx drops these in any location that sets its own add_header, so the
    # locations below include them again.
    include /etc/nginx/snippets/juspol-security-headers.conf;
    include /etc/nginx/mime.types;
    types { application/javascript mjs; application/manifest+json webmanifest; }
    location /api/ {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 180s;
        # The API sets its own security headers (helmet).
        add_header Cache-Control "no-store" always;
    }
    # The service worker is never cached, so updates reach every device.
    location = /sw.js {
        include /etc/nginx/snippets/juspol-security-headers.conf;
        add_header Cache-Control "no-cache";
        try_files \$uri =404;
    }
    location /assets/ {
        include /etc/nginx/snippets/juspol-security-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files \$uri =404;
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
chmod 644 "$NGINX_SITE"
ln -sfn "$NGINX_SITE" "$NGINX_ENABLED/juspol-$ENV_NAME.conf"
if ! nginx -t >/dev/null 2>&1; then
  if [[ -f "$NGINX_SITE.bak" ]]; then mv "$NGINX_SITE.bak" "$NGINX_SITE"; else rm -f "$NGINX_ENABLED/juspol-$ENV_NAME.conf" "$NGINX_SITE"; fi
  die "nginx refused the site file; the previous one was put back. The API runs; see: nginx -t"
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
    echo "the certificate could not be obtained now (DNS not pointing here yet, or the certificate authority's limit for this name). Run this script again to retry."
    if [[ "$ENV_NAME" == "staging" ]]; then echo "Until then staging runs on http; signing in works there (production needs https)."; fi
  fi
fi
# The address printed on receipts, seals and in e-mails follows what really works.
if [[ "$(get_setting "$SETTINGS" PUBLIC_BASE_URL)" != "$URL" ]]; then
  put_setting "$SETTINGS" PUBLIC_BASE_URL "$URL"
  chmod 640 "$SETTINGS"; chown "root:$USER_NAME" "$SETTINGS"
  systemctl restart "$UNIT"
  wait_healthy "$PORT" || die "the API did not come back after the address change. See: journalctl -u $UNIT"
fi

step "Public health check"
if body="$(health "$URL/api/v1/health")" && grep -q "\"env\":\"$ENV_NAME\"" <<<"$body"; then echo "ok"; else echo "not reachable from here yet: $URL/api/v1/health"; fi

printf '\n=== DONE (%s): %s — version %s\n' "$ENV_NAME" "$URL" "$VERSION"
if [[ "$ENV_NAME" == "staging" ]]; then
  printf 'For the demonstration ministry and its accounts: sudo bash %s demo --env staging\n' "$0"
fi
