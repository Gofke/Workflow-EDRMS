#!/usr/bin/env bash
# Tests deploy/install.sh end to end with stubs (no real server needed):
# first install, update, address of another site, port in use, wrong key on
# staging, invalid domain, certificate retry, broken version → rollback.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export JUSPOL_PREFIX="$T/root" JUSPOL_HEALTH_WAIT=4 JUSPOL_AI_KEY="Demo-Secret-Key-1234567890"
mkdir -p "$T/bin" "$JUSPOL_PREFIX"/etc/{systemd/system,nginx/sites-available,nginx/sites-enabled,nginx/conf.d} "$T/state"
# --- stubs: each records its call; behaviour is steered by files in $T/state
for c in useradd systemctl journalctl nginx certbot npm chown chmod pg_dump; do
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
  local d="$T/rel-$1"; mkdir -p "$d/backend/dist" "$d/frontend/dist"
  echo "console.log(1)" > "$d/backend/dist/main.js"; echo "<html></html>" > "$d/frontend/dist/index.html"
  printf 'APP_ENV=\nPORT=\nDB_HOST=\nDB_DATABASE=\nDB_USERNAME=\nDB_PASSWORD=\nSESSION_SECRET=\nAI_API_KEY=\n' > "$d/backend/.env.example"
  echo "$1" > "$d/VERSION"; tar -czf "$T/r-$1.tgz" -C "$d" .; echo "$T/r-$1.tgz"
}
run() { bash "$HERE/install.sh" "$@" > "$T/out" 2>&1; echo $?; }
pass=0 fail=0
check() { if eval "$2"; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; sed 's/^/      /' "$T/out" | tail -5; fail=$((fail+1)); fi; }
fill_db() { sed -i -E 's/^DB_HOST=.*/DB_HOST=localhost/; s/^DB_DATABASE=.*/DB_DATABASE=juspol_staging/; s/^DB_USERNAME=.*/DB_USERNAME=juspol/; s/^DB_PASSWORD=.*/DB_PASSWORD=x/' "$JUSPOL_PREFIX/etc/juspol/staging/settings.env"; }
R1="$(release 0.4.0)"; R2="$(release 0.4.1)"; R3="$(release 0.4.2)"
A=(install --env staging --domain edrms-test.juspol.sr --port 4611 --email ict@juspol.sr)

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
check "first run writes the settings (key included) and stops for the database settings" '[[ $rc -ne 0 ]] && grep -q "DB_HOST is empty" "$T/out" && grep -q "^APP_ENV=staging" "$JUSPOL_PREFIX/etc/juspol/staging/settings.env" && grep -q "^AI_API_KEY=Demo-Secret-Key-1234567890" "$JUSPOL_PREFIX/etc/juspol/staging/settings.env"'

rc=$(bash "$HERE/install.sh" status --env production > "$T/out" 2>&1; echo $?)
check "status of an environment that is not installed says so" '[[ $rc -eq 0 ]] && grep -q "not installed" "$T/out"'
fill_db

touch "$T/state/certbot-fails"
rc=$(run "${A[@]}" --release "$R1")
check "first install succeeds; a failed certificate asks to run again" '[[ $rc -eq 0 ]] && grep -q "=== DONE (staging)" "$T/out" && grep -q "Run this script again to retry" "$T/out" && head -1 "$JUSPOL_PREFIX/etc/nginx/sites-available/juspol-staging.conf" | grep -q "managed-by"'
rm "$T/state/certbot-fails"

rc=$(run "${A[@]}" --release "$R2")
check "update to 0.4.1 keeps the settings and the previous version, after a database copy" '[[ $rc -eq 0 ]] && grep -q "kept (existing file)" "$T/out" && [[ "$(basename "$(readlink "$JUSPOL_PREFIX/opt/juspol/staging/current")")" == 0.4.1-* ]] && grep -q "https://edrms-test.juspol.sr" "$T/out" && ls "$JUSPOL_PREFIX"/opt/juspol/staging/backups/before-0.4.1-*.dump >/dev/null 2>&1'

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

mkdir -p "$T/badrel/backend/dist" "$T/badrel/frontend/dist"; echo x > "$T/badrel/backend/dist/main.js"; echo x > "$T/badrel/frontend/dist/index.html"; echo 0.4.3 > "$T/badrel/VERSION"
# The key-like text is built at run time, so none is stored in git.
printf "%s%s\n" "AIza" "SyA1234567890abcdefghijklmnopqrstuvw" > "$T/badrel/backend/leak.txt"; tar -czf "$T/bad.tgz" -C "$T/badrel" .
rc=$(run "${A[@]}" --release "$T/bad.tgz")
check "a release that contains a key is refused" '[[ $rc -ne 0 ]] && grep -q "looks like a key" "$T/out"'

echo; echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
