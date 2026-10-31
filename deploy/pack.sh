#!/usr/bin/env bash
# Builds a release of JusPol EDRMS for deploy/install.sh:
#   deploy/pack.sh            → juspol-edrms-<version>.tar.gz in the current folder
# Built backend (dist) with its assets (the fonts of every PDF) and frontend
# (dist), package files, migrations, the settings template and the deploy scripts. Never .env, keys, storage or node_modules.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/backend/package.json').version")"
OUT="${1:-$PWD/juspol-edrms-$VERSION.tar.gz}"
echo "[1] Building the backend"
(cd "$ROOT/backend" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
echo "[2] Building the frontend"
(cd "$ROOT/frontend" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/backend" "$STAGE/frontend" "$STAGE/deploy"
cp -a "$ROOT/backend/dist" "$ROOT/backend/assets" "$ROOT/backend/package.json" "$ROOT/backend/package-lock.json" "$ROOT/backend/.env.example" "$STAGE/backend/"
cp -a "$ROOT/frontend/dist" "$STAGE/frontend/"
cp -a "$ROOT/deploy/." "$STAGE/deploy/"
echo "$VERSION" > "$STAGE/VERSION"
echo "[3] Checking for secrets"
if grep -rqsE 'AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----' "$STAGE"; then echo "=== STOPPED: a key was found in the release" >&2; exit 1; fi
tar -czf "$OUT" -C "$STAGE" .
echo "=== DONE: $OUT"
