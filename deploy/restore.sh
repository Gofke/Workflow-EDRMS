#!/usr/bin/env bash
# JusPol EDRMS — restore.
#
# Checks every file of a backup against its SHA-256 first, and stops if any
# differs. Then restores the database into TARGET_DB (created if missing,
# replaced if present), the documents into TARGET_STORAGE and the keys into
# TARGET_KEYS. Stop the application before restoring over a live system.
#
# Usage: deploy/restore.sh <backup-directory> <target-db> <target-storage-dir> [target-keys-dir]
# Uses DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD (and BACKUP_PASSPHRASE for an
# encrypted backup) from the environment.
set -euo pipefail
SRC="${1:?backup directory}"
TARGET_DB="${2:?target database}"
TARGET_STORAGE="${3:?target storage directory}"
TARGET_KEYS="${4:-}"
: "${DB_HOST:?DB_HOST missing}" "${DB_USERNAME:?DB_USERNAME missing}"
export PGPASSWORD="${DB_PASSWORD:-}"

echo "Verifying $SRC"
( cd "$SRC" && sha256sum --quiet -c SHA256SUMS ) || { echo "BACKUP DAMAGED: a file does not match its checksum. Nothing was restored."; exit 2; }
echo "All files match their checksums."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
for f in database.dump documents.tar.gz keys.tar.gz; do
  if [ -f "$SRC/$f.enc" ]; then
    : "${BACKUP_PASSPHRASE:?this backup is encrypted: set BACKUP_PASSPHRASE}"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$SRC/$f.enc" -out "$WORK/$f"
  elif [ -f "$SRC/$f" ]; then
    cp "$SRC/$f" "$WORK/$f"
  fi
done

PG=(-h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USERNAME")
if psql "${PG[@]}" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'" | grep -q 1; then
  echo "Replacing database $TARGET_DB"
  psql "${PG[@]}" -d postgres -qc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TARGET_DB' AND pid <> pg_backend_pid();" >/dev/null
  psql "${PG[@]}" -d postgres -qc "DROP DATABASE \"$TARGET_DB\";"
fi
psql "${PG[@]}" -d postgres -qc "CREATE DATABASE \"$TARGET_DB\";"
pg_restore "${PG[@]}" -d "$TARGET_DB" --no-owner --exit-on-error "$WORK/database.dump"

mkdir -p "$TARGET_STORAGE"
tar -C "$TARGET_STORAGE" -xzf "$WORK/documents.tar.gz"
if [ -n "$TARGET_KEYS" ] && [ -f "$WORK/keys.tar.gz" ]; then
  mkdir -p "$TARGET_KEYS" && chmod 700 "$TARGET_KEYS"
  tar -C "$TARGET_KEYS" -xzf "$WORK/keys.tar.gz"
fi
echo "Restored into database $TARGET_DB and storage $TARGET_STORAGE."
echo "Start the application on the restored data and run the integrity check (Audit → Integriteit) to confirm."
