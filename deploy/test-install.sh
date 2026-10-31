#!/usr/bin/env bash
# Tests deploy/install.sh end to end with stubs (no real server needed):
# server check, database created with a generated password, first install,
# update, address of another site, port in use, wrong key on staging, invalid
# domain, certificate retry, broken version → rollback, demonstration data.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export JUSPOL_PREFIX="$T/root" JUSPOL_HEALTH_WAIT=4 JUSPOL_AI_KEY="Demo-Secret-Key-1234567890" JUSPOL_NODE="$T/bin/node-ok"
mkdir -p "$T/bin" "$JUSPOL_PREFIX"/etc/{systemd/system,nginx/sites-available,nginx/sites-enabled,nginx/conf.d} "$T/state"
# --- stubs: each records its call; behaviour is steered by files in $T/state
for c in useradd systemctl journalctl nginx certbot npm chown chmod pg_dump psql; do
  cat > "$T/bin/$c" <<STUB
#!/usr/bin/env bash
echo "$c \$*" >> "$T/state/calls"
case "$c" in
  certbot) [[ -f "$T/state/certbot-fails" ]] && exit 1 ;;
  pg_dump) echo "dump" ;;
  nginx) [[ -f "$T/state/nginx-fails" ]] && exit 1 ;;
esac
exit 0
STUB
  chmod +x "$T/bin/$c"
done
# runuser: records the call; psql's standard input (where passwords go) is kept apart.
cat > "$T/bin/runuser" <<STUB
#!/usr/bin/env bash
echo "runuser \$*" >> "$T/state/calls"
case "\$*" in
  *"SELECT 1 FROM pg_roles"*) cat "$T/state/db-exists" 2>/dev/null; exit 0 ;;
  *"SELECT 1"*) echo 1; exit 0 ;;
  *" -c "*|*" -d "*) exit 0 ;;
  *psql*) cat >> "$T/state/psql-stdin"; exit 0 ;;
  *demo.js*) echo "demo \$* SEED=\$SEED_PASSWORD NODE_PATH=\$NODE_PATH DOCS=\$DOCUMENT_STORAGE_PATH" >> "$T/state/demo"; exit 0 ;;
esac
exit 0
STUB
cat > "$T/bin/node-ok" <<'STUB'
#!/usr/bin/env bash
case "$*" in *process.versions*) echo 22 ;; *supertest*) echo 7.2.2 ;; esac
STUB
cat > "$T/bin/node-old" <<'STUB'
#!/usr/bin/env bash
echo 18
STUB
for c in pdftoppm identify convert; do printf '#!/usr/bin/env bash\nexit 0\n' > "$T/bin/$c"; done
cat > "$T/bin/id" <<STUB
#!/usr/bin/env bash
grep -qx "\$1" "$T/state/users" 2>/dev/null
STUB
cat > "$T/bin/install" <<'STUB'
#!/usr/bin/env bash
# Only the -d form is used: create folders, ignore owner and mode.
args=(); while [[ $# -gt 0 ]]; do case "$1" in -m|-o|-g) shift 2 ;; -d) shift ;; *) args+=("$1"); shift ;; esac; done
mkdir -p "${args[@]}"
STUB
cat > "$T/bin/ss" <<STUB
#!/usr/bin/env bash
cat "$T/state/ports" 2>/dev/null
STUB
cat > "$T/bin/curl" <<STUB
#!/usr/bin/env bash
url="\${@: -1}"
version="\$(basename "\$(readlink "$JUSPOL_PREFIX/opt/juspol/staging/current")" | cut -d- -f1)"
[[ -f "$T/state/broken-\$version" ]] && exit 7
echo '{"success":true,"message":"ok","data":{"env":"staging","version":"'\$version'"}}'
STUB
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"

release() { # version
  local d="$T/rel-$1"; mkdir -p "$d/backend/dist/seed" "$d/backend/assets/fonts" "$d/frontend/dist" "$d/deploy"
  echo "font" > "$d/backend/assets/fonts/LiberationSans-Regular.ttf"
  echo "console.log(1)" > "$d/backend/dist/main.js"; echo "x" > "$d/backend/dist/seed/demo.js"; echo "<html></html>" > "$d/frontend/dist/index.html"
  echo "add_header X-Content-Type-Options nosniff always;" > "$d/deploy/juspol-security-headers.conf"
  # The real template's example values, which must not pass as filled in.
  printf 'APP_ENV=development\nPORT=3000\nDB_HOST=localhost\nDB_PORT=5432\nDB_USERNAME=juspol\nDB_PASSWORD=change_me\nDB_DATABASE=juspol_edrms\nSESSION_SECRET=change_me_to_a_long_random_string\nMFA_ENCRYPTION_KEY=change_me_to_another_long_random_string\nSEED_PASSWORD=choose_a_test_password\nDOCUMENT_STORAGE_PATH=./captured-documents\nKEYS_DIR=./keys\nAI_API_KEY=\n' > "$d/backend/.env.example"
  echo "$1" > "$d/VERSION"; tar -czf "$T/r-$1.tgz" -C "$d" .; echo "$T/r-$1.tgz"
}
run() { bash "$HERE/install.sh" "$@" < /dev/null > "$T/out" 2>&1; echo $?; }
pass=0 fail=0
check() { if eval "$2"; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; sed 's/^/      /' "$T/out" | tail -5; fail=$((fail+1)); fi; }
S="$JUSPOL_PREFIX/etc/juspol/staging/settings.env"
setting() { grep -m1 "^$1=" "$S" | cut -d= -f2-; }
R1="$(release 0.4.0)"; R2="$(release 0.4.1)"; R3="$(release 0.4.2)"
A=(install --env staging --domain edrms-test.juspol.sr --port 4611 --email ict@juspol.sr)

rc=$(JUSPOL_NODE="$T/bin/node-old" run "${A[@]}" --release "$R1")
check "an old Node.js is refused before anything is created, with the command to install" '[[ $rc -ne 0 ]] && grep -q "Node.js 20 or newer (found 18)" "$T/out" && grep -q "nodesource" "$T/out" && [[ ! -d "$JUSPOL_PREFIX/opt/juspol" ]]'

mv "$JUSPOL_PREFIX/etc/nginx/sites-enabled" "$T/se"
rc=$(run "${A[@]}" --release "$R1")
check "an nginx without sites-enabled is refused before anything is created" '[[ $rc -ne 0 ]] && grep -q "Ubuntu.s nginx layout" "$T/out" && [[ ! -d "$JUSPOL_PREFIX/opt/juspol" ]]'
mv "$T/se" "$JUSPOL_PREFIX/etc/nginx/sites-enabled"

rc=$(run install --env staging --domain 'x.sr;rm -rf /' --port 4611 --release "$R1" --no-tls)
check "invalid domain is refused" '[[ $rc -ne 0 ]] && grep -q "not a valid host name" "$T/out"'

echo "server { server_name edrms-test.juspol.sr; }" > "$JUSPOL_PREFIX/etc/nginx/sites-enabled/other.conf"
rc=$(run "${A[@]}" --release "$R1")
check "address used by another site is refused before anything is installed" '[[ $rc -ne 0 ]] && grep -q "already used by another site" "$T/out" && [[ ! -d "$JUSPOL_PREFIX/opt/juspol" ]]'
rm "$JUSPOL_PREFIX/etc/nginx/sites-enabled/other.conf"

echo "LISTEN 0 511 127.0.0.1:4611 0.0.0.0:*" > "$T/state/ports"
rc=$(run "${A[@]}" --release "$R1")
check "port used by another program is refused" '[[ $rc -ne 0 ]] && grep -q "already in use" "$T/out"'
rm "$T/state/ports"

rc=$(run "${A[@]}" --release "$R1")
check "without a local PostgreSQL the first run writes the settings (key included) and stops; example values do not pass" '[[ $rc -ne 0 ]] && grep -q "no local PostgreSQL found" "$T/out" && [[ "$(setting APP_ENV)" == staging && "$(setting AI_API_KEY)" == Demo-Secret-Key-1234567890 && "$(setting DB_PASSWORD)" == change_me ]]'
check "settings: storage and keys in the writable folder, fresh secrets, no demo password" '[[ "$(setting DOCUMENT_STORAGE_PATH)" == "$JUSPOL_PREFIX/opt/juspol/staging/storage/documents" && "$(setting KEYS_DIR)" == "$JUSPOL_PREFIX/opt/juspol/staging/storage/keys" && ${#S} -gt 0 && "$(setting SESSION_SECRET)" =~ ^[A-Za-z0-9]{64}$ && "$(setting MFA_ENCRYPTION_KEY)" =~ ^[A-Za-z0-9]{64}$ && -z "$(setting SEED_PASSWORD)" && "$(setting PUBLIC_BASE_URL)" == https://edrms-test.juspol.sr ]]'

echo postgres >> "$T/state/users"; echo 1 > "$T/state/db-exists"
rc=$(run "${A[@]}" --release "$R1")
check "an existing role or database of that name is never taken over" '[[ $rc -ne 0 ]] && grep -q "already has a role or database juspol_staging" "$T/out" && [[ ! -f "$T/state/psql-stdin" ]]'
rm "$T/state/db-exists"

rc=$(bash "$HERE/install.sh" status --env production > "$T/out" 2>&1; echo $?)
check "status of an environment that is not installed says so" '[[ $rc -eq 0 ]] && grep -q "not installed" "$T/out"'

touch "$T/state/certbot-fails"
rc=$(run "${A[@]}" --release "$R1")
check "first install creates the database with a generated password and succeeds" '[[ $rc -eq 0 ]] && grep -q "=== DONE (staging)" "$T/out" && [[ "$(setting DB_USERNAME)" == juspol_staging && "$(setting DB_DATABASE)" == juspol_staging && "$(setting DB_PASSWORD)" =~ ^[A-Za-z0-9]{40}$ ]] && grep -q "CREATE DATABASE juspol_staging OWNER juspol_staging" "$T/state/calls" && grep -q "pgcrypto" "$T/state/calls"'
check "the database password goes in on standard input, never on a command line" 'pw="$(setting DB_PASSWORD)"; grep -q "PASSWORD '"'"'$pw'"'"'" "$T/state/psql-stdin" && ! grep -q "$pw" "$T/state/calls"'
check "a failed certificate asks to run again; staging then runs on http and says so" 'grep -q "Run this script again to retry" "$T/out" && grep -q "signing in works there" "$T/out" && [[ "$(setting PUBLIC_BASE_URL)" == http://edrms-test.juspol.sr ]] && head -1 "$JUSPOL_PREFIX/etc/nginx/sites-available/juspol-staging.conf" | grep -q "managed-by"'
check "nginx site carries the security headers and the caching rules" 'f="$JUSPOL_PREFIX/etc/nginx/sites-available/juspol-staging.conf"; grep -q "include /etc/nginx/snippets/juspol-security-headers.conf;" "$f" && grep -q "location = /sw.js" "$f" && grep -q "immutable" "$f" && [[ -f "$JUSPOL_PREFIX/etc/nginx/snippets/juspol-security-headers.conf" ]]'
check "the service runs with the node that was checked" 'grep -q "^ExecStart=$JUSPOL_NODE dist/main.js" "$JUSPOL_PREFIX/etc/systemd/system/juspol-api-staging.service"'
rm "$T/state/certbot-fails"

rc=$(run "${A[@]}" --release "$R2")
check "update to 0.4.1 keeps the settings and the previous version, after a database copy" '[[ $rc -eq 0 ]] && grep -q "kept (existing file)" "$T/out" && [[ "$(basename "$(readlink "$JUSPOL_PREFIX/opt/juspol/staging/current")")" == 0.4.1-* ]] && grep -q "https://edrms-test.juspol.sr" "$T/out" && ls "$JUSPOL_PREFIX"/opt/juspol/staging/backups/before-0.4.1-*.dump >/dev/null 2>&1 && [[ "$(setting DB_PASSWORD)" == "$pw" ]]'
check "with the certificate the public address is https again" '[[ "$(setting PUBLIC_BASE_URL)" == https://edrms-test.juspol.sr ]]'

rc=$(run install --env staging --domain edrms-test.juspol.sr --port 4612 --email ict@juspol.sr --release "$R2")
check "a new port is written to the settings and the nginx site follows it" '[[ $rc -eq 0 ]] && grep -q "^PORT=4612" "$JUSPOL_PREFIX/etc/juspol/staging/settings.env" && grep -q "proxy_pass http://127.0.0.1:4612;" "$JUSPOL_PREFIX/etc/nginx/sites-available/juspol-staging.conf"'

check "no secret ever appears on a command line" '! grep -qE "Demo-Secret-Key-1234567890|SESSION_SECRET=" "$T/state/calls"'

touch "$T/state/broken-0.4.2"
rc=$(run "${A[@]}" --release "$R3")
check "a version that does not start is rolled back automatically, pointing at the database copy" '[[ $rc -ne 0 ]] && grep -q "rolled back" "$T/out" && grep -q "pg_restore" "$T/out" && [[ "$(basename "$(readlink "$JUSPOL_PREFIX/opt/juspol/staging/current")")" == 0.4.1-* ]]'

mkdir -p "$JUSPOL_PREFIX/etc/juspol/production"
printf 'AI_API_KEY=PRODKEY_abcdefghijklmnopqrstuvwxyz\nDB_DATABASE=juspol_prod\n' > "$JUSPOL_PREFIX/etc/juspol/production/settings.env"
sed -i 's/^AI_API_KEY=.*/AI_API_KEY=PRODKEY_abcdefghijklmnopqrstuvwxyz/' "$JUSPOL_PREFIX/etc/juspol/staging/settings.env"
rc=$(run "${A[@]}" --release "$R2")
check "staging with the production key is refused" '[[ $rc -ne 0 ]] && grep -q "production AI key" "$T/out"'

mkdir -p "$T/badrel/backend/dist" "$T/badrel/backend/assets/fonts" "$T/badrel/frontend/dist"; echo x > "$T/badrel/backend/dist/main.js"; echo x > "$T/badrel/backend/assets/fonts/LiberationSans-Regular.ttf"; echo x > "$T/badrel/frontend/dist/index.html"; echo 0.4.3 > "$T/badrel/VERSION"
# The key-like text is built at run time, so none is stored in git.
printf "%s%s\n" "AIza" "SyA1234567890abcdefghijklmnopqrstuvw" > "$T/badrel/backend/leak.txt"; tar -czf "$T/bad.tgz" -C "$T/badrel" .
rc=$(run "${A[@]}" --release "$T/bad.tgz")
check "a release that contains a key is refused" '[[ $rc -ne 0 ]] && grep -q "looks like a key" "$T/out"'

rc=$(JUSPOL_DEMO_PASSWORD="Demo-Pass-123" run demo --env production)
check "demonstration data is refused on production" '[[ $rc -ne 0 ]] && grep -q "never loaded on production" "$T/out"'

rc=$(JUSPOL_DEMO_PASSWORD="short" run demo --env staging)
check "a short demonstration password is refused" '[[ $rc -ne 0 ]] && grep -q "at least 10 characters" "$T/out" && [[ ! -f "$T/state/demo" ]]'

rc=$(JUSPOL_DEMO_PASSWORD="Demo-Pass-123" run demo --env staging --reset)
check "demonstration data: loaded as the service user with the settings, the password only in the environment" '[[ $rc -eq 0 ]] && grep -q "=== DONE: sign in at https://edrms-test.juspol.sr" "$T/out" && grep -q "runuser -u juspol-staging -- $JUSPOL_NODE dist/seed/demo.js --reset" "$T/state/calls" && grep -q "SEED=Demo-Pass-123 NODE_PATH=$JUSPOL_PREFIX/opt/juspol/staging/demo-tools/node_modules DOCS=$JUSPOL_PREFIX/opt/juspol/staging/storage/documents" "$T/state/demo" && ! grep -q "Demo-Pass-123" "$T/state/calls" "$S"'

mkdir -p "$T/nofont/backend/dist" "$T/nofont/frontend/dist"; echo x > "$T/nofont/backend/dist/main.js"; echo x > "$T/nofont/frontend/dist/index.html"; echo 0.4.4 > "$T/nofont/VERSION"; tar -czf "$T/nofont.tgz" -C "$T/nofont" .
rc=$(run "${A[@]}" --release "$T/nofont.tgz")
check "a release without the PDF fonts is refused (V0.4.0 packed none)" '[[ $rc -ne 0 ]] && grep -q "release is incomplete" "$T/out"'

echo; echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
