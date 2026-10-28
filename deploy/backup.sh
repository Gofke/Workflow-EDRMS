#!/usr/bin/env bash
# JusPol EDRMS — backup.
#
# Makes one self-contained, verifiable backup of everything the system needs:
#   database.dump     the PostgreSQL database (pg_dump custom format)
#   documents.tar.gz  the stored documents (content-addressed files)
#   keys.tar.gz       the seal key and other server keys (KEYS_DIR)
#   manifest.txt      what was backed up, row counts and the SHA-256 of each file
#
# With BACKUP_PASSPHRASE set, every file is encrypted (AES-256, PBKDF2). Keep
# the passphrase apart from the backups: without it they cannot be restored.
#
# Usage: deploy/backup.sh [path/to/backend/.env] [target-directory]
# Run nightly from cron, e.g.  15 1 * * *  /opt/juspol/deploy/backup.sh /opt/juspol/backend/.env /var/backups/juspol
set -euo pipefail

ENV_FILE="${1:-$(dirname "$0")/../backend/.env}"
TARGET_ROOT="${2:-${BACKUP_DIR:-$(dirname "$0")/../backups}}"
if [ -f "$ENV_FILE" ]; then
  set -a; # shellcheck disable=SC1090
  . "$ENV_FILE"; set +a
fi
: "${DB_HOST:?DB_HOST missing}" "${DB_DATABASE:?DB_DATABASE missing}" "${DB_USERNAME:?DB_USERNAME missing}"
BACKEND_DIR="$(cd "$(dirname "$ENV_FILE")" && pwd)"
resolve() { case "$1" in /*) echo "$1" ;; *) echo "$BACKEND_DIR/$1" ;; esac; }
STORAGE="$(resolve "${DOCUMENT_STORAGE_PATH:-./captured-documents}")"
KEYS="$(resolve "${KEYS_DIR:-./keys}")"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="$TARGET_ROOT/juspol-$STAMP"
mkdir -p "$OUT"
chmod 700 "$OUT"
export PGPASSWORD="${DB_PASSWORD:-}"
PSQL=(psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USERNAME" -d "$DB_DATABASE" -At)

echo "Backing up $DB_DATABASE on $DB_HOST to $OUT"
pg_dump -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USERNAME" -Fc -Z 6 -f "$OUT/database.dump" "$DB_DATABASE"
tar -C "$STORAGE" -czf "$OUT/documents.tar.gz" .
if [ -d "$KEYS" ]; then tar -C "$KEYS" -czf "$OUT/keys.tar.gz" .; fi

{
  echo "JusPol EDRMS backup"
  echo "created_utc=$STAMP"
  echo "database=$DB_DATABASE"
  echo "server_version=$("${PSQL[@]}" -c 'SHOW server_version')"
  echo "migrations=$("${PSQL[@]}" -c 'SELECT count(*) FROM migrations')"
  for t in correspondence_item dossier task captured_document audit_event; do
    echo "rows_$t=$("${PSQL[@]}" -c "SELECT count(*) FROM $t")"
  done
  echo "audit_newest_seq=$("${PSQL[@]}" -c 'SELECT coalesce(max(seq),0) FROM audit_event')"
  echo "audit_newest_hash=$("${PSQL[@]}" -c 'SELECT chain_hash FROM audit_event ORDER BY seq DESC LIMIT 1')"
  echo "document_files=$(find "$STORAGE" -type f | wc -l)"
} > "$OUT/manifest.txt"

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  for f in database.dump documents.tar.gz keys.tar.gz; do
    [ -f "$OUT/$f" ] || continue
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -in "$OUT/$f" -out "$OUT/$f.enc"
    rm -f "$OUT/$f"
  done
  echo "encrypted=aes-256-cbc-pbkdf2" >> "$OUT/manifest.txt"
fi

( cd "$OUT" && sha256sum -- * | grep -v ' manifest.txt$' > SHA256SUMS )
echo "Backup complete: $OUT"
cat "$OUT/manifest.txt"

# Keep BACKUP_KEEP_DAYS days of backups (default 30).
find "$TARGET_ROOT" -maxdepth 1 -type d -name 'juspol-*' -mtime "+${BACKUP_KEEP_DAYS:-30}" -exec rm -rf {} + 2>/dev/null || true
